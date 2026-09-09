/**
 * runtime.js — Nodaic Node.js API Runtime
 *
 * System:
 *   POST /nodaic/v1/          → Single endpoint for all operations
 *   GET|POST /trigger/:event  → Webhook entry
 *   GET|POST /trigger/pub/:token → Public opaque route
 *   WS /nodaic/v1/ws          → Stream endpoint for all operations
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const child_process = require('child_process');

/* ─── Supervisor / File Watcher Mode ─────────────────────────────── */
if (!process.env.NODAIC_WORKER && require.main === module) {
    let worker = null;
    let restartTimer = null;
    let isShuttingDown = false;

    function startWorker() {
        if (isShuttingDown) return;
        if (worker) {
            try { worker.kill('SIGTERM'); } catch (_) { }
        }
        worker = child_process.fork(__filename, process.argv.slice(2), {
            env: { ...process.env, NODAIC_WORKER: '1' },
            stdio: 'inherit'
        });
        worker.on('exit', (code, signal) => {
            if (!isShuttingDown && signal !== 'SIGTERM' && signal !== 'SIGKILL' && code !== 0 && code !== null) {
                console.log(`[watcher] Runtime worker exited with code ${code}. Waiting for .js changes to restart...`);
            }
        });
    }

    function setupWatcher(dir) {
        try {
            fs.watch(dir, { recursive: true }, (eventType, filename) => {
                if (!filename) return;
                if (!filename.endsWith('.js')) return;
                if (filename.includes('node_modules') || filename.includes('.git') || filename.includes('blobs') || filename.includes('.tmp')) return;

                if (restartTimer) clearTimeout(restartTimer);
                restartTimer = setTimeout(() => {
                    console.log(`\n[watcher] File change detected (${filename}). Restarting runtime...`);
                    startWorker();
                }, 250);
            });
        } catch (err) {
            console.warn('[watcher] Recursive fs.watch failed, falling back:', err.message);
        }
    }

    setupWatcher(__dirname);
    startWorker();

    function cleanExit() {
        isShuttingDown = true;
        if (worker) {
            try { worker.kill('SIGTERM'); } catch (_) { }
        }
        process.exit(0);
    }
    process.on('SIGINT', cleanExit);
    process.on('SIGTERM', cleanExit);
    return;
}

const express = require('express');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { createNodaicSystem } = require('./engine/nodaic_minimal.js');
const { WorkflowScheduler } = require('./engine/nodaic_scheduler.js');
const { TOKEN_CONTEXTS, generateAPIKey, validateToken } = require('./helpers/token.js');
const { IO, DatabasePipeline, BlobPipeline, Ops } = require('./helpers/storage.js');
const STATIC_REGISTRY = require('./library/index.js');
const { stateNode, isReservedNamespace, RESERVED_NAMESPACES } = require('./library/state_process.js');

/* ─── Error Classes ─────────────────────────────────────────────── */

class NotFoundError extends Error { constructor(msg) { super(msg); this.status = 404; this.code = 'not_found'; } }
class ForbiddenError extends Error { constructor(msg) { super(msg); this.status = 403; this.code = 'forbidden'; } }
class BadRequestError extends Error { constructor(msg) { super(msg); this.status = 400; this.code = 'bad_request'; } }
class ConflictError extends Error { constructor(msg) { super(msg); this.status = 409; this.code = 'conflict'; } }
class UnauthorizedError extends Error { constructor(msg) { super(msg); this.status = 401; this.code = 'unauthorized'; } }

// Spec §11 uniform error envelope
function errEnvelope(err) {
    return { error: true, code: err.code || 'server_error', reason: err.message };
}

// Extract bearer token: Authorization header first, then query/body token or auth_token
function extractToken(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return (req.query && (req.query.token || req.query.auth_token)) ||
        (req.body && (req.body.token || req.body.auth_token)) || null;
}


// --- Env Loader -----------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
        const [key, ...val] = line.split('=');
        if (key && val.length && process.env[key.trim()] === undefined) {
            process.env[key.trim()] = val.join('=').trim().replace(/(^"|"$)/g, '');
        }
    });
}

/* ─── Config ─────────────────────────────────────────────────────── */

const CONFIG_FILE = path.join(__dirname, 'runtime.config.json');

function loadOrGenerateConfig() {
    let saved = {};
    let isFirstBoot = false;

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (err) {
            console.error('[config] Failed to parse runtime.config.json, using defaults:', err.message);
        }
    } else {
        isFirstBoot = true;
    }

    const config = {
        // Identity
        runtimeId: process.env.NODAIC_RUNTIME_ID || saved.runtimeId || crypto.randomBytes(3).toString('hex'),
        port: Number(process.env.PORT || saved.port || 3030),
        verbose: saved.verbose ?? true,
        environment: saved.environment || 'nodejs',

        // Paths
        libraryDir: path.join(__dirname, 'library'),

        // Security — Master Secret is environment-only, never persisted to config file
        masterSecret: process.env.NODAIC_MASTER_SECRET || process.env.NODAIC_APP_SECRET || crypto.randomBytes(48).toString('base64'),

        // Token epoch for global revocation
        epoch: Number(process.env.NODAIC_TOKEN_EPOCH || saved.epoch || 1),

        // List of individually revoked key IDs
        revokedKeys: Array.isArray(saved.revokedKeys) ? saved.revokedKeys : [],

        // Token TTL in seconds (default 90 days)
        tokenTTL: Number(process.env.NODAIC_TOKEN_TTL || saved.tokenTTL || 90 * 24 * 60 * 60),

        // Executor
        heartbeatInterval: saved.heartbeatInterval ?? 30000,
        maxParallelRuns: saved.maxParallelRuns ?? null,

        // Auto-run entries: [{ id, input, state }]
        autoRun: saved.autoRun || [],

        // Network & Origin / IP access control (supports wildcards for domains, ports, and IPs)
        allowedOrigins: process.env.NODAIC_ALLOWED_ORIGINS || process.env.NODAIC_ALLOWED_DOMAINS || saved.allowedOrigins || [`http://localhost:${saved.port || 3030}`, 'http://127.0.0.1:*'],
        allowedIPs: process.env.NODAIC_ALLOWED_IPS || saved.allowedIPs || '*',

        // Internal
        _isFirstBoot: isFirstBoot,
        _savedPort: saved.port || 3030,
    };

    if (!process.env.NODAIC_MASTER_SECRET && !process.env.NODAIC_APP_SECRET) {
        console.warn('[security] NODAIC_MASTER_SECRET not set in environment. Using generated ephemeral in-memory secret.');
    }

    // Persist config (NEVER write masterSecret to disk)
    const persisted = {
        runtimeId: config.runtimeId,
        port: config._savedPort,
        verbose: config.verbose,
        environment: config.environment,
        heartbeatInterval: config.heartbeatInterval,
        maxParallelRuns: config.maxParallelRuns,
        autoRun: config.autoRun,
        epoch: config.epoch,
        revokedKeys: config.revokedKeys,
        allowedOrigins: config.allowedOrigins,
        allowedIPs: config.allowedIPs
    };
    try {
        writeAtomic(CONFIG_FILE, JSON.stringify(persisted, null, 2));
    } catch (err) {
        console.error('[config] Failed to write runtime.config.json:', err.message);
    }

    return config;
}

const CONFIG = loadOrGenerateConfig();

function saveConfig() {
    const persisted = {
        runtimeId: CONFIG.runtimeId,
        port: CONFIG._savedPort || 3030,
        verbose: CONFIG.verbose,
        environment: CONFIG.environment,
        heartbeatInterval: CONFIG.heartbeatInterval,
        maxParallelRuns: CONFIG.maxParallelRuns,
        autoRun: CONFIG.autoRun,
        epoch: CONFIG.epoch,
        revokedKeys: CONFIG.revokedKeys,
        allowedOrigins: CONFIG.allowedOrigins,
        allowedIPs: CONFIG.allowedIPs
    };
    try {
        writeAtomic(CONFIG_FILE, JSON.stringify(persisted, null, 2));
    } catch (err) {
        console.error('[config] Failed to write runtime.config.json:', err.message);
    }
}

/* ─── Runtime Identity & Capabilities ───────────────────────────── */

const RUNTIME = {
    id: CONFIG.runtimeId,
    environment: CONFIG.environment,
    capabilities: {
        persistent: true,
        writable: true,
        interpreter: true,
        artifact_deploy: 'live-post',
        maxValueSize: 1024 * 1024
    }
};

/* ─── System ─────────────────────────────────────────────────────── */

const nodaic = createNodaicSystem();
const { library, addArtifact, stripPrivate } = nodaic;

/* ─── Atomic Write ────────────────────────────────────────────────── */

