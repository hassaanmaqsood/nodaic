# Nodaic Runtime (NodeJS)

A production-ready, minimal implementation of the Nodaic engine for automation in Node.js environments. The runtime provides a unified action-driven interface over both HTTP and WebSockets.

---

## 🏗️ Architecture & How It Works

The Nodaic Runtime is built on three core pillars:

1.  **`nodaic_minimal.js` (The Engine)**: The heart of the system. It handles the instantiation of artifacts and manages the computation logic for Processes, Nodes, and Graphs.
2.  **`nodaic_scheduler.js` (The Orchestrator)**: Manages event-driven execution. It maintains bindings between events and artifacts, handling concurrency and data flow.
3.  **`runtime.js` (The Surface)**: The API layer. It provides a unified communication surface, handles HMAC-based authentication, and dispatches actions to the scheduler and engine.

### How it "Does Stuff":
-   **Artifacts**: Everything is an artifact (a JS Process, a Node, or an NDL Graph).
-   **Library**: Artifacts are stored in the library. Core artifacts live in `artifacts/core/`, and user-defined ones in `artifacts/user/`.
-   **Execution**: When an action is dispatched (e.g., `run.start`), the scheduler finds the artifact, prepares the state (including `_emit`), and executes it.
-   **Event Loop**: Artifacts can emit events via `state._emit(event, data)`, which the scheduler captures and uses to trigger further bound artifacts, creating complex, reactive pipelines.

---

## 📡 Communication (Single Endpoint Design)

The runtime uses a protocol-agnostic communication model where everything is an **action**.

### 🔐 Unified Authentication (HMAC)

Security is handled via HMAC-derived tokens. Tokens are passed in the request body for HTTP or as part of the initial message for WebSockets.

-   **Token Shape**: `keyId.hash`
-   **Derivation**: `hash = HMAC_SHA256(signing_key, "api" + keyId)`
-   **Authorization**: Each key is mapped to a `role` (viewer, runner, editor, admin) and a `scope` (glob patterns for artifacts and events).

### 🛠️ Transports

#### HTTP
-   `GET  /nodaic/v1/`: Health check.
-   `POST /nodaic/v1/`: Central endpoint for all operations.
-   `GET|POST /trigger/:event`: Dumb forwarder for external webhooks. Translates request to `trigger.emit`.

#### WebSocket
-   `WS /nodaic/v1/ws`: Same action-driven interface but with native two-way streaming.

---

## 📋 Action Surface

All requests follow this shape:
```json
{
  "action": "namespace.operation",
  "token": "...",
  "payload": { ... }
}
```

### Supported Actions:

| Namespace | Action | Description |
| :--- | :--- | :--- |
| **Auth** | `auth.keys.create` | Create a new HMAC key (Admin only). |
| | `auth.keys.revoke` | Revoke an existing key (Admin only). |
| **Library** | `library.list` | List all artifacts in the library. |
| | `library.get` | Fetch a specific artifact definition. |
| | `library.push` | Register/Update an artifact. |
| | `library.remove` | Delete an artifact. |
| **Execution**| `run.start` | Start a specific artifact run. |
| | `run.list` | List currently active runs. |
| | `run.cancel` | Terminate a running execution. |
| **Trigger** | `trigger.emit` | Manually emit a scheduler event. |
| | `trigger.bind` | Bind an event to an artifact. |
| | `trigger.unbind`| Remove an event-to-artifact binding. |
| | `trigger.list` | List all current bindings. |
| **Runtime** | `runtime.status` | Get system status, uptime, and active stats. |

---

## 🔌 Real-time Streaming

When using WebSockets or the HTTP endpoint for streaming actions (like `run.start`), the runtime sends events back as they happen:

```json
// WebSocket receive or HTTP NDJSON line
{ "event": "run.started", "runId": "run_123" }
{ "event": "run.node", "runId": "run_123", "nodeId": "step1", "output": { ... } }
{ "event": "run.done", "runId": "run_123", "output": { ... } }
```

---

## 🛠️ Getting Started

1.  **Boot**: Run `node runtime.js`.
2.  **Admin Key**: On the first run, check the console logs for the auto-generated **Bootstrap Admin Token**.
3.  **Configure**: Use `CONFIG.signingKey` in `runtime.js` or `NODAIC_SIGNING_KEY` env var to set your master secret.

---

## ⚡ Deployment Note
The runtime is designed for high-concurrency environments. Use `trigger.bind` to build self-healing, event-driven automation pipelines that persist across restarts via `bindings.json`.
