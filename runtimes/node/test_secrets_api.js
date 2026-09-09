const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

async function runApiTests() {
    console.log('=== Running Secrets REST & RPC API Tests ===\n');

    // Test with child process running runtime.js on an isolated port
    const { spawn } = require('child_process');
    const testPort = 3987;
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const env = {
        ...process.env,
        PORT: String(testPort),
        NODAIC_MASTER_SECRET: testSecret,
        NODAIC_VERBOSE: 'false',
        NODAIC_WORKER: '1' // run directly in worker mode without supervisor watcher loop for test
    };

    const serverProc = spawn('node', ['runtime.js'], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutData = '';
    const { generateAPIKey } = require('./helpers/token.js');
    let adminToken = await generateAPIKey(testSecret, 'admin:admin_boot', 1);

    serverProc.stdout.on('data', (d) => {
        const str = d.toString();
        stdoutData += str;
        const match = str.match(/[0-9A-F]{256}/i);
        if (match) {
            adminToken = match[0];
        }
    });

    serverProc.stderr.on('data', (d) => {
        console.error('[server stderr]', d.toString());
    });

    // Helper for HTTP requests
    function makeRequest(method, reqPath, body = null, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost',
                port: testPort,
                path: reqPath,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(adminToken ? { 'Authorization': `Bearer ${adminToken}` } : {}),
                    ...headers
                }
            }, (res) => {
                let resBody = '';
                res.on('data', chunk => resBody += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(resBody);
                        resolve({ status: res.statusCode, body: parsed });
                    } catch (e) {
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
        // Wait for server to start
        let ready = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 200));
            try {
                const res = await makeRequest('GET', '/manifest');
                if (res.status === 200) {
                    ready = true;
                    break;
                }
            } catch (_) {}
        }
        assert(ready, 'Server should be ready on port ' + testPort);
        assert(adminToken, 'Admin token should be captured from boot');
        console.log('✓ Server booted successfully with token:', adminToken.slice(0, 25) + '...');

        // 1. Elevate session (sudo-session)
        const sudoRes = await makeRequest('POST', '/nodaic/v1/', { action: 'sudo-session', payload: {} });
        assert.strictEqual(sudoRes.status, 200);
        console.log('✓ Session elevated with sudo-session');

        // 2. Test PUT /secrets/:key (REST)
        console.log('Testing PUT /secrets/PAYMENT_GATEWAY_KEY...');
        const putRes = await makeRequest('PUT', '/secrets/PAYMENT_GATEWAY_KEY', {
            value: 'stripe_live_sec_1234567890',
            description: 'Live stripe payment secret key'
        });
        assert.strictEqual(putRes.status, 200);
        assert.strictEqual(putRes.body.status, 'stored');
        console.log('✓ Secret stored via REST PUT');

        // 3. Test GET /secrets (Masked list)
        console.log('Testing GET /secrets...');
        const listRes = await makeRequest('GET', '/secrets');
        assert.strictEqual(listRes.status, 200);
        assert(Array.isArray(listRes.body.secrets));
        const found = listRes.body.secrets.find(s => s.key === 'PAYMENT_GATEWAY_KEY');
        assert(found, 'Stored secret must appear in list');
        assert.strictEqual(found.value, '●●●●●●●●', 'Secret value must be masked');
        assert.strictEqual(found.hint, '7890', 'Hint should be the last 4 characters');
        console.log('✓ GET /secrets returns masked secret list');

        // 4. Test POST /secrets/:key/reveal (Unmask)
        console.log('Testing POST /secrets/PAYMENT_GATEWAY_KEY/reveal...');
        const revealRes = await makeRequest('POST', '/secrets/PAYMENT_GATEWAY_KEY/reveal');
        assert.strictEqual(revealRes.status, 200);
        assert.strictEqual(revealRes.body.value, 'stripe_live_sec_1234567890');
        console.log('✓ POST /secrets/:key/reveal successfully returns decrypted secret');

        // 5. Test RPC secret.set, secret.get, secret.list
        console.log('Testing RPC secret.set...');
        const rpcSetRes = await makeRequest('POST', '/nodaic/v1/', {
            action: 'secret.set',
            payload: { key: 'JWT_SIGNING_KEY', value: 'jwt-very-secret-signing-key-999' }
        });
        assert.strictEqual(rpcSetRes.status, 200);

        const rpcGetRes = await makeRequest('POST', '/nodaic/v1/', {
            action: 'secret.get',
            payload: { key: 'JWT_SIGNING_KEY' }
        });
        assert.strictEqual(rpcGetRes.status, 200);
        assert.strictEqual(rpcGetRes.body.value, 'jwt-very-secret-signing-key-999');
        console.log('✓ RPC secret.set and secret.get work properly');

        // 6. Test DELETE /secrets/:key
        console.log('Testing DELETE /secrets/PAYMENT_GATEWAY_KEY...');
        const delRes = await makeRequest('DELETE', '/secrets/PAYMENT_GATEWAY_KEY');
        assert.strictEqual(delRes.status, 200);
        assert.strictEqual(delRes.body.status, 'deleted');

        const listAfterDel = await makeRequest('GET', '/secrets');
        assert(!listAfterDel.body.secrets.some(s => s.key === 'PAYMENT_GATEWAY_KEY'), 'Secret should be deleted');
        console.log('✓ DELETE /secrets/:key successfully removed secret');

        console.log('\n=========================================');
        console.log('ALL REST & RPC API TESTS PASSED!');
        console.log('=========================================\n');

    } finally {
        serverProc.kill('SIGTERM');
        await new Promise(resolve => {
            const t = setTimeout(() => {
                try { serverProc.kill('SIGKILL'); } catch (_) {}
                resolve();
            }, 1000);
            serverProc.on('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
    }
}

runApiTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('API Test failed with error:', err);
    process.exit(1);
});
