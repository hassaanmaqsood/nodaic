/**
 * Nodaic Studio — REST Terminal Console Engine
 *
 * Highly intuitive, readable terminal console interface for REST API data:
 * - Transforms raw JSON payloads into clean, pretty-printed outputs with 2-space indentation
 * - Distinct syntax highlighting for keys, strings, numbers, booleans, and nulls
 * - Prominently displays HTTP status codes (2xx, 3xx, 4xx, 5xx) and response latencies (ms)
 * - Exposes critical headers like rate limits (x-ratelimit-remaining, x-ratelimit-limit, etc.)
 * - Handles errors gracefully with distinct styling and error banners
 * - Anti-flooding navigation: page-by-page pagination, collapsible/foldable JSON nodes,
 *   array truncation for large datasets, and key-based & regex search filtering.
 */

export class RestTerminalConsole {
    constructor(containerEl, options = {}) {
        this.container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
        if (!this.container) throw new Error('RestTerminalConsole: container not found');

        this.options = {
            pageSize: 15,
            maxArrayItems: 12,
            autoScroll: true,
            app: options.app || null,
            ...options
        };

        this.entries = [];
        this.filteredEntries = [];
        this.currentPage = 1;
        this.pageSize = this.options.pageSize;
        this.categoryFilter = 'all';
        this.searchQuery = '';
        this.isRegex = false;
        this.autoScroll = this.options.autoScroll;
        this.nodeIdCounter = 0;
        this.nodeStates = new Map(); // id -> { collapsed: boolean, truncated: boolean }

        this._initUI();
    }

    _initUI() {
        this.container.innerHTML = `
            <div class="rt-toolbar">
                <div class="rt-toolbar-row">
                    <div class="rt-filters" id="rt-filter-group">
                        <button class="rt-filter-chip active" data-cat="all">All <span class="rt-chip-count" id="rt-count-all">0</span></button>
                        <button class="rt-filter-chip" data-cat="rxtx">REST API <span class="rt-chip-count" id="rt-count-rxtx">0</span></button>
                        <button class="rt-filter-chip" data-cat="error">Errors <span class="rt-chip-count" id="rt-count-error">0</span></button>
                        <button class="rt-filter-chip" data-cat="library">Library <span class="rt-chip-count" id="rt-count-library">0</span></button>
                        <button class="rt-filter-chip" data-cat="runner">Runner <span class="rt-chip-count" id="rt-count-runner">0</span></button>
                        <button class="rt-filter-chip" data-cat="system">System <span class="rt-chip-count" id="rt-count-system">0</span></button>
                    </div>

                    <div class="rt-search-box">
                        <svg class="rt-search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input class="rt-search-input" id="rt-search-input" type="text" placeholder="Filter logs or key:val or /regex/…" spellcheck="false" autocomplete="off">
                        <button class="rt-toggle-btn" id="rt-regex-btn" title="Toggle Regular Expression mode">.*</button>
                        <span class="rt-search-clear" id="rt-search-clear" title="Clear filter" style="display:none">✕</span>
                    </div>

                    <div class="rt-pagination">
                        <button class="rt-page-btn" id="rt-page-prev" title="Previous page" disabled>◀ Prev</button>
                        <span class="rt-page-info" id="rt-page-info">Page 1 of 1 (0)</span>
                        <button class="rt-page-btn" id="rt-page-next" title="Next page" disabled>Next ▶</button>
                        <select class="rt-page-select" id="rt-page-size" title="Page size">
                            <option value="10">10 / page</option>
                            <option value="15" selected>15 / page</option>
                            <option value="25">25 / page</option>
                            <option value="50">50 / page</option>
                        </select>
                        <span class="rt-sep-v"></span>
                        <button class="rt-action-btn" id="rt-expand-all-btn" title="Expand all JSON nodes">▼ Expand</button>
                        <button class="rt-action-btn" id="rt-collapse-all-btn" title="Collapse all JSON nodes">▶ Fold</button>
                        <button class="rt-action-btn" id="rt-clear-btn" title="Clear console output">🗑 Clear</button>
                    </div>
                </div>
            </div>

            <div class="rt-log-viewport" id="rt-viewport" role="log" aria-live="polite">
                <div class="rt-empty">Ready. REST transactions, API responses & payloads will stream here.</div>
            </div>

            <div class="rt-cli-row">
                <span class="rt-cli-prompt">›</span>
                <input class="rt-cli-input" id="rt-cli-input" type="text" spellcheck="false" autocomplete="off"
                    placeholder="CLI command (help, whoami, library list, role list, secret list, sudo-session)…">
            </div>
        `;

        this.viewportEl = this.container.querySelector('#rt-viewport');
        this.searchInputEl = this.container.querySelector('#rt-search-input');
        this.regexBtnEl = this.container.querySelector('#rt-regex-btn');
        this.searchClearEl = this.container.querySelector('#rt-search-clear');
        this.pagePrevBtn = this.container.querySelector('#rt-page-prev');
        this.pageNextBtn = this.container.querySelector('#rt-page-next');
        this.pageInfoEl = this.container.querySelector('#rt-page-info');
        this.pageSizeSelect = this.container.querySelector('#rt-page-size');
        this.cliInputEl = this.container.querySelector('#rt-cli-input');

        this._bindEvents();
    }

