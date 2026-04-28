/**
 * @fileoverview Graph Editor Web Component
 * A lightweight, customizable node-based graph editor with zero dependencies.
 * 
 * @version 1.0.0
 * @author Hassaan Maqsood
 * @license MIT
 * 
 * ============================================================================
 * API REFERENCE - QUICK LOOKUP
 * ============================================================================
 * 
 * CONFIGURATION:
 * - setConfig(config)              - Update editor configuration
 * - config.snapRadius              - Port connection snap distance (default: 30)
 * - config.gridSize                - Grid cell size (default: 20)
 * - config.showGrid                - Show/hide grid (default: true)
 * - config.edgeStyle               - Edge style: 'bezier'|'straight'|'step'
 * - config.theme                   - Theme: 'dark'|'light'
 * - config.zoomSpeed               - Zoom sensitivity (default: 0.1)
 * - config.minZoom                 - Minimum zoom level (default: 0.1)
 * - config.maxZoom                 - Maximum zoom level (default: 3)
 * - config.zoomToMouse             - Zoom to mouse cursor vs canvas center
 * - config.enableKeyboardShortcuts - Enable keyboard navigation (default: true)
 * 
 * NODE MANAGEMENT:
 * - addNode(nodeData)              - Add a new node to the graph
 * - removeNode(nodeId)             - Remove a node by ID
 * - getNodes()                     - Get all nodes as array
 * - getNodeData(nodeId)            - Get node data by ID
 * - updateNodeContent(nodeId, html)- Update node display content
 * - updateNodeTitle(nodeId, title) - Update node title
 * 
 * EDGE MANAGEMENT:
 * - addEdge(sourceId, targetId, sourcePort, targetPort) - Create connection
 * - removeEdge(edgeId)             - Remove edge by ID
 * - getEdges()                     - Get all edges as array
 * - updateConnectedEdges(node)     - Refresh edges for a node
 * 
 * VIEW CONTROL:
 * - centerView()                   - Reset pan and zoom to center
 * - fitToView()                    - Fit all nodes in viewport
 * - setZoom(scale)                 - Set zoom level (0.1 - 3)
 * - getCenter()                    - Get canvas center coordinates
 * 
 * GRAPH OPERATIONS:
 * - exportGraph()                  - Export graph as JSON
 * - importGraph(data)              - Import graph from JSON
 * - clearGraph()                   - Remove all nodes and edges
 * 
 * SELECTION:
 * - clearSelection()               - Deselect all elements
 * - deleteSelected()               - Delete selected node/edge
 * 
 * STYLING:
 * - setStylesheet(css)             - Apply CSS as string
 * - loadStylesheetFromURL(url)     - Load external CSS file (async)
 * 
 * EVENTS:
 * - 'editor-ready'                 - Editor initialized
 * - 'node-added'                   - Node created
 * - 'node-removed'                 - Node deleted
 * - 'node-moved'                   - Node position changed
 * - 'edge-added'                   - Edge created
 * - 'edge-removed'                 - Edge deleted
 * - 'selection-changed'            - Selection updated
 * - 'zoom-changed'                 - Zoom level changed
 * 
 * NODE DATA STRUCTURE:
 * {
 *   id: string,                    - Unique identifier (auto-generated)
 *   title: string,                 - Display name
 *   position: {x, y},              - Canvas coordinates
 *   inputs: [{id, label, type}],   - Input ports
 *   outputs: [{id, label, type}],  - Output ports
 *   content: string,               - HTML for display area
 *   color: string                  - Accent color (CSS)
 * }
 * 
 * KEYBOARD SHORTCUTS (when enabled):
 * - Delete/Backspace               - Delete selected element
 * - Arrow Keys                     - Pan canvas (with Shift for faster)
 * - +/=                            - Zoom in
 * - -/_                            - Zoom out
 * - 0                              - Reset zoom to 100%
 * - F                              - Fit all nodes in view
 * - A                              - Select all (Ctrl/Cmd + A)
 * - Escape                         - Clear selection
 * 
 * CSS CUSTOM PROPERTIES (40+ available):
 * --background-color, --grid-color, --node-bg, --node-text, --edge-color,
 * --port-color, --selected-color, --edge-width, --port-size, --node-shadow,
 * --node-border-radius, --transition-duration, and more...
 * 
 * ============================================================================
 */

/**
 * GraphEditor Web Component
 * A lightweight, customizable node-based graph editor
 * 
 * @class GraphEditor
 * @extends HTMLElement
 * 
 * @example
 * // Basic usage
 * const editor = document.getElementById('editor');
 * editor.setConfig({ gridSize: 20, showGrid: true });
 * 
 * @example
 * // Add a node
 * editor.addNode({
 *   title: 'My Node',
 *   position: { x: 100, y: 100 },
 *   inputs: [{ id: 'in', label: 'Input', type: 'any' }],
 *   outputs: [{ id: 'out', label: 'Output', type: 'any' }]
 * });
 * 
 * @example
 * // Listen to events
 * editor.addEventListener('node-added', (e) => {
 *   console.log('Node added:', e.detail.nodeId);
 * });
 */
class GraphEditor extends HTMLElement {
  /**
   * Creates a new GraphEditor instance
   * @constructor
   */
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // State
    /** @type {Map<string, {element: HTMLElement, data: Object}>} */
    this.nodes = new Map();

    /** @type {Map<string, {sourceNode: string, targetNode: string, sourcePort: string, targetPort: string, element: SVGPathElement}>} */
    this.edges = new Map();

    /** @type {HTMLElement|SVGPathElement|null} */
    this.selectedElement = null;

    /** @type {Object|null} */
    this.currentEdge = null;

    /** @type {{x: number, y: number}} */
    this.canvasOffset = { x: 0, y: 0 };

    /** @type {number} */
    this.scale = 1;

    /** @type {number} */
    this.nodeIdCounter = 0;

