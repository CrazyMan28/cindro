# Orin — BUILD SPEC (source of truth for all build agents)

Read this fully before writing code. It defines the stack, layout, and the **shared contracts** that
let parallel agents build matching pieces. Do not invent alternative protocols/ports/paths.

## Product
"Orin": a unified AI co-worker. Native Linux sidebar (Sway + KDE) + headless daemon, a Python
computer-use engine, a new Android app, a Chrome bridge, and a plugin system. Two modes: **coder** and
**co-worker**. Brain is **hybrid**: Codex CLI (default), Claude CLI, or direct API.

## Verified toolchain (host, Fedora)
Qt6 6.11.1 (Core/Gui/Quick/Qml/WebSockets/Sql/Multimedia/Svg), LayerShellQt (cmake config in
/usr/lib64/cmake/LayerShellQt), cage, wayvnc, mako, grim, slurp, libsodium 1.0.22, qrencode 4.1.1,
sqlite 3.51.2, cmake 4.3.2, ninja 1.13.2, g++ 16.1.1 (C++20/23 ok), codex 0.135.0, claude 2.1.170,
gradle+java (sdkman), uv, node/npm. NO sudo available to agents. See spikes/RESULTS.md.

## Monorepo layout (root = ~/jarvis, git branch main)
- core/      C++20 static lib `jarvis-core`: SessionStore(SQLite), Brain iface + impls, protocol types, config.
- daemon/    `jarvisd` exe (QCoreApplication): control WS server, device WS (phone, later), scheduler, push.
- desktop/   `jarvis-sidebar` exe (QGuiApplication + QtQuick/QML + LayerShellQt): the sidebar UI.
- computer-use/  Python FastMCP engine (copied from mcp/computer_use, upgraded).
- extension/ Chrome MV3 bridge (copied from mcp/computer_use/extension, upgraded).
- android/   New Kotlin/Compose app, package `com.jarvis.app`.
- plugins/   Plugin SDK + signed catalog.
- kde-applet/ Plasma applet/tray that toggles the sidebar on KDE.
- packaging/ systemd user units, sway keybind snippet, mako config, install.sh.
- docs/, spikes/

## Build conventions
- C++: one top-level CMake superbuild; targets jarvis-core(STATIC), jarvisd, jarvis-sidebar. CMAKE_AUTOMOC ON,
  CMAKE_CXX_STANDARD 20. Build with `cmake -S . -B build -G Ninja && cmake --build build`. Tests via ctest.
- Python (computer-use): `uv` + pytest; ALWAYS run python with `env -u PYTHONPATH` (host exports a 3.14
  PYTHONPATH that breaks venvs — see computer_use README).
- Android: Gradle (sdkman), Kotlin, Compose, `./gradlew assembleDebug`.
- Secrets NEVER in git. .gitignore covers build/, .venv/, __pycache__/, *.apk, *.token, service-account*.json, .env.
- Every component must build and ship at least one test. `scripts/verify.sh` builds all + runs tests.

## LayerShellQt usage (proven in spike — follow exactly)
Do NOT call `useLayerShell()` (deprecated/no-op since Qt 6.5). For the QWindow/QQuickWindow:
```
auto *w = LayerShellQt::Window::get(window);
LayerShellQt::Window::Anchors a; a|=AnchorTop; a|=AnchorRight; a|=AnchorBottom; // enums lack QFlags ops
w->setLayer(LayerShellQt::Window::LayerTop);
w->setAnchors(a); w->setExclusiveZone(width); w->setScope("jarvis-sidebar");
w->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);
```
Force `QT_QPA_PLATFORM=wayland`. Anchoring + focus confirmed working on KWin 6 and (native) Sway.

## CONTRACT A — Control protocol (desktop/sidebar <-> jarvisd)
Loopback WebSocket: `ws://127.0.0.1:8795/control/ws?token=<control_token>`.
Token: `~/.config/jarvis/control_token` (0600, auto-generated on first daemon start).
Messages are single JSON objects:
- Request:  `{"v":1,"id":<int>,"method":"<m>","params":{...}}`
- Response: `{"v":1,"id":<int>,"ok":true,"result":{...}}` or `{"v":1,"id":<int>,"ok":false,"error":{"code","message"}}`
- Event (unsolicited): `{"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}`
Methods (v1): `ping`; `settings.get`; `settings.set{patch}`; `model.list{brain}`;
`session.create{profile:"coder"|"coworker",brain:"codex"|"claude"|"api",model?,cwd?,target?:"agent"|"real"}`->`{session_id,thread_id?}`;
`session.send{session_id,text,images?}`; `session.cancel{session_id}`; `session.list`; `session.history{session_id,limit?}`;
`approval.respond{session_id,approval_id,decision:"allow"|"deny"|"always"}`.

