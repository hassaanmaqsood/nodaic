/**
 * Nodaic Studio Application Controller (Spec v5)
 * Dynamic runtime management with real library & graph synchronization,
 * runtime-only local storage, graph creation/deployment, and fail-safe NDL parsing.
 */

import { Observable } from './observable.js';
import { NodaicCliEngine } from './nodaic-clicore.js';

export const RUNTIME_COLORS = [
    '#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2', '#4f46e5', '#64748b'
];

export const DEFAULT_AUTH_TOKEN = '00010000000000026B09633A61646D696E5F626F6F740000000000000000000070E3FBCA8E2F803892402CEC11C894CA4ECDBE4155658D6EF62661AC3625AEAB843C32F303A97FFAF12B8848CD4879077ACDB7028B4D4D67A396729ABBC6AC417015B285E743FD039B9A76FD09B0550FCCA2FCF913F1795F66E29F587D203D4D';
export const DEFAULT_RUNTIME_URL = 'http://localhost:3030';

export class StudioApp {
    constructor() {
        this.state = new Observable({
            mode: 'write', // 'read' | 'write' (§4)
            activeTab: 'modeler', // 'modeler' | 'secrets' | 'triggers'
            runtimes: {},
            activeRuntimeId: null,
            activeGraphId: null,
            elevatedUntil: 0,
            connectivityState: 'offline', // 'live' | 'syncing' | 'offline' | 'local' (§7)
            connectivityLatency: 0,
            offlineRetryCountdown: 0,
            mutationStatus: 'idle', // 'idle' | 'pending' | 'synced' | 'failed' (§8)
            logHistory: []
        });

        this.cli = new NodaicCliEngine(this);
        this.network = null;
        this.visNodes = null;
        this.visEdges = null;
        this.editorView = null;
        this.graphModel = { meta: { name: 'graph', version: '1.0.0', author: '' }, nodes: {}, edges: [] };
        this.selectedNodeId = null;
        this.selectedEdgeVisId = null;
        this.linking = false;
        this.sheetState = null;
        this.confirmCallback = null;
        this.runTimer = null;
        this.runActive = false;
        this.offlineInterval = null;
        this.filterCat = 'all';

        this.library = [];
        if (typeof window !== 'undefined') window.LIBRARY = [];
        else globalThis.LIBRARY = [];
    }

    /* ── App Initialization ── */
    async init() {
        this._loadPersistedState();
        this._initVisCanvas();
        this._setupEventListeners();
        this._setupStateSubscriptions();

        this.renderAll();

        const rt = this.getActiveRuntime();
        if (rt && rt.url) {
            await this.syncActiveRuntime();
        } else {
            this.state.setValue('offline', '/connectivityState');
            this.logEvent('System', 'system', 'Click "＋" in Runtimes to connect a runtime with URL & Auth Token.', 'WARN');
        }

        this.logEvent('System', 'system', 'Nodaic Studio ready.', 'OK');
    }

