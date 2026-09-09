# Nodaic Node.js Runtime: Studio Integration Guide

The Nodaic Runtime provides a unified, action-driven interface for running event-based automation and declarative NDL graphs. This guide covers the complete architecture, API surface, and operational workflows for connecting Nodaic Studio to the runtime.

---

## 🏗️ 1. Architecture Overview

The runtime is composed of three internal layers:

1. **The Engine (`nodaic_minimal.js`)**: Handles the execution of JS Processes, Nodes, and NDL Graphs with cycle detection and sandboxing.
2. **The Scheduler (`nodaic_scheduler.js`)**: Manages event-artifact bindings and trigger dispatch.
3. **The Surface (`runtime.js`)**: Exposes REST and WebSocket endpoints, validates HMAC tokens, and enforces RBAC and network perimeter policies.
4. **Storage Layer (`library/nodaic.db`)**: Persistent SQLite database operating in WAL mode with busy timeout handling, storing artifacts, bindings, principals, and the unified `variables` table.

---

## 🔐 2. Authentication & Stateless Tokens

Nodaic uses stateless HMAC tokens for authentication:

### The Token Format
Tokens are formatted either as 128-byte hexadecimal strings or compact representations:
```text
<role>:<keyId>.<expiryTimestamp>.<hmacSignature>
```
- Signed using HMAC-SHA256 against the runtime's `NODAIC_MASTER_SECRET`.
- Validated in constant time without database lookups.
- Globally revocable via token epoch increments.

### Bootstrap Admin Token
When booted on an unconfigured system, the runtime outputs a valid **Bootstrap Admin Token** to the console. Copy this token to authenticate from Nodaic Studio.

### Roles & Access Hierarchy
- **`admin`**: Full administrative control (create/revoke tokens, edit all artifacts, access secrets).
- **`dev`**: Developer access (push artifacts, manage bindings, run executions).
- **`ops`**: Operational management (monitor runs, view logs).
- **`device`**: Machine-to-machine trigger dispatch and execution.
- **`viewer`**: Read-only inspection of library and logs.

---

## 📡 3. The Unified API Surface

The runtime provides a central endpoint for RPC logic alongside direct REST endpoints for Studio compatibility:

- **HTTP POST RPC**: `http://localhost:3030/nodaic/v1/`
- **WebSocket Stream**: `ws://localhost:3030/nodaic/v1/ws`
- **Capability Manifest**: `GET http://localhost:3030/manifest`

### RPC Request Shape
Every RPC request is a JSON object:
```json
{
  "action": "namespace.operation",
  "token": "<role-token>",
  "payload": { ... }
}
```

---

## 📋 4. Action Reference

### Auth Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `auth.keys.create` | `{ "role": "...", "scope": { "events": [], "artifacts": [] } }` | Mint a new role token. |
| `auth.keys.revoke` | `{ "keyId": "..." }` | Invalidate a key ID. |

### Library Namespace (Artifact CRUD)
| Action | Payload | Description |
| :--- | :--- | :--- |
| `library.list` | `{}` | List IDs, versions, and types of all artifacts. |
| `library.get` | `{ "id": "...", "version": "latest" }` | Get the full artifact JSON definition. |
| `library.push` | `{ "artifact": { ... } }` | Save an artifact to the persistent SQLite database. |
| `library.remove` | `{ "id": "..." }` | Delete an artifact from disk and library. |

### Execution Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `run.start` | `{ "artifactId": "...", "input": {}, "state": {} }` | Begin execution. Streams events via NDJSON/WebSocket. |
| `run.list` | `{}` | List current active run IDs. |
| `run.cancel` | `{ "runId": "..." }` | Terminate an active execution. |

### Trigger Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `trigger.emit` | `{ "event": "...", "data": {} }` | Emit a scheduler event manually. |
| `trigger.bind` | `{ "event": "...", "artifactId": "..." }` | Bind an event to an artifact in SQLite. |
| `trigger.unbind`| `{ "event": "...", "artifactId": "..." }` | Remove an event-artifact binding. |
| `trigger.list` | `{}` | List all current event bindings. |

### Secrets & Variables Namespace
| Action | Payload | Description |
| :--- | :--- | :--- |
| `secret.set` | `{ "key": "...", "value": "..." }` | Encrypt and store secret in unified DB. |
| `secret.get` | `{ "key": "..." }` | Get secret metadata (value masked). |
| `secret.reveal`| `{ "key": "..." }` | Reveal plaintext secret (requires elevated session). |
| `secret.list` | `{}` | List all stored secrets (masked). |
| `variable.set` | `{ "namespace": "...", "key": "...", "value": ..., "roles": [...] }` | Store variable with row-level RBAC. |
| `variable.get` | `{ "namespace": "...", "key": "..." }` | Retrieve variable if permitted by RBAC. |
| `variable.list`| `{ "namespace": "..." }` | List accessible variables. |

---

## 🧊 5. Artifact Structure (JSON)

When using `library.push`, the artifact conforms to this schema:

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

## 🌊 6. Real-time Streaming & Telemetry

For actions like `run.start` and trigger dispatches, the WebSocket stream broadcasts:

1. `run.start`: Execution initialized with assigned `runId`.
2. `run.node`: Node execution completed (in graph workflows).
3. `run.done`: Final output and ending state.
4. `run.error`: Error envelope if a node throws or times out.
