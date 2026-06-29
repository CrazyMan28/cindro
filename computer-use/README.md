# computer-use-mcp

Anthropic-computer-use-style control of this desktop for AI agents (Claude
Code, Codex, anything MCP), plus deep Chrome control through a companion
extension. Python FastMCP server over streamable HTTP with bearer auth,
following the fleet conventions (project-tracker / phone-installer / vm-agent).

**Scope is UI-only by design** — no exec/file/process tools, because local
agents already have a shell. This server adds the missing senses and hands:
screen, mouse, keyboard, windows, clipboard, browser.

## Endpoints

- `http://127.0.0.1:8794/mcp` — MCP (streamable HTTP), `Authorization: Bearer <token>`
- `ws://127.0.0.1:8794/ws/extension?token=<token>` — Chrome extension bridge
- `http://…:8794/health` — open health check (`active_compositor`, `ydotoold_socket`, `extension_connected`)

Token lives in `~/.computer-use/config.yaml` (auto-generated on first run).
Port 8794 because 8790–8792 are taken and **8793 is intermittently bound by
kihi-launcher**.

## Tools

Desktop (work on whichever session is ACTIVE — KDE Plasma or Sway, both run
concurrently on this box; uinput input always lands in the active one):

| Tool | Notes |
|---|---|
| `session_info` | compositors, TTYs, monitors, desktop bbox |
| `desktop_screenshot` | full desktop / one output / region; downscaled; returns coord transform |
| `mouse_move/click/drag`, `scroll` | coords in `image` (last screenshot), `desktop`, or `output:NAME` space |
| `key_press`, `type_text` | combos like `ctrl+shift+t`; unicode auto-routes via clipboard paste |
| `clipboard_get/set` | per session |
| `window_list/activate/close` | unified `kwin:`/`sway:` ids |
| `window_set` | minimize/unminimize/maximize/fullscreen/restore/move_resize |
| `app_list` | installed applications (rpm + flatpak + snap .desktop entries) |
| `app_launch` | launch any app by fuzzy name/id or raw command — runs in its own systemd user unit with the active session's display env; returns the new window |
| `desktop_calibrate` | verifies pointer accuracy (KWin cursorPos / image diff) |

Browser (need Chrome + the extension connected): `browser_status`,
`browser_tabs`, `browser_tab_new/activate/close`, `browser_navigate`,
`browser_snapshot` (interactive elements with refs `e1…`),
`browser_click` (ref/selector, `trusted=True` for real CDP input),
`browser_type`, `browser_select`, `browser_scroll`, `browser_screenshot`
(`full_page` via CDP), `browser_eval` (MAIN world, CDP fallback),
`browser_console`, `browser_cdp` (raw DevTools-protocol escape hatch).

`trusted` clicks, console capture, full-page shots and `browser_cdp` attach
Chrome's debugger to the tab — Chrome shows its "is being debugged" banner
until the tab closes; that's inherent to the API. If DevTools is open on the
tab, attach fails (close DevTools and retry).

## Multiple agents at once

Any number of MCP clients can connect at the same time — Claude Code, Codex,
and tailnet agents all hit the same `…:8794/mcp` with the same bearer token,
each getting its own MCP session. Browser commands from every client are
multiplexed onto the single extension WebSocket: each command carries a unique
id with its own response future, and a send lock serializes socket writes so
concurrent agents can't interleave half-frames. Verified live: Codex
(`codex exec`) opened a tab and read a random server UUID through the browser
MCP while a second Claude session read the same tab and confirmed the value —
no crosstalk.

**Rule for concurrent browser use: give each agent its own tab.** Snapshot
refs (`e1…`) are per-tab and bump a generation each snapshot, so if two agents
snapshot the *same* tab they invalidate each other's refs; on separate tabs
they're fully isolated. The desktop tools' `LAST_SHOT` (image-coordinate
mapping) is likewise shared global state — for parallel desktop work, prefer
`coord_space="desktop"`/`"output:NAME"` over the default `"image"` so agents
don't depend on whose screenshot was last.

## Architecture notes (the non-obvious bits)

- **Mouse is a virtual ABSOLUTE pointer** (`uinput` via python-evdev, the
  VM-mouse trick). ydotool's emulated absolute moves break on this KDE:
  libinput acceleration scales deltas ~2x and Plasma's screen-edge barriers
  eat single-event motion at monitor boundaries. The ABS device maps 0..65535
  onto the desktop bbox with zero acceleration — verified ≤1px on all 3
  monitors. Keyboard stays on ydotoold (systemd user unit).
- **Both compositors run at once** (KDE tty3, sway tty2). Session detection
  can't trust loginctl Type/Desktop (KDE was console-launched) or kwin's
  /proc environ (capability-elevated → root-owned); it majority-votes
  WAYLAND_DISPLAY→XDG_SESSION_ID over readable session processes.
- **Screenshots**: sway→grim; KDE→spectacle -b -n (this KWin lacks the
  screencopy protocols grim speaks), PIL-cropped for region/output shots.
- **KWin window ops** run JS inside KWin (kdotool approach): the server owns
  `org.computeruse.KWinBridge` on the session bus and scripts call back via
  `callDBus`.
- **MV3 service worker** stays alive because the server sends app-level JSON
  pings every 20s (protocol pings don't reset Chrome's idle timer);
  `chrome.alarms` reconnects after Chrome restarts.

## Install (already done on this box)

```bash
cd ~/projects/mcp/computer_use
env -u PYTHONPATH uv venv && env -u PYTHONPATH uv pip install -e .
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ydotoold computer-use-mcp
loginctl enable-linger $USER
# /dev/uinput needs an ACL once (was already present here):
#   sudo setfacl -m u:$USER:rw /dev/uinput
```

Register with Claude Code (note: the name `computer-use` is reserved):

```bash
claude mcp add -s user -t http desktop-use http://127.0.0.1:8794/mcp \
  -H "Authorization: Bearer $(grep bearer_token ~/.computer-use/config.yaml | awk '{print $2}')"
```

Chrome extension: `chrome://extensions` → Developer mode → Load unpacked →
`extension/` → open its Options → paste the token, port 8794 → Save & Connect.
`/health` then reports `extension_connected: true`.

ALWAYS use `env -u PYTHONPATH` for any python in this repo — this machine
exports a Python-3.14 PYTHONPATH that poisons venvs.

## Agent workflow

1. `session_info` → learn monitors.
2. `desktop_screenshot` (an output, or full desktop) → look.
3. `mouse_click(x, y)` with coordinates measured on that image (default
   `coord_space="image"` maps them back through the recorded transform).
4. Re-screenshot to verify; `desktop_calibrate` if clicks seem off.
5. For Chrome work prefer the `browser_*` tools: `browser_snapshot` refs are
   far more reliable than pixel-clicking the rendered page.
