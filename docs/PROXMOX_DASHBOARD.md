# Cindro Proxmox Dashboard — an AI-powered replacement for the Proxmox web UI

A brand-new, Cindro-themed dashboard **served on a Proxmox host** that becomes
the primary UI there. Jarvis is the manager: you chat with it and it does
**everything the Proxmox GUI can do** (create/clone/delete VMs, power, snapshots,
backup/restore, storage/ISO, network, LXC, cluster, migration…) through MCP —
with a **user-configurable permission system** gating anything destructive.

It is deliberately Proxmox-specific: **no** Outpost-pairing UI, **no** computer-use
screen. It DEPENDS ON, and never replaces, the always-on
[Proxmox Workload Manager](PROXMOX_WORKLOAD_MANAGER.md) — that agent's restricted
tuning catalog (no power/create tools) is untouched.

## Two isolated MCP catalogs on the host

```
Proxmox host
 ├─ pveproxy :8006                          native Proxmox UI+API — UNTOUCHED (escape hatch at /pve)
 ├─ proxmox-mcp :8799 (loopback)            EXISTING restricted tuning catalog — UNTOUCHED (no power tools)
 ├─ proxmox-operator-mcp :8800 (loopback)   NEW full-power, permission-gated catalog
 ├─ proxmox-dashboard :8443 (LAN, TLS)      NEW: serves the SPA + WS-proxy to jarvisd + /pve escape hatch
 └─ jarvisd-proxmox-agent (headless)        EXISTING; also drives the interactive operator session
```

The autonomous 5-minute tuning tick keeps its `:8799` catalog. The interactive
dashboard's Jarvis uses the SEPARATE `:8800` operator catalog, where every
mutating tool is permission-gated. They can never be confused (distinct
endpoints + distinct bearer tokens).

## How a browser reaches the loopback daemon

jarvisd's control socket is loopback-only and token-gated by design. The
`proxmox-dashboard` service (`proxmox-mcp/proxmox_mcp/dashboard_server.py`,
:8443 TLS) is the only new LAN-facing surface. It:

1. Static-serves the SPA (`dist-pve/`, SPA history-fallback).
2. Reverse-proxies the browser's `wss://<host>:8443/control/ws` to the co-located
   jarvisd's loopback control socket, **injecting jarvisd's control token
   server-side** — the browser never sees it, and ControlServer keeps its
   loopback binding unchanged (the proxy connects from 127.0.0.1).
3. Redirects `/pve` to the native Proxmox UI on :8006 (full-takeover escape hatch).

Auth boundary: a `dashboard_token` (installer-generated, 0600) is exchanged at
`/login` for an HttpOnly+Secure session cookie; the WS proxy and `/pve` require it.

## The permission system (user-configurable)

Policy lives at `/etc/jarvis-proxmox-agent/operator_policy.json`:

```json
{ "default_risky": "ask",
  "rules": [ { "id": "r1", "match": {"tool":"proxmox_vm_power","verb":"start"}, "effect": "allow" },
             { "id": "r2", "match": {"vmid":106}, "effect": "deny" } ] }
```

- `default_risky` ∈ `ask` (approve each change) | `allow` (full autonomy) | `deny`
  (read-only). Chosen on the dashboard's **Permissions** page.
- Per-action `rules` (match on `tool`/`verb`/`method`/`vmid`) override the default;
  first match wins. Answering **“Always”** on an approval appends an `allow` rule.
- Enforced twice: the daemon's `operatorGate` (interactive `ask`/`allow`/`deny`,
  reusing the Contract B `approval` event + `approval.respond`) AND the operator
  MCP's `guarded_write()` server-side `deny` backstop. Reads + local board writes
  (Home grid, Tasks) are never gated.

`operator_store.resolve_effect` (Python) and `ControlServer::operatorResolveEffect`
(C++) mirror each other — keep them in lock-step.

## Routing an interactive operator session

A UI opens the operator with `session.create {agent:"proxmox-operator", brain:"api",
model:"mistral-large-latest", target_ref:"proxmox-op-<host>"}`. The
`target_ref="proxmox-op-"` prefix makes `makeBrain()` point the ApiBrain at the
`:8800` operator endpoint and install the `approveTool` gate (before the generic
`proxmox-` branch, which still routes the autonomous tick at `:8799`).
`handleSessionCreate` now threads `target_ref` through (previously dropped).

## Contract A verbs (served by the host jarvisd, reached via the WS-proxy)

