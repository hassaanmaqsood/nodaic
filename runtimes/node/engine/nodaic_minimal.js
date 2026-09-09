/**
 * nodaic_minimal.js — minimal runtime
 * Observable → Process → Node → Graph → Library
 * v3.2.0 — Universal edition (Node.js + Cloudflare)
 *
 * Hardened: crypto IDs, Map-based Observable, capped ErrorLog,
 *           single loader (application/javascript), compute timeout,
 *           semver sort, additive mapping, NDL round-trip, cycle detection.
 */

/* ─── Utilities ──────────────────────────────────────────────────── */

function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return require('crypto').randomUUID();
}

/* ─── Observable ─────────────────────────────────────────────────── */

class Observable {
    constructor(value = null) {
        this.value = value;
        this.listeners = new Map();
    }

    subscribe(id, fn) {
        this.listeners.set(id, fn);
        return () => this.listeners.delete(id);
    }

    update(value) {
        this.value = value;
        for (const fn of this.listeners.values()) fn(value);
    }
}

class ErrorLog {
    constructor() {
        this.errors = [];
        this.maxEntries = 500;
    }

    log(context, message, details = {}) {
        this.errors.push({ timestamp: Date.now(), context, message, details });
        if (this.errors.length > this.maxEntries) {
            this.errors = this.errors.slice(-this.maxEntries);
        }
    }

    get(context = null) {
        return context ? this.errors.filter(e => e.context === context) : [...this.errors];
    }

    has(context = null) {
        return context ? this.errors.some(e => e.context === context) : this.errors.length > 0;
    }

    clear() { this.errors = []; }
}

/* ─── Process ────────────────────────────────────────────────────── */

class Process {
    // Compiled functions: accepts live function references directly, or inline JS strings
    // compiled via new Function (safe for trusted artifact sources in a self-hosted runtime).
    static _compileSource(source) {
        if (typeof source === 'function') return source;
        if (typeof source === 'string') {
            // Strategy 1: source is a full function/arrow expression
            //   e.g.  "(input, state, cb) => cb({ output: input, state })"
            try {
                const fn = new Function(`return (${source.trim()})`)();
                if (typeof fn === 'function') return fn;
            } catch (_) { /* not a valid expression — fall through */ }

            // Strategy 2: source is the function body only
            //   e.g.  "returnCallback({ output: input, state });"
            return new Function('input', 'state', 'returnCallback', source);
        }
        throw new Error(`[Process] Unsupported source type: ${typeof source}`);
    }

    static defaultLoaders = {
        'application/javascript': async (source) => Process._compileSource(source),
        // text/javascript is the canonical MIME used by library.push
        'text/javascript':        async (source) => Process._compileSource(source),
    };

    static async fromArtifact(definition, loaders = Process.defaultLoaders) {
        const loader = loaders[definition.sourceType];
        if (!loader) {
            console.error(`[Process] No loader for sourceType: ${definition.sourceType}`);
            return null;
        }
        try {
            const fn = await loader(definition.source);
            const proc = new Process(fn);
            proc.id = definition.id;
            proc.version = definition.version || '1.0.0';
            proc.metadata = definition.metadata || {};
            proc.interface = definition.interface || { inputs: {}, outputs: {} };
            return proc;
        } catch (err) {
            console.error(`[Process] fromArtifact failed for '${definition.id}':`, err.message);
            return null;
        }
    }

    constructor(fn = null, config = {}) {
        this.fn = fn || ((input, state, cb) => cb({ output: input, state }));
        this.errors = new ErrorLog();
        this.id = null;
        this.version = null;
        this.metadata = {};
        this.interface = { inputs: {}, outputs: {} };
        this.loaders = { ...Process.defaultLoaders };
        this.computeTimeout = config.computeTimeout || 30000;
    }

    addLoader(sourceType, loaderFn) {
        this.loaders[sourceType] = loaderFn;
        return this;
    }