    /* ── Storage: ONLY runtime connection info is persisted locally ── */
    _loadPersistedState() {
        if (typeof localStorage !== 'undefined') {
            try {
                const saved = localStorage.getItem('nodaic_studio_state_v5');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed && parsed.runtimes && Object.keys(parsed.runtimes).length > 0) {
                        const loadedRuntimes = {};
                        for (const [id, r] of Object.entries(parsed.runtimes)) {
                            loadedRuntimes[id] = {
                                id: r.id,
                                label: r.label,
                                url: r.url,
                                token: r.token,
                                color: r.color || '#059669',
                                description: r.description || '',
                                capabilities: {},
                                graphs: {},
                                secrets: {},
                                roles: {},
                                triggers: {}
                            };
                        }
                        this.state.setValue(loadedRuntimes, '/runtimes');
                        const activeId = parsed.activeRuntimeId && loadedRuntimes[parsed.activeRuntimeId] 
                            ? parsed.activeRuntimeId 
                            : Object.keys(loadedRuntimes)[0];
                        this.state.setValue(activeId, '/activeRuntimeId');
                        this.state.setValue(null, '/activeGraphId');
                        this.state.setValue(parsed.mode || 'write', '/mode');
                        return;
                    }
                }
            } catch (e) {
                console.warn('State load exception:', e);
            }
        }

        // Default initial connection to the active local runtime
        const defaultRuntimeId = 'nodejs-runtime';
        const initialRuntimes = {
            [defaultRuntimeId]: {
                id: defaultRuntimeId,
                label: 'Node.js Runtime',
                url: DEFAULT_RUNTIME_URL,
                token: DEFAULT_AUTH_TOKEN,
                color: '#059669',
                description: 'Local Node.js API runtime',
                capabilities: {},
                graphs: {},
                secrets: {},
                roles: {},
                triggers: {}
            }
        };

        this.state.setValue(initialRuntimes, '/runtimes');
        this.state.setValue(defaultRuntimeId, '/activeRuntimeId');
        this.state.setValue(null, '/activeGraphId');
        this.state.setValue('write', '/mode');
    }

    _savePersistedState() {
        if (typeof localStorage === 'undefined') return;
        try {
            const rawRuntimes = this.state.getValue('/runtimes') || {};
            const cleanRuntimes = {};
            for (const [id, r] of Object.entries(rawRuntimes)) {
                cleanRuntimes[id] = {
                    id: r.id,
                    label: r.label,
                    url: r.url,
                    token: r.token,
                    color: r.color,
                    description: r.description
                };
            }

            localStorage.setItem('nodaic_studio_state_v5', JSON.stringify({
                runtimes: cleanRuntimes,
                activeRuntimeId: this.state.getValue('/activeRuntimeId'),
                mode: this.state.getValue('/mode')
            }));
        } catch (e) {
            console.warn('Failed saving state:', e);
        }
    }

    _setupStateSubscriptions() {
        this.state.addListener(() => {
            this._savePersistedState();
            this.renderAll();
        }, '/');

        this.state.addListener(() => {
            this._updateStatusBar();
        }, '/connectivityState');

        this.state.addListener(() => {
            this._updateStatusBar();
        }, '/mutationStatus');
    }

    /* ── Runtime & Capability Getters ── */
    getActiveRuntime() {
        const id = this.state.getValue('/activeRuntimeId');
        if (!id) return null;
        return this.state.getValue(`/runtimes/${id}`) || null;
    }

    getCapability(flagName) {
        const rt = this.getActiveRuntime();
        if (!rt || !rt.capabilities) return undefined;
        return rt.capabilities[flagName];
    }

    getActiveRole() {
        const rt = this.getActiveRuntime();
        if (!rt || !rt.auth) return null;
        return {
            name: rt.auth.role || 'none',
            keyId: rt.auth.keyId || null,
            isAdmin: Boolean(rt.auth.isAdmin || rt.auth.role === 'admin'),
            scopes: rt.auth.scopes || [],
            token: rt.token || ''
        };
    }

    canManageRoles() {
        const role = this.getActiveRole();
        if (!role) return false;
        if (role.isAdmin || role.name === 'admin') return true;
        const scopes = role.scopes || [];
        return scopes.some(s => ['*', 'all', 'rbac:*', 'rbac', 'keys:write', 'keys:*'].includes(s));
    }

    isSessionElevated() {
        const until = this.state.getValue('/elevatedUntil') || 0;
        return Date.now() < until;
    }

    elevateSession(durationSeconds = 300) {
        const until = Date.now() + durationSeconds * 1000;
        this.state.setValue(until, '/elevatedUntil');
        this.renderAll();
        return durationSeconds;
    }

    isWriteMode() {
        return this.state.getValue('/mode') === 'write';
    }

    /* ── Optimistic Mutation Tracking (§8) ── */
    startMutation(operationName) {
        this.state.setValue('pending', '/mutationStatus');
        this.logEvent('Mutation', 'system', `[Pending] ${operationName}...`);
    }

    completeMutation(operationName) {
        this.state.setValue('synced', '/mutationStatus');
        this.logEvent('Mutation', 'system', `[Synced ✓] ${operationName}`, 'OK');
        setTimeout(() => {
            if (this.state.getValue('/mutationStatus') === 'synced') {
                this.state.setValue('idle', '/mutationStatus');
            }
        }, 2000);
    }

    failMutation(operationName, error) {
        this.state.setValue('failed', '/mutationStatus');
        this.logEvent('Mutation', 'system', `[Failed ✕] ${operationName}: ${error.message}`, 'ERROR');
        this.showToast(`Action failed: ${error.message}`, true);
    }

    /* ── Live HTTP Bridge to Runtime Backend ── */
    async execRuntimeAction(action, payload = {}, runtimeId = null) {
        const rt = runtimeId ? this.state.getValue(`/runtimes/${runtimeId}`) : this.getActiveRuntime();
        if (!rt) throw new Error('No runtime selected');
        if (!rt.url) throw new Error(`Runtime "${rt.label}" has no URL configured`);

        const token = rt.token || '';
        const targetUrl = rt.url.replace(/\/$/, '') + '/nodaic/v1/';

        this.logEvent(rt.label, 'rxtx', `[TX] ${action} -> ${targetUrl}`, 'TX');

        const startTime = Date.now();
        try {
            this.state.setValue('syncing', '/connectivityState');
            const res = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : ''
                },
                body: JSON.stringify({ action, token, payload })
            });

            const latency = Date.now() - startTime;
            this.state.setValue(latency, '/connectivityLatency');

            const data = await res.json();
            this.logEvent(rt.label, 'rxtx', `[RX] ${action} (${latency}ms) <- ${JSON.stringify(data)}`, 'RX');

            if (data.error) {
                const err = new Error(data.reason || data.error?.message || 'Runtime returned error');
                err.code = data.code;
                throw err;
            }

            this.state.setValue('live', '/connectivityState');
            return data;
        } catch (err) {
            this.state.setValue('offline', '/connectivityState');
            this.logEvent(rt.label, 'rxtx', `[RX] ${action} Failed: ${err.message}`, 'ERROR');
            throw err;
        }
    }

    /* ── Fetch Real Manifest, Artifacts & Graphs from Runtime ── */
    async syncActiveRuntime() {
        const rt = this.getActiveRuntime();
        if (!rt || !rt.url) return;

        try {
            this.state.setValue('syncing', '/connectivityState');

            // 1. Fetch live capability manifest (§2)
            try {
                const manifestUrl = rt.url.replace(/\/$/, '') + '/manifest';
                const mRes = await fetch(manifestUrl);
                if (mRes.ok) {
                    const manifestData = await mRes.json();
                    rt.capabilities = {
                        transport: manifestData.transport || 'REST+WS',
                        persistent_state: manifestData.persistent_state || 'native',
                        live_logs: manifestData.live_logs || 'push',
                        secrets_revealable: manifestData.secrets_revealable ? 'yes' : 'no',
                        artifact_deploy: manifestData.artifact_deploy || 'live-post',
                        concurrency_check: manifestData.concurrency_check || 'version-stamp',
                        role_management: manifestData.role_management || 'full',
                        ...manifestData
                    };
                }
            } catch (mErr) {
                console.warn('Manifest endpoint fallback:', mErr.message);
            }

            // 2. Authenticate token and query identity via whoami
            const whoamiRes = await this.execRuntimeAction('whoami');
            rt.auth = {
                role: whoamiRes.role || 'none',
                keyId: whoamiRes.keyId || null,
                isAdmin: Boolean(whoamiRes.isAdmin)
            };

            this.state.setValue('live', '/connectivityState');
            this.logEvent('Auth', 'system', `✓ Authenticated as [Role: ${rt.auth.role}${rt.auth.isAdmin ? ' (admin)' : ''}] on "${rt.label}"`, 'OK');

            // 3. Query all runtime artifacts and populate graphs & library
            await this.syncLibraryAndGraphsFromRuntime();

            // 4. Query live event trigger bindings
            await this.syncTriggersFromRuntime();

            // 5. Query live roles/keys if admin
            if (rt.auth.isAdmin && rt.capabilities?.role_management !== 'none') {
                await this.syncRolesFromRuntime();
            }

            this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
            this.renderAll();
        } catch (e) {
            this.state.setValue('offline', '/connectivityState');
            this._startOfflineRetry();
            this.showToast(`Connection failed: ${e.message}`, true);
        }
    }

    async syncLibraryAndGraphsFromRuntime() {
        const rt = this.getActiveRuntime();
        if (!rt) return;

        try {
            const res = await this.execRuntimeAction('library.list', { limit: 100 });
            const allArtifacts = res.artifacts || [];

            // 1. Populate library for node picker
            this.library = allArtifacts.map(a => ({
                ref: a.id,
                version: a.version || 'v1.0.0',
                versions: [a.version || 'v1.0.0'],
                label: a.metadata?.name || a.id,
                category: a.artifactType === 'graph' ? 'Graph' : (a.artifactType || 'Process'),
                artifactType: a.artifactType || 'process',
                color: RUNTIME_COLORS[Math.abs(this._hashString(a.id)) % RUNTIME_COLORS.length],
                inputs: a.interface?.inputs ? Object.entries(a.interface.inputs).map(([k, v]) => ({ name: k, type: v.type || 'object' })) : [{ name: 'input', type: 'object' }],
                outputs: a.interface?.outputs ? Object.entries(a.interface.outputs).map(([k, v]) => ({ name: k, type: v.type || 'object' })) : [{ name: 'output', type: 'object' }],
                defaultState: a.interface?.defaultState || {}
            }));
            if (typeof window !== 'undefined') window.LIBRARY = this.library;
            else globalThis.LIBRARY = this.library;

            // 2. Extract and pull all graphs
            const graphArtifacts = allArtifacts.filter(a => a.artifactType === 'graph');
            if (!rt.graphs) rt.graphs = {};

            for (const g of graphArtifacts) {
                // Fetch graph definition/NDL if not already present
                let ndlCode = rt.graphs[g.id]?.ndl;
                if (!ndlCode) {
                    try {
                        const gDef = await this.execRuntimeAction('library.get', { id: g.id, version: g.version || 'latest' });
                        ndlCode = gDef.source ? gDef.source.trim() + '\n' : '';
                    } catch (err) {
                        ndlCode = '';
                    }
                }
                if (!ndlCode || ndlCode.trim() === `graph ${g.id} @version:${g.version || '1.0.0'}`) {
                    if (g.id === 'logger') {
                        ndlCode = `graph logger @version:1.0.0\n\nnode receiver @parseRequest\nnode logger @log-process\n\nreceiver.body -> logger.data\n`;
                    } else {
                        ndlCode = `graph ${g.id} @version:${g.version || '1.0.0'}\n\n`;
                    }
                }

                rt.graphs[g.id] = {
                    id: g.id,
                    label: g.metadata?.name || g.id,
                    version: g.version || 'v1.0.0',
                    description: g.metadata?.description || '',
                    ndl: ndlCode
                };
            }

            // Select active graph if none or invalid
            const graphIds = Object.keys(rt.graphs);
            const curGraphId = this.state.getValue('/activeGraphId');
            const targetGraphId = (curGraphId && rt.graphs[curGraphId]) ? curGraphId : graphIds[0];

            if (targetGraphId) {
                this.loadGraph(rt.id, targetGraphId);
            }

            this.logEvent('Library', 'library', `Synced ${allArtifacts.length} total artifacts (${graphIds.length} graphs) from runtime.`);
        } catch (e) {
            console.warn('Library sync warning:', e.message);
        }
    }

    async syncLibraryFromRuntime() {
        return this.syncLibraryAndGraphsFromRuntime();
    }

    async syncTriggersFromRuntime() {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        try {
            const res = await this.execRuntimeAction('trigger.list');
            rt.triggers = {};
            if (Array.isArray(res.triggers)) {
                for (const t of res.triggers) {
                    const ev = t.event;
                    rt.triggers[ev] = {
                        event: ev,
                        artifact: t.artifact || t.artifactId,
                        access: t.access || { mode: 'allow', roles: t.roles || ['admin', 'device'] },
                        roles: t.roles || t.access?.roles || ['admin', 'device'],
                        delivery: t.delivery || 'trigger',
                        once: Boolean(t.once),
                        publicToken: t.publicToken || null
                    };
                }
            } else if (res.bindings) {
                for (const [event, targets] of Object.entries(res.bindings)) {
                    (Array.isArray(targets) ? targets : [targets]).forEach(target => {
                        const targetId = typeof target === 'string' ? target : target.artifactId;
                        rt.triggers[event] = {
                            event,
                            artifact: targetId,
                            access: { mode: 'allow', roles: ['admin', 'device'] },
                            roles: ['admin', 'device'],
                            delivery: 'trigger'
                        };
                    });
                }
            }
        } catch (e) {
            console.warn('Trigger sync warning:', e.message);
        }
    }

    async syncRolesFromRuntime() {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        try {
            const res = await this.execRuntimeAction('auth.keys.list');
            if (res.keys) {
                rt.roles = {};
                for (const k of res.keys) {
                    rt.roles[k.name] = {
                        name: k.name,
                        role: k.role,
                        isAdmin: k.isAdmin,
                        token: k.name === rt.auth?.keyId ? rt.token : '••••••••'
                    };
                }
            }
        } catch (e) {
            console.warn('Roles sync warning:', e.message);
        }
    }

    _startOfflineRetry() {
        clearInterval(this.offlineInterval);
        this.state.setValue(10, '/offlineRetryCountdown');
        this.offlineInterval = setInterval(() => {
            let cd = this.state.getValue('/offlineRetryCountdown');
            if (cd <= 1) {
                clearInterval(this.offlineInterval);
                this.syncActiveRuntime();
            } else {
                this.state.setValue(cd - 1, '/offlineRetryCountdown');
                this._updateStatusBar();
            }
        }, 1000);
    }

    _hashString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return h;
    }

    /* ── Render Controllers ── */
    renderAll() {
        if (typeof document === 'undefined') return;
        this._renderTitlebar();
        this._renderSidebar();
        this._renderWorkspaceView();
        this._updateStatusBar();
    }

    _renderTitlebar() {
        const rt = this.getActiveRuntime();
        const graph = this.getActiveGraph();
        const mode = this.state.getValue('/mode');
        const activeTab = this.state.getValue('/activeTab');

        // Mode toggle (Read | Write)
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        // Context switcher tabs
        document.querySelectorAll('.ws-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeTab);
        });

        // Breadcrumb
        const breadcrumbEl = document.getElementById('breadcrumb');
        if (breadcrumbEl) {
            if (!rt) {
                breadcrumbEl.textContent = 'runtimes/—';
            } else if (activeTab === 'modeler') {
                breadcrumbEl.textContent = `${rt.id}/library/${graph ? graph.id : '—'}`;
            } else {
                breadcrumbEl.textContent = `${rt.id}/${activeTab}`;
            }
        }

        // View toggle disabled when not in modeler
        const viewToggle = document.getElementById('view-toggle');
        const runBtn = document.getElementById('run-btn');
        if (viewToggle) viewToggle.classList.toggle('disabled', activeTab !== 'modeler');
        if (runBtn) runBtn.classList.toggle('disabled', activeTab !== 'modeler');
    }

    _renderSidebar() {
        const rt = this.getActiveRuntime();
        const roleMgmt = this.getCapability('role_management') || 'full';
        const activeRole = this.getActiveRole();
        const isWrite = this.isWriteMode();

        // 1. RUNTIMES section
        const runtimeListEl = document.getElementById('runtime-list');
        if (runtimeListEl) {
            const allRuntimes = Object.values(this.state.getValue('/runtimes') || {});
            runtimeListEl.innerHTML = allRuntimes.length ? allRuntimes.map(r => `
                <div class="side-row ${r.id === rt?.id ? 'active' : ''}" data-runtime-id="${r.id}">
                    <span class="side-dot" style="background:${r.color || '#2563eb'}"></span>
                    <span class="side-label">${this._escape(r.label)}</span>
                    <span class="side-sublabel">${r.capabilities?.role_management || 'online'}</span>
                    ${isWrite ? `<div class="side-action-btns">
                        <button class="side-edit-btn" data-edit-runtime="${r.id}" title="Edit Runtime">✎</button>
                    </div>` : ''}
                </div>
            `).join('') : `<div class="side-empty">Click ＋ to connect runtime</div>`;
        }

        // 2. LIBRARY (Graphs) section - displaying all runtime graphs
        const libraryListEl = document.getElementById('library-list');
        const libraryBadge = document.getElementById('library-badge');
        if (libraryListEl) {
            if (!rt || !rt.graphs || !Object.keys(rt.graphs).length) {
                libraryListEl.innerHTML = `<div class="side-empty">No graphs loaded</div>`;
                if (libraryBadge) libraryBadge.textContent = '0 graphs';
            } else {
                const graphs = Object.values(rt.graphs);
                if (libraryBadge) libraryBadge.textContent = `${graphs.length} graphs`;
                libraryListEl.innerHTML = graphs.map(g => `
                    <div class="side-row ${g.id === this.state.getValue('/activeGraphId') ? 'active' : ''}" data-graph-id="${g.id}">
                        <span class="side-label mono">${this._escape(g.label || g.id)}</span>
                        <span class="side-sublabel">${this._escape(g.version || '')}</span>
                        ${isWrite ? `<div class="side-action-btns">
                            <button class="side-edit-btn" data-edit-graph="${g.id}" title="Rename Graph">✎</button>
                        </div>` : ''}
                    </div>
                `).join('');
            }
        }

        // 3. SECRETS section
        const secretsSection = document.getElementById('side-section-secrets');
        const secretsListEl = document.getElementById('secrets-list');
        if (secretsListEl && secretsSection) {
            const secrets = Object.values(rt?.secrets || {});
            secretsListEl.innerHTML = secrets.length ? secrets.map(s => `
                <div class="side-row" data-open-secrets="true">
                    <span class="side-label mono">${this._escape(s.key)}</span>
                    <span class="side-sublabel">${s.revealed && this.isSessionElevated() ? s.value : '••••'}</span>
                </div>
            `).join('') : `<div class="side-empty">No secrets</div>`;
        }

        // 4. ROLES section (rendered per §5.3 & RBAC permissions)
        const rolesSection = document.getElementById('side-section-roles');
        const rolesListEl = document.getElementById('roles-list');
        const addRoleBtn = document.getElementById('add-role-btn');

        if (rolesSection && rolesListEl) {
            const canManage = this.canManageRoles();

            if (!rt || roleMgmt === 'none' || !canManage) {
                // If role management is unsupported or user's role lacks permission, hide section completely
                rolesSection.style.display = 'none';
            } else if (roleMgmt === 'fixed') {
                rolesSection.style.display = 'flex';
                if (addRoleBtn) addRoleBtn.style.display = 'none';
                const roles = Object.values(rt?.roles || {
                    'admin': { name: 'admin', role: 'admin', isAdmin: true },
                    'device': { name: 'device', role: 'device', isAdmin: false }
                });
                rolesListEl.innerHTML = roles.map(r => `
                    <div class="side-row ${r.name === activeRole?.name || r.name === activeRole?.keyId ? 'active' : ''}">
                        <span class="side-label mono">${r.name === activeRole?.keyId || r.name === activeRole?.name ? '● ' : '  '}${this._escape(r.name)}</span>
                        <span class="side-sublabel">[${this._escape(r.role || (r.isAdmin ? 'admin' : 'device'))}]</span>
                    </div>
                `).join('');
            } else if (roleMgmt === 'full') {
                rolesSection.style.display = 'flex';
                if (addRoleBtn) addRoleBtn.style.display = isWrite ? 'flex' : 'none';
                const roles = Object.values(rt?.roles || {});
                if (!roles.length && activeRole) {
                    roles.push({ name: activeRole.keyId || activeRole.name, role: activeRole.name, isAdmin: activeRole.isAdmin });
                }

                rolesListEl.innerHTML = roles.length ? roles.map(r => {
                    const isCurrent = (r.name === activeRole?.keyId || r.name === activeRole?.name);
                    const roleBadge = r.role ? r.role.toLowerCase() : (r.isAdmin ? 'admin' : 'device');
                    const scopesTooltip = (r.scopes && r.scopes.length) ? r.scopes.join(', ') : 'default preset';
                    return `
                        <div class="side-row ${isCurrent ? 'active' : ''}" data-role-id="${this._escape(r.name)}" title="Role: ${this._escape(roleBadge)} | Scopes: ${this._escape(scopesTooltip)}">
                            <span class="side-label mono" title="${this._escape(r.name)}">${isCurrent ? '● ' : '  '}${this._escape(r.name)}</span>
                            <span class="side-sublabel">[${this._escape(roleBadge)}]</span>
                            ${isWrite ? `<div class="side-action-btns">
                                <button class="side-edit-btn" data-edit-role="${this._escape(r.name)}" title="Edit Role &amp; Scopes">✎</button>
                                <button class="side-edit-btn" data-delete-role="${this._escape(r.name)}" title="Revoke Role Key">✕</button>
                            </div>` : ''}
                        </div>
                    `;
                }).join('') : `<div class="side-empty">No role keys</div>`;
            }
        }
    }

    _renderWorkspaceView() {
        const activeTab = this.state.getValue('/activeTab');

        document.querySelectorAll('.ws-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === `workspace-${activeTab}`);
        });

        if (activeTab === 'modeler') {
            if (this.editorView) this.editorView.requestMeasure();
        } else if (activeTab === 'secrets') {
            this._renderSecretsTable();
        } else if (activeTab === 'triggers') {
            this._renderTriggersTable();
        }
    }

    _renderSecretsTable() {
        const rt = this.getActiveRuntime();
        const tbody = document.getElementById('secrets-table-body');
        const revealable = this.getCapability('secrets_revealable') === 'yes';
        const isElevated = this.isSessionElevated();
        const isWrite = this.isWriteMode();

        if (!tbody) return;

        const secrets = Object.values(rt?.secrets || {});
        if (!secrets.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-table-state">No secrets configured for this runtime.</td></tr>`;
            return;
        }

        tbody.innerHTML = secrets.map(s => {
            const showVal = isElevated && revealable && s.revealed;
            const valDisplay = showVal ? s.value : '●●●●●●●●●●●●';
            return `
                <tr>
                    <td class="cell-mono"><b>${this._escape(s.key)}</b></td>
                    <td class="cell-mono">
                        <span>${this._escape(valDisplay)}</span>
                        ${revealable && isWrite ? `
                            <button class="tbl-btn" data-toggle-reveal="${this._escape(s.key)}" style="margin-left:8px">
                                ${s.revealed && isElevated ? 'Hide' : '👁 Reveal'}
                            </button>
                        ` : ''}
                    </td>
                    <td>${this._escape(s.description || '—')}</td>
                    <td style="text-align:right">
                        ${isWrite ? `
                            <div class="table-actions" style="justify-content:flex-end">
                                <button class="tbl-btn" data-edit-secret="${this._escape(s.key)}">✎ Edit</button>
                                <button class="tbl-btn danger" data-delete-secret="${this._escape(s.key)}">Delete</button>
                            </div>
                        ` : '<span style="color:var(--text-3)">Read-only</span>'}
                    </td>
                </tr>
            `;
        }).join('');
    }

    _renderTriggersTable() {
        const rt = this.getActiveRuntime();
        const tbody = document.getElementById('triggers-table-body');
        const roleMgmt = this.getCapability('role_management');
        const isWrite = this.isWriteMode();

        if (!tbody) return;

        const triggers = Object.values(rt?.triggers || {});
        if (!triggers.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-table-state">No event triggers configured. Click "＋ Add Trigger" to bind an event.</td></tr>`;
            return;
        }

        tbody.innerHTML = triggers.map(t => {
            let accessHtml = '—';
            const roles = t.roles || t.access?.roles || [];
            const isAnon = roles.includes('anonymous') || roles.includes('anon');
            const hasAdmin = roles.includes('admin');
            const hasDevice = roles.includes('device');

            let badges = [];
            if (isAnon) {
                badges.push('<span class="insp-badge" style="background:rgba(16, 185, 129, 0.12); color:#10b981; border:1px solid rgba(16, 185, 129, 0.25)">🌐 Anonymous</span>');
            }
            if (hasAdmin) {
                badges.push('<span class="insp-badge" style="background:rgba(239, 68, 68, 0.12); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.25)">👑 Admin</span>');
            }
            if (hasDevice) {
                badges.push('<span class="insp-badge" style="background:rgba(59, 130, 246, 0.12); color:#3b82f6; border:1px solid rgba(59, 130, 246, 0.25)">📱 Device</span>');
            }
            if (!badges.length) {
                badges.push('<span class="insp-badge" style="background:var(--bg-surface); color:var(--text-3); border:1px solid var(--border)">Default (Admin, Device)</span>');
            }
            accessHtml = `<div style="display:flex; flex-wrap:wrap; gap:4px">${badges.join('')}</div>`;

            const isGraph = Boolean(rt?.graphs?.[t.artifact] || (this.library || []).some(x => x.ref === t.artifact && (x.category === 'Graph' || x.artifactType === 'graph')));
            const kindBadge = isGraph
                ? `<span class="insp-badge" style="font-size:8.5px; background:var(--bg-surface); border:1px solid var(--border)">Graph</span>`
                : `<span class="insp-badge" style="font-size:8.5px; background:var(--bg-surface); border:1px solid var(--border)">Process</span>`;

            return `
                <tr>
                    <td class="cell-mono"><b>${this._escape(t.event)}</b></td>
                    <td class="cell-mono" style="color:var(--accent)">
                        <code>${this._escape(t.artifact)}</code>
                        ${kindBadge}
                    </td>
                    <td>${accessHtml}</td>
                    <td class="cell-mono"><span class="insp-badge" style="background:var(--bg-surface); color:var(--text-2); border:1px solid var(--border)">${t.delivery || 'trigger'}</span></td>
                    <td style="text-align:right">
                        <div class="table-actions" style="justify-content:flex-end">
                            <button class="tbl-btn" data-emit-trigger="${this._escape(t.event)}" title="Simulate / Emit event">⚡ Emit</button>
                            ${isWrite ? `
                                <button class="tbl-btn" data-edit-trigger="${this._escape(t.event)}" title="Edit trigger event and access roles">✎ Edit</button>
                                <button class="tbl-btn danger" data-delete-trigger="${this._escape(t.event)}" title="Delete trigger">Delete</button>
                            ` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

    }

    _updateStatusBar() {
        if (typeof document === 'undefined') return;
        const role = this.getActiveRole();
        const connState = this.state.getValue('/connectivityState');
        const latency = this.state.getValue('/connectivityLatency');
        const mutation = this.state.getValue('/mutationStatus');
        const retryCd = this.state.getValue('/offlineRetryCountdown');

        const nodesCount = Object.keys(this.graphModel.nodes).length;
        const edgesCount = this.graphModel.edges.length;

        const statNodes = document.getElementById('stat-nodes');
        const statEdges = document.getElementById('stat-edges');
        const statConn = document.getElementById('stat-conn');
        const statRole = document.getElementById('stat-role');
        const statMutation = document.getElementById('stat-mutation');

        if (statNodes) statNodes.textContent = nodesCount;
        if (statEdges) statEdges.textContent = edgesCount;

        if (statConn) {
            statConn.className = `connectivity-chip ${connState}`;
            if (connState === 'live') {
                statConn.innerHTML = `● Live (${latency}ms)`;
            } else if (connState === 'syncing') {
                statConn.innerHTML = `◐ Syncing…`;
            } else if (connState === 'offline') {
                statConn.innerHTML = `○ Offline ${retryCd ? `(${retryCd}s)` : ''} <button id="retry-now-btn" class="tbl-btn" style="height:18px; padding:0 4px; font-size:9px">↻ now</button>`;
            } else if (connState === 'local') {
                statConn.innerHTML = `⚡ Local (tab-only)`;
            }
        }

        if (statRole) {
            if (role && role.name !== 'none') {
                statRole.style.display = 'inline-flex';
                statRole.className = `role-chip ${role.isAdmin ? 'admin' : ''}`;
                statRole.innerHTML = `role: <b>${this._escape(role.name)}</b>${role.isAdmin ? ' (admin)' : ''}`;
            } else {
                statRole.style.display = 'none';
            }
        }

        if (statMutation) {
            statMutation.className = `mutation-status ${mutation}`;
            if (mutation === 'pending') statMutation.innerHTML = `● saving…`;
            else if (mutation === 'synced') statMutation.innerHTML = `✓ synced`;
            else if (mutation === 'failed') statMutation.innerHTML = `✕ failed`;
            else statMutation.innerHTML = ``;
        }
    }

    /* ── Graph Modeler & Visual Canvas ── */
    _initVisCanvas() {
        const container = document.getElementById('vis-canvas');
        if (!container) return;

        this.visNodes = new vis.DataSet();
        this.visEdges = new vis.DataSet();

        const options = {
            physics: {
                enabled: true,
                solver: 'barnesHut',
                barnesHut: { gravitationalConstant: -2800, springLength: 180, springConstant: 0.05, damping: 0.18 },
                stabilization: { iterations: 120, fit: true }
            },
            nodes: {
                shape: 'box',
                shapeProperties: { borderRadius: 8 },
                borderWidth: 1.5,
                borderWidthSelected: 2,
                color: {
                    background: '#FFFFFF',
                    border: '#E5E7EB',
                    highlight: { background: '#FFF7F2', border: '#FF6B35' },
                    hover: { background: '#FAFAFB', border: '#FF6B35' }
                },
                font: {
                    multi: false,
                    color: '#111827',
                    face: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    size: 13
                },
                margin: { top: 12, bottom: 12, left: 16, right: 16 },
                shadow: { enabled: true, color: 'rgba(0, 0, 0, 0.06)', size: 8, x: 0, y: 2 }
            },
            edges: {
                color: { color: '#9CA3AF', highlight: '#FF6B35', hover: '#FF6B35' },
                width: 1.75,
                selectionWidth: 2.5,
                arrows: { to: { enabled: true, scaleFactor: 0.7 } },
                font: { color: '#4B5563', face: 'IBM Plex Mono, monospace', size: 10, background: '#FFFFFF', strokeWidth: 0 },
                smooth: { type: 'curvedCW', roundness: 0.15 }
            },
            interaction: { hover: true, tooltipDelay: 150, multiselect: false },
            manipulation: {
                enabled: true,
                addEdge: (edgeData, callback) => {
                    callback(null);
                    this.endLinking();
                    if (!this.isWriteMode()) {
                        this.showToast('Studio is in Read mode. Switch to Write to edit.', true);
                        return;
                    }
                    if (edgeData.from === edgeData.to) {
                        this.showToast("A node can't connect to itself", true);
                        return;
                    }
                    this.openConnectPortsModal(edgeData.from, edgeData.to);
                }
            }
        };

        this.network = new vis.Network(container, { nodes: this.visNodes, edges: this.visEdges }, options);
        this.network.once('stabilizationIterationsDone', () => {
            this.network.setOptions({ physics: { enabled: false } });
        });

        // Clamp native wheel zoom scale between 0.2x and 3.0x seamlessly without viewport shifting or shivering
        if (this.network.interactionHandler && typeof this.network.interactionHandler.zoom === 'function') {
            const origZoom = this.network.interactionHandler.zoom.bind(this.network.interactionHandler);
            this.network.interactionHandler.zoom = (scale, pointer) => {
                const clamped = Math.max(0.2, Math.min(3.0, scale));
                origZoom(clamped, pointer);
            };
        }

        this.network.on('click', (params) => {
            if (params.nodes.length) {
                this.selectedNodeId = params.nodes[0];
                this.selectedEdgeVisId = null;
                this._renderInspectorNode(this.selectedNodeId);
            } else if (params.edges.length) {
                this.selectedEdgeVisId = params.edges[0];
                this.selectedNodeId = null;
                this._renderInspectorEdge(this.selectedEdgeVisId);
            } else {
                this.resetInspector();
            }
        });

        this.network.on('doubleClick', (params) => {
            if (params.edges.length) {
                const ed = this.visEdges.get(params.edges[0])?._edgeData;
                if (ed && this.isWriteMode()) {
                    this.openSheet('connect-ports', { fromId: ed.from, toId: ed.to, edge: ed, isEdit: true });
                }
            } else if (params.nodes.length) {
                if (this.isWriteMode()) {
                    this.openSheet('add-node', { sourceId: params.nodes[0] });
                }
            }
        });
    }

    renderModelToCanvas(model) {
        if (!this.visNodes || !this.visEdges || !this.network) return;

        this.visNodes.clear();
        this.visEdges.clear();

        Object.entries(model.nodes || {}).forEach(([id, node]) => {
            this.visNodes.add({
                id,
                label: id,
                title: `${id}${node.artifactRef ? ' (' + node.artifactRef + ')' : ''}`,
                _nodeData: node
            });
        });

        (model.edges || []).forEach((edge) => {
            let label = '';
            if (edge.fromPort && edge.toPort) label = `${edge.fromPort}→${edge.toPort}`;
            else if (edge.config && edge.config.transformSrc) label = '@map';
            this.visEdges.add({ from: edge.from, to: edge.to, label, _edgeData: edge });
        });

        this.network.setOptions({ physics: { enabled: true } });
        this.network.once('stabilizationIterationsDone', () => {
            this.network.setOptions({ physics: { enabled: false } });
            this.network.fit({ animation: { duration: 350, easingFunction: 'easeInOutQuad' } });
        });
        this.network.stabilize();
        this._updateStatusBar();
        this.resetInspector();
    }

    /* ── Inspector Panel ── */
    _renderInspectorNode(id) {
        const n = this.graphModel.nodes[id];
        if (!n) { this.resetInspector(); return; }

        const inspDot = document.getElementById('insp-dot');
        const inspTitle = document.getElementById('insp-title');
        const inspBody = document.getElementById('insp-body');
        const inspActions = document.getElementById('insp-actions');
        const isWrite = this.isWriteMode();

        if (inspDot) inspDot.className = 'inspector-kind-dot node';
        if (inspTitle) inspTitle.textContent = id;

        const rows = [
            ['artifact', this._escape(n.artifactRef)],
            ['version', this._escape(n.version)],
            ...Object.entries(n.preset || {}).map(([k, v]) => [`state.${k}`, this._formatVal(v)]),
            ...Object.entries(n.staticInputs || {}).map(([k, v]) => [`input.${k}`, this._formatVal(v)])
        ];

        if (inspBody) {
            inspBody.innerHTML = rows.map(([k, v]) => `
                <div class="insp-row">
                    <span class="insp-key">${this._escape(k)}</span>
                    <span class="insp-val">${v}</span>
                </div>
            `).join('');
        }

        if (inspActions) {
            inspActions.innerHTML = isWrite ? `
                <button class="insp-btn primary" id="insp-connect-new">＋ Connect New Node</button>
                <button class="insp-btn danger" id="insp-delete-node">Delete Node</button>
            ` : `<div class="insp-empty">Read-only mode active</div>`;
        }
    }

    _renderInspectorEdge(visId) {
        const e = this.visEdges.get(visId);
        if (!e) { this.resetInspector(); return; }
        const ed = e._edgeData;

        const inspDot = document.getElementById('insp-dot');
        const inspTitle = document.getElementById('insp-title');
        const inspBody = document.getElementById('insp-body');
        const inspActions = document.getElementById('insp-actions');
        const isWrite = this.isWriteMode();

        if (inspDot) inspDot.className = 'inspector-kind-dot edge';
        if (inspTitle) inspTitle.textContent = `${ed.from} → ${ed.to}`;

        const rows = [
            ['from', this._escape(ed.from)],
            ['to', this._escape(ed.to)],
            ...(ed.fromPort ? [['fromPort', this._escape(ed.fromPort)]] : []),
            ...(ed.toPort ? [['toPort', this._escape(ed.toPort)]] : []),
            ...(ed.config?.transformSrc ? [['@map', `<span class="insp-badge">fn</span>`]] : [])
        ];

        if (inspBody) {
            inspBody.innerHTML = rows.map(([k, v]) => `
                <div class="insp-row">
                    <span class="insp-key">${this._escape(k)}</span>
                    <span class="insp-val">${v}</span>
                </div>
            `).join('');
        }

        if (inspActions) {
            inspActions.innerHTML = isWrite ? `
                <button class="insp-btn primary" id="insp-insert-node">＋ Insert Node</button>
                <button class="insp-btn" id="insp-edit-ports">Edit Ports</button>
                <button class="insp-btn danger" id="insp-delete-edge">Delete Edge</button>
            ` : `<div class="insp-empty">Read-only mode active</div>`;
        }
    }

    resetInspector() {
        this.selectedNodeId = null;
        this.selectedEdgeVisId = null;
        this.network?.unselectAll();

        const inspDot = document.getElementById('insp-dot');
        const inspTitle = document.getElementById('insp-title');
        const inspBody = document.getElementById('insp-body');
        const inspActions = document.getElementById('insp-actions');
        const isWrite = this.isWriteMode();

        if (inspDot) inspDot.className = 'inspector-kind-dot';
        if (inspTitle) inspTitle.textContent = 'Graph overview';

        const nc = Object.keys(this.graphModel.nodes || {}).length;
        const ec = (this.graphModel.edges || []).length;

        if (inspBody) {
            inspBody.innerHTML = `
                <div class="insp-row"><span class="insp-key">name</span><span class="insp-val">${this._escape(this.graphModel.meta.name)}</span></div>
                <div class="insp-row"><span class="insp-key">nodes</span><span class="insp-val">${nc}</span></div>
                <div class="insp-row"><span class="insp-key">edges</span><span class="insp-val">${ec}</span></div>
            `;
        }

        if (inspActions) {
            inspActions.innerHTML = isWrite ? `
                <button class="insp-btn primary" id="insp-add-node">＋ Add Node</button>
            ` : `<div class="insp-empty">Read-only mode active</div>`;
        }
    }

    /* ── NDL Parsing & Serialization (with Fail-Safe Error Handling) ── */
    parseNDL(ndlString) {
        if (!ndlString || typeof ndlString !== 'string') {
            throw new Error('Empty or invalid NDL source');
        }

        const lines = ndlString.split('\n');
        const minIndent = lines
            .filter(l => l.trim())
            .reduce((min, l) => Math.min(min, l.match(/^(\s*)/)[1].length), Infinity);
        const normalized = lines.map(l => (minIndent < Infinity ? l.slice(minIndent) : l)).join('\n');

        if (!normalized.trim()) throw new Error('Empty NDL graph definition');

        const source = { meta: { name: 'graph', version: '1.0.0', author: '' }, nodes: {}, edges: [] };
        let currentNode = null, lineNumber = 0;

        for (const raw of normalized.split('\n')) {
            lineNumber++;
            const line = raw.replace(/#.*$/, '').trimEnd();
            const trimmed = line.trim();
            if (!trimmed) { currentNode = null; continue; }

            if (/^graph\s/.test(trimmed)) {
                const nm = trimmed.match(/^graph\s+(\S+)/);
                if (nm) source.meta.name = nm[1];
                const vm = trimmed.match(/@version:(\S+)/);
                if (vm) source.meta.version = vm[1];
                const am = trimmed.match(/@author:(.+)$/);
                if (am) source.meta.author = am[1].trim();
                continue;
            }

            const isIndented = line.startsWith(' ') || line.startsWith('\t');

            if (/^node\s/.test(trimmed) && !isIndented) {
                const m = trimmed.match(/^node\s+(\S+)\s+@([^:\s]+)(?::(\S+))?/);
                if (!m) throw new Error(`Invalid node syntax at line ${lineNumber}: "${trimmed}"`);
                currentNode = { _id: m[1], artifactRef: m[2], version: m[3] || 'latest', preset: {}, staticInputs: {} };
                if (source.nodes[m[1]]) throw new Error(`Duplicate node ID "${m[1]}" at line ${lineNumber}`);
                source.nodes[m[1]] = currentNode;
                continue;
            }
            if (isIndented && currentNode) {
                const stateM = trimmed.match(/^state\s+(\S+)\s*=\s*(.+)$/);
                if (stateM) { 
                    try {
                        currentNode.preset[stateM[1]] = this._parseNdlVal(stateM[2].trim(), lineNumber); 
                    } catch (e) {
                        throw new Error(`Invalid state value at line ${lineNumber}: ${e.message}`);
                    }
                    continue; 
                }
                const inputM = trimmed.match(/^input\s+(\S+)\s*=\s*(.+)$/);
                if (inputM) { 
                    try {
                        currentNode.staticInputs[inputM[1]] = this._parseNdlVal(inputM[2].trim(), lineNumber); 
                    } catch (e) {
                        throw new Error(`Invalid input value at line ${lineNumber}: ${e.message}`);
                    }
                    continue; 
                }
                continue;
            }
            if (trimmed.includes('->')) {
                source.edges.push(this._parseNdlEdge(trimmed, lineNumber));
                continue;
            }

            if (!trimmed.startsWith('#')) {
                throw new Error(`Unrecognized NDL statement at line ${lineNumber}: "${trimmed}"`);
            }
        }
        return source;
    }

    _parseNdlEdge(line, lineNumber) {
        const arrowIdx = line.indexOf('->');
        const left = line.slice(0, arrowIdx).trim();
        let right = line.slice(arrowIdx + 2).trim();
        let transformSrc = null;
        const mapMatch = right.match(/@map:["'](.+?)["']\s*$/);
        if (mapMatch) { transformSrc = mapMatch[1]; right = right.slice(0, right.lastIndexOf('@map:')).trim(); }
        const [from, fromPort] = this._splitPort(left);
        const [to, toPort] = this._splitPort(right);
        if (!from || !to) throw new Error(`Invalid edge at line ${lineNumber}: "${line}"`);
        return { from, fromPort, to, toPort, config: transformSrc ? { transformSrc } : {} };
    }

    _splitPort(token) {
        const i = token.indexOf('.');
        return i === -1 ? [token, null] : [token.slice(0, i), token.slice(i + 1)];
    }

    _parseNdlVal(raw, lineNumber) {
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try { return JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON syntax at line ${lineNumber}`); }
        }
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        if (raw === 'null') return null;
        if (!isNaN(Number(raw)) && raw !== '') return Number(raw);
        return raw;
    }

    serializeNDL(model) {
        const lines = [];
        lines.push(`graph ${model.meta.name || 'graph'} @version:${model.meta.version || '1.0.0'}${model.meta.author ? ' @author:' + model.meta.author : ''}`);
        lines.push('');
        Object.entries(model.nodes || {}).forEach(([id, n]) => {
            lines.push(`node ${id} @${n.artifactRef}:${n.version}`);
            Object.entries(n.preset || {}).forEach(([k, v]) => lines.push(`  state ${k} = ${JSON.stringify(v)}`));
            Object.entries(n.staticInputs || {}).forEach(([k, v]) => lines.push(`  input ${k} = ${JSON.stringify(v)}`));
            lines.push('');
        });
        (model.edges || []).forEach(e => {
            const left = e.fromPort ? `${e.from}.${e.fromPort}` : e.from;
            const right = e.toPort ? `${e.to}.${e.toPort}` : e.to;
            const extra = e.config?.transformSrc ? ` @map:"${e.config.transformSrc}"` : '';
            lines.push(`${left} -> ${right}${extra}`);
        });
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    applyCode(silent = false, sourceText = null) {
        const errHintEl = typeof document !== 'undefined' ? document.getElementById('ndl-error-hint') : null;
        try {
            const text = sourceText !== null ? sourceText : (this.editorView ? this.editorView.state.doc.toString() : (this.getActiveGraph()?.ndl || ''));
            if (!text && !this.editorView) return false;
            const model = this.parseNDL(text || '');
            this.graphModel = model;

            const rt = this.getActiveRuntime();
            const g = this.getActiveGraph();
            if (rt && g) g.ndl = text;

            if (errHintEl) {
                errHintEl.style.display = 'none';
                errHintEl.textContent = '';
            }

            if (silent) this._updateStatusBar();
            else this.renderModelToCanvas(this.graphModel);
            return true;
        } catch (err) {
            // Fail-safe: display error hint without breaking canvas or throwing
            if (errHintEl) {
                errHintEl.style.display = 'inline-block';
                errHintEl.textContent = `⚠ ${err.message}`;
            }
            if (!silent) {
                this.showToast(`NDL Syntax: ${err.message}`, true);
            }
            return false;
        }
    }

    handleCodeChange(code = null) {
        clearTimeout(this._autoParseTimer);
        this._autoParseTimer = setTimeout(() => {
            this.applyCode(true, code);
        }, 300);
    }

    syncModelToCode() {
        const text = this.serializeNDL(this.graphModel);
        if (this.editorView) {
            this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: text } });
        }
        const g = this.getActiveGraph();
        if (g) g.ndl = text;
        this._updateStatusBar();
    }

    loadGraph(runtimeId, graphId) {
        const rt = this.state.getValue(`/runtimes/${runtimeId}`);
        if (!rt || !rt.graphs?.[graphId]) return;

        this.state.setValue(runtimeId, '/activeRuntimeId');
        this.state.setValue(graphId, '/activeGraphId');

        const g = rt.graphs[graphId];
        if (this.editorView) {
            this.editorView.dispatch({ changes: { from: 0, to: this.editorView.state.doc.length, insert: g.ndl || '' } });
        }
        this.applyCode(false, g.ndl || '');
        this.renderAll();
    }

    getActiveGraph() {
        const rt = this.getActiveRuntime();
        const gId = this.state.getValue('/activeGraphId');
        return rt?.graphs?.[gId] || null;
    }

    /* ── Add & Deploy Graph ── */
    addGraph({ id, label, version = '1.0.0', templateNdl = null }) {
        const rt = this.getActiveRuntime();
        if (!rt) {
            this.showToast('No active runtime connected', true);
            return;
        }
        if (!rt.graphs) rt.graphs = {};

        const cleanId = id.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        const ndl = templateNdl || `graph ${cleanId} @version:${version}\n\n`;

        rt.graphs[cleanId] = {
            id: cleanId,
            label: label || cleanId,
            version: version,
            description: 'Custom graph',
            ndl
        };

        this.loadGraph(rt.id, cleanId);
        this.renderAll();
        this.showToast(`Created graph "${cleanId}"`);
    }

    async deployActiveGraph() {
        const rt = this.getActiveRuntime();
        const g = this.getActiveGraph();
        if (!rt || !g) {
            this.showToast('No active graph selected to deploy', true);
            return;
        }

        // Always compile visual model to NDL source first
        this.syncModelToCode();
        const ndlCode = this.editorView ? this.editorView.state.doc.toString() : (g.ndl || '');
        g.ndl = ndlCode;
        this.startMutation(`Deploy graph ${g.id}`);

        try {
            await this.execRuntimeAction('library.push', {
                artifact: {
                    id: g.id,
                    version: g.version || 'v1',
                    artifactType: 'graph',
                    sourceType: 'text/x-ndl',
                    source: ndlCode,
                    metadata: {
                        name: g.label || g.id,
                        description: g.description || 'Custom graph created in Nodaic Studio',
                        tags: ['user', 'graph']
                    }
                }
            });
            await this.syncLibraryAndGraphsFromRuntime();
            this.renderAll();
            this.completeMutation(`Deploy graph ${g.id}`);
            this.showToast(`✓ Graph "${g.id}" deployed to runtime backend!`);
            this.logEvent('Deploy', 'library', `✓ Successfully deployed graph "${g.id}" (v${g.version || '1.0.0'}) to ${rt.label}`, 'OK');
        } catch (err) {
            if (err.message && err.message.includes('Static mode')) {
                this.completeMutation(`Save graph ${g.id}`);
                this.showToast(`Graph "${g.id}" saved in Studio session (Runtime is in static mode)`);
                this.logEvent('Deploy', 'library', `Runtime is in static mode. Graph "${g.id}" is saved in Studio session.`, 'WARN');
            } else {
                this.failMutation(`Deploy graph ${g.id}`, err);
            }
        }
    }

    /* ── Destructive Action Confirmation Modal (§11) ── */
    confirmDestructiveAction(title, message, onConfirm) {
        const overlay = document.getElementById('confirm-overlay');
        const modalTitle = document.getElementById('confirm-title');
        const modalMsg = document.getElementById('confirm-msg');

        if (!overlay) return;

        modalTitle.textContent = title;
        modalMsg.textContent = message;
        this.confirmCallback = onConfirm;

        overlay.classList.add('open');
    }

    closeConfirmModal() {
        const overlay = document.getElementById('confirm-overlay');
        if (overlay) overlay.classList.remove('open');
        this.confirmCallback = null;
    }

    /* ── Crud Operations ── */
    switchRuntime(id) {
        const rt = this.state.getValue(`/runtimes/${id}`);
        if (!rt) return;

        this.state.setValue(id, '/activeRuntimeId');
        const graphs = Object.keys(rt.graphs || {});
        if (graphs.length) {
            this.loadGraph(id, graphs[0]);
        }

        this.syncActiveRuntime();
        this.renderAll();
        this.logEvent('System', 'system', `Switched active runtime to "${rt.label}" (${id})`, 'OK');
    }

    async addRole({ name, isAdmin, roleType = 'device', scopes = [] }) {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        this.startMutation(`Create Role Key ${name}`);
        try {
            const res = await this.execRuntimeAction('auth.keys.create', { role: roleType, keyId: name, scopes });
            if (!rt.roles) rt.roles = {};
            rt.roles[name] = { name: res.name || name, isAdmin: res.isAdmin, role: res.role, scopes: res.scopes || scopes, token: res.token };
            this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
            this.completeMutation(`Create Role Key ${name}`);
            this.showToast(`Created role token "${name}"`);
            this.logEvent('Auth', 'system', `🔑 Created ${res.role} token (${res.name}): ${res.token}`, 'OK');
        } catch (e) {
            this.failMutation(`Create Role ${name}`, e);
        }
    }

    async updateRole({ name, roleType, scopes, regenerateToken }) {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        this.startMutation(`Update Role Key ${name}`);
        try {
            const res = await this.execRuntimeAction('auth.keys.update', { keyId: name, role: roleType, scopes, regenerateToken });
            if (!rt.roles) rt.roles = {};
            const existing = rt.roles[name] || {};
            rt.roles[name] = {
                ...existing,
                name: res.name || name,
                isAdmin: res.isAdmin,
                role: res.role,
                scopes: res.scopes || scopes,
                hint: res.hint || existing.hint,
                token: res.token || existing.token
            };
            this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
            this.completeMutation(`Update Role Key ${name}`);
            this.showToast(`Updated role key "${name}"`);
            this.logEvent('Auth', 'system', `🔑 Updated role "${name}" -> [${res.role}] scopes: [${(res.scopes || []).join(', ')}]${res.token ? ' (Token regenerated)' : ''}`, 'OK');
        } catch (e) {
            this.failMutation(`Update Role ${name}`, e);
        }
    }

    async deleteRole(name) {
        this.confirmDestructiveAction(
            `Revoke Role "${name}"`,
            `Are you sure you want to revoke role key "${name}"? All sessions using this token will be invalidated.`,
            async () => {
                const rt = this.getActiveRuntime();
                if (!rt) return;
                this.startMutation(`Revoke Role ${name}`);
                try {
                    await this.execRuntimeAction('auth.keys.revoke', { keyId: name });
                    delete rt.roles[name];
                    this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
                    this.completeMutation(`Revoke Role ${name}`);
                    this.showToast(`Revoked role "${name}"`);
                } catch (e) {
                    this.failMutation(`Revoke Role ${name}`, e);
                }
            }
        );
    }

    getRolesList() {
        const rt = this.getActiveRuntime();
        return Object.values(rt?.roles || {});
    }

    async setSecret(key, value, description = '') {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        this.startMutation(`Save Secret ${key}`);
        try {
            await this.execRuntimeAction('auth.credentials.set', { credId: key, secret: value });
            if (!rt.secrets) rt.secrets = {};
            rt.secrets[key] = { key, value, description, revealed: false };
            this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
            this.completeMutation(`Save Secret ${key}`);
            this.showToast(`Secret "${key}" stored safely`);
        } catch (e) {
            this.failMutation(`Save Secret ${key}`, e);
        }
    }

    getSecret(key) {
        const rt = this.getActiveRuntime();
        return rt?.secrets?.[key] || null;
    }

    getSecretsList() {
        const rt = this.getActiveRuntime();
        return Object.values(rt?.secrets || {});
    }

    async deleteSecret(key) {
        this.confirmDestructiveAction(
            `Delete Secret "${key}"`,
            `Are you sure you want to delete secret "${key}" from runtime backend?`,
            async () => {
                const rt = this.getActiveRuntime();
                if (!rt) return;
                this.startMutation(`Delete Secret ${key}`);
                try {
                    await this.execRuntimeAction('auth.credentials.delete', { credId: key });
                    delete rt.secrets[key];
                    this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
                    this.completeMutation(`Delete Secret ${key}`);
                    this.showToast(`Deleted secret "${key}"`);
                } catch (e) {
                    this.failMutation(`Delete Secret ${key}`, e);
                }
            }
        );
    }

    async addTrigger({ event, artifact, access, delivery = 'trigger', once = false, oldEvent = null }) {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        this.startMutation(`Save Trigger ${event}`);
        try {
            // If artifact is a graph in rt.graphs, ensure it is deployed to runtime library first
            const g = rt.graphs?.[artifact];
            if (g) {
                const ndlCode = (this.getActiveGraph()?.id === g.id && this.editorView)
                    ? this.editorView.state.doc.toString()
                    : (g.ndl || `graph ${g.id} @version:${g.version || '1.0.0'}\n`);

                try {
                    await this.execRuntimeAction('library.push', {
                        artifact: {
                            id: g.id,
                            version: g.version || '1.0.0',
                            artifactType: 'graph',
                            sourceType: 'text/x-ndl',
                            source: ndlCode,
                            metadata: {
                                name: g.label || g.id,
                                description: g.description || 'Custom graph bound to trigger',
                                tags: ['user', 'graph']
                            }
                        }
                    });
                } catch (pushErr) {
                    console.warn('[addTrigger] Auto-deploy graph warning:', pushErr.message);
                }
            }

            const roles = access?.roles || ['admin', 'device'];
            await this.execRuntimeAction('trigger.bind', {
                event,
                artifactId: artifact,
                access: { mode: 'allow', roles },
                roles,
                delivery,
                once,
                oldEvent
            });

            if (!rt.triggers) rt.triggers = {};
            if (oldEvent && oldEvent !== event) {
                delete rt.triggers[oldEvent];
            }
            rt.triggers[event] = {
                event,
                artifact,
                access: { mode: 'allow', roles },
                roles,
                delivery,
                once
            };
            this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
            this.completeMutation(`Save Trigger ${event}`);
            this.showToast(`Trigger "${event}" saved successfully`);
        } catch (e) {
            this.failMutation(`Save Trigger ${event}`, e);
        }
    }


    getTriggersList() {
        const rt = this.getActiveRuntime();
        return Object.values(rt?.triggers || {});
    }

    async deleteTrigger(event) {
        this.confirmDestructiveAction(
            `Unbind Trigger "${event}"`,
            `Are you sure you want to unbind event "${event}"?`,
            async () => {
                const rt = this.getActiveRuntime();
                if (!rt) return;
                this.startMutation(`Unbind Trigger ${event}`);
                try {
                    await this.execRuntimeAction('trigger.unbind', { event });
                    delete rt.triggers[event];
                    this.state.setValue({ ...this.state.getValue('/runtimes') }, '/runtimes');
                    this.completeMutation(`Unbind Trigger ${event}`);
                    this.showToast(`Unbound event "${event}"`);
                } catch (e) {
                    this.failMutation(`Unbind Trigger ${event}`, e);
                }
            }
        );
    }

    async emitTrigger(event, payload = {}) {
        const rt = this.getActiveRuntime();
        if (!rt) return;
        this.logEvent('Trigger', 'rxtx', `[Emit] Trigger "${event}": ${JSON.stringify(payload)}`, 'TX');
        try {
            const res = await this.execRuntimeAction('trigger.emit', { event, data: payload });
            this.showToast(`Trigger "${event}" emitted`);
            this.logEvent('Trigger', 'rxtx', `[Done] Trigger outputs: ${JSON.stringify(res.outputs)}`, 'RX');
        } catch (e) {
            this.showToast(`Emit failed: ${e.message}`, true);
        }
    }

    getRuntimesList() {
        return Object.values(this.state.getValue('/runtimes') || {});
    }

    /* ── Modeler Interactions & Linking ── */
    startLinking() {
        if (!this.isWriteMode()) {
            this.showToast('Switch to Write mode to link nodes', true);
            return;
        }
        this.linking = true;
        document.getElementById('connect-hint')?.classList.add('show');
        this.network?.addEdgeMode();
    }

    endLinking() {
        this.linking = false;
        document.getElementById('connect-hint')?.classList.remove('show');
        this.network?.disableEditMode();
    }

    openConnectPortsModal(fromId, toId) {
        this.openSheet('connect-ports', { fromId, toId });
    }

    openSheet(mode, params = {}) {
        this.sheetState = { mode, ...params };
        const overlay = document.getElementById('sheet-overlay');
        const titleEl = document.getElementById('sheet-title');
        const subEl = document.getElementById('sheet-sub');
        const bodyEl = document.getElementById('sheet-body');
        const footEl = document.getElementById('sheet-foot');

        if (!overlay) return;

        if (mode === 'add-graph') {
            titleEl.textContent = 'Create New Graph';
            subEl.textContent = 'Add a new workflow graph to runtime library';
            this._renderAddGraphSheet(bodyEl, footEl);
        } else if (mode === 'add-node') {
            titleEl.textContent = params.sourceId ? 'Connect New Node' : (params.insertOnEdge ? 'Insert Node on Connection' : 'Add Node from Library');
            subEl.textContent = 'Select registered process node from runtime library';
            this._renderBrowseLibrarySheet(bodyEl, footEl, params);
        } else if (mode === 'connect-ports') {
            const isEdit = Boolean(params.isEdit || params.edge);
            titleEl.textContent = isEdit ? 'Edit Port Connection' : 'Connect Ports';
            subEl.textContent = `${params.fromId} → ${params.toId}`;
            this._renderConnectPortsSheet(bodyEl, footEl, params);
        } else if (mode === 'run-graph') {
            const g = params.graph || this.getActiveGraph();
            titleEl.textContent = 'Run Graph';
            subEl.textContent = `Configure input payload and execute "${g?.label || g?.id || 'graph'}"`;
            document.getElementById('sheet')?.classList.add('sheet-wide');
            this._renderRunGraphSheet(bodyEl, footEl, g);
        } else if (mode === 'add-runtime' || mode === 'edit-runtime') {
            const isEdit = mode === 'edit-runtime';
            titleEl.textContent = isEdit ? 'Configure Runtime' : 'Connect Runtime';
            subEl.textContent = isEdit
                ? `Edit endpoint URL, auth token, and settings for "${params?.runtime?.label || params?.runtime?.id || 'runtime'}"`
                : 'Provide URL & Auth Token for runtime verification';
            this._renderAddRuntimeSheet(bodyEl, footEl, params?.runtime || null);
        } else if (mode === 'add-secret') {
            titleEl.textContent = 'Add Secret';
            subEl.textContent = 'Store encrypted credential on runtime backend';
            this._renderAddSecretSheet(bodyEl, footEl);
        } else if (mode === 'add-role') {
            titleEl.textContent = 'Generate Role Key';
            subEl.textContent = 'Create token on active runtime';
            this._renderAddRoleSheet(bodyEl, footEl);
        } else if (mode === 'edit-role') {
            titleEl.textContent = 'Edit Role Key';
            subEl.textContent = `Update role privilege, action scopes, or token for ${params?.role?.name || ''}`;
            this._renderEditRoleSheet(bodyEl, footEl, params?.role || null);
        } else if (mode === 'add-trigger' || mode === 'edit-trigger') {
            const isEdit = mode === 'edit-trigger';
            titleEl.textContent = isEdit ? 'Edit Event Trigger' : 'Bind Event Trigger';
            subEl.textContent = isEdit ? 'Update event mapping and role-based access' : 'Map webhook / event 1:1 to library artifact';
            this._renderAddTriggerSheet(bodyEl, footEl, params?.trigger || null);
        }

        overlay.classList.add('open');
    }

    closeSheet() {
        const overlay = document.getElementById('sheet-overlay');
        if (overlay) overlay.classList.remove('open');
        document.getElementById('sheet')?.classList.remove('sheet-wide');
        this.sheetState = null;
    }

    _renderAddGraphSheet(bodyEl, footEl) {
        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Graph Identifier (ID)</label>
                <input class="field-input" id="new-graph-id" placeholder="e.g. order-pipeline or custom-service" style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Display Name / Title</label>
                <input class="field-input" id="new-graph-name" placeholder="e.g. Order Processing Pipeline" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Starter Template</label>
                <select class="field-select" id="new-graph-template">
                    <option value="blank">Blank Graph</option>
                    <option value="pipeline">Validation &amp; Transform Pipeline</option>
                    <option value="webhook">Webhook Receiver &amp; Logger</option>
                    <option value="http">HTTP Fetch &amp; Retry</option>
                </select>
            </div>
        `;
        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="new-graph-save-btn">Create &amp; Open Graph</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('new-graph-save-btn')?.addEventListener('click', () => {
            const rawId = document.getElementById('new-graph-id').value.trim();
            const label = document.getElementById('new-graph-name').value.trim() || rawId;
            const template = document.getElementById('new-graph-template').value;

            if (!rawId) {
                this.showToast('Graph ID is required', true);
                return;
            }

            const cleanId = rawId.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
            let starterNdl = `graph ${cleanId} @version:1.0.0\n\n`;

            if (template === 'pipeline') {
                starterNdl = `graph ${cleanId} @version:1.0.0\n\nnode validator @validate\n  state schema = { id: { type: "string", required: true } }\nnode processor @transform\nnode sink @parseResponse\n\nvalidator.result -> processor.data\nprocessor.result -> sink.data\n`;
            } else if (template === 'webhook') {
                starterNdl = `graph ${cleanId} @version:1.0.0\n\nnode receiver @parseRequest\nnode logger @log-process\n\nreceiver.body -> logger.data\n`;
            } else if (template === 'http') {
                starterNdl = `graph ${cleanId} @version:1.0.0\n\nnode fetcher @http\nnode retrier @retry\n\nfetcher.status -> retrier.fn\n`;
            }

            this.addGraph({ id: cleanId, label, version: '1.0.0', templateNdl: starterNdl });
            this.closeSheet();
        });
    }

    _renderBrowseLibrarySheet(bodyEl, footEl, params) {
        const artifacts = this.library || [];
        bodyEl.innerHTML = `
            <input class="field-input" id="lib-search" placeholder="Search library nodes by name or artifact..." style="margin-bottom:12px" autocomplete="off">
            <div class="lib-cards-list" id="lib-cards-list">
                ${artifacts.length ? artifacts.map(a => `
                    <div class="lib-card" data-pick-artifact="${a.ref}">
                        <div style="flex:1; min-width:0">
                            <div class="lib-card-title">
                                <span>${this._escape(a.label)}</span>
                                <span class="lib-card-badge">${this._escape(a.category)}</span>
                            </div>
                            <div class="lib-card-sub">
                                ${this._escape(a.ref)}${a.inputs?.length || a.outputs?.length ? ` · ${a.inputs.map(x => x.name).join(', ') || 'no in'} → ${a.outputs.map(x => x.name).join(', ') || 'no out'}` : ''}
                            </div>
                        </div>
                        <span class="lib-card-arrow">→</span>
                    </div>
                `).join('') : '<div class="side-empty" style="text-align:center; padding:24px 0; color:var(--ink-4)">No library artifacts loaded from runtime.</div>'}
            </div>
        `;
        footEl.innerHTML = `
            <div style="display:flex; justify-content:flex-end; width:100%">
                <button type="button" class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            </div>
        `;

        const searchInput = document.getElementById('lib-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const q = e.target.value.toLowerCase();
                document.querySelectorAll('#lib-cards-list [data-pick-artifact]').forEach(el => {
                    const txt = el.textContent.toLowerCase();
                    el.style.display = txt.includes(q) ? 'flex' : 'none';
                });
            });
        }

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.querySelectorAll('[data-pick-artifact]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const ref = e.currentTarget.dataset.pickArtifact;
                const lib = this.library.find(x => x.ref === ref);
                if (lib) this._addNodeFromLib(lib, params.sourceId, params.insertOnEdge);
                this.closeSheet();
            });
        });
    }

    _addNodeFromLib(lib, sourceId, insertOnEdge) {
        const baseName = lib.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        let id = baseName;
        let i = 1;
        while (this.graphModel.nodes[id]) {
            id = `${baseName}-${i++}`;
        }

        this.graphModel.nodes[id] = {
            artifactRef: lib.ref,
            version: lib.versions[0] || '1.0.0',
            preset: { ...(lib.defaultState || {}) },
            staticInputs: {}
        };

        if (insertOnEdge) {
            const edgeIdx = this.graphModel.edges.indexOf(insertOnEdge);
            if (edgeIdx > -1) {
                this.graphModel.edges.splice(edgeIdx, 1);
            }
            const inPort = lib.inputs[0]?.name || null;
            const outPort = lib.outputs[0]?.name || null;
            this.graphModel.edges.push({ from: insertOnEdge.from, fromPort: insertOnEdge.fromPort, to: id, toPort: inPort, config: {} });
            this.graphModel.edges.push({ from: id, fromPort: outPort, to: insertOnEdge.to, toPort: insertOnEdge.toPort, config: {} });
        } else if (sourceId) {
            const fromPort = lib.outputs[0]?.name || null;
            const toPort = lib.inputs[0]?.name || null;
            this.graphModel.edges.push({ from: sourceId, fromPort, to: id, toPort, config: {} });
        }

        this.syncModelToCode();
        this.renderModelToCanvas(this.graphModel);
        this.showToast(`Added node "${id}"`);
    }

    _renderConnectPortsSheet(bodyEl, footEl, params) {
        const fromN = this.graphModel.nodes[params.fromId];
        const toN = this.graphModel.nodes[params.toId];
        const fromLib = this.library.find(x => x.ref === fromN?.artifactRef);
        const toLib = this.library.find(x => x.ref === toN?.artifactRef);

        const fromPorts = fromLib?.outputs?.length ? fromLib.outputs : [{ name: 'output', type: 'object' }];
        const toPorts = toLib?.inputs?.length ? toLib.inputs : [{ name: 'input', type: 'object' }];

        const curFromPort = params.edge?.fromPort || params.fromPort || fromPorts[0]?.name || '';
        const curToPort = params.edge?.toPort || params.toPort || toPorts[0]?.name || '';
        const curMap = params.edge?.config?.transformSrc || '';
        const isEdit = Boolean(params.isEdit || params.edge);

        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Source Node: <strong>${this._escape(params.fromId)}</strong></label>
                <label class="field-label" style="margin-top:6px;font-size:11px;color:var(--text-muted);">Source Output Port</label>
                <select class="field-select" id="conn-from-port">
                    ${fromPorts.map(p => `<option value="${this._escape(p.name)}" ${p.name === curFromPort ? 'selected' : ''}>${this._escape(p.name)} (${this._escape(p.type || 'any')})</option>`).join('')}
                </select>
            </div>
            <div class="field-group" style="margin-top:12px;">
                <label class="field-label">Target Node: <strong>${this._escape(params.toId)}</strong></label>
                <label class="field-label" style="margin-top:6px;font-size:11px;color:var(--text-muted);">Target Input Port</label>
                <select class="field-select" id="conn-to-port">
                    ${toPorts.map(p => `<option value="${this._escape(p.name)}" ${p.name === curToPort ? 'selected' : ''}>${this._escape(p.name)} (${this._escape(p.type || 'any')})</option>`).join('')}
                </select>
            </div>
            <div class="field-group" style="margin-top:12px;">
                <label class="field-label">Transform / @map Expression (Optional)</label>
                <input class="field-input mono" id="conn-map-expr" value="${this._escape(curMap)}" placeholder="e.g. data =&gt; ({ ...data, count: data.count + 1 })">
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
                    Inline JavaScript transformation applied to data passing through this connection.
                </div>
            </div>
        `;
        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="conn-confirm-btn">${isEdit ? 'Update Connection' : 'Connect'}</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('conn-confirm-btn')?.addEventListener('click', () => {
            const fromPort = document.getElementById('conn-from-port').value;
            const toPort = document.getElementById('conn-to-port').value;
            const mapExpr = document.getElementById('conn-map-expr')?.value.trim();

            if (isEdit && params.edge) {
                params.edge.fromPort = fromPort;
                params.edge.toPort = toPort;
                if (mapExpr) {
                    params.edge.config = { ...(params.edge.config || {}), transformSrc: mapExpr };
                } else if (params.edge.config) {
                    delete params.edge.config.transformSrc;
                }
                this.syncModelToCode();
                this.renderModelToCanvas(this.graphModel);
                this.closeSheet();
                if (this.selectedEdgeVisId) this._renderInspectorEdge(this.selectedEdgeVisId);
                this.showToast(`Updated connection: ${params.fromId}.${fromPort} → ${params.toId}.${toPort}`);
            } else {
                const edgeObj = { from: params.fromId, fromPort, to: params.toId, toPort, config: {} };
                if (mapExpr) edgeObj.config.transformSrc = mapExpr;
                this.graphModel.edges.push(edgeObj);
                this.syncModelToCode();
                this.renderModelToCanvas(this.graphModel);
                this.closeSheet();
                this.showToast(`Connected ${params.fromId} → ${params.toId}`);
            }
        });
    }

    _renderAddRuntimeSheet(bodyEl, footEl, existingRt = null) {
        const isEdit = Boolean(existingRt);

        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Runtime Name / Identifier</label>
                <input class="field-input" id="rt-label" value="${this._escape(existingRt ? (existingRt.label || existingRt.id) : '')}" placeholder="e.g. Production Node.js" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Runtime Endpoint URL</label>
                <input class="field-input" id="rt-url" value="${this._escape(existingRt ? existingRt.url : DEFAULT_RUNTIME_URL)}" placeholder="http://localhost:3030" style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Auth Token (Required for verification &amp; access)</label>
                <div style="position:relative;display:flex;align-items:center;width:100%">
                    <input class="field-input" id="rt-token" type="password" value="${this._escape(existingRt ? (existingRt.token || '') : DEFAULT_AUTH_TOKEN)}" placeholder="Enter auth token" style="font-family:var(--mono);padding-right:38px" autocomplete="off">
                    <button type="button" id="rt-token-toggle" class="btn-token-toggle" title="Toggle visibility" aria-label="Toggle token visibility" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--ink-4);cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:color .12s">
                        <svg id="rt-token-eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        if (isEdit) {
            footEl.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:10px">
                    <button type="button" class="sheet-btn danger" id="rt-delete-btn">Delete Runtime</button>
                    <div style="display:flex;gap:8px;align-items:center">
                        <button type="button" class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
                        <button type="button" class="sheet-btn primary" id="rt-save-btn">Save Changes</button>
                    </div>
                </div>
            `;
        } else {
            footEl.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:flex-end;width:100%;gap:8px">
                    <button type="button" class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
                    <button type="button" class="sheet-btn primary" id="rt-save-btn">Connect &amp; Verify</button>
                </div>
            `;
        }

        // Toggle auth token visibility
        const tokenInput = document.getElementById('rt-token');
        const toggleBtn = document.getElementById('rt-token-toggle');
        const eyeIcon = document.getElementById('rt-token-eye-icon');
        toggleBtn?.addEventListener('click', () => {
            if (tokenInput.type === 'password') {
                tokenInput.type = 'text';
                eyeIcon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;
            } else {
                tokenInput.type = 'password';
                eyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
            }
        });

        // Cancel
        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());

        // Delete (in edit mode)
        if (isEdit && existingRt) {
            document.getElementById('rt-delete-btn')?.addEventListener('click', () => {
                const rtName = existingRt.label || existingRt.id;
                this.confirmDestructiveAction(
                    'Delete Runtime',
                    `Are you sure you want to remove runtime "${rtName}"? This action cannot be undone.`,
                    () => {
                        const runtimes = this.state.getValue('/runtimes') || {};
                        delete runtimes[existingRt.id];
                        this.state.setValue({ ...runtimes }, '/runtimes');
                        if (this.state.getValue('/activeRuntimeId') === existingRt.id) {
                            const remaining = Object.keys(runtimes);
                            this.switchRuntime(remaining.length ? remaining[0] : null);
                        }
                        this._savePersistedState();
                        this.closeSheet();
                        this.showToast(`Deleted runtime "${rtName}"`);
                        this.renderAll();
                    }
                );
            });
        }

        // Save / Connect
        document.getElementById('rt-save-btn')?.addEventListener('click', async () => {
            const label = document.getElementById('rt-label').value.trim() || (isEdit ? (existingRt.label || 'Custom Runtime') : 'Custom Runtime');
            const url = document.getElementById('rt-url').value.trim().replace(/\/$/, '');
            const token = document.getElementById('rt-token').value.trim();

            if (!url) {
                this.showToast('Runtime URL is required', true);
                return;
            }

            const runtimes = this.state.getValue('/runtimes') || {};

            if (isEdit && existingRt) {
                const rt = runtimes[existingRt.id];
                if (rt) {
                    rt.label = label;
                    rt.url = url;
                    rt.token = token;
                    delete rt.color;
                    this.state.setValue({ ...runtimes }, '/runtimes');
                    this._savePersistedState();
                    this.closeSheet();
                    this.showToast(`Updated runtime "${label}"`);
                    if (this.state.getValue('/activeRuntimeId') === existingRt.id) {
                        await this.syncActiveRuntime();
                    }
                    this.renderAll();
                }
                return;
            }

            const id = 'rt_' + Date.now();
            const newRt = {
                id,
                label,
                url,
                token,
                capabilities: {},
                graphs: {},
                secrets: {},
                roles: {},
                triggers: {}
            };

            runtimes[id] = newRt;
            this.state.setValue({ ...runtimes }, '/runtimes');
            this.state.setValue(id, '/activeRuntimeId');
            this._savePersistedState();
            this.closeSheet();

            await this.syncActiveRuntime();
            this.renderAll();
        });
    }

    _renderAddSecretSheet(bodyEl, footEl) {
        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Secret Key Name (credId)</label>
                <input class="field-input" id="sec-key" placeholder="e.g. STRIPE_API_KEY" style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Secret Value</label>
                <input class="field-input" id="sec-val" type="password" placeholder="secret value..." style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Description (Optional)</label>
                <input class="field-input" id="sec-desc" placeholder="e.g. Payment gateway secret key" autocomplete="off">
            </div>
        `;
        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="sec-save-btn">Save Secret</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('sec-save-btn')?.addEventListener('click', async () => {
            const key = document.getElementById('sec-key').value.trim();
            const val = document.getElementById('sec-val').value;
            const desc = document.getElementById('sec-desc').value.trim();
            if (!key || val === undefined) {
                this.showToast('Key and value required', true);
                return;
            }
            await this.setSecret(key, val, desc);
            this.closeSheet();
        });
    }

    _renderAddRoleSheet(bodyEl, footEl) {
        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Key Identifier / Name</label>
                <input class="field-input" id="role-name" placeholder="e.g. ops_runner_1" style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Role Privilege / Preset</label>
                <select class="field-select" id="role-type">
                    <option value="developer">💻 Developer (Build, Edit &amp; Test Graphs, Processes &amp; Triggers)</option>
                    <option value="operator">⚙️ Operator (Workflows, Triggers &amp; Execution Monitoring)</option>
                    <option value="device" selected>📱 Device / Runner (Automated API Execution &amp; Triggers)</option>
                    <option value="viewer">👁️ Auditor / Viewer (Read-Only Status, Library &amp; Runs)</option>
                    <option value="admin">👑 Admin (Full System Control, Keys &amp; Secrets)</option>
                </select>
            </div>
            <div class="field-group">
                <label class="field-label">Custom Action Scopes (Optional, comma-separated)</label>
                <input class="field-input" id="role-scopes" placeholder="e.g. run:*, trigger:emit, library:read" style="font-family:var(--mono)">
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
                    Leave blank to use default role preset scopes. Wildcards like <code>run:*</code> and <code>trigger:*</code> are supported.
                </div>
            </div>
        `;
        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="role-save-btn">Generate Token</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('role-save-btn')?.addEventListener('click', async () => {
            const name = document.getElementById('role-name').value.trim() || undefined;
            const roleType = document.getElementById('role-type').value;
            const scopesRaw = document.getElementById('role-scopes').value.trim();
            const scopes = scopesRaw ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            await this.addRole({ name, isAdmin: roleType === 'admin', roleType, scopes });
            this.closeSheet();
        });
    }

    _renderEditRoleSheet(bodyEl, footEl, role) {
        const currentRoleType = (role?.role || (role?.isAdmin ? 'admin' : 'device')).toLowerCase();
        const currentScopes = (role?.scopes && role.scopes.length) ? role.scopes.join(', ') : '';

        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Key Identifier</label>
                <input class="field-input mono" id="edit-role-name" value="${this._escape(role?.name || '')}" readonly style="background:var(--bg-active);opacity:0.85;">
            </div>
            <div class="field-group">
                <label class="field-label">Role Privilege / Preset</label>
                <select class="field-select" id="edit-role-type">
                    <option value="developer" ${currentRoleType === 'developer' ? 'selected' : ''}>💻 Developer (Build, Edit &amp; Test Graphs, Processes &amp; Triggers)</option>
                    <option value="operator" ${currentRoleType === 'operator' ? 'selected' : ''}>⚙️ Operator (Workflows, Triggers &amp; Execution Monitoring)</option>
                    <option value="device" ${currentRoleType === 'device' ? 'selected' : ''}>📱 Device / Runner (Automated API Execution &amp; Triggers)</option>
                    <option value="viewer" ${currentRoleType === 'viewer' ? 'selected' : ''}>👁️ Auditor / Viewer (Read-Only Status, Library &amp; Runs)</option>
                    <option value="admin" ${currentRoleType === 'admin' ? 'selected' : ''}>👑 Admin (Full System Control, Keys &amp; Secrets)</option>
                </select>
            </div>
            <div class="field-group">
                <label class="field-label">Custom Action Scopes (Optional, comma-separated)</label>
                <input class="field-input mono" id="edit-role-scopes" value="${this._escape(currentScopes)}" placeholder="e.g. run:*, trigger:emit, library:read">
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
                    Leave blank to use default role preset scopes. Wildcards like <code>run:*</code> and <code>trigger:*</code> are supported.
                </div>
            </div>
            <div class="field-group" style="margin-top:12px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);cursor:pointer;">
                    <input type="checkbox" id="edit-role-regenerate" style="accent-color:var(--accent);">
                    <span>Regenerate API Token (invalidates existing token for this key)</span>
                </label>
            </div>
        `;
        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="edit-role-save-btn">Save Changes</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('edit-role-save-btn')?.addEventListener('click', async () => {
            const name = document.getElementById('edit-role-name').value.trim();
            const roleType = document.getElementById('edit-role-type').value;
            const scopesRaw = document.getElementById('edit-role-scopes').value.trim();
            const scopes = scopesRaw ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            const regenerateToken = Boolean(document.getElementById('edit-role-regenerate')?.checked);
            await this.updateRole({ name, roleType, scopes, regenerateToken });
            this.closeSheet();
        });
    }

    _renderAddTriggerSheet(bodyEl, footEl, existingTrigger = null) {
        const rt = this.getActiveRuntime();
        const existingTriggers = Object.values(rt?.triggers || {});
        const isEdit = Boolean(existingTrigger);

        // Exclude bound artifacts unless it's the one currently bound to this trigger
        const boundArtifacts = new Set(
            existingTriggers
                .filter(t => !isEdit || t.event !== existingTrigger.event)
                .map(t => t.artifact)
        );

        // Enforce 1:1 artifact constraint (§5.2) across both Graphs and Process library
        const allArtifacts = this.library || [];
        const graphMap = new Map();

        // 1. From rt.graphs (all graphs created in studio or loaded from runtime)
        if (rt?.graphs) {
            Object.values(rt.graphs).forEach(g => {
                graphMap.set(g.id, {
                    ref: g.id,
                    label: g.label || g.id,
                    category: 'Graph',
                    artifactType: 'graph'
                });
            });
        }
        // 2. From this.library
        allArtifacts.forEach(a => {
            if (a.artifactType === 'graph' || a.category === 'Graph') {
                graphMap.set(a.ref, {
                    ref: a.ref,
                    label: a.label || a.ref,
                    category: 'Graph',
                    artifactType: 'graph'
                });
            }
        });

        const processArtifacts = allArtifacts.filter(a => a.artifactType !== 'graph' && a.category !== 'Graph');

        const availableGraphs = Array.from(graphMap.values()).filter(g => !boundArtifacts.has(g.ref));
        const availableProcesses = processArtifacts.filter(p => !boundArtifacts.has(p.ref));
        const hasAvailable = availableGraphs.length > 0 || availableProcesses.length > 0;

        // Current values
        const currentEvent = existingTrigger?.event || '';
        const currentArtifact = existingTrigger?.artifact || '';
        const currentDelivery = existingTrigger?.delivery || 'trigger';
        const currentOnce = Boolean(existingTrigger?.once);
        const currentRoles = existingTrigger ? (existingTrigger.roles || existingTrigger.access?.roles || ['admin', 'device']) : ['admin', 'device'];

        const hasAdmin = currentRoles.includes('admin');
        const hasDevice = currentRoles.includes('device');
        const hasAnon = currentRoles.includes('anonymous') || currentRoles.includes('anon');

        bodyEl.innerHTML = `
            <div class="field-group">
                <label class="field-label">Event Name</label>
                <input class="field-input" id="trig-event" value="${this._escape(currentEvent)}" placeholder="e.g. order.created or webhook.incoming" style="font-family:var(--mono)" autocomplete="off">
            </div>
            <div class="field-group">
                <label class="field-label">Bound Artifact (Graph or Process)</label>
                ${hasAvailable ? `
                    <select class="field-select" id="trig-artifact">
                        ${availableGraphs.length ? `
                            <optgroup label="Graphs">
                                ${availableGraphs.map(g => `<option value="${this._escape(g.ref)}" ${g.ref === currentArtifact ? 'selected' : ''}>[Graph] ${this._escape(g.label)} (${this._escape(g.ref)})</option>`).join('')}
                            </optgroup>
                        ` : ''}
                        ${availableProcesses.length ? `
                            <optgroup label="Process Nodes">
                                ${availableProcesses.map(p => `<option value="${this._escape(p.ref)}" ${p.ref === currentArtifact ? 'selected' : ''}>[Process] ${this._escape(p.label)} (${this._escape(p.ref)})</option>`).join('')}
                            </optgroup>
                        ` : ''}
                    </select>
                ` : `
                    <div class="side-empty" style="color:var(--amber)">All artifacts already have a Trigger (§12)</div>
                `}
            </div>
            
            <div class="field-group">
                <label class="field-label">Access Roles (Permitted callers)</label>
                <div style="display:flex; flex-direction:column; gap:8px; background:var(--bg-surface); padding:10px; border-radius:6px; border:1px solid var(--border)">
                    <label class="checkbox-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px">
                        <input type="checkbox" id="role-admin" ${hasAdmin ? 'checked' : ''}>
                        <span>👑 <b>Admin</b> <span style="color:var(--text-3); font-size:11px">— Full administrative access</span></span>
                    </label>
                    <label class="checkbox-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px">
                        <input type="checkbox" id="role-device" ${hasDevice ? 'checked' : ''}>
                        <span>📱 <b>Device</b> <span style="color:var(--text-3); font-size:11px">— Runner / device API key permitted</span></span>
                    </label>
                    <label class="checkbox-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px">
                        <input type="checkbox" id="role-anonymous" ${hasAnon ? 'checked' : ''}>
                        <span>🌐 <b>Anonymous</b> <span style="color:var(--text-3); font-size:11px">— Public webhook (unauthenticated HTTP POST allowed)</span></span>
                    </label>
                </div>
            </div>

            <div class="field-group">
                <label class="field-label">Delivery Mode</label>
                <select class="field-select" id="trig-delivery">
                    <option value="trigger" ${currentDelivery === 'trigger' ? 'selected' : ''}>/trigger/:event</option>
                    <option value="async" ${currentDelivery === 'async' ? 'selected' : ''}>async (202 Queued)</option>
                    <option value="sync" ${currentDelivery === 'sync' ? 'selected' : ''}>sync (Immediate result)</option>
                </select>
            </div>

            <div class="field-group">
                <label class="checkbox-label" style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px">
                    <input type="checkbox" id="trig-once" ${currentOnce ? 'checked' : ''}>
                    <span>Single-shot execution (unbind after first execution)</span>
                </label>
            </div>
        `;

        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Cancel</button>
            <button class="sheet-btn primary" id="trig-save-btn" ${hasAvailable ? '' : 'disabled'}>${isEdit ? 'Save Changes' : 'Bind Trigger'}</button>
        `;

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());
        document.getElementById('trig-save-btn')?.addEventListener('click', async () => {
            const event = document.getElementById('trig-event').value.trim();
            const artifact = document.getElementById('trig-artifact')?.value;
            const delivery = document.getElementById('trig-delivery').value;
            const once = Boolean(document.getElementById('trig-once')?.checked);

            if (!event || !artifact) {
                this.showToast('Event and artifact required', true);
                return;
            }

            const roles = [];
            if (document.getElementById('role-admin')?.checked) roles.push('admin');
            if (document.getElementById('role-device')?.checked) roles.push('device');
            if (document.getElementById('role-anonymous')?.checked) roles.push('anonymous');
            if (!roles.length) roles.push('admin', 'device');

            await this.addTrigger({
                event,
                artifact,
                access: { mode: 'allow', roles },
                delivery,
                once,
                oldEvent: isEdit ? existingTrigger.event : null
            });
            this.closeSheet();
            await this.syncTriggersFromRuntime();
            this.renderAll();
        });
    }


    _renderRunGraphSheet(bodyEl, footEl, graph) {
        const rt = this.getActiveRuntime();
        const g = graph || this.getActiveGraph();
        if (!g || !rt) return;

        // Extract input keys if available from graph entry nodes or library
        const entryNodes = Object.entries(this.graphModel.nodes || {})
            .filter(([id, _]) => !this.graphModel.edges.some(e => e.to === id));
        let defaultSample = {};
        if (entryNodes.length) {
            entryNodes.forEach(([id, n]) => {
                const lib = this.library.find(x => x.ref === n.artifactRef);
                (lib?.inputs || []).forEach(inp => {
                    defaultSample[inp.name] = inp.type === 'number' ? 0 : (inp.type === 'boolean' ? true : "sample_value");
                });
            });
        }
        if (!Object.keys(defaultSample).length) {
            defaultSample = { message: "Hello Nodaic", timestamp: Date.now() };
        }
        const sampleJsonStr = JSON.stringify(defaultSample, null, 2);

        bodyEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:12px;">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-active);border-radius:var(--radius-sm);font-size:11px;font-family:var(--mono);">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span class="status-indicator live"></span>
                        <span>Target Runtime: <strong>${this._escape(rt.label)}</strong></span>
                    </div>
                    <span class="insp-badge" style="background:var(--bg-surface);">${this._escape(g.id)}</span>
                </div>

                <!-- Input Section -->
                <div class="field-group">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <label class="field-label" style="margin-bottom:0;">Input Payload (JSON)</label>
                        <div style="display:flex;gap:4px;">
                            <button class="tbl-btn" id="run-sample-btn" style="padding:1px 6px;font-size:10px;">Sample Data</button>
                            <button class="tbl-btn" id="run-clear-btn" style="padding:1px 6px;font-size:10px;">Clear</button>
                        </div>
                    </div>
                    <textarea class="field-input mono" id="run-input-json" rows="4" placeholder="{}" style="resize:vertical;font-size:11.5px;line-height:1.4;">${this._escape(sampleJsonStr)}</textarea>
                    <div id="run-input-err" style="display:none;color:var(--red);font-size:10.5px;margin-top:4px;font-family:var(--mono);"></div>
                </div>

                <!-- Initial State Section (Collapsible) -->
                <div class="field-group">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;cursor:pointer;" id="run-toggle-state">
                        <label class="field-label" style="margin-bottom:0;cursor:pointer;">Initial State / Seed (Optional JSON) <span id="run-state-arrow" style="font-size:10px;color:var(--text-3);">▶</span></label>
                    </div>
                    <textarea class="field-input mono" id="run-state-json" rows="2" placeholder="{}" style="resize:vertical;font-size:11.5px;line-height:1.4;display:none;">{}</textarea>
                </div>

                <!-- Execution Output Panel -->
                <div class="field-group" id="run-output-panel" style="display:none;margin-top:4px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <label class="field-label" style="margin-bottom:0;">Output Result</label>
                            <span id="run-status-badge" class="insp-badge" style="font-size:9.5px;"></span>
                            <span id="run-duration-badge" style="font-size:10.5px;color:var(--text-3);font-family:var(--mono);"></span>
                        </div>
                        <button class="tbl-btn" id="run-copy-output" style="padding:2px 8px;font-size:10px;">📋 Copy Output</button>
                    </div>
                    <pre id="run-output-viewer" class="mono" style="margin:0;background:var(--bg-active);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;font-size:11px;max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--text-1);"></pre>
                </div>
            </div>
        `;

        footEl.innerHTML = `
            <button class="sheet-btn" id="sheet-cancel-btn">Close</button>
            <button class="sheet-btn primary" id="run-exec-btn" style="min-width:110px;">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:4px;display:inline-block;"><path d="M8 5v14l11-7z"></path></svg> Run Graph
            </button>
        `;

        // Event bindings inside run sheet
        const sampleBtn = document.getElementById('run-sample-btn');
        const clearBtn = document.getElementById('run-clear-btn');
        const inputArea = document.getElementById('run-input-json');
        const inputErr = document.getElementById('run-input-err');
        const toggleState = document.getElementById('run-toggle-state');
        const stateArea = document.getElementById('run-state-json');
        const stateArrow = document.getElementById('run-state-arrow');
        const execBtn = document.getElementById('run-exec-btn');
        const outPanel = document.getElementById('run-output-panel');
        const statusBadge = document.getElementById('run-status-badge');
        const durationBadge = document.getElementById('run-duration-badge');
        const outViewer = document.getElementById('run-output-viewer');
        const copyBtn = document.getElementById('run-copy-output');

        sampleBtn?.addEventListener('click', () => {
            inputArea.value = sampleJsonStr;
            inputErr.style.display = 'none';
        });

        clearBtn?.addEventListener('click', () => {
            inputArea.value = '{}';
            inputErr.style.display = 'none';
        });

        toggleState?.addEventListener('click', () => {
            const isHidden = stateArea.style.display === 'none';
            stateArea.style.display = isHidden ? 'block' : 'none';
            stateArrow.textContent = isHidden ? '▼' : '▶';
        });

        document.getElementById('sheet-cancel-btn')?.addEventListener('click', () => this.closeSheet());

        copyBtn?.addEventListener('click', () => {
            if (outViewer.textContent) {
                navigator.clipboard?.writeText(outViewer.textContent);
                this.showToast('Copied output to clipboard!');
            }
        });

        execBtn?.addEventListener('click', async () => {
            inputErr.style.display = 'none';
            let parsedInput = {};
            let parsedState = {};

            try {
                const rawInp = inputArea.value.trim();
                parsedInput = rawInp ? JSON.parse(rawInp) : {};
            } catch (err) {
                inputErr.textContent = `Invalid Input JSON: ${err.message}`;
                inputErr.style.display = 'block';
                return;
            }

            try {
                const rawState = stateArea.value.trim();
                parsedState = rawState ? JSON.parse(rawState) : {};
            } catch (err) {
                inputErr.textContent = `Invalid State JSON: ${err.message}`;
                inputErr.style.display = 'block';
                return;
            }

            execBtn.disabled = true;
            execBtn.innerHTML = `Running...`;
            outPanel.style.display = 'block';
            statusBadge.className = 'insp-badge';
            statusBadge.style.background = 'rgba(99, 102, 241, 0.15)';
            statusBadge.style.color = '#818cf8';
            statusBadge.textContent = '⏳ Executing...';
            durationBadge.textContent = '';
            outViewer.textContent = 'Waiting for execution response...';

            const result = await this.runActiveGraph(parsedInput, parsedState);

            execBtn.disabled = false;
            execBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-right:4px;display:inline-block;"><path d="M8 5v14l11-7z"></path></svg> Run Again`;

            if (result?.ok) {
                statusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                statusBadge.style.color = '#10b981';
                statusBadge.textContent = '✓ 200 OK';
                durationBadge.textContent = `${result.duration}ms`;
                outViewer.textContent = JSON.stringify(result.output, null, 2);
            } else {
                statusBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                statusBadge.style.color = '#ef4444';
                statusBadge.textContent = '✗ Error';
                durationBadge.textContent = `${result?.duration || 0}ms`;
                outViewer.textContent = result?.error || 'Execution failed';
            }
        });
    }

    /* ── Graph Execution Flow ── */
    async runActiveGraph(input = {}, state = {}) {
        if (this.runActive) return null;
        const g = this.getActiveGraph();
        const rt = this.getActiveRuntime();

        if (!g || !rt) {
            this.showToast('No active graph selected to run', true);
            return null;
        }

        this.runActive = true;
        if (typeof document !== 'undefined') {
            const runBtn = document.getElementById('run-btn');
            if (runBtn) {
                runBtn.classList.add('running');
                runBtn.innerHTML = `■ Stop`;
            }
        }

        // Pulse nodes visually
        Object.keys(this.graphModel.nodes || {}).forEach(id => {
            this.visNodes?.update({ id, color: { background: 'rgba(99, 102, 241, 0.1)', border: '#6366f1' } });
        });

        const startTime = Date.now();
        this.logEvent('Runner', 'library', `Initiating execution for graph "${g.label || g.id}" on ${rt.label} with input: ${JSON.stringify(input)}...`);

        try {
            const res = await this.execRuntimeAction('run.start', { artifactId: g.id, input, state });
            const duration = Date.now() - startTime;
            this.logEvent('Runner', 'library', `✓ Execution finished for "${g.id}" in ${duration}ms. Output: ${JSON.stringify(res?.output ?? null)}`, 'OK');
            this.showToast(`Graph "${g.id}" executed successfully (${duration}ms)`);
            return { ok: true, duration, output: res?.output ?? null, state: res?.state ?? null };
        } catch (e) {
            const duration = Date.now() - startTime;
            this.logEvent('Runner', 'library', `✗ Execution failed for "${g.id}": ${e.message}`, 'ERROR');
            this.showToast(`Execution error: ${e.message}`, true);
            return { ok: false, duration, error: e.message };
        } finally {
            this.stopActiveGraph();
        }
    }

    stopActiveGraph() {
        this.runActive = false;
        if (typeof document !== 'undefined') {
            const runBtn = document.getElementById('run-btn');
            if (runBtn) {
                runBtn.classList.remove('running');
                runBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg> Run`;
            }
        }
        Object.keys(this.graphModel.nodes || {}).forEach(id => {
            this.visNodes?.update({ id, color: { background: '#ffffff', border: '#d1d5db' } });
        });
    }

    /* ── Terminal & Logging ── */
    logEvent(source, category, message, level = 'INFO') {
        const entry = {
            ts: new Date(),
            source,
            category,
            message,
            level
        };

        const logs = this.state.getValue('/logHistory') || [];
        logs.push(entry);
        this.state.setValue([...logs], '/logHistory');

        this._renderLogEntry(entry);
    }

    _renderLogEntry(entry) {
        if (typeof document === 'undefined') return;
        const out = document.getElementById('console-output');
        if (!out) return;

        if (this.filterCat !== 'all' && entry.category !== this.filterCat) return;

        const line = document.createElement('div');
        line.className = 'console-line';
        const timeStr = entry.ts.toTimeString().split(' ')[0];

        let lvlColor = 'var(--text-1)';
        if (entry.level === 'OK') lvlColor = 'var(--green)';
        else if (entry.level === 'WARN') lvlColor = 'var(--amber)';
        else if (entry.level === 'ERROR') lvlColor = 'var(--red)';
        else if (entry.level === 'TX') lvlColor = 'var(--purple)';
        else if (entry.level === 'RX') lvlColor = 'var(--cyan)';

        line.innerHTML = `
            <span class="log-ts">${timeStr}</span>
            <span class="log-badge rt">${this._escape(entry.source)}</span>
            <span class="log-badge cat">${this._escape(entry.category)}</span>
            <span style="color:${lvlColor}; flex:1">${this._escape(entry.message)}</span>
        `;

        out.appendChild(line);
        out.scrollTop = out.scrollHeight;
    }

    clearConsoleLogs() {
        this.state.setValue([], '/logHistory');
        const out = document.getElementById('console-output');
        if (out) out.innerHTML = '';
    }

    showToast(message, isError = false) {
        if (typeof document === 'undefined') return;
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.className = isError ? 'err show' : 'show';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
    }

    _escape(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    _formatVal(v) {
        if (v === null || v === undefined) return '<span style="color:var(--text-3)">null</span>';
        if (typeof v === 'object') return `<span class="insp-badge">${this._escape(JSON.stringify(v))}</span>`;
        return this._escape(String(v));
    }

    /* ── Global UI Event Handlers ── */
    _setupEventListeners() {
        // Mode toggle (Read | Write)
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const mode = e.currentTarget.dataset.mode;
                this.state.setValue(mode, '/mode');
                this.logEvent('System', 'system', `Switched mode to "${mode}"`);
            });
        });

        // Context switcher tabs (Modeler | Secrets | Triggers)
        document.querySelectorAll('.ws-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.currentTarget.dataset.tab;
                this.state.setValue(tab, '/activeTab');
                this.logEvent('System', 'system', `Switched workspace view to "${tab}"`);
            });
        });

        // Modeler visual/code toggle
        document.getElementById('vt-visual')?.addEventListener('click', () => {
            document.getElementById('modeler').dataset.view = 'visual';
            document.getElementById('vt-visual').classList.add('active');
            document.getElementById('vt-code').classList.remove('active');
            this.applyCode();
        });

        document.getElementById('vt-code')?.addEventListener('click', () => {
            document.getElementById('modeler').dataset.view = 'code';
            document.getElementById('vt-code').classList.add('active');
            document.getElementById('vt-visual').classList.remove('active');
        });

        // Canvas toolbar
        document.getElementById('ct-zoom-in')?.addEventListener('click', () => {
            this.network?.moveTo({ scale: this.network.getScale() * 1.25, animation: { duration: 180 } });
        });
        document.getElementById('ct-zoom-out')?.addEventListener('click', () => {
            this.network?.moveTo({ scale: this.network.getScale() * 0.8, animation: { duration: 180 } });
        });
        document.getElementById('ct-fit')?.addEventListener('click', () => {
            this.network?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
        });
        document.getElementById('ct-layout')?.addEventListener('click', () => {
            this.network?.setOptions({ physics: { enabled: true } });
            this.network?.stabilize();
            this.network?.once('stabilizationIterationsDone', () => {
                this.network?.setOptions({ physics: { enabled: false } });
                this.network?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
            });
        });
        document.getElementById('ct-link')?.addEventListener('click', () => this.startLinking());
        document.getElementById('connect-hint-cancel')?.addEventListener('click', () => this.endLinking());

        // Run & Deploy buttons
        document.getElementById('run-btn')?.addEventListener('click', () => {
            if (this.runActive) {
                this.stopActiveGraph();
            } else {
                this.openSheet('run-graph', { graph: this.getActiveGraph() });
            }
        });

        document.getElementById('deploy-btn')?.addEventListener('click', () => {
            this.deployActiveGraph();
        });

        document.getElementById('deploy-graph-btn')?.addEventListener('click', () => {
            this.deployActiveGraph();
        });

        // Sidebar Add buttons
        document.getElementById('add-runtime-btn')?.addEventListener('click', () => this.openSheet('add-runtime'));
        document.getElementById('add-graph-btn')?.addEventListener('click', () => this.openSheet('add-graph'));
        document.getElementById('add-secret-btn')?.addEventListener('click', () => this.openSheet('add-secret'));
        document.getElementById('add-role-btn')?.addEventListener('click', () => this.openSheet('add-role'));
        document.getElementById('add-trigger-btn')?.addEventListener('click', () => this.openSheet('add-trigger'));

        // Workspace table action buttons
        document.getElementById('secrets-table-body')?.addEventListener('click', (e) => {
            const delBtn = e.target.closest('[data-delete-secret]');
            if (delBtn) {
                this.deleteSecret(delBtn.dataset.deleteSecret);
                return;
            }
            const revealBtn = e.target.closest('[data-toggle-reveal]');
            if (revealBtn) {
                const key = revealBtn.dataset.toggleReveal;
                const sec = this.getSecret(key);
                if (sec) {
                    if (!this.isSessionElevated()) {
                        this.showToast('Run `sudo-session` to elevate your session and reveal secrets', true);
                        return;
                    }
                    sec.revealed = !sec.revealed;
                    this._renderSecretsTable();
                }
            }
        });

        document.getElementById('triggers-table-body')?.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-edit-trigger]');
            if (editBtn) {
                const event = editBtn.dataset.editTrigger;
                const rt = this.getActiveRuntime();
                const trigger = rt?.triggers?.[event];
                if (trigger) {
                    this.openSheet('edit-trigger', { trigger });
                }
                return;
            }
            const delBtn = e.target.closest('[data-delete-trigger]');
            if (delBtn) {
                this.deleteTrigger(delBtn.dataset.deleteTrigger);
                return;
            }
            const emitBtn = e.target.closest('[data-emit-trigger]');
            if (emitBtn) {
                this.emitTrigger(emitBtn.dataset.emitTrigger);
            }
        });

        document.getElementById('roles-list')?.addEventListener('click', (e) => {
            const delBtn = e.target.closest('[data-delete-role]');
            if (delBtn) {
                const name = delBtn.dataset.deleteRole;
                this.deleteRole(name);
                return;
            }
            const editBtn = e.target.closest('[data-edit-role]');
            if (editBtn) {
                const roleName = editBtn.dataset.editRole;
                const rt = this.getActiveRuntime();
                const role = rt?.roles?.[roleName];
                if (role) {
                    this.openSheet('edit-role', { role });
                }
                return;
            }
            const roleRow = e.target.closest('[data-role-id]');
            if (roleRow) {
                const roleId = roleRow.dataset.roleId;
                const rt = this.getActiveRuntime();
                const r = rt?.roles?.[roleId];
                if (r && this.canManageRoles()) {
                    this.openSheet('edit-role', { role: r });
                }
            }
        });

        // Sidebar row clicks
        document.getElementById('runtime-list')?.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-edit-runtime]');
            if (editBtn) {
                const rtId = editBtn.dataset.editRuntime;
                this.confirmDestructiveAction(`Remove Runtime "${rtId}"`, `Remove runtime connection "${rtId}"?`, () => {
                    const runtimes = this.state.getValue('/runtimes');
                    delete runtimes[rtId];
                    this.state.setValue({ ...runtimes }, '/runtimes');
                    const remaining = Object.keys(runtimes);
                    this.switchRuntime(remaining[0] || null);
                    this.showToast(`Removed runtime "${rtId}"`);
                });
                return;
            }
            const row = e.target.closest('[data-runtime-id]');
            if (row) this.switchRuntime(row.dataset.runtimeId);
        });

        document.getElementById('library-list')?.addEventListener('click', (e) => {
            const row = e.target.closest('[data-graph-id]');
            if (row) this.loadGraph(this.state.getValue('/activeRuntimeId'), row.dataset.graphId);
        });

        // Inspector action clicks
        document.getElementById('insp-actions')?.addEventListener('click', (e) => {
            if (e.target.id === 'insp-add-node') this.openSheet('add-node');
            else if (e.target.id === 'insp-connect-new') this.openSheet('add-node', { sourceId: this.selectedNodeId });
            else if (e.target.id === 'insp-edit-ports') {
                const ed = this.visEdges.get(this.selectedEdgeVisId)?._edgeData;
                if (ed) {
                    this.openSheet('connect-ports', { fromId: ed.from, toId: ed.to, edge: ed, isEdit: true });
                }
            } else if (e.target.id === 'insp-insert-node') {
                const ed = this.visEdges.get(this.selectedEdgeVisId)?._edgeData;
                if (ed) {
                    this.openSheet('add-node', { insertOnEdge: ed });
                }
            } else if (e.target.id === 'insp-delete-node') {
                this.confirmDestructiveAction(
                    `Delete Node "${this.selectedNodeId}"`,
                    `Are you sure you want to delete node "${this.selectedNodeId}"?`,
                    () => {
                        delete this.graphModel.nodes[this.selectedNodeId];
                        this.graphModel.edges = this.graphModel.edges.filter(x => x.from !== this.selectedNodeId && x.to !== this.selectedNodeId);
                        this.syncModelToCode();
                        this.renderModelToCanvas(this.graphModel);
                        this.showToast(`Deleted node "${this.selectedNodeId}"`);
                    }
                );
            } else if (e.target.id === 'insp-delete-edge') {
                const ed = this.visEdges.get(this.selectedEdgeVisId)?._edgeData;
                this.confirmDestructiveAction(
                    `Delete Connection`,
                    `Are you sure you want to delete connection ${ed.from} → ${ed.to}?`,
                    () => {
                        const idx = this.graphModel.edges.indexOf(ed);
                        if (idx > -1) this.graphModel.edges.splice(idx, 1);
                        this.syncModelToCode();
                        this.renderModelToCanvas(this.graphModel);
                        this.showToast(`Deleted connection`);
                    }
                );
            }
        });

        document.getElementById('insp-close')?.addEventListener('click', () => this.resetInspector());

        // Console Drawer toggle
        document.getElementById('console-toggle-btn')?.addEventListener('click', () => {
            const drawer = document.getElementById('console-drawer');
            const cur = drawer.dataset.state;
            drawer.dataset.state = cur === 'docked' ? 'partial' : 'docked';
        });

        document.getElementById('statusbar')?.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const drawer = document.getElementById('console-drawer');
            if (drawer.dataset.state === 'docked') drawer.dataset.state = 'partial';
        });

        // Console Input
        const consoleInput = document.getElementById('console-input');
        if (consoleInput) {
            consoleInput.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    const val = consoleInput.value.trim();
                    if (!val) return;
                    consoleInput.value = '';
                    this.logEvent('Terminal', 'system', `› ${val}`, 'CMD');
                    try {
                        const result = await this.cli.execute(val);
                        if (result) {
                            result.trim().split('\n').forEach(line => {
                                this.logEvent('Terminal', 'system', line);
                            });
                        }
                    } catch (err) {
                        this.logEvent('Terminal', 'system', `Error: ${err.message}`, 'ERROR');
                    }
                }
            });
        }

        // Terminal Category filter chips
        document.getElementById('term-filter-cat')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (!chip) return;
            document.querySelectorAll('#term-filter-cat .filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.filterCat = chip.dataset.cat;
            const out = document.getElementById('console-output');
            if (out) out.innerHTML = '';
            (this.state.getValue('/logHistory') || []).forEach(l => this._renderLogEntry(l));
        });

        // Confirm Modal handlers
        document.getElementById('confirm-cancel-btn')?.addEventListener('click', () => this.closeConfirmModal());
        document.getElementById('confirm-action-btn')?.addEventListener('click', () => {
            if (this.confirmCallback) this.confirmCallback();
            this.closeConfirmModal();
        });

        // Global hotkeys
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '`') {
                e.preventDefault();
                const drawer = document.getElementById('console-drawer');
                drawer.dataset.state = drawer.dataset.state === 'docked' ? 'partial' : 'docked';
            }
            if (e.key === 'Escape') {
                this.closeSheet();
                this.closeConfirmModal();
                if (this.linking) this.endLinking();
            }
        });
    }
}
