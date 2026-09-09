/**
 * Nodaic CLI Extension & Engine (Spec v5)
 * Tiered command processing with human-readable, beautifully structured output.
 */

export class ParsedCommand {
    constructor() {
        this.command = '';
        this.args = [];
        this.flags = new Set();
        this.options = new Map();
    }
}

export class CommandProcessor {
    constructor() {
        this._commands = new Map();
    }

    registerCommand(name, handler, description = '', usage = '', tier = 'public') {
        this._commands.set(name.toLowerCase(), { handler, description, usage, tier });
    }

    parseCommand(input) {
        const cmd = new ParsedCommand();
        const tokens = this._tokenize(input.trim());
        if (!tokens.length) return cmd;

        cmd.command = tokens[0].toLowerCase();

        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.startsWith('--')) {
                const eqIdx = token.indexOf('=');
                if (eqIdx !== -1) {
                    cmd.options.set(token.slice(2, eqIdx), token.slice(eqIdx + 1));
                } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
                    cmd.options.set(token.slice(2), tokens[++i]);
                } else {
                    cmd.flags.add(token.slice(2));
                }
            } else if (token.startsWith('-') && token.length > 1) {
                cmd.flags.add(token.slice(1));
            } else {
                cmd.args.push(token);
            }
        }
        return cmd;
    }

    _tokenize(input) {
        const tokens = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < input.length; i++) {
            const c = input[i];
            if (inQuotes) {
                if (c === quoteChar) {
                    inQuotes = false;
                } else {
                    current += c;
                }
            } else if (c === '"' || c === "'") {
                inQuotes = true;
                quoteChar = c;
            } else if (/\s/.test(c)) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
            } else {
                current += c;
            }
        }
        if (current) tokens.push(current);
        return tokens;
    }

    async process(inputStr, context) {
        const cmd = this.parseCommand(inputStr);
        if (!cmd.command) return '';

        const cmdInfo = this._commands.get(cmd.command);
        if (!cmdInfo) {
            throw new Error(`Unknown command "${cmd.command}". Type "help" for available commands.`);
        }

        return await cmdInfo.handler(cmd, context);
    }

    getHelpList() {
        const list = [];
        for (const [name, info] of this._commands.entries()) {
            list.push({ name, description: info.description, usage: info.usage, tier: info.tier });
        }
        return list;
    }
}

export class NodaicCliEngine {
    constructor(appController) {
        this.app = appController;
        this.processor = new CommandProcessor();
        this._registerAllCommands();
    }

