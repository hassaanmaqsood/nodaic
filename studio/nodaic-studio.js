/**
 * Nodaic Studio — Main Application
 *
 * Implements the Nodaic Station server workflow:
 *   DISCOVER  GET /manifest           → { runtimes: [{id, name, environment, url}] }
 *   CONNECT   GET /:id/manifest       → { runtime, capabilities, panels, endpoints }
 *   LIBRARY   GET /:id/library        → { artifacts: [...] }
 *   SIMULATE  WS  /:id/simulate       → push { ndl, env, input }, stream per-node events
 *   DEPLOY    POST /:id/deploy        → { deployId, streamUrl }
 *             GET  /:id/stream/:id    → SSE deploy log
 *   PANELS    GET  /:id/panels/:name  → SSE line stream
 *
 * Station-specific contracts:
 *   - Discovery at GET /manifest (NOT /)
 *   - Discovery response key is "runtimes" (not "runtimes")
 *   - Runtime URL field is "url" (e.g. "/nodejs"), not "manifestUrl"
 *   - Per-runtime manifest wraps metadata under "runtime" key (not "runtime")
 *   - Library response is { artifacts: [...] } (not a bare array)
 *   - NDL bundle "ndl" field is JSON.stringify({ nodes, edges })
 *     nodes: [{ id, artifactId, input, state }]
 *     edges: [[fromId, toId, fromPort, toPort], ...]
 *   - WS simulate URL: replace http(s) with ws(s) on server base + endpoint path
 */

'use strict';

/* ================================================================
 * 0. LOCAL ENGINE BOOTSTRAP
 * ================================================================ */

const nodaicSystem = createNodaicSystem();
const { library: localLibrary } = nodaicSystem;

if (typeof NODAIC_CORE_ARTIFACTS !== 'undefined') {
  NODAIC_CORE_ARTIFACTS.forEach(a => localLibrary.addArtifact(a));
} else if (typeof NODAIC_ARTIFACTS !== 'undefined') {
  NODAIC_ARTIFACTS.forEach(a => localLibrary.addArtifact(a));
}

/* ================================================================
 * 1. RUNTIME MANAGER
 *
 * Manages connected Station runtimes.
 * "Runtime" is the server-side term; the UI shows them as "runtimes".
 *
 * RuntimeRecord {
 *   id          : string           — runtime id (also URL prefix)
 *   name        : string
 *   environment : string           — shown as library section label
 *   status      : 'online'|'offline'
 *   serverBase  : string           — http://host:port (no trailing slash)
 *   runtimePath : string           — "/:id"
 *   manifest    : object           — full manifest from /:id/manifest
 *   library     : Artifact[]       — synced from /:id/library (source excluded)
 * }
 */