## CONTRACT B — NormalizedBrainEvent (brain output -> control events; same shape for all brains)
`{"kind": "<k>", ...fields}` where k ∈
`thread_started{thread_id}` | `turn_started` | `thinking{text}` | `message{role,text}` |
`tool_call{call_id,name,args}` | `tool_result{call_id,ok,output}` | `approval{approval_id,summary,risk}` |
`diff{path,patch}` | `usage{input_tokens,output_tokens,...}` | `final{}` | `error{message}`.
CodexBrain mapping (from `codex exec --json`, verified): `thread.started`->thread_started;
`turn.started`->turn_started; `item.*` assistant text->message, command/tool->tool_call/tool_result;
`turn.completed`->usage then final. ALWAYS spawn codex with stdin `</dev/null`, `--sandbox` per profile
(coder=workspace-write, coworker=workspace-write+computer-use MCP), `-C <cwd>`, `-m <model>`, `--json`.
ClaudeBrain: `claude -p --output-format stream-json --input-format stream-json` (Wave 5). ApiBrain: direct
OpenAI/Anthropic/Ollama loop (port from Android AgentLoop) (Wave 5).

## CONTRACT C — Device protocol (jarvisd <-> phone) — Wave 3+, summary only
WebSocket `:8796`, P-256 device-signed handshake + QR pairing + capability tiers — REUSE the design in
`~/projects/infrastructure/jarvice_log/src/ws.rs` (mirror.start/mirror.frame/input caps,
binary frames for video). Devices store: `~/.config/jarvis/devices.json`. Not in Workflow #1.

## Config & state
`~/.config/jarvis/config.toml` (brains, default_brain=codex, default_model, ports{control:8795,device:8796},
cwd defaults). `~/.local/share/jarvis/jarvis.db` (SQLite: sessions, threads, events, queue, schedules,
memories, skills, ssh_allow, plugins, devices, audit). Computer-use bearer read from
`~/.computer-use/config.yaml`; jarvisd injects it into spawned codex/claude MCP config so the brain can
call `http://127.0.0.1:8794/mcp`.

## Copy-from map (copy, then UPGRADE — never ship a verbatim copy)
- Daemon protocol/pairing design <- infrastructure/jarvice_log/src/{ws.rs,control.rs}
- computer-use engine <- mcp/computer_use/ (whole), extension <- mcp/computer_use/extension/
- Android patterns <- mcp/rip_out_gemini/.../com/jarvice/assistant/ (McpConnectionManager.kt, AiProvider, SecretStore, Room entities, AiSettingsScreen, McpServersScreen, TasksScreen)
- FCM push + APK delivery <- phone-installer MCP (project "the FCM project")

## Wave plan (execution order via Workflow per wave; verify gate each)
- Wave 0+2 (Workflow #1, NOW): foundation + desktop vertical slice (see ACCEPTANCE).
- Wave 3: Android app (pair, sessions, chat+photo, queue, FCM).
- Wave 4: live video MJPEG + remote steer + file receive.
- Wave 5: nested agent desktop + distinct cursor overlay + diff review + ClaudeBrain + ApiBrain.
- Wave 6: WebRTC video + scheduler + skills/today + SSH allow-list + memories + prompt-injection gating.
- Wave 7: plugin marketplace + Jarvis-MCP server + sub-agent tree + voice + in-app browser.

## Workflow #1 ACCEPTANCE (what "done" means)
1. Top-level CMake superbuild + scripts/verify.sh exist; `docs/ARCHITECTURE.md` written.
2. `jarvisd` builds; serves control WS (Contract A); `session.create`+`session.send` spawn CodexBrain
   and stream NormalizedBrainEvents. ctest: parser fed `spikes/codex_jsonl_sample.jsonl` yields the
   expected normalized sequence.
3. `jarvis-sidebar` builds; anchors right on KWin (proven pattern); shows a chat view that renders
   session events + an input box + model picker; connects to control WS. Launches under QT_QPA_PLATFORM=wayland.
4. `computer-use/` copied; `uv` env builds; imports OK; `docs/UPGRADES.md` lists the 4 upgrade points.
5. `android/` skeleton builds `assembleDebug` (package com.jarvis.app) with a pairing screen stub.
6. `packaging/` has jarvisd.service (systemd --user), a sway `bindsym $mod+j` snippet, mako config.
