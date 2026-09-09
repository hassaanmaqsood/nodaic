/**
 * Nodaic Studio — UI Controller
 * Hybrid 3-Tier Observability: Canvas-Native Graphics + Chrome DevTools Console
 * Theme: Modeler Flame (#FF6B35)
 */

import { basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { EditorView, keymap } from "https://esm.sh/@codemirror/view";
import { EditorState } from "https://esm.sh/@codemirror/state";
import { indentWithTab } from "https://esm.sh/@codemirror/commands";
import { StreamLanguage } from "https://esm.sh/@codemirror/language";
import { autocompletion } from "https://esm.sh/@codemirror/autocomplete";
import { StudioApp } from "./studio-app.js";
import { CommandProcessor, NodaicCliEngine } from "./nodaic-clicore.js";

// ── NDL Tokenizer ─────────────────────────────────────────────────────────
const ndlLanguage = StreamLanguage.define({
    token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match(/#.*/)) return "comment";
        if (stream.match(/"([^"\\]|\\.)*"/) || stream.match(/'([^'\\]|\\.)*'/)) return "string";
        if (stream.match(/\d+(\.\d+)?/)) return "number";
        if (stream.match(/@[a-zA-Z0-9\/\-_\.:]+/)) return "meta";
        if (stream.match(/\b(graph|node|state|input)\b/)) return "keyword";
        if (stream.match(/\b(true|false|null)\b/)) return "atom";
        if (stream.match(/->/)) return "operator";
        if (stream.match(/[a-zA-Z0-9\-_]+/)) return "variableName";
        if (stream.eat("=")) return "operator";
        stream.next(); return null;
    }
});

// ── NDL Autocompletion ────────────────────────────────────────────────────
function buildNdlCompletions(app) {
    return function ndlCompletions(context) {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const fullDoc = context.state.doc.toString();
        const lib = app.library || [];

        const scanNodeRefs = (doc) => {
            const map = {};
            const re = /^node\s+(\S+)\s+@([^:\s]+)(?::(\S+))?/gm;
            let m; while ((m = re.exec(doc))) map[m[1]] = { ref: m[2] };
            return map;
        };
        const libByRef = (ref) => lib.find(e => e.ref === ref) || null;

        let m = /=\s*([A-Za-z]*)$/.exec(before);
        if (m) return { from: context.pos - m[1].length, options: ['true','false','null'].map(v=>({label:v,type:'constant'})), validFor:/^[A-Za-z]*$/ };

        m = /@([\w\-\/]*)$/.exec(before);
        if (m && /^\s*node\s+\S+\s+/.test(before)) return {
            from: context.pos - m[1].length,
            options: lib.map(e => ({
                label: '@' + e.ref,
                apply: '@' + e.ref + (e.version ? `:${e.version}` : ''),
                detail: e.category,
                type: 'class'
            })),
            validFor: /^@[\w\-\/]*$/
        };

        m = /->\s*([a-zA-Z0-9_\-\.]*)$/.exec(before);
        if (m) {
            const nodes = Object.keys(app.getActiveGraphModel().nodes || {});
            return {
                from: context.pos - m[1].length,
                options: nodes.map(id => ({ label: id, type: 'variable' })),
                validFor: /^[a-zA-Z0-9_\-\.]*$/
            };
        }

        m = /->\s*([a-zA-Z0-9_\-]+)\.([a-zA-Z0-9_]*)$/.exec(before);
        if (m) {
            const nodeMap = scanNodeRefs(fullDoc);
            const ref = nodeMap[m[1]]?.ref;
            const entry = ref ? libByRef(ref) : null;
            if (entry && entry.inputs) {
                return {
                    from: context.pos - m[2].length,
                    options: entry.inputs.map(p => ({ label: p.name, type: 'property' })),
                    validFor: /^[a-zA-Z0-9_]*$/
                };
            }
        }

        m = /([a-zA-Z0-9_\-]+)\.([a-zA-Z0-9_]*)$/.exec(before);
        if (m) {
            const nodeMap = scanNodeRefs(fullDoc);
            const ref = nodeMap[m[1]]?.ref;
            const entry = ref ? libByRef(ref) : null;
            if (entry && entry.outputs) {
                return {
                    from: context.pos - m[2].length,
                    options: entry.outputs.map(p => ({ label: p.name, type: 'property' })),
                    validFor: /^[a-zA-Z0-9_]*$/
                };
            }
        }

        if (/^\s*[a-zA-Z]*$/.test(before)) {
            return {
                from: context.pos - before.trim().length,
                options: [
                    { label: 'graph', type: 'keyword', apply: 'graph ${1:name} @version:${2:1.0.0}\n' },
                    { label: 'node',  type: 'keyword', apply: 'node ${1:id} @${2:artifact}\n' },
                    { label: 'state', type: 'keyword', apply: 'state ${1:key} = ${2:value}\n' },
                    { label: 'input', type: 'keyword', apply: 'input ${1:name}\n' },
                ]
            };
        }
        return null;
    };
}

// ── App & State ───────────────────────────────────────────────────────────
const app = new StudioApp();
window.app = app;
app.getActiveGraphModel = function() { return app.graphModel || { nodes: {}, edges: [] }; };
const cliEngine = new NodaicCliEngine(app);
window.cliEngine = cliEngine;
const cli = cliEngine.processor;

// Register studio-specific commands on CLI engine
cliEngine.processor.registerCommand('nodes', () => {
    const g = app.getActiveGraphModel();
    const nodeStats = {};
    Object.keys(g.nodes || {}).forEach(k => {
        nodeStats[k] = nodeTelemetry.get(k) || { status: 'ok', latency: 14 };
    });
    return nodeStats;
}, 'List active canvas nodes and health status', 'nodes');

cliEngine.processor.registerCommand('deploy', async () => {
    if (app.deployActiveGraph) {
        await app.deployActiveGraph();
        return '✓ Active graph deployed to runtime.';
    }
    return 'Deploy action not available.';
}, 'Compile and deploy active graph to runtime', 'deploy');

const $ = id => document.getElementById(id);
const escH = str => String(str||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ══════════════════════════════════════════════════════════════════════════
// TIER 1: ON-CANVAS VISUAL TELEMETRY (0 Clicks / 60fps)
// ══════════════════════════════════════════════════════════════════════════
const nodeTelemetry = new Map();
let hoveredNodeId = null;

function setNodeTelemetry(nodeId, data) {
    const cur = nodeTelemetry.get(nodeId) || { status: 'ok', latency: 14, errorCount: 0, warningCount: 0 };
    nodeTelemetry.set(nodeId, { ...cur, ...data });
    app.network?.redraw();
    syncSummaryStrip();
}

function initCanvasTelemetry() {
    if (!app.network) return;

    app.network.on('hoverNode', params => {
        hoveredNodeId = params.node;
        app.network.redraw();
    });
    app.network.on('blurNode', () => {
        hoveredNodeId = null;
        app.network.redraw();
    });
    app.network.on('click', params => {
        if (params.nodes?.length) {
            setNodeScope(params.nodes[0]);
        } else if (!params.edges?.length) {
            setNodeScope(null);
        }
    });

    app.network.on('afterDrawing', ctx => {
        if (!app.visNodes || !app.network) return;
        const nodeIds = app.visNodes.getIds();
        if (!nodeIds.length) return;

        const time = Date.now();

        nodeIds.forEach(nodeId => {
            const telem = nodeTelemetry.get(nodeId) || { status: 'ok', latency: 14, errorCount: 0 };
            const box = app.network.getBoundingBox(nodeId);
            if (!box || !isFinite(box.top)) return;

            const x = (box.left + box.right) / 2;
            const y = (box.top + box.bottom) / 2;
            const w = box.right - box.left;
            const h = box.bottom - box.top;
            const r = 8;

            ctx.save();

            // 1. Concentric Halo Ring (ONLY when running, error, or warning)
            if (telem.status === 'running' || telem.status === 'err' || telem.status === 'warn' || telem.errorCount > 0) {
                let ringColor = '#DC2626';
                let glowColor = 'rgba(220, 38, 38, 0.35)';
                if (telem.status === 'warn') {
                    ringColor = '#D97706';
                    glowColor = 'rgba(217, 119, 6, 0.3)';
                } else if (telem.status === 'running') {
                    const pulse = (Math.sin(time / 180) + 1) / 2;
                    ringColor = '#FF6B35';
                    glowColor = `rgba(255, 107, 53, ${0.25 + pulse * 0.45})`;
                }

                ctx.strokeStyle = ringColor;
                ctx.lineWidth = telem.status === 'running' ? 2.5 : 2;
                ctx.shadowColor = glowColor;
                ctx.shadowBlur = 8;
                ctx.beginPath();
                ctx.roundRect(box.left - 4, box.top - 4, w + 8, h + 8, r + 2);
                ctx.stroke();
            }

            // 3. Error-Count Badge Chip ("● 2")
            if (telem.errorCount > 0) {
                const errText = `● ${telem.errorCount}`;
                ctx.font = '600 9px "IBM Plex Mono", monospace';
                const etw = ctx.measureText(errText).width;
                const ebw = Math.max(etw + 8, 20);
                const ebh = 16;
                const ebx = box.right - ebw / 2;
                const eby = box.top - ebh / 2;

                ctx.shadowColor = 'rgba(220, 38, 38, 0.4)';
                ctx.shadowBlur = 6;
                ctx.fillStyle = '#DC2626';
                ctx.beginPath();
                ctx.roundRect(ebx, eby, ebw, ebh, 9999);
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.fillStyle = '#FFFFFF';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(errText, ebx + ebw / 2, eby + ebh / 2 + 0.5);
            }

            ctx.restore();
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════
// TIER 2: COLLAPSED RUNNING SUMMARY STRIP
// ══════════════════════════════════════════════════════════════════════════
function syncSummaryStrip() {
    const rt = app.getActiveRuntime();
    const isLive = rt && rt.status !== 'offline';
    const activeGraph = app.getActiveGraph();
    const g = app.getActiveGraphModel();
    const nCnt = Object.keys(g.nodes || {}).length;
    const eCnt = (g.edges || []).length;

    let totalErrors = 0;
    nodeTelemetry.forEach(t => { if (t.errorCount > 0) totalErrors += t.errorCount; });

    const dot = $('ss-conn-dot');
    if (dot) dot.className = 'ss-conn-dot ' + (isLive ? 'live' : 'offline');

    const label = $('ss-conn-label');
    if (label) label.textContent = isLive ? 'Live' : 'Offline';

    const lat = $('ss-latency');
    if (lat) lat.textContent = (rt?.latency || 14) + 'ms';

    const role = $('ss-role-chip');
    if (role) role.textContent = app.getActiveRole()?.name || 'admin';

    const ag = $('ss-active-graph');
    if (ag) ag.textContent = activeGraph?.id || '—';

    const cnt = $('ss-counts');
    if (cnt) cnt.textContent = `${nCnt}N·${eCnt}E`;

    const errBadge = $('ss-err-badge');
    if (errBadge) {
        if (totalErrors > 0) {
            errBadge.textContent = `● ${totalErrors} ERR`;
            errBadge.classList.add('visible');
        } else {
            errBadge.classList.remove('visible');
        }
    }

    // Also sync topbar runtime badge, breadcrumb & empty state
    const rtDot = $('tb-rt-dot');
    const rtLabel = $('tb-rt-label');
    if (rtDot) { rtDot.className = 'pill-dot'; rtDot.classList.add(isLive ? 'live' : 'offline'); }
    if (rtLabel) rtLabel.textContent = rt ? rt.label : 'No Runtime';

    const bcGraph = $('bc-graph-label');
    const bcWrap = $('tb-breadcrumb');
    if (bcGraph && bcWrap) {
        if (activeGraph) { bcGraph.textContent = activeGraph.id; bcWrap.style.display = 'flex'; }
        else bcWrap.style.display = 'none';
    }

    const es = $('empty-state');
    if (es) es.classList.toggle('visible', !rt);

    const ctb = $('canvas-toolbar');
    if (ctb) ctb.style.display = rt ? 'flex' : 'none';
}

// ══════════════════════════════════════════════════════════════════════════
// TIER 3: CHROME DEVTOOLS CONSOLE ENGINE
// ══════════════════════════════════════════════════════════════════════════
let dtLogs = [];
let dtSeverityFilter = 'all';
let dtSearchQuery = '';
let dtIsRegex = false;
let dtPreserveLog = false;
let dtConsoleState = 'docked'; // 'docked' | 'partial' | 'full'
let currentActiveRunGroup = null;

// Sizing controller
function setDrawerState(state) {
    dtConsoleState = state;
    const drawer = $('console-drawer');
    const toggleBtn = $('ss-console-toggle');
    const maxBtn = $('dt-maximize-btn');
    if (!drawer) return;

    drawer.setAttribute('data-state', state);

    if (state === 'docked') {
        toggleBtn?.classList.remove('open');
        if (maxBtn) maxBtn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    } else if (state === 'partial') {
        toggleBtn?.classList.add('open');
        if (maxBtn) maxBtn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
        $('dt-console-input')?.focus();
    } else if (state === 'full') {
        toggleBtn?.classList.add('open');
        if (maxBtn) maxBtn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
        $('dt-console-input')?.focus();
    }

    // Auto-fit canvas so nodes remain visible and reachable when drawer resizes
    setTimeout(() => {
        try {
            app.network?.fit({ animation: { duration: 200 } });
        } catch (_) {}
    }, 250);
}

// Interactive Collapsible Object Tree (§4, §5)
function createJsonTreeElement(data, depth = 0, maxInitialDepth = 1) {
    const isObject = data !== null && typeof data === 'object';
    if (!isObject) {
        const span = document.createElement('span');
        if (typeof data === 'string') {
            span.className = 'dt-str';
            span.textContent = `"${data}"`;
        } else if (typeof data === 'number') {
            span.className = 'dt-num';
            span.textContent = data;
        } else if (typeof data === 'boolean') {
            span.className = 'dt-bool';
            span.textContent = data;
        } else {
            span.className = 'dt-null';
            span.textContent = String(data);
        }
        return span;
    }

    const isArray = Array.isArray(data);
    const keys = Object.keys(data);
    const container = document.createElement('span');
    container.className = 'dt-tree' + (depth < maxInitialDepth ? ' expanded' : '');

    // Preview Header
    const preview = document.createElement('span');
    preview.className = 'dt-tree-preview';

    const fold = document.createElement('span');
    fold.className = 'dt-fold-glyph';
    fold.textContent = '▶';
    preview.appendChild(fold);

    const typeLabel = document.createElement('span');
    if (isArray) {
        typeLabel.textContent = `Array(${keys.length}) `;
    } else {
        const previewKeys = keys.slice(0, 3).map(k => {
            const v = data[k];
            const vStr = typeof v === 'object' && v !== null ? (Array.isArray(v) ? `[Array]` : '{…}') : JSON.stringify(v);
            return `${k}: ${vStr}`;
        }).join(', ');
        typeLabel.textContent = `Object { ${previewKeys}${keys.length > 3 ? ', …' : ''} }`;
    }
    preview.appendChild(typeLabel);
    container.appendChild(preview);

    // Expandable Branch
    const branch = document.createElement('div');
    branch.className = 'dt-tree-branch';

    const renderLimit = 8;
    const initialKeys = keys.slice(0, renderLimit);

    const renderRows = (keyList) => {
        keyList.forEach(k => {
            const row = document.createElement('div');
            row.className = 'dt-tree-row';

            const sep = document.createElement('span');
            sep.className = 'dt-tree-sep';
            sep.textContent = '├─ ';
            row.appendChild(sep);

            const keyEl = document.createElement('span');
            keyEl.className = 'dt-key';
            keyEl.textContent = `${k}: `;
            row.appendChild(keyEl);

            row.appendChild(createJsonTreeElement(data[k], depth + 1, maxInitialDepth));
            branch.appendChild(row);
        });
    };

    renderRows(initialKeys);

    if (keys.length > renderLimit) {
        const moreRow = document.createElement('div');
        moreRow.className = 'dt-tree-row';
        const moreBtn = document.createElement('span');
        moreBtn.className = 'dt-more-btn';
        moreBtn.textContent = `+${keys.length - renderLimit} more properties (click to show)`;
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moreRow.remove();
            renderRows(keys.slice(renderLimit));
        });
        moreRow.appendChild(moreBtn);
        branch.appendChild(moreRow);
    }

    container.appendChild(branch);

    preview.addEventListener('click', (e) => {
        e.stopPropagation();
        container.classList.toggle('expanded');
    });

    return container;
}

// Terminal Output Syntax Formatter
function formatTerminalOutput(text) {
    if (!text || typeof text !== 'string') return '';
    const clean = text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
    const lines = clean.split('\n');

    return lines.map(line => {
        const escaped = escH(line);

        // 1. Box drawing headers / borders: ┌── ... ┐, └── ... ┘, ├── ... ┤
        if (/^\s*[┌├└].*[┐┤┘]\s*$/.test(line)) {
            return `<span class="dt-term-box">${escaped}</span>`;
        }

        // 2. Banner lines: ── Section Title (N) ────────────────────────
        if (/^\s*──\s+.*?\s+──+/.test(line)) {
            return `<span class="dt-term-banner">${escaped}</span>`;
        }

        // 3. Section headers: e.g. "Examples:" or "Usage:" or "Commands:"
        if (/^\s*(Examples|Usage|Commands|Options|Aliases|Arguments|Outputs):\s*$/i.test(line)) {
            return `<span class="dt-term-section">${escaped}</span>`;
        }

        // 4. Table header row: e.g. "  ID                  VER       NAME"
        if (/^\s+(ID\s+VER\s+|EVENT\s+ARTIFACT\s+|ROLE\s+TYPE\s+|KEY\s+DESCRIPTION\s+)/i.test(line)) {
            return `<span class="dt-term-table-head">${escaped}</span>`;
        }

        // 5. Table separator line: e.g. "  ──────────────────────────────────────────"
        if (/^\s*[─\-]{6,}\s*$/.test(line)) {
            return `<span class="dt-term-divider">${escaped}</span>`;
        }

        // 6. Examples list item: e.g. "  whoami                     - Check authenticated role on active runtime"
        const exMatch = line.match(/^(\s{2,})([a-zA-Z0-9_\-\.\s<>|]+?)(\s+-\s+)(.+)$/);
        if (exMatch) {
            const indent = escH(exMatch[1]);
            const cmd = escH(exMatch[2]);
            const sep = escH(exMatch[3]);
            const desc = escH(exMatch[4]);
            return `${indent}<span class="dt-term-cmd">${cmd}</span><span class="dt-term-muted">${sep}</span><span class="dt-term-val">${desc}</span>`;
        }

        // 7. Command list item (e.g. in help): "  whoami                               Show authenticated role..."
        const cmdMatch = line.match(/^(\s{2,})([a-z0-9\-_]+(?:\s+<[^>]+>|\s+\[[^\]]+\])*)(\s{2,})([A-Z0-9].+)$/);
        if (cmdMatch) {
            const indent = escH(cmdMatch[1]);
            let cmdName = escH(cmdMatch[2]);
            const spaces = escH(cmdMatch[3]);
            const desc = escH(cmdMatch[4]);
            cmdName = cmdName.replace(/(&lt;[^&]+&gt;|\[[^\]]+\])/g, '<span class="dt-term-arg">$1</span>');
            return `${indent}<span class="dt-term-cmd">${cmdName}</span>${spaces}<span class="dt-term-val">${desc}</span>`;
        }

        // 8. Key-Value pairs: e.g. "  Role:            ADMIN (Admin Privileges: YES)" or "  Runtime URL:     http://localhost:3030"
        const kvMatch = line.match(/^(\s{2,})([A-Za-z0-9_\s\-]+:)(\s+)(.*)$/);
        if (kvMatch) {
            const indent = escH(kvMatch[1]);
            const key = escH(kvMatch[2]);
            const spaces = escH(kvMatch[3]);
            let val = escH(kvMatch[4]);

            val = val.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" class="dt-term-url">$1</a>');
            val = val.replace(/\b(YES|OK|true|active|live)\b/gi, '<span class="dt-term-val-ok">$1</span>');
            val = val.replace(/\b(NO|FAIL|ERR|error|false|offline)\b/gi, '<span class="dt-term-val-err">$1</span>');
            val = val.replace(/\b(ADMIN|ELEVATED)\b/g, '<span class="dt-term-cmd">$1</span>');

            return `${indent}<span class="dt-term-key">${key}</span>${spaces}<span class="dt-term-val">${val}</span>`;
        }

        // 9. JSON formatting for JSON lines: e.g. '  "key": "value",' or '  "key": 123'
        const jsonMatch = line.match(/^(\s*)("([^"\\]|\\.)*")\s*:\s*(.*)$/);
        if (jsonMatch) {
            const indent = escH(jsonMatch[1]);
            const key = escH(jsonMatch[2]);
            let val = escH(jsonMatch[4]);
            val = val.replace(/^("([^"\\]|\\.)*")(,?)$/, '<span class="dt-term-json-str">$1</span>$3');
            val = val.replace(/^(\d+(?:\.\d+)?)(,?)$/, '<span class="dt-term-json-num">$1</span>$2');
            val = val.replace(/^(true|false|null)(,?)$/, '<span class="dt-term-json-bool">$1</span>$2');
            return `${indent}<span class="dt-term-json-key">${key}</span>: ${val}`;
        }

        // 10. General line: format inline URLs, success checkmarks, error crosses
        let formatted = escaped;
        formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" class="dt-term-url">$1</a>');
        formatted = formatted.replace(/✓/g, '<span class="dt-term-val-ok">✓</span>');
        formatted = formatted.replace(/✗/g, '<span class="dt-term-val-err">✗</span>');

        return formatted;
    }).join('\n');
}

// Log streaming and deduplication
function appendDtLog(entry) {
    // entry: { type: 'log'|'input'|'group', level: 'LOG'|'INFO'|'WARN'|'ERR'|'OK', ts, text, data, nodeId, runId, source }
    const out = $('dt-console-output');
    if (!out) return;

    // Deduplicate consecutive identical messages
    if (dtLogs.length > 0 && entry.type !== 'input' && entry.type !== 'group') {
        const last = dtLogs[dtLogs.length - 1];
        if (last.text === entry.text && last.level === entry.level && last.nodeId === entry.nodeId) {
            last.repeats = (last.repeats || 1) + 1;
            const badge = last.el?.querySelector('.dt-badge');
            if (badge) {
                badge.textContent = `×${last.repeats}`;
                badge.style.display = 'inline-flex';
            }
            return;
        }
    }

    entry.repeats = 1;
    dtLogs.push(entry);

    // 500-entry ring buffer: prune oldest DOM nodes to prevent memory and DOM leak
    const MAX_LOG_ENTRIES = 500;
    while (dtLogs.length > MAX_LOG_ENTRIES) {
        const oldest = dtLogs.shift();
        if (oldest?.el) {
            oldest.el.remove();
        }
    }

    const row = document.createElement('div');
    const lvl = (entry.level || 'LOG').toLowerCase();
    row.className = `dt-row ${lvl} ${entry.type === 'input' ? 'input' : ''}`;
    row.dataset.level = lvl;
    row.dataset.nodeId = entry.nodeId || '';
    row.dataset.text = (entry.text || '') + ' ' + (entry.nodeId || '') + ' ' + (entry.source || '');

    // Timestamp Gutter
    const tsEl = document.createElement('span');
    tsEl.className = 'dt-ts';
    const d = new Date(entry.ts || Date.now());
    tsEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.appendChild(tsEl);

    // Gutter Glyph for User Input (§3)
    if (entry.type === 'input') {
        const gGlyph = document.createElement('span');
        gGlyph.className = 'dt-gutter-glyph';
        gGlyph.textContent = '>';
        row.appendChild(gGlyph);
    }

    // Content container
    const content = document.createElement('div');
    content.className = 'dt-content';

    if (entry.text) {
        const textEl = document.createElement('div');
        textEl.className = 'dt-msg' + (entry.type === 'input' ? ' dt-input-text' : '');
        textEl.innerHTML = formatTerminalOutput(entry.text);
        content.appendChild(textEl);
    }

    if (entry.data !== undefined) {
        content.appendChild(createJsonTreeElement(entry.data, 0, 1));
    }

    // Repeat badge
    const badge = document.createElement('span');
    badge.className = 'dt-badge';
    badge.style.display = 'none';
    badge.textContent = '×1';
    content.appendChild(badge);

    row.appendChild(content);

    // Source Reference Tag (node id + run id)
    if (entry.nodeId || entry.source) {
        const srcTag = document.createElement('a');
        srcTag.className = 'dt-src-tag';
        const tagText = entry.nodeId ? (entry.runId ? `${entry.nodeId} · ${entry.runId}` : entry.nodeId) : (entry.source || 'runtime');
        srcTag.textContent = tagText;
        srcTag.title = entry.nodeId ? `Focus node "${entry.nodeId}" on canvas` : '';
        if (entry.nodeId) {
            srcTag.addEventListener('click', (e) => {
                e.stopPropagation();
                app.network?.focus(entry.nodeId, { animation: { duration: 350, easingFunction: 'easeInOutQuad' }, scale: 1.25 });
                app._renderInspectorNode?.(entry.nodeId);
            });
        }
        row.appendChild(srcTag);
    }

    entry.el = row;

    // Filter check
    applyRowFilter(row);

    // Append to active group or root output
    if (currentActiveRunGroup && entry.type !== 'input') {
        currentActiveRunGroup.body.appendChild(row);
    } else {
        out.appendChild(row);
    }

    out.scrollTop = out.scrollHeight;
    updateFilterCounts();
}

function startRunGroup(runId, artifactId, latency = null) {
    const out = $('dt-console-output');
    if (!out) return;

    const group = document.createElement('div');
    group.className = 'dt-group';
    group.dataset.runId = runId;

    const header = document.createElement('div');
    header.className = 'dt-group-header';
    header.innerHTML = `
        <span class="dt-group-chevron">▼</span>
        <span>Run: <strong>${escH(runId)}</strong></span>
        <span style="opacity:.7">(${escH(artifactId)})</span>
        <span class="dt-group-meta">${latency ? latency + 'ms' : 'active'}</span>
    `;

    const body = document.createElement('div');
    body.className = 'dt-group-body';

    group.appendChild(header);
    group.appendChild(body);
    out.appendChild(group);

    header.addEventListener('click', () => {
        group.classList.toggle('closed');
    });

    currentActiveRunGroup = { group, header, body, runId };
}

function endRunGroup() {
    currentActiveRunGroup = null;
}

// Contextual Node Scoping State
let dtActiveNodeScope = null;

function setNodeScope(nodeId) {
    dtActiveNodeScope = nodeId;
    const scopeContainer = $('dt-scope-container');
    if (scopeContainer) {
        if (nodeId) {
            scopeContainer.innerHTML = `
                <span class="dt-scope-chip" id="dt-node-scope">
                    <span class="scope-dot"></span>
                    <span>${escH(nodeId)}</span>
                    <span class="scope-close" title="Clear node filter">✕</span>
                </span>
            `;
            scopeContainer.querySelector('.scope-close')?.addEventListener('click', (e) => {
                e.stopPropagation();
                setNodeScope(null);
            });
        } else {
            scopeContainer.innerHTML = '';
        }
    }
    applyAllFilters();
}

// Filter engine
function applyRowFilter(row) {
    if (!row || !row.dataset) return;
    const lvl = row.dataset.level;
    const text = row.dataset.text || '';
    const rowNodeId = row.dataset.nodeId || '';

    // Node scope check
    let passScope = true;
    if (dtActiveNodeScope && !row.classList.contains('input')) {
        passScope = (rowNodeId === dtActiveNodeScope) || text.includes(dtActiveNodeScope);
    }

    // Level check
    let passLevel = dtSeverityFilter === 'all' || lvl === dtSeverityFilter;
    if (row.classList.contains('input')) passLevel = true;

    // Search query check
    let passSearch = true;
    if (dtSearchQuery) {
        if (dtIsRegex) {
            try {
                const re = new RegExp(dtSearchQuery, 'i');
                passSearch = re.test(text);
            } catch {
                passSearch = text.toLowerCase().includes(dtSearchQuery.toLowerCase());
            }
        } else {
            passSearch = text.toLowerCase().includes(dtSearchQuery.toLowerCase());
        }
    }

    if (passScope && passLevel && passSearch) {
        row.classList.remove('hidden');
    } else {
        row.classList.add('hidden');
    }
}

function applyAllFilters() {
    const rows = document.querySelectorAll('#dt-console-output .dt-row');
    rows.forEach(applyRowFilter);
    updateFilterCounts();
}

function updateFilterCounts() {
    const counts = { all: 0, err: 0, warn: 0, info: 0, log: 0 };
    dtLogs.forEach(e => {
        counts.all++;
        const l = (e.level || 'LOG').toLowerCase();
        if (l === 'error' || l === 'err') counts.err++;
        else if (l === 'warn') counts.warn++;
        else if (l === 'info') counts.info++;
        else if (l === 'log' || l === 'ok') counts.log++;
    });

    $('dt-cnt-all') && ($('dt-cnt-all').textContent = counts.all);
    $('dt-cnt-err') && ($('dt-cnt-err').textContent = counts.err);
    $('dt-cnt-warn') && ($('dt-cnt-warn').textContent = counts.warn);
    $('dt-cnt-info') && ($('dt-cnt-info').textContent = counts.info);
    $('dt-cnt-log') && ($('dt-cnt-log').textContent = counts.log);
}

// ── Hook App Logging ──────────────────────────────────────────────────────
const origLogEvent = app.logEvent.bind(app);
app.logEvent = function(source, type, message, level = 'INFO') {
    origLogEvent(source, type, message, level);

    let parsedNodeId = null;
    let parsedRunId = null;

    // Extract nodeId / runId if formatted
    const runMatch = /\[Run:\s*([a-zA-Z0-9_\-]+)\]/.exec(message);
    if (runMatch) parsedRunId = runMatch[1];

    const nodeMatch = /node\s+([a-zA-Z0-9_\-]+)/i.exec(message) || /artifact\s+"?([a-zA-Z0-9_\-]+)"?/i.exec(message);
    if (nodeMatch) parsedNodeId = nodeMatch[1];

    // Update Tier 1 canvas telemetry on warnings/errors
    if (parsedNodeId) {
        if (level === 'ERROR') {
            const cur = nodeTelemetry.get(parsedNodeId) || { errorCount: 0 };
            setNodeTelemetry(parsedNodeId, { status: 'err', errorCount: cur.errorCount + 1 });
        } else if (level === 'WARN') {
            setNodeTelemetry(parsedNodeId, { status: 'warn' });
        }
    }

    appendDtLog({
        type: 'log',
        level: level === 'ERROR' ? 'ERR' : level,
        ts: Date.now(),
        text: message,
        nodeId: parsedNodeId,
        runId: parsedRunId,
        source: source
    });
};

// Hook Graph Run Execution for automatic Run Grouping & Particle Rings
const origDeploy = app.deployActiveGraph?.bind(app);
if (origDeploy) {
    app.deployActiveGraph = async function() {
        const g = app.getActiveGraph();
        if (g) {
            startRunGroup(`deploy_${Date.now().toString(36)}`, g.id);
            appendDtLog({ type: 'log', level: 'INFO', ts: Date.now(), text: `Deploying graph "${g.id}" to runtime library...`, nodeId: g.id });
        }
        try {
            await origDeploy();
            endRunGroup();
        } catch (e) {
            appendDtLog({ type: 'log', level: 'ERR', ts: Date.now(), text: `Deploy failed: ${e.message}`, nodeId: g?.id });
            endRunGroup();
        }
    };
}

// ── Top Filter Bar Wireup ─────────────────────────────────────────────────
function initFilterBar() {
    const searchInput = $('dt-fb-search');
    const clearSearch = $('dt-fb-clear-search');

    searchInput?.addEventListener('input', () => {
        dtSearchQuery = searchInput.value;
        applyAllFilters();
    });

    clearSearch?.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        dtSearchQuery = '';
        applyAllFilters();
    });

    // Severity pills
    document.querySelectorAll('.dt-level-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.dt-level-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            dtSeverityFilter = pill.dataset.filter || 'all';
            applyAllFilters();
        });
    });

    // Clear console (Ctrl+L)
    $('dt-clear-btn')?.addEventListener('click', () => {
        const out = $('dt-console-output');
        if (out) out.innerHTML = '';
        dtLogs = [];
        updateFilterCounts();
        appendDtLog({ type: 'log', level: 'INFO', ts: Date.now(), text: 'Console cleared. (Press help for CLI commands)' });
    });

    // Console Settings Popover (Progressive Disclosure)
    const settingsBtn = $('dt-settings-btn');
    const settingsPopover = $('dt-settings-popover');
    settingsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = settingsPopover?.classList.toggle('open');
        settingsBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    document.addEventListener('click', (e) => {
        if (settingsPopover?.classList.contains('open') && !settingsPopover.contains(e.target) && e.target !== settingsBtn) {
            settingsPopover.classList.remove('open');
            settingsBtn?.setAttribute('aria-expanded', 'false');
        }
    });

    const optRegex = $('dt-opt-regex');
    optRegex?.addEventListener('change', () => {
        dtIsRegex = optRegex.checked;
        applyAllFilters();
    });

    const optTimestamps = $('dt-opt-timestamps');
    optTimestamps?.addEventListener('change', () => {
        $('dt-console-output')?.classList.toggle('hide-timestamps', !optTimestamps.checked);
    });

    const optCompact = $('dt-opt-compact');
    optCompact?.addEventListener('change', () => {
        $('dt-console-output')?.classList.toggle('compact-mode', optCompact.checked);
    });

    const optPreserve = $('dt-opt-preserve');
    optPreserve?.addEventListener('change', () => {
        dtPreserveLog = optPreserve.checked;
    });

    // Shortcuts Modal Controls
    const shortcutsOverlay = $('shortcuts-overlay');
    function openShortcutsModal() {
        shortcutsOverlay?.classList.add('open');
        shortcutsOverlay?.classList.add('active');
        document.activeElement?.blur?.();
    }
    function closeShortcutsModal() {
        shortcutsOverlay?.classList.remove('open');
        shortcutsOverlay?.classList.remove('active');
    }
    $('shortcuts-close')?.addEventListener('click', closeShortcutsModal);
    shortcutsOverlay?.addEventListener('click', (e) => {
        if (e.target === shortcutsOverlay) closeShortcutsModal();
    });
    $('dt-opt-shortcuts')?.addEventListener('click', () => {
        settingsPopover?.classList.remove('open');
        settingsBtn?.setAttribute('aria-expanded', 'false');
        openShortcutsModal();
    });
    window._openShortcutsModal = openShortcutsModal;
    window._closeShortcutsModal = closeShortcutsModal;

    // Maximize toggle
    $('dt-maximize-btn')?.addEventListener('click', () => {
        if (dtConsoleState === 'full') setDrawerState('partial');
        else setDrawerState('full');
    });

    // Status strip click toggles drawer
    $('status-strip')?.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (dtConsoleState === 'docked') setDrawerState('partial');
        else setDrawerState('docked');
    });

    $('ss-console-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dtConsoleState === 'docked') setDrawerState('partial');
        else setDrawerState('docked');
    });

    // Command History & Autocomplete State
    const cmdHistory = [];
    let cmdHistoryIdx = -1;
    let cmdDraft = '';

    // CLI Input with History, Autocomplete, Multiline (Shift+Enter), & Unified Slash Commands
    const consoleInput = $('dt-console-input');
    function autoResizeConsoleInput() {
        if (!consoleInput) return;
        consoleInput.style.height = 'auto';
        consoleInput.style.height = Math.min(consoleInput.scrollHeight, 120) + 'px';
    }
    consoleInput?.addEventListener('input', autoResizeConsoleInput);

    consoleInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowUp') {
            const val = consoleInput.value;
            const isSingleLine = !val.includes('\n');
            const isAtFirstLine = consoleInput.selectionStart <= (val.indexOf('\n') === -1 ? val.length : val.indexOf('\n'));

            if (isSingleLine || isAtFirstLine) {
                if (cmdHistory.length === 0) return;
                e.preventDefault();
                if (cmdHistoryIdx === -1) cmdDraft = consoleInput.value;
                if (cmdHistoryIdx < cmdHistory.length - 1) {
                    cmdHistoryIdx++;
                    consoleInput.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx];
                    autoResizeConsoleInput();
                }
            }
            return;
        }

        if (e.key === 'ArrowDown') {
            const val = consoleInput.value;
            const isSingleLine = !val.includes('\n');
            const lastNl = val.lastIndexOf('\n');
            const isAtLastLine = consoleInput.selectionStart > (lastNl === -1 ? 0 : lastNl);

            if (isSingleLine || isAtLastLine) {
                if (cmdHistoryIdx > 0) {
                    e.preventDefault();
                    cmdHistoryIdx--;
                    consoleInput.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx];
                    autoResizeConsoleInput();
                } else if (cmdHistoryIdx === 0) {
                    e.preventDefault();
                    cmdHistoryIdx = -1;
                    consoleInput.value = cmdDraft;
                    autoResizeConsoleInput();
                }
            }
            return;
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            const val = consoleInput.value;
            const tokens = val.split(/\s+/);
            const lastToken = tokens[tokens.length - 1] || '';
            if (!lastToken) return;

            const builtInCmds = [
                'whoami', 'status', 'ping', 'help', 'nodes', 'deploy', 'clear',
                'artifact', 'graph', 'runtime', 'trigger', 'run', 'sudo-session',
                '/err', '/warn', '/info', '/log', '/all', '/clear'
            ];
            const nodeIds = Object.keys(app.getActiveGraphModel()?.nodes || {});
            const candidates = [...builtInCmds, ...nodeIds];

            const match = candidates.find(c => c.toLowerCase().startsWith(lastToken.toLowerCase()) && c.toLowerCase() !== lastToken.toLowerCase());
            if (match) {
                tokens[tokens.length - 1] = match;
                consoleInput.value = tokens.join(' ') + (tokens.length === 1 ? ' ' : '');
                autoResizeConsoleInput();
            }
            return;
        }

        if (e.key === 'Escape') {
            if (dtActiveNodeScope) {
                setNodeScope(null);
            }
            return;
        }

        // Shift+Enter: allow newline insertion and auto-expand
        if (e.key === 'Enter' && e.shiftKey) {
            setTimeout(autoResizeConsoleInput, 0);
            return;
        }

        // Enter without Shift: execute command
        if (e.key === 'Enter' && !e.shiftKey && consoleInput.value.trim()) {
            e.preventDefault();
            const raw = consoleInput.value.trim();
            consoleInput.value = '';
            consoleInput.style.height = 'auto';
            cmdHistory.push(raw);
            cmdHistoryIdx = -1;
            cmdDraft = '';

            // Render typed input row with distinct gutter marker (§3)
            appendDtLog({ type: 'input', level: 'LOG', ts: Date.now(), text: raw });

            // Unified Prompt: Slash Commands for quick filtering
            if (raw.startsWith('/')) {
                const slash = raw.slice(1).toLowerCase().trim();
                if (slash === 'err' || slash === 'error') {
                    document.querySelector('.dt-level-pill.err')?.click();
                    return;
                }
                if (slash === 'warn' || slash === 'warning') {
                    document.querySelector('.dt-level-pill.warn')?.click();
                    return;
                }
                if (slash === 'info') {
                    document.querySelector('.dt-level-pill.info')?.click();
                    return;
                }
                if (slash === 'log') {
                    document.querySelector('.dt-level-pill.log')?.click();
                    return;
                }
                if (slash === 'all') {
                    document.querySelector('.dt-level-pill[data-filter="all"]')?.click();
                    return;
                }
                if (slash === 'clear') {
                    $('dt-clear-btn')?.click();
                    return;
                }

                // Filter search query
                const searchInput = $('dt-fb-search');
                if (searchInput) {
                    searchInput.value = raw.slice(1);
                    dtSearchQuery = raw.slice(1);
                    applyAllFilters();
                }
                return;
            }

            if (raw === 'clear' || raw === 'cls') {
                $('dt-clear-btn')?.click();
                return;
            }

            try {
                const result = await cliEngine.execute(raw);
                if (result !== undefined && result !== null) {
                    if (typeof result === 'string') {
                        if (result.trim()) {
                            appendDtLog({ type: 'log', level: 'LOG', ts: Date.now(), text: result });
                        }
                    } else if (typeof result === 'object') {
                        appendDtLog({ type: 'log', level: 'OK', ts: Date.now(), data: result });
                    }
                }
            } catch (err) {
                appendDtLog({ type: 'log', level: 'ERR', ts: Date.now(), text: err.message });
            }
        }
    });
}

