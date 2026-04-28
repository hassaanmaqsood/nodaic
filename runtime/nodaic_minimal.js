/**
 * nodaic_minimal.js — minimal runtime
 * Observable → Process → Node → Graph → Library
 * v3.1.0 — Universal edition (Node.js + Cloudflare)
 */

/* ─── Utilities ──────────────────────────────────────────────────── */

function generateId() {
    return Math.random().toString(36).slice(2, 10);
}

/* ─── Observable ─────────────────────────────────────────────────── */

class Observable {
    constructor(value = null) {
        this.value = value;
        this.listeners = {};
    }

    subscribe(id, fn) {
        this.listeners[id] = fn;
        return () => delete this.listeners[id];
    }

    update(value) {
        this.value = value;
        Object.values(this.listeners).forEach(fn => fn(value));
    }
}

class ErrorLog {
    constructor() { this.errors = []; }

    log(context, message, details = {}) {
        this.errors.push({ timestamp: Date.now(), context, message, details });
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
    // Static loader registry — keyed by sourceType string
    static loaders = {
        // load complied functions/applications directly
        'application/javascript': async (source) => {
            return new Function('input', 'state', 'returnCallback', source);
        },
        // Inline JS function body as a string - least recommended
        'text/javascript': async (source) => {
            return new Function('input', 'state', 'returnCallback', source);
        },
        // Remote URL — fetch text, compile with new Function
        'url': async (source) => {
            const res = await fetch(source);
            const code = await res.text();
            return new Function('input', 'state', 'returnCallback', code);
        },
    };

    // Platform or user adds their own loader
    static addLoader(sourceType, loaderFn) {
        Process.loaders[sourceType] = loaderFn;
    }

    // Create a Process from a full artifact definition object
    static async fromArtifact(definition) {
        const loader = Process.loaders[definition.sourceType];
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

    constructor(fn = null) {
        this.fn = fn || ((input, state, cb) => cb({ output: input, state }));
        this.errors = new ErrorLog();
        this.id = null;
        this.version = null;
        this.metadata = {};
        this.interface = { inputs: {}, outputs: {} };
    }

    compute(input, state, callback) {
        try {
            this.fn(input, state, (result) => {
                if (state.signal?.aborted) return;
                callback({ output: result?.output ?? {}, state: result?.state ?? state });
            });
        } catch (err) {
            this.errors.log('compute', err.message, { input });
            callback({ output: {}, state });
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

        if (!trimmed) { currentNode = null; continue; }

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
            const val = (typeof savedPreset[key] === 'string' && savedPreset[key].startsWith('env:'))
                ? savedPreset[key]
                : liveState[key];
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
        lines.push(`${left} -> ${right}`);
    }

    return lines.join('\n');
}

function ndlSerializeValue(val) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'boolean') return String(val);
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

        const merged = Object.assign({}, ...this.inputs.map(i => i.data || {}), rootInput);

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
        'url': async (source) => {
            const res = await fetch(source);
            const ct = res.headers.get('content-type') ?? '';
            return ct.includes('json') ? res.json() : parseNDL(await res.text());
        },
    };

    static addLoader(sourceType, loaderFn) {
        Graph.loaders[sourceType] = loaderFn;
    }

    static async fromArtifact(definition, library = null) {
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

        return graph;
    }

    constructor() {
        this.nodes = {};
        this.edges = [];
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

    compute(rootInput = {}, rootState = {}, callback = () => { }) {
        const computed = new Set(), computing = new Set(), output = {};

        const computeNode = async (node) => {
            if (computed.has(node.id)) return;
            if (computing.has(node.id)) {
                console.warn('[Graph] Circular dependency:', node.id);
                computed.add(node.id);
                return;
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
        const targets = sinks.length ? sinks : Object.values(this.nodes);

        return Promise.all(targets.map(computeNode)).then(() => {
            callback({ output, state: rootState });
            return output;
        });
    }
}

/* ─── Library ────────────────────────────────────────────────────── */

class Library {
    constructor() {
        // { [id]: { [version]: artifactDefinition } }
        this.artifacts = {};
        this.errors = new ErrorLog();
    }

    // Store a raw artifact definition (not an instance)
    addArtifact(definition) {
        const id = definition.id;
        const version = definition.version || '1.0.0';
        if (!id) { this.errors.log('addArtifact', 'Missing id', { definition }); return this; }
        this.artifacts[id] = this.artifacts[id] ?? {};
        if (this.artifacts[id][version]) {
            this.errors.log('addArtifact', 'Version collision', { id, version });
            return this;
        }
        this.artifacts[id][version] = { ...definition, id, version };
        return this;
    }

    getArtifact(id, version = 'latest') {
        const versions = this.artifacts[id];
        if (!versions) { this.errors.log('getArtifact', 'Not found', { id }); return null; }
        if (version === 'latest') {
            const keys = Object.keys(versions).sort();
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
                return await Graph.fromArtifact(definition, this);
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
    const result = {};
    Object.entries(mapping).forEach(([src, tgt]) => {
        if (src in data) result[tgt] = data[src];
    });
    return result;
}

function stripPrivate(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(
        Object.entries(obj).filter(([k]) => !k.startsWith('_'))
    );
}

/* ─── System factory ─────────────────────────────────────────────── */

function createNodaicSystem() {
    const library = new Library();
    return {
        library,
        // Programmatic use only — not for artifact registration
        createProcess: (fn) => new Process(fn),
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
    Observable, Process, Node, Graph, Library,
    generateId, applyMapping, stripPrivate,
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