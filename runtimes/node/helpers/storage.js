const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

/**
 * ============================================================================
 * 1. PURE OPERATIONS (Ops)
 * ============================================================================
 * These functions have no side effects. They take inputs and return outputs, 
 * making them fully testable and environment-agnostic.
 */
const Ops = {
    fingerprint(str) {
        return crypto.createHash('sha256').update(str).digest('hex');
    },

    encrypt(text, keyBuffer) {
        if (!keyBuffer || keyBuffer.length !== 32) throw new Error("Storage.Ops: Valid 32-byte encryption key required.");
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return JSON.stringify({ iv: iv.toString('hex'), authTag, data: encrypted });
    },

    decrypt(payload, keyBuffer) {
        if (!keyBuffer || keyBuffer.length !== 32) throw new Error("Storage.Ops: Valid 32-byte encryption key required.");
        const { iv, authTag, data } = JSON.parse(payload);
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    },

    compress(str) {
        return zlib.deflateSync(str).toString('base64');
    },

    decompress(base64Str) {
        return zlib.inflateSync(Buffer.from(base64Str, 'base64')).toString('utf8');
    },

    computeDiff(oldStr, newStr) {
        if (oldStr === newStr) return null;
        let start = 0;
        while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) start++;
        let oldEnd = oldStr.length - 1;
        let newEnd = newStr.length - 1;
        while (oldEnd >= start && newEnd >= start && oldStr[oldEnd] === newStr[newEnd]) {
            oldEnd--;
            newEnd--;
        }
        return {
            s: start,
            r: oldStr.substring(start, oldEnd + 1),
            a: newStr.substring(start, newEnd + 1)
        };
    },

    applyDiff(oldStr, diff) {
        if (!diff) return oldStr;
        return oldStr.substring(0, diff.s) + diff.a + oldStr.substring(diff.s + diff.r.length);
    }
};

/**
 * ============================================================================
 * 2. I/O ADAPTERS (IO)
 * ============================================================================
 * Wrappers for side-effects. Uniform surfaces mean pipelines don't care 
 * if they are writing to disk, SQLite, or a Cloud Bucket.
 */
