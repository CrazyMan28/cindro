# Cindro — Architecture

Concise architecture overview derived from `docs/BUILD_SPEC.md` (the source of
truth). This document describes how the components fit together, the shared
contracts they speak, the network ports in play, and the end-to-end data flow.

## Product in one line

Cindro is a unified AI co-worker: a native Linux sidebar (Sway + KDE) backed by
a headless daemon, a Python computer-use engine, an Android app, and a Chrome
bridge. It runs in two profiles — **coder** and **co-worker** — over a
**hybrid brain**: Codex CLI (default), Claude CLI, or a direct provider API.

## Components

| Component       | Path           | Kind                         | Responsibility |
|-----------------|----------------|------------------------------|----------------|
| `jarvis-core`   | `core/`        | C++20 static lib             | `SessionStore` (SQLite), Brain interface + implementations (CodexBrain now; Claude/Api later), protocol types, config loading. |
| `jarvisd`       | `daemon/`      | C++ exe (`QCoreApplication`) | Control WebSocket server (Contract A), device WebSocket server (Contract C), scheduler, push. Spawns/streams brains. |
| `cindro-sidebar`| `desktop/`     | C++ exe (`QGuiApplication` + QtQuick/QML + LayerShellQt) | The anchored sidebar UI: chat view, input box, model picker; control-WS client. |
| computer-use    | `computer-use/`| Python FastMCP engine        | Screen/keyboard/mouse computer-use tools, served over HTTP MCP. |
| extension       | `extension/`   | Chrome MV3                   | Browser bridge for the computer-use engine. |
| android         | `android/`     | Kotlin/Compose (`com.cindro.app`) | Phone client: pairing, sessions, chat + photo, queue, FCM push. |
| plugins         | `plugins/`     | Plugin SDK + signed catalog  | Extensibility surface (later waves). |
| kde-applet      | `kde-applet/`  | Plasma applet/tray           | Toggles the sidebar on KDE. |
| packaging       | `packaging/`   | systemd user units + configs | `jarvisd.service`, Sway keybind snippet, mako config, `install.sh`. |
| website         | `website/`     | Laravel 13 (PHP)             | Marketing/billing site — intentionally a separate stack, not part of the C++/Contract A/B/C system above. Touches the product only via the documented `/api/license/verify` JSON contract (see `website/README.md`). |

The C++ trio is driven by a single top-level CMake superbuild (`CMakeLists.txt`
-> `core`, `daemon`, `desktop`). `scripts/verify.sh` configures, builds, and
runs `ctest` for the whole superbuild.

## Contracts (shared protocols)

These are fixed across all components so parallel agents build matching pieces.
Do not invent alternative protocols, ports, or paths.

### Contract A — Control protocol (sidebar <-> jarvisd)

Loopback WebSocket: `ws://127.0.0.1:8795/control/ws?token=<control_token>`.
The token lives at `~/.config/jarvis/control_token` (mode 0600, auto-generated
on first daemon start). Every message is a single JSON object.

- Request:  `{"v":1,"id":<int>,"method":"<m>","params":{...}}`
- Response: `{"v":1,"id":<int>,"ok":true,"result":{...}}`
            or `{"v":1,"id":<int>,"ok":false,"error":{"code","message"}}`
- Event (unsolicited):
  `{"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}`

Methods (v1): `ping`; `settings.get`; `settings.set{patch}`;
`model.list{brain}`;
`session.create{profile:"coder"|"coworker", brain:"codex"|"claude"|"api", model?, cwd?, target?:"agent"|"real"}` -> `{session_id, thread_id?}`;
`session.send{session_id, text, images?}`; `session.cancel{session_id}`;
`session.list`; `session.history{session_id, limit?}`;
`approval.respond{session_id, approval_id, decision:"allow"|"deny"|"always"}`;
`plan.enter{session_id}` / `plan.exit{session_id}` / `plan.approve{session_id}` /
`plan.status{session_id}` -> `{restricted, source:"settings"|"self"|"approved"|""}` —
Plan Mode's self-initiated entry path plus the session-scoped approve override
(`plan.approve`, called only by `present_plan`'s Approve & Build — never flips the
global `agent_mode`) (engine-facing only; see [MODES.md](MODES.md)).

`settings.get` returns (among others) `permission_level: "high"|"medium"|"low"` — the
**soft ask-before-risky policy** (default `medium`). `settings.set{patch:{permission_level}}`
updates it. It is auto-translated into a clause in the per-session co-work preamble
(`ControlServer::permissionPolicyClause`) that auto-ranks tools HIGH/MEDIUM/LOW and tells
the model to call `ask_user` before acting at/above the chosen tier. It does **not** change
the capability sandbox — that stays enforced independently.

### Contract B — NormalizedBrainEvent (brain output -> control events)

Every brain emits the same event shape so the UI is brain-agnostic:
`{"kind":"<k>", ...fields}` where `k` is one of:

`thread_started{thread_id}` | `turn_started` | `thinking{text}` |
`message{role,text}` | `tool_call{call_id,name,args}` |
`tool_result{call_id,ok,output}` | `approval{approval_id,summary,risk}` |
`diff{path,patch}` | `usage{input_tokens,output_tokens,...}` | `final{}` |
`error{message}`.

**CodexBrain mapping** (from `codex exec --json`, verified in the spike):
`thread.started` -> `thread_started`; `turn.started` -> `turn_started`;
`item.*` assistant text -> `message`, command/tool -> `tool_call`/`tool_result`;
`turn.completed` -> `usage` then `final`. Codex MUST be spawned with stdin
`</dev/null` (else it blocks reading stdin), `--sandbox` per profile
(coder = workspace-write; coworker = workspace-write + computer-use MCP),
`-C <cwd>`, `-m <model>`, `--json`.
ClaudeBrain (`claude -p --output-format stream-json --input-format stream-json`)
and ApiBrain (direct OpenAI/Anthropic/Ollama loop) arrive in Wave 5.