    compute(input, state, callback) {
        let called = false;
        const safeCallback = (result) => {
            if (called) return;
            called = true;
            clearTimeout(timer);
            callback(result);
        };

        const timer = setTimeout(() => {
            if (!called) {
                called = true;
                this.errors.log('compute', 'Process execution timed out', { timeout: this.computeTimeout });
                callback({ output: {}, state, error: 'timeout' });
            }
        }, this.computeTimeout);

        try {
            this.fn(input, state, (result) => {
                if (state.signal?.aborted) { clearTimeout(timer); return safeCallback({ output: {}, state, error: 'aborted' }); }
                safeCallback({ output: result?.output ?? {}, state: result?.state ?? state });
            });
        } catch (err) {
            this.errors.log('compute', err.message, { input });
            safeCallback({ output: {}, state });
        }
    }
}


/* ================ NDL ==================== */

function parseNDL(ndlString) {
    if (typeof ndlString !== 'string' || !ndlString.trim()) {
        throw new Error('[NDL] source must be a non-empty string');
    }

    const source = { nodes: {}, edges: [] };
    let currentNode = null;
    let lineNumber = 0;

    for (const raw of ndlString.split('\n')) {
        lineNumber++;
        const line = raw.replace(/#.*$/, '').trimEnd(); // strip inline comments
        const trimmed = line.trim();

        // Blank lines: skip without resetting node context
        // Node context resets on non-indented non-node content lines
        if (!trimmed) continue;

        if (/^graph\s/.test(trimmed)) continue;

        const isIndented = line.startsWith(' ') || line.startsWith('\t');

        if (/^node\s/.test(trimmed) && !isIndented) {
            const m = trimmed.match(/^node\s+(\S+)\s+@([^:\s]+)(?::(\S+))?/);
            if (!m) throw new Error(`[NDL] Invalid node declaration at line ${lineNumber}: "${trimmed}"`);

            currentNode = { artifactRef: m[2], version: m[3] || 'latest', preset: {}, staticInputs: {} };
            if (source.nodes[m[1]]) throw new Error(`[NDL] Duplicate node id "${m[1]}" at line ${lineNumber}`);
            source.nodes[m[1]] = currentNode;
            continue;
        }

        if (isIndented && currentNode) {
            const stateM = trimmed.match(/^state\s+(\S+)\s*=\s*(.+)$/);
            if (stateM) { currentNode.preset[stateM[1]] = ndlParseValue(stateM[2].trim(), lineNumber); continue; }

            const inputM = trimmed.match(/^input\s+(\S+)\s*=\s*(.+)$/);
            if (inputM) { currentNode.staticInputs[inputM[1]] = ndlParseValue(inputM[2].trim(), lineNumber); continue; }

            continue;
        }

        // Non-indented, non-node line: end current node context
        if (!isIndented) {
            currentNode = null;
        }

        if (trimmed.includes('->')) {
            source.edges.push(ndlParseEdge(trimmed, lineNumber));
            continue;
        }
    }

    return source;
}

function ndlParseEdge(line, lineNumber) {
    const arrowIdx = line.indexOf('->');
    const left = line.slice(0, arrowIdx).trim();
    let right = line.slice(arrowIdx + 2).trim();

    let transformFn = null;
    const mapMatch = right.match(/@map:["'](.+?)["']\s*$/);
    if (mapMatch) {
        transformFn = mapMatch[1];
        right = right.slice(0, right.lastIndexOf('@map:')).trim();
    }

    const [from, fromPort] = ndlSplitPort(left);
    const [to, toPort] = ndlSplitPort(right);

    if (!from || !to) throw new Error(`[NDL] Invalid edge at line ${lineNumber}: "${line}"`);

    const config = {};
    if (fromPort) config.sourcePort = fromPort;
    if (toPort) config.targetPort = toPort;
    if (transformFn) {
        config.transformSource = transformFn; // Preserve for round-trip serialization
        try {
            config.transform = new Function('v', `const __f = (${transformFn}); return __f(v);`);
        } catch (e) {
            console.error(`[NDL] Invalid @map at line ${lineNumber}: ${e.message}`);
        }
    }

    return { from, fromPort, to, toPort, config };
}

function ndlSplitPort(token) {
    const i = token.indexOf('.');
    return i === -1 ? [token, null] : [token.slice(0, i), token.slice(i + 1)];
}

function ndlParseValue(raw, lineNumber) {
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);

    if (raw.startsWith('{') || raw.startsWith('[')) {
        try { return JSON.parse(raw); }
        catch (e) { throw new Error(`[NDL] Invalid JSON value at line ${lineNumber}: ${e.message}`); }
    }

    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (!isNaN(Number(raw)) && raw !== '') return Number(raw);

    return raw;
}

function toNDL(graph, options = {}) {
    const { author = null, omitInternalKeys = true } = options;
    const SKIP = new Set(['signal', 'root', 'node']);
    const lines = [];

    let header = `graph ${graph.id || 'unnamed'}`;
    if (graph.version) header += ` @version:${graph.version}`;
    const resolvedAuthor = author || graph.metadata?.author;
    if (resolvedAuthor) header += ` @author:${resolvedAuthor}`;
    const envs = graph.metadata?.environments;
    if (envs?.length) header += ` @env:${envs.join(',')}`;
    lines.push(header, '');

    for (const node of Object.values(graph.nodes)) {
        const artifactId = node._ndlArtifactRef || node.content?._artifactId || 'unknown';
        const version = node._ndlArtifactVersion || node.content?.version;

        let nodeHeader = `node ${node.id} @${artifactId}`;
        if (version && version !== 'latest') nodeHeader += `:${version}`;
        lines.push(nodeHeader);

        const liveState = node.state || {};
        const savedPreset = node._ndlPreset || {};

        const allKeys = new Set([...Object.keys(savedPreset), ...Object.keys(liveState)]);
        for (const key of allKeys) {
            if (omitInternalKeys && (key.startsWith('_') || SKIP.has(key))) continue;
            const isSecretRef = typeof savedPreset[key] === 'string' && (
                savedPreset[key].startsWith('env:') ||
                savedPreset[key].startsWith('secret:') ||
                savedPreset[key].startsWith('@key:') ||
                savedPreset[key].startsWith('@secret:')
            );
            const val = isSecretRef ? savedPreset[key] : liveState[key];
            if (val !== undefined) lines.push(`  state ${key} = ${ndlSerializeValue(val)}`);
        }

        const staticInputs = node._ndlStaticInputs || {};
        for (const [port, val] of Object.entries(staticInputs)) {
            lines.push(`  input ${port} = ${ndlSerializeValue(val)}`);
        }

        lines.push('');
    }

    for (const edge of graph.edges) {
        const config = edge.config || {};
        const fromPort = config.sourcePort && config.sourcePort !== '*' ? config.sourcePort : null;
        const toPort = config.targetPort || null;

        const left = fromPort ? `${edge.from}.${fromPort}` : edge.from;
        const right = toPort ? `${edge.to}.${toPort}` : edge.to;

        let edgeLine = `${left} -> ${right}`;
        if (config.transformSource) {
            edgeLine += ` @map:"${config.transformSource}"`;
        }
        lines.push(edgeLine);
    }

    return lines.join('\n');
}

function ndlSerializeValue(val) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'boolean') return String(val);
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') {
        if (val.startsWith('env:') || val.startsWith('secret:') || val.startsWith('@key:') || val.startsWith('@secret:')) {
            return val;
        }
        return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    if (typeof val === 'object') {
        try { return JSON.stringify(val); } catch { return '"[unserializable]"'; }
    }
    return String(val);
}

