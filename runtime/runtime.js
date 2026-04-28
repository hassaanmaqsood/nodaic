/**
 * runtime.js — Nodaic Unified API Runtime
 *
 * System:
 *   POST /nodaic/v1/          → Single endpoint for all operations
 *   GET|POST /trigger/:event  → Webhook entry
 *   WS /nodaic/v1/ws          → Stream endpoint for all operations
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createNodaicSystem } = require('./nodaic_minimal');
const { WorkflowScheduler } = require('./nodaic_scheduler');

// --- Env Loader -----------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
        const [key, ...val] = line.split('=');
        if (key && val.length) process.env[key.trim()] = val.join('=').trim().replace(/(^"|"$)/g, '');
    });
}


/* ─── Config ─────────────────────────────────────────────────────── */

const CONFIG = {
    runtimeId: 'unified-runtime',
    port: 3030,
    verbose: true,
    artifactsDir: path.join(__dirname, 'artifacts'),
    bindingsFile: path.join(__dirname, 'bindings.json'),
    keysFile: path.join(__dirname, 'keys.json'),
    kvStoreFile: path.join(__dirname, 'kv.json'),
    signingKey: process.env.NODAIC_SIGNING_KEY || 'default-insecure-signing-key-123456',
    appSecret: process.env.NODAIC_APP_SECRET
};


/* ─── System ─────────────────────────────────────────────────────── */

const nodaic = createNodaicSystem();
const { library, addArtifact, stripPrivate } = nodaic;

/* ─── Storage Loaders ────────────────────────────────────────────── */

function loadBindings() {
    if (!fs.existsSync(CONFIG.bindingsFile)) return;
    try {
        const raw = fs.readFileSync(CONFIG.bindingsFile, 'utf8');
        const saved = JSON.parse(raw);
        for (const [event, ids] of Object.entries(saved)) {
            for (const artifactId of ids) {
                scheduler.on(event, artifactId);
            }
        }
    } catch (err) {
        console.error('[runtime] Failed to load bindings:', err);
    }
}

async function saveBindings() {
    const data = scheduler.bindings(); 
    fs.writeFileSync(CONFIG.bindingsFile, JSON.stringify(data, null, 2));
}

/* ─── Simple KV Storage (Encrypted) ─────────────────────────────── */

class SimpleKV {
    constructor(filePath, secretHex) {
        this.filePath = filePath;
        if (!secretHex || secretHex.length !== 64) {
             throw new Error('NODAIC_APP_SECRET must be a 64-character hex string (32 bytes)');
        }
        this.secret = Buffer.from(secretHex, 'hex');
        this.data = {};
        this._load();
    }