// ── View Switching ────────────────────────────────────────────────────────
let currentView = 'visual';

function setView(view) {
    currentView = view;
    $('stage')?.setAttribute('data-view', view);
    document.querySelectorAll('.view-seg-btn, .ctb-btn.view-toggle').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (view === 'code' || view === 'split') {
        if (!app.editorView) initEditor();
        setTimeout(() => app.editorView?.requestMeasure(), 60);
    }
    if (view === 'visual' || view === 'split') {
        setTimeout(() => app.network?.fit({ animation: { duration: 250 } }), 80);
    }
}

// ── CodeMirror Editor ─────────────────────────────────────────────────────
function initEditor() {
    const parent = $('ndl-editor');
    if (!parent || app.editorView) return;

    const g = app.getActiveGraph();
    const doc = g ? (g.ndl || '') : '';

    const startState = EditorState.create({
        doc,
        extensions: [
            basicSetup,
            keymap.of([indentWithTab]),
            ndlLanguage,
            autocompletion({ override: [buildNdlCompletions(app)] }),
            EditorView.updateListener.of(update => {
                if (update.docChanged) {
                    const code = update.state.doc.toString();
                    if (typeof app.handleCodeChange === 'function') {
                        app.handleCodeChange(code);
                    } else if (typeof app.applyCode === 'function') {
                        app.applyCode(true, code);
                    }
                }
            })
        ]
    });

    app.editorView = new EditorView({ state: startState, parent });
}

