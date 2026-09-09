# Nodaic Node.js Runtime

The official Node.js execution runtime for the Nodaic engine and Nodaic Studio. This runtime provides a secure, self-healing execution environment for running Nodaic Process and Graph artifacts, handling event-driven schedules, persisting state, and serving REST/WebSocket APIs with granular HMAC-based role authentication.

---

## 🏗️ 1. Architecture Overview

The runtime is structured into decoupled, resilient modules:

```text
runtimes/node/
├── runtime.js             # Supervisor, HTTP REST & WebSocket API server
├── runtime.config.json    # Runtime configuration & key revocation registry
├── runtime_spec.md        # Wire protocol & Studio compatibility specification
├── engine/
│   ├── nodaic_minimal.js  # Process/Graph execution engine (timeouts, sandboxing)
│   └── nodaic_scheduler.js# Event-driven scheduler & trigger orchestrator
├── helpers/
│   ├── storage.js         # SQLite DatabasePipeline, BlobPipeline & IO abstractions
│   └── token.js           # Stateless HMAC-SHA256 token minting & validation
└── library/
    ├── index.js           # Pre-bundled standard library (math, logic, utilities)
    ├── state_process.js   # StateNode workflow persistence & namespace gatekeeper
    └── nodaic.db          # Unified SQLite database (WAL mode, busy timeout)
```

### Core Components:
1. **Supervisor & Live Reload (`runtime.js`)**: Runs a worker sub-process (`child_process.fork`). Watches all `.js` files recursively and automatically hot-reloads the runtime with debouncing and safe database handle teardown.
2. **Resilient Port Listener**: If the configured port is already bound (`EADDRINUSE`), the runtime dynamically searches up to 100 subsequent ports without crashing.
3. **Engine Core (`engine/`)**: 
   - `nodaic_minimal.js`: Manages synchronous and asynchronous execution of JavaScript process nodes and declarative graph workflows with cycle detection.
   - `nodaic_scheduler.js`: Dispatches incoming events to bound graph/process artifacts.
4. **Unified SQLite Storage Layer (`library/nodaic.db`)**: 
   - Uses `better-sqlite3` in **WAL (Write-Ahead Logging)** mode with busy timeouts to support concurrent readers and writers without `SQLITE_BUSY` contention.
   - Houses artifacts, event bindings, authorization principals, and a **single unified `variables` table**.
5. **Standard Node Library (`library/index.js`)**: Static registry of built-in math and utility nodes (`add`, `subtract`, `multiply`, `divide`, `clamp`, `cos`, `sin`, `round`, `towards`, `step`, etc.).

---

## 🗄️ 2. Unified Database Architecture (`variables`)

All state, global secrets, and general variables are consolidated into a **single unified table** within `library/nodaic.db`:

```sql
CREATE TABLE IF NOT EXISTS variables (
    namespace   TEXT NOT NULL DEFAULT 'default',
    key         TEXT NOT NULL,
    value       TEXT,                           -- Plaintext value or AES-256-GCM cipher
    type        TEXT NOT NULL DEFAULT 'state',  -- 'state', 'secret', 'variable', etc.
    encrypted   INTEGER NOT NULL DEFAULT 0,     -- 1 if encrypted with masterSecret
    roles_json  TEXT,                           -- Allowed roles: e.g. '["admin"]', '["*"]'
    owner_id    TEXT NOT NULL DEFAULT 'local',
    meta_json   TEXT,                           -- Metadata, description, hint
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_vars_type ON variables(type);
CREATE INDEX IF NOT EXISTS idx_vars_ns ON variables(namespace);
```

### Internal State Isolation (`StateNode`)
- **No HTTP `/state` Endpoints**: State is strictly internal for workflows. There are zero public REST endpoints for reading or mutating state from the outside.
- **Workflow State Management**: Workflows read, write, and observe state exclusively through the `StateNode` (`library/state_process.js`).
- **Namespace Gates**: The built-in namespaces `secrets` and `system` are strictly protected by namespace gates. Any workflow attempting to read or write to `namespace: 'secrets'` or `namespace: 'system'` via `StateNode` is rejected with an access violation.

### Row-Level Role-Based Access Control (RBAC)
General variables (`type = 'variable'`) support row-level permissions via `roles_json`:
- `roles_json = '["admin"]'`: Only tokens with the `admin` role or elevated privileges can read or modify.
- `roles_json = '["*"]'`: Readable by any authenticated role (including `device`, `dev`, `ops`, `viewer`).
- `roles_json = '["dev", "ops"]'`: Restricted to specific operational roles.

