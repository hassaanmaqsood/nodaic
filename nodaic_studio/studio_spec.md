# Nodaic Studio — Complete Spec (v11, self-contained)

---

## 1. Product model

```
Runtime ──owns──▶ Library (graphs/artifacts)
   │                  └─contains──▶ Nodes ──reference──▶ Library artifacts
   ├─owns──▶ Secrets (config; write-only or revealable per capability)
   ├─owns──▶ Roles (identity: name + token; shape depends on role_management — §5)
   ├─owns──▶ Triggers (event ↔ artifact, 1:1, filtered by role — §5)
   └─exposes──▶ Console (role-gated) + Logs (push or poll, per capability)

Studio = one client, many Runtimes, one Runtime "in focus" at a time.
Every connection to a Runtime authenticates AS a Role, via that Role's token.
Runtime types: Node.js server, Python server, Cloudflare Worker, ESP32 MCU,
in-browser Local (SCAD / Web-API — no network, tab-scoped, no auth model).
```

---

## 2. Runtime Capability Manifest

Every Runtime reports this on connect. **Missing capability → the control does not exist, not "disabled."** This absence-rule governs both by runtime capability and by role permission (§5).

`role_management` is tri-state, reported by the runtime, never configured by the user:

| Value | Meaning | Reported by |
|---|---|---|
| `none` | no auth/role concept at all | Browser Local |
| `fixed` | exactly `admin` + `device`, baked in, not creatable/editable | ESP32 |
| `full` | arbitrary named roles, admin-manageable | Node.js, Python, Cloudflare Worker |

Full manifest:

| Flag | Node.js | Python | CF Worker | Browser Local | ESP32 |
|---|---|---|---|---|---|
| `transport` | REST+WS | REST+WS | REST + WS-via-DO | in-process | REST poll only |
| `persistent_state` | yes | yes | externalized (KV/DO) | tab-local | yes (flash) |
| `live_logs` | push | push | push (DO)/poll fallback | n/a | poll, low-freq |
| `secrets_revealable` | yes | yes | no | n/a | no |
| `artifact_deploy` | live POST | live POST | live POST | instant in-memory | OTA bundle |
| `concurrency_check` | version-stamp | version-stamp | version-stamp if DO | n/a | none (LWW) |
| `role_management` | full | full | full | none | fixed |

**Rule:** every panel renders conditionally on capability. `role_management` has three renderings — see §5.

---

## 3. Global shell

```
┌ Titlebar ────────────────────────────────────────────────────────────────┐
│[≡] Nodaic │ runtime/library/graph │ [Read|Write] │[◫Modeler|🔑][▶][</>][?]│
├ Sidebar (240px) ───────────┬ Workspace ────────────────────────────────┤
│ RUNTIMES          +        │  Modeler: Visual canvas ⇄ Code (NDL)       │
│ LIBRARY (active runtime) + │  or Secrets/Triggers drawer (overlay)      │
│ SECRETS (active runtime) + │                                            │
│ ROLES (renders per §5.3)  +│  Inspector (right, node selected)          │
├────────────────────────────┴────────────────────────────────────────────┤
│ Status: nodes:N edges:N │ runtime chip │ role: <name> │ [Console ⌘\`]   │
└───────────────────────────────────────────────────────────────────────────┘
```
The status bar always shows the active Role name — identity should never be ambiguous while editing or triggering anything.

**Breakpoints:** Desktop ≥1024px 3-column persistent; Tablet 640–1023px sidebar→icon rail, Inspector→bottom sheet; Mobile <640px both are overlay drawers, canvas defaults to Read+Monitor.

---

## 4. Mode system

| | Read | Write |
|---|---|---|
| Canvas | pan/zoom/select only | full edit |
| Secrets | masked, no reveal/edit | reveal (if capable + elevated session), edit |
| Roles | visible per §5.3 rendering | mutate per §5.3 rendering |
| Triggers | visible only | add/edit/delete |
| Console | Public commands only | full tier per §6 |

Read/Write is orthogonal to Role identity: a Read-mode session still authenticates as a specific Role and still only sees what that Role and the runtime's capabilities allow.

---

## 5. Roles & Triggers