// ── Floating Panels ───────────────────────────────────────────────────────
let activePanel = null;

function openPanel(id, triggerBtn) {
    closeAllPanels();
    const panel = $(`panel-${id}`);
    if (!panel) return;

    panel.classList.add('open');
    $('glass-panel-overlay')?.classList.add('active');
    triggerBtn?.classList.add('active');
    activePanel = id;

    if (triggerBtn && window.innerWidth > 640) {
        const r = triggerBtn.getBoundingClientRect();
        const pw = panel.offsetWidth || (panel.classList.contains('glass-panel--wide') ? 340 : 260);
        let left = r.left + r.width / 2 - pw / 2;
        left = Math.max(12, Math.min(window.innerWidth - pw - 12, left));
        panel.style.left = `${left}px`;
        panel.style.top = `${r.bottom + 8}px`;
    }

    renderPanelContent(id);
}

function closeAllPanels() {
    document.querySelectorAll('.glass-panel').forEach(p => p.classList.remove('open'));
    $('glass-panel-overlay')?.classList.remove('active');
    document.querySelectorAll('.tb-nav-btn').forEach(b => b.classList.remove('active'));
    activePanel = null;
}

function togglePanel(id, triggerBtn) {
    if (activePanel === id) closeAllPanels();
    else openPanel(id, triggerBtn);
}