### Contract C — Device protocol (jarvisd <-> phone) — Wave 3+

WebSocket on `:8796` with a P-256 device-signed handshake, QR pairing, and
capability tiers (`mirror.start`/`mirror.frame`/input caps; binary frames for
video). Reuse the design in
`infrastructure/jarvice_log/src/ws.rs`. Devices persist to
`~/.config/jarvis/devices.json`. Not part of Workflow #1.

## Ports

| Port  | Endpoint                                   | Used by |
|-------|--------------------------------------------|---------|
| 8794  | `http://127.0.0.1:8794/mcp`           | computer-use MCP engine (the desktop-use server the brain calls). |
| 8795  | `ws://127.0.0.1:8795/control/ws`           | Contract A control protocol (sidebar/clients <-> jarvisd), loopback only. |
| 8796  | `ws://...:8796`                            | Contract C device protocol (jarvisd <-> phone), Wave 3+. |

## Config & state

- `~/.config/jarvis/config.toml` — brains, `default_brain=codex`,
  `default_model`, `ports{control:8795, device:8796}`, cwd defaults.
- `~/.config/jarvis/control_token` — control-WS bearer (0600, auto-generated).
- `~/.config/jarvis/devices.json` — paired devices (Wave 3+).
- `~/.local/share/jarvis/jarvis.db` — SQLite: sessions, threads, events, queue,
  schedules, memories, skills, ssh_allow, plugins, devices, audit.
- `~/.computer-use/config.yaml` — computer-use bearer; jarvisd injects it into
  the spawned codex/claude MCP config so the brain can reach the engine at
  `http://127.0.0.1:8794/mcp`.

## Data flow (Workflow #1 vertical slice)

```
  user types in sidebar
        |
        v  Contract A request: session.create / session.send
  cindro-sidebar  ───────ws://127.0.0.1:8795────────▶  jarvisd
        ▲                                                  |
        |                                                  |  spawn brain
        |                                                  v
        |                                          CodexBrain (codex exec --json,
        |                                          stdin </dev/null, sandbox per
        |                                          profile, computer-use MCP for
        |                                          coworker @ :8794)
        |                                                  |
        |                                                  |  raw codex JSONL
        |                                                  v
        |                                          normalize -> Contract B
        |                                          NormalizedBrainEvent
        |                                                  |
        |   Contract A event: session.event{ev:...}       |
        └──────────────────────────────────────────────────┘
                         (streamed back to UI; persisted in jarvis.db)
```

1. The sidebar opens the control WebSocket (Contract A) using the auto-generated
   token and issues `session.create` (choosing profile + brain + model).
2. `jarvisd` creates a session row in `jarvis.db`, spawns the selected brain
   (CodexBrain for now) with the profile-appropriate sandbox, and — for the
   `coworker` profile — wires the computer-use MCP (`:8794`) into the brain so it
   can drive the screen.
3. The brain's raw output (e.g. `codex exec --json` JSONL) is parsed into
   **Contract B** NormalizedBrainEvents.
4. Each event is persisted and pushed to subscribed clients as a Contract A
   `session.event`, which the sidebar renders in the chat view (messages, tool
   calls/results, diffs, approvals, usage, final).
5. Approvals flow back via `approval.respond`; cancellation via `session.cancel`.

## Desktop layer-shell notes (proven in spike)

The sidebar uses LayerShellQt directly — do **not** call the deprecated
`useLayerShell()`. For the QWindow/QQuickWindow: `LayerShellQt::Window::get(w)`,
then accumulate anchors into `LayerShellQt::Window::Anchors` with `|=` (the anchor
enums lack QFlags operators), and call
`setLayer`/`setAnchors`/`setExclusiveZone`/`setScope("cindro-sidebar")`/
`setKeyboardInteractivity(... KeyboardInteractivityOnDemand)`. Run with
`QT_QPA_PLATFORM=wayland`. Right-anchoring + keyboard focus are confirmed on
KWin 6 and native Sway (wlroots).
```


## ACP bridge + web dashboard (external client contracts)

- **`acp-bridge/` (jarvis-acp)** — a Python stdio process the EDITOR spawns
  (Zed `agent_servers`, JetBrains): newline-delimited ACP JSON-RPC 2.0 ⇄ the
  Contract A control WS. `session/new` → `session.create` + immediate
  `session.subscribe` (scoping guard); `session/prompt` → `session.send` with
  the normalized event stream mapped to ACP `session/update` chunks;
  `kind=approval` → `session/request_permission` → `approval.respond`.
- **`web/`** — a Bun+Vite+SolidJS SPA with full desktop-GUI page parity (Home/
  Chat/Voice/Computer/Canvas/Widgets/Sessions/Memory/Skills/Agents/Schedules/
  Activity/Graph/Replay/MCP/Plugins/SSH/Phone/Settings, plus Browser),
  speaking the same Contract A client dialect straight to
  `ws://127.0.0.1:8795` (pairing-code redemption on `/control/pair`, both
  session-scoping layers, streamed chat + approvals). `web/server.ts` (Bun)
  only serves the built static files; the daemon stays loopback-only —
  remote use means an SSH/tailscale port-forward, never a daemon bind flag.
  A browser tab has no filesystem access, so the widget saved-library
  (`~/.local/share/jarvis/saved_widgets.json` on GUI/TUI) falls back to
  `localStorage` there instead — see `web/README.md`'s "Known differences"
  section for this and other browser-specific trade-offs.