### 5.1 Role object
```
Role {
  name: string        // unique per runtime
  token: secret        // the credential; reveal rules identical to Secrets (§2 secrets_revealable)
  isAdmin: boolean     // grants role-management rights on this runtime — nothing more, nothing less
}
```
That's the entire object, regardless of `role_management` value. Under `fixed`, exactly two Role instances exist (`admin`, `device`) and are not created or edited. Under `full`, admins manage an arbitrary set. Under `none`, no Role objects exist at all.

### 5.2 Trigger object
```
Trigger {
  event: string           // unique per runtime
  artifact: string         // exactly one Library artifact — 1:1, enforced both ways:
                            // an artifact already bound to an event is hidden from
                            // other Triggers' artifact picker
  access: {mode, roles[]}  // shape below depends on role_management, storage does not
  delivery: "trigger" | "async" | "sync"   // maps to /trigger/:event, /trigger/async/:event, /trigger/sync/:event
}
```
`access` is stored identically regardless of `role_management` value — under `fixed`, `roles[]` simply only ever contains `admin` and/or `device`. One data model, three UI renderings (§5.4).

**Default safety rule:** an `allow` list left empty means *no one but admins* can invoke it (admins bypass all Trigger access lists by definition of `isAdmin`). A `deny` list left empty means *everyone* can invoke it. The safe default (`allow`, empty) is the one a user reaches by doing nothing.

### 5.3 Sidebar — ROLES section, rendered per `role_management`

| `role_management` | Rendering |
|---|---|
| `none` | absent entirely |
| `fixed` | **read-only** list: `admin`, `device` rows, token masked (revealable only if `secrets_revealable`), no `+` add, no `⋮` menu — visible for transparency, nothing to act on |
| `full` | full CRUD, rendered only if the current session's Role has `isAdmin: true`; otherwise absent (permission gate uses the same absence rule as capability gate) |

`full` rendering:
```
ROLES (admin only)        +
● admin      token ●●●●●●  [👁 if capable]  ⋮
  ops        token ●●●●●●  [👁 if capable]  ⋮
  guest      token ●●●●●●  [👁 if capable]  ⋮
```

**Add/Edit Role sheet** (`full` only):
```
NAME       [ ops                    ]
ADMIN      ( ) yes  (•) no
TOKEN      [ ●●●●●●●●●●●●    ] [⚡ Generate]   (reveal only if secrets_revealable)
```
Delete requires confirm (destructive-action rule, §11).

### 5.4 Trigger Access field — same self-collapsing rule

| `role_management` | Access UI |
|---|---|
| `none` | field absent — Trigger is just event→artifact, no auth model to filter against |
| `fixed` | **3-way radio**: Admin only / Device only / Both — no mode toggle, no empty-list ambiguity, no multi-select |
| `full` | allow/deny mode + multi-select role picker |

`full` rendering, Secrets & Triggers drawer:
```
┌ Secrets | Triggers ──────────────────────────────────────┐
│ Triggers tab:                                              │
│  event: order.created → artifact: process-order            │
│  Access: Allow only [ops] [admin]        delivery: async   │
│                                                       [＋Add]│
└──────────────────────────────────────────────────────────────┘
```

**Add/Edit Trigger sheet** (one component, one `switch(role_management)` at render time — not three sheets to maintain):
```
EVENT NAME   [ order.created                         ]
ARTIFACT     [ process-order ▾ ]  (bound artifacts excluded from list)
ACCESS       — none:   (no field rendered)
             — fixed:  (•) Admin only  ( ) Device only  ( ) Both
             — full:   (•) Allow only these roles   ( ) Deny these roles
                        [ ops ✕ ] [ admin ✕ ] [+ add role]
DELIVERY     ( ) /trigger/:event  ( ) async  ( ) sync
```

---

## 6. Console — role-aware, tiered, collapses per `role_management`

```
› whoami                     → always available, all three states
  role: ops        admin: no       runtime: node-dev

› role list                  → none: "not supported here"
                                fixed: admin, device (read-only)
                                full: full list with isAdmin flags

› role add auditor           → none: command doesn't exist
                                fixed: rejected — "This runtime only supports built-in roles"
                                full: works, admin-gated

› role edit ops --token regenerate    (full only, admin-gated)
› role delete guest                    (full only, admin-gated, confirm required)

› binding set STRIPE_KEY sk_live_xxx --secret
⚠ Requires elevated session — run `sudo-session` (5 min unlock)
```

