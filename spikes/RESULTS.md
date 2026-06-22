# Wave 1 — Risk Spike Results (2026-06-22)

## Risk #1 (HIGHEST): KWin + wlr-layer-shell anchoring & keyboard focus — RESOLVED
Built a Qt6/QML + LayerShellQt probe (`spikes/layershell_probe/`). On the live KDE/KWin 6 session
`desktop-use.window_list` reported the probe window as:

    app=layershell_probe  output=DP-1(1920x1080)  rect={x:1500,y:0,w:420,h:1080}  active=true

=> x=1500 == 1920-420 (anchored hard RIGHT), full 1080 height (top+bottom anchors), and `active=true`
(accepts keyboard focus on KWin via KeyboardInteractivityOnDemand). LayerShellQt is confirmed; the
same binary anchors on Sway (wlroots native).

CAVEAT (important for later waves): KDE `spectacle` screenshot path does NOT capture layer-shell
overlay surfaces (a close-up showed wallpaper even though the surface was composited and visible).
IMPACT: the agent-cursor overlay + phone live-video on the *real KDE session* must capture via the
PipeWire portal / kwin screencast, NOT spectacle. The agent's nested headless-sway desktop
(grim / wlr-screencopy) is unaffected -> use it as the default live-video source.

API NOTES for the real app:
- `LayerShellQt::Shell::useLayerShell()` is deprecated/no-op since Qt 6.5 — drop it. Just call
  `LayerShellQt::Window::get(window)` then setLayer/setAnchors/setExclusiveZone/setKeyboardInteractivity.
- Anchor enums have NO QFlags operators -> accumulate into `LayerShellQt::Window::Anchors` with `|=`.

## Risk #2: codex exec --json event contract — RESOLVED
`codex 0.135.0`: `codex exec --json --sandbox read-only </dev/null` emits top-level `type` JSONL:

    thread.started {thread_id} -> turn.started -> item.completed -> turn.completed
    {usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}

GOTCHA: MUST redirect stdin from /dev/null or codex blocks on "Reading additional input from stdin".
Sample saved: `spikes/codex_jsonl_sample.jsonl`. CodexBrain parses this into normalized brain events.

## Risk #3: computer-use MCP reachable — RESOLVED
desktop-use MCP (http://127.0.0.1:8794/mcp) `session_info` OK: active=kde tty2; outputs DP-1
(0,0 1920x1080), HDMI-A-1 (1920,0 2560x1440), eDP-1 (4480,490 1920x1080); bbox 6400x1570.

## Deferred to their own waves
- Sway-side anchoring (other TTY) — low risk (wlr-layer-shell is native on wlroots).
- Nested sway + wayvnc input isolation (Wave 5).
- jarvisd-spawned-headless codex MCP pickup — codex DID connect to the configured MCP servers during
  the spike, so headless MCP loading works.

## Toolchain verified on host (Fedora, no sudo used by agent — user ran one dnf install)
Qt6 6.11.1 (Core/Gui/Quick/Qml/WebSockets/Sql/Multimedia/Svg), LayerShellQt cmake config present,
cage, wayvnc, mako, grim, slurp, libsodium 1.0.22, qrencode 4.1.1, sqlite 3.51.2, cmake 4.3.2,
ninja 1.13.2, g++ 16.1.1, codex 0.135.0, claude 2.1.170, gradle/java (sdkman), uv, node/npm.