const RuntimeManager = (() => {
  const runtimes = new Map();   // id → RuntimeRecord
  let activeId = null;

  /**
   * Connect to an Runtime using the Unified API.
   */
  async function connectServer(serverUrl, token = null) {
    const base = serverUrl.replace(/\/$/, '');
    const unifiedUrl = `${base}/nodaic/v1/`;

    try {
      // Check if it's a unified runtime
      const res = await fetch(unifiedUrl, { method: 'GET' });
      if (!res.ok) throw new Error(`Not a Nodaic Runtime (${res.status})`);
      const info = await res.json();

      // Get full status using action (verifies token)
      const statusRes = await fetch(unifiedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'runtime.status', token, payload: {} })
      });

      if (!statusRes.ok) {
        throw new Error(`Auth failed: ${statusRes.status}`);
      }

      const status = await statusRes.json();
      if (status.error) throw new Error(status.error);

      // Register the runtime
      const record = {
        id: status.runtimeId || info.runtimeId,
        name: status.runtimeId || info.runtimeId,
        environment: info.environment || 'nodejs',
        version: info.version || 'v1',
        status: 'online',
        serverBase: base,
        token: token,
        library: []
      };

      runtimes.set(record.id, record);
      if (!activeId) activeId = record.id;

      await _syncLibrary(record);
      return [record];

    } catch (err) {
      console.error('[RuntimeManager] Connection failed:', err.message);
      throw err;
    }
  }

  /**
   * Sync library using library.list action.
   */
  async function _syncLibrary(record) {
    try {
      const url = `${record.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'library.list', token: record.token, payload: {} })
      });

      if (!res.ok) return;
      const data = await res.json();
      record.library = data.artifacts || [];
    } catch (e) {
      console.warn(`[RuntimeManager] library sync failed for ${record.id}:`, e.message);
    }
  }

  /**
   * Build WebSocket URL for the unified WS endpoint.
   */
  function wsUrl(record) {
    return `${record.serverBase}/nodaic/v1/ws`.replace(/^http/, 'ws');
  }

  function disconnect(id) {
    runtimes.delete(id);
    if (activeId === id) {
      activeId = runtimes.size ? [...runtimes.keys()][0] : null;
    }
  }

  function setActive(id) { if (runtimes.has(id)) activeId = id; }
  function getActive() { return runtimes.get(activeId) ?? null; }
  function getAll() { return [...runtimes.values()]; }
  function get(id) { return runtimes.get(id) ?? null; }
  function getActiveId() { return activeId; }

  return { connectServer, disconnect, setActive, getActive, getAll, get, getActiveId, wsUrl };
})();

/* ================================================================
 * 1.5. BINDINGS MANAGER
 * ================================================================ */

const BindingsManager = (() => {
  async function list(runtime) {
    const url = `${runtime.serverBase}/nodaic/v1/`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger.list', token: runtime.token, payload: {} })
    });
    if (!res.ok) throw new Error('Failed to fetch bindings');
    const data = await res.json();
    return data.bindings || [];
  }

  async function add(runtime, event, artifactId, once = false) {
    const url = `${runtime.serverBase}/nodaic/v1/`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trigger.bind',
        token: runtime.token,
        payload: { event, artifactId, opts: { once } }
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add binding');
    }
    return await res.json();
  }

  async function remove(runtime, event, artifactId) {
    const url = `${runtime.serverBase}/nodaic/v1/`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trigger.unbind',
        token: runtime.token,
        payload: { event, artifactId }
      })
    });
    if (!res.ok) throw new Error('Failed to remove binding');
    return await res.json();
  }

  return { list, add, remove };
})();

/* ================================================================
 * 2. OUTPUT PANEL
 * ================================================================ */

const OutputPanel = (() => {
  const tabsEl = document.getElementById('outputTabs');
  const outputEl = document.getElementById('pane-output');
  const errorsEl = document.getElementById('pane-errors');
  const runsListEl = document.getElementById('runsList');
  const ndlViewEl = document.getElementById('ndlCodeView');
  const outputPip = document.getElementById('outputPip');
  const panelEl = document.getElementById('outputPanel');
  const toggleEl = document.getElementById('outputToggle');

  // Clear button for active tab
  const clearBtn = document.createElement('button');
  clearBtn.className = 'output-clear';
  clearBtn.innerHTML = '<span class="material-symbols-outlined">delete_sweep</span>';
  clearBtn.title = 'Clear current pane';
  clearBtn.addEventListener('click', () => {
    const activePane = document.querySelector('.output-pane.active');
    if (activePane) activePane.innerHTML = '';
  });
  panelEl.appendChild(clearBtn);

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.output-tab');
    if (tab) setTab(tab.dataset.tab);
  });
  toggleEl.addEventListener('click', () => panelEl.classList.toggle('collapsed'));

  function setTab(name) {
    tabsEl.querySelectorAll('.output-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.output-pane').forEach(p =>
      p.classList.toggle('active', p.id === `pane-${name}`));
    
    if (name === 'output') outputPip?.classList.remove('has-new');
  }

  function _expand() { 
    if (panelEl.classList.contains('collapsed')) {
      panelEl.classList.remove('collapsed'); 
    }
  }

  function _line(el, html, cls) {
    if (!el) return;
    const line = document.createElement('div');
    line.className = `output-line ${cls}`;
    line.innerHTML = html;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    
    // Pulse the output pip if not on output tab
    if (el === outputEl && !tabsEl.querySelector('[data-tab="output"]').classList.contains('active')) {
      outputPip?.classList.add('has-new');
    }
  }

  function logOutput(html, cls = '') { _expand(); _line(outputEl, html, cls); }
  function logError(text) { 
    _expand(); 
    _line(errorsEl, escHtml(text), 'error-line'); 
    _line(outputEl, escHtml(text), 'error-line');
    if (typeof Toast !== 'undefined') Toast.error(text);
  }
  function logDone() { logOutput('— done —', 'done'); }

  function logNode(nodeId, output, error, state) {
    if (error) {
      logError(`[${nodeId}] ${error}`);
    } else {
      if (state) GraphBridge.setFullState(nodeId, state);
      const val = typeof output === 'string' ? output : JSON.stringify(output);
      logOutput(`<span class="output-node-id">${escHtml(nodeId)}</span>  ${escHtml(val)}`, 'node');
      GraphBridge.setNodeOutput(nodeId, val);
      if (InspectorPanel.getSelected() === nodeId) InspectorPanel.show(nodeId);
      
      // Visual feedback on node
      const nodeEl = graphEditor.shadowRoot?.querySelector(`.node[data-node-id="${nodeId}"]`);
      if (nodeEl) {
        nodeEl.classList.add('executed');
        setTimeout(() => nodeEl.classList.remove('executed'), 1000);
      }
    }
  }

  function logDeploy(step, status, message) {
    const icon = status === 'ok' ? '✔' : status === 'error' ? '✘' : '…';
    logOutput(`${icon} [${escHtml(step)}] ${escHtml(message || '')}`, `step-${status}`);
    if (status === 'error' && typeof Toast !== 'undefined') Toast.error(message);
    if (status === 'ok' && typeof Toast !== 'undefined') Toast.success(message);
  }

  /**
   * Run Tracking for the "Runs" tab
   */
  function addRun(runId, artifactId) {
    if (runsListEl.querySelector('.empty-msg')) runsListEl.innerHTML = '';
    
    const item = document.createElement('div');
    item.className = 'run-item';
    item.id = `run-${runId}`;
    item.innerHTML = `
      <div class="run-dot running"></div>
      <div class="run-id" title="${escHtml(runId)}">${escHtml(artifactId)} <small>(${runId.slice(0,8)})</small></div>
      <div class="run-time">just now</div>
      <button class="run-cancel" title="Stop run" onclick="SimulateController.stop('${runId}')">
        <span class="material-symbols-outlined" style="font-size:16px;">stop_circle</span>
      </button>
    `;
    runsListEl.prepend(item);
    return item;
  }

  function updateRunStatus(runId, status, errorMsg = '') {
    const item = document.getElementById(`run-${runId}`);
    if (!item) return;
    const dot = item.querySelector('.run-dot');
    dot.className = `run-dot ${status}`;
    const cancelBtn = item.querySelector('.run-cancel');
    if (cancelBtn) cancelBtn.style.display = 'none';
    
    if (status === 'error') {
      item.title = errorMsg;
      item.style.borderColor = 'var(--state-error)';
    }
  }

  /**
   * Add a dynamic SSE tab for a manifest panel.
   */
  function addRuntimePanel(name, endpointPath, serverBase) {
    const tabKey = `panel-${name.toLowerCase()}`;
    if (document.getElementById(`pane-${tabKey}`)) return;

    const fullUrl = endpointPath.startsWith('http')
      ? endpointPath
      : `${serverBase}${endpointPath}`;

    // Tab button
    const tab = document.createElement('button');
    tab.className = 'output-tab';
    tab.dataset.tab = tabKey;
    tab.textContent = name;
    tabsEl.appendChild(tab);

    // Pane
    const pane = document.createElement('div');
    pane.className = 'output-pane';
    pane.id = `pane-${tabKey}`;
    panelEl.querySelector('.output-body').appendChild(pane);

    // SSE
    const es = new EventSource(fullUrl);
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        const line = document.createElement('div');
        line.className = 'output-line';
        line.textContent = data.line ?? e.data;
        pane.appendChild(line);
        pane.scrollTop = pane.scrollHeight;
      } catch (_) { }
    };
    es.onerror = () => es.close();
  }

  function clearAll() { outputEl.innerHTML = ''; errorsEl.innerHTML = ''; }

  return { logOutput, logError, logNode, logDone, logDeploy, addRuntimePanel, clearAll, setTab, addRun, updateRunStatus };
})();

/* ================================================================
 * 3. GRAPH BRIDGE
 *
 * NodeInfo {
 *   artifactId  : string
 *   environment : string
 *   runtimeId   : string | null
 *   state       : object           — node.state (mutable via inspector)
 *   inputs      : object           — seed input overrides for simulate
 * }
 * ================================================================ */

const GraphBridge = (() => {
  const nodes = new Map();

  function register(nodeId, info) {
    nodes.set(nodeId, {
      artifactId: info.artifactId,
      environment: info.environment || 'local',
      runtimeId: info.runtimeId ?? null,
      state: { ...(info.preset || {}) },
      inputs: {}
    });
  }

  function unregister(nodeId) { nodes.delete(nodeId); }
  function getNode(nodeId) { return nodes.get(nodeId) ?? null; }

  function setState(nodeId, key, value) {
    const n = nodes.get(nodeId);
    if (n) n.state[key] = value;
  }

  function setFullState(nodeId, state) {
    const n = nodes.get(nodeId);
    if (n && state) n.state = { ...n.state, ...state };
  }

  function setInput(nodeId, port, value) {
    const n = nodes.get(nodeId);
    if (n) n.inputs[port] = value;
  }

  /**
   * Build the NDL bundle for Station simulate/deploy.
   *
   * Station's nodejs-runtime.js expects:
   *   bundle.ndl   = JSON.stringify({
   *     nodes: [{ id, artifactId, input, state }],
   *     edges: [[fromId, toId, fromPort, toPort], ...]
   *   })
   *   bundle.env   = {}
   *   bundle.input = { nodeId: { port: value } }  (seed overrides, merged at runtime)
   */
  function buildBundle(graphData) {
    const data = graphData || document.getElementById('graphEditor').exportGraph();

    const stationNodes = data.nodes.map(n => {
      const info = nodes.get(n.id) ?? {};
      return {
        id: n.id,
        artifactId: info.artifactId || n.title,
        state: { ...(info.state || {}) },
        input: { ...(info.inputs || {}) }
      };
    });

    // graph-editor-unified edge formats vary — handle both
    const stationEdges = data.edges.map(e => {
      const srcNode = e.sourceNode ?? e.source?.nodeId ?? '';
      const tgtNode = e.targetNode ?? e.target?.nodeId ?? '';
      const srcPort = e.sourcePort ?? e.source?.portId ?? 'result';
      const tgtPort = e.targetPort ?? e.target?.portId ?? srcPort;
      return [srcNode, tgtNode, srcPort, tgtPort];
    }).filter(([f, t]) => f && t);

    // Seed inputs as a separate bundle.input map (runtime merges with edge outputs)
    const input = {};
    nodes.forEach((info, nodeId) => {
      if (Object.keys(info.inputs).length > 0) {
        input[nodeId] = { ...info.inputs };
      }
    });

    return {
      ndl: JSON.stringify({ nodes: stationNodes, edges: stationEdges }),
      env: {},
      input
    };
  }

  /** Update output badge on the canvas node element. */
  function setNodeOutput(nodeId, valStr) {
    const sr = document.getElementById('graphEditor').shadowRoot;
    if (!sr) return;
    const nodeEl = sr.querySelector(`[data-node-id="${nodeId}"]`);
    if (!nodeEl) return;
    let badge = nodeEl.querySelector('.node-output-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'node-output-badge';
      (nodeEl.querySelector('.block') || nodeEl).appendChild(badge);
    }
    badge.textContent = valStr.length > 36 ? valStr.slice(0, 36) + '…' : valStr;
  }

  return { register, unregister, getNode, setState, setFullState, setInput, buildBundle, setNodeOutput };
})();

/* ================================================================
 * 4. LIBRARY PANEL
 * ================================================================ */

const LibraryPanel = (() => {
  const bodyEl = document.getElementById('libraryBody');
  const searchEl = document.getElementById('librarySearch');
  let filter = '';

  searchEl.addEventListener('input', () => { filter = searchEl.value.trim().toLowerCase(); render(); });

  function render() {
    bodyEl.innerHTML = '';
    const activeId = RuntimeManager.getActiveId();

    // Always show local
    _section({ label: 'local', sublabel: null, artifacts: localLibrary.listArtifacts(), runtimeId: null, online: true });

    // Only show active runtime if selected
    if (activeId) {
      const rt = RuntimeManager.get(activeId);
      if (rt) {
        _section({ label: rt.environment, sublabel: rt.name, artifacts: rt.library, runtimeId: rt.id, online: rt.status === 'online' });
      }
    }
  }

  function _match(a) {
    if (!filter) return true;
    return (
      a.id?.toLowerCase().includes(filter) ||
      a.metadata?.name?.toLowerCase().includes(filter) ||
      a.metadata?.description?.toLowerCase().includes(filter) ||
      a.metadata?.tags?.some(t => t.toLowerCase().includes(filter))
    );
  }

  function _section({ label, sublabel, artifacts, runtimeId, online }) {
    const filtered = artifacts.filter(_match);
    const sec = document.createElement('div');
    sec.className = `lib-section open${online ? '' : ' offline'}`;

    const hdr = document.createElement('div');
    hdr.className = 'lib-section-header';
    hdr.innerHTML = `
      <span class="material-symbols-outlined lib-chevron">chevron_right</span>
      <span>${escHtml(label)}</span>
      ${sublabel ? `<span class="lib-section-env">${escHtml(sublabel)}</span>` : ''}
    `;
    hdr.addEventListener('click', () => sec.classList.toggle('open'));

    const itemsEl = document.createElement('div');
    itemsEl.className = 'lib-items';

    if (!filtered.length) {
      itemsEl.innerHTML = `<div style="padding:8px 12px;color:var(--text-muted);font-size:0.7rem;">No artifacts</div>`;
    } else {
      filtered.forEach(a => itemsEl.appendChild(_item(a, runtimeId, label)));
    }

    sec.appendChild(hdr);
    sec.appendChild(itemsEl);
    bodyEl.appendChild(sec);
  }

  function _item(artifact, runtimeId, environment) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.draggable = true;
    const icon = artifact.artifactType === 'graph' ? 'account_tree' : 'function';
    const name = artifact.metadata?.name || artifact.id;
    item.innerHTML = `
      <span class="material-symbols-outlined lib-item-icon">${icon}</span>
      <span class="lib-item-name">${escHtml(name)}</span>
      <span class="lib-item-type">${escHtml(artifact.artifactType || '')}</span>
      <button class="lib-item-info" title="View details">
        <span class="material-symbols-outlined">info</span>
      </button>
    `;
    item.querySelector('.lib-item-info').addEventListener('click', e => {
      e.stopPropagation();
      ArtifactDetailsModal.show(artifact);
    });

    if (artifact.artifactType === 'graph') {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'lib-item-load';
      loadBtn.title = 'Load workflow';
      loadBtn.innerHTML = '<span class="material-symbols-outlined">file_open</span>';
      loadBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Load this workflow? Current canvas will be replaced.')) return;

        try {
          let fullArtifact = artifact;
          if (!artifact.source && runtimeId) {
            const runtime = RuntimeManager.get(runtimeId);
            const url = `${runtime.serverBase}/nodaic/v1/`;
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'library.get',
                token: runtime.token,
                payload: { id: artifact.id, version: artifact.version }
              })
            });
            fullArtifact = await res.json();
          }
          if (fullArtifact.source) {
            graphEditor.clearGraph?.();
            const data = typeof fullArtifact.source === 'string' ? JSON.parse(fullArtifact.source) : fullArtifact.source;
            _importGraph(data);
          }
        } catch (err) {
          OutputPanel.logError('Load failed: ' + err.message);
        }
      });
      item.insertBefore(loadBtn, item.querySelector('.lib-item-info'));
    }

    item.addEventListener('click', () => _addToCanvas(artifact, runtimeId, environment));
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        artifactId: artifact.id, runtimeId, environment,
        preset: artifact.preset || {}, interface: artifact.interface || {}
      }));
    });
    return item;
  }

  function _addToCanvas(artifact, runtimeId, environment) {
    const ge = document.getElementById('graphEditor');
    const rect = ge.getBoundingClientRect();
    const pos = {
      x: Math.round(rect.width / 2 - 80 + (Math.random() - 0.5) * 60),
      y: Math.round(rect.height / 2 - 40 + (Math.random() - 0.5) * 60)
    };

    const inputs = Object.keys(artifact.interface?.inputs || {}).map(k => ({ id: k, label: k, type: artifact.interface.inputs[k].type || 'any' }));
    const outputs = Object.keys(artifact.interface?.outputs || {}).map(k => ({ id: k, label: k, type: artifact.interface.outputs[k].type || 'any' }));
    const nodeId = `${artifact.id}-${Date.now()}`;
    const badge = (runtimeId && environment !== 'local') ? `<span class="node-env-badge">${escHtml(environment)}</span>` : '';

    ge.addNode({ id: nodeId, title: artifact.id, position: pos, inputs, outputs, content: badge });
    GraphBridge.register(nodeId, { artifactId: artifact.id, environment, runtimeId, preset: artifact.preset || {} });
  }

  // Canvas drag-and-drop
  const ge = document.getElementById('graphEditor');
  ge.addEventListener('dragover', e => e.preventDefault());
  ge.addEventListener('drop', e => {
    e.preventDefault();
    try {
      const d = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (!d.artifactId) return;
      const artifact = d.runtimeId
        ? RuntimeManager.get(d.runtimeId)?.library?.find(a => a.id === d.artifactId)
        : localLibrary.listArtifacts().find(a => a.id === d.artifactId);
      if (artifact) _addToCanvas(artifact, d.runtimeId, d.environment);
    } catch (_) { }
  });

  return { render };
})();

/* ================================================================
 * 5. INSPECTOR PANEL
 * ================================================================ */

const InspectorPanel = (() => {
  const bodyEl = document.getElementById('inspectorBody');
  let selected = null;
  let originalNdl = '';

  function show(nodeId) {
    selected = nodeId;
    const info = GraphBridge.getNode(nodeId);
    if (!info) { clear(); return; }

    const ndl = _generateNodeNdl(nodeId, info);
    originalNdl = ndl;

    bodyEl.innerHTML = '';

    // Header
    const hdr = _el('div', 'insp-section');
    hdr.innerHTML = `
      <div class="insp-node-id">${escHtml(nodeId)}</div>
      ${info.environment !== 'local' ? `<span class="insp-env-badge">${escHtml(info.environment)}</span>` : ''}
    `;
    bodyEl.appendChild(hdr);

    // NDL Editor
    const sec = _el('div', 'insp-section');
    sec.innerHTML = '<div class="insp-section-label">NDL Editor</div>';
    
    const editorWrap = _el('div', 'insp-editor-wrap');
    const textarea = document.createElement('textarea');
    textarea.className = 'insp-ndl-textarea';
    textarea.value = ndl;
    textarea.spellcheck = false;
    
    // Auto-resize
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight + 10) + 'px';
    
    editorWrap.appendChild(textarea);
    sec.appendChild(editorWrap);
    bodyEl.appendChild(sec);

    // Apply / Revert Buttons
    const actions = _el('div', 'insp-actions');
    
    const applyBtn = document.createElement('button');
    applyBtn.className = 'insp-btn insp-btn-run';
    applyBtn.innerHTML = `<span class="material-symbols-outlined">done</span> apply`;
    applyBtn.addEventListener('click', () => {
      _applyNdl(nodeId, textarea.value);
      if (typeof Toast !== 'undefined') Toast.success('Applied NDL changes');
    });
    
    const revertBtn = document.createElement('button');
    revertBtn.className = 'insp-btn';
    revertBtn.innerHTML = `<span class="material-symbols-outlined">restart_alt</span> revert`;
    revertBtn.addEventListener('click', () => {
      textarea.value = originalNdl;
    });
    
    actions.appendChild(applyBtn);
    actions.appendChild(revertBtn);
    bodyEl.appendChild(actions);

    // Quick Actions (Run/Deploy)
    const active = RuntimeManager.getActive();
    if (active?.manifest?.capabilities?.deploy === true) {
      const qActions = _el('div', 'insp-actions');
      qActions.style.marginTop = 'var(--sp-1)';
      
      const deployBtn = document.createElement('button');
      deployBtn.className = 'insp-btn insp-btn-deploy';
      deployBtn.style.width = '100%';
      deployBtn.innerHTML = `<span class="material-symbols-outlined">rocket_launch</span> deploy artifact`;
      deployBtn.addEventListener('click', () => SimulateController.deploy());
      qActions.appendChild(deployBtn);
      bodyEl.appendChild(qActions);
    }
  }

  function _generateNodeNdl(nodeId, info) {
    let ndl = `node ${info.artifactId}\n`;
    const stateKeys = Object.keys(info.state);
    if (stateKeys.length) {
      stateKeys.forEach(k => {
        const val = info.state[k];
        const formatted = typeof val === 'string' ? `"${val}"` : val;
        ndl += `  state ${k} = ${formatted}\n`;
      });
    }
    return ndl;
  }

  function _applyNdl(nodeId, text) {
    const lines = text.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('state ')) {
        const parts = trimmed.substring(6).split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          let val = parts.slice(1).join('=').trim();
          // Basic unquoting
          if (val.startsWith('"') && val.endsWith('"')) val = val.substring(1, val.length - 1);
          else if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (!isNaN(val) && val !== '') val = Number(val);
          
          GraphBridge.setState(nodeId, key, val);
        }
      }
    });
    // Refresh to show normalized
    show(nodeId);
    if (window.__graphUnsaved) window.__graphUnsaved.mark();
  }

  function clear() {
    selected = null;
    bodyEl.innerHTML = `<div class="inspector-empty"><span class="material-symbols-outlined">touch_app</span><span>Select a node</span></div>`;
  }

  function refreshButtons() { if (selected) show(selected); }
  function getSelected() { return selected; }

  function _el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }

  function _field(label, value, onChange) {
    const row = _el('div', 'insp-field');
    row.innerHTML = `<span class="insp-field-label">${escHtml(label)}</span><input class="insp-field-input" type="text" value="${escHtml(String(value ?? ''))}">`;
    row.querySelector('input').addEventListener('change', e => onChange(e.target.value));
    return row;
  }

  function _coerce(v) {
    if (v === '') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    const n = Number(v);
    return isNaN(n) ? v : n;
  }

  return { show, clear, refreshButtons, getSelected };
})();

/* ================================================================
 * 6. RUNTIMES BAR
 * ================================================================ */

const RuntimesBar = (() => {
  const pillsEl = document.getElementById('runtimesPills');
  let ctxMenu = null;

  function render() {
    pillsEl.innerHTML = '';
    RuntimeManager.getAll().forEach(rt => {
      const pill = document.createElement('div');
      pill.className = `runtime-pill online${RuntimeManager.getActiveId() === rt.id ? ' active' : ''}`;
      pill.innerHTML = `<span class="runtime-dot"></span><span>${escHtml(rt.environment)}/${escHtml(rt.name)}</span>`;
      pill.addEventListener('click', () => {
        RuntimeManager.setActive(rt.id);
        render();
        LibraryPanel.render();
        InspectorPanel.refreshButtons();
        BindingsPanel.render();
      });
      pill.addEventListener('contextmenu', e => { e.preventDefault(); _ctx(e.clientX, e.clientY, rt.id); });
      pillsEl.appendChild(pill);
    });
  }

  function _ctx(x, y, runtimeId) {
    _close();
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'runtime-pill-menu';
    ctxMenu.style.cssText = `left:${x}px;top:${y}px;`;
    ctxMenu.innerHTML = `<button class="runtime-pill-menu-item danger">Disconnect</button>`;
    ctxMenu.querySelector('button').addEventListener('click', () => {
      RuntimeManager.disconnect(runtimeId);
      LibraryPanel.render(); render(); InspectorPanel.refreshButtons(); _close();
    });
    document.body.appendChild(ctxMenu);
    setTimeout(() => document.addEventListener('click', _close, { once: true }), 0);
  }

  function _close() { ctxMenu?.remove(); ctxMenu = null; }

  return { render };
})();

/* ================================================================
 * 7. SIMULATE & DEPLOY CONTROLLER
 * ================================================================ */

const SimulateController = (() => {
  let activeWS = null;
  let activeRunId = null;
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    OutputPanel.clearAll();
    const runtime = RuntimeManager.getActive();
    try {
      if (runtime) {
        await _runViaRuntime(runtime);
      } else {
        await _runInBrowser();
      }
    } finally {
      running = false;
      activeWS = null;
      activeRunId = null;
    }
  }

  function stop(runId) {
    if (activeWS) {
      if (runId && activeRunId !== runId) return; // Only stop the requested one if ID supplied
      
      const runtime = RuntimeManager.getActive();
      if (runtime && activeRunId) {
        // Send cancel action via WebSocket if possible
        try {
          activeWS.send(JSON.stringify({
            action: 'run.cancel',
            token: runtime.token,
            payload: { runId: activeRunId }
          }));
        } catch (_) {}
      }
      activeWS.close();
      activeWS = null;
      if (activeRunId) OutputPanel.updateRunStatus(activeRunId, 'error', 'Cancelled by user');
      running = false;
      OutputPanel.logOutput('Execution cancelled by user', 'error-line');
    }
  }

  async function _runViaRuntime(runtime) {
    const wsEndpoint = RuntimeManager.wsUrl(runtime);
    const bundle = GraphBridge.buildBundle();
    const token = runtime.token;

    OutputPanel.logOutput(`→ run via Unified API: ${escHtml(runtime.environment)}/${escHtml(runtime.name)}`, 'info');

    // For graphs on canvas, we push them first to ensure the runtime can run them
    const studioArtifactId = `user/studio_session_${Date.now()}`;
    const artifact = {
      id: studioArtifactId,
      version: '1.0.0',
      artifactType: 'graph',
      sourceType: 'application/json',
      source: bundle.ndl,
      interface: { inputs: {}, outputs: {} }
    };

    try {
      const pushUrl = `${runtime.serverBase}/nodaic/v1/`;
      const pushRes = await fetch(pushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'library.push', token, payload: { artifact } })
      });
      if (!pushRes.ok) throw new Error(`Push failed: ${pushRes.status}`);

      return new Promise((resolve, reject) => {
        try { 
          activeWS = new WebSocket(wsEndpoint); 
        } catch (err) { 
          reject(err); 
          return; 
        }

        activeWS.onopen = () => {
          activeWS.send(JSON.stringify({
            action: 'run.start',
            token,
            payload: {
              artifactId: studioArtifactId,
              input: bundle.input,
              state: {}
            }
          }));
        };

        activeWS.onerror = () => { 
          OutputPanel.logError('WebSocket connection failed'); 
          resolve(); 
        };
        activeWS.onclose = () => {
          if (activeRunId) OutputPanel.updateRunStatus(activeRunId, 'done');
          resolve();
        };

        activeWS.onmessage = e => {
          let msg;
          try { msg = JSON.parse(e.data); } catch (_) { return; }

          switch (msg.event) {
            case 'run.started':
              activeRunId = msg.runId;
              OutputPanel.logOutput(`Execution started: ${msg.runId}`, 'info');
              OutputPanel.addRun(msg.runId, studioArtifactId);
              break;
            case 'run.node':
              OutputPanel.logNode(msg.nodeId, msg.output, msg.error, msg.state);
              break;
            case 'run.done':
              OutputPanel.logOutput(`Execution finished.`, 'done');
              OutputPanel.logDone();
              if (activeRunId) OutputPanel.updateRunStatus(activeRunId, 'done');
              activeWS.close();
              resolve();
              break;
            case 'error':
              OutputPanel.logError(msg.error || 'Execution error');
              if (activeRunId) OutputPanel.updateRunStatus(activeRunId, 'error', msg.error);
              activeWS.close();
              resolve();
              break;
          }
        };
      });

    } catch (err) {
      OutputPanel.logError(`Remote run failed: ${err.message}`);
    }
  }



  /**
   * In-browser fallback — mirrors nodejs-runtime.js logic.
   * Runs text/javascript artifacts locally; no deploy, env resolves to "".
   *
   * Uses the same graph format as Station:
   *   nodes: [{ id, artifactId, state, input }]
   *   edges: [[fromId, toId, fromPort, toPort], ...]
   */
  async function _runInBrowser() {
    OutputPanel.logOutput('→ in-browser execution (JS only)', 'info');

    const bundle = GraphBridge.buildBundle();
    let graph;
    try { graph = JSON.parse(bundle.ndl); }
    catch (e) { OutputPanel.logError('Graph parse error: ' + e.message); return; }

    const { nodes, edges } = graph;
    if (!nodes.length) { OutputPanel.logOutput('No nodes on canvas.', 'info'); return; }

    const order = _topoSort(nodes, edges);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const outputs = {};

    for (const nodeId of order) {
      const nodeDef = nodeMap.get(nodeId);
      if (!nodeDef) continue;

      const artifact = localLibrary.listArtifacts().find(a => a.id === nodeDef.artifactId);
      if (!artifact) {
        OutputPanel.logNode(nodeId, null, `artifact "${nodeDef.artifactId}" not found`);
        continue;
      }

      // Resolve inputs: nodeDef.input + seed bundle.input[nodeId] + upstream edge outputs
      const edgeInputs = {};
      edges.forEach(([from, to, fromPort = 'result', toPort]) => {
        if (to === nodeId && outputs[from]) {
          edgeInputs[toPort || fromPort] = outputs[from][fromPort];
        }
      });

      const resolved = {
        ...(nodeDef.input || {}),
        ...(bundle.input[nodeId] || {}),
        ...edgeInputs
      };

      try {
        const result = await _execProcess(artifact, resolved, nodeDef.state || {});
        outputs[nodeId] = result.output;
        OutputPanel.logNode(nodeId, result.output, null, result.state);
      } catch (err) {
        OutputPanel.logNode(nodeId, null, err.message);
      }
    }

    OutputPanel.logDone();
  }

  /** Kahn's topological sort — mirrors nodejs-runtime.js */
  function _topoSort(nodes, edges) {
    const ids = nodes.map(n => n.id);
    const inDegree = new Map(ids.map(id => [id, 0]));
    const adj = new Map(ids.map(id => [id, []]));

    for (const [from, to] of edges) {
      if (!inDegree.has(to) || !adj.has(from)) continue;
      inDegree.set(to, inDegree.get(to) + 1);
      adj.get(from).push(to);
    }

    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      for (const next of adj.get(id) ?? []) {
        const d = inDegree.get(next) - 1;
        inDegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    return sorted;
  }

  /** Execute a local artifact's process function, callback → Promise. */
  function _execProcess(artifact, input, state) {
    return new Promise((resolve, reject) => {
      try {
        // Try nodaic library instance first
        const instance = localLibrary.getInstance?.(artifact.id);
        if (instance?.process) {
          instance.process(input, state, r => resolve({ output: r?.output ?? {}, state: r?.state ?? state }));
          return;
        }
        // Fallback: eval artifact source
        if (artifact.source) {
          const fn = new Function(`return (${artifact.source})`)();
          fn(input, state, r => resolve({ output: r?.output ?? {}, state: r?.state ?? state }));
          return;
        }
        reject(new Error('no executable source'));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Deploy via Station:
   *   POST /:id/deploy { ndl }  → { deployId, streamUrl }
   *   GET  streamUrl            → SSE { step, status, message }
   */
  async function deploy() {
    const runtime = RuntimeManager.getActive();
    if (!runtime) return;

    OutputPanel.clearAll();
    OutputPanel.logOutput(`→ deploying graph to ${escHtml(runtime.environment)}/${escHtml(runtime.name)}`, 'info');

    const bundle = GraphBridge.buildBundle();
    const artifactId = prompt('Enter artifact ID to deploy as:', 'user/deployed_graph') || 'user/deployed_graph';

    const artifact = {
      id: artifactId,
      version: '1.0.0',
      artifactType: 'graph',
      sourceType: 'application/json',
      source: bundle.ndl,
      interface: { inputs: {}, outputs: {} }
    };

    try {
      const url = `${runtime.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'library.push',
          token: runtime.token,
          payload: { artifact }
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Deploy failed: ${res.status}`);
      }

      OutputPanel.logOutput(`Successfully deployed as ${artifactId}`, 'done');
      LibraryPanel.render();
    } catch (err) {
      OutputPanel.logError(err.message);
    }
  }

  return { run, deploy };
})();

/* ================================================================
 * 8. ADD RUNTIME MODAL
 * ================================================================ */

const AddRuntimeModal = (() => {
  const overlay = document.getElementById('addRuntimeModal');
  const urlInput = document.getElementById('runtimeUrlInput');
  const statusEl = document.getElementById('runtimeConnectStatus');
  const connectBtn = document.getElementById('connectRuntimeBtn');
  const closeBtn = document.getElementById('closeRuntimeModal');

  const open = () => { overlay.classList.add('active'); urlInput.focus(); };
  const close = () => { overlay.classList.remove('active'); statusEl.textContent = ''; statusEl.className = 'modal-status'; };

  document.getElementById('addRuntimeBtn').addEventListener('click', open);
  document.getElementById('addRuntimeNavBtn').addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectBtn.click(); });

  connectBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const token = document.getElementById('runtimeTokenInput').value.trim();
    if (!url) return;
    statusEl.textContent = 'Connecting…';
    statusEl.className = 'modal-status';
    connectBtn.disabled = true;

    try {
      const runtimes = await RuntimeManager.connectServer(url, token);

      LibraryPanel.render();
      RuntimesBar.render();
      InspectorPanel.refreshButtons();

      statusEl.textContent = `Connected: ${runtimes.map(r => r.environment).join(', ')}`;
      statusEl.className = 'modal-status success';
      setTimeout(close, 900);

      // Initial render for everything
      LibraryPanel.render();
      RuntimesBar.render();
      BindingsPanel.render();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'modal-status error';
    } finally {
      connectBtn.disabled = false;
    }
  });

  return { open, close };
})();

/* ================================================================
 * 8.5. NDL PEEK MODAL
 * ================================================================ */

const NdlPeekModal = (() => {
  const overlay = document.getElementById('ndlPeekModal');
  const viewer = document.getElementById('ndlViewer');
  const copyBtn = document.getElementById('copyNdlBtn');
  const downloadBtn = document.getElementById('downloadNdlBtn');
  const closeBtn = document.getElementById('closeNdlModal');

  const open = () => {
    const bundle = GraphBridge.buildBundle();
    viewer.textContent = JSON.stringify(JSON.parse(bundle.ndl), null, 2);
    overlay.classList.add('active');
  };
  const close = () => overlay.classList.remove('active');

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(viewer.textContent);
    const oldText = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = oldText, 1500);
  });

  downloadBtn.addEventListener('click', () => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([viewer.textContent], { type: 'application/json' })),
      download: 'process-definition.ndl.json'
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  return { open, close };
})();

/* ================================================================
 * 8.7. ARTIFACT DETAILS MODAL
 * ================================================================ */

const ArtifactDetailsModal = (() => {
  const overlay = document.getElementById('artifactDetailsModal');
  const titleEl = document.getElementById('artDetTitle');
  const typeEl = document.getElementById('artDetType');
  const descEl = document.getElementById('artDetDesc');
  const inputsEl = document.getElementById('artDetInputs');
  const outputsEl = document.getElementById('artDetOutputs');
  const closeBtn = document.getElementById('closeArtDetModal');

  const show = (artifact) => {
    titleEl.textContent = artifact.metadata?.name || artifact.id;
    typeEl.textContent = artifact.artifactType || 'process';
    descEl.textContent = artifact.metadata?.description || 'No description provided.';

    // Render Interface
    const renderIface = (map, el) => {
      el.innerHTML = '';
      const keys = Object.keys(map || {});
      if (!keys.length) { el.innerHTML = '<li>None</li>'; return; }
      keys.forEach(k => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="port-name">${escHtml(k)}</span>: <span class="port-type">${escHtml(map[k].type || 'any')}</span>`;
        el.appendChild(li);
      });
    };

    renderIface(artifact.interface?.inputs, inputsEl);
    renderIface(artifact.interface?.outputs, outputsEl);

    overlay.classList.add('active');
  };

  const close = () => overlay.classList.remove('active');

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  return { show, close };
})();

