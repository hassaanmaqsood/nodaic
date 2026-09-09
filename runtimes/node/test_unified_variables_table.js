const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const { generateAPIKey } = require('./helpers/token.js');
const { StateNode, isReservedNamespace, RESERVED_NAMESPACES } = require('./library/state_process.js');

async function runUnifiedVariablesTests() {
    console.log('=== Running Unified Variables Table & Namespace Gates Tests ===\n');

    const testPort = 3989;
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const testDir = path.join(__dirname, 'test_tmp_' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'nodaic.db');

    // ─── 1. Unit Test StateNode & Namespace Gates ───
    console.log('1. Testing StateNode with unified variables table...');
    const unitStateNode = new StateNode(dbPath);

    // Verify table structure in SQLite
    const sqliteCheck = new Database(dbPath);
    const tables = sqliteCheck.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert(tables.some(t => t.name === 'variables'), 'variables table must exist in SQLite database');
    console.log('✓ variables table confirmed in SQLite DB');

    // Test writing normal state
    let stateResult;
    unitStateNode.compute({ key: 'counter', value: 42, namespace: 'workflow_1' }, {}, (res) => {
        stateResult = res;
    });
    assert.strictEqual(stateResult.output.key, 'counter');
    assert.strictEqual(stateResult.output.value, 42);

    // Read back via StateNode.compute
    let readResult;
    unitStateNode.compute({ key: 'counter', namespace: 'workflow_1' }, {}, (res) => {
        readResult = res;
    });
    assert.strictEqual(readResult.output.value, 42);
    console.log('✓ StateNode read/write works in variables table');

    // Direct SQLite inspection
    const stateRow = sqliteCheck.prepare("SELECT * FROM variables WHERE namespace = ? AND key = ?").get('workflow_1', 'counter');
    assert(stateRow, 'Row must exist in variables table');
    assert.strictEqual(stateRow.type, 'state');
    assert.strictEqual(JSON.parse(stateRow.value), 42);
    assert.strictEqual(stateRow.encrypted, 0);
    console.log('✓ Row in variables table verified: type=state, value=42, encrypted=0');

    // Test Namespace Gates on StateNode
    console.log('\n2. Testing StateNode Namespace Gates for reserved namespaces...');
    let gateErrorResult = null;
    unitStateNode.compute({ key: 'api_token', value: 'leak_attempt', namespace: 'secrets' }, {}, (res) => {
        gateErrorResult = res;
    });
    assert(gateErrorResult && gateErrorResult.error, 'StateNode must reject namespace="secrets"');
    assert(gateErrorResult.error.includes('reserved built-in namespace'), 'Error message must specify reserved namespace');
    console.log('✓ StateNode blocked write to namespace "secrets"');

    let sysGateErrorResult = null;
    unitStateNode.compute({ key: 'admin_override', value: true, namespace: 'system' }, {}, (res) => {
        sysGateErrorResult = res;
    });
    assert(sysGateErrorResult && sysGateErrorResult.error, 'StateNode must reject namespace="system"');
    console.log('✓ StateNode blocked write to namespace "system"');

    assert.throws(() => unitStateNode.get('secrets', 'any_key'), /reserved built-in namespace/);
    assert.throws(() => unitStateNode.delete('secrets', 'any_key'), /reserved built-in namespace/);
    console.log('✓ StateNode get() and delete() also enforce namespace gate');

    unitStateNode.close();
    sqliteCheck.close();

    // ─── 2. Integration Tests with Runtime Server ───
    console.log('\n3. Starting Runtime Server to test Variables RPC & RBAC...');
    const env = {
        ...process.env,
        PORT: String(testPort),
        NODAIC_MASTER_SECRET: testSecret,
        NODAIC_TOKEN_EPOCH: '1',
        NODAIC_VERBOSE: 'false',
        NODAIC_WORKER: '1'
    };

    const serverProc = spawn('node', ['runtime.js'], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let adminToken = null;
    serverProc.stdout.on('data', (d) => {
        const str = d.toString();
        const match = str.match(/[0-9A-F]{256}/i);
        if (match) {
            adminToken = match[0];
        }
    });
    serverProc.stderr.on('data', (d) => console.error('[server err]', d.toString()));

    function request(method, reqPath, body, token = null) {
        const effectiveToken = token !== undefined ? token : adminToken;
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: testPort,
                path: reqPath,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(effectiveToken ? { 'Authorization': `Bearer ${effectiveToken}` } : {})
                }
            }, (res) => {
                let resBody = '';
                res.on('data', chunk => resBody += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(resBody) });
                    } catch (_) {
                        resolve({ status: res.statusCode, body: resBody });
                    }
                });
            });
            req.on('error', reject);
            if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
            req.end();
        });
    }

    try {
        // Wait for server ready
        let ready = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 200));
            try {
                const res = await request('GET', '/manifest', null, null);
                if (res.status === 200 && adminToken) { ready = true; break; }
            } catch (_) {}
        }
        assert(ready, 'Server failed to start on port ' + testPort);
        console.log('✓ Runtime server ready with adminToken');

        // Create a real device role key via auth.keys.create
        const keyRes = await request('POST', '/nodaic/v1/', {
            action: 'auth.keys.create',
            payload: { role: 'device', keyId: 'dev_test_runner' }
        }, adminToken);
        assert.strictEqual(keyRes.status, 200);
        const devToken = keyRes.body.token;
        console.log('✓ Device token generated via auth.keys.create');

        // Verify NO /state endpoint exists
        console.log('\n4. Verifying NO /state endpoint is exposed (Internal-only)...');
        const stateEndpointRes = await request('GET', '/state', null, adminToken);
        assert.strictEqual(stateEndpointRes.status, 404, '/state endpoint must return 404 (not exposed)');
        console.log('✓ Confirmed: /state is NOT an exposed endpoint (internal-only for workflows)');

        // Test variable.set with namespace gates
        console.log('\n5. Testing Variable RPC & Namespace Gates...');
        // Non-elevated caller trying to set in 'secrets'
        const devSecretSet = await request('POST', '/nodaic/v1/', {
            action: 'variable.set',
            payload: { namespace: 'secrets', key: 'MALICIOUS_KEY', value: '12345' }
        }, devToken);
        assert.strictEqual(devSecretSet.status, 403, 'Non-elevated device token must be rejected for namespace="secrets"');
        console.log('✓ Non-elevated token rejected from writing to namespace "secrets" (403)');

        // Elevate admin session
        const sudoRes = await request('POST', '/nodaic/v1/', { action: 'sudo-session', payload: {} }, adminToken);
        assert.strictEqual(sudoRes.status, 200);

        // Store secret via secret.set
        const secSetRes = await request('POST', '/nodaic/v1/', {
            action: 'secret.set',
            payload: { key: 'UNIFIED_TEST_API_KEY', value: 'secret_abc_xyz_777', description: 'Test secret in variables' }
        }, adminToken);
        assert.strictEqual(secSetRes.status, 200);
        console.log('✓ Secret stored in unified variables table via secret.set');

        // Read secret via secret.get
        const secGetRes = await request('POST', '/nodaic/v1/', {
            action: 'secret.get',
            payload: { key: 'UNIFIED_TEST_API_KEY' }
        }, adminToken);
        assert.strictEqual(secGetRes.status, 200);
        assert.strictEqual(secGetRes.body.value, 'secret_abc_xyz_777');
        console.log('✓ Secret retrieved and decrypted successfully');

        // Test variable.set for general user / workflow data with RBAC
        console.log('\n6. Testing Variable RBAC with roles_json...');
        // Store variable with restricted roles: ['admin']
        const adminVarSet = await request('POST', '/nodaic/v1/', {
            action: 'variable.set',
            payload: {
                namespace: 'user_profile',
                key: 'preferences',
                value: { theme: 'dark', language: 'en' },
                roles: ['admin']
            }
        }, adminToken);
        assert.strictEqual(adminVarSet.status, 200);

        // Admin can read it
        const adminVarGet = await request('POST', '/nodaic/v1/', {
            action: 'variable.get',
            payload: { namespace: 'user_profile', key: 'preferences' }
        }, adminToken);
        assert.strictEqual(adminVarGet.status, 200);
        assert.deepStrictEqual(adminVarGet.body.value, { theme: 'dark', language: 'en' });
        console.log('✓ Admin successfully read admin-restricted variable');

        // Device role (non-admin) should be forbidden
        const devVarGet = await request('POST', '/nodaic/v1/', {
            action: 'variable.get',
            payload: { namespace: 'user_profile', key: 'preferences' }
        }, devToken);
        assert.strictEqual(devVarGet.status, 403, 'Device role must be rejected for admin-only variable');
        console.log('✓ Non-permitted role blocked by row-level RBAC (403)');

        // Store variable with public access: roles: ['*']
        const publicVarSet = await request('POST', '/nodaic/v1/', {
            action: 'variable.set',
            payload: {
                namespace: 'workflow_config',
                key: 'max_retries',
                value: 3,
                roles: ['*']
            }
        }, adminToken);
        assert.strictEqual(publicVarSet.status, 200);

        // Device can read public variable
        const devPublicGet = await request('POST', '/nodaic/v1/', {
            action: 'variable.get',
            payload: { namespace: 'workflow_config', key: 'max_retries' }
        }, devToken);
        assert.strictEqual(devPublicGet.status, 200);
        assert.strictEqual(devPublicGet.body.value, 3);
        console.log('✓ Device role successfully read public variable (roles: ["*"])');

        // Test variable.list
        console.log('\n7. Testing variable.list...');
        const listRes = await request('POST', '/nodaic/v1/', {
            action: 'variable.list',
            payload: { namespace: 'workflow_config' }
        }, devToken);
        assert.strictEqual(listRes.status, 200);
        assert(listRes.body.variables.some(v => v.key === 'max_retries'));
        console.log('✓ variable.list correctly filtered accessible variables');

        // Test variable.delete
        console.log('\n8. Testing variable.delete...');
        const delRes = await request('POST', '/nodaic/v1/', {
            action: 'variable.delete',
            payload: { namespace: 'workflow_config', key: 'max_retries' }
        }, adminToken);
        assert.strictEqual(delRes.status, 200);
        assert.strictEqual(delRes.body.status, 'deleted');
        console.log('✓ variable.delete successfully deleted variable');

        console.log('\n=========================================');
        console.log('ALL UNIFIED VARIABLES & GATE TESTS PASSED!');
        console.log('=========================================');

    } finally {
        serverProc.kill('SIGTERM');
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
}

runUnifiedVariablesTests().catch(err => {
    console.error('\nTest failed with error:', err);
    process.exit(1);
});