/* ─── Node ───────────────────────────────────────────────────────── */

class Node {
    constructor(content = null) {
        this.id = generateId();
        this.content = content;
        this.state = {};
        this.inputs = [];
        this.output = new Observable();
        // NDL round-trip metadata — set by Graph.fromArtifact when loading from NDL
        this._ndlArtifactRef = null;
        this._ndlArtifactVersion = null;
        this._ndlPreset = null;       // original parsed preset (preserves env: references)
        this._ndlStaticInputs = null; // original parsed static inputs
    }

    connect(sourceNode, mapping = {}) {
        const unsub = sourceNode.output.subscribe(this.id, (data) => {
            const conn = this.inputs.find(i => i.refId === sourceNode.id);
            if (conn) conn.data = applyMapping(data, mapping);
        });
        this.inputs.push({ refId: sourceNode.id, mapping, data: {}, unsub });
        return this;
    }

    disconnect(sourceNode) {
        const idx = this.inputs.findIndex(i => i.refId === sourceNode.id);
        if (idx !== -1) { this.inputs[idx].unsub(); this.inputs.splice(idx, 1); }
        return this;
    }

    compute(rootInput = {}, rootState = {}, callback = () => { }) {
        if (!this.content) { callback({}); return Promise.resolve(); }

        // Connected node outputs override rootInput
        const merged = Object.assign({}, rootInput, ...this.inputs.map(i => i.data || {}));

        return new Promise(resolve => {
            this.content.compute(merged, { ...this.state, ...rootState }, (result) => {
                const out = result?.output ?? result ?? {};
                this.state = result?.state ?? this.state;
                this.output.update(out);
                callback(out);
                resolve(out);
            });
        });
    }
}