function writeAtomic(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

/* ─── Log Ring Buffer (last 200 entries, polled via GET /logs) ─────── */

const logBuffer = [];
function rlog(level, msg) {
    logBuffer.push({ seq: logBuffer.length + 1, ts: Date.now(), level, message: String(msg) });
    if (logBuffer.length > 200) logBuffer.shift();
}

/* ─── Database & Storage Initialization ───────────────────────────── */

const dbPath = path.join(CONFIG.libraryDir, 'nodaic.db');
fs.mkdirSync(CONFIG.libraryDir, { recursive: true });

const _dbConn = new Database(dbPath, { timeout: 5000 });
try { _dbConn.pragma('journal_mode = WAL'); } catch (_) {}
try { _dbConn.pragma('busy_timeout = 5000'); } catch (_) {}
_dbConn.exec('PRAGMA foreign_keys = ON;');
stateNode.setDb(_dbConn);

const db = new DatabasePipeline({
    io: IO.SQLite,
    target: _dbConn
});

const blobPipeline = new BlobPipeline({
    io: IO.File,
    target: path.join(CONFIG.libraryDir, 'blobs')
});

/* ─── Global Secrets Resolver ─────────────────────────────────────── */

async function resolveSecret(key) {
    if (!key) return undefined;
    try {
        const varRows = await db.exec(
            `SELECT value, encrypted FROM variables WHERE namespace = 'secrets' AND key = ? AND type = 'secret'`,
            [key]
        );
        if (varRows.length && varRows[0].value) {
            if (varRows[0].encrypted) {
                return Ops.decrypt(varRows[0].value, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
            }
            return varRows[0].value;
        }

        const rows = await db.exec(
            `SELECT encrypted_val FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type IN ('credential', 'secret') AND revoked = 0`,
            [key]
        );
        if (rows.length && rows[0].encrypted_val) {
            return Ops.decrypt(rows[0].encrypted_val, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
        }
    } catch (e) {
        if (CONFIG.verbose) console.warn(`[secrets] DB lookup error for '${key}':`, e.message);
    }
    return process.env[key];
}

async function getAllSecrets() {
    const secretsMap = {};
    try {
        const varRows = await db.exec(
            `SELECT key, value, encrypted FROM variables WHERE namespace = 'secrets' AND type = 'secret'`
        );
        for (const row of varRows) {
            try {
                if (row.value) {
                    secretsMap[row.key] = row.encrypted
                        ? Ops.decrypt(row.value, Buffer.from(CONFIG.masterSecret.slice(0, 32)))
                        : row.value;
                }
            } catch (_) { }
        }

        const rows = await db.exec(
            `SELECT principal_id, encrypted_val FROM principals WHERE owner_id = 'local' AND type IN ('credential', 'secret') AND revoked = 0`
        );
        for (const row of rows) {
            try {
                if (row.encrypted_val && !secretsMap[row.principal_id]) {
                    secretsMap[row.principal_id] = Ops.decrypt(row.encrypted_val, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
                }
            } catch (_) {}
        }
    } catch (_) {}
    return { ...process.env, ...secretsMap };
}

library.setSecretsResolver(resolveSecret);

// Initialize 4-table minimal schema
_dbConn.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
        owner_id      TEXT    NOT NULL DEFAULT 'local',
        id            TEXT    NOT NULL,
        version       TEXT    NOT NULL,
        dispatch_key  TEXT    NOT NULL UNIQUE,
        artifact_type TEXT    NOT NULL,
        source_type   TEXT    NOT NULL,
        is_static     INTEGER NOT NULL DEFAULT 1,
        meta_json     TEXT,
        source_ref    TEXT,
        content_hash  TEXT,
        is_latest     INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (owner_id, id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_latest ON artifacts(owner_id, id) WHERE is_latest = 1;

    CREATE TABLE IF NOT EXISTS bindings (
        owner_id      TEXT    NOT NULL DEFAULT 'local',
        event         TEXT    NOT NULL,
        artifact_id   TEXT    NOT NULL,
        dispatch_key  TEXT    NOT NULL,
        once          INTEGER NOT NULL DEFAULT 0,
        public_token  TEXT,
        roles_json    TEXT,
        delivery      TEXT    NOT NULL DEFAULT 'trigger',
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (owner_id, event, artifact_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_public_token ON bindings(public_token) WHERE public_token IS NOT NULL;

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

    CREATE TABLE IF NOT EXISTS permissions (
        owner_id      TEXT    NOT NULL DEFAULT 'local',
        grantee_id    TEXT    NOT NULL,
        artifact_id   TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (owner_id, grantee_id, artifact_id)
    );

    CREATE TABLE IF NOT EXISTS variables (
        namespace   TEXT NOT NULL DEFAULT 'default',
        key         TEXT NOT NULL,
        value       TEXT,
        type        TEXT NOT NULL DEFAULT 'state',
        encrypted   INTEGER NOT NULL DEFAULT 0,
        roles_json  TEXT,
        owner_id    TEXT NOT NULL DEFAULT 'local',
        meta_json   TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_vars_type ON variables(type);
    CREATE INDEX IF NOT EXISTS idx_vars_ns ON variables(namespace);
`);

try { _dbConn.exec(`ALTER TABLE bindings ADD COLUMN roles_json TEXT;`); } catch (_) { }
try { _dbConn.exec(`ALTER TABLE bindings ADD COLUMN delivery TEXT DEFAULT 'trigger';`); } catch (_) { }

// Migration: sync any existing legacy state and principals into unified variables table
try {
    const legacyStatePath = path.join(__dirname, 'data', 'nodaic-state.db');
    if (fs.existsSync(legacyStatePath)) {
        const legacyDb = new Database(legacyStatePath);
        const legacyRows = legacyDb.prepare("SELECT namespace, key, value FROM state").all();
        const insertStmt = _dbConn.prepare(`
            INSERT OR IGNORE INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
            VALUES (?, ?, ?, 'state', 0, '["*"]', 'local', NULL, ?, ?)
        `);
        const now = Date.now();
        for (const row of legacyRows) {
            insertStmt.run(row.namespace, row.key, row.value, now, now);
        }
        legacyDb.close();
    }
} catch (_) { }

try {
    const credRows = _dbConn.prepare(`SELECT principal_id, encrypted_val, hint, meta_json, created_at FROM principals WHERE owner_id = 'local' AND type IN ('credential', 'secret')`).all();
    const insertVarStmt = _dbConn.prepare(`
        INSERT OR IGNORE INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
        VALUES ('secrets', ?, ?, 'secret', 1, '["admin"]', 'local', ?, ?, ?)
    `);
    for (const r of credRows) {
        insertVarStmt.run(r.principal_id, r.encrypted_val, r.meta_json, r.created_at, r.created_at);
    }
} catch (_) { }

/* ─── Storage Loaders ────────────────────────────────────────────── */

async function loadArtifacts() {
    try {
        let count = 0;
        const now = Date.now();

        for (const [dispatchKey, staticArt] of Object.entries(STATIC_REGISTRY)) {
            const version = staticArt.version || '1.0.0';
            const artWithVersion = { ...staticArt, version };
            addArtifact(artWithVersion);
            count++;

            const ownerId = staticArt.owner_id || 'local';
            const metaJson = JSON.stringify({
                name: staticArt.metadata?.name || staticArt.id,
                description: staticArt.metadata?.description || '',
                tags: staticArt.metadata?.tags || [],
                interface: staticArt.interface || {}
            });
            const contentHash = staticArt.source ? Ops.fingerprint(typeof staticArt.source === 'string' ? staticArt.source : staticArt.source.toString()) : null;

            await db.exec(`
                INSERT INTO artifacts (
                    owner_id, id, version, dispatch_key, artifact_type, source_type,
                    is_static, meta_json, source_ref, content_hash, is_latest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, 1, ?)
                ON CONFLICT(owner_id, id, version) DO UPDATE SET
                    meta_json = excluded.meta_json,
                    content_hash = excluded.content_hash,
                    is_latest = excluded.is_latest
            `, [
                ownerId,
                staticArt.id,
                version,
                dispatchKey,
                staticArt.artifactType || 'process',
                staticArt.sourceType || 'application/javascript',
                metaJson,
                contentHash,
                now
            ]);
        }

        // Load dynamic artifacts from SQLite (is_static = 0)
        const dynamicRows = await db.exec(`SELECT * FROM artifacts WHERE is_static = 0`);
        for (const row of dynamicRows) {
            try {
                let meta = {};
                try { meta = JSON.parse(row.meta_json || '{}'); } catch (_) { }
                let source = '';
                if (row.source_ref) {
                    source = await blobPipeline.read(row.source_ref);
                }
                const art = {
                    id: row.id,
                    version: row.version,
                    artifactType: row.artifact_type,
                    sourceType: row.source_type,
                    metadata: {
                        name: meta.name || row.id,
                        description: meta.description || '',
                        tags: meta.tags || []
                    },
                    interface: meta.interface || { inputs: {}, outputs: {} },
                    source: source || ''
                };
                addArtifact(art);
                count++;
            } catch (dynErr) {
                console.error(`[loader] Failed loading dynamic artifact ${row.id}@${row.version}:`, dynErr.message);
            }
        }

        console.log(`[loader] Initialized ${count} artifact version(s) (static + sqlite dynamic).`);
    } catch (err) {
        console.error(`[loader] Failed to load artifacts:`, err.message);
    }
}

async function loadBindings() {
    try {
        const rows = await db.exec(`SELECT * FROM bindings WHERE owner_id = 'local'`);
        for (const row of rows) {
            scheduler.on(row.event, row.artifact_id, { once: Boolean(row.once) });
        }
        console.log(`[loader] Initialized ${rows.length} event binding(s) from database.`);
    } catch (err) {
        console.error('[runtime] Failed to load bindings:', err.message);
    }
}

async function saveBindingRow(ownerId, event, artifactId, once = false, publicToken = null, rolesJson = null, delivery = 'trigger') {
    const dispatchKey = [ownerId, artifactId, 'v1'].join('__').replace(/[^a-z0-9_]/gi, '_');
    await db.exec(`
        INSERT OR REPLACE INTO bindings (owner_id, event, artifact_id, dispatch_key, once, public_token, roles_json, delivery, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [ownerId, event, artifactId, dispatchKey, once ? 1 : 0, publicToken, rolesJson, delivery, Date.now()]);
}

async function removeBindingRow(ownerId, event, artifactId = null) {
    if (artifactId) {
        await db.exec(`DELETE FROM bindings WHERE owner_id = ? AND event = ? AND artifact_id = ?`, [ownerId, event, artifactId]);
    } else {
        await db.exec(`DELETE FROM bindings WHERE owner_id = ? AND event = ?`, [ownerId, event]);
    }
}

/* ─── RBAC & Permission Scopes ────────────────────────────────────── */

const BUILTIN_ROLES = {
    admin: {
        name: 'admin',
        label: 'Administrator',
        description: 'Full system control, key management, credentials, and RBAC',
        isAdmin: true,
        scopes: ['*']
    },
    developer: {
        name: 'developer',
        label: 'Developer',
        description: 'Build, deploy, and test graphs, process nodes, triggers, and execution',
        isAdmin: false,
        scopes: [
            'whoami',
            'run:*',
            'trigger:*',
            'library:*',
            'secrets:*',
            'credentials:*',
            'variables:*',
            'variable:*',
            'runtime:status',
            'runtime:list',
            'sudo-session'
        ]
    },
    operator: {
        name: 'operator',
        label: 'Operator / Ops',
        description: 'Run workflows, emit triggers, view library, and monitor system runs',
        isAdmin: false,
        scopes: [
            'whoami',
            'run:*',
            'trigger:emit',
            'trigger:list',
            'library:list',
            'library:get',
            'variables:read',
            'variable:get',
            'variable:list',
            'runtime:status',
            'runtime:list'
        ]
    },
    device: {
        name: 'device',
        label: 'Device / Runner',
        description: 'Automated runner / client execution token',
        isAdmin: false,
        scopes: [
            'whoami',
            'run:*',
            'trigger:emit',
            'trigger:list',
            'library:list',
            'library:get',
            'variables:*',
            'variable:*',
            'runtime:status',
            'runtime:list',
            'sudo-session'
        ]
    },
    viewer: {
        name: 'viewer',
        label: 'Auditor / Viewer',
        description: 'Read-only access to status, library, triggers, and execution logs',
        isAdmin: false,
        scopes: [
            'whoami',
            'run:list',
            'run:get',
            'trigger:list',
            'library:list',
            'library:get',
            'variables:read',
            'variable:get',
            'variable:list',
            'runtime:status',
            'runtime:list'
        ]
    },
    anonymous: {
        name: 'anonymous',
        label: 'Anonymous / Public',
        description: 'Unauthenticated public webhooks and whoami inspection',
        isAdmin: false,
        scopes: [
            'whoami',
            'rolesys.is_role_sys'
        ]
    }
};

function matchesScope(scopePattern, action) {
    if (!scopePattern || !action) return false;
    if (scopePattern === '*' || scopePattern === 'all') return true;
    if (scopePattern === action) return true;

    const normalizedScope = scopePattern.replace(/:/g, '.');
    const normalizedAction = action.replace(/:/g, '.');

    if (normalizedScope === normalizedAction) return true;

    // Scope alias mappings
    if (normalizedScope === 'run.*' && normalizedAction.startsWith('run.')) return true;
    if (normalizedScope === 'run.read' && ['run.list', 'run.get'].includes(normalizedAction)) return true;
    if (normalizedScope === 'run.write' && ['run.start', 'run.cancel'].includes(normalizedAction)) return true;

    if (normalizedScope === 'trigger.*' && normalizedAction.startsWith('trigger.')) return true;
    if (normalizedScope === 'trigger.read' && normalizedAction === 'trigger.list') return true;
    if (normalizedScope === 'trigger.write' && ['trigger.bind', 'trigger.unbind'].includes(normalizedAction)) return true;
    if (normalizedScope === 'trigger.emit' && normalizedAction === 'trigger.emit') return true;

    if (normalizedScope === 'library.*' && normalizedAction.startsWith('library.')) return true;
    if (normalizedScope === 'library.read' && ['library.list', 'library.get'].includes(normalizedAction)) return true;
    if (normalizedScope === 'library.write' && ['library.push', 'library.remove'].includes(normalizedAction)) return true;

    if (normalizedScope === 'credentials.*' && (normalizedAction.startsWith('auth.credentials.') || normalizedAction.startsWith('secret.') || normalizedAction.startsWith('secrets.'))) return true;
    if (normalizedScope === 'credentials.read' && ['auth.credentials.get', 'auth.credentials.list', 'secret.get', 'secret.list', 'secrets.get', 'secrets.list'].includes(normalizedAction)) return true;
    if (normalizedScope === 'credentials.write' && ['auth.credentials.set', 'auth.credentials.delete', 'secret.set', 'secret.delete', 'secrets.set', 'secrets.delete'].includes(normalizedAction)) return true;

    if (normalizedScope === 'secrets.*' && (normalizedAction.startsWith('secret.') || normalizedAction.startsWith('secrets.') || normalizedAction.startsWith('auth.credentials.'))) return true;
    if (normalizedScope === 'secrets.read' && ['secret.get', 'secret.list', 'secrets.get', 'secrets.list', 'auth.credentials.get', 'auth.credentials.list'].includes(normalizedAction)) return true;
    if (normalizedScope === 'secrets.write' && ['secret.set', 'secret.delete', 'secrets.set', 'secrets.delete', 'auth.credentials.set', 'auth.credentials.delete', 'secret.reveal', 'secrets.reveal'].includes(normalizedAction)) return true;

    if (normalizedScope === 'variables.*' && (normalizedAction.startsWith('variable.') || normalizedAction.startsWith('variables.'))) return true;
    if (normalizedScope === 'variables.read' && ['variable.get', 'variable.list', 'variables.get', 'variables.list'].includes(normalizedAction)) return true;
    if (normalizedScope === 'variables.write' && ['variable.set', 'variable.delete', 'variables.set', 'variables.delete'].includes(normalizedAction)) return true;

    if (normalizedScope === 'keys.*' && normalizedAction.startsWith('auth.keys.')) return true;
    if (normalizedScope === 'rbac.*' && (normalizedAction.startsWith('rbac.') || normalizedAction.startsWith('auth.keys.'))) return true;

    if (normalizedScope.endsWith('.*') && normalizedAction.startsWith(normalizedScope.slice(0, -1))) return true;
    if (normalizedScope.endsWith('*') && normalizedAction.startsWith(normalizedScope.slice(0, -1))) return true;

    return false;
}

async function makeToken(role, keyId, ttlSeconds) {
    const rawRole = role === 'admin' ? 'admin' : 'device';
    const id = `${rawRole}:${keyId}`;
    const ttl = ttlSeconds ?? CONFIG.tokenTTL;
    return generateAPIKey(CONFIG.masterSecret, id, CONFIG.epoch, ttl);
}

async function verifyRuntimeToken(token) {
    if (!token || typeof token !== 'string') return null;

    const result = await validateToken(token, CONFIG.masterSecret, TOKEN_CONTEXTS.API, CONFIG.epoch);
    if (!result.valid) return null;

    const { role, keyId } = result;

    // Check flat array of revoked key IDs
    if (CONFIG.revokedKeys.includes(keyId)) {
        return null;
    }

    return { role, keyId };
}

async function resolveAuth(token) {
    const parsed = await verifyRuntimeToken(token);
    if (!parsed) return { role: 'none', keyId: null, scopes: [], isAdmin: false };

    // Check if principal exists in SQLite to enrich with custom role and scopes
    try {
        const rows = await db.exec(
            `SELECT role, scope_json, revoked FROM principals WHERE owner_id = 'local' AND principal_id = ?`,
            [parsed.keyId]
        );
        if (rows.length) {
            if (rows[0].revoked) return { role: 'none', keyId: null, revoked: true, isAdmin: false, scopes: [] };
            const dbRole = rows[0].role || parsed.role;
            let scopes = [];
            try { if (rows[0].scope_json) scopes = JSON.parse(rows[0].scope_json); } catch (_) { }
            return {
                role: dbRole,
                keyId: parsed.keyId,
                scopes,
                isAdmin: dbRole === 'admin'
            };
        }
    } catch (_) { }

    return {
        role: parsed.role,
        keyId: parsed.keyId,
        scopes: [],
        isAdmin: parsed.role === 'admin'
    };
}

function isElevated(auth) {
    if (!auth?.keyId) return false;
    const exp = elevatedSessions.get(auth.keyId);
    return Boolean(exp && exp > Date.now());
}

async function checkPermission(action, payload, auth) {
    const { role = 'none', keyId = null, scopes = [], isAdmin = false } = auth;

    // 1. Superuser admin bypass
    if (isAdmin || role === 'admin') return true;

    // 2. Check explicit principal scopes (assigned directly to this API key)
    if (scopes && scopes.length) {
        for (const s of scopes) {
            if (matchesScope(s, action)) return true;
        }
    }

    // 3. Check explicit grants in SQLite permissions table
    if (keyId || role) {
        try {
            const rows = await db.exec(
                `SELECT artifact_id FROM permissions WHERE owner_id = 'local' AND (grantee_id = ? OR grantee_id = ? OR grantee_id = '*')`,
                [keyId || '', role]
            );
            for (const r of rows) {
                if (matchesScope(r.artifact_id, action)) return true;
            }
        } catch (_) { }
    }

    // 4. Check Built-in Roles
    const roleDef = BUILTIN_ROLES[role];
    if (roleDef) {
        for (const s of roleDef.scopes) {
            if (matchesScope(s, action)) return true;
        }
    }

    // 5. Check Custom Role defined in DB (principals table type = 'role_def')
    try {
        const customRoleRows = await db.exec(
            `SELECT scope_json FROM principals WHERE owner_id = 'local' AND type = 'role_def' AND principal_id = ?`,
            [role]
        );
        if (customRoleRows.length && customRoleRows[0].scope_json) {
            const customScopes = JSON.parse(customRoleRows[0].scope_json);
            for (const s of customScopes) {
                if (matchesScope(s, action)) return true;
            }
        }
    } catch (_) { }

    // 6. Fallback onto legacy 2-role system
    if (role === 'device') {
        const legacyDeviceActions = [
            'whoami',
            'run.start', 'run.list', 'run.cancel', 'run.get',
            'trigger.emit', 'trigger.list',
            'library.list', 'library.get',
            'runtime.status', 'runtime.list',
            'sudo-session'
        ];
        if (legacyDeviceActions.includes(action)) return true;
    }

    if (role === 'none') {
        const legacyAnonActions = [
            'whoami',
            'rolesys.is_role_sys'
        ];
        if (legacyAnonActions.includes(action)) return true;
    }

    // If still not matched:
    if (role === 'none') {
        throw new UnauthorizedError('Authentication required');
    }
    throw new ForbiddenError(`Forbidden: role '${role}' cannot execute action '${action}'`);
}


// Global runtime state
let scheduler;
const runs = new Map();
let _seq = 0;
const nextRunId = () => `run_${++_seq}_${Date.now()}`;
let bootAdminToken = null;
const elevatedSessions = new Map(); // keyId → expiry (ms), 5-min window

// Initial loads
loadArtifacts().then(() => {
    scheduler = new WorkflowScheduler(library, { verbose: CONFIG.verbose });
    loadBindings();
    return makeToken('admin', 'admin_boot');
}).then((tok) => {
    bootAdminToken = tok;
    startServer();
}).catch(err => {
    console.error('[boot] Fatal: failed to initialize runtime:', err.message);
    process.exit(1);
});

/* ─── Dispatcher ─────────────────────────────────────────────────── */

async function dispatch(action, payload, tokenOrAuth, emitCallback = () => { }) {
    // Direct in-process auth object support for autoRun / internal callers
    const auth = (typeof tokenOrAuth === 'object' && tokenOrAuth?.role)
        ? tokenOrAuth
        : await resolveAuth(tokenOrAuth);

    await checkPermission(action, payload, auth);

    if (CONFIG.verbose) {
        console.log(`[${Date.now()}] [dispatch] ${auth.role} (${auth.keyId || 'anon'}) -> ${action}`);
    }

    switch (action) {
        case 'whoami': {
            return {
                role: auth.role,
                keyId: auth.keyId,
                isAdmin: Boolean(auth.isAdmin || auth.role === 'admin'),
                scopes: auth.scopes?.length ? auth.scopes : (BUILTIN_ROLES[auth.role]?.scopes || [])
            };
        }
        // Stub — role-system introspection reserved for future multi-runtime management
        case 'rolesys.is_role_sys': {
            return { isRoleSys: false };
        }

        /* ── RBAC & Role Management Endpoints ── */
        case 'rbac.roles.list': {
            const customRoles = await db.exec(
                `SELECT principal_id, meta_json, scope_json, created_at FROM principals WHERE owner_id = 'local' AND type = 'role_def'`
            );
            const rolesList = Object.values(BUILTIN_ROLES).map(r => ({ ...r, isBuiltin: true }));
            for (const cr of customRoles) {
                let meta = {};
                let scopes = [];
                try { if (cr.meta_json) meta = JSON.parse(cr.meta_json); } catch (_) { }
                try { if (cr.scope_json) scopes = JSON.parse(cr.scope_json); } catch (_) { }
                rolesList.push({
                    name: cr.principal_id,
                    label: meta.label || cr.principal_id,
                    description: meta.description || 'Custom user-defined role',
                    isAdmin: false,
                    scopes,
                    isBuiltin: false,
                    createdAt: cr.created_at
                });
            }
            return { roles: rolesList };
        }
        case 'rbac.roles.create':
        case 'rbac.roles.set': {
            if (!auth.isAdmin && auth.role !== 'admin') throw new ForbiddenError('Admin privileges required to manage roles');
            const { name, label, description, scopes = [] } = payload;
            if (!name) throw new BadRequestError('Missing role name');
            const cleanName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
            const metaJson = JSON.stringify({ label: label || cleanName, description: description || '' });
            const scopeJson = JSON.stringify(Array.isArray(scopes) ? scopes : [scopes]);
            await db.exec(
                `INSERT OR REPLACE INTO principals (owner_id, principal_id, type, role, scope_json, encrypted_val, hint, revoked, meta_json, created_at)
                 VALUES ('local', ?, 'role_def', ?, ?, NULL, NULL, 0, ?, ?)`,
                [cleanName, cleanName, scopeJson, metaJson, Date.now()]
            );
            return { name: cleanName, label: label || cleanName, scopes, status: 'saved' };
        }
        case 'rbac.roles.delete': {
            if (!auth.isAdmin && auth.role !== 'admin') throw new ForbiddenError('Admin privileges required to manage roles');
            const { name } = payload;
            if (!name) throw new BadRequestError('Missing role name');
            if (BUILTIN_ROLES[name]) throw new BadRequestError(`Cannot delete built-in system role '${name}'`);
            await db.exec(`DELETE FROM principals WHERE owner_id = 'local' AND type = 'role_def' AND principal_id = ?`, [name]);
            await db.exec(`DELETE FROM permissions WHERE owner_id = 'local' AND grantee_id = ?`, [name]);
            return { name, status: 'deleted' };
        }
        case 'rbac.permissions.grant': {
            if (!auth.isAdmin && auth.role !== 'admin') throw new ForbiddenError('Admin privileges required to grant permissions');
            const { granteeId, resource, permission } = payload;
            const targetResource = resource || permission;
            if (!granteeId || !targetResource) throw new BadRequestError('Missing granteeId or resource');
            await db.exec(
                `INSERT OR REPLACE INTO permissions (owner_id, grantee_id, artifact_id, created_at)
                 VALUES ('local', ?, ?, ?)`,
                [granteeId, targetResource, Date.now()]
            );
            return { granteeId, resource: targetResource, status: 'granted' };
        }
        case 'rbac.permissions.revoke': {
            if (!auth.isAdmin && auth.role !== 'admin') throw new ForbiddenError('Admin privileges required to revoke permissions');
            const { granteeId, resource, permission } = payload;
            const targetResource = resource || permission;
            if (!granteeId) throw new BadRequestError('Missing granteeId');
            if (targetResource) {
                await db.exec(`DELETE FROM permissions WHERE owner_id = 'local' AND grantee_id = ? AND artifact_id = ?`, [granteeId, targetResource]);
            } else {
                await db.exec(`DELETE FROM permissions WHERE owner_id = 'local' AND grantee_id = ?`, [granteeId]);
            }
            return { granteeId, resource: targetResource, status: 'revoked' };
        }
        case 'rbac.permissions.list': {
            const rows = await db.exec(`SELECT grantee_id, artifact_id, created_at FROM permissions WHERE owner_id = 'local' ORDER BY created_at DESC`);
            return {
                grants: rows.map(r => ({ granteeId: r.grantee_id, resource: r.artifact_id, createdAt: r.created_at }))
            };
        }

        case 'auth.keys.create': {
            const { role = 'device', keyId: requestedId, scopes = [] } = payload;
            const customRoleExists = await db.exec(
                `SELECT 1 FROM principals WHERE owner_id = 'local' AND type = 'role_def' AND principal_id = ?`,
                [role]
            );
            if (!BUILTIN_ROLES[role] && !customRoleExists.length) {
                throw new BadRequestError(`Invalid role: '${role}'. Must be one of: ${Object.keys(BUILTIN_ROLES).join(', ')} or custom defined role.`);
            }
            // Non-admin callers may not escalate to admin
            if (!auth.isAdmin && auth.role !== 'admin' && (role === 'admin' || (Array.isArray(scopes) && scopes.includes('*')))) {
                throw new ForbiddenError("Non-admin callers cannot create admin keys");
            }
            const keyId = requestedId || `key_${crypto.randomBytes(4).toString('hex')}`;
            const newToken = await makeToken(role, keyId);
            const scopeJson = (Array.isArray(scopes) && scopes.length) ? JSON.stringify(scopes) : null;
            await db.exec(
                `INSERT OR REPLACE INTO principals (owner_id, principal_id, type, role, scope_json, encrypted_val, hint, revoked, meta_json, created_at)
                 VALUES ('local', ?, 'api_key', ?, ?, NULL, ?, 0, NULL, ?)`,
                [keyId, role, scopeJson, newToken.slice(-4), Date.now()]
            );
            return { name: keyId, token: newToken, isAdmin: role === 'admin', role, scopes };
        }
        case 'auth.keys.update':
        case 'auth.keys.edit': {
            if (!auth.isAdmin && auth.role !== 'admin') throw new ForbiddenError('Admin privileges required to edit role keys');
            const { keyId, role, scopes, regenerateToken } = payload;
            if (!keyId) throw new BadRequestError('Missing keyId parameter');

            const rows = await db.exec(
                `SELECT role, scope_json, hint, revoked FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type = 'api_key'`,
                [keyId]
            );
            if (!rows.length) throw new NotFoundError(`Key '${keyId}' not found`);

            const newRole = role || rows[0].role || 'device';
            const customRoleExists = await db.exec(
                `SELECT 1 FROM principals WHERE owner_id = 'local' AND type = 'role_def' AND principal_id = ?`,
                [newRole]
            );
            if (!BUILTIN_ROLES[newRole] && !customRoleExists.length) {
                throw new BadRequestError(`Invalid role: '${newRole}'`);
            }

            let newScopeJson = rows[0].scope_json;
            if (scopes !== undefined) {
                newScopeJson = (Array.isArray(scopes) && scopes.length) ? JSON.stringify(scopes) : null;
            }

            let newToken = null;
            let newHint = rows[0].hint;
            if (regenerateToken) {
                newToken = await makeToken(newRole, keyId);
                newHint = newToken.slice(-4);
            }

            await db.exec(
                `UPDATE principals SET role = ?, scope_json = ?, hint = ? WHERE owner_id = 'local' AND principal_id = ? AND type = 'api_key'`,
                [newRole, newScopeJson, newHint, keyId]
            );

            let parsedScopes = [];
            try { if (newScopeJson) parsedScopes = JSON.parse(newScopeJson); } catch (_) { }

            return {
                name: keyId,
                role: newRole,
                isAdmin: newRole === 'admin',
                scopes: parsedScopes,
                hint: newHint,
                ...(newToken ? { token: newToken } : {}),
                status: 'updated'
            };
        }
        case 'auth.keys.revoke': {
            const { keyId } = payload;
            if (!keyId) throw new BadRequestError('Missing keyId parameter');
            if (!CONFIG.revokedKeys.includes(keyId)) {
                CONFIG.revokedKeys.push(keyId);
                saveConfig();
            }
            await db.exec(`UPDATE principals SET revoked = 1 WHERE owner_id = 'local' AND principal_id = ? AND type = 'api_key'`, [keyId]);
            return { status: 'revoked', keyId };
        }
        case 'auth.keys.list': {
            const rows = await db.exec(
                `SELECT principal_id, role, scope_json, hint, revoked, created_at FROM principals
                 WHERE owner_id = 'local' AND type = 'api_key' ORDER BY created_at DESC`
            );
            const keys = rows.map(r => {
                let scopes = [];
                try { if (r.scope_json) scopes = JSON.parse(r.scope_json); } catch (_) { }
                return {
                    name: r.principal_id,
                    role: r.role,
                    isAdmin: r.role === 'admin',
                    scopes,
                    hint: r.hint,
                    revoked: Boolean(r.revoked),
                    createdAt: r.created_at
                };
            });
            return { keys, epoch: CONFIG.epoch };
        }

        case 'auth.credentials.set':
        case 'secret.set':
        case 'secrets.set': {
            if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                throw new ForbiddenError('Elevated session or admin role required. Call sudo-session first.');
            }
            const credId = payload.credId || payload.key || payload.name;
            const secret = payload.secret !== undefined ? payload.secret : payload.value;
            const description = payload.description || payload.desc || '';
            const classification = payload.classification || 'secret';
            if (!credId || secret === undefined || secret === null) throw new BadRequestError('Missing credId/key or secret/value');
            const strSecret = String(secret);
            const encryptedVal = Ops.encrypt(strSecret, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
            const metaJson = JSON.stringify({ description, classification, updatedAt: Date.now() });
            const hint = strSecret.length >= 4 ? strSecret.slice(-4) : '****';
            const now = Date.now();

            await db.exec(
                `INSERT INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
                 VALUES ('secrets', ?, ?, 'secret', 1, '["admin"]', 'local', ?, ?, ?)
                 ON CONFLICT(namespace, key) DO UPDATE SET
                    value = excluded.value,
                    type = 'secret',
                    encrypted = 1,
                    meta_json = excluded.meta_json,
                    updated_at = excluded.updated_at`,
                [credId, encryptedVal, metaJson, now, now]
            );

            await db.exec(
                `INSERT OR REPLACE INTO principals (owner_id, principal_id, type, role, scope_json, encrypted_val, hint, revoked, meta_json, created_at)
                 VALUES ('local', ?, 'credential', NULL, NULL, ?, ?, 0, ?, ?)`,
                [credId, encryptedVal, hint, metaJson, now]
            );
            return { credId, key: credId, hint, status: 'stored' };
        }
        case 'auth.credentials.get':
        case 'secret.get':
        case 'secrets.get': {
            if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                throw new ForbiddenError('Elevated session or admin role required. Call sudo-session first.');
            }
            const credId = payload.credId || payload.key || payload.name;
            if (!credId) throw new BadRequestError('Missing credId/key');

            const varRows = await db.exec(
                `SELECT key, value, encrypted, meta_json, created_at FROM variables WHERE namespace = 'secrets' AND key = ? AND type = 'secret'`,
                [credId]
            );
            if (varRows.length) {
                const decrypted = varRows[0].encrypted
                    ? Ops.decrypt(varRows[0].value, Buffer.from(CONFIG.masterSecret.slice(0, 32)))
                    : varRows[0].value;
                let meta = {};
                try { if (varRows[0].meta_json) meta = JSON.parse(varRows[0].meta_json); } catch (_) {}
                const hint = decrypted.length >= 4 ? decrypted.slice(-4) : '****';
                return { credId, key: credId, value: decrypted, hint, description: meta.description || '', createdAt: varRows[0].created_at };
            }

            const rows = await db.exec(
                `SELECT principal_id, encrypted_val, hint, meta_json, created_at FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type IN ('credential', 'secret') AND revoked = 0`,
                [credId]
            );
            if (!rows.length) {
                if (process.env[credId] !== undefined) {
                    return { credId, key: credId, value: process.env[credId], hint: process.env[credId].slice(-4), isEnv: true };
                }
                throw new NotFoundError(`Secret '${credId}' not found`);
            }
            const decrypted = Ops.decrypt(rows[0].encrypted_val, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
            let meta = {};
            try { if (rows[0].meta_json) meta = JSON.parse(rows[0].meta_json); } catch (_) {}
            return { credId, key: credId, value: decrypted, hint: rows[0].hint, description: meta.description || '', createdAt: rows[0].created_at };
        }
        case 'auth.credentials.delete':
        case 'secret.delete':
        case 'secrets.delete': {
            if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                throw new ForbiddenError('Elevated session or admin role required.');
            }
            const credId = payload.credId || payload.key || payload.name;
            if (!credId) throw new BadRequestError('Missing credId/key');
            await db.exec(`DELETE FROM variables WHERE namespace = 'secrets' AND key = ?`, [credId]);
            await db.exec(`DELETE FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type IN ('credential', 'secret')`, [credId]);
            return { credId, key: credId, status: 'deleted' };
        }
        case 'auth.credentials.list':
        case 'secret.list':
        case 'secrets.list': {
            const varRows = await db.exec(
                `SELECT key, value, encrypted, meta_json, created_at FROM variables WHERE namespace = 'secrets' AND type = 'secret' ORDER BY key ASC`
            );
            const seen = new Set();
            const secrets = [];
            for (const r of varRows) {
                seen.add(r.key);
                let meta = {};
                try { if (r.meta_json) meta = JSON.parse(r.meta_json); } catch (_) {}
                let hint = '****';
                try {
                    const decrypted = r.encrypted ? Ops.decrypt(r.value, Buffer.from(CONFIG.masterSecret.slice(0, 32))) : r.value;
                    hint = decrypted.length >= 4 ? decrypted.slice(-4) : '****';
                } catch (_) {}
                secrets.push({
                    key: r.key,
                    credId: r.key,
                    hint,
                    value: '●●●●●●●●',
                    revealed: false,
                    description: meta.description || '',
                    classification: meta.classification || 'secret',
                    createdAt: r.created_at
                });
            }
            const legacyRows = await db.exec(
                `SELECT principal_id, hint, meta_json, created_at FROM principals WHERE owner_id = 'local' AND type IN ('credential', 'secret') AND revoked = 0 ORDER BY principal_id ASC`
            );
            for (const r of legacyRows) {
                if (!seen.has(r.principal_id)) {
                    seen.add(r.principal_id);
                    let meta = {};
                    try { if (r.meta_json) meta = JSON.parse(r.meta_json); } catch (_) {}
                    secrets.push({
                        key: r.principal_id,
                        credId: r.principal_id,
                        hint: r.hint,
                        value: '●●●●●●●●',
                        revealed: false,
                        description: meta.description || '',
                        classification: meta.classification || 'secret',
                        createdAt: r.created_at
                    });
                }
            }
            return { secrets, count: secrets.length };
        }
        case 'secret.reveal':
        case 'secrets.reveal': {
            if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                throw new ForbiddenError('Elevated session or admin role required to reveal secrets');
            }
            const key = payload.key || payload.credId || payload.name;
            if (!key) throw new BadRequestError('Missing secret key');
            const varRows = await db.exec(
                `SELECT value, encrypted, meta_json FROM variables WHERE namespace = 'secrets' AND key = ? AND type = 'secret'`,
                [key]
            );
            if (varRows.length) {
                const decrypted = varRows[0].encrypted
                    ? Ops.decrypt(varRows[0].value, Buffer.from(CONFIG.masterSecret.slice(0, 32)))
                    : varRows[0].value;
                const hint = decrypted.length >= 4 ? decrypted.slice(-4) : '****';
                return { key, value: decrypted, hint };
            }
            const rows = await db.exec(
                `SELECT encrypted_val, hint FROM principals WHERE owner_id = 'local' AND principal_id = ? AND type IN ('credential', 'secret') AND revoked = 0`,
                [key]
            );
            if (!rows.length) {
                if (process.env[key] !== undefined) {
                    return { key, value: process.env[key], hint: process.env[key].slice(-4), isEnv: true };
                }
                throw new NotFoundError(`Secret '${key}' not found`);
            }
            const decrypted = Ops.decrypt(rows[0].encrypted_val, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
            return { key, value: decrypted, hint: rows[0].hint };
        }

        /* ── Unified Variables Table & RBAC ── */
        case 'variable.set':
        case 'variables.set': {
            const namespace = payload.namespace ?? 'default';
            const key = payload.key ?? payload.name;
            const rawValue = payload.value;
            const type = payload.type || (namespace === 'secrets' ? 'secret' : 'variable');
            const shouldEncrypt = Boolean(payload.encrypted || type === 'secret');
            const roles = payload.roles ? (Array.isArray(payload.roles) ? payload.roles : [payload.roles]) : null;
            const rolesJson = roles ? JSON.stringify(roles) : null;
            const description = payload.description || payload.desc || '';
            const metaJson = JSON.stringify({ description, ...(payload.meta || {}), updatedAt: Date.now() });

            if (!key || rawValue === undefined) {
                throw new BadRequestError('Missing variable key or value');
            }

            // Namespace Gate for built-in namespaces
            if (namespace === 'secrets') {
                if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Elevated session or admin role required for secrets namespace');
                }
            } else if (namespace === 'system') {
                if (!auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Admin role required for system namespace');
                }
            } else {
                // Non-reserved namespace: check row-level RBAC if row already exists
                const existing = await db.exec(`SELECT roles_json FROM variables WHERE namespace = ? AND key = ?`, [namespace, key]);
                if (existing.length && existing[0].roles_json) {
                    try {
                        const allowed = JSON.parse(existing[0].roles_json);
                        if (Array.isArray(allowed) && !allowed.includes('*') && !auth.isAdmin && auth.role !== 'admin' && !allowed.includes(auth.role)) {
                            throw new ForbiddenError(`Forbidden: role '${auth.role}' cannot modify variable '${namespace}/${key}'`);
                        }
                    } catch (e) {
                        if (e instanceof ForbiddenError) throw e;
                    }
                }
            }

            let storedVal = typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue);
            if (shouldEncrypt) {
                storedVal = Ops.encrypt(storedVal, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
            }

            const now = Date.now();
            await db.exec(`
                INSERT INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?)
                ON CONFLICT(namespace, key) DO UPDATE SET
                    value = excluded.value,
                    type = excluded.type,
                    encrypted = excluded.encrypted,
                    roles_json = COALESCE(excluded.roles_json, variables.roles_json),
                    meta_json = excluded.meta_json,
                    updated_at = excluded.updated_at
            `, [namespace, key, storedVal, type, shouldEncrypt ? 1 : 0, rolesJson, metaJson, now, now]);

            return { namespace, key, type, encrypted: shouldEncrypt, status: 'stored' };
        }

        case 'variable.get':
        case 'variables.get': {
            const namespace = payload.namespace ?? 'default';
            const key = payload.key ?? payload.name;
            if (!key) throw new BadRequestError('Missing variable key');

            // Namespace Gate
            if (namespace === 'secrets') {
                if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Elevated session or admin role required for secrets namespace');
                }
            }

            const rows = await db.exec(
                `SELECT namespace, key, value, type, encrypted, roles_json, meta_json, created_at, updated_at
                 FROM variables WHERE namespace = ? AND key = ?`,
                [namespace, key]
            );
            if (!rows.length) {
                throw new NotFoundError(`Variable '${namespace}/${key}' not found`);
            }

            const row = rows[0];

            // Row-level RBAC check
            if (row.roles_json) {
                try {
                    const allowed = JSON.parse(row.roles_json);
                    if (Array.isArray(allowed) && !allowed.includes('*') && !auth.isAdmin && auth.role !== 'admin' && !allowed.includes(auth.role)) {
                        throw new ForbiddenError(`Forbidden: role '${auth.role}' cannot read variable '${namespace}/${key}'`);
                    }
                } catch (e) {
                    if (e instanceof ForbiddenError) throw e;
                }
            }

            let val = row.value;
            if (row.encrypted) {
                try {
                    val = Ops.decrypt(row.value, Buffer.from(CONFIG.masterSecret.slice(0, 32)));
                } catch (_) { }
            }
            try { val = JSON.parse(val); } catch (_) { }

            let meta = {};
            try { if (row.meta_json) meta = JSON.parse(row.meta_json); } catch (_) { }

            return {
                namespace: row.namespace,
                key: row.key,
                value: val,
                type: row.type,
                encrypted: Boolean(row.encrypted),
                roles: row.roles_json ? JSON.parse(row.roles_json) : ['*'],
                meta,
                createdAt: row.created_at,
                updatedAt: row.updated_at
            };
        }

        case 'variable.delete':
        case 'variables.delete': {
            const namespace = payload.namespace ?? 'default';
            const key = payload.key ?? payload.name;
            if (!key) throw new BadRequestError('Missing variable key');

            // Namespace Gate
            if (namespace === 'secrets') {
                if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Elevated session or admin role required for secrets namespace');
                }
            } else if (namespace === 'system') {
                if (!auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Admin role required for system namespace');
                }
            }

            // Row-level RBAC check
            const rows = await db.exec(`SELECT roles_json FROM variables WHERE namespace = ? AND key = ?`, [namespace, key]);
            if (rows.length && rows[0].roles_json) {
                try {
                    const allowed = JSON.parse(rows[0].roles_json);
                    if (Array.isArray(allowed) && !allowed.includes('*') && !auth.isAdmin && auth.role !== 'admin' && !allowed.includes(auth.role)) {
                        throw new ForbiddenError(`Forbidden: role '${auth.role}' cannot delete variable '${namespace}/${key}'`);
                    }
                } catch (e) {
                    if (e instanceof ForbiddenError) throw e;
                }
            }

            await db.exec(`DELETE FROM variables WHERE namespace = ? AND key = ?`, [namespace, key]);
            return { namespace, key, status: 'deleted' };
        }

        case 'variable.list':
        case 'variables.list': {
            const namespace = payload.namespace;
            const type = payload.type;

            // Namespace Gate
            if (namespace === 'secrets') {
                if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                    throw new ForbiddenError('Elevated session or admin role required for secrets namespace');
                }
            }

            let sql = `SELECT namespace, key, type, encrypted, roles_json, meta_json, created_at, updated_at FROM variables WHERE 1=1`;
            const params = [];
            if (namespace) {
                sql += ` AND namespace = ?`;
                params.push(namespace);
            } else {
                if (!isElevated(auth) && !auth.isAdmin && auth.role !== 'admin') {
                    sql += ` AND namespace != 'secrets'`;
                }
            }
            if (type) {
                sql += ` AND type = ?`;
                params.push(type);
            }
            sql += ` ORDER BY namespace ASC, key ASC`;

            const rows = await db.exec(sql, params);
            const filtered = rows.filter(r => {
                if (!r.roles_json) return true;
                if (auth.isAdmin || auth.role === 'admin') return true;
                try {
                    const allowed = JSON.parse(r.roles_json);
                    return Array.isArray(allowed) && (allowed.includes('*') || allowed.includes(auth.role));
                } catch { return true; }
            }).map(r => {
                let meta = {};
                try { if (r.meta_json) meta = JSON.parse(r.meta_json); } catch (_) { }
                return {
                    namespace: r.namespace,
                    key: r.key,
                    type: r.type,
                    encrypted: Boolean(r.encrypted),
                    roles: r.roles_json ? JSON.parse(r.roles_json) : ['*'],
                    meta,
                    createdAt: r.created_at,
                    updatedAt: r.updated_at
                };
            });

            return { variables: filtered, count: filtered.length };
        }


        case 'library.list': {
            const { offset = 0, limit = 50 } = payload;
            const allArtifacts = library.list().map(({ id, version }) => {
                const def = library.getArtifact(id, version);
                const { source, ...details } = def;
                return details;
            });
            const total = allArtifacts.length;
            const artifacts = allArtifacts.slice(offset, offset + limit);
            return { artifacts, total, offset, limit };
        }
        case 'library.get': {
            const { id, version = 'latest' } = payload;
            const def = library.getArtifact(id, version);
            if (!def) throw new NotFoundError('Not found in library');
            if (auth.role !== 'admin') {
                const { source, ...safe } = def;
                return safe;
            }
            return def;
        }
        case 'library.push': {
            const art = payload.artifact || payload;
            if (!art || !art.id) throw new BadRequestError('Missing artifact definition or id');

            const id = art.id;
            const version = art.version || '1.0.0';
            const artifactType = art.artifactType || 'graph';
            const sourceType = art.sourceType || (artifactType === 'graph' ? 'text/x-ndl' : 'application/javascript');
            const ownerId = 'local';
            const dispatchKey = [ownerId, id, version].join('__').replace(/[^a-z0-9_]/gi, '_');
            const source = typeof art.source === 'string' ? art.source : (art.source ? art.source.toString() : '');
            const now = Date.now();

            // Save source in Blob pipeline
            let sourceRef = null;
            let contentHash = null;
            if (source) {
                sourceRef = await blobPipeline.write(source);
                contentHash = Ops.fingerprint(source);
            }

            const metaJson = JSON.stringify({
                name: art.metadata?.name || id,
                description: art.metadata?.description || '',
                tags: art.metadata?.tags || [],
                interface: art.interface || { inputs: {}, outputs: {} }
            });

            // Persist to SQLite
            await db.exec(`
                INSERT INTO artifacts (
                    owner_id, id, version, dispatch_key, artifact_type, source_type,
                    is_static, meta_json, source_ref, content_hash, is_latest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
                ON CONFLICT(owner_id, id, version) DO UPDATE SET
                    artifact_type = excluded.artifact_type,
                    source_type = excluded.source_type,
                    is_static = 0,
                    meta_json = excluded.meta_json,
                    source_ref = excluded.source_ref,
                    content_hash = excluded.content_hash,
                    is_latest = 1
            `, [
                ownerId,
                id,
                version,
                dispatchKey,
                artifactType,
                sourceType,
                metaJson,
                sourceRef,
                contentHash,
                now
            ]);

            await db.exec(`
                UPDATE artifacts SET is_latest = 0
                WHERE owner_id = ? AND id = ? AND version != ?
            `, [ownerId, id, version]);

            // Register in in-memory library
            const fullArt = {
                ...art,
                id,
                version,
                artifactType,
                sourceType,
                source,
                metadata: {
                    name: art.metadata?.name || id,
                    description: art.metadata?.description || '',
                    tags: art.metadata?.tags || []
                },
                interface: art.interface || { inputs: {}, outputs: {} }
            };
            addArtifact(fullArt);

            rlog('INFO', `Artifact "${id}@${version}" saved to SQLite & registered in library.`);
            return { id, version, status: 'saved', artifact: fullArt };
        }
        case 'library.remove': {
            const { id } = payload;
            if (!library.has(id)) throw new NotFoundError('Not found in library');
            library.removeArtifact(id);
            await db.exec(`DELETE FROM artifacts WHERE owner_id = 'local' AND id = ?`, [id]);
            return { id, status: 'deleted' };
        }

        case 'run.start': {
            const { artifactId, input = {}, state: seed = {} } = payload;
            const runId = nextRunId();
            const controller = new AbortController();
            const cleanSeed = { ...stripPrivate(seed), signal: controller.signal };

            emitCallback({ event: 'run.started', runId });

            let execPromise;
            if (artifactId) {
                execPromise = scheduler._execute(artifactId, input, cleanSeed);
            } else {
                execPromise = scheduler.emit('runtime:run', input).then(r => r[0] ?? { output: null });
            }

            runs.set(runId, { controller, startTime: Date.now(), artifactId: artifactId || null, promise: execPromise });

            const execResult = await execPromise;
            runs.delete(runId);

            const finalResult = {
                output: execResult?.output ?? null,
                state: stripPrivate(execResult?.state)
            };

            emitCallback({ event: 'run.done', runId, output: finalResult.output });
            return finalResult;
        }
        case 'run.list': {
            const activeRuns = Array.from(runs.entries()).map(([runId, entry]) => ({
                runId,
                artifactId: entry.artifactId || null,
                startTime: entry.startTime,
                uptime: Math.floor((Date.now() - entry.startTime) / 1000)
            }));
            return { activeRuns };
        }
        case 'run.cancel': {
            const { runId } = payload;
            const entry = runs.get(runId);
            if (entry) {
                entry.controller.abort();
                try { await entry.promise; } catch (e) { }
                runs.delete(runId);
            }
            return { status: 'cancelled', runId };
        }

        case 'trigger.emit': {
            const { event, data } = payload;
            const runId = nextRunId();

            // Validate caller's role against trigger's configured access roles
            const bindingRows = await db.exec(`SELECT * FROM bindings WHERE owner_id = 'local' AND event = ?`, [event]);
            if (bindingRows.length > 0) {
                let allowedRoles = ['admin', 'device'];
                try { if (bindingRows[0].roles_json) allowedRoles = JSON.parse(bindingRows[0].roles_json); } catch (_) { }

                const isAnonAllowed = allowedRoles.includes('anonymous') || allowedRoles.includes('anon');
                if (!isAnonAllowed) {
                    if (auth.role === 'none') {
                        throw new UnauthorizedError(`Authentication required for trigger '${event}'`);
                    }
                    if (auth.role !== 'admin' && !allowedRoles.includes(auth.role)) {
                        throw new ForbiddenError(`Forbidden: role '${auth.role}' is not allowed to emit trigger '${event}'`);
                    }
                }
            }

            emitCallback({ event: 'trigger.emitted', runId, triggerEvent: event });

            const results = await scheduler.emit(event, data);

            const finalOutputs = results.map(r => ({
                artifactId: r.artifactId,
                output: r?.output ?? null,
                ...(r.error ? { error: r.error } : {})
            }));
            emitCallback({ event: 'trigger.done', runId, count: results.length, outputs: finalOutputs });
            return { outputs: finalOutputs };
        }
        case 'trigger.bind': {
            const { event, artifactId, artifact, opts = {}, access = {}, delivery = 'trigger', oldEvent } = payload;
            const targetArtifactId = artifactId || artifact;
            if (!event || !targetArtifactId) throw new BadRequestError('Missing event or artifactId');

            // If editing/renaming an existing trigger:
            if (oldEvent && oldEvent !== event) {
                scheduler.off(oldEvent);
                await removeBindingRow('local', oldEvent);
            }

            // Enforce 1:1: an artifact may not be bound to more than one event
            const existing = await db.exec(
                `SELECT event FROM bindings WHERE owner_id = 'local' AND artifact_id = ? AND event != ?`,
                [targetArtifactId, event]
            );
            if (existing.length) {
                throw new ConflictError(`Artifact '${targetArtifactId}' is already bound to event '${existing[0].event}'`);
            }

            const once = Boolean(opts.once ?? payload.once ?? false);
            const publicToken = opts.publicToken ?? payload.publicToken ?? null;

            // Extract roles array: ['admin', 'device', 'anonymous']
            let roles = ['admin', 'device'];
            if (Array.isArray(access.roles)) {
                roles = access.roles;
            } else if (Array.isArray(payload.roles)) {
                roles = payload.roles;
            } else if (typeof access === 'string') {
                roles = [access];
            }
            const rolesJson = JSON.stringify(roles);
            const deliveryMode = delivery || 'trigger';

            scheduler.on(event, targetArtifactId, { once });
            await saveBindingRow('local', event, targetArtifactId, once, publicToken, rolesJson, deliveryMode);
            return { event, artifactId: targetArtifactId, roles, delivery: deliveryMode, once, status: 'bound' };
        }
        case 'trigger.unbind': {
            const { event, artifactId = null } = payload;
            scheduler.off(event, artifactId);
            await removeBindingRow('local', event, artifactId);
            return { event, artifactId, status: 'unbound' };
        }
        case 'trigger.list': {
            const rows = await db.exec(`SELECT * FROM bindings WHERE owner_id = 'local'`);
            const triggerList = rows.map(r => {
                let roles = ['admin', 'device'];
                try { if (r.roles_json) roles = JSON.parse(r.roles_json); } catch (_) { }
                return {
                    event: r.event,
                    artifact: r.artifact_id,
                    artifactId: r.artifact_id,
                    access: { mode: 'allow', roles },
                    roles: roles,
                    delivery: r.delivery || 'trigger',
                    once: Boolean(r.once),
                    publicToken: r.public_token
                };
            });
            return {
                triggers: triggerList,
                bindings: scheduler.bindings()
            };
        }

        case 'runtime.status': {
            return {
                runtimeId: RUNTIME.id,
                environment: RUNTIME.environment,
                capabilities: RUNTIME.capabilities,
                uptime: process.uptime(),
                activeRuns: runs.size,
                bindings: scheduler.bindings(),
                epoch: CONFIG.epoch,
                revokedKeysCount: CONFIG.revokedKeys.length
            };
        }
        case 'runtime.list': {
            // Single-node deployment — reports self
            return { runtimes: [{ id: RUNTIME.id, environment: RUNTIME.environment, url: `http://localhost:${CONFIG.port}` }] };
        }

        case 'run.get': {
            const { runId } = payload;
            const entry = runs.get(runId);
            if (!entry) return { runId, status: 'not_found' };
            return { runId, artifactId: entry.artifactId, startTime: entry.startTime, uptime: Math.floor((Date.now() - entry.startTime) / 1000), status: 'running' };
        }

        case 'sudo-session': {
            // Grants a 5-minute elevated window for secret/credential operations
            if (!auth.keyId) throw new ForbiddenError('Cannot elevate an anonymous session');
            elevatedSessions.set(auth.keyId, Date.now() + 5 * 60 * 1000);
            rlog('info', `[sudo-session] Elevated: ${auth.keyId}`);
            return { status: 'elevated', expiresIn: 300 };
        }

        case 'runtime.secret.set': {
            const { secret } = payload;
            if (secret) {
                if (typeof secret !== 'string' || secret.length < 64) {
                    throw new BadRequestError('Secret must be at least 64 characters');
                }
                CONFIG.masterSecret = secret;
            }
            CONFIG.epoch = (CONFIG.epoch || 1) + 1;
            saveConfig();
            console.log(`[security] Global token epoch incremented to ${CONFIG.epoch}. All previous tokens invalidated.`);
            return { status: 'updated', epoch: CONFIG.epoch };
        }
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

/* ─── Express App / Transports ───────────────────────────────────── */

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

const triggerLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/trigger', triggerLimiter);

/* ─── Wildcard Domain & IP Matchers ───────────────────────────────── */

function escapeRegex(str) {
    return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegex(pattern) {
    if (pattern === '*' || pattern === '') return /^.*$/;
    const parts = pattern.split('*').map(escapeRegex);
    return new RegExp('^' + parts.join('.*') + '$', 'i');
}

function normalizeIP(ip) {
    if (!ip) return '';
    let cleaned = ip.trim();
    if (cleaned.startsWith('::ffff:')) {
        cleaned = cleaned.slice(7);
    }
    if (cleaned === '::1') {
        return '127.0.0.1';
    }
    return cleaned;
}

function ipToInt(ip) {
    return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

function matchCIDR(ip, cidr) {
    try {
        const [range, bits = '32'] = cidr.split('/');
        const bitCount = parseInt(bits, 10);
        if (bitCount === 0) return true;
        const mask = ~(2 ** (32 - bitCount) - 1) >>> 0;
        return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
    } catch {
        return false;
    }
}

function isIPAllowed(rawIP, patterns) {
    if (!patterns) return true;
    const list = Array.isArray(patterns) ? patterns : String(patterns).split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return true;
    if (list.includes('*') || list.includes('all')) return true;

    const ip = normalizeIP(rawIP);

    for (const rawPat of list) {
        if (!rawPat) continue;
        const pat = rawPat.trim();
        if (pat === '*' || pat === 'all') return true;

        // CIDR notation (e.g. 192.168.1.0/24)
        if (pat.includes('/')) {
            if (matchCIDR(ip, pat)) return true;
            continue;
        }

        const normalizedPat = normalizeIP(pat);

        // Wildcard match (e.g. 192.168.1.*, 10.*.*.*, 127.0.0.1)
        const regex = wildcardToRegex(normalizedPat);
        if (regex.test(ip) || regex.test(rawIP)) return true;
    }
    return false;
}

function isOriginAllowed(origin, patterns) {
    if (!origin) return false;
    const list = Array.isArray(patterns) ? patterns : String(patterns).split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return false;

    let parsedOrigin = null;
    try {
        parsedOrigin = new URL(origin);
    } catch (_) { }

    for (const rawPattern of list) {
        if (!rawPattern) continue;
        const pat = rawPattern.trim();
        if (pat === '*') return true;

        // 1. Direct match on full origin string
        const fullRegex = wildcardToRegex(pat);
        if (fullRegex.test(origin)) return true;

        // 2. If origin is a valid URL, match host/hostname and implicit protocol/ports
        if (parsedOrigin) {
            const hostname = parsedOrigin.hostname; // e.g. "sub.domain.com" or "192.168.1.5"
            const host = parsedOrigin.host;         // e.g. "sub.domain.com:8080"

            if (fullRegex.test(hostname)) return true;
            if (fullRegex.test(host)) return true;

            // If pattern has no scheme, allow matching with incoming origin's scheme
            if (!pat.includes('://')) {
                const protoPat = `${parsedOrigin.protocol}//${pat}`;
                if (wildcardToRegex(protoPat).test(origin)) return true;
                if (wildcardToRegex(`${protoPat}:*`).test(origin)) return true;
            }
        }
    }
    return false;
}

const ALLOWED_ORIGINS = Array.isArray(CONFIG.allowedOrigins) ? CONFIG.allowedOrigins : String(CONFIG.allowedOrigins).split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_IPS = Array.isArray(CONFIG.allowedIPs) ? CONFIG.allowedIPs : String(CONFIG.allowedIPs).split(',').map(s => s.trim()).filter(Boolean);

// IP filtering middleware (supports wildcards and CIDR ranges)
app.use((req, res, next) => {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || req.ip;
    if (!isIPAllowed(clientIP, ALLOWED_IPS)) {
        if (CONFIG.verbose) console.warn(`[security] Blocked request from unauthorized client IP: ${clientIP}`);
        return res.status(403).json({ error: true, code: 'forbidden', reason: `Access denied: IP ${clientIP} is not allowed` });
    }
    next();
});

// CORS middleware supporting wildcard domains, origins, and IP addresses
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        if (isOriginAllowed(origin, ALLOWED_ORIGINS)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
    } else {
        const originList = Array.isArray(ALLOWED_ORIGINS) ? ALLOWED_ORIGINS : String(ALLOWED_ORIGINS).split(',').map(s => s.trim());
        if (originList.includes('*')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// GET /manifest — Capability manifest (unauthenticated, spec §2)
app.get('/manifest', (req, res) => {
    res.json({
        runtime_type: 'nodejs',
        transport: 'rest-ws',
        persistent_state: 'native',
        live_logs: 'push',
        secrets_revealable: true,
        artifact_deploy: 'live-post',
        concurrency_check: 'version-stamp',
        role_management: 'full',
        max_payload_bytes: RUNTIME.capabilities.maxValueSize,
        poll_interval_hint_ms: 4000
    });
});

// GET /nodaic/v1/ — Health alias (subset of manifest, for quick connectivity checks)
app.get('/nodaic/v1/', (req, res) => {
    res.json({
        environment: RUNTIME.environment,
        runtimeId: RUNTIME.id,
        capabilities: RUNTIME.capabilities,
        api: 'unified-v1'
    });
});

// Unified Action Dispatch Endpoint
app.post('/nodaic/v1/', async (req, res) => {
    const { action, payload = {} } = req.body || {};
    const token = extractToken(req);
    if (!action) return res.status(400).json({ error: true, code: 'bad_request', reason: 'Missing action field' });
    try {
        const result = await dispatch(action, payload, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

// Opaque Public Token Trigger Route: /trigger/pub/:token (fail-closed)
app.all('/trigger/pub/:token', async (req, res) => {
    const { token } = req.params;
    const rows = await db.exec(`SELECT * FROM bindings WHERE public_token = ?`, [token]);
    if (!rows || rows.length === 0) {
        return res.status(404).json({ error: true, code: 'not_found', reason: 'Endpoint not found' });
    }
    const binding = rows[0];
    const queryData = req.query ? { ...req.query } : {};
    const bodyData = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
    const payloadData = { ...queryData, ...bodyData };
    delete payloadData.token;
    delete payloadData.auth_token;

    try {
        const results = await scheduler.emit(binding.event, payloadData);
        res.json({ outputs: results.map(r => ({ artifactId: r.artifactId, output: r?.output ?? null })) });
    } catch (err) {
        res.status(500).json(errEnvelope(err));
    }
});

// Standard Webhook Route: /trigger/:event, /trigger/sync/:event, /trigger/async/:event
app.all(/^\/trigger(?:\/(async|sync))?\/(.+)$/, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const mode = req.params[0];
    const event = req.params[1];
    const isAsync = mode === 'async';
    const token = extractToken(req);
    const queryData = req.query ? { ...req.query } : {};
    const bodyData = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
    const payloadData = { ...queryData, ...bodyData };
    delete payloadData.token;
    delete payloadData.auth_token;

    try {
        if (isAsync) {
            dispatch('trigger.emit', { event, data: payloadData }, token, () => { })
                .catch(err => console.error(`[async trigger] '${event}' failed:`, err.message));
            res.status(202).json({ event, status: 'queued' });
        } else {
            const result = await dispatch('trigger.emit', { event, data: payloadData }, token, () => { });
            res.json(result);
        }
    } catch (err) {
        res.status(err.status ?? 400).json(errEnvelope(err));
    }
});


// GET /secrets — List secrets, always masked (spec §4)
app.get('/secrets', async (req, res) => {
    const token = extractToken(req);
    try {
        const result = await dispatch('secret.list', {}, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

// POST /secrets/:key/reveal — Unmask one value (elevated/admin required)
app.post('/secrets/:key/reveal', async (req, res) => {
    const token = extractToken(req);
    try {
        const result = await dispatch('secret.reveal', { key: req.params.key }, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

// PUT /secrets/:key or POST /secrets — Create/update secret
app.put('/secrets/:key', async (req, res) => {
    const token = extractToken(req);
    try {
        const payload = { key: req.params.key, ...(req.body || {}) };
        const result = await dispatch('secret.set', payload, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

app.post('/secrets', async (req, res) => {
    const token = extractToken(req);
    try {
        const result = await dispatch('secret.set', req.body || {}, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

// DELETE /secrets/:key — Delete secret
app.delete('/secrets/:key', async (req, res) => {
    const token = extractToken(req);
    try {
        const result = await dispatch('secret.delete', { key: req.params.key }, token);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json(errEnvelope(err));
    }
});

// GET /logs — Poll log buffer (authenticated)
app.get('/logs', async (req, res) => {
    const token = extractToken(req);
    const auth = await resolveAuth(token);
    if (auth.role === 'none') return res.status(401).json({ error: true, code: 'unauthorized', reason: 'Authentication required' });
    const since = Number(req.query.since) || 0;
    const entries = logBuffer.filter(e => e.seq > since);
    const next = logBuffer.length ? logBuffer[logBuffer.length - 1].seq : 0;
    res.json({ entries, next });
});

const wss = new WebSocketServer({
    server,
    path: '/nodaic/v1/ws',
    verifyClient: (info, callback) => {
        const clientIP = info.req.headers['x-forwarded-for']?.split(',')[0].trim() || info.req.socket.remoteAddress;
        if (!isIPAllowed(clientIP, ALLOWED_IPS)) {
            if (CONFIG.verbose) console.warn(`[ws] Rejected unauthorized IP: ${clientIP}`);
            return callback(false, 403, 'Forbidden IP');
        }
        const origin = info.origin || info.req.headers.origin;
        if (origin && !isOriginAllowed(origin, ALLOWED_ORIGINS)) {
            if (CONFIG.verbose) console.warn(`[ws] Rejected unauthorized origin: ${origin}`);
            return callback(false, 403, 'Forbidden Origin');
        }
        callback(true);
    }
});
wss.on('error', (err) => {
    // Suppress unhandled error crash when server is retrying listening on next port
    if (err.code !== 'EADDRINUSE') {
        console.error('[ws] WebSocketServer error:', err.message);
    }
});
const wsSend = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };


wss.on('connection', (ws) => {
    if (CONFIG.verbose) console.log('[ws] Client connected to unified stream');

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return wsSend(ws, { event: 'error', error: 'Invalid JSON' }); }

        const { action, token, payload = {} } = msg;

        if (msg.type === 'ping' || action === 'ping') {
            return wsSend(ws, { event: 'pong', ts: Date.now() });
        }

        if (!action) return wsSend(ws, { event: 'error', error: 'Missing action field' });

        try {
            const requestId = crypto.randomUUID();
            const emitCallback = (eventObj) => wsSend(ws, { ...eventObj, requestId });

            const result = await dispatch(action, payload, token, emitCallback);

            if (['run.start', 'trigger.emit'].includes(action)) {
                wsSend(ws, { event: `${action}.ack`, requestId });
            } else {
                wsSend(ws, { event: `${action}.reply`, result, requestId });
            }

        } catch (err) {
            wsSend(ws, { event: 'error', action, error: err.message });
        }
    });

    ws.on('close', () => {
        if (CONFIG.verbose) console.log('[ws] Client disconnected');
    });
});

/* ─── Start ──────────────────────────────────────────────────────── */

app.use((req, res) => res.status(404).json({ error: true, code: 'not_found', reason: 'Endpoint not found' }));

function printPairingInfo() {
    const url = `http://localhost:${CONFIG.port}`;
    const border = '─'.repeat(52);
    console.log(`\n┌${border}┐`);
    console.log(`│  Nodaic Runtime — Ready${' '.repeat(28)}│`);
    console.log(`│${' '.repeat(54)}│`);
    console.log(`│  URL: ${url.padEnd(46)}│`);
    console.log(`│  ID:  ${CONFIG.runtimeId.padEnd(46)}│`);
    console.log(`│  Env: ${CONFIG.environment.padEnd(46)}│`);
    console.log(`└${border}┘\n`);
    if (bootAdminToken) {
        console.log(`[!] BOOT ADMIN TOKEN:\n${bootAdminToken}\n`);
    }
}

function startServer() {
    let currentPort = Number(CONFIG.port) || 3030;
    const maxAttempts = 100;
    let attempts = 0;

    function tryListen(port) {
        const onError = (err) => {
            if (err.code === 'EADDRINUSE') {
                attempts++;
                if (attempts >= maxAttempts) {
                    console.error(`[runtime] Could not find an available port after ${maxAttempts} attempts.`);
                    process.exit(1);
                }
                console.log(`[runtime] Port ${port} is occupied, trying next port ${port + 1}...`);
                tryListen(port + 1);
            } else {
                console.error('[runtime] Server error:', err.message);
                process.exit(1);
            }
        };

        server.once('error', onError);

        server.listen(port, () => {
            server.removeListener('error', onError);
            CONFIG.port = port;
            printPairingInfo();
            console.log(`[runtime] HTTP: POST http://localhost:${CONFIG.port}/nodaic/v1/`);
            console.log(`[runtime] WS:   ws://localhost:${CONFIG.port}/nodaic/v1/ws`);
            console.log(`[runtime] Env:  ${CONFIG.environment} | verbose: ${CONFIG.verbose}\n`);

            setInterval(() => {
                if (runs.size === 0) return;
                const now = Date.now();
                for (const [runId, entry] of runs) {
                    const heartbeat = {
                        event: 'run.heartbeat',
                        runId,
                        uptime: Math.floor((now - (entry.startTime ?? now)) / 1000)
                    };
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) client.send(JSON.stringify(heartbeat));
                    });
                }
            }, CONFIG.heartbeatInterval);

            if (CONFIG.autoRun?.length) {
                console.log(`[runtime] Executing ${CONFIG.autoRun.length} autoRun entries...`);
                const internalAuth = { role: 'admin', keyId: 'internal' };
                for (const entry of CONFIG.autoRun) {
                    if (!entry.id) continue;
                    dispatch('run.start', {
                        artifactId: entry.id,
                        input: entry.input ?? {},
                        state: entry.state ?? {}
                    }, internalAuth, () => { })
                        .then(result => console.log(`[autoRun] '${entry.id}' completed:`, result?.output ?? null))
                        .catch(err => console.error(`[autoRun] '${entry.id}' failed:`, err.message));
                }
            }
        });
    }

    tryListen(currentPort);
}


/* ─── Graceful Shutdown ──────────────────────────────────────────── */

function shutdown() {
    console.log('[runtime] Shutting down...');
    try { wss.clients.forEach(c => c.close(1001, 'Server shutting down')); } catch (_) {}
    try { if (_dbConn && typeof _dbConn.close === 'function') _dbConn.close(); } catch (_) {}
    server.close(() => {
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
    isOriginAllowed,
    isIPAllowed,
    wildcardToRegex,
    normalizeIP,
    matchCIDR,
    escapeRegex
};