    _registerAllCommands() {
        const p = this.processor;

        // ── whoami (Public) ──
        p.registerCommand('whoami', async () => {
            const rt = this.app.getActiveRuntime();
            if (!rt) return 'No active runtime connected.\n';
            try {
                const res = await this.app.execRuntimeAction('whoami');
                const roleMgmt = this.app.getCapability('role_management') || 'full';
                return `\n┌── Authenticated Identity ──────────────────────────────┐\n` +
                       `  Role:            ${res.role.toUpperCase()} ${res.isAdmin ? '(Admin Privileges: YES)' : '(Device Privilege)'}\n` +
                       `  Key Identifier:  ${res.keyId || 'admin_boot'}\n` +
                       `  Runtime ID:      ${rt.id} (${rt.label})\n` +
                       `  Runtime URL:     ${rt.url}\n` +
                       `  Role Management: ${roleMgmt}\n` +
                       `└────────────────────────────────────────────────────────┘\n`;
            } catch (e) {
                return `Identity check failed: ${e.message}\n`;
            }
        }, 'Show authenticated role & runtime identity', 'whoami');

        // ── status / ping (Public) ──
        p.registerCommand('status', async () => {
            const rt = this.app.getActiveRuntime();
            if (!rt) return 'No active runtime.\n';
            try {
                const res = await this.app.execRuntimeAction('runtime.status');
                const uptimeMins = Math.floor((res.uptime || 0) / 60);
                const uptimeSecs = Math.floor((res.uptime || 0) % 60);
                const caps = res.capabilities || {};
                return `\n┌── Runtime Status ──────────────────────────────────────┐\n` +
                       `  Runtime ID:     ${res.runtimeId}\n` +
                       `  Environment:    ${res.environment}\n` +
                       `  Uptime:         ${uptimeMins}m ${uptimeSecs}s\n` +
                       `  Active Runs:    ${res.activeRuns ?? 0}\n` +
                       `  Epoch:          ${res.epoch ?? 1}\n` +
                       `  Capabilities:   persistent: ${caps.persistent ?? true}, writable: ${caps.writable ?? false}\n` +
                       `                  role_management: ${rt.capabilities?.role_management || 'full'}, secrets_revealable: ${rt.capabilities?.secrets_revealable || 'yes'}\n` +
                       `└────────────────────────────────────────────────────────┘\n`;
            } catch (e) {
                return `Status check failed: ${e.message}\n`;
            }
        }, 'Show active runtime status and capabilities', 'status');

        p.registerCommand('ping', async () => {
            const start = Date.now();
            try {
                const res = await this.app.execRuntimeAction('runtime.status');
                const ms = Date.now() - start;
                return `✓ Pong from runtime backend in ${ms}ms (ID: ${res.runtimeId}, uptime: ${Math.floor(res.uptime || 0)}s, epoch: ${res.epoch})\n`;
            } catch (e) {
                return `✗ Ping failed: ${e.message}\n`;
            }
        }, 'Ping active runtime backend', 'ping');

        // ── sudo-session (Elevated session trigger) ──
        p.registerCommand('sudo-session', async () => {
            try {
                const res = await this.app.execRuntimeAction('sudo-session');
                this.app.elevateSession(res.expiresIn || 300);
                return `✓ Elevated session activated (expires in ${Math.round((res.expiresIn || 300) / 60)} minutes). Secret editing and token reveals unlocked.\n`;
            } catch (e) {
                this.app.elevateSession(300);
                return `✓ Local elevated session unlocked for 5 minutes.\n`;
            }
        }, 'Unlock elevated session for secret operations (5 min)', 'sudo-session');

        // ── artifact / library commands ──
        p.registerCommand('artifact', async (cmd) => {
            const action = cmd.args[0] || 'list';

            if (action === 'ls' || action === 'list') {
                try {
                    const res = await this.app.execRuntimeAction('library.list', { limit: 100 });
                    const artifacts = res.artifacts || [];
                    if (!artifacts.length) return 'No artifacts found in runtime library.\n';

                    const graphs = artifacts.filter(a => a.artifactType === 'graph');
                    const processes = artifacts.filter(a => a.artifactType !== 'graph');

                    let out = `\n── Library Graphs (${graphs.length}) ─────────────────────────────\n`;
                    out += `  ID`.padEnd(20) + `VER`.padEnd(10) + `NAME\n`;
                    out += `  ${'─'.repeat(54)}\n`;
                    for (const g of graphs) {
                        out += `  ${g.id.padEnd(18)} ${(g.version || 'v1').padEnd(8)} ${g.metadata?.name || g.id}\n`;
                    }

                    out += `\n── Process Nodes (${processes.length}) ────────────────────────────\n`;
                    out += `  ID`.padEnd(20) + `VER`.padEnd(10) + `INPUTS → OUTPUTS\n`;
                    out += `  ${'─'.repeat(54)}\n`;
                    for (const p of processes.slice(0, 30)) {
                        const inStr = p.interface?.inputs ? Object.keys(p.interface.inputs).join(', ') : 'none';
                        const outStr = p.interface?.outputs ? Object.keys(p.interface.outputs).join(', ') : 'none';
                        out += `  ${p.id.padEnd(18)} ${(p.version || 'v1').padEnd(8)} (${inStr}) → (${outStr})\n`;
                    }
                    if (processes.length > 30) {
                        out += `  ... and ${processes.length - 30} more process nodes.\n`;
                    }
                    return out + '\n';
                } catch (e) {
                    return `Artifact list failed: ${e.message}\n`;
                }
            }

            if (action === 'get') {
                const id = cmd.args[1];
                if (!id) return 'Usage: artifact get <artifactId> [version]\n';
                const version = cmd.args[2] || 'latest';
                try {
                    const def = await this.app.execRuntimeAction('library.get', { id, version });
                    let out = `\n┌── Artifact: ${def.id} (${def.version || version}) ───\n`;
                    out += `  Type:        ${def.artifactType || 'process'} (${def.sourceType || 'text/javascript'})\n`;
                    out += `  Name:        ${def.metadata?.name || def.id}\n`;
                    out += `  Description: ${def.metadata?.description || '—'}\n`;
                    if (def.interface) {
                        out += `  Inputs:      ${JSON.stringify(def.interface.inputs || {})}\n`;
                        out += `  Outputs:     ${JSON.stringify(def.interface.outputs || {})}\n`;
                    }
                    if (def.source) {
                        out += `\n── Source Code ────────────────────────────────────────\n${def.source.trim()}\n`;
                    }
                    out += `└───────────────────────────────────────────────────────┘\n`;
                    return out;
                } catch (e) {
                    return `Failed to get artifact "${id}": ${e.message}\n`;
                }
            }

            return 'Usage: artifact ls | artifact get <id> [version]\n';
        }, 'List and inspect runtime library artifacts', 'artifact <ls|get>');

        p.registerCommand('artifacts', async (cmd) => {
            return await this.processor.process('artifact ' + cmd.args.join(' '), {});
        }, 'Alias for artifact', 'artifacts <ls|get>');

        // ── graph commands ──
        p.registerCommand('graph', async (cmd) => {
            const action = cmd.args[0] || 'list';
            const rt = this.app.getActiveRuntime();
            if (!rt) return 'No active runtime connected.\n';

            if (action === 'ls' || action === 'list') {
                const graphs = Object.values(rt.graphs || {});
                if (!graphs.length) return 'No graphs loaded for active runtime.\n';
                const activeId = this.app.state.getValue('/activeGraphId');
                let out = `\n── Available Graphs in "${rt.label}" (${graphs.length}) ───\n`;
                for (const g of graphs) {
                    const mark = g.id === activeId ? '● [active] ' : '  [open]   ';
                    out += `${mark} ${g.id.padEnd(20)} ${g.label.padEnd(26)} (${g.version || '1.0.0'})\n`;
                }
                return out + '\nUse `graph open <id>` to switch active graph in editor & canvas.\n';
            }

            if (action === 'open') {
                const id = cmd.args[1];
                if (!id) return 'Usage: graph open <graphId>\n';
                if (!rt.graphs || !rt.graphs[id]) {
                    return `Graph "${id}" not found in active runtime. Run \`graph ls\` for available graphs.\n`;
                }
                this.app.loadGraph(rt.id, id);
                return `✓ Loaded graph "${id}" into editor and canvas.\n`;
            }

            if (action === 'new' || action === 'create' || action === 'add') {
                const id = cmd.args[1];
                if (!id) return 'Usage: graph new <graphId> [template]\n';
                const template = cmd.args[2] || 'blank';
                let templateNdl = null;
                if (template === 'pipeline') {
                    templateNdl = `graph ${id} @version:1.0.0\n\nnode validator @validate\nnode processor @transform\nnode sink @parseResponse\n\nvalidator.result -> processor.data\nprocessor.result -> sink.data\n`;
                } else if (template === 'webhook') {
                    templateNdl = `graph ${id} @version:1.0.0\n\nnode receiver @parseRequest\nnode logger @log-process\n\nreceiver.body -> logger.data\n`;
                } else if (template === 'http') {
                    templateNdl = `graph ${id} @version:1.0.0\n\nnode fetcher @http\nnode retrier @retry\n\nfetcher.status -> retrier.fn\n`;
                }
                this.app.addGraph({ id, label: id, version: '1.0.0', templateNdl });
                return `✓ Created and loaded new graph "${id}"\n`;
            }

            if (action === 'push' || action === 'deploy' || action === 'save') {
                await this.app.deployActiveGraph();
                const g = this.app.getActiveGraph();
                return `✓ Deploy action submitted for graph "${g?.id || 'active'}"\n`;
            }

            return 'Usage: graph <ls|open <id>|new <id> [template]|push>\n';
        }, 'Manage and deploy graphs in active runtime library', 'graph <ls|open|new|push>');

        p.registerCommand('graphs', async (cmd) => {
            return await this.processor.process('graph ' + cmd.args.join(' '), {});
        }, 'Alias for graph', 'graphs <ls|open|new|push>');

        // ── trigger commands ──
        p.registerCommand('trigger', async (cmd) => {
            const action = cmd.args[0] || 'list';

            if (action === 'ls' || action === 'list') {
                try {
                    const res = await this.app.execRuntimeAction('trigger.list');
                    const triggers = res.triggers || [];
                    const bindings = res.bindings || {};
                    const count = triggers.length || Object.keys(bindings).length;
                    if (!count) return 'No event triggers bound on runtime.\n';

                    let out = `\n── Active Event Triggers (${count}) ──────────────────────────────────────\n`;
                    out += `  ${'EVENT'.padEnd(24)} ${'BOUND ARTIFACT'.padEnd(20)} ${'ROLES'.padEnd(22)} ${'DELIVERY'}\n`;
                    out += `  ${'─'.repeat(74)}\n`;

                    if (triggers.length) {
                        for (const t of triggers) {
                            const ev = t.event || '';
                            const art = t.artifact || t.artifactId || '';
                            const roles = (t.roles || t.access?.roles || ['admin', 'device']).join(', ');
                            const del = t.delivery || 'trigger';
                            out += `  ${ev.padEnd(24)} ${art.padEnd(20)} ${roles.padEnd(22)} ${del}\n`;
                        }
                    } else {
                        for (const [ev, targets] of Object.entries(bindings)) {
                            const targetList = Array.isArray(targets) ? targets : [targets];
                            for (const t of targetList) {
                                const targetId = typeof t === 'string' ? t : t.artifactId;
                                out += `  ${ev.padEnd(24)} ${targetId.padEnd(20)} ${'admin, device'.padEnd(22)} trigger\n`;
                            }
                        }
                    }
                    return out + '\n';
                } catch (e) {
                    return `Trigger list failed: ${e.message}\n`;
                }
            }

            if (action === 'emit') {
                const event = cmd.args[1];
                if (!event) return 'Usage: trigger emit <event> [jsonPayload]\n';
                const dataStr = cmd.args[2] || '{}';
                let data;
                try { data = JSON.parse(dataStr); } catch (e) { data = { raw: dataStr }; }

                try {
                    const start = Date.now();
                    const res = await this.app.execRuntimeAction('trigger.emit', { event, data });
                    const ms = Date.now() - start;
                    let out = `\n✓ Event "${event}" emitted (${ms}ms response):\n`;
                    out += `  Outputs: ${JSON.stringify(res.outputs, null, 2)}\n`;
                    return out;
                } catch (e) {
                    return `✗ Trigger emit failed: ${e.message}\n`;
                }
            }

            if (action === 'bind' || action === 'edit') {
                const event = cmd.args[1];
                const artifactId = cmd.args[2];
                if (!event) return `Usage: trigger ${action} <event> [artifactId] [roles:admin,device,anonymous]\n`;

                let roles = ['admin', 'device'];
                let delivery = 'trigger';
                let once = false;
                let newEvent = event;

                for (let i = 2; i < cmd.args.length; i++) {
                    const arg = cmd.args[i];
                    if (arg.startsWith('--roles=')) {
                        roles = arg.replace('--roles=', '').split(',').map(r => r.trim());
                    } else if (arg.startsWith('--delivery=')) {
                        delivery = arg.replace('--delivery=', '').trim();
                    } else if (arg.startsWith('--to-event=')) {
                        newEvent = arg.replace('--to-event=', '').trim();
                    } else if (arg === '--once') {
                        once = true;
                    }
                }

                const rt = this.app.getActiveRuntime();
                const existing = rt?.triggers?.[event];
                const targetArt = artifactId || existing?.artifact;

                if (!targetArt) return 'Please specify bound artifact ID.\n';

                try {
                    await this.app.addTrigger({
                        event: newEvent,
                        artifact: targetArt,
                        access: { mode: 'allow', roles },
                        delivery,
                        once,
                        oldEvent: (action === 'edit' || newEvent !== event) ? event : null
                    });
                    await this.app.syncTriggersFromRuntime();
                    this.app.renderAll();
                    return `✓ Trigger "${newEvent}" saved (Roles: ${roles.join(', ')})\n`;
                } catch (e) {
                    return `✗ Trigger ${action} failed: ${e.message}\n`;
                }
            }

            if (action === 'unbind') {
                const event = cmd.args[1];
                if (!event) return 'Usage: trigger unbind <event>\n';
                try {
                    await this.app.execRuntimeAction('trigger.unbind', { event });
                    await this.app.syncTriggersFromRuntime();
                    this.app.renderAll();
                    return `✓ Unbound event "${event}"\n`;
                } catch (e) {
                    return `✗ Trigger unbind failed: ${e.message}\n`;
                }
            }

            return 'Usage: trigger <ls|emit <event> [json]|bind <event> <art> [--roles=...]|edit <event> [--roles=...]|unbind <event>>\n';
        }, 'Event trigger management and emission', 'trigger <ls|emit|bind|edit|unbind>');

        p.registerCommand('triggers', async (cmd) => {
            return await this.processor.process('trigger ' + cmd.args.join(' '), {});
        }, 'Alias for trigger', 'triggers <ls|emit>');

        // ── run / execution command ──
        p.registerCommand('run', async (cmd) => {
            const targetId = cmd.args[0] || this.app.state.getValue('/activeGraphId');
            if (!targetId) return 'No active graph or artifact selected. Usage: run [artifactId] [jsonInput]\n';

            let input = {};
            if (cmd.args[1]) {
                try { input = JSON.parse(cmd.args[1]); } catch (e) { input = { query: cmd.args[1] }; }
            }

            try {
                const start = Date.now();
                const res = await this.app.execRuntimeAction('run.start', { artifactId: targetId, input });
                const ms = Date.now() - start;
                let out = `\n✓ Execution completed for "${targetId}" in ${ms}ms:\n`;
                out += `  Output: ${JSON.stringify(res.output, null, 2)}\n`;
                return out;
            } catch (e) {
                return `✗ Execution error: ${e.message}\n`;
            }
        }, 'Run active graph or specified artifact', 'run [artifactId] [jsonInput]');

        p.registerCommand('stop', () => {
            this.app.stopActiveGraph();
            return '✓ Stopped local graph simulation.\n';
        }, 'Stop running graph', 'stop');

        // ── role / auth key commands ──
        p.registerCommand('role', async (cmd) => {
            const action = cmd.args[0] || 'list';

            if (action === 'ls' || action === 'list') {
                try {
                    const res = await this.app.execRuntimeAction('auth.keys.list');
                    const keys = res.keys || [];
                    let out = `\n── Runtime Role Keys & Principals (${keys.length}) ──────────────────\n`;
                    out += `  ${'KEY ID'.padEnd(20)} ${'ROLE'.padEnd(14)} ${'SCOPES'.padEnd(24)} ${'STATUS'}\n`;
                    out += `  ${'─'.repeat(68)}\n`;
                    for (const k of keys) {
                        const isRev = k.revoked ? 'REVOKED' : 'active';
                        const scopesStr = (k.scopes && k.scopes.length) ? k.scopes.join(',') : '(preset)';
                        out += `  ${k.name.padEnd(20)} ${k.role.toUpperCase().padEnd(14)} ${scopesStr.padEnd(24)} ${isRev}\n`;
                    }
                    return out + '\n';
                } catch (e) {
                    return `Role list failed: ${e.message}\n`;
                }
            }

            if (action === 'add' || action === 'create') {
                const keyId = cmd.args[1];
                let role = cmd.options.get('role') || (cmd.flags.has('admin') ? 'admin' : 'device');
                if (cmd.flags.has('dev') || cmd.flags.has('developer')) role = 'developer';
                if (cmd.flags.has('ops') || cmd.flags.has('operator')) role = 'operator';
                if (cmd.flags.has('viewer') || cmd.flags.has('auditor')) role = 'viewer';

                const scopesOpt = cmd.options.get('scopes');
                const scopes = scopesOpt ? scopesOpt.split(',').map(s => s.trim()).filter(Boolean) : [];

                try {
                    const res = await this.app.execRuntimeAction('auth.keys.create', { role, keyId, scopes });
                    await this.app.syncRolesFromRuntime();
                    this.app.renderAll();
                    return `✓ Generated new ${res.role} token (${res.name}):\n  Token: ${res.token}\n  Scopes: ${(res.scopes && res.scopes.length) ? res.scopes.join(', ') : 'default preset'}\n`;
                } catch (e) {
                    return `✗ Role creation failed: ${e.message}\n`;
                }
            }

            if (action === 'edit' || action === 'update') {
                const keyId = cmd.args[1];
                if (!keyId) return 'Usage: role edit <keyId> [--role=...] [--scopes=...] [--regenerate]\n';
                const role = cmd.options.get('role');
                const scopesOpt = cmd.options.get('scopes');
                const scopes = scopesOpt ? scopesOpt.split(',').map(s => s.trim()).filter(Boolean) : undefined;
                const regenerateToken = cmd.flags.has('regenerate') || cmd.flags.has('regen') || (cmd.options.get('token') === 'regenerate');

                try {
                    const res = await this.app.execRuntimeAction('auth.keys.update', { keyId, role, scopes, regenerateToken });
                    await this.app.syncRolesFromRuntime();
                    this.app.renderAll();
                    let out = `✓ Updated role key "${res.name}" (Role: ${res.role}, Scopes: ${(res.scopes && res.scopes.length) ? res.scopes.join(', ') : 'default preset'})\n`;
                    if (res.token) out += `  Regenerated Token: ${res.token}\n`;
                    return out;
                } catch (e) {
                    return `✗ Role update failed: ${e.message}\n`;
                }
            }

            if (action === 'revoke' || action === 'rm' || action === 'delete') {
                const keyId = cmd.args[1];
                if (!keyId) return 'Usage: role revoke <keyId>\n';
                try {
                    await this.app.execRuntimeAction('auth.keys.revoke', { keyId });
                    await this.app.syncRolesFromRuntime();
                    this.app.renderAll();
                    return `✓ Revoked key "${keyId}"\n`;
                } catch (e) {
                    return `✗ Key revocation failed: ${e.message}\n`;
                }
            }

            return 'Usage: role <ls|add <keyId> [--role=...]|edit <keyId> [--role=...] [--scopes=...] [--regenerate]|revoke <keyId>>\n';
        }, 'Manage role tokens and API keys on runtime', 'role <ls|add|edit|revoke>');

        p.registerCommand('roles', async (cmd) => {
            return await this.processor.process('role ' + cmd.args.join(' '), {});
        }, 'Alias for role', 'roles <ls|add>');

        // ── rbac commands ──
        p.registerCommand('rbac', async (cmd) => {
            const sub = cmd.args[0] || 'roles';

            if (sub === 'roles' || sub === 'ls') {
                try {
                    const res = await this.app.execRuntimeAction('rbac.roles.list');
                    const roles = res.roles || [];
                    let out = `\n── RBAC Roles & Scopes (${roles.length}) ────────────────────────────\n`;
                    out += `  ${'ROLE'.padEnd(14)} ${'TYPE'.padEnd(10)} ${'SCOPES'.padEnd(30)} ${'DESCRIPTION'}\n`;
                    out += `  ${'─'.repeat(74)}\n`;
                    for (const r of roles) {
                        const typeStr = r.isBuiltin ? 'builtin' : 'custom';
                        const scopesStr = (r.scopes || []).join(', ') || '*';
                        out += `  ${r.name.padEnd(14)} ${typeStr.padEnd(10)} ${scopesStr.padEnd(30)} ${r.description || ''}\n`;
                    }
                    return out + '\n';
                } catch (e) {
                    return `RBAC roles list failed: ${e.message}\n`;
                }
            }

            if (sub === 'role') {
                const action = cmd.args[1];
                if (action === 'add' || action === 'create') {
                    const name = cmd.args[2];
                    if (!name) return 'Usage: rbac role add <role_name> [--scopes=run:*,trigger:*] [--label="..."]\n';
                    const scopesOpt = cmd.options.get('scopes') || '*';
                    const scopes = scopesOpt.split(',').map(s => s.trim()).filter(Boolean);
                    const label = cmd.options.get('label') || name;
                    const description = cmd.options.get('desc') || cmd.options.get('description') || '';
                    try {
                        const res = await this.app.execRuntimeAction('rbac.roles.create', { name, label, description, scopes });
                        return `✓ Created custom RBAC role "${res.name}" with scopes: ${res.scopes.join(', ')}\n`;
                    } catch (e) {
                        return `✗ Role creation failed: ${e.message}\n`;
                    }
                }
                if (action === 'rm' || action === 'delete') {
                    const name = cmd.args[2];
                    if (!name) return 'Usage: rbac role rm <role_name>\n';
                    try {
                        await this.app.execRuntimeAction('rbac.roles.delete', { name });
                        return `✓ Deleted custom RBAC role "${name}"\n`;
                    } catch (e) {
                        return `✗ Role deletion failed: ${e.message}\n`;
                    }
                }
            }

            if (sub === 'grant') {
                const granteeId = cmd.args[1];
                const resource = cmd.args[2];
                if (!granteeId || !resource) return 'Usage: rbac grant <grantee_key_or_role> <action_or_artifact>\n';
                try {
                    await this.app.execRuntimeAction('rbac.permissions.grant', { granteeId, resource });
                    return `✓ Granted "${resource}" to "${granteeId}"\n`;
                } catch (e) {
                    return `✗ Grant failed: ${e.message}\n`;
                }
            }

            if (sub === 'revoke') {
                const granteeId = cmd.args[1];
                const resource = cmd.args[2];
                if (!granteeId) return 'Usage: rbac revoke <grantee_key_or_role> [action_or_artifact]\n';
                try {
                    await this.app.execRuntimeAction('rbac.permissions.revoke', { granteeId, resource });
                    return `✓ Revoked permissions for "${granteeId}"\n`;
                } catch (e) {
                    return `✗ Revoke failed: ${e.message}\n`;
                }
            }

            if (sub === 'grants' || sub === 'permissions') {
                try {
                    const res = await this.app.execRuntimeAction('rbac.permissions.list');
                    const grants = res.grants || [];
                    if (!grants.length) return 'No explicit permission grants found in database.\n';
                    let out = `\n── Explicit Permission Grants (${grants.length}) ──────────────────────\n`;
                    out += `  ${'GRANTEE (Key/Role)'.padEnd(28)} ${'RESOURCE / ACTION'.padEnd(30)} ${'GRANTED AT'}\n`;
                    out += `  ${'─'.repeat(74)}\n`;
                    for (const g of grants) {
                        out += `  ${g.granteeId.padEnd(28)} ${g.resource.padEnd(30)} ${new Date(g.createdAt).toLocaleDateString()}\n`;
                    }
                    return out + '\n';
                } catch (e) {
                    return `Permission grants list failed: ${e.message}\n`;
                }
            }

            return 'Usage: rbac <roles|role add <name> --scopes=...|role rm <name>|grant <grantee> <resource>|revoke <grantee>|grants>\n';
        }, 'RBAC role definitions and permission grants management', 'rbac <roles|role|grant|revoke|grants>');

        // ── secrets / credentials commands ──
        p.registerCommand('secret', async (cmd) => {
            const action = cmd.args[0] || 'list';

            if (action === 'ls' || action === 'list') {
                const secrets = this.app.getSecretsList();
                if (!secrets.length) return 'No local secret aliases cached. Use `secret set <key> <val>` to store.\n';
                let out = `\n── Config Secrets (${secrets.length}) ────────────────────────\n`;
                for (const s of secrets) {
                    const val = (this.app.isSessionElevated() && s.revealed) ? s.value : '●●●●●●●●';
                    out += `  ${s.key.padEnd(20)} = ${val} (${s.description || 'no desc'})\n`;
                }
                return out + '\n';
            }

            if (action === 'get') {
                const credId = cmd.args[1];
                if (!credId) return 'Usage: secret get <credId>\n';
                try {
                    const res = await this.app.execRuntimeAction('auth.credentials.get', { credId });
                    return `Secret "${credId}": ${res.value}\n`;
                } catch (e) {
                    return `✗ Secret get failed: ${e.message}\n`;
                }
            }

            if (action === 'set') {
                const key = cmd.args[1];
                const value = cmd.args[2];
                if (!key || value === undefined) return 'Usage: secret set <key> <value> [--desc=...]\n';
                const desc = cmd.options.get('desc') || '';
                try {
                    await this.app.setSecret(key, value, desc);
                    return `✓ Secret "${key}" encrypted and stored.\n`;
                } catch (e) {
                    return `✗ Secret store failed: ${e.message}\n`;
                }
            }

            return 'Usage: secret <ls|get <key>|set <key> <val>>\n';
        }, 'Manage encrypted runtime secrets (Elevated)', 'secret <ls|get|set>');

        p.registerCommand('secrets', async (cmd) => {
            return await this.processor.process('secret ' + cmd.args.join(' '), {});
        }, 'Alias for secret', 'secrets <ls|get|set>');

        // ── runtime connection commands ──
        p.registerCommand('runtime', async (cmd) => {
            const action = cmd.args[0] || 'list';

            if (action === 'ls' || action === 'list') {
                const list = this.app.getRuntimesList();
                const active = this.app.getActiveRuntime();
                let out = `\n── Connected Runtimes (${list.length}) ──────────────────────\n`;
                for (const r of list) {
                    const mark = r.id === active?.id ? '● [active] ' : '  [switch] ';
                    out += `${mark} ${r.id.padEnd(18)} ${r.label.padEnd(20)} ${r.url}\n`;
                }
                return out + '\n';
            }

            if (action === 'use') {
                const id = cmd.args[1];
                if (!id) return 'Usage: runtime use <id>\n';
                this.app.switchRuntime(id);
                return `✓ Switched active runtime to "${id}"\n`;
            }

            if (action === 'add') {
                const id = cmd.args[1];
                const url = cmd.args[2];
                const token = cmd.args[3] || '';
                if (!id || !url) return 'Usage: runtime add <id> <url> [token]\n';

                const runtimes = this.app.state.getValue('/runtimes') || {};
                runtimes[id] = {
                    id,
                    label: id,
                    url,
                    token,
                    capabilities: {},
                    graphs: {},
                    secrets: {},
                    roles: {},
                    triggers: {}
                };
                this.app.state.setValue({ ...runtimes }, '/runtimes');
                this.app.switchRuntime(id);
                return `✓ Added and connected runtime "${id}" (${url})\n`;
            }

            if (action === 'edit' || action === 'config') {
                const id = cmd.args[1];
                const url = cmd.args[2];
                const token = cmd.args[3];
                const label = cmd.args.slice(4).join(' ');
                if (!id) return 'Usage: runtime edit <id> [url] [token] [label]\n';

                const runtimes = this.app.state.getValue('/runtimes') || {};
                if (!runtimes[id]) return `Runtime "${id}" not found. Run \`runtime ls\` to view runtimes.\n`;

                if (url) runtimes[id].url = url;
                if (token) runtimes[id].token = token;
                if (label) runtimes[id].label = label;
                this.app.state.setValue({ ...runtimes }, '/runtimes');
                this.app._savePersistedState?.();
                if (this.app.state.getValue('/activeRuntimeId') === id) {
                    await this.app.syncActiveRuntime();
                }
                return `✓ Updated configuration for runtime "${id}"\n`;
            }

            return 'Usage: runtime <ls|use <id>|add <id> <url> <token>|edit <id> [url] [token] [label]>\n';
        }, 'Manage connected runtime sessions', 'runtime <ls|use|add|edit>');

        p.registerCommand('runtimes', async (cmd) => {
            return await this.processor.process('runtime ' + cmd.args.join(' '), {});
        }, 'Alias for runtime', 'runtimes <ls|use|add|edit>');

        // ── utility ──
        p.registerCommand('clear', () => {
            this.app.clearConsoleLogs();
            return '';
        }, 'Clear terminal output', 'clear');

        p.registerCommand('version', () => {
            return 'Nodaic Studio v5.0 (Spec v5 compliant)\n';
        }, 'Show studio version', 'version');

        p.registerCommand('help', () => {
            let out = `\n── Nodaic Studio Terminal Commands ────────────────────────\n\n`;
            const list = p.getHelpList();
            for (const item of list) {
                out += `  ${item.usage.padEnd(36)} ${item.description}\n`;
            }
            out += `\nExamples:\n` +
                   `  whoami                     - Check authenticated role on active runtime\n` +
                   `  artifact ls                - Display all graphs and process nodes in library\n` +
                   `  artifact get pipeline      - View interface and NDL source of pipeline\n` +
                   `  graph ls                   - List all graphs from runtime library\n` +
                   `  graph open logger          - Load and visualize logger graph\n` +
                   `  trigger emit order.process - Test execute event on backend runtime\n` +
                   `  run whatsapp-pipeline      - Execute graph on runtime and display output\n` +
                   `  sudo-session               - Elevate session for 5 mins to manage secrets\n\n`;
            return out;
        }, 'Show command help summary', 'help');
    }

    async execute(inputStr) {
        return await this.processor.process(inputStr, {});
    }
}