/* ─── Graph ──────────────────────────────────────────────────────── */

class Graph {
    static loaders = {
        'application/json': async (source) =>
            typeof source === 'string' ? JSON.parse(source) : source,
        'text/json': async (source) =>
            typeof source === 'string' ? JSON.parse(source) : source,
        'text/x-ndl': async (source) => parseNDL(source),
    };

    // dead code - would remove the updating loaders entirely
    // static addLoader(sourceType, loaderFn) {
    //     Graph.loaders[sourceType] = loaderFn;
    // }

    static async fromArtifact(definition, library = null, options = {}) {
        const loader = Graph.loaders[definition.sourceType];
        if (!loader) {
            console.error(`[Graph] No loader for sourceType: ${definition.sourceType}`);
            return null;
        }

        const isNDL = definition.sourceType === 'text/x-ndl';
        let source;
        try {
            source = await loader(definition.source);
        } catch (err) {
            console.error(`[Graph] Load failed for '${definition.id}':`, err.message);
            return null;
        }

        const graph = new Graph();
        graph.id = definition.id;
        graph.version = definition.version || '1.0.0';
        graph.metadata = definition.metadata || {};

        // Build nodes — resolve artifact refs from Library at this point (deferred from registration)
        const nodeMap = {};
        for (const nodeId in source.nodes) {
            const nodeDef = source.nodes[nodeId];
            const node = new Node(null);
            node.id = nodeId;

            if (nodeDef.artifactRef && library) {
                const instance = await library.getInstance(nodeDef.artifactRef, nodeDef.version ?? 'latest');
                if (instance) {
                    node.content = instance.content ?? instance; // Process or Graph
                } else {
                    console.warn(`[Graph] Could not resolve artifact '${nodeDef.artifactRef}' for node '${nodeId}'`);
                }
            }

            // NDL: hydrate state and static inputs
            if (isNDL) {
                if (nodeDef.preset) {
                    node.state = { ...nodeDef.preset };
                    node._ndlPreset = { ...nodeDef.preset };
                }
                if (nodeDef.staticInputs) {
                    node.output.update(nodeDef.staticInputs);
                    node._ndlStaticInputs = { ...nodeDef.staticInputs };
                }
                node._ndlArtifactRef = nodeDef.artifactRef;
                node._ndlArtifactVersion = nodeDef.version ?? 'latest';
            }

            graph.addNode(node);
            nodeMap[nodeId] = node;
        }

        // Wire edges
        for (const edgeDef of source.edges) {
            const from = nodeMap[edgeDef.from];
            const to = nodeMap[edgeDef.to];
            if (from && to) {
                graph.addEdge(from, to, isNDL ? (edgeDef.config ?? {}) : {});
            } else {
                console.warn(`[Graph] Edge skipped — missing node:`, edgeDef);
            }
        }

        if (isNDL) {
            const resolver = options.secretsResolver || (library && typeof library.resolveSecret === 'function' ? (k) => library.resolveSecret(k) : library?.secretsResolver);
            if (resolver) {
                await graph.injectSecrets(resolver);
            }
        }

        return graph;
    }

