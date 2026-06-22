# computer-use — UPGRADE POINTS (Wave 5 plan)

This file is a **map**, not a changelog. The engine was copied verbatim from
`mcp/computer_use/` (NO behaviour changes / NO upgrades applied yet — `git diff`
against the source tree is empty except for the removed `.git`, `.venv`,
`__pycache__`). The four upgrades below are what Wave 5 ("nested agent desktop +
distinct cursor overlay + live video") needs from this engine. Each entry names
the exact file and the exact existing functions/objects to extend so the work
lands in one place and matches Contract A / Contract B in `docs/BUILD_SPEC.md`.

Importable package: **`computer_use_mcp`** (pyproject `[project].name =
computer-use-mcp`, wheel package `computer_use_mcp`, console script
`computer_use_mcp.server:main`). Always run Python with `env -u PYTHONPATH`
(host exports a 3.14 PYTHONPATH that breaks the venv — see README).

---

## (1) `computer_use_mcp/session.py` — add a nested-agent-desktop session kind

**What:** today `detect()` only discovers the two *real* host compositors
(`kde` via `_find_kwin()`, `sway` via `_find_sway()`), and `SessionInfo.kind`
is `"kde" | "sway"`. Add a third kind, e.g. `"agent"` (alias
`nested-agent-desktop`), for the headless **nested Sway** that runs the agent's
own desktop under `cage`/`wayvnc` (see Wave 5 in BUILD_SPEC and the
"Nested sway + wayvnc input isolation (Wave 5)" item in `spikes/RESULTS.md`).

**Exact touch points:**
- `SessionInfo.kind` docstring/typing (line ~66): allow `"agent"`.
- New discovery helper alongside `_find_sway()` (line 171) / `_find_kwin()`
  (line 196), e.g. `_find_agent_sway()` — find the nested sway by its **own**
  `sway-ipc.<UID>.<PID>.sock` and distinguish it from the host sway. It is NOT on
  seat0 and NOT the loginctl ActiveSession, so it must be matched by its nested
  `WAYLAND_DISPLAY` / a marker env var on the `cage`/nested-sway process, not by
  `_active_session_id()`.
- `SessionInfo.env()` (line 87): for the agent kind, emit the **nested**
  `WAYLAND_DISPLAY` (+ its `SWAYSOCK`) so `grim`/input target the nested socket,
  not the host's.
- `detect()` (line 305): append the agent session to `sessions`; the agent
  session is explicitly NOT eligible to be `result["active"]` (host seat stays
  active) — Contract A `session.create{...,target:"agent"|"real"}` will request
  it by name.
- `get_session(which=...)` (line 363): accept `which="agent"`.

## (2) `computer_use_mcp/input.py` — per-session input targeting + agent-pointer event bus

**What:** input is currently hard-wired to the **active host seat**: every
emit calls `session.get_session("active")` and there is a single global
`_POINTER` uinput device. Wave 5 needs (a) input that can be routed at the
**nested agent desktop** instead of the host seat, and (b) an
**agent-pointer event bus** so the desktop sidebar can draw a distinct cursor
overlay that tracks where the agent is pointing (BUILD_SPEC Wave 5: "distinct
cursor overlay").

**Exact touch points:**
- `_emit_abs()` (line 97): it calls `session.get_session("active")` and uses
  `active.bbox`. Parameterize the target session (`which`/`SessionInfo`) so it
  can normalize against the **agent** session's bbox; for the nested desktop the
  pointer is the nested compositor's virtual pointer, not the host uinput.
- `_pointer()` / global `_POINTER` (lines 60, 65): support a **second** pointer
  device (or per-session pointer registry) bound to the nested compositor, since
  one uinput device only lands on the host seat.
- `move()`/`click()`/`drag()`/`scroll()` (lines 118/124/141/163): thread a
  `which="active"|"agent"` (or session) argument through; `map_to_desktop` in
  `screen.py` is already coord-space aware and pairs with this.
- **New: agent-pointer event bus.** After each successful `move`/`click`/`drag`
  on the agent session, publish `{x,y,button,kind,session}` to an in-process
  async pub/sub (e.g. an `asyncio.Queue`/callback registry, module-level like
  `_POINTER`). `server.py` subscribes and forwards these over the existing
  extension/daemon channel so the sidebar overlay can render the agent cursor.
  This is the data source for the "video-frame endpoint" in (4).

## (3) `computer_use_mcp/screen.py` — video-source hook

**What:** `take_screenshot()` is a one-shot still capture that picks a backend
per session kind in `_grim_available()` → `_grim_capture()` (sway/wlr) or
`_spectacle_capture()` (KDE). Wave 4/5 need a **continuous video source**.

**Critical constraint (from `spikes/RESULTS.md`):** on the **real KDE** session
`spectacle` CANNOT capture layer-shell surfaces (the agent-cursor overlay +
phone live-video), so KDE video must go through the **PipeWire portal /
kwin screencast**, NOT spectacle. The **nested agent Sway** desktop is
unaffected — capture it with **grim / wlr-screencopy** and use it as the
default live-video source.

**Exact touch points:**
- New capture path next to `_grim_capture()` (line 42) / `_spectacle_capture()`
  (line 55): a `video_source(info, ...)` generator/streamer that yields frames.
  - `info.kind in ("sway","agent")` → wlr-screencopy stream (grim per-frame, or
    a `wlr-screencopy`/`wf-recorder`-style continuous grab) over `info.env()`'s
    `WAYLAND_DISPLAY`.
  - `info.kind == "kde"` → PipeWire/`xdg-desktop-portal` ScreenCast node
    (kwin screencast), **never spectacle** (it returns wallpaper for layer-shell
    surfaces — proven in the spike).
- Reuse `_grim_available()` (line 78) / the `screenshot_tool` config knob
  (`config.py` `DEFAULT_CONFIG["screenshot_tool"]`) — add a parallel
  `video_source` preference (`auto|wlr|portal`).
- Keep `LAST_SHOT` / `map_to_desktop()` (line 178) semantics so video-frame
  coordinates and click mapping stay consistent (same `origin`/`scale` model).

## (4) `computer_use_mcp/server.py` — expose a video-frame endpoint for the daemon

**What:** the FastAPI app currently exposes `/mcp` (MCP transport), `/health`,
and `/ws/extension` (the Chrome bridge). Add an endpoint the **daemon**
(`jarvisd`) consumes for live video (Wave 4 MJPEG → Wave 6 WebRTC), fed by the
`screen.video_source` hook from (3) and the agent-pointer bus from (2).

**Exact touch points:**
- Add the route before the catch-all mount. Note line 94
  `app.mount("/", mcp_app)` is mounted LAST so concrete routes win — add the new
  endpoint **above** that line (like `/health` at line 70 and
  `/ws/extension` at line 88).
- Suggested: `@app.get("/video/frame")` (single MJPEG/PNG frame) plus
  `@app.websocket("/video/stream")` (continuous frames + agent-pointer events
  multiplexed). Implement by pulling from `screen.video_source(...)` and the
  `input.py` agent-pointer bus.
- It is automatically auth-gated: `auth_middleware` (line 58) already requires a
  bearer token on every path except `/health` and `OPTIONS`, so the new
  endpoints inherit the tailnet bearer model (token in
  `~/.computer-use/config.yaml`, read by `config.py`). Do not add an exemption.
- Parameterize by session: accept `?which=agent|active` so the daemon can stream
  the nested agent desktop by default (per the RESULTS.md guidance) and the real
  KDE session via the portal path when needed.