    _load() {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            this.data = JSON.parse(raw);
        } catch (err) {
            console.error('[kv] Failed to load store:', err);
        }
    }

    _save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    get(key) {
        const encrypted = this.data[key];
        if (!encrypted) return null;
        try {
            return this._decrypt(encrypted);
        } catch (err) {
            console.error(`[kv] Failed to decrypt key "${key}":`, err.message);
            return null;
        }
    }

    put(key, value) {
        this.data[key] = this._encrypt(value);
        this._save();
    }

    _encrypt(text) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', this.secret, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }

    _decrypt(encryptedText) {
        const parts = encryptedText.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encrypted = parts.join(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.secret, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
}

const kv = CONFIG.appSecret ? new SimpleKV(CONFIG.kvStoreFile, CONFIG.appSecret) : null;

let keysStore = {};

function loadKeys() {
    if (!kv) {
        console.warn('[!] NODAIC_APP_SECRET not set. Falling back to insecure keys.json');
        if (!fs.existsSync(CONFIG.keysFile)) {
            bootstrapAdmin();
        } else {
            try {
                keysStore = JSON.parse(fs.readFileSync(CONFIG.keysFile, 'utf8'));
            } catch (err) { console.error('[runtime] Load keys failed:', err); }
        }
        return;
    }

    // Attempt migration from legacy keys.json
    if (fs.existsSync(CONFIG.keysFile)) {
        try {
            const legacy = JSON.parse(fs.readFileSync(CONFIG.keysFile, 'utf8'));
            keysStore = legacy;
            saveKeys();
            fs.renameSync(CONFIG.keysFile, CONFIG.keysFile + '.migrated');
            console.log('[runtime] Migrated keys to encrypted KV store.');
        } catch (err) { console.error('[runtime] Migration failed:', err); }
    } else {
        const saved = kv.get('nodaic:keys');
        if (saved) {
            try {
                keysStore = JSON.parse(saved);
            } catch (err) { console.error('[runtime] KV Parse failed:', err); }
        } else {
            bootstrapAdmin();
        }
    }
}

function bootstrapAdmin() {
    const adminKeyId = `admin_${crypto.randomBytes(4).toString('hex')}`;
    keysStore = {
        [adminKeyId]: { role: 'admin', scope: { events: ['*'], artifacts: ['*'] } }
    };
    saveKeys();
    console.log(`\n[!] BOOTSTRAP: Generated first admin key.`);
    console.log(`[!] Admin Token: ${generateToken(adminKeyId)}\n`);
}

function saveKeys() {
    if (kv) {
        kv.put('nodaic:keys', JSON.stringify(keysStore));
    } else {
        fs.writeFileSync(CONFIG.keysFile, JSON.stringify(keysStore, null, 2));
    }
}


/* ─── Auth / Tokens ──────────────────────────────────────────────── */

// Tokens are derived via HMAC of keyId with the server's signing key.
function generateToken(keyId) {
    const hash = crypto.createHmac('sha256', CONFIG.signingKey).update('api' + keyId).digest('hex');
    return `${keyId}.${hash}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [keyId, hash] = parts;
    const expected = crypto.createHmac('sha256', CONFIG.signingKey).update('api' + keyId).digest('hex');
    if (hash === expected) return keyId; // Return platform-id / keyId
    return null;
}

function resolveAuth(token) {
    const keyId = verifyToken(token);
    if (!keyId) return { role: 'none', scope: { events: [], artifacts: [] } };
    const record = keysStore[keyId];
    if (!record) return { role: 'none', scope: { events: [], artifacts: [] } };
    return { keyId, role: record.role, scope: record.scope };
}

function matchesScope(value, scopes) {
    if (!scopes || !Array.isArray(scopes)) return false;
    if (scopes.includes('*')) return true;
    for (const s of scopes) {
        if (s.endsWith('*')) {
            const prefix = s.slice(0, -1);
            if (value.startsWith(prefix)) return true;
        } else if (s === value) {
            return true;
        }
    }
    return false;
}

function checkPermission(action, payload, auth) {
    const { role, scope } = auth;
    if (role === 'admin') return; // admins bypass all checks
    
    // Hard rejection for strictly admin paths
    if (['auth.keys.create', 'auth.keys.revoke'].includes(action)) {
        throw new Error('Forbidden: requires admin role');
    }

    if (action.startsWith('library.')) {
        if (['library.push', 'library.remove'].includes(action) && !['editor'].includes(role)) {
            throw new Error('Forbidden: requires editor role');
        }
    }

    if (action.startsWith('run.')) {
        if (!['runner'].includes(role)) throw new Error('Forbidden: requires runner role');
        if (action === 'run.start' && payload.artifactId) {
            if (!matchesScope(payload.artifactId, scope?.artifacts)) {
                throw new Error('Forbidden: artifact not in scope');
            }
        }
    }
    
    if (action.startsWith('trigger.')) {
        if (['trigger.bind', 'trigger.unbind'].includes(action) && !['editor'].includes(role)) {
            throw new Error('Forbidden: requires editor role');
        }
        if (action === 'trigger.emit' && payload.event) {
            if (!matchesScope(payload.event, scope?.events)) {
                throw new Error('Forbidden: event not in scope');
            }
        }
    }
}

/* ─── Artifact Loader ────────────────────────────────────────────── */

function loadArtifacts() {
    const folders = ['core', 'user'];
    folders.forEach(folder => {
        const dir = path.join(CONFIG.artifactsDir, folder);
        if (!fs.existsSync(dir)) return;

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
        files.forEach(file => {
            const filePath = path.join(dir, file);
            try {
                delete require.cache[require.resolve(filePath)];
                const artifact = require(filePath);
                const definition = artifact.default || artifact;
                if (definition.id && definition.artifactType) {
                    addArtifact(definition);
                }
            } catch (err) {
                console.error(`[loader] Failed to load ${file}:`, err.message);
            }
        });
    });
    console.log(`[loader] Initialized artifacts from ${CONFIG.artifactsDir}`);
}

// Initial loads
loadKeys();
loadArtifacts();

/* ─── Scheduler ──────────────────────────────────────────────────── */

const scheduler = new WorkflowScheduler(library, { verbose: CONFIG.verbose });
loadBindings();

/* ─── Global State ───────────────────────────────────────────────── */

const runs = new Map();
let _seq = 0;
const nextRunId = () => `run_${++_seq}_${Date.now()}`;

/* ─── Dispatcher ─────────────────────────────────────────────────── */

async function dispatch(action, payload, token, emitCallback) {
    const auth = resolveAuth(token);
    checkPermission(action, payload, auth);

    switch (action) {
        case 'auth.keys.create': {
            const { role, scope } = payload;
            const keyId = `key_${crypto.randomBytes(4).toString('hex')}`;
            keysStore[keyId] = { role, scope: scope || { events: [], artifacts: [] } };
            saveKeys();
            const newToken = generateToken(keyId);
            return { token: newToken, keyId, role, scope: keysStore[keyId].scope };
        }
        case 'auth.keys.revoke': {
            const { keyId } = payload;
            delete keysStore[keyId];
            saveKeys();
            return { status: 'revoked', keyId };
        }
        case 'library.list': {
            const artifacts = library.list().map(({ id, version }) => {
                const def = library.getArtifact(id, version);
                return { id: def.id, version: def.version, type: def.artifactType, metadata: def.metadata, interface: def.interface };
            });
            // basic array of artifacts
            return { artifacts };
        }
        case 'library.get': {
            const { id, version = 'latest' } = payload;
            const def = library.getArtifact(id, version);
            if (!def) throw new Error('Not found in library');
            return def;
        }
        case 'library.push': {
            const artifact = payload.artifact;
            if (!artifact || !artifact.id || !artifact.artifactType) throw new Error('Missing artifact id or artifactType');
            const fileName = `${artifact.id.replace(/\//g, '_')}.js`;
            const userDir = path.join(CONFIG.artifactsDir, 'user');
            if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
            
            const filePath = path.join(userDir, fileName);
            fs.writeFileSync(filePath, `module.exports = ${JSON.stringify(artifact, null, 2)};\n`);
            addArtifact(artifact);
            return { id: artifact.id, version: artifact.version || '1.0.0', status: 'saved' };
        }
        case 'library.remove': {
            const { id, version } = payload;
            if (!library.has(id)) throw new Error('Not found in library');
            if (version) {
                library.removeArtifact(id, version);
            } else {
                const fileName = `${id.replace(/\//g, '_')}.js`;
                const userPath = path.join(CONFIG.artifactsDir, 'user', fileName);
                if (fs.existsSync(userPath)) fs.unlinkSync(userPath);
                library.removeArtifact(id);
            }
            return { id, version, status: 'deleted' };
        }

        // Execution path produces streams
        case 'run.start': {
            const { artifactId, input = {}, state: seed = {} } = payload;
            const runId = payload.runId || nextRunId();
            
            emitCallback({ event: 'run.started', runId });
            
            const cleanSeed = stripPrivate(seed);
            runs.set(runId, { done: false });
            
            const work = artifactId 
                ? scheduler.run(artifactId, input, cleanSeed)
                : scheduler.emit('runtime:run', input);
            
            const result = await work;
            
            const finalResult = { 
                output: result?.output ?? result,
                state: stripPrivate(result?.state)
            };
            runs.delete(runId);
            
            emitCallback({ event: 'run.done', runId, output: finalResult.output });
            return finalResult;
        }
        case 'run.list': {
            return { activeRuns: Array.from(runs.keys()) };
        }
        case 'run.cancel': {
            const { runId } = payload;
            runs.delete(runId);
            return { status: 'cancelled', runId };
        }
        
        // Trigger path processes scheduler events natively
        case 'trigger.emit': {
            const { event, data } = payload;
            const runId = payload.runId || nextRunId();
            
            emitCallback({ event: 'trigger.emitted', runId, triggerEvent: event });
            
            const work = scheduler.emit(event, data);
            const results = await work; // array of scheduler results
            
            const finalOutputs = results.map(r => r?.output ?? r);
            emitCallback({ event: 'trigger.done', runId, count: results.length, outputs: finalOutputs });
            return { outputs: finalOutputs };
        }
        case 'trigger.bind': {
            const { event, artifactId, opts = {} } = payload;
            scheduler.on(event, artifactId, { once: opts.once ?? false });
            await saveBindings();
            return { event, artifactId, status: 'bound' };
        }
        case 'trigger.unbind': {
            const { event, artifactId = null } = payload;
            scheduler.off(event, artifactId);
            await saveBindings();
            return { event, artifactId, status: 'unbound' };
        }
        case 'trigger.list': {
            return { bindings: scheduler.bindings() };
        }

        case 'runtime.status': {
            return {
                runtimeId: CONFIG.runtimeId, 
                uptime: process.uptime(),
                activeRuns: runs.size, 
                bindings: scheduler.bindings()
            };
        }
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

/* ─── Express App / Transports ───────────────────────────────────── */

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// GET /nodaic/v1/ - Health verification
app.get('/nodaic/v1/', (req, res) => {
    res.json({
        runtimeId: CONFIG.runtimeId,
        environment: 'nodejs',
        api: 'unified-v1',
        capabilities: ['http', 'ws']
    });
});

// POST /nodaic/v1/ - Central unified interface
app.post('/nodaic/v1/', async (req, res) => {
    const { action, token, payload = {} } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action field' });

    let isStreaming = false;

    try {
        const emitCallback = (eventObj) => {
            if (!isStreaming) {
                isStreaming = true;
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
            }
            res.write(JSON.stringify(eventObj) + '\n');
        };

        const result = await dispatch(action, payload, token, emitCallback);
        
        if (!isStreaming) {
            res.json(result);
        } else {
            res.end();
        }
    } catch (err) {
        if (!isStreaming && !res.headersSent) {
            res.status(400).json({ error: err.message, event: 'error' });
        } else {
            res.write(JSON.stringify({ event: 'error', error: err.message }) + '\n');
            res.end();
        }
    }
});

// GET|POST /trigger/:event - Webhook fallback
app.all('/trigger/:event', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const event = req.params.event;
    
    const token = req.query.token || (req.body && req.body.token);
    let payloadData = req.method === 'GET' ? req.query : req.body;
    
    // Strip token from payload layer
    if (payloadData && payloadData.token) {
        const { token: _, ...rest } = payloadData;
        payloadData = rest;
    }
    
    try {
        // Run sync-only (noop emit logic to let caller only wait for result)
        const emitCallback = () => {};
        const result = await dispatch('trigger.emit', { event, data: payloadData }, token, emitCallback);
        res.json(result); // Final parsed output
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/* ─── WebSocket Server ───────────────────────────────────────────── */

const wss = new WebSocketServer({ server, path: '/nodaic/v1/ws' });

const wsSend = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };

wss.on('connection', (ws) => {
    console.log('[ws] Client connected to unified stream');

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return wsSend(ws, { event: 'error', error: 'Invalid JSON' }); }

        const { action, token, payload = {} } = msg;

        // Maintain basic ping logic
        if (msg.type === 'ping' || action === 'ping') {
            return wsSend(ws, { event: 'pong', ts: Date.now() });
        }
        
        if (!action) return wsSend(ws, { event: 'error', error: 'Missing action field' });

        try {
            const emitCallback = (eventObj) => wsSend(ws, eventObj);

            const result = await dispatch(action, payload, token, emitCallback);
            
            // Only send formal replies if the dispatch task was non-emitted (e.g. library.list)
            if (!['run.start', 'trigger.emit'].includes(action)) {
                wsSend(ws, { event: `${action}.reply`, result });
            }

        } catch (err) {
            wsSend(ws, { event: 'error', action, error: err.message });
        }
    });

    ws.on('close', () => {
        console.log('[ws] Client disconnected');
    });
});

/* ─── Start ──────────────────────────────────────────────────────── */

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

server.listen(CONFIG.port, () => {
    console.log(`\n[runtime] ${CONFIG.runtimeId} booted.`);
    console.log(`[runtime] Transport HTTP: POST http://localhost:${CONFIG.port}/nodaic/v1/`);
    console.log(`[runtime] Transport WS:   WS   ws://localhost:${CONFIG.port}/nodaic/v1/ws\n`);
});