function _closePanel(id) {
    $(`panel-${id}`)?.classList.remove('open');
    if (activePanel === id) {
        $('glass-panel-overlay')?.classList.remove('active');
        document.querySelectorAll('.tb-nav-btn').forEach(b => b.classList.remove('active'));
        activePanel = null;
    }
}

function renderPanelContent(id) {
    if (id === 'graphs') renderGraphsPanel();
    else if (id === 'library') renderLibraryPanel();
    else if (id === 'secrets') renderSecretsPanel();
    else if (id === 'triggers') renderTriggersPanel();
    else if (id === 'roles') renderRolesPanel();
    else if (id === 'runtimes') renderRuntimesPanel();
    else if (id === 'rt-picker') renderRtPickerPanel();
    else if (id === 'run-log') renderRunLogPanel();
    else if (id === 'audit-log') renderAuditLogPanel();
}

function renderGraphsPanel() {
    const body = $('panel-graphs-body');
    if (!body) return;
    const rt = app.getActiveRuntime();
    const graphs = rt ? Object.values(rt.graphs || {}) : [];
    const activeId = app.state.getValue('/activeGraphId');
    const isWrite = app.isWriteMode();

    if (!graphs.length) {
        body.innerHTML = `<div class="gp-empty">No graphs yet.<br>Click <strong>New</strong> above to create one.</div>`;
        return;
    }

    body.innerHTML = graphs.map(g => `
        <div class="gp-row ${g.id === activeId ? 'active' : ''}" data-graph-id="${escH(g.id)}" tabindex="0">
            <div class="gp-row-dot" style="background:var(--flame)"></div>
            <div style="flex:1;min-width:0">
                <div class="gp-row-name mono">${escH(g.label || g.id)}</div>
                <div class="gp-row-meta">${escH(g.version ? 'v' + g.version : '')}</div>
            </div>
            ${isWrite ? `
            <div class="gp-row-actions">
                <button class="gp-row-action" data-rename-graph="${escH(g.id)}" title="Rename">✎</button>
            </div>` : ''}
        </div>
    `).join('');

    body.querySelectorAll('[data-graph-id]').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('[data-rename-graph]')) return;
            app.loadGraph(app.state.getValue('/activeRuntimeId'), row.dataset.graphId);
            closeAllPanels();
        });
    });
    body.querySelectorAll('[data-rename-graph]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            app.openSheet('rename-graph', { id: btn.dataset.renameGraph });
        });
    });
}

