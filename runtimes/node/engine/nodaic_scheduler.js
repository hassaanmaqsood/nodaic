/**
 * nodaic_scheduler.js — WorkflowScheduler
 *
 * Ties named events to Library artifacts (Process | Node | Graph).
 * Universal edition (Node.js + Cloudflare).
 */

class WorkflowScheduler {
    constructor(library, options = {}) {
        if (!library) throw new Error('Library instance required');

        this.library = library;
        this._bindings = new Map();
        this._running = new Map();

        this.options = {
            verbose: options.verbose ?? false,
            maxConcurrent: options.maxConcurrent ?? 10
        };
    }

    // ─── Binding API ───────────────────────────────────────────────

    on(eventName, artifactId, opts = {}) {
        if (!this._bindings.has(eventName)) {
            this._bindings.set(eventName, []);
        }
        this._bindings.get(eventName).push({
            artifactId,
            state: opts.state ?? {},
            filter: opts.filter ?? null,
            once: opts.once ?? false
        });
        this._log(`on('${eventName}') → '${artifactId}'`);
        return this;
    }

    off(eventName, artifactId = null) {
        if (!this._bindings.has(eventName)) return this;

        if (artifactId === null) {
            this._bindings.delete(eventName);
        } else {
            const remaining = this._bindings.get(eventName)
                .filter(b => b.artifactId !== artifactId);
            remaining.length
                ? this._bindings.set(eventName, remaining)
                : this._bindings.delete(eventName);
        }
        return this;
    }

    // ─── Execution API ─────────────────────────────────────────────

    async emit(eventName, eventData = {}) {
        this._log(`emit('${eventName}')`);

        const bindings = this._bindings.get(eventName) || [];
        const toRun = bindings.filter(b => {
            if (b.filter && !b.filter(eventData)) {
                this._log(`  filtered '${b.artifactId}'`);
                return false;
            }
            return true;
        });

        const remaining = bindings.filter(b => !b.once || !toRun.includes(b));
        remaining.length
            ? this._bindings.set(eventName, remaining)
            : this._bindings.delete(eventName);

        // Implicit execution: if eventName matches an artifact in the library
        if (this.library.has(eventName)) {
            // Avoid duplicate execution if already explicitly bound
            if (!toRun.some(b => b.artifactId === eventName)) {
                toRun.push({ artifactId: eventName, state: {}, filter: null, once: false });
                this._log(`  implicit run for '${eventName}'`);
            }
        }

        if (!toRun.length) {
            this._log(`  no bindings or implicit artifact for '${eventName}'`);
            return [];
        }

        return Promise.all(toRun.map(b => this._execute(b.artifactId, eventData, b.state)));
    }

    async run(artifactId, input = {}, state = {}) {
        const result = await this._execute(artifactId, input, state);
        return result?.output ?? null;
    }

    // ─── Internal ──────────────────────────────────────────────────

    async _execute(artifactId, input, seedState = {}) {
        const artifact = await this.library.getInstance(artifactId);
        if (!artifact) {
            console.error(`[Scheduler] '${artifactId}' not in Library`);
            return { artifactId, output: null, error: 'not found' };
        }

        const active = this._running.get(artifactId) ?? 0;
        if (active >= this.options.maxConcurrent) {
            console.warn(`[Scheduler] '${artifactId}' at concurrency limit`);
            return { artifactId, output: null, error: 'concurrency limit' };
        }

        this._running.set(artifactId, active + 1);
        this._log(`  run '${artifactId}'`);

        const state = {
            ...seedState,
            _emit: (name, data) => this.emit(name, data)
        };

        try {
            const result = await new Promise((resolve, reject) => {
                try {
                    artifact.compute(input, state, resolve);
                } catch (err) {
                    reject(err);
                }
            });

            const output = result?.output ?? result ?? {};
            this._log(`  done '${artifactId}'`);
            return { artifactId, output };

        } catch (err) {
            console.error(`[Scheduler] '${artifactId}' threw:`, err.message);
            return { artifactId, output: null, error: err.message };
        } finally {
            const n = this._running.get(artifactId) - 1;
            n > 0
                ? this._running.set(artifactId, n)
                : this._running.delete(artifactId);
        }
    }

    // ─── Introspection ─────────────────────────────────────────────

    bindings() {
        const out = {};
        for (const [event, list] of this._bindings.entries()) {
            out[event] = list.map(b => b.artifactId);
        }
        return out;
    }

    _log(msg) {
        if (this.options.verbose) console.log(`[Scheduler] ${msg}`);
    }
}

/* ─── Export ─────────────────────────────────────────────────────── */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WorkflowScheduler };
} else if (typeof window !== 'undefined') {
    window.Nodaic = { ...(window.Nodaic ?? {}), WorkflowScheduler };
}