/* ================================================================
 * 9. GRAPH EDITOR SETUP & EVENTS
 * ================================================================ */

const graphEditor = document.getElementById('graphEditor');
const deleteBtn = document.getElementById('deleteBtn');
const fitBtn = document.getElementById('fitBtn');

graphEditor.setConfig({
  gridSize: 20,
  showGrid: false,
  edgeStyle: 'bezier',
  theme: 'dark',
  zoomToMouse: true,
  enableKeyboardShortcuts: true
});

graphEditor.setStylesheet(`
  :host {
    --background-color:   #0A0B0D;
    --grid-color:         rgba(255, 255, 255, 0.03);
    --node-bg:            rgba(24, 24, 27, 0.95);
    --node-border:        rgba(255, 255, 255, 0.08);
    --node-text:          #F8F9FA;
    --edge-color:         rgba(255, 255, 255, 0.12);
    --port-color:         #FF6B35;
    --selected-color:     #FF6B35;
    --node-border-radius: 6px;
    --port-size:          0.7rem;
  }
  .node .title {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.65rem; color: #F8F9FA; letter-spacing: 0.05em; font-weight: 600;
    text-transform: uppercase;
  }
  .node .display { 
    height: fit-content; aspect-ratio: unset; 
    border-radius: var(--node-border-radius);
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid var(--node-border);
  }
  .node.selected > * { border-color: #FF6B35; box-shadow: 0 0 0 1px #FF6B35; }
  .edge.selected { stroke: #FF6B35; stroke-width: 2.5px; }
  .node-env-badge {
    display: inline-block; font-family: 'IBM Plex Mono', monospace;
    font-size: 0.5rem; font-weight: 700; padding: 1px 4px; border-radius: 2px;
    background: rgba(255, 107, 53, 0.1); color: #FF6B35; border: 1px solid rgba(255, 107, 53, 0.2);
    text-transform: uppercase; margin-bottom: 4px;
  }
  .node-output-badge {
    display: block; font-family: 'IBM Plex Mono', monospace;
    font-size: 0.55rem; color: #71717A; padding: 2px 8px 4px;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
`);