---

## 🔐 3. Security & Authentication Model

### Master Secret
The cryptographic root secret is loaded exclusively from environment variables:
- `NODAIC_MASTER_SECRET` or `NODAIC_APP_SECRET`
*(The secret is never written to disk or configuration files).*

### Stateless HMAC Tokens
Tokens are 128-byte hexadecimal strings or compact representations formatted as:
```text
<role>:<keyId>.<expiryTimestamp>.<hmacSignature>
```
- **Verification**: Evaluated using HMAC-SHA256 in constant time against the master secret. No database lookup required.
- **Roles & Scopes**:
  - `admin`: Full administrative control (key creation, revocation, configuration, artifact deletion).
  - `dev`: Development and testing permissions.
  - `ops`: Operational management and monitoring.
  - `billing`: Restricted to billing/account-related actions.
  - `viewer`: Read-only access to library, logs, and telemetry.
  - `device`: Machine-to-machine execution and event emission.

### Token Revocation
- **Global Epoch Invalidation**: Incrementing the `epoch` setting immediately invalidates all tokens minted under prior epochs.
- **Granular Key Invalidation**: Specific `keyId` strings can be added to `revokedKeys` in `runtime.config.json`.

---

## 🌐 4. Network Perimeter & Wildcard Access Control

The runtime includes perimeter security enforcing origin CORS and client IP restrictions:

### Allowed Origins & Domain Wildcards (`NODAIC_ALLOWED_ORIGINS`)
Supports flexible wildcards for domain names and ports:
- `https://*.example.com:*`: Allows any subdomain of `example.com` on any HTTPS port.
- `http://192.168.1.*:*`: Allows any local LAN IP origin.
- `*`: Allows all origins.

### Allowed Client IPs & CIDR Subnets (`NODAIC_ALLOWED_IPS`)
Restricts incoming HTTP requests and WebSocket handshakes by client IP:
- **Exact IPs**: `127.0.0.1, 10.0.0.1`
- **Octet Wildcards**: `192.168.*.*, 10.0.*.15`
- **CIDR Subnet Notation**: `192.168.1.0/24, 10.0.0.0/8, 172.16.0.0/12`
- **IPv6 Normalization**: Automatically normalizes IPv4-mapped IPv6 addresses (`::ffff:192.168.1.1` -> `192.168.1.1`) and IPv6 loopbacks (`::1` -> `127.0.0.1`).

Requests from unauthorized IPs are rejected with `403 Forbidden`.

---

## 📡 5. API & Communication Protocols

### Unified RPC Endpoint
- **HTTP POST**: `http://localhost:<port>/nodaic/v1/`
- **Request Format**:
  ```json
  {
    "action": "run.start",
    "token": "<role-token>",
    "payload": {
      "artifactId": "math/add",
      "input": { "a": 5, "b": 10 }
    }
  }
  ```

### RPC Actions Reference
| Action | Roles | Description |
| :--- | :--- | :--- |
| `run.start` | device, dev, admin | Start asynchronous execution of an artifact |
| `run.list` | viewer, dev, admin | List active execution run IDs |
| `run.cancel` | dev, admin | Cancel an in-progress execution |
| `library.list` | any | List registered artifacts and versions |
| `library.get` | any | Retrieve full artifact definition |
| `library.push` | dev, admin | Register or update an artifact |
| `library.remove` | admin | Delete an artifact |
| `secret.set` | dev, admin | Encrypt and store secret in unified DB (`namespace='secrets'`) |
| `secret.get` | dev, admin | Retrieve secret metadata (masked value) |
| `secret.reveal`| elevated admin | Reveal plaintext secret value |
| `secret.list` | dev, admin | List all stored secrets (masked) |
| `secret.delete`| dev, admin | Remove secret from DB |
| `variable.set` | dev, ops, admin | Store variable with namespace and `roles_json` RBAC |
| `variable.get` | role-gated | Retrieve variable (checks row-level `roles_json`) |
| `variable.list`| any | List variables accessible to caller's role |
| `variable.delete`| role-gated | Delete variable (checks row-level `roles_json`) |
| `trigger.emit` | device, admin | Emit scheduler event |
| `trigger.bind` | dev, admin | Bind event name to an artifact |
| `trigger.unbind`| dev, admin | Unbind event from artifact |
| `trigger.list` | any | List active event bindings |
| `auth.keys.create`| admin | Generate a new HMAC role token |
| `auth.keys.revoke`| admin | Revoke a key ID |

