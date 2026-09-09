/**
 * state_process.js — StateNode (SQLite-backed, unified variables table in nodaic.db)
 *
 * Contract (as a Process used inside a graph):
 *
 *   key / namespace resolution: input.key ?? state.key, input.namespace ??
 *   state.namespace ?? 'default'. `state` here is the Node's own persistent
 *   state (Node.state in nodaic_minimal.js), which NDL's `state key = "..."`
 *   line sets once at graph-authoring time.
 *
 *   Namespace Gates:
 *   Built-in namespaces like 'secrets' and 'system' are strictly gated.
 *   Graph workflows cannot read or write to these reserved namespaces.
 *
 *   Write:  input has ANY key besides {key, namespace}
 *           -> that remaining `value` becomes the new stored value.
 *           Convention: if `value` is exactly { value: X }, it unwraps to
 *           the raw X.
 *
 *   Atomicity: writes use a single conditional UPSERT in the unified
 *   `variables` table in the runtime database.
 *
 *   Read/initialization: input has nothing besides {key, namespace} (or is
 *   entirely empty) -> no write, just publish the current stored value.
 *
 *   Output is always a read-through: { key, value } reflecting whatever is
 *   now stored, whether this call wrote or not.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RESERVED_NAMESPACES = new Set(['secrets', 'system']);

function isReservedNamespace(ns) {
    if (!ns || typeof ns !== 'string') return false;
    return RESERVED_NAMESPACES.has(ns.toLowerCase().trim());
}

class StateNode {
    constructor(dbOrPath = null) {
        this.subscribers = new Map(); // "namespace/key" -> Map(subscriberId -> fn)
        this.compute = this.compute.bind(this);
        this.db = null;

        if (dbOrPath && typeof dbOrPath === 'object' && typeof dbOrPath.prepare === 'function') {
            this.setDb(dbOrPath);
        } else if (typeof dbOrPath === 'string') {
            this._initDbWithPath(dbOrPath);
        }
    }

    _ensureDb() {
        if (this.db) return this.db;
        const dbPath = process.env.NODAIC_DB_PATH || process.env.NODAIC_STATE_DB_PATH || path.join(__dirname, 'nodaic.db');
        this._initDbWithPath(dbPath);
        return this.db;
    }

    _initDbWithPath(dbPath) {
        if (dbPath && dbPath !== ':memory:') {
            const dir = path.dirname(dbPath);
            if (dir && dir !== '.') {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        const db = new Database(dbPath, { timeout: 5000 });
        try { db.pragma('journal_mode = WAL'); } catch (_) {}
        try { db.pragma('busy_timeout = 5000'); } catch (_) {}
        this.setDb(db);
    }

    _initSchemaAndStmts() {
        if (!this.db) return;
        try { this.db.pragma('journal_mode = WAL'); } catch (_) {}
        try { this.db.pragma('busy_timeout = 5000'); } catch (_) {}
        this.db.exec(`
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

        this._selectStmt = this.db.prepare("SELECT value FROM variables WHERE namespace = ? AND key = ? AND type = 'state'");
        this._insertIgnoreStmt = this.db.prepare(`
            INSERT OR IGNORE INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
            VALUES (?, ?, ?, 'state', 0, '["*"]', 'local', NULL, ?, ?)
        `);
        this._upsertStmt = this.db.prepare(`
            INSERT INTO variables (namespace, key, value, type, encrypted, roles_json, owner_id, meta_json, created_at, updated_at)
            VALUES (?, ?, ?, 'state', 0, '["*"]', 'local', NULL, ?, ?)
            ON CONFLICT(namespace, key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            WHERE variables.value != excluded.value
        `);
    }

    setDb(dbConn) {
        if (dbConn && typeof dbConn.prepare === 'function') {
            this.db = dbConn;
            this._initSchemaAndStmts();
        }
    }

    /**
     * Process-compatible entry point: (input, state, callback).
     * `state` here is the caller's Node.state — the NDL-configured, per-node
     * persistent config, not this class's own storage.
     */
    compute(input = {}, state = {}, callback = () => { }) {
        this._ensureDb();
        const { key: inputKey, namespace: inputNamespace, ...value } = input;

        const key = inputKey ?? state.key;
        const namespace = inputNamespace ?? state.namespace ?? 'default';

        if (key === undefined) {
            callback({ output: {}, state, error: 'state: "key" is required (via input.key or state.key)' });
            return;
        }

        // Namespace gate: reject reserved built-in namespaces
        if (isReservedNamespace(namespace)) {
            callback({ output: {}, state, error: `Access denied: namespace "${namespace}" is a reserved built-in namespace` });
            return;
        }

        const valueKeys = Object.keys(value);
        const isReadOrInit = valueKeys.length === 0;

        if (isReadOrInit) {
            const current = this._read(namespace, key);
            callback({ output: { key, value: current }, state });
            return;
        }

        // Convention: a lone `value` field unwraps to the raw value;
        // any other shape is stored as-is.
        const resolvedValue = (valueKeys.length === 1 && valueKeys[0] === 'value')
            ? value.value
            : value;

        const now = Date.now();
        const serialized = StateNode._serialize(resolvedValue);
        const result = this._upsertStmt.run(namespace, key, serialized, now, now);
        const written = result.changes > 0;

        const finalValue = written ? resolvedValue : this._read(namespace, key);

        if (written) this._notify(namespace, key, finalValue);

        callback({ output: { key, value: finalValue }, state });
    }

    /**
     * Atomic "set only if the key doesn't exist yet"
     */
    trySetIfAbsent(namespace, key, value) {
        this._ensureDb();
        if (isReservedNamespace(namespace)) {
            throw new Error(`Access denied: namespace "${namespace}" is a reserved built-in namespace`);
        }
        const now = Date.now();
        const result = this._insertIgnoreStmt.run(namespace, key, StateNode._serialize(value), now, now);
        const written = result.changes > 0;
        if (written) this._notify(namespace, key, value);
        return written;
    }

    subscribe(namespace, key, subscriberId, fn) {
        this._ensureDb();
        if (isReservedNamespace(namespace)) {
            throw new Error(`Access denied: namespace "${namespace}" is a reserved built-in namespace`);
        }
        const channel = `${namespace}/${key}`;
        if (!this.subscribers.has(channel)) this.subscribers.set(channel, new Map());
        this.subscribers.get(channel).set(subscriberId, fn);
        return () => {
            const subs = this.subscribers.get(channel);
            if (subs) {
                subs.delete(subscriberId);
                if (!subs.size) this.subscribers.delete(channel);
            }
        };
    }

    get(namespace, key) {
        this._ensureDb();
        if (isReservedNamespace(namespace)) {
            throw new Error(`Access denied: namespace "${namespace}" is a reserved built-in namespace`);
        }
        return this._read(namespace, key);
    }

    delete(namespace, key) {
        this._ensureDb();
        if (isReservedNamespace(namespace)) {
            throw new Error(`Access denied: namespace "${namespace}" is a reserved built-in namespace`);
        }
        const stmt = this.db.prepare("DELETE FROM variables WHERE namespace = ? AND key = ? AND type = 'state'");
        return stmt.run(namespace, key).changes > 0;
    }

    list(namespace = 'default') {
        this._ensureDb();
        if (isReservedNamespace(namespace)) {
            throw new Error(`Access denied: namespace "${namespace}" is a reserved built-in namespace`);
        }
        const stmt = this.db.prepare("SELECT key, value, updated_at FROM variables WHERE namespace = ? AND type = 'state'");
        return stmt.all(namespace).map(r => ({
            key: r.key,
            value: StateNode._deserialize(r.value),
            updatedAt: r.updated_at
        }));
    }

    close() {
        if (this.db && typeof this.db.close === 'function') {
            try { this.db.close(); } catch (_) { }
        }
    }

    _read(namespace, key) {
        this._ensureDb();
        const row = this._selectStmt.get(namespace, key);
        return row ? StateNode._deserialize(row.value) : undefined;
    }

    _notify(namespace, key, value) {
        const subs = this.subscribers.get(`${namespace}/${key}`);
        if (!subs) return;
        for (const [subscriberId, fn] of subs) {
            try {
                fn(value, key);
            } catch (err) {
                console.error(`[StateNode] subscriber '${subscriberId}' for '${namespace}/${key}' threw:`, err.message);
            }
        }
    }

    static _serialize(value) {
        return JSON.stringify(value === undefined ? null : value);
    }

    static _deserialize(text) {
        try { return JSON.parse(text); } catch { return text; }
    }

    static _equal(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a && b && typeof a === 'object') {
            try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
        }
        return false;
    }
}

// Pre-initialized default instance connected to nodaic.db
const defaultDbPath = process.env.NODAIC_DB_PATH || process.env.NODAIC_STATE_DB_PATH || path.join(__dirname, 'nodaic.db');
const stateNode = new StateNode(defaultDbPath);

module.exports = { StateNode, stateNode, isReservedNamespace, RESERVED_NAMESPACES };