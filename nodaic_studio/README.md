# Nodaic Studio

The official visual modeling canvas and runtime orchestration platform for the Nodaic ecosystem.

Nodaic Studio allows engineers and automation architects to visually compose reactive graphs, inspect runtime execution in real time, edit Node Definition Language (`.ndl`) code with instant bidirectional AST synchronization, and manage distributed runtimes.

---

## 🎨 Design Philosophy & Features

Nodaic Studio is built as a zero-dependency, ultra-fast web application using modern vanilla HTML5, CSS3, and ES6 modules.

- **Visual Graph Modeler**: Interactive graph canvas with zoom, pan, port snapping, bezier wiring, and real-time node state visualizers.
- **Modeler Theme**: Signature `#FF6B35` branding, dark/light contrast aesthetics, and custom typography (Inter + IBM Plex Mono).
- **Dual-Mode NDL Editor**: Seamlessly switch between the visual graph canvas and declarative NDL code with instantaneous bidirectional synchronization.
- **3-Tier Hybrid Observability**:
  1. **Canvas Graphics**: Live node glow states (`running`, `done`, `failed`), animated wiring pulses, and error badges.
  2. **DevTools Console**: Granular event logs, filterable by log level (`info`, `warn`, `error`, `system`) and timestamp.
  3. **Interactive REST Terminal**: Built-in command terminal (`rest-terminal.js`) for executing raw RPC actions, querying runtime manifests, and testing endpoints.
- **Multi-Runtime Orchestration**:
  - Connects to any Nodaic-compliant runtime (Node.js, Cloudflare Workers, Python, ESP32 MCU) via capability manifests (`GET /manifest`).
  - Auto-adapts UI controls based on what the connected runtime supports (e.g., hiding role management if unsupported).
- **Secrets & Token Management**:
  - Configure encrypted secrets with masked displays.
  - Generate and inspect stateless HMAC role tokens (`admin`, `dev`, `ops`, `viewer`, `device`).

---

## 🏗️ Studio File Structure

```text
nodaic_studio/
├── index.html                 # Main studio entry point
├── studio.html                # Alternative direct studio mount
├── 404.html                   # Not found fallback
├── studio_spec.md             # Complete v5 Studio architecture specification
├── nodiac_runtime_guide.md    # Integration and deployment guide
├── styles/
│   └── studio.css             # Comprehensive Modeler design system
├── scripts/
│   ├── studio-app.js          # Core studio application state & lifecycle manager
│   ├── studio-ui.js           # DOM renderer, inspector drawer & modal dialogs
│   ├── rest-terminal.js       # Embedded interactive REST & RPC terminal
│   ├── observable.js          # Reactive path-based state store
│   └── nodaic-clicore.js      # Client command parsing & execution core
├── images/                    # Modeler SVG icons and branding assets
└── fonts/                     # Bundled icon & monospace fonts
```

---

## 🚀 Running Nodaic Studio

Because Nodaic Studio is purely static with zero build steps or heavy node dependencies, you can serve it with any standard HTTP server:

### Option 1: Using `npx serve` (Recommended)
```bash
# Serve studio on port 3000
npx serve nodaic_studio -l 3000
```

### Option 2: Using Python
```bash
cd nodaic_studio
python3 -m http.server 3000
```

### Option 3: Using Node `http-server`
```bash
npx http-server nodaic_studio -p 3000 -c-1
```

Once running, navigate to `http://localhost:3000` in your web browser.

---

## 🔌 Connecting to a Runtime

1. Start your Nodaic Node.js runtime (default: `http://localhost:3030`).
2. Copy the **Bootstrap Admin Token** output in your terminal.
3. In Nodaic Studio, click the **Runtime Pill** in the top navigation bar (or click **Connect Runtime**).
4. Enter `http://localhost:3030` and paste your Admin Token.
5. Studio will automatically interrogate the runtime's `/manifest` endpoint, establish a real-time WebSocket connection to `ws://localhost:3030/nodaic/v1/ws`, and synchronize your graphs, secrets, and triggers.

---

## 🗺️ Studio Roadmap

- [x] High-performance visual canvas with bezier wiring and reactive state rendering.
- [x] Dual-mode NDL editor with real-time bidirectional AST parser synchronization.
- [x] 3-Tier Observability (Canvas + DevTools Console + REST Terminal).
- [x] Runtime capability manifest interrogation and auto-adaptive UI panels.
- [ ] **Real-Time Collaboration**: Multi-user live cursor sharing and concurrent graph editing backed by CRDTs.
- [ ] **Time-Travel Visual Debugger**: Step forward and backward through graph execution history with full node state snapshots.
- [ ] **Node Marketplace & Template Gallery**: One-click import of pre-built workflow templates and community node bundles.
- [ ] **Electron / Tauri Desktop App**: Self-contained native desktop app with embedded local runtime.
