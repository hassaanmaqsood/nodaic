#!/usr/bin/env node

/**
 * nodaic-admin.js — The intuitive Nodaic Runtime CLI
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Helpers --------------------------------------------------------

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    mruntimea: "\x1b[35m",
    cyan: "\x1b[36m",
};

const log = {
    info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg) => console.log(`${colors.green}✔${colors.reset} ${msg}`),
    warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg) => console.error(`${colors.red}✘${colors.reset} ${msg}`),
    bold: (msg) => console.log(`${colors.bright}${msg}${colors.reset}`),
    stream: (data) => {
        let prefix = `${colors.dim}[stream]${colors.reset}`;
        if (data.event === 'error') prefix = `${colors.red}[error]${colors.reset}`;
        if (data.event === 'run.done') prefix = `${colors.green}[done]${colors.reset}`;
        console.log(`${prefix}`, data);
    }
};

// Auto-load .env if it exists
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
        const [key, ...val] = line.split('=');
        if (key && val) process.env[key.trim()] = val.join('=').trim().replace(/(^"|"$)/g, '');
    });
}

const CONFIG = {
    url: process.env.NODAIC_URL || 'http://localhost:3030/nodaic/v1/',
    token: process.env.NODAIC_ADMIN_TOKEN || '',
};

// --- API Client -----------------------------------------------------

async function dispatch(action, payload = {}) {
    if (!CONFIG.token) {
        log.error('NODAIC_ADMIN_TOKEN not found in environment or .env file.');
        log.info('Usage: export NODAIC_ADMIN_TOKEN="your.token"');
        process.exit(1);
    }

    const body = JSON.stringify({ action, token: CONFIG.token, payload });
    const url = new URL(CONFIG.url);
    
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            const isStream = res.headers['content-type'] === 'application/x-ndjson';
            let data = '';

            res.on('data', (chunk) => {
                const text = chunk.toString();
                if (isStream) {
                    text.split('\n').filter(l => l.trim()).forEach(line => {
                        try { log.stream(JSON.parse(line)); } catch { console.log(line); }
                    });
                } else {
                    data += text;
                }
            });

            res.on('end', () => {
                if (isStream) return resolve();
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                    else resolve(parsed);
                } catch (e) { reject(new Error('Response not JSON: ' + data)); }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// --- CLI Commands ---------------------------------------------------

const help = () => {
    log.bold('\nNodaic Admin CLI v2');
    console.log(`${colors.dim}Target: ${CONFIG.url}${colors.reset}\n`);
    
    const usage = (cmd, desc) => console.log(`  ${colors.cyan}${cmd.padEnd(25)}${colors.reset} ${desc}`);
    
    log.bold('Core Commands:');
    usage('status', 'Check health, uptime, and stats');
    usage('run <id> [input]', 'Execute artifact & stream results');
    usage('emit <event> [data]', 'Manually trigger a scheduler event');

    log.bold('\nArtifacts (lib):');
    usage('lib ls', 'List all artifacts in library');
    usage('lib push <file>', 'Push/Update artifact from JS file');
    usage('lib get <id>', 'Inspect artifact definition');
    usage('lib rm <id>', 'Delete artifact from runtime');

    log.bold('\nKey Management:');
    usage('key add <role> [scope]', 'Create new API key (scope is JSON)');
    usage('key rm <id>', 'Revoke/Delete an API key');

    log.bold('\nBindings:');
    usage('bindings', 'List all event-to-artifact bindings');
    usage('bind <event> <id>', 'Link an event to an artifact');
    usage('unbind <event> [id]', 'Remove specific or all bindings for event');

    console.log('\n');
};

const parsePayload = (val) => {
    if (!val) return {};
    try { return JSON.parse(val); } catch {
        // Fallback: try key=val shorthand?
        if (val.includes('=')) {
            const obj = {};
            val.split(',').forEach(pair => {
                const [k, v] = pair.split('=');
                obj[k.trim()] = v.trim();
            });
            return obj;
        }
        log.error(`Invalid JSON or shorthand: ${val}`);
        process.exit(1);
    }
};

async function main() {
    const [group, sub, ...rest] = process.argv.slice(2);

    try {
        switch (group) {
            case 'status':
                const info = await dispatch('runtime.status');
                log.success('Runtime Online');
                console.dir(info, { colors: true, depth: null });
                break;

            case 'run':
                if (!sub) throw new Error('Usage: run <artifactId> [input_json]');
                await dispatch('run.start', { artifactId: sub, input: parsePayload(rest[0]) });
                break;

            case 'emit':
                if (!sub) throw new Error('Usage: emit <event> [data_json]');
                await dispatch('trigger.emit', { event: sub, data: parsePayload(rest[0]) });
                break;

            case 'lib':
                if (sub === 'ls') {
                    const { artifacts } = await dispatch('library.list');
                    console.table(artifacts);
                } else if (sub === 'push') {
                    const filePath = path.resolve(rest[0] || '');
                    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
                    const artifact = require(filePath);
                    const res = await dispatch('library.push', { artifact });
                    log.success(`Artifact pushed: ${res.id} (v${res.version})`);
                } else if (sub === 'get') {
                    if (!rest[0]) throw new Error('Usage: lib get <id>');
                    console.dir(await dispatch('library.get', { id: rest[0] }), { colors: true });
                } else if (sub === 'rm') {
                    if (!rest[0]) throw new Error('Usage: lib rm <id>');
                    await dispatch('library.remove', { id: rest[0] });
                    log.success('Artifact removed.');
                } else {
                    throw new Error('Unknown lib command. Use: ls, push, get, rm');
                }
                break;

            case 'key':
                if (sub === 'add') {
                    const role = rest[0];
                    const scope = parsePayload(rest[1]);
                    if (!role) throw new Error('Usage: key add <role> [scope_json]');
                    const res = await dispatch('auth.keys.create', { role, scope });
                    log.success('Key Created');
                    console.log(`\n  ${colors.bright}Token:${colors.reset} ${colors.yellow}${res.token}${colors.reset}\n`);
                } else if (sub === 'rm') {
                    if (!rest[0]) throw new Error('Usage: key rm <id>');
                    await dispatch('auth.keys.revoke', { keyId: rest[0] });
                    log.success('Key revoked.');
                } else {
                    throw new Error('Unknown key command. Use: add, rm');
                }
                break;

            case 'bind':
                if (!sub || !rest[0]) throw new Error('Usage: bind <event> <artifactId>');
                await dispatch('trigger.bind', { event: sub, artifactId: rest[0] });
                log.success(`Bound event '${sub}' to '${rest[0]}'`);
                break;

            case 'unbind':
                if (!sub) throw new Error('Usage: unbind <event> [artifactId]');
                await dispatch('trigger.unbind', { event: sub, artifactId: rest[0] });
                log.success(`Unbound event '${sub}'`);
                break;

            case 'bindings':
                const { bindings } = await dispatch('runtime.status'); // status contains bindings too
                console.log(bindings);
                break;

            case 'help':
            case undefined:
                help();
                break;

            default:
                log.error(`Unknown command: ${group}`);
                help();
        }
    } catch (e) {
        log.error(e.message);
        process.exit(1);
    }
}

main();