    _bindEvents() {
        // Category Filters
        this.container.querySelector('#rt-filter-group').addEventListener('click', (e) => {
            const btn = e.target.closest('.rt-filter-chip');
            if (!btn) return;
            this.container.querySelectorAll('.rt-filter-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            this.setCategory(btn.dataset.cat);
        });

        // Search Input
        this.searchInputEl.addEventListener('input', (e) => {
            this.searchClearEl.style.display = e.target.value ? 'inline' : 'none';
            this.setSearch(e.target.value, this.isRegex);
        });

        this.searchClearEl.addEventListener('click', () => {
            this.searchInputEl.value = '';
            this.searchClearEl.style.display = 'none';
            this.setSearch('', this.isRegex);
        });

        // Regex Toggle
        this.regexBtnEl.addEventListener('click', () => {
            this.isRegex = !this.isRegex;
            this.regexBtnEl.classList.toggle('active', this.isRegex);
            this.setSearch(this.searchInputEl.value, this.isRegex);
        });

        // Pagination
        this.pagePrevBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.render();
            }
        });

        this.pageNextBtn.addEventListener('click', () => {
            const totalPages = Math.ceil(this.filteredEntries.length / this.pageSize) || 1;
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.render();
            }
        });

        this.pageSizeSelect.addEventListener('change', (e) => {
            this.pageSize = parseInt(e.target.value, 10) || 15;
            this.currentPage = 1;
            this.render();
        });

        // Expand / Collapse All
        this.container.querySelector('#rt-expand-all-btn').addEventListener('click', () => {
            this.nodeStates.forEach(s => s.collapsed = false);
            this.viewportEl.querySelectorAll('.rt-fold-toggle').forEach(btn => btn.classList.remove('collapsed'));
            this.viewportEl.querySelectorAll('.rt-fold-content').forEach(el => el.style.display = 'inline');
            this.viewportEl.querySelectorAll('.rt-collapsed-placeholder').forEach(el => el.style.display = 'none');
        });

        this.container.querySelector('#rt-collapse-all-btn').addEventListener('click', () => {
            this.nodeStates.forEach(s => s.collapsed = true);
            this.viewportEl.querySelectorAll('.rt-fold-toggle').forEach(btn => btn.classList.add('collapsed'));
            this.viewportEl.querySelectorAll('.rt-fold-content').forEach(el => el.style.display = 'none');
            this.viewportEl.querySelectorAll('.rt-collapsed-placeholder').forEach(el => el.style.display = 'inline-block');
        });

        // Clear
        this.container.querySelector('#rt-clear-btn').addEventListener('click', () => {
            this.clear();
        });

        // Click delegation on Viewport for Fold Toggles, Array Truncation, Headers, and Copy buttons
        this.viewportEl.addEventListener('click', (e) => {
            // Fold toggle
            const foldBtn = e.target.closest('.rt-fold-toggle');
            if (foldBtn) {
                e.stopPropagation();
                const id = foldBtn.dataset.nodeId;
                const contentEl = this.viewportEl.querySelector(`#content-${id}`);
                const placeholderEl = this.viewportEl.querySelector(`#ph-${id}`);
                const state = this.nodeStates.get(id) || { collapsed: false };
                state.collapsed = !state.collapsed;
                this.nodeStates.set(id, state);

                if (state.collapsed) {
                    foldBtn.classList.add('collapsed');
                    if (contentEl) contentEl.style.display = 'none';
                    if (placeholderEl) placeholderEl.style.display = 'inline-block';
                } else {
                    foldBtn.classList.remove('collapsed');
                    if (contentEl) contentEl.style.display = 'inline';
                    if (placeholderEl) placeholderEl.style.display = 'none';
                }
                return;
            }

            // Click on collapsed placeholder to unfold
            const placeholder = e.target.closest('.rt-collapsed-placeholder');
            if (placeholder) {
                e.stopPropagation();
                const id = placeholder.dataset.nodeId;
                const btn = this.viewportEl.querySelector(`.rt-fold-toggle[data-node-id="${id}"]`);
                btn?.click();
                return;
            }

            // Array Truncation "+N more items"
            const truncBtn = e.target.closest('.rt-array-truncation');
            if (truncBtn) {
                e.stopPropagation();
                const id = truncBtn.dataset.nodeId;
                const hiddenItems = this.viewportEl.querySelector(`#trunc-${id}`);
                if (hiddenItems) {
                    hiddenItems.style.display = 'inline';
                    truncBtn.style.display = 'none';
                }
                return;
            }

            // Toggle Headers dropdown
            const headersBtn = e.target.closest('.rt-headers-toggle');
            if (headersBtn) {
                e.stopPropagation();
                const card = headersBtn.closest('.rt-card');
                const panel = card?.querySelector('.rt-headers-panel');
                if (panel) {
                    panel.classList.toggle('open');
                    headersBtn.classList.toggle('active', panel.classList.contains('open'));
                }
                return;
            }

            // Copy Payload
            const copyBtn = e.target.closest('.rt-copy-btn');
            if (copyBtn) {
                e.stopPropagation();
                const rawJson = copyBtn.dataset.raw;
                if (rawJson) {
                    navigator.clipboard?.writeText(rawJson);
                    const origText = copyBtn.textContent;
                    copyBtn.textContent = '✓ Copied';
                    setTimeout(() => { copyBtn.textContent = origText; }, 1400);
                }
                return;
            }
        });

        // CLI Execution
        this.cliInputEl.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const cmd = this.cliInputEl.value.trim();
                if (!cmd) return;
                this.cliInputEl.value = '';
                this.append({
                    ts: new Date(),
                    source: 'Terminal',
                    category: 'system',
                    message: `› ${cmd}`,
                    level: 'CMD'
                });

                if (this.options.app?.cliCore) {
                    try {
                        const out = await this.options.app.cliCore.execute(cmd);
                        if (out) {
                            out.split('\n').forEach(line => {
                                this.append({ ts: new Date(), source: 'Terminal', category: 'system', message: line, level: 'OK' });
                            });
                        }
                    } catch (err) {
                        this.append({ ts: new Date(), source: 'Terminal', category: 'system', message: `Error: ${err.message}`, level: 'ERROR' });
                    }
                }
            }
        });
    }

    /**
     * Ingest a log entry and parse it into a structured REST record when possible
     */
    append(rawEntry) {
        const entry = this._normalizeEntry(rawEntry);
        this.entries.push(entry);

        this._updateCounts();
        this._applyFilter();

        if (this.autoScroll) {
            // Jump to the latest page where the new item lives
            const totalPages = Math.ceil(this.filteredEntries.length / this.pageSize) || 1;
            this.currentPage = totalPages;
        }

        this.render();
    }

    _normalizeEntry(raw) {
        const id = 'entry_' + (++this.nodeIdCounter);
        const ts = raw.ts ? new Date(raw.ts) : new Date();
        const level = raw.level || 'INFO';
        const source = raw.source || 'Studio';
        const category = raw.category || 'system';
        const message = raw.message || '';

        // If raw already has rich REST meta:
        if (raw.meta && raw.meta.type === 'rest') {
            return {
                id,
                ts,
                level,
                source,
                category: 'rxtx',
                isRest: true,
                method: raw.meta.method || 'POST',
                action: raw.meta.action || 'api',
                url: raw.meta.url || '',
                status: raw.meta.status || (raw.meta.direction === 'tx' ? 'TX' : 200),
                statusText: raw.meta.statusText || 'OK',
                latency: raw.meta.latency || 0,
                headers: raw.meta.headers || {},
                reqPayload: raw.meta.reqPayload || null,
                resPayload: raw.meta.resPayload || null,
                error: raw.meta.error || null,
                rawMessage: message
            };
        }

        // Check if message is a serialized RX/TX string to extract structured REST data:
        // Examples: "[RX] library.list (24ms) <- {...}" or "[TX] library.push -> /url"
        const rxMatch = /^\[RX\]\s+([\w\.]+)\s+\((\d+)ms\)\s+<-\s+(.+)$/s.exec(message);
        if (rxMatch) {
            let parsedRes = null;
            try { parsedRes = JSON.parse(rxMatch[3]); } catch (_) { parsedRes = rxMatch[3]; }
            const isErr = parsedRes?.error || level === 'ERROR';
            return {
                id,
                ts,
                level: isErr ? 'ERROR' : 'RX',
                source,
                category: 'rxtx',
                isRest: true,
                method: 'POST',
                action: rxMatch[1],
                url: '/nodaic/v1/',
                status: isErr ? 400 : 200,
                statusText: isErr ? 'Error' : 'OK',
                latency: parseInt(rxMatch[2], 10) || 0,
                headers: { 'content-type': 'application/json' },
                resPayload: parsedRes,
                error: isErr ? (parsedRes?.reason || parsedRes?.error?.message || 'Error returned') : null,
                rawMessage: message
            };
        }

        const txMatch = /^\[TX\]\s+([\w\.]+)\s+->\s+(\S+)/.exec(message);
        if (txMatch) {
            return {
                id,
                ts,
                level: 'TX',
                source,
                category: 'rxtx',
                isRest: true,
                method: 'POST',
                action: txMatch[1],
                url: txMatch[2],
                status: 'TX',
                statusText: 'Sent',
                latency: 0,
                headers: { 'content-type': 'application/json' },
                reqPayload: { action: txMatch[1] },
                rawMessage: message
            };
        }

        // Check if plain message has embedded JSON to pretty-print:
        let embeddedJson = null;
        const jsonIdx = message.indexOf('{');
        const jsonArrIdx = message.indexOf('[');
        const start = jsonIdx !== -1 ? (jsonArrIdx !== -1 ? Math.min(jsonIdx, jsonArrIdx) : jsonIdx) : jsonArrIdx;
        if (start !== -1) {
            try {
                const candidate = message.slice(start);
                embeddedJson = JSON.parse(candidate);
            } catch (_) {}
        }

        return {
            id,
            ts,
            level,
            source,
            category,
            isRest: false,
            embeddedJson,
            rawMessage: message
        };
    }

    _updateCounts() {
        const counts = { all: this.entries.length, rxtx: 0, error: 0, library: 0, runner: 0, system: 0 };
        this.entries.forEach(e => {
            if (e.isRest || e.category === 'rxtx') counts.rxtx++;
            if (e.level === 'ERROR' || e.error) counts.error++;
            if (e.category === 'library') counts.library++;
            if (e.category === 'runner') counts.runner++;
            if (e.category === 'system' || e.category === 'auth') counts.system++;
        });

        for (const [k, v] of Object.entries(counts)) {
            const el = this.container.querySelector(`#rt-count-${k}`);
            if (el) el.textContent = v;
        }
    }

    setCategory(cat) {
        this.categoryFilter = cat;
        this.currentPage = 1;
        this._applyFilter();
        this.render();
    }

    setSearch(query, isRegex) {
        this.searchQuery = query.trim();
        this.isRegex = !!isRegex;
        this.currentPage = 1;
        this._applyFilter();
        this.render();
    }

    _applyFilter() {
        let list = this.entries;

        // 1. Category Filter
        if (this.categoryFilter === 'rxtx') {
            list = list.filter(e => e.isRest || e.category === 'rxtx');
        } else if (this.categoryFilter === 'error') {
            list = list.filter(e => e.level === 'ERROR' || e.error || (typeof e.status === 'number' && e.status >= 400));
        } else if (this.categoryFilter !== 'all') {
            list = list.filter(e => e.category === this.categoryFilter);
        }

        // 2. Search Query Filter
        if (this.searchQuery) {
            let keyFilter = null;
            let query = this.searchQuery;

            // Support key-based filter syntax: e.g. "key:status" or "status:200" or "action:library"
            const keyMatch = /^([a-zA-Z_0-9]+):(.*)$/.exec(query);
            if (keyMatch) {
                keyFilter = { key: keyMatch[1].toLowerCase(), val: keyMatch[2].trim().toLowerCase() };
            }

            let regex = null;
            if (this.isRegex) {
                try {
                    regex = new RegExp(query, 'i');
                } catch (_) {}
            }

            list = list.filter(e => {
                if (keyFilter) {
                    if (keyFilter.key === 'action' && e.action) return e.action.toLowerCase().includes(keyFilter.val);
                    if (keyFilter.key === 'status' && e.status) return String(e.status).toLowerCase().includes(keyFilter.val);
                    if (keyFilter.key === 'source' && e.source) return e.source.toLowerCase().includes(keyFilter.val);
                    // Check within payloads:
                    const hay = JSON.stringify(e.resPayload || e.reqPayload || e.embeddedJson || {});
                    if (hay.toLowerCase().includes(keyFilter.key) && (!keyFilter.val || hay.toLowerCase().includes(keyFilter.val))) {
                        return true;
                    }
                }

                const fullText = (e.rawMessage + ' ' + (e.action || '') + ' ' + (e.source || '') + ' ' + JSON.stringify(e.resPayload || e.reqPayload || e.embeddedJson || ''));
                if (regex) return regex.test(fullText);
                return fullText.toLowerCase().includes(query.toLowerCase());
            });
        }

        this.filteredEntries = list;
    }

    clear() {
        this.entries = [];
        this.filteredEntries = [];
        this.currentPage = 1;
        this._updateCounts();
        this.render();
    }

    render() {
        if (!this.viewportEl) return;

        const total = this.filteredEntries.length;
        const totalPages = Math.ceil(total / this.pageSize) || 1;
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;

        // Update pagination UI
        this.pagePrevBtn.disabled = this.currentPage <= 1;
        this.pageNextBtn.disabled = this.currentPage >= totalPages;
        this.pageInfoEl.textContent = `Page ${this.currentPage} of ${totalPages} (${total})`;

        if (total === 0) {
            this.viewportEl.innerHTML = `<div class="rt-empty">No entries matching current filter "${this.categoryFilter}"${this.searchQuery ? ` and query "${this.searchQuery}"` : ''}.</div>`;
            return;
        }

        const start = (this.currentPage - 1) * this.pageSize;
        const end = Math.min(start + this.pageSize, total);
        const pageItems = this.filteredEntries.slice(start, end);

        let html = '';
        pageItems.forEach(entry => {
            if (entry.isRest) {
                html += this._renderRestCard(entry);
            } else {
                html += this._renderPlainLine(entry);
            }
        });

        this.viewportEl.innerHTML = html;

        if (this.autoScroll && this.currentPage === totalPages) {
            this.viewportEl.scrollTop = this.viewportEl.scrollHeight;
        }
    }

    _renderRestCard(entry) {
        const timeStr = entry.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const statusNum = typeof entry.status === 'number' ? entry.status : 0;
        let statusClass = 's-2xx';
        let cardClass = 'status-2xx';

        if (entry.error || (statusNum >= 400 && statusNum < 500)) {
            statusClass = 's-4xx'; cardClass = 'status-4xx';
        } else if (statusNum >= 500) {
            statusClass = 's-5xx'; cardClass = 'status-5xx';
        } else if (statusNum >= 300) {
            statusClass = 's-3xx'; cardClass = 'status-3xx';
        } else if (entry.status === 'TX') {
            statusClass = 's-3xx'; cardClass = 'status-3xx';
        }

        const latencyClass = entry.latency < 80 ? 'fast' : (entry.latency < 400 ? 'med' : 'slow');

        // Check for rate limit headers
        const rlRemaining = entry.headers?.['x-ratelimit-remaining'] || entry.headers?.['ratelimit-remaining'];
        const rlLimit = entry.headers?.['x-ratelimit-limit'] || entry.headers?.['ratelimit-limit'];
        const rlReset = entry.headers?.['x-ratelimit-reset'] || entry.headers?.['ratelimit-reset'];

        const hasHeaders = entry.headers && Object.keys(entry.headers).length > 0;
        const rawPayload = entry.resPayload || entry.reqPayload || {};
        const rawJsonString = JSON.stringify(rawPayload, null, 2);

        return `
            <div class="rt-card ${cardClass}" id="card-${entry.id}">
                <div class="rt-card-head">
                    <span class="rt-card-ts">${timeStr}</span>
                    <span class="rt-badge rt-badge-method">${entry.method || 'POST'}</span>
                    <span class="rt-badge rt-badge-action">${this._escape(entry.action)}</span>
                    <span class="rt-badge rt-badge-status ${statusClass}">${entry.status} ${this._escape(entry.statusText || '')}</span>
                    ${entry.latency ? `<span class="rt-badge rt-badge-latency ${latencyClass}">⚡ ${entry.latency}ms</span>` : ''}
                    ${rlRemaining ? `<span class="rt-badge rt-badge-ratelimit" title="Rate limit remaining: ${rlRemaining}/${rlLimit || '?'}">RL: ${rlRemaining}${rlLimit ? `/${rlLimit}` : ''}</span>` : ''}
                    <span class="rt-card-src" title="${this._escape(entry.url)}">${this._escape(entry.source)}</span>

                    <div class="rt-card-actions">
                        ${hasHeaders ? `<button class="rt-mini-btn rt-headers-toggle" title="View HTTP Headers">Headers (${Object.keys(entry.headers).length})</button>` : ''}
                        <button class="rt-mini-btn rt-copy-btn" data-raw="${this._escape(rawJsonString)}" title="Copy pretty JSON payload">Copy</button>
                    </div>
                </div>

                <div class="rt-card-body">
                    ${entry.error ? `
                        <div class="rt-error-banner">
                            <span class="rt-error-icon">✕</span>
                            <div><strong>Error:</strong> ${this._escape(entry.error)}</div>
                        </div>
                    ` : ''}

                    ${hasHeaders ? `
                        <div class="rt-headers-panel">
                            ${Object.entries(entry.headers).map(([k, v]) => `
                                <div class="rt-header-row">
                                    <span class="rt-header-key">${this._escape(k)}:</span>
                                    <span class="rt-header-val ${k.includes('ratelimit') ? 'highlight-limit' : ''}">${this._escape(String(v))}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    ${entry.reqPayload ? `
                        <div class="rt-payload-block">
                            <div class="rt-payload-title">
                                <span>Request Payload</span>
                            </div>
                            <div class="rt-json-tree">${this.formatJson(entry.reqPayload, 0, `${entry.id}_req`)}</div>
                        </div>
                    ` : ''}

                    ${entry.resPayload ? `
                        <div class="rt-payload-block">
                            <div class="rt-payload-title">
                                <span>Response Payload (${entry.status} ${this._escape(entry.statusText || '')})</span>
                            </div>
                            <div class="rt-json-tree">${this.formatJson(entry.resPayload, 0, `${entry.id}_res`)}</div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    _renderPlainLine(entry) {
        const timeStr = entry.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const levelCls = {
            INFO: 's-3xx', OK: 's-2xx', WARN: 's-4xx', ERROR: 's-5xx', CMD: 's-3xx'
        }[entry.level] || 's-3xx';

        return `
            <div class="rt-line-plain">
                <span class="rt-card-ts">${timeStr}</span>
                <span class="rt-badge rt-badge-status ${levelCls}">${entry.level}</span>
                <span class="rt-badge rt-badge-action">${this._escape(entry.category)}</span>
                <span class="rt-plain-msg">
                    ${this._highlightSearch(this._escape(entry.rawMessage))}
                    ${entry.embeddedJson ? `
                        <div class="rt-payload-block" style="margin-top:6px">
                            <div class="rt-json-tree">${this.formatJson(entry.embeddedJson, 0, `${entry.id}_emb`)}</div>
                        </div>
                    ` : ''}
                </span>
            </div>
        `;
    }

    /**
     * Pretty-prints JSON with 2-space indentation, collapsible nodes,
     * array truncation for large datasets, and distinct syntax highlighting.
     */
    formatJson(val, indent = 0, path = 'root') {
        const spaces = '  '.repeat(indent);
        const childSpaces = '  '.repeat(indent + 1);

        if (val === null) return `<span class="rt-null">null</span>`;
        if (typeof val === 'boolean') return `<span class="rt-bool">${val}</span>`;
        if (typeof val === 'number') return `<span class="rt-num">${val}</span>`;
        if (typeof val === 'string') return `<span class="rt-str">"${this._highlightSearch(this._escape(val))}"</span>`;

        if (Array.isArray(val)) {
            if (val.length === 0) return `<span class="rt-punct">[]</span>`;

            const nodeId = 'arr_' + (++this.nodeIdCounter);
            const state = this.nodeStates.get(nodeId) || { collapsed: false };
            this.nodeStates.set(nodeId, state);

            const isTruncated = val.length > this.options.maxArrayItems;
            const visibleItems = isTruncated ? val.slice(0, this.options.maxArrayItems) : val;
            const remainingItems = isTruncated ? val.slice(this.options.maxArrayItems) : [];

            return `
                <button class="rt-fold-toggle ${state.collapsed ? 'collapsed' : ''}" data-node-id="${nodeId}" title="Toggle array fold">▼</button><span class="rt-punct">[</span><span class="rt-collapsed-placeholder" id="ph-${nodeId}" data-node-id="${nodeId}" style="display:${state.collapsed ? 'inline-block' : 'none'}">${val.length} items</span><span class="rt-fold-content" id="content-${nodeId}" style="display:${state.collapsed ? 'none' : 'inline'}">
${visibleItems.map((item, idx) => `${childSpaces}${this.formatJson(item, indent + 1, `${path}[${idx}]`)}${idx < val.length - 1 ? '<span class="rt-punct">,</span>' : ''}`).join('\n')}
${isTruncated ? `
<div class="rt-array-truncation" data-node-id="${nodeId}">... +${remainingItems.length} more items (click to expand)</div>
<span id="trunc-${nodeId}" style="display:none">
${remainingItems.map((item, idx) => `${childSpaces}${this.formatJson(item, indent + 1, `${path}[${idx + this.options.maxArrayItems}]`)}${idx < remainingItems.length - 1 ? '<span class="rt-punct">,</span>' : ''}`).join('\n')}
</span>` : ''}
${spaces}</span><span class="rt-punct">]</span>`;
        }

        if (typeof val === 'object') {
            const keys = Object.keys(val);
            if (keys.length === 0) return `<span class="rt-punct">{}</span>`;

            const nodeId = 'obj_' + (++this.nodeIdCounter);
            const state = this.nodeStates.get(nodeId) || { collapsed: false };
            this.nodeStates.set(nodeId, state);

            return `
                <button class="rt-fold-toggle ${state.collapsed ? 'collapsed' : ''}" data-node-id="${nodeId}" title="Toggle object fold">▼</button><span class="rt-punct">{</span><span class="rt-collapsed-placeholder" id="ph-${nodeId}" data-node-id="${nodeId}" style="display:${state.collapsed ? 'inline-block' : 'none'}">${keys.length} keys</span><span class="rt-fold-content" id="content-${nodeId}" style="display:${state.collapsed ? 'none' : 'inline'}">
${keys.map((key, idx) => `${childSpaces}<span class="rt-key">"${this._highlightSearch(this._escape(key))}"</span><span class="rt-punct">: </span>${this.formatJson(val[key], indent + 1, `${path}.${key}`)}${idx < keys.length - 1 ? '<span class="rt-punct">,</span>' : ''}`).join('\n')}
${spaces}</span><span class="rt-punct">}</span>`;
        }

        return String(val);
    }

    _highlightSearch(text) {
        if (!this.searchQuery) return text;
        try {
            const re = this.isRegex ? new RegExp(`(${this.searchQuery})`, 'gi') : new RegExp(`(${this._escapeRegExp(this.searchQuery)})`, 'gi');
            return text.replace(re, '<mark class="rt-match">$1</mark>');
        } catch (_) {
            return text;
        }
    }

    _escape(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    _escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