    constructor() {
        this.id = generateId();
        this.version = '1.0.0';
        this.metadata = {};
        this.nodes = {};
        this.edges = [];
        this.errors = new ErrorLog();
    }

    addNode(node) { this.nodes[node.id] = node; return this; }

    removeNode(id) {
        const node = this.nodes[id];
        if (node) {
            node.inputs.forEach(i => i.unsub());
            delete this.nodes[id];
            this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
        }
        return this;
    }

    addEdge(fromNode, toNode, mapping = {}) {
        toNode.connect(fromNode, mapping);
        this.edges.push({ from: fromNode.id, to: toNode.id, config: mapping });
        return this;
    }

    removeEdge(fromId, toId) {
        const f = this.nodes[fromId], t = this.nodes[toId];
        if (f && t) t.disconnect(f);
        this.edges = this.edges.filter(e => !(e.from === fromId && e.to === toId));
        return this;
    }

    async injectSecrets(resolverOrMap) {
        if (!resolverOrMap) return this;
        const resolve = typeof resolverOrMap === 'function'
            ? resolverOrMap
            : (key) => (resolverOrMap && key in resolverOrMap ? resolverOrMap[key] : (typeof process !== 'undefined' ? process.env[key] : undefined));

        for (const node of Object.values(this.nodes)) {
            if (!node.state) continue;
            for (const [key, val] of Object.entries(node.state)) {
                if (typeof val === 'string') {
                    const m = val.match(/^(?:env:|secret:|@key:|@secret:)(.+)$/);
                    if (m) {
                        const secretKey = m[1].trim();
                        const resolved = await resolve(secretKey);
                        if (resolved !== undefined && resolved !== null) {
                            node.state[key] = resolved;
                        }
                    }
                }
            }
        }
        return this;
    }

    compute(rootInput = {}, rootState = {}, callback = () => { }) {
        const computed = new Set(), computing = new Set(), output = {};

        const computeNode = async (node) => {
            if (computed.has(node.id)) return;
            if (computing.has(node.id)) {
                const err = new Error(`[Graph] Circular dependency detected at node '${node.id}'`);
                this.errors.log('compute', err.message, { nodeId: node.id });
                throw err;
            }

            computing.add(node.id);

            const deps = node.inputs.map(i => this.nodes[i.refId]).filter(Boolean);
            for (const dep of deps) await computeNode(dep);

            await node.compute(rootInput, rootState, out => Object.assign(output, out));

            computed.add(node.id);
            computing.delete(node.id);
        };

        const hasDependents = new Set(this.edges.map(e => e.from));
        const sinks = Object.values(this.nodes).filter(n => !hasDependents.has(n.id));

        if (sinks.length === 0 && Object.keys(this.nodes).length > 0) {
            const err = new Error('[Graph] No sink nodes found — possible pure cycle');
            this.errors.log('compute', err.message, {});
            callback({ output: {}, state: rootState, error: err.message });
            return Promise.resolve();
        }

        return Promise.all(sinks.map(computeNode))
            .then(() => {
                callback({ output, state: rootState });
                return output;
            })
            .catch((error) => {
                this.errors.log('compute', error.message, {});
                callback({ output: {}, state: rootState, error: error.message });
            });
    }
}

/* ─── Library ────────────────────────────────────────────────────── */

function compareVersions(a, b) {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (aVal > bVal) return 1;
        if (aVal < bVal) return -1;
    }
    return 0;
}

class Library {
    constructor() {
        // { [id]: { [version]: artifactDefinition } }
        this.artifacts = {};
        this.errors = new ErrorLog();
        this.secretsResolver = null;
    }

