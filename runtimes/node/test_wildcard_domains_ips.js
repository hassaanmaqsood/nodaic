const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
    isOriginAllowed,
    isIPAllowed,
    wildcardToRegex,
    normalizeIP,
    matchCIDR
} = require('./runtime.js');

async function testWildcardDomainsAndIPs() {
    console.log('=== Running Wildcard Domains & IP Addresses Tests ===\n');

    // ─── 1. Unit Tests for Domain / Origin Wildcard Matching ───
    console.log('1. Testing Domain / Origin Wildcard Matcher...');

    // Star wildcard
    assert.strictEqual(isOriginAllowed('http://anywhere.com', ['*']), true);
    assert.strictEqual(isOriginAllowed('https://sub.domain.org:9000', ['*']), true);

    // Subdomain wildcard
    assert.strictEqual(isOriginAllowed('https://api.example.com', ['*.example.com']), true);
    assert.strictEqual(isOriginAllowed('http://sub.example.com:3000', ['*.example.com']), true);
    assert.strictEqual(isOriginAllowed('https://deep.sub.example.com', ['*.example.com']), true);
    assert.strictEqual(isOriginAllowed('https://badexample.com', ['*.example.com']), false);
    assert.strictEqual(isOriginAllowed('https://other.org', ['*.example.com']), false);

    // Port wildcard
    assert.strictEqual(isOriginAllowed('http://localhost:3000', ['http://localhost:*']), true);
    assert.strictEqual(isOriginAllowed('http://localhost:5173', ['http://localhost:*']), true);
    assert.strictEqual(isOriginAllowed('http://127.0.0.1:8080', ['http://127.0.0.1:*']), true);
    assert.strictEqual(isOriginAllowed('http://192.168.1.1:8080', ['http://127.0.0.1:*']), false);

    // Protocol + Subdomain + Port wildcard
    assert.strictEqual(isOriginAllowed('https://staging.app.io:8443', ['https://*.app.io:*']), true);
    assert.strictEqual(isOriginAllowed('http://staging.app.io:8443', ['https://*.app.io:*']), false);

    // IP address wildcards in origin
    assert.strictEqual(isOriginAllowed('http://192.168.1.50:3000', ['http://192.168.1.*:*']), true);
    assert.strictEqual(isOriginAllowed('http://192.168.1.50:3000', ['192.168.1.*']), true);
    assert.strictEqual(isOriginAllowed('http://192.168.2.50:3000', ['192.168.1.*']), false);
    assert.strictEqual(isOriginAllowed('http://10.0.5.12:8080', ['10.*.*.*']), true);
    assert.strictEqual(isOriginAllowed('http://172.16.1.1:9090', ['172.16.*.*']), true);

    console.log('✓ Domain and Origin wildcard matching verified');

    // ─── 2. Unit Tests for IP Address Wildcard & CIDR Matching ───
    console.log('\n2. Testing IP Address Wildcard & CIDR Matcher...');

    // Star wildcard
    assert.strictEqual(isIPAllowed('192.168.1.1', ['*']), true);
    assert.strictEqual(isIPAllowed('10.0.0.1', ['*']), true);

    // Wildcard IP octets
    assert.strictEqual(isIPAllowed('192.168.1.45', ['192.168.1.*']), true);
    assert.strictEqual(isIPAllowed('192.168.2.45', ['192.168.1.*']), false);
    assert.strictEqual(isIPAllowed('192.168.99.100', ['192.168.*.*']), true);
    assert.strictEqual(isIPAllowed('10.254.1.2', ['10.*.*.*']), true);
    assert.strictEqual(isIPAllowed('11.0.0.1', ['10.*.*.*']), false);

    // IPv6 / IPv4-mapped
    assert.strictEqual(isIPAllowed('::ffff:192.168.1.45', ['192.168.1.*']), true);
    assert.strictEqual(isIPAllowed('::1', ['127.0.0.1']), true);
    assert.strictEqual(isIPAllowed('127.0.0.1', ['127.0.0.1']), true);

    // CIDR notation
    assert.strictEqual(matchCIDR('192.168.1.50', '192.168.1.0/24'), true);
    assert.strictEqual(matchCIDR('192.168.2.50', '192.168.1.0/24'), false);
    assert.strictEqual(matchCIDR('10.55.2.1', '10.0.0.0/8'), true);
    assert.strictEqual(isIPAllowed('192.168.1.120', ['192.168.1.0/24']), true);
    assert.strictEqual(isIPAllowed('192.168.2.120', ['192.168.1.0/24']), false);

    console.log('✓ IP wildcard, IPv6 normalization, and CIDR matching verified');

    // ─── 3. Integration Tests with Live HTTP Server ───
    console.log('\n3. Testing Live Server CORS and IP Access Control with Wildcards...');

    const testPort = 3991;
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const env = {
        ...process.env,
        PORT: String(testPort),
        NODAIC_MASTER_SECRET: testSecret,
        NODAIC_ALLOWED_ORIGINS: 'https://*.mycloud.org:*, http://192.168.1.*:*',
        NODAIC_ALLOWED_IPS: '127.0.0.1, 192.168.*.*',
        NODAIC_TOKEN_EPOCH: '1',
        NODAIC_VERBOSE: 'false',
        NODAIC_WORKER: '1'
    };

    const serverProc = spawn('node', ['runtime.js'], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stderr.on('data', d => console.error('[server err]', d.toString()));

    function makeRequest(path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: testPort,
                path,
                method: 'GET',
                headers
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    resolve({ status: res.statusCode, headers: res.headers, body });
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    try {
        // Wait for server ready
        let ready = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 200));
            try {
                const res = await makeRequest('/manifest');
                if (res.status === 200) { ready = true; break; }
            } catch (_) {}
        }
        assert(ready, 'Server should start on port ' + testPort);
        console.log('✓ Live server started with wildcard domain & IP configuration');

        // Test 1: Allowed domain wildcard (https://sub.mycloud.org:8443)
        const allowedDomainRes = await makeRequest('/manifest', {
            'Origin': 'https://sub.mycloud.org:8443'
        });
        assert.strictEqual(allowedDomainRes.status, 200);
        assert.strictEqual(
            allowedDomainRes.headers['access-control-allow-origin'],
            'https://sub.mycloud.org:8443',
            'CORS header should reflect allowed wildcard domain origin'
        );
        console.log('✓ CORS header correctly returned for wildcard domain origin https://*.mycloud.org:*');

        // Test 2: Allowed IP origin wildcard (http://192.168.1.88:4000)
        const allowedIpOriginRes = await makeRequest('/manifest', {
            'Origin': 'http://192.168.1.88:4000'
        });
        assert.strictEqual(allowedIpOriginRes.status, 200);
        assert.strictEqual(
            allowedIpOriginRes.headers['access-control-allow-origin'],
            'http://192.168.1.88:4000',
            'CORS header should reflect allowed wildcard IP origin'
        );
        console.log('✓ CORS header correctly returned for wildcard IP origin http://192.168.1.*:*');

        // Test 3: Unauthorized domain origin (https://evil.attacker.com)
        const unauthDomainRes = await makeRequest('/manifest', {
            'Origin': 'https://evil.attacker.com'
        });
        assert.strictEqual(unauthDomainRes.status, 200);
        assert.strictEqual(
            unauthDomainRes.headers['access-control-allow-origin'],
            undefined,
            'CORS header must NOT be set for unauthorized origin'
        );
        console.log('✓ CORS header rejected for unauthorized domain https://evil.attacker.com');

        // Test 4: Client IP restriction (X-Forwarded-For)
        const blockedIpRes = await makeRequest('/manifest', {
            'X-Forwarded-For': '203.0.113.195'
        });
        assert.strictEqual(blockedIpRes.status, 403, 'Unauthorized client IP must be rejected with 403');
        const parsedBody = JSON.parse(blockedIpRes.body);
        assert.strictEqual(parsedBody.code, 'forbidden');
        console.log('✓ Client IP outside allowed list rejected with 403 Forbidden');

        // Test 5: Client IP in allowed wildcard range (192.168.5.20)
        const allowedClientIpRes = await makeRequest('/manifest', {
            'X-Forwarded-For': '192.168.5.20'
        });
        assert.strictEqual(allowedClientIpRes.status, 200, 'Client IP in allowed wildcard range 192.168.*.* must be accepted');
        console.log('✓ Client IP in allowed wildcard range 192.168.*.* accepted (200 OK)');

        console.log('\n=========================================');
        console.log('ALL WILDCARD DOMAIN & IP TESTS PASSED!');
        console.log('=========================================');

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

testWildcardDomainsAndIPs().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('\nTest failed with error:', err);
    process.exit(1);
});