| Tier | Commands | Gate |
|---|---|---|
| Public | `whoami`, `role list` (read-only where applicable), `graph list/new`, `run`, `runtime list`, `binding get` (non-secret) | any authenticated Role, all three `role_management` states |
| Elevated | `binding set --secret`, secret reveal | `requireElevatedSession()` — password re-confirm, 5-min flag (orthogonal to Role identity) |
| Admin | `role add/edit/delete` | `none`: command doesn't exist, no message needed. `fixed`: rejected with a clear one-line notice naming the constraint — the runtime is capable of *having* the concept, so silence would be misleading. `full`: works, gated by current session's Role having `isAdmin: true` |

There is no separate "admin-only, never in console" tier and no user layer underneath Roles to issue OTPs for — identity **is** the Role's token.

---

## 7. Connectivity states

| State | Glyph | Color | Meaning | Extra |
|---|---|---|---|---|
| Live | ● | green | connected | latency (ms) |
| Syncing | ◐ | amber | reconnecting | — |
| Offline | ○ | gray/red | unreachable, edits queue | retry countdown + `[↻ now]` |
| Local | ⚡ | blue | in-browser, no network | "this tab only" |

---

## 8. Optimistic mutation lifecycle

`idle → pending(● amber) → synced(✓, fades 2s) | failed(✕, [Retry][Revert], toast)`

Applies uniformly to Graph, Secret, Role, and Trigger edits wherever the relevant section is rendered.

---

## 9. Conflict handling

Version-stamped where `concurrency_check` capability allows; mismatch → `"Changed elsewhere — [Reload latest] [Overwrite anyway]"`. No diff UI. Skipped entirely where capability is absent (ESP32, Browser Local). Applies to Trigger/Role edits identically to Graph edits.

---

## 10. Data loading order

1. Graph structure → 2. Node state/properties (streamed) → 3. Library metadata (on-demand) → 4. Secrets/Role tokens (always masked first; unmask only on explicit reveal + fresh elevated session, where capability allows).

---

## 11. Visual system, accessibility

- Color roles fixed: green=live/success, amber=syncing/in-progress, red=error/destructive, blue=local/selected/info, gray=disabled/offline.
- One glyph per state everywhere; monospace for code/logs/ids/tokens, sans for UI text.
- No hover-only affordances; status = glyph+color+label always; destructive actions always confirm via real modal.

---

## 12. Error / empty-state table

| Situation | Treatment |
|---|---|
| `role_management: none` runtime, any role UI | absent everywhere, no message needed |
| `role_management: fixed`, mutating role command attempted | one-line rejection naming the constraint, not silent absence |
| `role_management: fixed`, Trigger sheet opened | 3-way radio, never the full picker — same sheet component, different render path |
| `role_management: full`, non-admin session | ROLES sidebar section absent (permission gate, same absence rule as capability gate) |
| Trigger artifact picker, all artifacts already bound | picker shows "All artifacts already have a Trigger" instead of an empty list |
| Trigger access list empty, mode=allow (`full`) | functions correctly as admin-only — documented safe default, not an error |

---

## 13. Build sequencing

1. Node.js + Browser-Local first — exercises `full` and `none`, the two ends of the spectrum, and proves the shell with the simplest and richest cases side by side.
2. Cloudflare Worker next — `full`, and the first real test of `secrets_revealable: no` affecting Role token reveal too.
3. ESP32 last — `fixed`, the one state not yet exercised, deliberately saved for once the pattern is proven twice over.

---

## 14. Explicitly deferred

1. Diff/merge UI for edit conflicts (Graphs, Secrets, Roles, Triggers alike) — reload-and-redo is permanent at this scope.
2. WebAuthn/SSO for elevated sessions — password re-confirm is permanent until external users exist.
3. ESP32 OTA bundle format, MCU log-poll interval — need physical hardware, deferred to Phase 3.
4. Minimap node-count threshold — instrument, revisit with data.
5. Per-Trigger rate limiting / abuse protection on public (deny-empty) Triggers — not designed yet; flag it before any Trigger ships with `mode: deny` and an empty list on an internet-facing runtime.
6. Multiple same-category credentials under `fixed` (e.g. several distinct `device` instances for per-caller revocation) — not built now; the natural next step if a `fixed` runtime ever needs more than one physical caller distinguished.