    setSecretsResolver(fn) {
        this.secretsResolver = typeof fn === 'function' ? fn : null;
        return this;
    }

    async resolveSecret(key) {
        if (this.secretsResolver) {
            try {
                const val = await this.secretsResolver(key);
                if (val !== undefined && val !== null) return val;
            } catch (err) {
                this.errors.log('resolveSecret', err.message, { key });
            }
        }
        return typeof process !== 'undefined' ? process.env[key] : undefined;
    }

    // Store a raw artifact definition (not an instance)
    addArtifact(definition) {
        const id = definition.id;
        const version = definition.version || '1.0.0';
        if (!id) { this.errors.log('addArtifact', 'Missing id', { definition }); return this; }
        this.artifacts[id] = this.artifacts[id] ?? {};
        this.artifacts[id][version] = { ...definition, id, version };
        return this;
    }

    getArtifact(id, version = 'latest') {
        const versions = this.artifacts[id];
        if (!versions) { this.errors.log('getArtifact', 'Not found', { id }); return null; }
        if (version === 'latest') {
            const keys = Object.keys(versions).sort(compareVersions);
            version = keys[keys.length - 1];
        }
        return versions[version] ?? null;
    }

    // Instantiate on demand — returns a live Process or Graph, never a raw definition
    async getInstance(id, version = 'latest') {
        const definition = this.getArtifact(id, version);
        if (!definition) return null;
        try {
            if (definition.artifactType === 'process') {
                return await Process.fromArtifact(definition);
            } else if (definition.artifactType === 'graph') {
                const graph = await Graph.fromArtifact(definition, this);
                if (graph && (this.secretsResolver || typeof this.resolveSecret === 'function')) {
                    await graph.injectSecrets(k => this.resolveSecret(k));
                }
                return graph;
            }
            this.errors.log('getInstance', 'Unknown artifactType', { id, artifactType: definition.artifactType });
            return null;
        } catch (err) {
            this.errors.log('getInstance', err.message, { id });
            return null;
        }
    }

    removeArtifact(id, version = null) {
        if (!this.artifacts[id]) return this;
        if (version) {
            delete this.artifacts[id][version];
            if (!Object.keys(this.artifacts[id]).length) delete this.artifacts[id];
        } else {
            delete this.artifacts[id];
        }
        return this;
    }

    has(id) { return id in this.artifacts; }

    list() {
        return Object.entries(this.artifacts).flatMap(([id, versions]) =>
            Object.keys(versions).map(version => ({ id, version }))
        );
    }
}

/* ─── Port mapping helper ────────────────────────────────────────── */

function applyMapping(data, mapping) {
    if (!mapping || !Object.keys(mapping).length) return data;
    // Additive: unmapped keys pass through, mapped keys are renamed
    const renamed = {};
    Object.entries(mapping).forEach(([src, tgt]) => {
        if (src in data) renamed[tgt] = data[src];
    });
    return { ...data, ...renamed };
}

function stripPrivate(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(
        Object.entries(obj).filter(([k]) => !k.startsWith('_'))
    );
}

/* ─── System factory ─────────────────────────────────────────────── */

function createNodaicSystem(config = {}) {
    const library = new Library();
    return {
        library,
        // Programmatic use only — not for artifact registration
        createProcess: (fn, processConfig) => new Process(fn, processConfig),
        createNode: (content) => new Node(content),
        createGraph: () => new Graph(),
        // Artifact lifecycle
        addArtifact: (definition) => library.addArtifact(definition),
        getInstance: (id, version) => library.getInstance(id, version),
        // NDL
        parseNDL,
        toNDL,
        stripPrivate,
    };
}

/* ─── Export ─────────────────────────────────────────────────────── */

const NodaicExports = {
    Observable, Process, Node, Graph, Library, ErrorLog,
    generateId, compareVersions, applyMapping, stripPrivate,
    parseNDL, toNDL,
    createNodaicSystem
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = NodaicExports;
}

// Global for browser compatibility if needed
if (typeof window !== 'undefined') {
    window.Nodaic = NodaicExports;
}