function renderLibraryPanel() {
    const body = $('panel-library-body');
    if (!body) return;
    const lib = app.library || [];
    const query = ($('lib-search')?.value || '').toLowerCase();
    const filtered = query ? lib.filter(l => (l.ref || '').toLowerCase().includes(query) || (l.label || '').toLowerCase().includes(query)) : lib;

    if (!filtered.length) {
        body.innerHTML = `<div class="gp-empty">${query ? `No nodes match "${escH(query)}"` : 'No library artifacts loaded. Connect a runtime first.'}</div>`;
        return;
    }

    const grouped = {};
    filtered.forEach(item => {
        const cat = item.category || 'Process';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(item);
    });

    body.innerHTML = Object.entries(grouped).map(([cat, items]) => `
        <div class="gp-category">${escH(cat)}</div>
        ${items.map(item => `
            <div class="gp-row" data-lib-ref="${escH(item.ref)}" tabindex="0" title="${escH(item.label || item.ref)}">
                <div style="flex:1;min-width:0">
                    <div class="gp-row-name mono">${escH(item.ref)}</div>
                    <div class="gp-row-meta">${(item.inputs?.length || 0)}↑ ${(item.outputs?.length || 0)}↓</div>
                </div>
            </div>
        `).join('')}
    `).join('');

    body.querySelectorAll('[data-lib-ref]').forEach(row => {
        row.addEventListener('click', () => {
            const item = app.library?.find(l => l.ref === row.dataset.libRef);
            if (item) {
                if (app._addNodeFromLib) {
                    app._addNodeFromLib(item);
                    app.showToast(`+ ${item.ref}`);
                    closeAllPanels();
                } else if (app.isWriteMode()) {
                    app.openSheet('add-node', { artifactRef: row.dataset.libRef });
                    closeAllPanels();
                } else {
                    app.showToast('Switch to Write mode to insert nodes', true);
                }
            }
        });
    });
}

