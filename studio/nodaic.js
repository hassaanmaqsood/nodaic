/**
 * Nodaic v2: Callback-Only + Complete Port Mapping
 * 
 * ARCHITECTURE:
 * - Callback-only compute (no race conditions)
 * - Advanced port mapping with validation
 * - Type checking and compatibility
 * - Wildcard and pattern matching
 * - Transform functions
 * - Aggregation modes
 * - Fluent builder API
 * 
 * ROADMAP:
 * - Call update on the changed output variables
 * - Dynamic port mapping like in control systems
 */

/* ========================================= */
/* ============ ERROR LOGGING ============== */
/* ========================================= */

class ErrorLog {
    constructor() {
        this.errors = [];
    }

    log(context, message, details = {}) {
        this.errors.push({
            timestamp: Date.now(),
            context,
            message,
            details,
            id: `${context}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        });
    }

    get(context = null) {
        return context
            ? this.errors.filter(e => e.context === context)
            : [...this.errors];
    }

    clear(context = null) {
        if (context) {
            this.errors = this.errors.filter(e => e.context !== context);
        } else {
            this.errors = [];
        }
    }

    has(context = null) {
        return context
            ? this.errors.some(e => e.context === context)
            : this.errors.length > 0;
    }

    getLatest(context = null, count = 5) {
        const filtered = context
            ? this.errors.filter(e => e.context === context)
            : this.errors;
        return filtered.slice(-count);
    }
}

/* ========================================= */
/* ============ PORT SYSTEM ================ */
/* ========================================= */

/**
 * Port type definitions and validators
 */
class PortTypes {
    static ANY = 'any';
    static STRING = 'string';
    static NUMBER = 'number';
    static BOOLEAN = 'boolean';
    static OBJECT = 'object';
    static ARRAY = 'array';
    static FUNCTION = 'function';

    static validators = {
        any: () => true,
        string: (val) => typeof val === 'string',
        number: (val) => typeof val === 'number' && !isNaN(val),
        boolean: (val) => typeof val === 'boolean',
        object: (val) => typeof val === 'object' && val !== null && !Array.isArray(val),
        array: (val) => Array.isArray(val),
        function: (val) => typeof val === 'function'
    };

    static validate(value, type) {
        const validator = this.validators[type] || this.validators.any;
        return validator(value);
    }

    static isCompatible(sourceType, targetType) {
        if (sourceType === this.ANY || targetType === this.ANY) {
            return true;
        }

        if (sourceType === targetType) {
            return true;
        }

        if (sourceType === this.NUMBER && targetType === this.STRING) {
            return true;
        }

        if (sourceType === this.BOOLEAN && targetType === this.STRING) {
            return true;
        }

        if (sourceType === this.ARRAY && targetType === this.OBJECT) {
            return true;
        }

        return false;
    }
}

/**
 * Port mapping with validation and transformation
 */
class PortMapping {
    constructor(config = {}) {
        this.sourcePort = config.sourcePort || '*';
        this.targetPort = config.targetPort;
        this.transformFn = config.transform;
        this.expectedType = config.expectedType;
        this.defaultValue = config.defaultValue;
        this.validateTypes = config.validateTypes !== false;
        this.pattern = config.pattern ? new RegExp(config.pattern) : null;
        this.aggregate = config.aggregate; // 'merge', 'array', 'first', 'last'
    }

    matches(portId) {
        if (this.sourcePort === '*') return true;
        if (this.pattern) return this.pattern.test(portId);
        return this.sourcePort === portId;
    }

    transform(value, context = {}) {
        if (value === undefined && this.defaultValue !== undefined) {
            value = this.defaultValue;
        }

        if (this.transformFn && typeof this.transformFn === 'function') {
            try {
                return this.transformFn(value, context.sourceData, context.targetData);
            } catch (error) {
                console.error('Port mapping transform error:', error);
                return value;
            }
        }

        return value;
    }

    validate(value) {
        if (!this.validateTypes || !this.expectedType) {
            return { valid: true };
        }

        const valid = PortTypes.validate(value, this.expectedType);
        return {
            valid,
            error: valid ? null : `Expected type ${this.expectedType}, got ${typeof value}`
        };
    }
}

/**
 * Port mapping builder for fluent API
 */
class PortMappingBuilder {
    constructor() {
        this.mappings = [];
    }

    map(sourcePort, targetPort) {
        this.mappings.push(new PortMapping({ sourcePort, targetPort }));
        return this;
    }

    mapTransform(sourcePort, targetPort, transformFn) {
        this.mappings.push(new PortMapping({
            sourcePort,
            targetPort,
            transform: transformFn
        }));
        return this;
    }

    mapTyped(sourcePort, targetPort, expectedType) {
        this.mappings.push(new PortMapping({
            sourcePort,
            targetPort,
            expectedType
        }));
        return this;
    }

    mapDefault(sourcePort, targetPort, defaultValue) {
        this.mappings.push(new PortMapping({
            sourcePort,
            targetPort,
            defaultValue
        }));
        return this;
    }

    mapPattern(pattern, targetPort, aggregate = 'merge') {
        this.mappings.push(new PortMapping({
            pattern,
            targetPort,
            aggregate
        }));
        return this;
    }

    mapAll() {
        this.mappings.push(new PortMapping({ sourcePort: '*' }));
        return this;
    }

    build() {
        return this.mappings;
    }
}

/* ========================================= */
/* ============== UTILITIES ================ */
/* ========================================= */

function getDataByPath(path = "/", item = {}) {
    return path.split("/").filter(Boolean).reduce((acc, key) => acc?.[key], item);
}

function setDataByPath(path = "/", obj = {}, value) {
    const keys = path.split("/").filter(Boolean);
    let ref = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        ref = ref[keys[i]] ??= {};
    }
    keys.length ? ref[keys.at(-1)] = value : Object.assign(obj, value);

    return obj;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function hashObject(obj) {
    const str = JSON.stringify(obj);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

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

function sortVersions(versions) {
    return versions.slice().sort(compareVersions);
}

/* ========================================= */
/* ============== OBSERVABLE =============== */
/* ========================================= */

class Observable {
    constructor(initialValue = {}) {
        this.listeners = {};
        this.value = initialValue;
    }

    _normalizePath(path) {
        return path.split("/").filter(Boolean).join("/");
    }

    addListener(listener, path = "/", listenerType = "default") {
        if (typeof listener !== "function") {
            throw new Error("Listener must be a function");
        }

        path = this._normalizePath(path);
        this.listeners[path] = this.listeners[path] || {};
        this.listeners[path][listenerType] = this.listeners[path][listenerType] || [];
        this.listeners[path][listenerType].push(listener);

        return this;
    }

    removeListener(listener, path = "/", listenerType = "default") {
        path = this._normalizePath(path);
        const listeners = this.listeners?.[path]?.[listenerType];

        if (listeners) {
            this.listeners[path][listenerType] = listeners.filter(l => l !== listener);
            if (!this.listeners[path][listenerType].length) {
                delete this.listeners[path][listenerType];
            }
            if (!Object.keys(this.listeners[path]).length) {
                delete this.listeners[path];
            }
        }

        return this;
    }

    getValue(path = "/") {
        return getDataByPath(this._normalizePath(path), this.value);
    }

    setValue(newValue, path = "/", listenerTypes = ["default"]) {
        path = this._normalizePath(path);
        const oldValue = structuredClone(this.value);

        const typesToNotify = Array.isArray(listenerTypes) ? listenerTypes : [listenerTypes];

        if (!path || path === '') {
            setDataByPath('/', this.value, newValue);

            typesToNotify.forEach((listenerType) => {
                this.listeners?.['']?.[listenerType]?.forEach(callback => {
                    callback(this.value, oldValue, '/');
                });
            });

            return this;
        }

        path.split('/').reverse().forEach((key, index, array) => {
            const dataPath = array.slice(index, array.length).reverse().join('/');

            if (index === 0) {
                setDataByPath(dataPath, this.value, newValue);
            }

            const initialData = getDataByPath(dataPath, oldValue);
            const finalData = getDataByPath(dataPath, this.value);

            typesToNotify.forEach((listenerType) => {
                this.listeners?.[dataPath]?.[listenerType]?.forEach(callback => {
                    callback(finalData, initialData, path);
                });
            });
        });

        return this;
    }
}

/* ========================================= */
/* ============ RUNTIME ENGINE ============= */
/* ========================================= */

/* --- PROCESS --- */

class Process {
    static loaders = {
        'text/javascript': async (source) => {
            return new Function('input', 'state', 'returnCallback', source);
        },
        'application/javascript': async (source) => {
            return eval(source);
        },
        'text/json': async (source) => {
            const data = typeof source === 'string' ? JSON.parse(source) : source;
            return funcFromFJSON(data);
        },
        'url': async (source) => {
            try {
                const response = await fetch(source);
                const code = await response.text();
                return new Function('input', 'state', 'returnCallback', code);
            } catch (error) {
                throw new Error(`Failed to fetch from URL: ${error.message}`);
            }
        }
    };

    static addLoader(sourceType, loader) {
        Process.loaders[sourceType] = loader;
    }

    static async fromArtifact(definition, library = null) {
        const loader = Process.loaders[definition.sourceType];

        if (!loader) {
            const error = new Error(`No loader for sourceType: ${definition.sourceType}`);
            console.error('Process.fromArtifact error:', error.message, { definition });
            return null;
        }

        try {
            const loadedFunc = await loader(definition.source);
            const process = new Process(loadedFunc, { library, artifactId: definition.id });

            process.metadata = definition.metadata || {};
            process.interface = definition.interface || { inputs: {}, outputs: {} };
            process.version = definition.version;
            process.id = definition.id;

            return process;
        } catch (error) {
            console.error('Process.fromArtifact error:', error.message, {
                artifactId: definition.id,
                sourceType: definition.sourceType
            });
            return null;
        }
    }

    static fromJSON(data, library = null) {
        const func = funcFromFJSON(data);
        return new Process(func, { library });
    }

    constructor(func = null, config = {}) {
        const { library = null, artifactId = null } = config;

        this.func = func || ((input, state, returnCallback) => {
            returnCallback({ output: input, state });
        });

        this.errors = new ErrorLog();
        this._library = library;
        this._artifactId = artifactId;
        this.metadata = {};
        this.interface = { inputs: {}, outputs: {} };
        this.version = null;
        this.id = null;
    }

    getType() {
        return 'process';
    }

    /**
     * CALLBACK-ONLY COMPUTE
     * No Promise resolution, no setTimeout, no race conditions
     */
    compute(input = {}, state = {}, returnCallback = () => { }) {
        try {
            this.func(input, state, (result) => {
                // Optional: Don't callback if we are already aborted?
                if (state.signal && state.signal.aborted) return;

                returnCallback({
                    output: result?.output || {},
                    state: result?.state || state
                });
            });
        } catch (error) {
            this.errors.log('compute', 'Process execution failed', {
                error: error.message,
                input,
                state
            });
            returnCallback({ output: {}, state });
        }
    }

    update(newFunc) {
        return new Process(newFunc, {
            library: this._library,
            artifactId: this._artifactId
        });
    }

    toJSON() {
        return funcToFJSON(this.func);
    }
}

/* --- Function Serialization --- */

function funcToFJSON(func) {
    if (typeof func !== "function") {
        return { functionBody: '', functionArgs: [], functionName: 'anonymous' };
    }

    const funcString = func.toString().trim();
    const functionName = func.name || "anonymous";

    let functionArgs = [];
    const argsRegex = /\(([^)]*)\)/;
    const argsMatch = funcString.match(argsRegex);

    if (argsMatch) {
        functionArgs = argsMatch[1]
            .split(",")
            .map((arg) => arg.trim())
            .filter(Boolean);
    }

    let functionBody = null;
    if (funcString.includes("=>")) {
        const arrowBodyMatch = funcString.match(/=>\s*(.+)$/s);
        if (arrowBodyMatch) {
            functionBody = arrowBodyMatch[1].trim();
            if (!functionBody.startsWith("{")) {
                functionBody = `return ${functionBody};`;
            }
        }
    } else {
        const bodyRegex = /{([\s\S]*)}/;
        const bodyMatch = funcString.match(bodyRegex);
        if (bodyMatch) {
            functionBody = bodyMatch[1].trim();
        }
    }

    const parsedArgs = functionArgs.map((arg) => {
        const [name, defaultValue] = arg.split("=").map((part) => part.trim());
        const isRest = name.startsWith("...");
        return {
            name: isRest ? name.slice(3) : name,
            isRest,
            defaultValue: defaultValue || null,
            isDestructured: name.includes("{") || name.includes("["),
        };
    });

    return {
        functionName,
        functionArgs: parsedArgs,
        functionBody,
        isArrowFunction: funcString.includes("=>"),
        isAsync: funcString.startsWith("async"),
        isGenerator: funcString.startsWith("function*"),
    };
}

function funcFromFJSON(fjson) {
    if (!fjson || typeof fjson !== 'object') {
        throw new Error('Invalid fjson: must be an object');
    }

    if (!fjson.functionArgs || !Array.isArray(fjson.functionArgs)) {
        throw new Error('Invalid fjson: functionArgs must be an array');
    }

    if (typeof fjson.functionBody !== 'string') {
        throw new Error('Invalid fjson: functionBody must be a string');
    }

    const argNames = fjson.functionArgs.map((arg) => arg.name);
    const func = new Function(...argNames, fjson.functionBody);
    return fjson.isAsync ? async (...args) => func(...args) : func;
}

/* --- NODE --- */

class Node {
    constructor(content = null, config = {}) {
        const { library = null, autoCompute = false, id = null } = config;

        this.id = id || generateId();
        this.content = content;
        this.output = new Observable({});
        this.state = {};
        this.inputs = [];
        this.autoCompute = autoCompute;
        this.errors = new ErrorLog();
        this._library = library;

        // Port metadata
        this.inputPorts = {};
        this.outputPorts = {};

        // Track the active abort controller
        this.abortController = null;
    }

    getType() {
        const hasInputs = this.inputs.length > 0;
        const hasOutputs = Object.keys(this.output.getValue()).length > 0;

        if (!hasInputs && !hasOutputs) return 2; // isolated
        if (hasInputs && !hasOutputs) return 1;   // sink
        if (!hasInputs && hasOutputs) return 0;   // source
        return -1;                                 // intermediate
    }

    /**
     * Define input ports with metadata
     */
    defineInputs(ports) {
        if (Array.isArray(ports)) {
            ports.forEach(port => {
                this.inputPorts[port.id] = {
                    label: port.label || port.id,
                    type: port.type || PortTypes.ANY,
                    description: port.description || '',
                    required: port.required !== false
                };
            });
        } else if (typeof ports === 'object') {
            this.inputPorts = ports;
        }
        return this;
    }

    /**
     * Define output ports with metadata
     */
    defineOutputs(ports) {
        if (Array.isArray(ports)) {
            ports.forEach(port => {
                this.outputPorts[port.id] = {
                    label: port.label || port.id,
                    type: port.type || PortTypes.ANY,
                    description: port.description || ''
                };
            });
        } else if (typeof ports === 'object') {
            this.outputPorts = ports;
        }
        return this;
    }

    /**
     * Connect with advanced port mapping
     */
    connect(sourceNode, config = {}) {
        const existingInput = this.inputs.find(i => i.refID === sourceNode.id);
        if (existingInput) {
            console.warn(`Node ${this.id} is already connected to ${sourceNode.id}`);
            if (config && Object.keys(config).length > 0) {
                existingInput.mappingConfig = this._normalizeMappingConfig(config);
            }
            return this;
        }

        const input = {
            refID: sourceNode.id,
            mappingConfig: this._normalizeMappingConfig(config),
            data: sourceNode.output.getValue(),
            onUpdate: (data) => {
                input.data = data;
                if (this.autoCompute) {
                    this.compute();
                }
            },
            removeListener: () => sourceNode.output.removeListener(input.onUpdate),
        };

        sourceNode.output.addListener(input.onUpdate);
        this.inputs.push(input);

        return this;
    }

    /**
     * Normalize mapping config to standard format
     */
    _normalizeMappingConfig(config) {
        // Handle PortMappingBuilder
        if (config instanceof PortMappingBuilder) {
            return config.build();
        }

        // Handle array of PortMapping objects
        if (Array.isArray(config)) {
            return config.map(c => c instanceof PortMapping ? c : new PortMapping(c));
        }

        // Handle simple object map { sourcePort: targetPort }
        if (config && typeof config === 'object' && !config.sourcePort) {
            return Object.entries(config).map(([source, target]) =>
                new PortMapping({ sourcePort: source, targetPort: target })
            );
        }

        // Handle single PortMapping config
        if (config && typeof config === 'object') {
            return [new PortMapping(config)];
        }

        // Default: passthrough all ports
        return [new PortMapping({ sourcePort: '*' })];
    }

    /**
     * Apply port mappings with validation and transformation
     */
    _applyPortMappings(sourceData, mappings) {
        const result = {};
        const validationErrors = [];
        const mappedSources = new Set();

        for (const mapping of mappings) {
            const matchedPorts = Object.keys(sourceData).filter(port =>
                mapping.matches(port)
            );

            for (const sourcePort of matchedPorts) {
                const value = sourceData[sourcePort];
                const targetPort = mapping.targetPort || sourcePort;

                // Validate type if needed
                if (mapping.validateTypes) {
                    const validation = mapping.validate(value);
                    if (!validation.valid) {
                        validationErrors.push({
                            sourcePort,
                            targetPort,
                            error: validation.error
                        });
                        continue;
                    }
                }

                // Apply transformation
                const transformedValue = mapping.transform(value, {
                    sourceData,
                    targetData: result
                });

                // Handle aggregation for multiple matches
                if (mapping.aggregate && result[targetPort] !== undefined) {
                    switch (mapping.aggregate) {
                        case 'merge':
                            if (typeof result[targetPort] === 'object' && typeof transformedValue === 'object') {
                                result[targetPort] = { ...result[targetPort], ...transformedValue };
                            }
                            break;
                        case 'array':
                            if (!Array.isArray(result[targetPort])) {
                                result[targetPort] = [result[targetPort]];
                            }
                            result[targetPort].push(transformedValue);
                            break;
                        case 'first':
                            break;
                        case 'last':
                            result[targetPort] = transformedValue;
                            break;
                        default:
                            result[targetPort] = transformedValue;
                    }
                } else {
                    result[targetPort] = transformedValue;
                }

                mappedSources.add(sourcePort);
            }
        }

        // Log validation errors
        if (validationErrors.length > 0) {
            this.errors.log('portMapping', 'Port validation errors', { validationErrors });
        }

        return result;
    }

    disconnect(sourceNode) {
        const input = this.inputs.find((i) => i.refID === sourceNode.id);

        if (input) {
            input.removeListener();
            this.inputs = this.inputs.filter((i) => i !== input);
        }

        return this;
    }

    /**
     * CALLBACK-ONLY COMPUTE with advanced port mapping
     */
    compute(rootInput = {}, rootState = {}, returnCallback = () => { }) {
        if (!this.content) {
            this.errors.log('compute', 'No content (process/graph) attached to node', {
                nodeId: this.id
            });
            returnCallback({});
            return Promise.resolve();
        }

        // Reset controller for new run
        if (this.abortController) {
            this.abortController.abort("Restarting");
        }
        this.abortController = new AbortController();
        const signal = this.abortController.signal; // <--- The signal we will pass

        return new Promise((resolve) => {
            // Apply advanced port mappings when aggregating inputs
            const input = this.inputs.reduce((acc, connection) => {
                const rawData = connection.data || {};
                const mappedData = this._applyPortMappings(rawData, connection.mappingConfig);

                if (Object.keys(connection.mappingConfig || []).length > 0) {
                    /* console.log(`[Node ${this.id}] Port mapping:`, {
                        from: connection.refID,
                        rawData,
                        mappingConfig: connection.mappingConfig,
                        mappedData
                    }); */
                }

                return { ...acc, ...mappedData };
            }, { root: rootInput });

            /* console.log(`[Node ${this.id}] Final input:`, input); */

            const outputCallback = (result) => {
                const output = result?.output || {};
                const state = result?.state || this.state;

                if (output && Object.keys(output).length > 0) {
                    this.output.setValue(output);
                    /* console.log(`[Node ${this.id}] Output set:`, output); */
                }

                if (state) {
                    this.state = { ...this.state, ...state };
                }

                returnCallback(output);
                resolve();
            };

            try {
                if (this.content.getType() === 'process') {
                    this.content.compute(input, { ...this.state, root: rootState, signal }, outputCallback);
                } else if (this.content.getType() === 'graph') {
                    this.content.compute(input, { ...rootState, nodeState: this.state }, outputCallback);
                }
            } catch (error) {
                this.errors.log('compute', 'Node computation failed', {
                    error: error.message,
                    nodeId: this.id
                });
                outputCallback({ output: {}, state: this.state });
            }
        });
    }

    update(newContent) {
        this.content = newContent;
        return this;
    }

    /**
     * forcefully stop execution
     */
    stop() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * forcefully stop execution and remove all inputs and outputs
     */
    destroy() {
        if (this.abortController) {
            // Signal any running process to stop
            this.abortController.abort("Node removed");
            this.abortController = null;
        }

        // Existing cleanup logic can move here
        this.inputs.forEach(i => i.removeListener());
        this.output.listeners = {};
    }

    toJSON() {
        return {
            id: this.id,
            contentType: this.content?.getType() || null,
            artifactId: this.content?._artifactId || null,
            autoCompute: this.autoCompute,
            inputPorts: this.inputPorts,
            outputPorts: this.outputPorts
        };
    }

    static fromJSON(data, library = null) {
        const node = new Node(null, {
            id: data.id,
            library,
            autoCompute: data.autoCompute
        });

        if (data.inputPorts) {
            node.inputPorts = data.inputPorts;
        }

        if (data.outputPorts) {
            node.outputPorts = data.outputPorts;
        }

        return node;
    }
}

/* ========================================= */
/* ================ NDL ==================== */
/* ========================================= */

/**
 * NDL — Nodaic Declaration Language
 *
 * Parses a plain-text NDL string into the intermediate source object
 * expected by Graph.fromArtifact:
 *
 *   {
 *     nodes: {
 *       [nodeId]: { artifactRef, version, preset, staticInputs }
 *     },
 *     edges: [
 *       { from, fromPort, to, toPort, config }
 *     ]
 *   }
 *
 * Registered as sourceType "text/x-ndl" on Graph.loaders.
 * fromArtifact applies preset → node.state and passes edge config
 * to addEdge when this sourceType is detected.
 */

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

        // graph declaration — metadata only, not used by the runtime source object
        if (/^graph\s/.test(trimmed)) continue;

        const isIndented = line.startsWith(' ') || line.startsWith('\t');

        // node declaration (must be at column 0)
        if (/^node\s/.test(trimmed) && !isIndented) {
            const m = trimmed.match(/^node\s+(\S+)\s+@([^:\s]+)(?::(\S+))?/);
            if (!m) throw new Error(`[NDL] Invalid node declaration at line ${lineNumber}: "${trimmed}"`);

            currentNode = { artifactRef: m[2], version: m[3] || 'latest', preset: {}, staticInputs: {} };
            if (source.nodes[m[1]]) throw new Error(`[NDL] Duplicate node id "${m[1]}" at line ${lineNumber}`);
            source.nodes[m[1]] = currentNode;
            continue;
        }

        // indented directives — state and input
        if (isIndented && currentNode) {
            const stateM = trimmed.match(/^state\s+(\S+)\s*=\s*(.+)$/);
            if (stateM) { currentNode.preset[stateM[1]] = ndlParseValue(stateM[2].trim(), lineNumber); continue; }

            const inputM = trimmed.match(/^input\s+(\S+)\s*=\s*(.+)$/);
            if (inputM) { currentNode.staticInputs[inputM[1]] = ndlParseValue(inputM[2].trim(), lineNumber); continue; }

            continue; // unknown indented token — silently skip
        }

        // edge declaration
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

    // @map decorator: @map:"(v) => expr"
    let transformFn = null;
    const mapMatch = right.match(/@map:["'](.+?)["']\s*$/);
    if (mapMatch) {
        transformFn = mapMatch[1];
        right = right.slice(0, right.lastIndexOf('@map:')).trim();
    }

    const [from, fromPort] = ndlSplitPort(left);
    const [to, toPort] = ndlSplitPort(right);

    if (!from || !to) throw new Error(`[NDL] Invalid edge at line ${lineNumber}: "${line}"`);

    // Build the port mapping config object consumed by addEdge / _normalizeMappingConfig
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

    return raw; // bare string / env:VAR_NAME
}

/**
 * toNDL
 *
 * Serializes a live Graph back to an NDL string.
 * Reads node.state (the post-compute snapshot) for state directives.
 * Reads node._ndlStaticInputs for input directives.
 * Preserves env: references from node._ndlPreset rather than the resolved state value.
 *
 * @param  {Graph}  graph
 * @param  {object} options  — { author, omitInternalKeys }
 * @returns {string}
 */
function toNDL(graph, options = {}) {
    const { author = null, omitInternalKeys = true } = options;
    const SKIP = new Set(['signal', 'root', 'node']);
    const lines = [];

    // graph header
    let header = `graph ${graph.id || 'unnamed'}`;
    if (graph.version) header += ` @version:${graph.version}`;
    const resolvedAuthor = author || graph.metadata?.author;
    if (resolvedAuthor) header += ` @author:${resolvedAuthor}`;
    const envs = graph.metadata?.environments;
    if (envs?.length) header += ` @env:${envs.join(',')}`;
    lines.push(header, '');

    // nodes
    for (const node of Object.values(graph.nodes)) {
        const artifactId = node._ndlArtifactRef || node.content?._artifactId || 'unknown';
        const version = node._ndlArtifactVersion || node.content?.version;

        let nodeHeader = `node ${node.id} @${artifactId}`;
        if (version && version !== 'latest') nodeHeader += `:${version}`;
        lines.push(nodeHeader);

        // state — write from _ndlPreset for env: keys, from node.state for the rest
        const liveState = node.state || {};
        const savedPreset = node._ndlPreset || {};

        const allKeys = new Set([...Object.keys(savedPreset), ...Object.keys(liveState)]);
        for (const key of allKeys) {
            if (omitInternalKeys && (key.startsWith('_') || SKIP.has(key))) continue;
            // prefer the saved env: reference over the resolved live value
            const val = (typeof savedPreset[key] === 'string' && savedPreset[key].startsWith('env:'))
                ? savedPreset[key]
                : liveState[key];
            if (val !== undefined) lines.push(`  state ${key} = ${ndlSerializeValue(val)}`);
        }

        // static inputs
        const staticInputs = node._ndlStaticInputs || {};
        for (const [port, val] of Object.entries(staticInputs)) {
            lines.push(`  input ${port} = ${ndlSerializeValue(val)}`);
        }

        lines.push('');
    }

    // edges
    for (const edge of graph.edges) {
        const config = edge.config || {};
        const fromPort = config.sourcePort && config.sourcePort !== '*' ? config.sourcePort : null;
        const toPort = config.targetPort || null;

        const left = fromPort ? `${edge[0]}.${fromPort}` : edge[0];
        const right = toPort ? `${edge[1]}.${toPort}` : edge[1];
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

/* --- GRAPH --- */

class Graph {
    static loaders = {
        'application/json': async (source) => {
            return typeof source === 'string' ? JSON.parse(source) : source;
        },
        'text/json': async (source) => {
            return typeof source === 'string' ? JSON.parse(source) : source;
        },
        'url': async (source) => {
            try {
                const response = await fetch(source);
                return await response.json();
            } catch (error) {
                throw new Error(`Failed to fetch graph from URL: ${error.message}`);
            }
        },
        'text/x-ndl': async (source) => parseNDL(source)
    };

    static addLoader(sourceType, loader) {
        Graph.loaders[sourceType] = loader;
    }

    static async fromArtifact(definition, library = null) {
        const loader = Graph.loaders[definition.sourceType];

        if (!loader) {
            const error = new Error(`No loader for sourceType: ${definition.sourceType}`);
            console.error('Graph.fromArtifact error:', error.message, { definition });
            return null;
        }

        try {
            const source = await loader(definition.source);
            const isNDL = definition.sourceType === 'text/x-ndl';
            const loadedGraph = new Graph({ library, artifactId: definition.id });

            for (const nodeId in source.nodes) {
                const nodeDef = source.nodes[nodeId];
                const node = new Node(null, { id: nodeId, library });

                if (nodeDef.artifactRef && library) {
                    const instance = await library.getInstance(nodeDef.artifactRef, nodeDef.version);
                    if (instance) {
                        node.update(instance);
                    } else {
                        node.errors.log('fromArtifact', 'Failed to load referenced artifact', {
                            artifactRef: nodeDef.artifactRef
                        });
                    }
                }

                // NDL: hydrate state from preset and seed static inputs
                if (isNDL) {
                    if (nodeDef.preset && Object.keys(nodeDef.preset).length > 0) {
                        node.state = { ...nodeDef.preset };
                        node._ndlPreset = { ...nodeDef.preset };
                        node._ndlArtifactRef = nodeDef.artifactRef;
                        node._ndlArtifactVersion = nodeDef.version;
                    }
                    if (nodeDef.staticInputs && Object.keys(nodeDef.staticInputs).length > 0) {
                        node.output.setValue(nodeDef.staticInputs);
                        node._ndlStaticInputs = { ...nodeDef.staticInputs };
                    }
                }

                loadedGraph.addNode(node);
            }

            for (const edgeDef of source.edges) {
                const outputNode = loadedGraph.nodes[edgeDef.from];
                const inputNode = loadedGraph.nodes[edgeDef.to];

                if (outputNode && inputNode) {
                    // NDL: pass port mapping config; JSON path passes no config (unchanged)
                    loadedGraph.addEdge(outputNode, inputNode, isNDL ? (edgeDef.config || {}) : {});
                } else {
                    loadedGraph.errors.log('fromArtifact', 'Edge references missing node', {
                        edgeDef
                    });
                }
            }

            loadedGraph.metadata = definition.metadata || {};
            loadedGraph.interface = definition.interface || { inputs: {}, outputs: {} };
            loadedGraph.version = definition.version;
            loadedGraph.id = definition.id;

            return loadedGraph;
        } catch (error) {
            console.error('Graph.fromArtifact error:', error.message, {
                artifactId: definition.id
            });
            return null;
        }
    }

    static async fromJSON(data, library = null) {
        const newGraph = new Graph({ library });

        const nodePromises = [];

        for (const nodeId in data.nodes) {
            const nodeData = data.nodes[nodeId];
            const node = new Node(null, { id: nodeId, library });

            if (nodeData.artifactId && library) {
                const loadPromise = (async () => {
                    const artifact = library.getArtifact(nodeData.artifactId);
                    if (artifact) {
                        const instance = await library.getInstance(nodeData.artifactId);
                        node.update(instance);
                    } else {
                        node.errors.log('fromJSON', 'Referenced artifact not found', {
                            artifactId: nodeData.artifactId
                        });
                    }
                })();
                nodePromises.push(loadPromise);
            }

            newGraph.addNode(node);
        }

        await Promise.all(nodePromises);

        for (const edgeData of data.edges) {
            const from = Array.isArray(edgeData) ? edgeData[0] : edgeData.from;
            const to = Array.isArray(edgeData) ? edgeData[1] : edgeData.to;
            const config = Array.isArray(edgeData) ? {} : (edgeData.config || {});

            const outputNode = newGraph.nodes[from];
            const inputNode = newGraph.nodes[to];

            if (outputNode && inputNode) {
                newGraph.addEdge(outputNode, inputNode, config);
            } else {
                newGraph.errors.log('fromJSON', 'Edge references missing node', {
                    edge: { from, to }
                });
            }
        }

        return newGraph;
    }

    constructor(config = {}) {
        const { library = null, artifactId = null } = config;

        this.nodes = {};
        this.edges = [];
        this.errors = new ErrorLog();
        this._library = library;
        this._artifactId = artifactId;
        this.metadata = {};
        this.interface = { inputs: {}, outputs: {} };
        this.version = null;
        this.id = null;
    }

    getType() {
        return 'graph';
    }

    addNode(node) {
        this.nodes[node.id] = node;
        return this;
    }

    removeNode(nodeId) {
        const node = this.nodes[nodeId];
        if (node) {
            this.edges.filter(e => e[0] === nodeId || e[1] === nodeId)
                .forEach(edge => edge.disconnect?.());

            if (node.output) {
                node.output.listeners = {};
            }

            node.state = {};

            if (typeof node.destroy === 'function') {
                node.destroy();
            }

            delete this.nodes[nodeId];
        }
        return this;
    }

    addEdge(outputNode, inputNode, config = {}) {
        inputNode.connect(outputNode, config);

        const edge = [outputNode.id, inputNode.id];
        edge.config = config;
        edge.disconnect = () => {
            inputNode.disconnect(outputNode);
            this.edges = this.edges.filter(e => e !== edge);
        };

        this.edges.push(edge);
        return this;
    }

    removeEdge(outputNodeId, inputNodeId) {
        const edge = this.edges.find(e => e[0] === outputNodeId && e[1] === inputNodeId);
        if (edge) {
            edge.disconnect();
        }
        return this;
    }

    /**
     * CALLBACK-ONLY COMPUTE with clean async/await traversal
     */
    compute(rootInput = {}, rootState = {}, returnCallback = () => { }) {
        const computed = new Set();
        const computing = new Set();
        const output = {};
        const nodeStates = {};

        const signal = rootState.signal; // Capture the signal passed from the parent Node

        // If the parent signal aborts, we should stop the whole graph
        if (signal) {
            signal.addEventListener('abort', () => {
                // Forcefully stop all child nodes in this graph
                Object.values(this.nodes).forEach(node => {
                    if (node.abortController) node.abortController.abort();
                });
            });
        }

        const computeNode = async (node) => {
            if (signal?.aborted) return; // Don't start new nodes if aborted

            if (computed.has(node.id)) {
                return;
            }

            if (computing.has(node.id)) {
                this.errors.log('compute', 'Circular dependency detected', { nodeId: node.id });
                computed.add(node.id);
                return;
            }

            computing.add(node.id);

            const dependencies = node.inputs
                .map(input => this.nodes[input.refID])
                .filter(Boolean);

            for (const dep of dependencies) {
                await computeNode(dep);
            }

            await node.compute(rootInput, { ...rootState, signal }, (outputData) => {
                if (outputData && typeof outputData === 'object') {
                    Object.assign(output, outputData);
                }

                if (node.state && Object.keys(node.state).length > 0) {
                    nodeStates[node.id] = node.state;
                }
            });

            computed.add(node.id);
            computing.delete(node.id);
        };

        const sinkNodes = Object.values(this.nodes).filter((node) => {
            const type = node.getType();
            return type === 1 || type === 2;
        });

        if (sinkNodes.length === 0) {
            this.errors.log('compute', 'No sink or isolated nodes found', {});
            returnCallback({ output, state: rootState });
            return;
        }

        Promise.all(sinkNodes.map(sink => computeNode(sink)))
            .then(() => {
                const combinedState = {
                    ...rootState,
                    ...(Object.keys(nodeStates).length > 0 ? { nodeStates } : {})
                };
                returnCallback({ output, state: combinedState });
            })
            .catch((error) => {
                this.errors.log('compute', 'Graph computation failed', { error: error.message });
                returnCallback({ output, state: rootState });
            });
    }

    traverse(startNode, callback, onlyToSource = true) {
        const visited = new Set();

        const visit = (node) => {
            if (visited.has(node.id)) return;
            visited.add(node.id);

            if (node.inputs.length > 0 && onlyToSource) {
                node.inputs.forEach(input => {
                    const sourceNode = this.nodes[input.refID];
                    if (sourceNode) visit(sourceNode);
                });
            }

            callback(node);
        };

        visit(startNode);
        return this;
    }

    querySelectorAll(query) {
        const results = Object.values(this.nodes);
        const conditions = query.split(/\s+/).filter(Boolean);

        return conditions.reduce((filteredResults, condition) => {
            return filteredResults.filter((node) => {
                if (condition === "*") return true;

                const idMatch = condition.match(/#(\w+)/);
                if (idMatch && node.id !== idMatch[1]) return false;

                const typeMatch = condition.match(/\$(\w+)/);
                if (typeMatch) {
                    const expectedType = parseInt(typeMatch[1], 10);
                    if (node.getType() !== expectedType) return false;
                }

                const propertyMatch = condition.match(/\[(\w+)=([\w\s]+)\]/);
                if (propertyMatch) {
                    const [_, key, value] = propertyMatch;
                    if (node[key] != value) return false;
                }

                const connectionMatch = condition.match(/->(\w+)/);
                if (connectionMatch) {
                    const targetId = connectionMatch[1];
                    const connected = this.edges.some(e => e[0] === node.id && e[1] === targetId);
                    if (!connected) return false;
                }

                return true;
            });
        }, results);
    }

    querySelector(query) {
        const results = this.querySelectorAll(query);
        return results.length > 0 ? results[0] : null;
    }

    toJSON() {
        const data = {
            nodes: {},
            edges: []
        };

        for (const node of Object.values(this.nodes)) {
            data.nodes[node.id] = node.toJSON();
        }

        for (const edge of this.edges) {
            const edgeData = {
                from: edge[0],
                to: edge[1]
            };

            if (edge.config && Object.keys(edge.config).length > 0) {
                edgeData.config = edge.config;
            }

            data.edges.push(edgeData);
        }

        return data;
    }
}

/* ========================================= */
/* ========== ARTIFACT REGISTRY ============ */
/* ========================================= */

class Library {
    constructor(config = {}) {
        this.artifacts = config.artifacts || {};
        this.errors = new ErrorLog();
        this.author = config.author || 'unknown';
    }

    addArtifact(definition) {
        const id = definition.id || hashObject(definition);
        const version = definition.version || '1.0.0';

        this.artifacts[id] = this.artifacts[id] || {};

        if (this.artifacts[id][version]) {
            this.errors.log('addArtifact', 'Version collision', {
                id,
                version,
                message: `Version ${version} of Artifact ${id} already exists`
            });
            return this;
        }

        this.artifacts[id][version] = {
            ...definition,
            id,
            version,
            timestamp: Date.now()
        };

        return this;
    }

    removeArtifact(id, version = null) {
        if (version) {
            delete this.artifacts[id]?.[version];
            if (Object.keys(this.artifacts[id] || {}).length === 0) {
                delete this.artifacts[id];
            }
        } else {
            delete this.artifacts[id];
        }
        return this;
    }

    getArtifact(id, version = "latest") {
        if (!this.artifacts[id]) {
            this.errors.log('getArtifact', 'Artifact not found', { id, version });
            return null;
        }

        if (version === 'latest') {
            const versions = sortVersions(Object.keys(this.artifacts[id]));
            version = versions[versions.length - 1];
        }

        const artifact = this.artifacts[id][version];

        if (!artifact) {
            this.errors.log('getArtifact', 'Version not found', { id, version });
            return null;
        }

        return artifact;
    }

    async getInstance(id, version = "latest") {
        const definition = this.getArtifact(id, version);

        if (!definition) {
            return null;
        }

        try {
            if (definition.artifactType === "process") {
                return await Process.fromArtifact(definition, this);
            } else if (definition.artifactType === "graph") {
                return await Graph.fromArtifact(definition, this);
            } else {
                this.errors.log('getInstance', 'Unknown artifact type', {
                    id,
                    version,
                    artifactType: definition.artifactType
                });
                return null;
            }
        } catch (error) {
            this.errors.log('getInstance', 'Failed to create instance', {
                id,
                version,
                error: error.message
            });
            return null;
        }
    }

    listArtifacts(filter = {}) {
        const results = [];

        for (const id in this.artifacts) {
            for (const version in this.artifacts[id]) {
                const artifact = this.artifacts[id][version];

                let matches = true;
                if (filter.type && artifact.artifactType !== filter.type) matches = false;
                if (filter.author && artifact.metadata?.author !== filter.author) matches = false;
                if (filter.tags && !filter.tags.every(tag =>
                    artifact.metadata?.tags?.includes(tag))) matches = false;

                if (matches) results.push(artifact);
            }
        }

        return results;
    }

    exportLibrary(artifactIds = null) {
        const exported = {
            version: "1.0",
            artifacts: [],
            metadata: {
                exportedAt: new Date().toISOString(),
                exportedBy: this.author
            }
        };

        const idsToExport = artifactIds || Object.keys(this.artifacts);

        idsToExport.forEach(id => {
            if (this.artifacts[id]) {
                Object.values(this.artifacts[id]).forEach(artifact => {
                    exported.artifacts.push(artifact);
                });
            }
        });

        return exported;
    }

    importLibrary(exported) {
        if (exported.artifacts) {
            exported.artifacts.forEach(artifact => {
                this.addArtifact(artifact);
            });
        }
        return this;
    }

    commit(id, changes, message = "") {
        const artifact = this.getArtifact(id);
        if (!artifact) {
            this.errors.log('commit', 'Cannot commit: artifact not found', { id });
            return this;
        }

        const versions = sortVersions(Object.keys(this.artifacts[id]));
        const lastVersion = versions[versions.length - 1];
        const [major, minor, patch] = lastVersion.split('.').map(Number);
        const newVersion = `${major}.${minor}.${patch + 1}`;

        const newArtifact = {
            ...artifact,
            ...changes,
            version: newVersion,
            timestamp: Date.now(),
            commitMessage: message
        };

        this.addArtifact(newArtifact);
        return this;
    }

    fork(id, newId, version = "latest") {
        const artifact = this.getArtifact(id, version);
        if (!artifact) {
            this.errors.log('fork', 'Cannot fork: artifact not found', { id, version });
            return this;
        }

        const forked = {
            ...artifact,
            id: newId,
            version: "1.0.0",
            forkedFrom: { id, version },
            timestamp: Date.now()
        };

        this.addArtifact(forked);
        return this;
    }
}

/* ========================================= */
/* ========== BIDIRECTIONAL ACCESS ========= */
/* ========================================= */

function createNodaicSystem(config = {}) {
    const library = new Library(config.library || {});

    const createNode = (content = null, nodeConfig = {}) => {
        return new Node(content, { ...nodeConfig, library });
    };

    const createGraph = (graphConfig = {}) => {
        return new Graph({ ...graphConfig, library });
    };

    const createProcess = (func = null, processConfig = {}) => {
        return new Process(func, { ...processConfig, library });
    };

    return {
        library,
        createNode,
        createGraph,
        createProcess,

        // Helpers
        PortTypes,
        PortMapping,
        PortMappingBuilder,

        // NDL
        toNDL,
        parseNDL,

        loadArtifact: (id, version) => library.getInstance(id, version),
        saveArtifact: (definition) => library.addArtifact(definition),

        getErrors: (component = null) => {
            if (component === 'library') return library.errors.get();
            const allErrors = [...library.errors.get()];
            return allErrors;
        }
    };
}

/* ========================================= */
/* ================ EXPORT ================= */
/* ========================================= */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createNodaicSystem,
        Library,
        Graph,
        Node,
        Process,
        Observable,
        ErrorLog,
        PortTypes,
        PortMapping,
        PortMappingBuilder,
        toNDL,
        parseNDL,
        generateId,
        hashObject,
        compareVersions,
        sortVersions
    };
}

if (typeof window !== 'undefined') {
    window.Nodaic = {
        createNodaicSystem,
        Library,
        Graph,
        Node,
        Process,
        Observable,
        ErrorLog,
        PortTypes,
        PortMapping,
        PortMappingBuilder,
        toNDL,
        parseNDL,
        generateId,
        hashObject,
        compareVersions,
        sortVersions
    };
}