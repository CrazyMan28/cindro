# Windows backend for the Jarvis computer-use engine

A **Win32 backend** for the Python computer-use engine, kept in a **fully
isolated directory**. Windows is **second priority**; the Linux engine
(`computer-use/computer_use_mcp/`) stays **byte-for-byte unchanged**.

> Delete `windows/` and the Linux engine is completely unaffected. There are
> **zero** edits anywhere under `computer-use/` — no platform guards, nothing.

## How it works — monkeypatch injection (no engine edits)

The engine calls its primitives **by module attribute at call time**:

- `tools_desktop` does `from computer_use_mcp import input as inp, screen, session`
  then `inp.move(...)`, `screen.take_screenshot(...)`, `session.get_session(...)`.
- `screen.video_source` calls `grab_jpeg_frame(...)` as a module global.
- `session.detect` / `compositor_hint` / `get_session` are read as `session.X`.

Nothing does `from computer_use_mcp.input import move` (verified), so **rebinding
those module attributes** reroutes every primitive to the Windows backend
without touching the engine. `server_windows.py` does exactly that at startup:

```python
for n in ("move","click","drag","scroll","key_press","type_text"): setattr(input,  n, getattr(bw, n))
for n in ("take_screenshot","grab_jpeg_frame"):                     setattr(screen, n, getattr(bw, n))
for n in ("detect","get_session","compositor_hint"):               setattr(session, n, getattr(bw, n))
```

`win_platform.py` does the same for the engine's Linux-only `clipboard`, `windows`,
`apps` and `workspaces` modules (`wp.PATCHES`, applied by `apply_patches()`). Before this,
`clipboard_*`, `window_*`, `app_*` and `workspace_*` all failed on Windows.

`screen.map_to_desktop` and the `SessionInfo` / `Output` dataclasses are
**OS-agnostic**, so they are reused unchanged (imported, never modified). The
Windows `take_screenshot` sets `screen.LAST_SHOT`, so the unchanged
`map_to_desktop` keeps converting image coordinates correctly.

## Win32 mechanism per primitive

| Primitive | Mechanism |
|---|---|
| `move` / `click` / `drag` | `SendInput` (ctypes). Absolute coords normalised `0..65535` over the **virtual** screen (`GetSystemMetrics` `SM_*VIRTUALSCREEN`), with `MOUSEEVENTF_ABSOLUTE \| MOUSEEVENTF_VIRTUALDESK`. |
| `scroll` | `SendInput` wheel: `MOUSEEVENTF_WHEEL` (vertical) / `MOUSEEVENTF_HWHEEL` (horizontal), `WHEEL_DELTA = 120` per notch; honours `config.scroll_invert`. |
| `key_press` | `SendInput` with a VK-code table (`_VK_CODES`, the Windows analogue of `input._KEY_CODES`) covering every key `input._resolve_combo` accepts; extended-key flag where required. |
| `type_text` | `SendInput` with `KEYEVENTF_UNICODE` — full Unicode (incl. surrogate pairs); `\n`→Enter, `\t`→Tab. No clipboard dependency. |
| `take_screenshot` / `grab_jpeg_frame` | `mss` capture + Pillow downscale/crop, reusing the engine's `LAST_SHOT` / metadata contract. |
| `detect` / `get_session` / `compositor_hint` | A single `SessionInfo(kind="windows")` with monitors from `mss` (EnumDisplayMonitors). |

`ctypes` / `pywin32` / `mss` are imported **lazily inside functions**, guarded by
`sys.platform == 'win32'`, so `import backend_windows` works on Linux (for the
test-suite) with no Win32 installed.

## Windows-only tools (`tools_windows.py`)

`server_windows.main()` calls `tools_windows.register(computer_use_mcp.server.mcp)` before
starting the server. FastMCP reads its tool manager on every `tools/list`, and
`policy.install` gates `call_tool` by name at call time. So these tools show up to every
brain and go through the same trust and plan-mode checks. The read-only ones are added to
`policy._PLAN_SAFE_TOOLS`.

| Module | Provides |
|---|---|
| `backend_windows.py` | New primitives: `drag_smooth` (with `smooth_path`), `click_ex`, `mouse_down`/`mouse_up`, `key_down`/`key_up` (held-input registry plus a 15s watchdog, `release_all`), `hover`, `scroll_smooth`, `type_text_paced`. All of them publish to `agent_bus`. |
| `win_platform.py` | Clipboard (text and TSV/CF_HTML tables), windows (`win:<hwnd>` ids), apps (`Get-StartApps`, Start-menu shortcuts, ShellExecute), virtual desktops. |
| `win_uia.py` | UI Automation via the `uiautomation` package (comtypes). Element ids are `<hwnd>:<i>.<j>…` child-index paths, and live elements are cached. |
| `win_office.py` | Excel/Word/PowerPoint through late-bound `win32com` (no gencache). |
| `tools_windows.py` | The MCP tool definitions. They overlap the existing tools only in the `desktop_calibrate` and `desktop_reset` overrides. |

Safety rules: `list_windows('sway'|'agent')` returns `[]` outside the sandbox, so the
engine's `desktop_reset` can never close the user's real windows. On the host, the overridden
`desktop_reset` refuses outright. Every held key or button is released in `finally`, or by
the watchdog.

New Win32 deps are lazy-imported and need matching flags in `windows/scripts/build.ps1`
(`--hidden-import win32clipboard/pythoncom/win32com.client`, `--collect-all uiautomation`,
`--collect-submodules comtypes`) plus `uiautomation` in `requirements-windows.txt`.

## Running on Windows

```powershell
cd windows\engine
pip install -e ..\..\computer-use        # the engine package (provides pillow + server)
pip install -r requirements-windows.txt  # pywin32 + mss
python server_windows.py
```

`server_windows.py` also installs a tiny `os.getuid` shim **before** importing the
engine — the engine's `session.py` / `config.py` call `os.getuid()` at import
time, which doesn't exist on Windows (no engine edit needed; the shim lives here).

## Not available on Windows (Linux-only → Windows v2)

- **Nested headless "agent" desktop** (`which="agent"`): the co-worker brain's
  isolated Sway desktop is Linux/wlroots-only. `get_session("agent")` raises a
  clear `RuntimeError`. The `/video` stream defaults to `which="agent"` and so
  needs `which="active"` on Windows.
- **KWin multi-seat** (the agent's own cursor/keyboard seat): KWin-fork specific.
- **Cursor capture in screenshots**: `mss` has no cursor overlay
  (`include_cursor` is advisory only).

## Tests

Run on Linux (Win32 mocked / import-guarded):

```bash
env -u PYTHONPATH ../../computer-use/.venv/bin/python -m pytest tests -q
```

`tests/test_tools_windows.py` covers the new layer: `smooth_path` bounds; that
`drag_smooth` holds the button through every intermediate move and always releases it; the
watchdog; modifier clicks; the TSV/CF_HTML codecs; the platform patches; the
`desktop_reset` safety rule; and tool registration and schemas.

Covers: absolute-coordinate normalization math, VK-table completeness vs
`input._KEY_CODES`, `import backend_windows` with no Win32, and that the
`server_windows` monkeypatch actually rebinds the engine primitives to the
backend (identity + an end-to-end `input.move` route).
