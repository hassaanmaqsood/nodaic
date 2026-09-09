const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createNodaicSystem, Process, Graph, toNDL } = require('./engine/nodaic_minimal.js');
const { Ops, IO, DatabasePipeline } = require('./helpers/storage.js');

async function runTests() {
    console.log('=== Running Global Secrets & NDL Injection Tests ===\n');

    const testDir = path.join(__dirname, '.test_secrets_tmp_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    try {
        const dbPath = path.join(testDir, 'test.db');
        const sqlite = new Database(dbPath);
        const masterSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

        // Setup principals table
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS principals (
                owner_id      TEXT    NOT NULL DEFAULT 'local',
                principal_id  TEXT    NOT NULL,
                type          TEXT    NOT NULL,
                role          TEXT,
                scope_json    TEXT,
                encrypted_val TEXT,
                hint          TEXT,
                revoked       INTEGER NOT NULL DEFAULT 0,
                meta_json     TEXT,
                created_at    INTEGER NOT NULL,
                PRIMARY KEY (owner_id, principal_id)
            );
        `);

        // 1. Test Saving Secrets to DB (encrypted)
        console.log('1. Storing encrypted secrets in DB...');
        const secretsToStore = {
            'OPENAI_API_KEY': 'sk-test-openai-1234567890',
            'DB_PASSWORD': 'super-secret-postgres-pass!',
            'GITHUB_TOKEN': 'ghp_secretTokenGithub999'
        };

        for (const [key, val] of Object.entries(secretsToStore)) {
            const encrypted = Ops.encrypt(val, Buffer.from(masterSecret.slice(0, 32)));
            const hint = val.slice(-4);
            sqlite.prepare(`
                INSERT OR REPLACE INTO principals (owner_id, principal_id, type, encrypted_val, hint, created_at)
                VALUES ('local', ?, 'credential', ?, ?, ?)
            `).run(key, encrypted, hint, Date.now());
        }

        // Verify stored value in DB is encrypted and not plaintext
        const rawRow = sqlite.prepare(`SELECT encrypted_val FROM principals WHERE principal_id = 'OPENAI_API_KEY'`).get();
        assert(rawRow.encrypted_val.includes('iv') && rawRow.encrypted_val.includes('authTag'), 'Value must be encrypted');
        assert(!rawRow.encrypted_val.includes('sk-test-openai'), 'Plaintext must not be present in DB');
        console.log('✓ Secrets stored and confirmed encrypted at rest.');

        // 2. Secret Resolver (DB first, fallback to process.env)
        process.env.FALLBACK_ENV_VAR = 'fallback-val-from-env';

        async function resolveSecret(key) {
            const row = sqlite.prepare(
                `SELECT encrypted_val FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type IN ('credential', 'secret') AND revoked = 0`
            ).get(key);
            if (row && row.encrypted_val) {
                return Ops.decrypt(row.encrypted_val, Buffer.from(masterSecret.slice(0, 32)));
            }
            return process.env[key];
        }

        assert.strictEqual(await resolveSecret('OPENAI_API_KEY'), 'sk-test-openai-1234567890');
        assert.strictEqual(await resolveSecret('DB_PASSWORD'), 'super-secret-postgres-pass!');
        assert.strictEqual(await resolveSecret('FALLBACK_ENV_VAR'), 'fallback-val-from-env');
        console.log('✓ Secret resolver correctly retrieves from DB and environment.');

        // 3. Setup Nodaic System and Library
        const nodaic = createNodaicSystem();
        const { library, addArtifact } = nodaic;
        library.setSecretsResolver(resolveSecret);

        // Register a test process node that echoes its state
        const echoProcess = new Process((input, state, cb) => {
            cb({
                output: {
                    receivedInput: input,
                    receivedToken: state.token,
                    receivedDbPass: state.db_pass,
                    receivedGithub: state.github_key,
                    receivedFallback: state.fallback
                },
                state
            });
        });
        echoProcess.id = 'test/echo';
        library.addArtifact({
            id: 'test/echo',
            version: '1.0.0',
            artifactType: 'process',
            sourceType: 'application/javascript',
            source: '((input, state, cb) => cb({ output: { receivedInput: input, receivedToken: state.token, receivedDbPass: state.db_pass, receivedGithub: state.github_key, receivedFallback: state.fallback }, state }))'
        });

        // 4. Test NDL graph parsing with env:, secret:, and @key: references
        console.log('2. Parsing NDL text referencing secrets in graph state...');
        const ndlSource = `
graph secret_test_pipeline @version:1.0.0

node my_echo @test/echo
  state token = env:OPENAI_API_KEY
  state db_pass = secret:DB_PASSWORD
  state github_key = @key:GITHUB_TOKEN
  state fallback = env:FALLBACK_ENV_VAR
  state normal_config = "regular_value"
`;

        library.addArtifact({
            id: 'secret_test_pipeline',
            version: '1.0.0',
            artifactType: 'graph',
            sourceType: 'text/x-ndl',
            source: ndlSource
        });

        // 5. Test Graph instantiation and direct secret injection
        console.log('3. Instantiating graph from Library...');
        const graphInstance = await library.getInstance('secret_test_pipeline');
        assert(graphInstance, 'Graph instance should be created');

        const echoNode = graphInstance.nodes['my_echo'];
        assert(echoNode, 'Node "my_echo" must exist in graph');

        console.log('Checking injected node state:');
        console.log('  node.state.token:', echoNode.state.token);
        console.log('  node.state.db_pass:', echoNode.state.db_pass);
        console.log('  node.state.github_key:', echoNode.state.github_key);
        console.log('  node.state.fallback:', echoNode.state.fallback);
        console.log('  node.state.normal_config:', echoNode.state.normal_config);

        assert.strictEqual(echoNode.state.token, 'sk-test-openai-1234567890', 'OPENAI_API_KEY must be injected');
        assert.strictEqual(echoNode.state.db_pass, 'super-secret-postgres-pass!', 'DB_PASSWORD must be injected');
        assert.strictEqual(echoNode.state.github_key, 'ghp_secretTokenGithub999', 'GITHUB_TOKEN must be injected');
        assert.strictEqual(echoNode.state.fallback, 'fallback-val-from-env', 'FALLBACK_ENV_VAR must be injected');
        assert.strictEqual(echoNode.state.normal_config, 'regular_value', 'Normal state should be preserved');
        console.log('✓ All secret references successfully resolved and injected directly into node.state.');

        // 6. Test Graph Compute execution with injected secrets
        console.log('4. Computing graph workflow...');
        const computeResult = await new Promise((resolve) => {
            graphInstance.compute({ msg: 'hello' }, {}, resolve);
        });

        console.log('Compute output:', computeResult.output);
        assert.strictEqual(computeResult.output.receivedToken, 'sk-test-openai-1234567890');
        assert.strictEqual(computeResult.output.receivedDbPass, 'super-secret-postgres-pass!');
        assert.strictEqual(computeResult.output.receivedGithub, 'ghp_secretTokenGithub999');
        assert.strictEqual(computeResult.output.receivedFallback, 'fallback-val-from-env');
        console.log('✓ Process node executed and successfully accessed injected secrets.');

        // 7. Test toNDL serialization preserves references and does not leak secrets
        console.log('5. Verifying toNDL serialization safety...');
        const serializedNDL = toNDL(graphInstance);
        console.log('Serialized NDL:\n' + serializedNDL);

        assert(serializedNDL.includes('state token = env:OPENAI_API_KEY'), 'toNDL must preserve env: reference');
        assert(serializedNDL.includes('state db_pass = secret:DB_PASSWORD'), 'toNDL must preserve secret: reference');
        assert(serializedNDL.includes('state github_key = @key:GITHUB_TOKEN'), 'toNDL must preserve @key: reference');
        assert(!serializedNDL.includes('sk-test-openai'), 'toNDL must NOT contain plaintext secret');
        assert(!serializedNDL.includes('super-secret-postgres-pass'), 'toNDL must NOT contain plaintext password');
        console.log('✓ toNDL safely preserves reference directives without leaking decrypted secrets.');

        console.log('\n=========================================');
        console.log('ALL TESTS PASSED SUCCESSFULLY!');
        console.log('=========================================\n');
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