const IO = {
    File: {
        read: async (baseDir, key) => await fs.readFile(path.join(baseDir, key), 'utf8'),
        write: async (baseDir, key, content) => {
            const p = path.join(baseDir, key);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.writeFile(p, content, 'utf8');
        },
        append: async (baseDir, key, content) => {
            const p = path.join(baseDir, key);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.appendFile(p, content, 'utf8');
        },
        kvGet: async (filePath, key) => {
            try {
                const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
                return data[key];
            } catch (e) { return undefined; }
        },
        kvSet: async (filePath, key, value) => {
            let data = {};
            try { data = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (e) {}
            data[key] = value;
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        },
        kvDelete: async (filePath, key) => {
            let data = {};
            try { data = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (e) {}
            delete data[key];
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        },
        kvKeys: async (filePath) => {
            try {
                const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
                return Object.keys(data);
            } catch (e) { return []; }
        }
    },
    SQLite: {
        read: async (db, key) => {
            if (key.endsWith('.journal')) {
                try {
                    // SQLite handles journal by fetching all appended rows and concatenating them
                    const rows = db.prepare('SELECT content FROM storage_journal WHERE key = ? ORDER BY rowid ASC').all(key);
                    return rows.map(r => r.content).join('');
                } catch(e) { throw new Error('ENOENT'); }
            }
            const row = db.prepare('SELECT value FROM storage WHERE key = ?').get(key);
            if (!row) throw new Error('ENOENT');
            return row.value;
        },
        write: async (db, key, content) => {
            db.exec(`CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT)`);
            db.prepare('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)').run(key, content);
        },
        append: async (db, key, content) => {
            db.exec(`CREATE TABLE IF NOT EXISTS storage_journal (key TEXT, content TEXT)`);
            db.prepare('INSERT INTO storage_journal (key, content) VALUES (?, ?)').run(key, content);
        },
        kvGet: async (db, key) => {
            try {
                const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
                return row ? row.value : undefined;
            } catch(e) { return undefined; }
        },
        kvSet: async (db, key, value) => {
            db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
            db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
        },
        kvDelete: async (db, key) => {
            try { db.prepare('DELETE FROM kv WHERE key = ?').run(key); } catch(e) {}
        },
        kvKeys: async (db) => {
            try {
                db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
                return db.prepare('SELECT key FROM kv').all().map(r => r.key);
            } catch(e) { return []; }
        }
    },
    // STUB — replace with a real adapter before production use
    Bucket: {
        read: async (bucket, key) => await bucket.get(key),
        write: async (bucket, key, content) => await bucket.put(key, content),
        append: async (_b, _k, _c) => { throw new Error('Bucket.append: not supported natively — use read-concat-write adapter'); },
        kvGet: async (_b, _k) => undefined, // STUB
        kvSet: async (_b, _k, _v) => {}     // STUB
    },
    KV: {
        read: async (map, key) => {
            const val = map.get(key);
            if (val === undefined) throw new Error('ENOENT');
            return val;
        },
        write: async (map, key, content) => {
            map.set(key, content);
        },
        append: async (map, key, content) => {
            map.set(key, (map.get(key) || '') + content);
        },
        kvGet: async (map, key) => map.get(key),
        kvSet: async (map, key, value) => map.set(key, value),
        kvDelete: async (map, key) => { map.delete(key); },
        kvKeys: async (map) => Array.from(map.keys()),
        // STUB — ignores SQL entirely, returns all object values from the Map
        exec: async (map, _sql, _params = []) => Array.from(map.values()).filter(v => typeof v === 'object')
    }
};

/**
 * ============================================================================
 * 3. COMPOSABLE PIPELINES
 * ============================================================================
 * Standardized classes that string together Pure Ops and IO Adapters seamlessly.
 */

/**
 * BlobPipeline handles raw text/binary artifact source payloads and secrets.
 * Supports inline shortcuts for small payloads (<= 4KB) and sha256 content-addressed refs.
 */
class BlobPipeline {
    /**
     * @param {Object} config
     * @param {Object} config.io - The IO adapter to use (e.g. IO.File, IO.KV)
     * @param {string|Object} config.target - Target connection (baseDir, DB, or Map)
     * @param {string|Buffer} config.encryptKey - 32-byte encryption key
     * @param {boolean} config.useCompression - Compress using zlib
     * @param {number} config.inlineMaxBytes - Maximum payload size to inline (default: 4096)
     */
    constructor({ io, target, encryptKey = null, useCompression = false, inlineMaxBytes = 4096 }) {
        this.io = io;
        this.target = target;
        this.encryptKey = encryptKey ? Buffer.from(encryptKey) : null;
        this.useCompression = useCompression;
        this.inlineMaxBytes = inlineMaxBytes;
    }

    async write(content) {
        const raw = String(content);
        if (Buffer.byteLength(raw) <= this.inlineMaxBytes) {
            return 'inline:' + raw;
        }

        const ref = Ops.fingerprint(raw);
        let processed = raw;
        if (this.useCompression) processed = Ops.compress(processed);
        if (this.encryptKey) processed = Ops.encrypt(processed, this.encryptKey);

        await this.io.write(this.target, ref, processed);
        return ref;
    }

    async read(ref) {
        if (!ref) return null;
        if (typeof ref === 'string' && ref.startsWith('inline:')) {
            return ref.slice(7);
        }

        let content = await this.io.read(this.target, ref);
        if (this.encryptKey) content = Ops.decrypt(content, this.encryptKey);
        if (this.useCompression) content = Ops.decompress(content);
        return content;
    }

    async delete(ref) {
        if (!ref || ref.startsWith('inline:')) return;
        if (this.io.delete) {
            await this.io.delete(this.target, ref);
        } else if (this.io.kvDelete) {
            await this.io.kvDelete(this.target, ref);
        }
    }
}

/**
 * StoragePipeline handles blobs, files, and modules, and includes built-in 
 * compact snapshot diff journaling. It treats all data as raw strings.
 */
class StoragePipeline {
    constructor({ io, target, encryptKey = null, useCompression = false, enableJournal = false }) {
        this.io = io;
        this.target = target;
        this.encryptKey = encryptKey ? Buffer.from(encryptKey) : null;
        this.useCompression = useCompression;
        this.enableJournal = enableJournal;
    }

    async save(key, data) {
        let content = String(data);
        const rawContent = content;
        const fp = Ops.fingerprint(content);

        if (this.useCompression) content = Ops.compress(content);
        if (this.encryptKey) content = Ops.encrypt(content, this.encryptKey);

        let oldRawContent = "";
        if (this.enableJournal) {
            try {
                let old = await this.io.read(this.target, key);
                if (this.encryptKey) old = Ops.decrypt(old, this.encryptKey);
                if (this.useCompression) old = Ops.decompress(old);
                oldRawContent = old;
            } catch (e) { /* File doesn't exist yet */ }
        }

        await this.io.write(this.target, key, content);

        if (this.enableJournal) {
            const diff = Ops.computeDiff(oldRawContent, rawContent);
            const entry = [Date.now(), fp, diff];
            await this.io.append(this.target, key + '.journal', JSON.stringify(entry) + '\n');
        }

        return fp;
    }

    async load(key) {
        let content = await this.io.read(this.target, key);
        if (this.encryptKey) content = Ops.decrypt(content, this.encryptKey);
        if (this.useCompression) content = Ops.decompress(content);
        return content;
    }

    async getHistory(key) {
        try {
            const rawJournal = await this.io.read(this.target, key + '.journal');
            const lines = rawJournal.split('\n').filter(Boolean).map(l => JSON.parse(l));
            let current = "";
            return lines.map(([ts, hash, diff]) => {
                current = Ops.applyDiff(current, diff);
                return { timestamp: new Date(ts).toISOString(), fingerprint: hash, content: current };
            });
        } catch (e) { return []; }
    }
}

/**
 * DatabasePipeline acts as a Key-Value & SQL abstraction mapping directly to JSON properties 
 * or Database Rows, featuring row-level encryption and compression.
 */
class DatabasePipeline {
    constructor({ io, target, encryptKey = null, useCompression = false }) {
        this.io = io;
        this.target = target;
        this.encryptKey = encryptKey ? Buffer.from(encryptKey) : null;
        this.useCompression = useCompression;
    }

    async exec(sql, params = []) {
        if (this.io && typeof this.io.exec === 'function') {
            return await this.io.exec(this.target, sql, params);
        }
        if (this.target && typeof this.target.prepare === 'function') {
            const stmt = this.target.prepare(sql);
            const isSelect = /^\s*SELECT/i.test(sql) || /^\s*PRAGMA/i.test(sql);
            return isSelect ? stmt.all(...params) : stmt.run(...params);
        }
        throw new Error('DatabasePipeline: Underlying IO target does not support exec() SQL statements.');
    }

    async set(key, value) {
        let content = typeof value === 'string' ? value : JSON.stringify(value);
        if (this.useCompression) content = Ops.compress(content);
        if (this.encryptKey) content = Ops.encrypt(content, this.encryptKey);
        await this.io.kvSet(this.target, key, content);
    }

    async get(key) {
        let content = await this.io.kvGet(this.target, key);
        if (content === undefined) return undefined;
        if (this.encryptKey) content = Ops.decrypt(content, this.encryptKey);
        if (this.useCompression) content = Ops.decompress(content);
        try { return JSON.parse(content); } catch (e) { return content; }
    }

    async delete(key) {
        await this.io.kvDelete(this.target, key);
    }

    async keys() {
        return this.io.kvKeys(this.target);
    }

    async listKeys(prefix = '') {
        const allKeys = await this.keys();
        if (!prefix) return allKeys;
        return allKeys.filter(k => k.startsWith(prefix));
    }
}

module.exports = { Ops, IO, DatabasePipeline, BlobPipeline, StoragePipeline };

/**
 * ============================================================================
 * Scenarios and Integration Tests
 * ============================================================================
 */
if (require.main === module) {
    const Database = require('better-sqlite3');

    (async () => {
        console.log("Running Modular Pipeline Tests...\n");
        const testDir = path.join(__dirname, '.pipeline_test_temp');
        const key32 = crypto.randomBytes(32);

        try {
            console.log("--- SCENARIO 1: Blob Pipeline (Inline & Content-Addressed) ---");
            const mapTarget = new Map();
            const blobKv = new BlobPipeline({ io: IO.KV, target: mapTarget, inlineMaxBytes: 20 });
            
            const refInline = await blobKv.write("hello");
            console.log(" [Blob] Small content ref:", refInline);
            console.log(" [Blob] Small content read:", await blobKv.read(refInline));

            const largeContent = "x".repeat(100);
            const refBlob = await blobKv.write(largeContent);
            console.log(" [Blob] Large content ref:", refBlob);
            console.log(" [Blob] Large content read length:", (await blobKv.read(refBlob)).length);

            console.log("\n--- SCENARIO 2: In-Memory IO.KV Database Pipeline ---");
            const kvDb = new DatabasePipeline({ io: IO.KV, target: mapTarget });
            await kvDb.set('artifact:local:test', { id: 'test', version: 'v1' });
            await kvDb.set('artifact:local:foo', { id: 'foo', version: 'v1' });
            await kvDb.set('binding:local:click', { event: 'click' });
            
            console.log(" [Database KV] listKeys('artifact:'):", await kvDb.listKeys('artifact:'));
            console.log(" [Database KV] get('artifact:local:test'):", await kvDb.get('artifact:local:test'));

            console.log("\n--- SCENARIO 3: SQLite Storage & SQL Exec ---");
            await fs.mkdir(testDir, { recursive: true });
            const sqliteConn = new Database(path.join(testDir, 'data.sqlite'));
            const sqliteDb = new DatabasePipeline({ io: IO.SQLite, target: sqliteConn });

            sqliteConn.exec(`CREATE TABLE IF NOT EXISTS test_tbl (id TEXT PRIMARY KEY, val TEXT)`);
            await sqliteDb.exec(`INSERT INTO test_tbl VALUES (?, ?)`, ['k1', 'v1']);
            const rows = await sqliteDb.exec(`SELECT * FROM test_tbl`);
            console.log(" [SQLite exec] Query result:", rows);
            sqliteConn.close();

        } catch (err) {
            console.error("Test failed:", err);
        } finally {
            await fs.rm(testDir, { recursive: true, force: true });
            console.log("\nAll Tests Completed & Environment Cleaned.");
        }
    })();
}