graphEditor.addEventListener('node-selected', e => {
  const nodeId = e.detail?.nodeId;
  if (!nodeId) return;
  InspectorPanel.show(nodeId);
  deleteBtn.style.display = 'flex';
});

graphEditor.addEventListener('node-deselected', () => {
  InspectorPanel.clear();
  deleteBtn.style.display = 'none';
});

deleteBtn.addEventListener('click', _deleteSelected);
fitBtn.addEventListener('click', () => graphEditor.fitToView?.());

document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
  const modalOpen = document.querySelector('.modal-overlay.active');

  if (inInput || modalOpen) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    _deleteSelected();
  }
  if (e.key === 'f' || e.key === 'F') graphEditor.fitToView?.();
});

function _deleteSelected() {
  const sel = graphEditor.shadowRoot?.querySelector('.node.selected');
  if (!sel) return;
  const nodeId = sel.dataset.nodeId;
  graphEditor.removeNode(nodeId);
  GraphBridge.unregister(nodeId);
  InspectorPanel.clear();
  deleteBtn.style.display = 'none';
}

/* ================================================================
 * 10. NAVBAR ACTIONS
 * ================================================================ */

document.getElementById('saveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveBtn');
  const runtime = RuntimeManager.getActive();
  const graphData = _exportGraph();

  try {
    // 1. Always save to localStorage as backup
    localStorage.setItem('nodaic-graph', JSON.stringify(graphData));

    // 2. If runtime is active, save to runtime library
    if (runtime) {
      const currentName = document.getElementById('graphNameInput')?.value || graphData.id || 'my-workflow';
      const artifactId = prompt('Enter artifact ID to save as:', currentName) || currentName;
      const artifact = {
        id: artifactId,
        version: '1.0.0',
        artifactType: 'graph',
        sourceType: 'application/json',
        source: graphData,
        metadata: {
          name: artifactId.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
          tags: ['workflow', 'studio']
        },
        interface: {
          inputs: { value: { type: 'any' } },
          outputs: { result: { type: 'any' } }
        }
      };

      const url = `${runtime.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'library.push',
          token: runtime.token,
          payload: { artifact }
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save to runtime');
      }

      if (typeof Toast !== 'undefined') Toast.success(`Saved to ${runtime.name} library`);
      if (window.__graphUnsaved) window.__graphUnsaved.clear();
      setTimeout(() => LibraryPanel.render(), 500);
    } else {
      if (typeof Toast !== 'undefined') Toast.success('Saved locally');
      if (window.__graphUnsaved) window.__graphUnsaved.clear();
    }
  } catch (err) {
    console.error('Save failed:', err);
    btn.textContent = 'Error';
    OutputPanel.logError('Save failed: ' + err.message);
  }
  setTimeout(() => (btn.textContent = 'Save'), 1500);
});

document.getElementById('peekNdlBtn').addEventListener('click', NdlPeekModal.open);

document.getElementById('importBtn').addEventListener('click', () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
  input.onchange = async e => {
    try { _importGraph(JSON.parse(await e.target.files[0].text())); }
    catch (err) { OutputPanel.logError('Import failed: ' + err.message); }
  };
  input.click();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(_exportGraph(), null, 2)], { type: 'application/json' })),
    download: 'nodaic-graph.json'
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

function _exportGraph() {
  const data = graphEditor.exportGraph();
  data.nodes = data.nodes.map(n => {
    const info = GraphBridge.getNode(n.id);
    return { ...n, artifactId: info?.artifactId, environment: info?.environment, runtimeId: info?.runtimeId, preset: { ...(info?.state || {}) } };
  });
  return data;
}

function _importGraph(data) {
  graphEditor.importGraph(data);
  (data.nodes || []).forEach(n => {
    if (n.artifactId) {
      GraphBridge.register(n.id, { artifactId: n.artifactId, environment: n.environment || 'local', runtimeId: n.runtimeId || null, preset: n.preset || {} });
    }
  });
}

/* ================================================================
 * 11. UTILS
 * ================================================================ */

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================================================================
 * 12. BINDINGS PANEL
 * ================================================================ */

const BindingsPanel = (() => {
  const listEl = document.getElementById('bindingsList');
  const eventInput = document.getElementById('bindEvent');
  const artifactInput = document.getElementById('bindArtifact');
  const onceInput = document.getElementById('bindOnce');
  const addBtn = document.getElementById('addBindingBtn');
  const refreshBtn = document.getElementById('refreshBindingsBtn');

  if (refreshBtn) refreshBtn.addEventListener('click', render);
  if (addBtn) addBtn.addEventListener('click', async () => {
    const runtime = RuntimeManager.getActive();
    if (!runtime) return alert('No active runtime');

    const event = eventInput.value.trim();
    const artifactId = artifactInput.value.trim();
    const once = onceInput ? onceInput.checked : false;
    if (!event || !artifactId) return;

    try {
      await BindingsManager.add(runtime, event, artifactId, once);
      eventInput.value = '';
      artifactInput.value = '';
      if (onceInput) onceInput.checked = false;
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  async function render() {
    if (!listEl) return;
    const runtime = RuntimeManager.getActive();
    if (!runtime) {
      listEl.innerHTML = '<div class="empty-msg">No active runtime</div>';
      return;
    }

    try {
      const bindings = await BindingsManager.list(runtime);
      listEl.innerHTML = '';
      if (!bindings || !bindings.length) {
        listEl.innerHTML = '<div class="empty-msg">No active bindings</div>';
        return;
      }

      bindings.forEach(b => {
        const item = document.createElement('div');
        item.className = 'binding-item';
        item.innerHTML = `
          <span class="binding-event">${escHtml(b.event)}</span>
          <span class="binding-arrow">→</span>
          <span class="binding-artifact">${escHtml(b.artifactId)}</span>
          ${b.once ? '<span class="binding-badge">once</span>' : ''}
          <div class="binding-actions">
            <button class="btn-icon danger" title="Remove">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        `;
        item.querySelector('.danger').addEventListener('click', async () => {
          if (confirm(`Remove binding for ${b.event}?`)) {
            try {
              await BindingsManager.remove(runtime, b.event, b.artifactId);
              render();
            } catch (err) { alert(err.message); }
          }
        });
        listEl.appendChild(item);
      });
    } catch (err) {
      listEl.innerHTML = `<div class="error-line">Failed to load: ${escHtml(err.message)}</div>`;
    }
  }

  return { render };
})();

// Tabs logic update
document.addEventListener('click', e => {
  const tab = e.target.closest('.output-tab');
  if (tab && tab.dataset.tab === 'bindings') {
    BindingsPanel.render();
  }
});

/* ================================================================
 * 12. INIT
 * ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  LibraryPanel.render();
  RuntimesBar.render();

  const saved = localStorage.getItem('nodaic-graph');
  if (saved) { try { _importGraph(JSON.parse(saved)); } catch (_) { } }

  const param = new URLSearchParams(location.search).get('graph');
  if (param) { try { _importGraph(JSON.parse(decodeURIComponent(atob(param)))); } catch (_) { } }
});

console.log('%cNodaic Studio', 'font-family:monospace;font-size:1.2rem;color:#52D9A6;font-weight:bold;');

/* ================================================================
 * 12. AUTH MODAL
 * ================================================================ */

const AuthModal = (() => {
  const overlay = document.getElementById('authModal');
  const body = document.getElementById('authModalBody');
  const createBtn = document.getElementById('createKeyBtn');
  const closeBtn = document.getElementById('closeAuthModal');

  const open = async () => {
    overlay.classList.add('active');
    render();
  };
  const close = () => overlay.classList.remove('active');

  closeBtn.addEventListener('click', close);
  createBtn.addEventListener('click', _promptCreateKey);

  async function render() {
    const runtime = RuntimeManager.getActive();
    if (!runtime) {
      body.innerHTML = '<div class="empty-msg">Connect an runtime to manage API keys</div>';
      createBtn.disabled = true;
      return;
    }

    createBtn.disabled = false;
    body.innerHTML = '<div class="empty-msg">Loading keys...</div>';

    try {
      const url = `${runtime.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auth.list', token: runtime.token, payload: {} })
      });
      
      if (!res.ok) throw new Error('Failed to fetch keys');
      const data = await res.json();
      
      if (!data.keys || data.keys.length === 0) {
        body.innerHTML = `<div class="empty-msg">No API keys found on <b>${escHtml(runtime.name)}</b></div>`;
        return;
      }

      body.innerHTML = '';
      data.keys.forEach(key => {
        const card = document.createElement('div');
        card.className = 'auth-key-card';
        card.innerHTML = `
          <div class="auth-key-header">
            <span class="auth-key-id">${escHtml(key.keyId)}</span>
            <div class="auth-key-actions">
              <button class="btn-small btn-ghost" onclick="AuthModal.copyToken('${key.keyId}')">Copy</button>
              <button class="btn-small btn-danger-ghost" onclick="AuthModal.revokeKey('${key.keyId}')">Revoke</button>
            </div>
          </div>
          <table class="auth-scope-table">
            <thead>
              <tr><th>Runtime</th><th>Role</th><th>Scope</th></tr>
            </thead>
            <tbody>
              ${key.permissions.map(p => `
                <tr>
                  <td>${escHtml(p.runtimeId || '*')}</td>
                  <td>${escHtml(p.role)}</td>
                  <td>${escHtml(p.scope || '*')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
        body.appendChild(card);
      });
    } catch (err) {
      body.innerHTML = `<div class="empty-msg is-error">Error: ${escHtml(err.message)}</div>`;
    }
  }

  async function _promptCreateKey() {
    const runtime = RuntimeManager.getActive();
    if (!runtime) return;

    const role = prompt('Enter role for new key (admin/editor/runner/viewer):', 'viewer');
    if (!role) return;

    try {
      const url = `${runtime.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'auth.create',
          token: runtime.token,
          payload: { 
            permissions: [{ runtimeId: '*', role, scope: '*' }]
          }
        })
      });
      
      if (!res.ok) throw new Error('Failed to create key');
      const data = await res.json();
      
      if (data.token) {
        if (typeof Toast !== 'undefined') Toast.success('Key created! Token copied to clipboard');
        navigator.clipboard.writeText(data.token);
      }
      render();
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.error(err.message);
    }
  }

  async function revokeKey(keyId) {
    const runtime = RuntimeManager.getActive();
    if (!runtime) return;
    if (!confirm(`Revoke key ${keyId}? This cannot be undone.`)) return;

    try {
      const url = `${runtime.serverBase}/nodaic/v1/`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auth.revoke', token: runtime.token, payload: { keyId } })
      });
      if (!res.ok) throw new Error('Failed to revoke key');
      if (typeof Toast !== 'undefined') Toast.success('Key revoked');
      render();
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.error(err.message);
    }
  }

  function copyToken(keyId) {
    if (typeof Toast !== 'undefined') Toast.info('Tokens only shown once at creation. Revoke and create new if lost.');
  }

  return { open, render, revokeKey, copyToken };
})();

// Re-expose to window for onclick handlers
window.AuthModal = AuthModal;
document.getElementById('authBtn').addEventListener('click', AuthModal.open);