| Verb | What |
|---|---|
| `proxmoxop.policy_get` / `policy_set` | read/write the permission policy |
| `proxmoxop.pending_list` | approvals currently waiting on the user |
| `proxmoxop.layout_get` / `layout_set` | the Home widget grid (Jarvis edits the same store) |
| `proxmoxop.tasks_list` / `tasks_create` / `tasks_update` | the Tasks board |
| `proxmoxop.tool` | call a FREE operator read tool directly (live tables, no LLM); mutating tools are refused here |
| `outpost.install_dashboard {machine}` | one-click install (below) |

Broadcasts `proxmoxop.approval` / `proxmoxop.layout` keep the Permissions/Home
pages live.

## One-click install

`outpost.install_dashboard {machine}` (an "Install Cindro Dashboard" button on the
Outpost page) follows the workload-manager installer pattern (base64-over-
`outpost.exec` + systemd). It **requires** the workload manager first (reuses its
sparse checkout, venv, and jarvisd AppImage), then: re-syncs code + `pip install`;
generates `operator_mcp_token`/`dashboard_token` and seeds `operator_policy/layout/
tasks` (guarded — never clobbers); seeds the `proxmox-operator` AGENT.md; fetches
the prebuilt `cindro-proxmox-dashboard.tgz` release asset into
`dashboard/dist` (best-effort — else the server shows a placeholder); writes the
two systemd units (also committed under `proxmox-mcp/packaging/`); `enable --now`.
Idempotent — re-run to upgrade. Returns `https://<machine>:8443/` + the dashboard
token.

## The SPA

A separate Vite target (`web/vite.pve.config.ts`, `web/src/pve/`) that reuses the
Cindro theme (`web/src/core/theme.css`) and the Contract A protocol, with a
curated page set: **Home** (a real drag/resize widget grid), **VMs** (list +
gated lifecycle), **Chat** (full operator conversation), **Tasks** (Kanban Jarvis
can edit), **Permissions**, plus a docked **side-chat rail** on every page (one
shared operator session). Build: `cd web && bun run build:pve`.

### Operator chat (`chat.tsx`)

- **History persists client-side.** The transcript + chosen model are saved to
  `localStorage` and rehydrated on load, so the chat survives reloads and page
  navigation. It's display continuity only — the WS-proxy scopes send/subscribe
  to sessions the current socket opened, so a daemon session can't be *resumed*
  across a reload; the next message starts a fresh session. A **new-conversation**
  button (⟲ in the header) clears it.
- **In-chat model picker** (header dropdown) lists the operator-capable catalog
  from `/_jarvis/settings` (non-Anthropic `api`-brain models only — the operator
  MCP won't wire tools onto a Claude/Anthropic brain). Switching starts a fresh
  session on the next turn (model is fixed at `session.create`) but keeps the
  transcript. Both the picker and new-conversation are disabled mid-turn.
- The docked **side rail is drag-resizable** from its left edge (width persisted,
  clamped 300–760px), independent of the collapse toggle.

### Home widget grid — the tile catalog

`proxmox_dashboard_layout_set` (and the user's drag/resize) write a tile list of
`{id, type, title?, node?, grid:{x,y,w,h}, content?}` on a 12-column board.
Renderers (`web/src/pve/widgets/tiles.tsx`): `cpu_usage`, `vm_status`,
`node_stats`, `storage`, `cluster_status`, `recent_backups`, `tasks_board`,
`note`, `gauge`. Aliases for the descriptive names the model tends to invent
(`vm_list`→`vm_status`, `storage_overview`→`storage`, …) and the flat
`col/row/width/height` grid an older build emitted are both normalized —
client-side in `WidgetGrid.normalizeTile` and server-side in
`operator_store.normalize_tiles`. **Keep the alias/type tables in
`tiles.tsx` (TS) and `operator_store.py` (Python) in lock-step.**

## Verification

- Operator MCP: `cd proxmox-mcp && env -u PYTHONPATH .venv/bin/python -m pytest
  tests/test_operator_store.py tests/test_operator_ops.py tests/test_operator_tools.py`.
- Daemon/core: `ninja -C build jarvisd` (routing/gate compile; live behaviour needs
  a paired Proxmox host).
- Web: `cd web && bun run typecheck && bun run build:pve`.
- Live: `outpost.install_dashboard`, browse `https://<host>:8443/`, sign in, chat a
  turn (streams through the WS-proxy), issue a gated `stop VM` (approval card →
  executes only on allow), and confirm `/pve` reaches the native UI.