function renderSecretsPanel() {
    const body = $('panel-secrets-body');
    if (!body) return;
    const rt = app.getActiveRuntime();
    const secrets = rt?.secrets || {};
    const entries = Object.entries(secrets);
    const isWrite = app.isWriteMode();
    const svgKey = `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

    if (!entries.length) {
        body.innerHTML = `<div class="gp-empty">No secrets yet.<br>Click <strong>Add</strong> above to add credentials.</div>`;
        return;
    }

    body.innerHTML = entries.map(([k, s]) => `
        <div class="gp-card">
            <div class="gp-card-top">
                <div class="gp-card-icon flame">${svgKey}</div>
                <div style="flex:1;min-width:0">
                    <div class="gp-card-name">${escH(k)}</div>
                    <div class="gp-card-desc mono" style="letter-spacing:2px">••••••••••${escH((s?.preview || s?.value || '').slice(-4))}</div>
                </div>
            </div>
            ${isWrite ? `
            <div class="gp-card-actions">
                <button class="gp-card-action" data-edit-sec="${escH(k)}" title="Edit">✎</button>
                <button class="gp-card-action danger" data-del-sec="${escH(k)}" title="Delete">✕</button>
            </div>` : ''}
        </div>
    `).join('');

    body.querySelectorAll('[data-edit-sec]').forEach(btn => btn.addEventListener('click', () => app.openSheet('add-secret', { key: btn.dataset.editSec, isEdit: true })));
    body.querySelectorAll('[data-del-sec]').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.delSec;
        app.confirmDestructiveAction('Delete Secret', `Delete secret "${key}"?`, () => {
            if (app.deleteSecret) app.deleteSecret(key);
            else {
                delete rt.secrets[key];
                app.showToast(`Deleted secret "${key}"`);
                renderSecretsPanel();
            }
        });
    }));
}

function renderTriggersPanel() {
    const body = $('panel-triggers-body');
    if (!body) return;
    const rt = app.getActiveRuntime();
    const triggers = rt?.triggers || {};
    const entries = Object.entries(triggers);
    const isWrite = app.isWriteMode();
    const svgBolt = `<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    const DLABEL = { trigger: 'HTTP', async: 'Async (202)', sync: 'Sync (Wait)' };

    if (!entries.length) {
        body.innerHTML = `<div class="gp-empty">No event triggers bound.<br>Click <strong>Bind</strong> above to map an event.</div>`;
        return;
    }

    body.innerHTML = entries.map(([ev, t]) => {
        const roles = t.access?.roles || t.roles || [];
        return `
        <div class="gp-card">
            <div class="gp-card-top">
                <div class="gp-card-icon flame">${svgBolt}</div>
                <div style="flex:1;min-width:0">
                    <div class="gp-card-name">${escH(ev)}</div>
                    <div class="gp-card-desc">Maps to: <span class="mono">${escH(t.artifact || '')}</span></div>
                </div>
            </div>
            <div class="gp-card-meta">
                <span class="chip flame">${escH(DLABEL[t.delivery] || t.delivery || 'HTTP')}</span>
                ${roles.map(r => `<span class="chip ${r === 'admin' ? 'flame' : ''}">${escH(r)}</span>`).join('')}
                ${t.once ? `<span class="chip crimson">once</span>` : ''}
            </div>
            ${isWrite ? `
            <div class="gp-card-actions">
                <button class="gp-card-action" data-edit-trig="${escH(ev)}" title="Edit">✎</button>
                <button class="gp-card-action danger" data-del-trig="${escH(ev)}" title="Unbind">✕</button>
            </div>` : ''}
        </div>`;
    }).join('');

    body.querySelectorAll('[data-edit-trig]').forEach(btn => btn.addEventListener('click', () => {
        const t = rt?.triggers?.[btn.dataset.editTrig];
        if (t) {
            if (app.openSheet) app.openSheet('edit-trigger', { trigger: t });
        }
    }));
    body.querySelectorAll('[data-del-trig]').forEach(btn => btn.addEventListener('click', () => {
        const ev = btn.dataset.delTrig;
        app.confirmDestructiveAction('Unbind Trigger', `Unbind trigger "${ev}"?`, () => {
            if (app.deleteTrigger) app.deleteTrigger(ev);
            else {
                delete rt.triggers[ev];
                app.showToast(`Unbound trigger "${ev}"`);
                renderTriggersPanel();
            }
        });
    }));
}