### Direct REST Endpoints
| Endpoint | Method | Role | Description |
| :--- | :--- | :--- | :--- |
| `/manifest` | `GET` | *Public* | Reports capability manifest & transport info |
| `/library` | `GET` | Any | Lists available graphs & artifacts |
| `/library/:id` | `GET` | Any | Retrieves artifact definition and interface |
| `/library` | `POST` | Dev / Admin | Registers or updates an artifact |
| `/library/:id` | `DELETE`| Admin | Deletes an artifact |
| `/secrets` | `GET` | Any | Lists all secrets (masked values: `●●●●●●●●`) |
| `/secrets/:key/reveal` | `POST` | Elevated Admin | Reveals unmasked plaintext secret value |
| `/secrets/:key` | `PUT` | Dev / Admin | Stores or updates an encrypted secret in DB |
| `/secrets/:key` | `DELETE`| Dev / Admin | Deletes secret from DB |
| `/run/:id` | `POST` | Device / Admin | Executes an artifact directly |
| `/trigger/:event` | `ALL` | Device / Admin | Dispatches an event to the scheduler |
| `/trigger/sync/:event` | `ALL` | Device / Admin | Synchronously executes bound artifact and returns output |
| `/trigger/async/:event` | `ALL` | Device / Admin | Queues event asynchronously (`202 Accepted`) |
| `/logs` | `GET` | Viewer+ | Polls circular log buffer |
| `/whoami` | `GET` | Any | Inspects the caller's verified role and key ID |

### WebSocket Real-time Stream
- **Endpoint**: `ws://localhost:<port>/nodaic/v1/ws`
- Multiplexes execution heartbeats, live logs, and run status updates (`run.start`, `run.progress`, `run.done`, `run.error`).

---

## 🔒 6. NDL State Injection

When an NDL graph defines node state using `env:`, `secret:`, `@key:`, or `@secret:` prefixes, the runtime resolves them from the encrypted DB store (falling back to `process.env`) and injects decrypted values directly into `node.state` upon graph instantiation:

```ndl
graph pipeline @version:1.0.0

node auth_handler @auth/verify
  state api_key = env:OPENAI_API_KEY
  state db_pass = secret:POSTGRES_PASSWORD
  state service_token = @key:PAYMENT_GATEWAY_KEY
```

- **Runtime Execution**: Nodes access the decrypted values directly on `state` during compute passes.
- **Serialization Safety**: `toNDL()` preserves the original `env:` / `secret:` references, preventing sensitive plaintext secrets from leaking back into exported NDL strings.

---

## 🚀 7. Quick Start & Testing

### Installation & Test Suite
```bash
# Install dependencies
npm install

# Run automated test suites (Unified Variables, Secrets API, NDL Injection, Wildcards)
npm test
```

### Starting the Runtime
```bash
# Set master secret
export NODAIC_MASTER_SECRET="your-secure-master-secret-at-least-32-bytes"

# Set network access control (optional)
export NODAIC_ALLOWED_ORIGINS="http://localhost:3000,https://*.mycloud.org:*"
export NODAIC_ALLOWED_IPS="127.0.0.1,192.168.1.0/24"

# Start the runtime
npm start
```

---

## 🗺️ 8. Node.js Runtime Roadmap

- [x] Unified SQLite database (`variables`) in WAL mode with busy timeouts.
- [x] Internal-only workflow state (`StateNode`) with namespace gates (`secrets`, `system`).
- [x] Variable RPC API with row-level RBAC (`roles_json`).
- [x] Wildcards for allowed domain origins and IP / CIDR subnets.
- [ ] **Clustered Discovery**: mDNS / UDP broadcast for auto-discovering peer runtimes on local networks.
- [ ] **WASM Execution Sandbox**: Sandboxed isolation for third-party node processes via WebAssembly.
- [ ] **OpenAPI 3.1 & JSON Schema Generator**: Automated live schema reflection for all registered artifacts.
- [ ] **OpenTelemetry Integration**: Native trace propagation and metrics export for distributed workflow monitoring.
