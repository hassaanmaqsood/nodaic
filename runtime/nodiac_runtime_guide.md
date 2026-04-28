# Nodaic NodeJS Runtime: The Complete Guide

The Nodaic Runtime is a unified, action-driven interface for running event-based automation. This guide covers the complete architecture, API surface, and operational workflows.

---

## 🏗️ 1. Architecture Overview

The runtime is composed of three internal layers:

1.  **The Engine (`nodaic_minimal.js`)**: Handles the execution of JS Processes, Nodes, and NDL Graphs.
2.  **The Scheduler (`nodaic_scheduler.js`)**: Manages the "Wiring." It binds events to artifacts and manages the execution flow across the system.
3.  **The Surface (`runtime.js`)**: Provides the API. It listens for HTTP and WebSocket requests, validates HMAC tokens, and dispatches actions to the scheduler.

---

## 🔐 2. Authentication & Keys

Nodaic uses **HMAC API Tokens** for every request.

### The Token Format
A token consists of two parts separated by a dot: `keyId.hash`.
- `keyId`: The identifier found in `keys.json`.
- `hash`: An HMAC-SHA256 signature of the string `"api" + keyId`, signed with the server's master `NODAIC_SIGNING_KEY`.

### Bootstrap Admin Token
On the very first run (if `keys.json` is missing), the runtime generates a unique Admin Key ID and outputs a valid **Bootstrap Admin Token** to the console. **Save this token immediately.**

### Roles & Scopes
Every key has a **Role** and a **Scope**:
- **Admin**: Full access. Bypasses all scope checks.
- **Editor**: Can push/remove artifacts and manage bindings.
- **Runner**: Can execute artifacts (`run.start`) and emit events.
- **Scope**: Limits `runner` and `editor` to specific artifact IDs (e.g., `["user/*"]`) or event names (e.g., `["stripe.*"]`).

---

## 📡 3. The Unified API Surface

The runtime provides a single central endpoint for all logic.

- **HTTP POST**: `http://localhost:3030/nodaic/v1/`
- **WebSocket**: `ws://localhost:3030/nodaic/v1/ws`

### Request Shape
Every request is a JSON object with these fields:
```json
{
  "action": "namespace.operation",
  "token": "keyId.hash",
  "payload": { ... }
}
```

---

## 📋 4. Action Reference

### Auth Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `auth.keys.create` | `{ "role": "...", "scope": { "events": [], "artifacts": [] } }` | Create a new key. |
| `auth.keys.revoke` | `{ "keyId": "..." }` | Delete a key. |

### Library Namespace (Artifact CRUD)
| Action | Payload | Description |
| :--- | :--- | :--- |
| `library.list` | `{}` | List IDs, versions, and types of all artifacts. |
| `library.get` | `{ "id": "...", "version": "latest" }` | Get the full artifact JSON definition. |
| `library.push` | `{ "artifact": { ... } }` | Save an artifact. It is written to `artifacts/user/`. |
| `library.remove` | `{ "id": "..." }` | Delete an artifact from disk and library. |

### Execution Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `run.start` | `{ "artifactId": "...", "input": {}, "state": {} }` | Begin execution. Returns an NDJSON stream. |
| `run.list` | `{}` | List current active `runId`s. |
| `run.cancel` | `{ "runId": "..." }` | Kill an active execution. |

### Trigger Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `trigger.emit` | `{ "event": "...", "data": {} }` | Emit a scheduler event manually. |
| `trigger.bind` | `{ "event": "...", "artifactId": "..." }` | Create a permanent binding. Saved to `bindings.json`. |
| `trigger.unbind`| `{ "event": "...", "artifactId": "..." }` | Remove a binding. |
| `trigger.list` | `{}` | List all current event-artifact bindings. |

---

## 🧊 5. Artifact Structure (JSON)

When using `library.push`, the artifact must follow this structure:

```json
{
  "id": "user/hello_world",
  "version": "1.0.0",
  "artifactType": "process",
  "sourceType": "text/javascript",
  "source": "returnCallback({ output: `Hello, ${input.name}!`, state });",
  "metadata": { "author": "dev" },
  "interface": { "input": { "name": "string" } }
}
```

---

## 🌊 6. Real-time Streaming (NDJSON)

For actions like `run.start` and `trigger.emit`, the server responds with `application/x-ndjson`. Each line is a JSON event representing the progress:

1. `run.started`: The execution has begun.
2. `run.node`: (Graph only) A specific node has finished execution.
3. `run.done`: Final output and ending state.
4. `error`: If something went wrong.

---

## 🛠️ 7. CLI Client: `nodaic-admin.js`

To make interaction easier, use the provided CLI tool. It automates token inclusion and payload formatting.

**Setup**:
```bash
export NODAIC_ADMIN_TOKEN="your.token"
alias nodaic="node nodaic-admin.js"
```

**Common Tasks**:
- Check Health: `nodaic status`
- List Artifacts: `nodaic ls`
- Start an automation: `nodaic run user/demo '{"id": 123}'`
- Bind a webhook: `nodaic bind stripe.invoice.paid user/billing_handler`