    // Configuration
    /** @type {Object} */
    this.config = {
      snapRadius: 30,
      gridSize: 20,
      showGrid: true,
      edgeStyle: 'bezier', // 'bezier' | 'straight' | 'step'
      theme: 'dark',
      zoomSpeed: 0.1,
      minZoom: 0.1,
      maxZoom: 3,
      zoomToMouse: true, // Zoom to cursor vs canvas center
      enableKeyboardShortcuts: true,
      nodeLayout: 'classic' // 'classic' | 'modern'
    };
  }

  /**
   * Called when element is added to the DOM
   * @override
   */
  connectedCallback() {
    this.render();
    this.setupEventListeners();

    // Apply custom stylesheet if provided
    this.applyCustomStylesheet();

    this.dispatchEvent(new CustomEvent('editor-ready', { detail: this }));
  }

  /**
   * Apply custom stylesheets from slots
   * @private
   */
  applyCustomStylesheet() {
    // Check for inline stylesheet
    const styleSlot = this.querySelector('style[slot="stylesheet"]');
    if (styleSlot) {
      const styleElement = document.createElement('style');
      styleElement.textContent = styleSlot.textContent;
      this.shadowRoot.appendChild(styleElement);
    }

    // Check for external stylesheet link
    const linkSlot = this.querySelector('link[slot="stylesheet"]');
    if (linkSlot) {
      const linkElement = document.createElement('link');
      linkElement.rel = 'stylesheet';
      linkElement.href = linkSlot.getAttribute('href');
      this.shadowRoot.appendChild(linkElement);
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="graph-editor">
        <div class="canvas-container">
          <canvas class="grid-canvas"></canvas>
          <div class="canvas" part="canvas">
            <svg class="edges-layer" part="edges-layer"></svg>
            <div class="nodes-layer" part="nodes-layer"></div>
          </div>
        </div>
        <slot name="toolbar"></slot>
        <slot name="library"></slot>
      </div>
    `;

    this.canvas = this.shadowRoot.querySelector('.canvas');
    this.nodesLayer = this.shadowRoot.querySelector('.nodes-layer');
    this.edgesLayer = this.shadowRoot.querySelector('.edges-layer');
    this.gridCanvas = this.shadowRoot.querySelector('.grid-canvas');

    if (this.config.showGrid) {
      this.drawGrid();
    }
  }

  getStyles() {
    return `
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
        
        /* Color scheme */
        --background-color: ${this.config.theme === 'dark' ? '#222' : '#fff'};
        --grid-color: ${this.config.theme === 'dark' ? '#333' : '#e0e0e0'};
        --node-bg: ${this.config.theme === 'dark' ? '#111' : '#f5f5f5'};
        --node-border: ${this.config.theme === 'dark' ? '#333' : '#ddd'};
        --node-text: ${this.config.theme === 'dark' ? '#f5f6f8' : '#000'};
        --edge-color: #474bff;
        --edge-width: 2;
        --edge-hover-color: #66ff66;
        --selected-color: #ff6b6b;
        --selected-width: 3;
        --port-color: #474bff;
        --port-size: 1rem;
        --port-hover-scale: 1.2;
        
        /* Node styling */
        --node-border-radius: 15px;
        --node-border-width: 2px;
        --node-padding: 1rem 0.5rem;
        --node-gap: 1rem;
        --node-min-width: 200px;
        --node-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        
        /* Typography */
        --node-title-size: 1rem;
        --node-title-weight: 500;
        --node-title-max-width: 15ch;
        
        /* Port styling */
        --port-border-radius: 50%;
        --port-shadow: 0 0 8px currentColor;
        --input-port-offset: -50%;
        --output-port-offset: 50%;
        
        /* Edge styling */
        --edge-temporary-color: #666;
        --edge-temporary-dash: 5, 5;
        
        /* Transition timing */
        --transition-duration: 0.0s;
        --transition-timing: ease;
      }

      .graph-editor {
        width: 100%;
        height: 100%;
        background-color: var(--background-color);
        position: relative;
        border-radius: 0.75rem;
        overflow: hidden;
      }

      .canvas-container {
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
      }

      .grid-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 0;
      }

      .canvas {
        position: absolute;
        top: 0;
        left: 0;
        min-width: 100%;
        min-height: 100%;
        cursor: grab;
        touch-action: none;
        z-index: 1;
      }

      .canvas.dragging {
        cursor: grabbing;
      }

      .edges-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: visible;
        transform-origin: 0 0;
      }

      .edges-layer path {
        pointer-events: stroke;
        stroke-width: var(--edge-width);
      }

      .nodes-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        transform-origin: 0 0;
      }

      /* Node Styles - Engineering Three-Column Layout */
      .node {
        position: absolute;
        display: flex;
        flex-direction: column;
        min-width: var(--node-min-width);
        user-select: none;
        pointer-events: all;
        filter: drop-shadow(var(--node-shadow));
        background-color: var(--node-bg);
        border: var(--node-border-width) solid var(--node-border-color, transparent);
        border-radius: var(--node-border-radius);
        transition: all var(--transition-duration) var(--transition-timing);
        overfow: hidden;
      }

      .node.selected {
        /* border-color: var(--selected-color); */
        box-shadow: 0 0 0 2px var(--selected-color);
      }

      /* Node Header (Title Bar) */
      .node-header {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: var(--node-header-bg, rgba(255, 255, 255, 0.05));
        border-bottom: 1px solid var(--node-border-color, rgba(255, 255, 255, 0.1));
        border-radius: var(--node-border-radius) var(--node-border-radius) 0 0;
        cursor: move;
      }

      .node-header:active {
        cursor: grabbing;
      }

      .node-header .title {
        flex: 1;
        font-weight: var(--node-title-weight);
        font-size: var(--node-title-size);
        color: var(--node-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
      }

      /* Node Body - Three Column Layout */
      .node-body {
        display: flex;
        flex-direction: row;
        gap: 0.25rem;
        padding: 0.25rem;
        min-height: 2.5rem;
        align-items: stretch;
      }

      /* Port Columns */
      .ports-column {
        display: flex;
        flex-direction: column;
        justify-content: space-around;
        gap: var(--port-spacing, 0.75rem);
        /* padding: 0.75rem 0.5rem; */
        min-width: fit-content;
      }

      .ports-column.inputs {
        padding-left: 0;
        align-items: flex-start;
      }

      .ports-column.outputs {
        padding-right: 0;
        align-items: flex-end;
      }

      /* Port Row - Socket + Label */
      .port-row {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        position: relative;
      }

      .inputs .port-row {
        flex-direction: row; /* Socket on left, label on right */
      }

      .outputs .port-row {
        flex-direction: row-reverse; /* Socket on right, label on left */
      }

      /* Port Labels */
      .port-label {
        text-transform: capitalize;
        font-size: var(--port-label-size, 0.8rem);
        color: var(--port-label-color, var(--node-text));
        white-space: nowrap;
        user-select: none;
        opacity: 0.9;
        transition: opacity var(--transition-duration);
      }

      .port-row:hover .port-label {
        opacity: 1;
      }

      .inputs .port-label {
        text-align: left;
      }

      .outputs .port-label {
        text-align: right;
      }

      /* Port Sockets */
      .port {
        width: var(--port-size);
        height: var(--port-size);
        border-radius: 50%;
        /* border: 2px solid var(--port-color); */
        background: var(--port-color);
        cursor: crosshair;
        flex-shrink: 0;
        transition: all var(--transition-duration) var(--transition-timing);
        position: relative;
        z-index: 10;
      }

      .port.input {
        /* margin-left: calc(var(--port-size) / -2); */
      }

      .port.output {
        /* margin-right: calc(var(--port-size) / -2); */
      }

      .port:hover {
        transform: scale(var(--port-hover-scale));
        /* background: var(--port-color); */
        /* box-shadow: var(--port-shadow); */
      }

      .port.input:hover {
        /* transform: translateX(0) scale(var(--port-hover-scale)); */
        /* margin-left: calc(var(--port-size) / -2); */
      }

      .port.output:hover {
        /* transform: translateX(0) scale(var(--port-hover-scale)); */
        /* margin-right: calc(var(--port-size) / -2); */
      }

      .port.connecting {
        background: var(--port-color);
        /* box-shadow: 0 0 10px var(--port-color); */
      }

      .port.hover {
        background-color: var(--edge-hover-color);
      }

      /* Display Column (Middle) */
      .display-column {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 100px; /* Ensure minimum usable width */
        /* padding: 0.75rem; */
        overflow: hidden;
        align-self: stretch; /* Match port column heights */
      }

      .display {
        flex: 1;
        display: flex;
        flex-direction: column;
        /* overflow: auto; */
        color: var(--node-text);
      }

      .display:empty {
        min-height: 0;
      }

      /* Modern Layout Styles */
      :host([data-layout="modern"]) .node {
        display: flex;
        flex-direction: column;
        min-width: 180px;
      }

      :host([data-layout="modern"]) .node .title {
        order: -2;
        background: rgba(0, 0, 0, 0.2);
        padding: 0.75rem 1rem;
        text-align: center;
        font-weight: 600;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: var(--node-border-radius) var(--node-border-radius) 0 0;
        margin: 0;
        max-width: none;
        cursor: grab;
      }

      :host([data-layout="modern"]) .node .title:active {
        cursor: grabbing;
      }

      :host([data-layout="modern"]) .node .display {
        order: -1;
        border-radius: 0;
        padding: 1rem;
        min-height: 60px;
        aspect-ratio: unset;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      }

      :host([data-layout="modern"]) .node .display:empty {
        display: flex;
        min-height: 0;
        padding: 0;
      }

      :host([data-layout="modern"]) .node .block {
        order: 0;
        display: flex;
        flex-direction: row;
        padding: 0;
        align-items: stretch;
        position: relative;
        min-height: 40px;
        cursor: default;
      }

      :host([data-layout="modern"]) .ports {
        display: flex;
        flex-direction: column;
        justify-content: space-evenly;
        gap: 0.75rem;
        padding: 0.75rem 0.5rem;
        flex: 0 0 auto;
      }

      :host([data-layout="modern"]) .ports.inputs {
        align-items: flex-start;
        padding-left: 0;
      }

      :host([data-layout="modern"]) .ports.outputs {
        align-items: flex-end;
        padding-right: 0;
      }

      :host([data-layout="modern"]) .port {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid var(--node-bg);
        position: relative;
        transform: none;
      }

      :host([data-layout="modern"]) .port.input {
        transform: translateX(-50%);
      }

      :host([data-layout="modern"]) .port.output {
        transform: translateX(50%);
      }

      :host([data-layout="modern"]) .port:hover {
        transform: translateX(-50%) scale(1.3);
      }

      :host([data-layout="modern"]) .port.output:hover {
        transform: translateX(50%) scale(1.3);
      }

      /* Port labels for modern layout */
      :host([data-layout="modern"]) .port::after {
        content: attr(title);
        position: absolute;
        font-size: 0.75rem;
        white-space: nowrap;
        color: var(--node-text);
        opacity: 0.7;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
      }

      :host([data-layout="modern"]) .port.input::after {
        left: 20px;
      }

      :host([data-layout="modern"]) .port.output::after {
        right: 20px;
      }

      /* Middle section for modern layout (between ports) */
      :host([data-layout="modern"]) .node .block::before {
        content: '';
        flex: 1;
        min-width: 40px;
      }

      /* Edge styles */
      .edge {
        fill: none;
        stroke: var(--edge-color);
        stroke-width: var(--edge-width);
        cursor: pointer;
      }

      .edge.temporary {
        stroke: var(--edge-temporary-color);
        stroke-dasharray: var(--edge-temporary-dash);
        pointer-events: none;
      }

      .edge.selected {
        stroke: var(--selected-color);
        stroke-width: var(--selected-width);
      }

      ::slotted([slot="toolbar"]) {
        position: absolute;
        top: 1rem;
        left: 1rem;
        z-index: 1000;
      }

      ::slotted([slot="library"]) {
        position: absolute;
        right: 0;
        top: 0;
        height: 100%;
        z-index: 999;
      }
    `;
  }

  drawGrid() {
    const ctx = this.gridCanvas.getContext('2d');
    const { width, height } = this.gridCanvas.getBoundingClientRect();

    this.gridCanvas.width = width;
    this.gridCanvas.height = height;

    // Get grid color from CSS variable
    const gridColor = getComputedStyle(this).getPropertyValue('--grid-color').trim() ||
      (this.config.theme === 'dark' ? '#333' : '#e0e0e0');

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;

    const gridSize = this.config.gridSize;
    const offsetX = this.canvasOffset.x % gridSize;
    const offsetY = this.canvasOffset.y % gridSize;

    // Vertical lines
    for (let x = offsetX; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = offsetY; y < height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  setupEventListeners() {
    // Canvas panning
    let isPanning = false;
    let startX, startY;

    this.canvas.addEventListener('pointerdown', (e) => {
      // Only start panning if clicking on canvas or nodes layer (not on a node)
      if (e.target === this.canvas || e.target === this.nodesLayer) {
        isPanning = true;
        startX = e.clientX - this.canvasOffset.x;
        startY = e.clientY - this.canvasOffset.y;
        this.canvas.classList.add('dragging');

        // Clear selection when clicking on empty canvas
        this.clearSelection();
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (isPanning) {
        this.canvasOffset.x = e.clientX - startX;
        this.canvasOffset.y = e.clientY - startY;
        this.updateCanvasPosition();
        if (this.config.showGrid) {
          this.drawGrid();
        }
      }

      // Handle edge creation
      if (this.currentEdge) {
        this.updateTemporaryEdge(e);
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (isPanning) {
        isPanning = false;
        this.canvas.classList.remove('dragging');
      }

      if (this.currentEdge) {
        this.finalizeEdge(e);
      }
    });

    // Zoom with mouse wheel / trackpad
    const canvasContainer = this.shadowRoot.querySelector('.canvas-container');
    canvasContainer.addEventListener('wheel', (e) => {
      e.preventDefault();

      const delta = e.deltaY > 0 ? -this.config.zoomSpeed : this.config.zoomSpeed;
      const newScale = this.scale * (1 + delta);

      if (this.config.zoomToMouse) {
        // Zoom to mouse cursor position
        this.zoomToPoint(newScale, e.clientX, e.clientY);
      } else {
        // Zoom to canvas center
        this.setZoom(newScale);
      }
    }, { passive: false });

    // Keyboard shortcuts
    if (this.config.enableKeyboardShortcuts) {
      this.setupKeyboardShortcuts();
    }
  }

  /**
   * Setup keyboard shortcuts for navigation and actions
   * @private
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Only handle shortcuts if not typing in input/textarea/contenteditable
      // Check both document and shadow DOM
      const activeElement = document.activeElement;
      const shadowActiveElement = this.shadowRoot.activeElement;

      // Don't handle shortcuts if typing in any input field
      if (activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable)) {
        return;
      }

      // Also check shadow DOM for inputs within nodes
      if (shadowActiveElement && (
        shadowActiveElement.tagName === 'INPUT' ||
        shadowActiveElement.tagName === 'TEXTAREA' ||
        shadowActiveElement.isContentEditable)) {
        return;
      }

      // Check if any input within the editor has focus
      const focusedInput = this.shadowRoot.querySelector('input:focus, textarea:focus, [contenteditable="true"]:focus');
      if (focusedInput) {
        return;
      }

      // Check if any node is selected for node-specific actions
      const hasNodeSelection = this.selectedElement &&
        this.selectedElement.classList.contains('node');
      const hasMultipleSelection = this.shadowRoot.querySelectorAll('.node.selected').length > 1;

      // Pan speed - faster with shift
      const panSpeed = e.shiftKey ? 50 : 20;

      switch (e.key) {
        // Delete selected element(s)
        case 'Delete':
        case 'Backspace':
          if (this.selectedElement || hasMultipleSelection) {
            e.preventDefault();
            this.deleteSelected();
          }
          break;

        // Pan canvas or move selected nodes
        case 'ArrowUp':
          e.preventDefault();
          if (hasNodeSelection && !e.ctrlKey && !e.metaKey) {
            this.moveSelectedNodes(0, -10);
          } else {
            this.canvasOffset.y += panSpeed;
            this.updateCanvasPosition();
            if (this.config.showGrid) this.drawGrid();
          }
          break;

        case 'ArrowDown':
          e.preventDefault();
          if (hasNodeSelection && !e.ctrlKey && !e.metaKey) {
            this.moveSelectedNodes(0, 10);
          } else {
            this.canvasOffset.y -= panSpeed;
            this.updateCanvasPosition();
            if (this.config.showGrid) this.drawGrid();
          }
          break;

        case 'ArrowLeft':
          e.preventDefault();
          if (hasNodeSelection && !e.ctrlKey && !e.metaKey) {
            this.moveSelectedNodes(-10, 0);
          } else {
            this.canvasOffset.x += panSpeed;
            this.updateCanvasPosition();
            if (this.config.showGrid) this.drawGrid();
          }
          break;

        case 'ArrowRight':
          e.preventDefault();
          if (hasNodeSelection && !e.ctrlKey && !e.metaKey) {
            this.moveSelectedNodes(10, 0);
          } else {
            this.canvasOffset.x -= panSpeed;
            this.updateCanvasPosition();
            if (this.config.showGrid) this.drawGrid();
          }
          break;

        // Tab through nodes
        case 'Tab':
          e.preventDefault();
          if (e.shiftKey) {
            this.selectPreviousNode();
          } else {
            this.selectNextNode();
          }
          break;

        // Zoom controls
        case '+':
        case '=':
          e.preventDefault();
          this.setZoom(this.scale * 1.1);
          break;

        case '-':
        case '_':
          e.preventDefault();
          this.setZoom(this.scale * 0.9);
          break;

        case '0':
          e.preventDefault();
          this.setZoom(1);
          break;

        // Fit view
        case 'f':
        case 'F':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.fitToView();
          }
          break;

        // Clear selection
        case 'Escape':
          e.preventDefault();
          this.clearSelection();
          break;

        // Select all (Ctrl/Cmd + A)
        case 'a':
        case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.selectAllNodes();
          }
          break;
      }
    });
  }

  /**
   * Move all selected nodes by a delta
   * @param {number} dx - Delta X
   * @param {number} dy - Delta Y
   * @private
   */
  moveSelectedNodes(dx, dy) {
    const selectedNodes = this.shadowRoot.querySelectorAll('.node.selected');
    selectedNodes.forEach(node => {
      const currentX = parseFloat(node.style.left) || 0;
      const currentY = parseFloat(node.style.top) || 0;
      node.style.left = `${currentX + dx}px`;
      node.style.top = `${currentY + dy}px`;
      this.updateConnectedEdges(node);
    });
  }

  /**
   * Select all nodes
   * @private
   */
  selectAllNodes() {
    this.clearSelection();
    this.nodes.forEach((nodeObj) => {
      nodeObj.element.classList.add('selected');
    });
    this.selectedElement = this.shadowRoot.querySelector('.node.selected');
    this.dispatchEvent(new CustomEvent('selection-changed', {
      detail: { selected: 'multiple', count: this.nodes.size }
    }));
  }

  /**
   * Select next node (Tab navigation)
   * @private
   */
  selectNextNode() {
    const nodesArray = Array.from(this.nodes.values()).map(n => n.element);
    if (nodesArray.length === 0) return;

    let currentIndex = -1;
    if (this.selectedElement && this.selectedElement.classList.contains('node')) {
      currentIndex = nodesArray.indexOf(this.selectedElement);
    }

    const nextIndex = (currentIndex + 1) % nodesArray.length;
    const nextNode = nodesArray[nextIndex];

    this.clearSelection();
    this.selectNode(nextNode);

    // Scroll node into view
    this.scrollNodeIntoView(nextNode);
  }

  /**
   * Select previous node (Shift+Tab navigation)
   * @private
   */
  selectPreviousNode() {
    const nodesArray = Array.from(this.nodes.values()).map(n => n.element);
    if (nodesArray.length === 0) return;

    let currentIndex = -1;
    if (this.selectedElement && this.selectedElement.classList.contains('node')) {
      currentIndex = nodesArray.indexOf(this.selectedElement);
    }

    const prevIndex = currentIndex <= 0 ? nodesArray.length - 1 : currentIndex - 1;
    const prevNode = nodesArray[prevIndex];

    this.clearSelection();
    this.selectNode(prevNode);

    // Scroll node into view
    this.scrollNodeIntoView(prevNode);
  }

  /**
   * Scroll a node into view
   * @param {HTMLElement} node - The node to scroll to
   * @private
   */
  scrollNodeIntoView(node) {
    const nodeRect = node.getBoundingClientRect();
    const editorRect = this.getBoundingClientRect();

    const nodeCenterX = nodeRect.left + nodeRect.width / 2;
    const nodeCenterY = nodeRect.top + nodeRect.height / 2;

    const editorCenterX = editorRect.left + editorRect.width / 2;
    const editorCenterY = editorRect.top + editorRect.height / 2;

    // Check if node is outside viewport
    const margin = 50;
    if (nodeCenterX < editorRect.left + margin ||
      nodeCenterX > editorRect.right - margin ||
      nodeCenterY < editorRect.top + margin ||
      nodeCenterY > editorRect.bottom - margin) {

      // Pan to center the node
      const pos = this.getNodePosition(node);
      this.canvasOffset.x = editorRect.width / 2 - (pos.x + nodeRect.width / 2) * this.scale;
      this.canvasOffset.y = editorRect.height / 2 - (pos.y + nodeRect.height / 2) * this.scale;
      this.updateCanvasPosition();
      if (this.config.showGrid) this.drawGrid();
    }
  }

  /**
   * Update the canvas transform (pan and zoom)
   * @private
   */
  updateCanvasPosition() {
    const transform = `translate(${this.canvasOffset.x}px, ${this.canvasOffset.y}px) scale(${this.scale})`;
    this.nodesLayer.style.transform = transform;
    this.edgesLayer.style.transform = transform;
  }

  /**
   * Set the zoom level
   * @param {number} newScale - The new zoom scale (0.1 to 3)
   * @fires GraphEditor#zoom-changed
   */
  setZoom(newScale) {
    this.scale = Math.max(this.config.minZoom, Math.min(this.config.maxZoom, newScale));
    this.updateCanvasPosition();
    this.dispatchEvent(new CustomEvent('zoom-changed', { detail: { scale: this.scale } }));
  }

  /**
   * Zoom to a specific point (mouse cursor position)
   * @param {number} newScale - The new zoom scale
   * @param {number} clientX - Mouse X position in viewport
   * @param {number} clientY - Mouse Y position in viewport
   * @private
   */
  zoomToPoint(newScale, clientX, clientY) {
    newScale = Math.max(this.config.minZoom, Math.min(this.config.maxZoom, newScale));

    const rect = this.getBoundingClientRect();

    // Mouse position relative to editor
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    // Canvas position under mouse before zoom
    const canvasX = (mouseX - this.canvasOffset.x) / this.scale;
    const canvasY = (mouseY - this.canvasOffset.y) / this.scale;

    // Update scale
    const oldScale = this.scale;
    this.scale = newScale;

    // Adjust offset to keep point under mouse
    this.canvasOffset.x = mouseX - canvasX * this.scale;
    this.canvasOffset.y = mouseY - canvasY * this.scale;

    this.updateCanvasPosition();
    if (this.config.showGrid) {
      this.drawGrid();
    }

    this.dispatchEvent(new CustomEvent('zoom-changed', { detail: { scale: this.scale } }));
  }

  // Node Management
  /**
   * Add a new node to the graph
   * @param {Object} nodeData - Node configuration
   * @param {string} [nodeData.id] - Unique identifier (auto-generated if not provided)
   * @param {string} [nodeData.title='Node'] - Display title
   * @param {{x: number, y: number}} [nodeData.position] - Canvas position (defaults to center)
   * @param {Array<{id: string, label: string, type: string}>} [nodeData.inputs=[]] - Input ports
   * @param {Array<{id: string, label: string, type: string}>} [nodeData.outputs=[]] - Output ports
   * @param {string} [nodeData.content] - HTML content for display area
   * @param {string} [nodeData.color] - CSS color for ports
   * @returns {HTMLElement} The created node element
   * @fires GraphEditor#node-added
   * 
   * @example
   * editor.addNode({
   *   title: 'Math Operation',
   *   position: { x: 100, y: 200 },
   *   inputs: [
   *     { id: 'a', label: 'A', type: 'number' },
   *     { id: 'b', label: 'B', type: 'number' }
   *   ],
   *   outputs: [
   *     { id: 'result', label: 'Result', type: 'number' }
   *   ],
   *   color: '#ff6b6b'
   * });
   */
  addNode(nodeData) {
    const nodeId = nodeData.id || this.generateId('node');
    const position = nodeData.position || this.getCenter();

    const nodeElement = this.createNodeElement(nodeId, {
      ...nodeData,
      position
    });

    this.nodes.set(nodeId, {
      element: nodeElement,
      data: nodeData
    });

    this.nodesLayer.appendChild(nodeElement);

    this.dispatchEvent(new CustomEvent('node-added', {
      detail: { nodeId, node: nodeElement, data: nodeData }
    }));

    return nodeElement;
  }

  createNodeElement(nodeId, data) {
    const node = document.createElement('div');
    node.className = 'node';
    node.dataset.nodeId = nodeId;
    node.style.left = `${data.position.x}px`;
    node.style.top = `${data.position.y}px`;

    // Apply custom color
    if (data.color) {
      node.style.setProperty('--port-color', data.color);
    }

    const inputs = data.inputs || [];
    const outputs = data.outputs || [];

    node.innerHTML = `
      <div class="node-header">
        <div class="title">${data.title || 'Node'}</div>
      </div>
      <div class="node-body">
        <div class="ports-column inputs">
          ${inputs.map(input => `
            <div class="port-row">
              <div class="port input" 
                   data-port-id="${input.id}"
                   data-port-type="${input.type}"
                   title="${input.label} (${input.type})">
              </div>
              <span class="port-label">${input.label}</span>
            </div>
          `).join('')}
        </div>
        <div class="display-column">
          <div class="display">${data.content || ''}</div>
        </div>
        <div class="ports-column outputs">
          ${outputs.map(output => `
            <div class="port-row">
              <span class="port-label">${output.label}</span>
              <div class="port output" 
                   data-port-id="${output.id}"
                   data-port-type="${output.type}"
                   title="${output.label} (${output.type})">
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    this.setupNodeEventListeners(node);

    return node;
  }

  setupNodeEventListeners(node) {
    const header = node.querySelector('.node-header');
    let isDraggingNode = false;
    let dragStartX, dragStartY;
    let nodeStartX, nodeStartY;

    // Function to handle drag start
    const handleDragStart = (e) => {
      // Don't drag when clicking ports
      if (e.target.classList.contains('port')) return;

      e.stopPropagation(); // Prevent canvas panning

      // Multi-select with Shift or Ctrl/Cmd
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // Toggle selection for this node
        if (node.classList.contains('selected')) {
          node.classList.remove('selected');
          if (this.selectedElement === node) {
            // Find another selected node to be the primary
            this.selectedElement = this.shadowRoot.querySelector('.node.selected');
          }
        } else {
          node.classList.add('selected');
          this.selectedElement = node;
        }

        const selectedCount = this.shadowRoot.querySelectorAll('.node.selected').length;
        this.dispatchEvent(new CustomEvent('selection-changed', {
          detail: { selected: selectedCount > 1 ? 'multiple' : node, count: selectedCount }
        }));
        return; // Don't start drag on multi-select click
      }

      // Check if this node is already part of a multi-selection
      const selectedNodes = this.shadowRoot.querySelectorAll('.node.selected');
      const isPartOfMultiSelect = selectedNodes.length > 1 && node.classList.contains('selected');

      if (!isPartOfMultiSelect) {
        // Single select - clear others
        this.clearSelection();
        this.selectNode(node);
      }

      isDraggingNode = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartX = parseFloat(node.style.left);
      nodeStartY = parseFloat(node.style.top);
    };

    // Node selection and dragging on header
    if (header) {
      header.addEventListener('pointerdown', handleDragStart);
    }

    const onMove = (e) => {
      if (!isDraggingNode) return;

      e.stopPropagation(); // Prevent canvas panning during node drag

      const dx = (e.clientX - dragStartX) / this.scale;
      const dy = (e.clientY - dragStartY) / this.scale;

      // Check if multiple nodes are selected
      const selectedNodes = this.shadowRoot.querySelectorAll('.node.selected');

      if (selectedNodes.length > 1) {
        // Move all selected nodes
        selectedNodes.forEach(selectedNode => {
          const startX = parseFloat(selectedNode.dataset.dragStartX || selectedNode.style.left);
          const startY = parseFloat(selectedNode.dataset.dragStartY || selectedNode.style.top);
          selectedNode.style.left = `${startX + dx}px`;
          selectedNode.style.top = `${startY + dy}px`;
          this.updateConnectedEdges(selectedNode);
        });
      } else {
        // Move single node
        node.style.left = `${nodeStartX + dx}px`;
        node.style.top = `${nodeStartY + dy}px`;
        this.updateConnectedEdges(node);
      }
    };

    const onUp = (e) => {
      if (isDraggingNode) {
        e.stopPropagation(); // Prevent canvas from handling this
        isDraggingNode = false;

        // Clear drag start positions
        this.shadowRoot.querySelectorAll('.node.selected').forEach(n => {
          delete n.dataset.dragStartX;
          delete n.dataset.dragStartY;
        });

        this.dispatchEvent(new CustomEvent('node-moved', {
          detail: {
            nodeId: node.dataset.nodeId,
            position: this.getNodePosition(node)
          }
        }));
      }
    };

    // Store initial positions for multi-drag
    if (header) {
      header.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('port')) return;
        const selectedNodes = this.shadowRoot.querySelectorAll('.node.selected');
        selectedNodes.forEach(n => {
          n.dataset.dragStartX = parseFloat(n.style.left);
          n.dataset.dragStartY = parseFloat(n.style.top);
        });
      });
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);

    // Port connection handling
    node.querySelectorAll('.port').forEach(port => {
      port.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        const portId = port.dataset.portId;
        const portType = port.classList.contains('output') ? 'output' : 'input';
        const position = this.getPortPosition(port);

        this.startEdgeCreation(node, port, portId, portType, position);
      });
    });
  }

  getNodePosition(node) {
    return {
      x: parseFloat(node.style.left) || 0,
      y: parseFloat(node.style.top) || 0
    };
  }

  getPortPosition(port) {
    const portRect = port.getBoundingClientRect();
    const editorRect = this.getBoundingClientRect();

    return {
      x: (portRect.left + portRect.width / 2 - editorRect.left - this.canvasOffset.x) / this.scale,
      y: (portRect.top + portRect.height / 2 - editorRect.top - this.canvasOffset.y) / this.scale
    };
  }

  /**
   * Remove a node from the graph
   * @param {string} nodeId - The node ID to remove
   * @fires GraphEditor#node-removed
   */
  removeNode(nodeId) {
    const nodeObj = this.nodes.get(nodeId);
    if (!nodeObj) return;

    // Remove connected edges
    const connectedEdges = Array.from(this.edges.entries())
      .filter(([_, edge]) =>
        edge.sourceNode === nodeId || edge.targetNode === nodeId
      );

    connectedEdges.forEach(([edgeId]) => this.removeEdge(edgeId));

    // Remove node
    nodeObj.element.remove();
    this.nodes.delete(nodeId);

    this.dispatchEvent(new CustomEvent('node-removed', { detail: { nodeId } }));
  }

  /**
   * Select a node
   * @param {HTMLElement} node - The node element to select
   * @private
   */
  selectNode(node) {
    this.clearSelection();
    this.selectedElement = node;
    node.classList.add('selected');
    this.dispatchEvent(new CustomEvent('selection-changed', {
      detail: { selected: node, nodeId: node.dataset.nodeId }
    }));
  }

  // Edge Management
  startEdgeCreation(node, port, portId, portType, position) {
    this.currentEdge = {
      sourceNode: node,
      sourcePort: port,
      sourcePortId: portId,
      sourcePortType: portType,
      startPosition: position,
      element: this.createTemporaryEdge()
    };

    this.edgesLayer.appendChild(this.currentEdge.element);
  }

  createTemporaryEdge() {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('edge', 'temporary');
    return path;
  }

  updateTemporaryEdge(event) {
    if (!this.currentEdge) return;

    const rect = this.getBoundingClientRect();
    const endPos = {
      x: (event.clientX - rect.left - this.canvasOffset.x) / this.scale,
      y: (event.clientY - rect.top - this.canvasOffset.y) / this.scale
    };

    const pathData = this.calculateEdgePath(this.currentEdge.startPosition, endPos);
    this.currentEdge.element.setAttribute('d', pathData);

    // Update port hover states
    const allPorts = this.shadowRoot.querySelectorAll('.port');
    allPorts.forEach(port => {
      if (port === this.currentEdge.sourcePort) return;

      const portRect = port.getBoundingClientRect();
      const isHovering = event.clientX >= portRect.left && event.clientX <= portRect.right &&
        event.clientY >= portRect.top && event.clientY <= portRect.bottom;

      if (isHovering) {
        port.classList.add('hover');
      } else {
        port.classList.remove('hover');
      }
    });
  }

  finalizeEdge(event) {
    if (!this.currentEdge) return;

    // Find port under pointer - need to check inside shadow DOM
    let targetPort = null;

    // Get all ports and check if pointer is over them
    const allPorts = this.shadowRoot.querySelectorAll('.port');

    for (const port of allPorts) {
      if (port === this.currentEdge.sourcePort) continue;

      const rect = port.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom) {
        targetPort = port;
        break;
      }
    }

    if (targetPort) {
      const targetNode = targetPort.closest('.node');
      const targetPortId = targetPort.dataset.portId;
      const targetPortType = targetPort.classList.contains('output') ? 'output' : 'input';

      // Validate connection
      const sourceNodeId = this.currentEdge.sourceNode.dataset.nodeId;
      const targetNodeId = targetNode.dataset.nodeId;

      if (sourceNodeId !== targetNodeId) {
        // Check that we're connecting output to input
        const isValid = (this.currentEdge.sourcePortType === 'output' && targetPortType === 'input') ||
          (this.currentEdge.sourcePortType === 'input' && targetPortType === 'output');

        if (isValid) {
          // Determine which is output and which is input
          let outputNodeId, outputPortId, inputNodeId, inputPortId;

          if (this.currentEdge.sourcePortType === 'output') {
            outputNodeId = sourceNodeId;
            outputPortId = this.currentEdge.sourcePortId;
            inputNodeId = targetNodeId;
            inputPortId = targetPortId;
          } else {
            outputNodeId = targetNodeId;
            outputPortId = targetPortId;
            inputNodeId = sourceNodeId;
            inputPortId = this.currentEdge.sourcePortId;
          }

          this.addEdge(outputNodeId, inputNodeId, outputPortId, inputPortId);
        }
      }
    }

    // Cleanup
    this.currentEdge.element.remove();
    this.currentEdge = null;

    // Remove hover states
    this.shadowRoot.querySelectorAll('.port.hover').forEach(p => {
      p.classList.remove('hover');
    });
  }

  /**
   * Add an edge (connection) between two nodes
   * @param {string} sourceNodeId - Source node ID
   * @param {string} targetNodeId - Target node ID
   * @param {string} sourcePortId - Source port ID
   * @param {string} targetPortId - Target port ID
   * @returns {Object|null} The created edge data or null if failed
   * @fires GraphEditor#edge-added
   * 
   * @example
   * editor.addEdge('node1', 'node2', 'output', 'input');
   */
  addEdge(sourceNodeId, targetNodeId, sourcePortId, targetPortId) {
    // Check if edge already exists
    const existing = Array.from(this.edges.values()).find(edge =>
      edge.sourceNode === sourceNodeId &&
      edge.targetNode === targetNodeId &&
      edge.sourcePort === sourcePortId &&
      edge.targetPort === targetPortId
    );

    if (existing) {
      console.warn('Edge already exists');
      return null;
    }

    const edgeId = this.generateId('edge');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('edge');
    path.dataset.edgeId = edgeId;

    const edgeData = {
      sourceNode: sourceNodeId,
      targetNode: targetNodeId,
      sourcePort: sourcePortId,
      targetPort: targetPortId,
      element: path
    };

    this.edges.set(edgeId, edgeData);
    this.edgesLayer.appendChild(path);

    this.updateEdgePath(edgeData);

    path.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectEdge(edgeData);
    });

    this.dispatchEvent(new CustomEvent('edge-added', {
      detail: { edgeId, sourceNodeId, targetNodeId, sourcePortId, targetPortId }
    }));

    return edgeData;
  }

  updateEdgePath(edgeData) {
    const sourceNode = this.nodes.get(edgeData.sourceNode);
    const targetNode = this.nodes.get(edgeData.targetNode);

    if (!sourceNode || !targetNode) return;

    const sourcePort = sourceNode.element.querySelector(`[data-port-id="${edgeData.sourcePort}"]`);
    const targetPort = targetNode.element.querySelector(`[data-port-id="${edgeData.targetPort}"]`);

    if (!sourcePort || !targetPort) return;

    const startPos = this.getPortPosition(sourcePort);
    const endPos = this.getPortPosition(targetPort);

    const pathData = this.calculateEdgePath(startPos, endPos);
    edgeData.element.setAttribute('d', pathData);
  }

  calculateEdgePath(start, end) {
    switch (this.config.edgeStyle) {
      case 'straight':
        return `M ${start.x},${start.y} L ${end.x},${end.y}`;

      case 'step':
        const midX = (start.x + end.x) / 2;
        return `M ${start.x},${start.y} L ${midX},${start.y} L ${midX},${end.y} L ${end.x},${end.y}`;

      case 'bezier':
      default:
        const dx = Math.abs(end.x - start.x);
        const controlOffset = Math.min(dx * 0.5, 150);
        const cp1x = start.x + controlOffset;
        const cp1y = start.y;
        const cp2x = end.x - controlOffset;
        const cp2y = end.y;
        return `M ${start.x},${start.y} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${end.x},${end.y}`;
    }
  }

  updateConnectedEdges(node) {
    const nodeId = node.dataset.nodeId;

    this.edges.forEach(edge => {
      if (edge.sourceNode === nodeId || edge.targetNode === nodeId) {
        this.updateEdgePath(edge);
      }
    });
  }

  removeEdge(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    edge.element.remove();
    this.edges.delete(edgeId);

    this.dispatchEvent(new CustomEvent('edge-removed', {
      detail: {
        edgeId,
        sourceNodeId: edge.sourceNode,
        targetNodeId: edge.targetNode,
        sourcePortId: edge.sourcePort,
        targetPortId: edge.targetPort
      }
    }));
  }

  selectEdge(edgeData) {
    this.clearSelection();
    this.selectedElement = edgeData.element;
    edgeData.element.classList.add('selected');

    // Fire selection-changed event
    this.dispatchEvent(new CustomEvent('selection-changed', {
      detail: {
        selected: edgeData.element,
        type: 'edge',
        edgeId: edgeData.element.dataset.edgeId
      }
    }));
  }

  // Selection Management
  /**
   * Clear all selections (nodes and edges)
   * @fires GraphEditor#selection-changed
   */
  clearSelection() {
    // Clear all selected nodes
    this.shadowRoot.querySelectorAll('.node.selected').forEach(node => {
      node.classList.remove('selected');
    });

    // Clear all selected edges
    this.shadowRoot.querySelectorAll('.edge.selected').forEach(edge => {
      edge.classList.remove('selected');
    });

    this.selectedElement = null;

    // Fire selection-changed event
    this.dispatchEvent(new CustomEvent('selection-changed', {
      detail: { selected: null, count: 0 }
    }));
  }

  /**
   * Delete selected element(s)
   */
  deleteSelected() {
    // Check for multiple selected nodes
    const selectedNodes = this.shadowRoot.querySelectorAll('.node.selected');

    if (selectedNodes.length > 0) {
      // Delete all selected nodes
      selectedNodes.forEach(node => {
        const nodeId = node.dataset.nodeId;
        this.removeNode(nodeId);
      });
      this.selectedElement = null;
      return;
    }

    // Single element selection
    if (!this.selectedElement) return;

    if (this.selectedElement.classList.contains('node')) {
      const nodeId = this.selectedElement.dataset.nodeId;
      this.removeNode(nodeId);
    } else if (this.selectedElement.classList.contains('edge')) {
      const edgeId = this.selectedElement.dataset.edgeId;
      this.removeEdge(edgeId);
    }

    this.selectedElement = null;
  }

  // Utility
  generateId(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2)}`;
  }

  getCenter() {
    const rect = this.getBoundingClientRect();
    return {
      x: (rect.width / 2 - this.canvasOffset.x) / this.scale,
      y: (rect.height / 2 - this.canvasOffset.y) / this.scale
    };
  }

  // Public API
  /**
   * Update the editor configuration
   * @param {Object} config - Configuration options
   * @param {number} [config.snapRadius] - Port snap radius in pixels
   * @param {number} [config.gridSize] - Grid cell size
   * @param {boolean} [config.showGrid] - Show/hide grid
   * @param {string} [config.edgeStyle] - Edge style: 'bezier', 'straight', or 'step'
   * @param {string} [config.theme] - Theme: 'dark' or 'light'
   * @param {number} [config.zoomSpeed] - Zoom sensitivity
   * @param {number} [config.minZoom] - Minimum zoom level
   * @param {number} [config.maxZoom] - Maximum zoom level
   * @param {boolean} [config.zoomToMouse] - Zoom to cursor vs canvas center
   * @param {boolean} [config.enableKeyboardShortcuts] - Enable keyboard shortcuts
   * @param {string} [config.nodeLayout] - Node layout: 'classic' or 'modern'
   * 
   * @example
   * editor.setConfig({
   *   gridSize: 25,
   *   showGrid: true,
   *   zoomToMouse: true,
   *   enableKeyboardShortcuts: true,
   *   nodeLayout: 'modern'
   * });
   */
  setConfig(config) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...config };

    // Handle grid visibility change
    if ('showGrid' in config && config.showGrid !== oldConfig.showGrid) {
      if (config.showGrid) {
        this.drawGrid();
      } else {
        // Clear grid
        const ctx = this.gridCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
      }
    }

    // Redraw grid if size changed
    if ('gridSize' in config && config.gridSize !== oldConfig.gridSize && this.config.showGrid) {
      this.drawGrid();
    }

    // Handle layout change
    if ('nodeLayout' in config && config.nodeLayout !== oldConfig.nodeLayout) {
      this.shadowRoot.host.setAttribute('data-layout', config.nodeLayout);
    }

    // Re-setup event listeners if keyboard shortcuts setting changed
    if ('enableKeyboardShortcuts' in config &&
      config.enableKeyboardShortcuts !== oldConfig.enableKeyboardShortcuts) {
      // Event listeners are document-level, so we need to track the state
      // The setupKeyboardShortcuts method checks this.config.enableKeyboardShortcuts
    }
  }

  /**
   * Apply a custom stylesheet as a string
   * @param {string} css - CSS stylesheet content
   * 
   * @example
   * editor.setStylesheet(`
   *   :host { --edge-color: #ff0000; }
   *   .node .title { color: gold; }
   * `);
   */
  setStylesheet(css) {
    // Remove any existing custom stylesheet
    const existing = this.shadowRoot.querySelector('style.custom-stylesheet');
    if (existing) {
      existing.remove();
    }

    // Add new stylesheet
    const styleElement = document.createElement('style');
    styleElement.className = 'custom-stylesheet';
    styleElement.textContent = css;
    this.shadowRoot.appendChild(styleElement);
  }

  /**
   * Load a stylesheet from an external URL
   * @param {string} url - URL to the CSS file
   * @returns {Promise<void>} Resolves when stylesheet is loaded
   * 
   * @example
   * await editor.loadStylesheetFromURL('themes/cyberpunk.css');
   */
  loadStylesheetFromURL(url) {
    return new Promise((resolve, reject) => {
      const existing = this.shadowRoot.querySelector('link.custom-stylesheet');
      if (existing) {
        existing.remove();
      }

      const link = document.createElement('link');
      link.className = 'custom-stylesheet';
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load stylesheet: ${url}`));
      this.shadowRoot.appendChild(link);
    });
  }

  /**
   * Get all nodes in the graph
   * @returns {Array<{id: string, element: HTMLElement, data: Object}>} Array of node objects
   */
  getNodes() {
    return Array.from(this.nodes.entries()).map(([id, node]) => ({
      id,
      element: node.element,
      data: node.data
    }));
  }

  /**
   * Get all edges in the graph
   * @returns {Array<{id: string, sourceNode: string, targetNode: string, sourcePort: string, targetPort: string, element: SVGPathElement}>}
   */
  getEdges() {
    return Array.from(this.edges.entries()).map(([id, edge]) => ({
      id,
      ...edge
    }));
  }

  /**
   * Export the graph to JSON
   * @returns {{nodes: Array, edges: Array}} Graph data
   * 
   * @example
   * const data = editor.exportGraph();
   * localStorage.setItem('my-graph', JSON.stringify(data));
   */
  exportGraph() {
    const nodes = Array.from(this.nodes.entries()).map(([id, node]) => ({
      id,
      ...node.data,
      position: this.getNodePosition(node.element)
    }));

    const edges = Array.from(this.edges.entries()).map(([id, edge]) => ({
      id,
      source: edge.sourceNode,
      target: edge.targetNode,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort
    }));

    return { nodes, edges };
  }

  /**
   * Import a graph from JSON
   * @param {{nodes: Array, edges: Array}} data - Graph data from exportGraph()
   * 
   * @example
   * const data = JSON.parse(localStorage.getItem('my-graph'));
   * editor.importGraph(data);
   */
  importGraph(data) {
    this.clearGraph();

    data.nodes.forEach(nodeData => this.addNode(nodeData));
    data.edges.forEach(edgeData =>
      this.addEdge(edgeData.source, edgeData.target, edgeData.sourcePort, edgeData.targetPort)
    );
  }

  /**
   * Clear all nodes and edges from the graph
   */
  clearGraph() {
    Array.from(this.nodes.keys()).forEach(id => this.removeNode(id));
    Array.from(this.edges.keys()).forEach(id => this.removeEdge(id));
  }

  /**
   * Reset view to center with 100% zoom
   */
  centerView() {
    this.canvasOffset = { x: 0, y: 0 };
    this.scale = 1;
    this.updateCanvasPosition();
  }

  /**
   * Fit all nodes in the viewport
   */
  fitToView() {
    if (this.nodes.size === 0) {
      this.centerView();
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    this.nodes.forEach(node => {
      const pos = this.getNodePosition(node.element);
      const rect = node.element.getBoundingClientRect();
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + rect.width / this.scale);
      maxY = Math.max(maxY, pos.y + rect.height / this.scale);
    });

    const padding = 50;
    const graphWidth = maxX - minX + padding * 2;
    const graphHeight = maxY - minY + padding * 2;

    const rect = this.getBoundingClientRect();
    const scaleX = rect.width / graphWidth;
    const scaleY = rect.height / graphHeight;

    this.scale = Math.min(scaleX, scaleY, 1);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    this.canvasOffset.x = rect.width / 2 - centerX * this.scale;
    this.canvasOffset.y = rect.height / 2 - centerY * this.scale;

    this.updateCanvasPosition();
  }

  // Helper methods for updating node content
  /**
   * Update a node's display content
   * @param {string} nodeId - Node ID
   * @param {string} content - HTML content
   * 
   * @example
   * editor.updateNodeContent('node-1', '<div>New content</div>');
   */
  updateNodeContent(nodeId, content) {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Display element always exists now
    const display = node.element.querySelector('.display');
    if (display) {
      display.innerHTML = content || '';
    }
  }

  /**
   * Update a node's title
   * @param {string} nodeId - Node ID
   * @param {string} title - New title text
   * 
   * @example
   * editor.updateNodeTitle('node-1', 'Updated Title');
   */
  updateNodeTitle(nodeId, title) {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const titleEl = node.element.querySelector('.title');
    if (titleEl) {
      titleEl.textContent = title;
    }
  }

  /**
   * Get node data by ID
   * @param {string} nodeId - Node ID
   * @returns {Object|null} Node data with current position
   */
  getNodeData(nodeId) {
    const node = this.nodes.get(nodeId);
    return node ? {
      ...node.data,
      position: this.getNodePosition(node.element)
    } : null;
  }
}

customElements.define('graph-editor', GraphEditor);