function renderRolesPanel() {
    const body = $('panel-roles-body');
    if (!body) return;
    const rt = app.getActiveRuntime();
    const roles = Object.values(rt?.roles || {});
    const isWrite = app.isWriteMode();
    const activeRole = app.getActiveRole();
    const svgUser = `<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

    if (!roles.length) {
        body.innerHTML = `<div class="gp-empty">No role keys configured.<br>Click <strong>Add</strong> above to create one.</div>`;
        return;
    }

    body.innerHTML = roles.map(r => {
        const isCurrent = r.name === activeRole?.keyId || r.name === activeRole?.name;
        const roleBadge = r.role || (r.isAdmin ? 'admin' : 'device');
        return `
        <div class="gp-card" ${isCurrent ? 'style="border-color:var(--flame)"' : ''}>
            <div class="gp-card-top">
                <div class="gp-card-icon ${r.isAdmin ? 'flame' : 'slate'}">${svgUser}</div>
                <div style="flex:1;min-width:0">
                    <div class="gp-card-name">${escH(r.name)} ${isCurrent ? `<span class="chip flame" style="font-size:9px;padding:0 4px">YOU</span>` : ''}</div>
                    <div class="gp-card-desc">${escH(r.description || roleBadge)}</div>
                </div>
            </div>
            <div class="gp-card-meta">
                <span class="chip ${roleBadge === 'admin' ? 'flame' : 'amber'}">${escH(roleBadge)}</span>
                ${r.isAdmin ? `<span class="chip jade">admin</span>` : ''}
            </div>
            ${isWrite ? `
            <div class="gp-card-actions">
                <button class="gp-card-action" data-edit-role="${escH(r.name)}" title="Edit">✎</button>
                <button class="gp-card-action danger" data-del-role="${escH(r.name)}" title="Revoke">✕</button>
            </div>` : ''}
        </div>`;
    }).join('');

    body.querySelectorAll('[data-edit-role]').forEach(btn => btn.addEventListener('click', () => {
        const role = rt?.roles?.[btn.dataset.editRole];
        if (role) app.openSheet('edit-role', { role });
    }));
    body.querySelectorAll('[data-del-role]').forEach(btn => btn.addEventListener('click', () => {
        const name = btn.dataset.delRole;
        app.confirmDestructiveAction('Revoke Role', `Revoke role "${name}"?`, () => {
            if (app.deleteRole) app.deleteRole(name);
            else {
                delete rt.roles[name];
                app.showToast(`Revoked role "${name}"`);
                renderRolesPanel();
            }
        });
    }));
}

function renderRuntimesPanel() {
    const body = $('panel-runtimes-body');
    if (!body) return;
    const rts = Object.values(app.state.getValue('/runtimes') || {});
    const activeId = app.state.getValue('/activeRuntimeId');
    const isWrite = app.isWriteMode();

    body.innerHTML = !rts.length
        ? `<div class="gp-empty">No runtimes connected.<br>Click <strong>Connect</strong> above.</div>`
        : rts.map(r => `
            <div class="gp-row ${r.id === activeId ? 'active' : ''}" data-rt-id="${escH(r.id)}" tabindex="0">
                <div class="gp-row-dot"></div>
                <div style="flex:1;min-width:0">
                    <div class="gp-row-name">${escH(r.label || r.id)}</div>
                    <div class="gp-row-meta">${escH((r.url || '').replace(/^https?:\/\//, ''))}</div>
                </div>
                ${r.id === activeId ? `<span class="chip jade" style="font-size:9px">active</span>` : ''}
                ${isWrite ? `
                <div class="gp-row-actions">
                    <button class="gp-row-action" data-edit-rt="${escH(r.id)}" title="Configure Runtime">✎</button>
                </div>` : ''}
            </div>
        `).join('');

    body.querySelectorAll('[data-rt-id]').forEach(row => row.addEventListener('click', e => {
        if (e.target.closest('[data-edit-rt]')) return;
        app.switchRuntime(row.dataset.rtId);
        closeAllPanels();
        syncAll();
    }));
    body.querySelectorAll('[data-edit-rt]').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.editRt;
        const r = (app.state.getValue('/runtimes') || {})[id];
        if (r) {
            closeAllPanels();
            app.openSheet('edit-runtime', { runtime: r });
        }
    }));
}

function renderRtPickerPanel() {
    const body = $('panel-rt-picker-body');
    if (!body) return;
    const rts = Object.values(app.state.getValue('/runtimes') || {});
    const activeId = app.state.getValue('/activeRuntimeId');

    body.innerHTML = !rts.length
        ? `<div class="gp-empty">No runtimes connected.</div>`
        : rts.map(r => `
            <div class="gp-row ${r.id === activeId ? 'active' : ''}" data-rt-pick="${escH(r.id)}" tabindex="0">
                <div class="gp-row-dot"></div>
                <div style="flex:1;min-width:0">
                    <div class="gp-row-name">${escH(r.label || r.id)}</div>
                    <div class="gp-row-meta">${escH((r.url || '').replace(/^https?:\/\//, ''))}</div>
                </div>
                ${r.id === activeId ? `<span class="chip jade" style="font-size:9px">✓</span>` : ''}
            </div>
        `).join('');

    body.querySelectorAll('[data-rt-pick]').forEach(row => row.addEventListener('click', () => {
        app.switchRuntime(row.dataset.rtPick);
        closeAllPanels();
        syncAll();
    }));
}

function renderRunLogPanel() {
    const list = $('panel-graphs-body');
    if (!list) return;
    const logs = app.runHistory || [];
    if (!logs.length) {
        list.innerHTML = `<div class="gp-empty">No execution runs recorded yet. Press Run (⌘↵) to trigger graph.</div>`;
        return;
    }
    list.innerHTML = logs.slice(0, 15).map(r => `
        <div class="gp-card">
            <div class="gp-card-name mono">${escH(r.id || r.runId)}</div>
            <div class="gp-card-desc">${escH(r.graphId || 'logger')} · ${r.duration || 14}ms</div>
            <div class="gp-card-meta"><span class="chip ${r.status==='ok'?'jade':'crimson'}">${r.status||'ok'}</span></div>
        </div>
    `).join('');
}

function renderAuditLogPanel() {
    const list = $('panel-graphs-body');
    if (!list) return;
    const events = app.eventLog || [];
    if (!events.length) {
        list.innerHTML = `<div class="gp-empty">No audit events logged.</div>`;
        return;
    }
    list.innerHTML = events.slice(-15).reverse().map(ev => `
        <div class="gp-card">
            <div class="gp-card-name">${escH(ev.action || ev.type)}</div>
            <div class="gp-card-desc">${escH(ev.details || ev.message)}</div>
            <div class="gp-card-meta"><span class="chip">${new Date(ev.ts||Date.now()).toLocaleTimeString()}</span></div>
        </div>
    `).join('');
}

// ── Command Palette (⌘K) ──────────────────────────────────────────────────
let cmdOpen = false;
let cmdSelectedIndex = 0;
let cmdFilteredList = [];

function openCmd() {
    cmdOpen = true;
    $('cmd-overlay')?.classList.add('open');
    const inp = $('cmd-input');
    if (inp) { inp.value = ''; inp.focus(); }
    renderCmdResults('');
}

function closeCmd() {
    cmdOpen = false;
    $('cmd-overlay')?.classList.remove('open');
}

function getCmdItems() {
    return [
        { label: 'Run Active Graph', meta: '⌘↵', fn: () => app.runActiveGraph?.() },
        { label: 'Deploy Active Graph', meta: '⌘⇧D', fn: () => app.deployActiveGraph?.() },
        { label: 'New Graph...', meta: '', fn: () => app.openSheet('add-graph') },
        { label: 'Add Node to Graph...', meta: 'A', fn: () => app.openSheet('add-node') },
        { label: 'Link Nodes Mode', meta: 'L', fn: () => app.startLinking?.() },
        { label: 'Fit View to Canvas', meta: 'F', fn: () => app.network?.fit({ animation: { duration: 300 } }) },
        { label: 'Switch to Visual View', meta: '⌘1', fn: () => setView('visual') },
        { label: 'Switch to Code View', meta: '⌘2', fn: () => setView('code') },
        { label: 'Switch to Split View', meta: '⌘3', fn: () => setView('split') },
        { label: 'Toggle Terminal Console', meta: '', fn: () => setDrawerState(dtConsoleState === 'docked' ? 'partial' : 'docked') },
        { label: 'Open Node Library', meta: '', fn: () => openPanel('library', $('nav-library')) },
        { label: 'Manage Secrets', meta: '', fn: () => openPanel('secrets', $('nav-secrets')) },
        { label: 'Manage Triggers', meta: '', fn: () => openPanel('triggers', $('nav-triggers')) },
        { label: 'Manage Roles', meta: '', fn: () => openPanel('roles', $('nav-roles')) },
        { label: 'Manage Runtimes', meta: '', fn: () => openPanel('runtimes', $('nav-runtimes')) },
        { label: 'Connect Runtime...', meta: '', fn: () => app.openSheet('add-runtime') },
    ];
}

function renderCmdResults(q) {
    const list = $('cmd-results');
    if (!list) return;
    const all = getCmdItems();
    cmdFilteredList = q ? all.filter(item => item.label.toLowerCase().includes(q.toLowerCase())) : all;
    cmdSelectedIndex = 0;

    if (!cmdFilteredList.length) {
        list.innerHTML = `<div class="cmd-empty">No matching commands</div>`;
        return;
    }

    list.innerHTML = cmdFilteredList.map((item, idx) => `
        <div class="cmd-item ${idx === 0 ? 'focused' : ''}" data-cmd-idx="${idx}">
            <div class="cmd-item-icon"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
            <span class="cmd-item-label">${escH(item.label)}</span>
            ${item.meta ? `<span class="cmd-item-meta">${escH(item.meta)}</span>` : ''}
        </div>
    `).join('');

    list.querySelectorAll('.cmd-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.cmdIdx, 10);
            closeCmd();
            cmdFilteredList[idx]?.fn();
        });
    });
}

// ── Status Bar & Roles Sync ───────────────────────────────────────────────
function syncRolesVisibility() {
    const rolesBtn = $('nav-roles');
    if (rolesBtn) rolesBtn.style.display = app.canManageRoles() ? 'flex' : 'none';
}

function syncAll() {
    syncSummaryStrip();
    syncRolesVisibility();
}

// ── Zoom HUD ──────────────────────────────────────────────────────────────
let _zoomHudTimer;
function flashZoomHud(scale) {
    const el = $('zoom-hud');
    if (!el) return;
    el.textContent = Math.round(scale * 100) + '%';
    el.classList.add('visible');
    clearTimeout(_zoomHudTimer);
    _zoomHudTimer = setTimeout(() => el.classList.remove('visible'), 1200);
}

// ── Inspector & Linking Patches ───────────────────────────────────────────
function patchInspector() {
    const orig = app.resetInspector?.bind(app);
    if (orig) app.resetInspector = function() { orig(); $('inspector')?.classList.remove('open'); };
    ['_renderInspectorNode', '_renderInspectorEdge', '_renderInspectorGraph'].forEach(name => {
        const m = app[name]?.bind(app);
        if (m) app[name] = function(...a) { m(...a); $('inspector')?.classList.add('open'); };
    });
}

function patchLinkMode() {
    const os = app.startLinking?.bind(app);
    const oe = app.endLinking?.bind(app);
    if (os) app.startLinking = function() { os(); $('link-hint')?.classList.add('visible'); };
    if (oe) app.endLinking = function() { oe(); $('link-hint')?.classList.remove('visible'); };
    $('link-cancel-btn')?.addEventListener('click', () => app.endLinking?.());
}

// ── Event Wireup ──────────────────────────────────────────────────────────
// Topbar nav buttons → glass panels
document.querySelectorAll('.tb-nav-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel(btn.dataset.panel, btn);
    });
});

// Mobile tabs → same panels
document.querySelectorAll('.mob-tab[data-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel(btn.dataset.panel, null);
    });
});

// Panel close buttons
document.querySelectorAll('[data-close-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _closePanel(btn.dataset.closePanel);
    });
});

// Glass overlay click
$('glass-panel-overlay')?.addEventListener('click', closeAllPanels);

// Runtime badge → rt-picker panel
$('tb-runtime-pill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel('rt-picker', $('tb-runtime-pill'));
});
$('rt-picker-connect-btn')?.addEventListener('click', () => {
    closeAllPanels();
    app.openSheet('add-runtime');
});

// Panel add buttons
$('gp-add-graph')?.addEventListener('click', () => app.openSheet('add-graph'));
$('gp-add-secret')?.addEventListener('click', () => app.openSheet('add-secret'));
$('gp-add-trigger')?.addEventListener('click', () => app.openSheet('add-trigger'));
$('gp-add-role')?.addEventListener('click', () => app.openSheet('add-role'));
$('gp-add-runtime')?.addEventListener('click', () => {
    closeAllPanels();
    app.openSheet('add-runtime');
});

// Library search
$('lib-search')?.addEventListener('input', () => renderLibraryPanel());

// Sheet modal close
$('sheet-close')?.addEventListener('click', () => app.closeSheet());
$('sheet-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('sheet-overlay')) app.closeSheet();
});

// Confirm modal
$('confirm-close')?.addEventListener('click', () => app.closeConfirmModal());
$('confirm-cancel-btn')?.addEventListener('click', () => app.closeConfirmModal());
$('confirm-action-btn')?.addEventListener('click', () => {
    if (app.confirmCallback) {
        const cb = app.confirmCallback;
        cb();
        app.closeConfirmModal();
    }
});
$('confirm-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('confirm-overlay')) app.closeConfirmModal();
});

// Inspector
$('insp-close')?.addEventListener('click', () => app.resetInspector?.());
$('insp-actions')?.addEventListener('click', e => {
    const t = e.target.closest('[id]');
    if (!t) return;
    if (t.id === 'insp-add-node') app.openSheet('add-node');
    else if (t.id === 'insp-edit-ports') {
        const ed = app.visEdges?.get(app.selectedEdgeVisId)?._edgeData;
        if (ed) app.openSheet('connect-ports', { fromId: ed.from, toId: ed.to, edge: ed, isEdit: true });
    } else if (t.id === 'insp-delete-node') {
        app.confirmDestructiveAction('Delete Node', `Delete "${app.selectedNodeId}"?`, () => {
            delete app.graphModel.nodes[app.selectedNodeId];
            app.graphModel.edges = app.graphModel.edges.filter(x => x.from !== app.selectedNodeId && x.to !== app.selectedNodeId);
            app.syncModelToCode();
            app.renderModelToCanvas(app.graphModel);
        });
    } else if (t.id === 'insp-delete-edge') {
        const ed = app.visEdges?.get(app.selectedEdgeVisId)?._edgeData;
        if (ed) app.confirmDestructiveAction('Delete Connection', `${ed.from} → ${ed.to}?`, () => {
            const idx = app.graphModel.edges.indexOf(ed);
            if (idx > -1) app.graphModel.edges.splice(idx, 1);
            app.syncModelToCode();
            app.renderModelToCanvas(app.graphModel);
        });
    }
});

// Action buttons
$('deploy-btn')?.addEventListener('click', () => app.deployActiveGraph?.());
$('deploy-graph-btn')?.addEventListener('click', () => app.deployActiveGraph?.());
$('run-btn')?.addEventListener('click', () => {
    if (app.runActive) app.stopActiveGraph?.();
    else app.openSheet('run-graph', { graph: app.getActiveGraph() });
});
$('run-graph-btn')?.addEventListener('click', () => {
    if (app.runActive) app.stopActiveGraph?.();
    else app.openSheet('run-graph', { graph: app.getActiveGraph() });
});

// View toggles
document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
});

// Canvas controls
$('ctb-fit')?.addEventListener('click', () => app.network?.fit({ animation: { duration: 300 } }));
$('ctb-add-node')?.addEventListener('click', () => {
    if (app.isWriteMode()) app.openSheet('add-node');
    else app.showToast('Switch to Write mode to add nodes', true);
});
$('ctb-add')?.addEventListener('click', () => {
    if (app.isWriteMode()) app.openSheet('add-node');
    else app.showToast('Switch to Write mode to add nodes', true);
});
$('ctb-link')?.addEventListener('click', () => {
    app.startLinking?.();
    $('ctb-link')?.classList.add('active');
});
$('link-hint-cancel')?.addEventListener('click', () => {
    app.endLinking?.();
    $('ctb-link')?.classList.remove('active');
});
$('ctb-zoom-in')?.addEventListener('click', () => {
    if (!app.network) return;
    const cur = app.network.getScale() || 1;
    if (cur >= 3.0) {
        flashZoomHud(3.0);
        return;
    }
    const s = Math.min(3.0, cur * 1.25);
    const pos = app.network.getViewPosition();
    app.network.moveTo({ position: pos, scale: s, animation: { duration: 160 } });
    flashZoomHud(s);
});
$('ctb-zoom-out')?.addEventListener('click', () => {
    if (!app.network) return;
    const cur = app.network.getScale() || 1;
    if (cur <= 0.2) {
        flashZoomHud(0.2);
        return;
    }
    const s = Math.max(0.2, cur * 0.8);
    const pos = app.network.getViewPosition();
    app.network.moveTo({ position: pos, scale: s, animation: { duration: 160 } });
    flashZoomHud(s);
});
$('ctb-layout')?.addEventListener('click', () => {
    app.network?.setOptions({ physics: { enabled: true } });
    app.network?.stabilize();
    app.network?.once('stabilizationIterationsDone', () => {
        app.network?.setOptions({ physics: { enabled: false } });
        app.network?.fit({ animation: { duration: 280 } });
    });
});
$('mob-fab')?.addEventListener('click', () => app.openSheet('add-node'));
$('canvas-fab')?.addEventListener('click', () => app.openSheet('add-node'));

// Empty state CTA
$('empty-connect-btn')?.addEventListener('click', () => app.openSheet('add-runtime'));
$('es-create-btn')?.addEventListener('click', () => app.openSheet('add-graph'));
$('force-sync-btn')?.addEventListener('click', () => {
    if (app.applyCode()) app.showToast('Synced to canvas');
});

// Command Palette triggers
$('cmd-trigger')?.addEventListener('click', openCmd);
$('cmd-overlay')?.addEventListener('click', e => {
    if (e.target === $('cmd-overlay')) closeCmd();
});
$('cmd-input')?.addEventListener('input', e => renderCmdResults(e.target.value));
$('cmd-input')?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        cmdSelectedIndex = Math.min(cmdSelectedIndex + 1, cmdFilteredList.length - 1);
        renderCmdResultsHighlight();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cmdSelectedIndex = Math.max(cmdSelectedIndex - 1, 0);
        renderCmdResultsHighlight();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (cmdFilteredList[cmdSelectedIndex]) {
            closeCmd();
            cmdFilteredList[cmdSelectedIndex].fn();
        }
    } else if (e.key === 'Escape') {
        closeCmd();
    }
});

function renderCmdResultsHighlight() {
    document.querySelectorAll('.cmd-item').forEach((el, idx) => {
        el.classList.toggle('focused', idx === cmdSelectedIndex);
    });
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', e => {
    const meta = e.metaKey || e.ctrlKey;

    if ($('shortcuts-overlay')?.classList.contains('open')) {
        if (e.key === 'Escape') {
            e.preventDefault();
            window._closeShortcutsModal?.();
            return;
        }
    }

    if (meta && (e.key === '/' || e.key === '?')) {
        e.preventDefault();
        const overlay = $('shortcuts-overlay');
        if (overlay?.classList.contains('open')) window._closeShortcutsModal?.();
        else window._openShortcutsModal?.();
        return;
    }

    if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (cmdOpen) closeCmd();
        else openCmd();
        return;
    }
    if (meta && e.key === 'Enter') {
        e.preventDefault();
        app.runActiveGraph?.();
        return;
    }
    if (meta && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        app.deployActiveGraph?.();
        return;
    }
    if (meta && e.key === '1') { e.preventDefault(); setView('visual'); return; }
    if (meta && e.key === '2') { e.preventDefault(); setView('code'); return; }
    if (meta && e.key === '3') { e.preventDefault(); setView('split'); return; }

    if (e.key === 'Escape') {
        if (cmdOpen) { closeCmd(); return; }
        if ($('confirm-overlay')?.classList.contains('open')) { app.closeConfirmModal(); return; }
        if ($('sheet-overlay')?.classList.contains('open')) { app.closeSheet(); return; }
        if (activePanel) { closeAllPanels(); return; }
        if (dtConsoleState !== 'docked') { setDrawerState('docked'); return; }
        return;
    }

    if (!e.target.matches('input,textarea,[contenteditable]')) {
        if (e.key === '?') {
            e.preventDefault();
            const overlay = $('shortcuts-overlay');
            if (overlay?.classList.contains('open')) window._closeShortcutsModal?.();
            else window._openShortcutsModal?.();
            return;
        }
        if (e.key === 'f') app.network?.fit({ animation: { duration: 280 } });
        if (e.key === 'a' && !meta) app.openSheet('add-node');
        if (e.key === 'l') app.startLinking?.();
    }
});

// ── App State Subscriptions ───────────────────────────────────────────────
if (app.state && typeof app.state.subscribe === 'function') {
    app.state.subscribe('/activeGraphId', () => {
        syncAll();
        const g = app.getActiveGraph();
        const lbl = $('bc-graph-label');
        if (lbl) lbl.textContent = g?.label || g?.id || 'untitled';
    });

    app.state.subscribe('/activeRuntimeId', () => {
        syncAll();
        const rt = app.getActiveRuntime();
        const rlbl = $('tb-rt-label');
        if (rlbl) rlbl.textContent = rt?.label || 'No Runtime';
    });

    app.state.subscribe('/runtimes', () => syncAll());

    app.state.subscribe('/connectivityState', () => syncAll());
}

// ── Initialize ────────────────────────────────────────────────────────────
patchInspector();
patchLinkMode();
initFilterBar();
initEditor();

await app.init();

// Post-init wiring
setView('visual');
syncAll();
patchInspector();
initCanvasTelemetry();

// Seed initial system startup message (§2)
appendDtLog({
    type: 'log',
    level: 'INFO',
    ts: Date.now(),
    text: 'Nodaic Studio — Hybrid Architecture Engine Initialized',
    data: {
        runtime: app.getActiveRuntime()?.id || 'prod-local',
        engine: 'NodeJS v20 (Distributed)',
        observability: '3-Tier Hybrid: Canvas Graphics + Summary Strip + DevTools Console'
    }
});

if (app.network) {
    // Native zoom boundary clamp: preserves exact viewport translation without jumping or shivering
    if (app.network.interactionHandler && typeof app.network.interactionHandler.zoom === 'function') {
        const origZoom = app.network.interactionHandler.zoom.bind(app.network.interactionHandler);
        app.network.interactionHandler.zoom = (scale, pointer) => {
            const clamped = Math.max(0.2, Math.min(3.0, scale));
            origZoom(clamped, pointer);
        };
    }
    app.network.on('zoom', params => {
        flashZoomHud(params.scale);
    });
    app.network.on('doubleClick', params => {
        if (params.edges?.length === 1 && !params.nodes?.length) {
            const ed = app.visEdges?.get(params.edges[0])?._edgeData;
            if (ed) app.openSheet('connect-ports', { fromId: ed.from, toId: ed.to, edge: ed, isEdit: true });
        }
    });
}

// Auto-open graphs panel on first connect
if (app.getActiveRuntime()) openPanel('graphs', $('nav-graphs'));
