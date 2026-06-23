"""Desktop MCP tools: session info, screenshots, mouse, keyboard, windows, clipboard."""

import json
import time

from mcp.server.fastmcp import FastMCP, Image

from computer_use_mcp import apps, clipboard, input as inp, screen, session, windows


def _err(exc: Exception, hint: str | None = None) -> str:
    out = {"error": str(exc)}
    if hint:
        out["hint"] = hint
    return json.dumps(out)


# Substrings that mark a "the nested compositor/engine isn't ready YET" failure
# (vs a real error). The daemon's /ready gate blocks the session until the
# compositor can serve a tool, but a model's very first tool call can still race
# a cold compositor; these errors get ONE automatic retry after a short wait.
_NOT_READY_MARKERS = (
    "nested compositor not ready",
    "no outputs",
    "reports no outputs",
    "session 'agent' not found",
    "session agent not found",
    "no active graphical session",
    "grim failed",
    "Connection refused",
    "broken pipe",
)


def _is_not_ready(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(m.lower() in msg for m in _NOT_READY_MARKERS)


def _retry_once_if_not_ready(fn, *, delay: float = 0.9):
    """Call fn(); if it raises a not-ready-class error, wait `delay` and retry
    ONCE. Any other error (or a second failure) propagates. Returns fn()'s value.
    This is the tool-layer one-shot retry for the first-tool-call readiness race
    (paired with the daemon's /ready gate)."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        if not _is_not_ready(exc):
            raise
        time.sleep(delay)
        return fn()


def register(mcp: FastMCP) -> None:
    @mcp.tool()
    def session_info() -> str:
        """Describe the desktop sessions: active compositor (kde/sway), TTYs,
        monitor layout (name/position/size/scale) and the desktop bounding box.
        Call this first to learn the screen geometry before screenshots/clicks."""
        try:
            d = session.detect(refresh=True)
            return json.dumps({
                "active": d["active"].kind if d["active"] else None,
                "sessions": [s.as_dict() for s in d["sessions"]],
            }, indent=2)
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def desktop_screenshot(
        output: str | None = None,
        region_x: int | None = None,
        region_y: int | None = None,
        region_w: int | None = None,
        region_h: int | None = None,
        max_width: int | None = None,
        include_cursor: bool = False,
        session_name: str = "active",
    ) -> list:
        """Screenshot the desktop. Default: the full virtual desktop of the active
        session, downscaled to max_width (config default 1536px). Pass output
        (e.g. 'HDMI-A-1') to capture one monitor, or region_x/y/w/h (desktop
        pixels) for an arbitrary rect. include_cursor=True draws the pointer —
        useful to verify mouse position. Coordinates you measure on the returned
        image can be passed straight to the mouse tools (coord_space='image')."""
        try:
            region = None
            if None not in (region_x, region_y, region_w, region_h):
                region = {"x": region_x, "y": region_y, "w": region_w, "h": region_h}
            png, meta = _retry_once_if_not_ready(lambda: screen.take_screenshot(
                output=output,
                region=region,
                max_width=max_width,
                include_cursor=include_cursor,
                which=session_name,
            ))
            return [Image(data=png, format="png"), json.dumps(meta)]
        except Exception as exc:
            return [_err(exc, hint="session_info shows monitors and sessions")]

    # -- mouse ----------------------------------------------------------------

    @mcp.tool()
    def mouse_move(x: float, y: float, coord_space: str = "image",
                   which: str = "active") -> str:
        """Move the mouse. coord_space: 'image' (coords measured on the last
        desktop_screenshot — the default), 'desktop' (global pixels), or
        'output:NAME' (pixels relative to that monitor's top-left). which:
        'active' (the real host seat, default) or 'agent' (the nested co-worker
        desktop, driven via the nested compositor — never touches your screen)."""
        try:
            gx, gy = inp.move(x, y, coord_space, which)
            return json.dumps({"moved_to_desktop": [gx, gy]})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_click(
        x: float | None = None,
        y: float | None = None,
        button: str = "left",
        double: bool = False,
        coord_space: str = "image",
        which: str = "active",
    ) -> str:
        """Click (optionally moving first — omit x/y to click in place).
        button: left/right/middle. Set double=True for a double-click.
        which='active' targets the real host seat (default); which='agent' drives
        the nested co-worker desktop."""
        try:
            return json.dumps(inp.click(x, y, button, double, coord_space, which))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_drag(
        x1: float, y1: float, x2: float, y2: float,
        button: str = "left",
        coord_space: str = "image",
        which: str = "active",
    ) -> str:
        """Press at (x1,y1), drag to (x2,y2), release. Motion is interpolated
        so drag-and-drop grab thresholds fire. which: 'active' (default) or
        'agent' (nested co-worker desktop)."""
        try:
            return json.dumps(inp.drag(x1, y1, x2, y2, button, coord_space, which=which))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def scroll(
        amount: int = 3,
        direction: str = "down",
        x: float | None = None,
        y: float | None = None,
        coord_space: str = "image",
        which: str = "active",
    ) -> str:
        """Scroll the mouse wheel (amount = notches). Optionally move to x/y
        first so the scroll lands on a specific element/window. which: 'active'
        (default) or 'agent' (nested co-worker desktop)."""
        try:
            return json.dumps(inp.scroll(amount, direction, x, y, coord_space, which))
        except Exception as exc:
            return _err(exc)

    # -- keyboard --------------------------------------------------------------

    @mcp.tool()
    def key_press(combo: str, repeat: int = 1) -> str:
        """Press a key or combo, e.g. 'Return', 'ctrl+c', 'ctrl+shift+t',
        'alt+F4', 'super'. Names are case-insensitive; use '+' to chord."""
        try:
            return json.dumps(inp.key_press(combo, repeat))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def type_text(text: str, method: str = "auto") -> str:
        """Type text into the focused window. method 'auto' types ASCII
        directly and falls back to clipboard-paste (ctrl+v) for unicode or
        long text; force with 'type' or 'paste'."""
        try:
            return json.dumps(inp.type_text(text, method))
        except Exception as exc:
            return _err(exc)

    # -- clipboard ---------------------------------------------------------------

    @mcp.tool()
    def clipboard_get(session_name: str = "active") -> str:
        """Read the clipboard text of the given session (active/kde/sway)."""
        try:
            return json.dumps({"text": clipboard.paste(session_name)})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def clipboard_set(text: str, session_name: str = "active") -> str:
        """Set the clipboard text of the given session (active/kde/sway)."""
        try:
            clipboard.copy(text, session_name)
            return json.dumps({"copied_chars": len(text)})
        except Exception as exc:
            return _err(exc)

    # -- windows ---------------------------------------------------------------

    @mcp.tool()
    def window_list(session_name: str = "all") -> str:
        """List windows with ids, titles, apps, geometry, active/minimized
        state. session_name: all/kde/sway. Ids look like 'kwin:<uuid>' or
        'sway:<id>' and feed window_activate/window_close."""
        try:
            return json.dumps({"windows": windows.list_windows(session_name)}, indent=1)
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def window_activate(window_id: str) -> str:
        """Focus/raise a window (un-minimizes it first). Use ids from
        window_list. Note: input lands in the ACTIVE session — activating a
        window of the inactive session won't receive keystrokes."""
        try:
            return json.dumps(windows.activate(window_id))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def window_close(window_id: str) -> str:
        """Ask a window to close (like clicking its X). Apps with unsaved
        changes may show a confirmation dialog instead of closing."""
        try:
            return json.dumps(windows.close(window_id))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def window_set(
        window_id: str,
        action: str,
        x: int | None = None,
        y: int | None = None,
        w: int | None = None,
        h: int | None = None,
    ) -> str:
        """Change a window's state. action: minimize, unminimize, maximize,
        fullscreen, restore, or move_resize (with x/y and/or w/h in desktop
        pixels)."""
        try:
            return json.dumps(windows.set_state(window_id, action, x, y, w, h))
        except Exception as exc:
            return _err(exc)

    # -- applications -----------------------------------------------------------

    @mcp.tool()
    def app_list(filter: str | None = None) -> str:
        """List installed desktop applications (id, name, description).
        Optionally filter by substring. Use the id or name with app_launch."""
        try:
            result = apps.list_apps(filter)
            return json.dumps({"count": len(result), "apps": [
                {"id": a["id"], "name": a["name"], "comment": a["comment"]} for a in result
            ]}, indent=1)
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def app_launch(app: str, wait_for_window: bool = True,
                   which: str | None = None) -> str:
        """Launch a desktop application by name/id (fuzzy-matched against
        installed apps, e.g. 'spotify', 'firefox', 'kcalc') or a raw command
        (e.g. 'foot'). which: 'active' (real host seat) or 'agent' (the nested
        co-worker desktop). Default auto-selects 'agent' when this engine is a
        nested agent desktop, else 'active'. On the host seat it runs in its own
        systemd unit; on the agent desktop it launches into the nested sway so
        the window maps there (never your screen). Returns new_windows so you can
        immediately window_activate/screenshot."""
        try:
            return json.dumps(_retry_once_if_not_ready(
                lambda: apps.launch(app, wait_for_window, which=which)))
        except Exception as exc:
            return _err(exc)

    # -- calibration ---------------------------------------------------------------

    @mcp.tool()
    def desktop_calibrate() -> str:
        """Verify pointer accuracy: move the cursor to each monitor's center
        and measure where it actually lands (exact via KWin on KDE; image-diff
        on sway). Reports per-output error in pixels."""
        try:
            active = session.get_session("active")
            results = []
            if active.kind == "kde":
                from computer_use_mcp.kwin_bridge import cursor_pos
                for o in active.outputs:
                    target = (o.x + o.w // 2, o.y + o.h // 2)
                    inp.move(target[0], target[1], "desktop")
                    time.sleep(0.12)
                    actual = cursor_pos()
                    results.append({
                        "output": o.name, "target": target, "actual": list(actual),
                        "error_px": max(abs(actual[0] - target[0]), abs(actual[1] - target[1])),
                    })
            else:
                results = _calibrate_sway_imagediff(active)
            max_err = max((r["error_px"] for r in results), default=None)
            return json.dumps({
                "ok": max_err is not None and max_err <= 3,
                "max_error_px": max_err,
                "method": "kwin-cursorpos" if active.kind == "kde" else "image-diff",
                "results": results,
            })
        except Exception as exc:
            return _err(exc)


def _calibrate_sway_imagediff(active) -> list:
    """Approximate cursor localization on sway: diff a small region around the
    target with the cursor away vs. on it."""
    import io
    from PIL import Image as PILImage, ImageChops

    results = []
    bbox = active.bbox
    for o in active.outputs:
        target = (o.x + o.w // 2, o.y + o.h // 2)
        region = {"x": target[0] - 80, "y": target[1] - 80, "w": 160, "h": 160}
        inp.move(bbox["x"] + 4, bbox["y"] + 4, "desktop")
        time.sleep(0.15)
        png_a, _ = screen.take_screenshot(region=region, max_width=0, include_cursor=True)
        inp.move(target[0], target[1], "desktop")
        time.sleep(0.15)
        png_b, _ = screen.take_screenshot(region=region, max_width=0, include_cursor=True)
        a = PILImage.open(io.BytesIO(png_a)).convert("RGB")
        b = PILImage.open(io.BytesIO(png_b)).convert("RGB")
        diff_box = ImageChops.difference(a, b).getbbox()
        if diff_box is None:
            results.append({"output": o.name, "target": target, "actual": None,
                            "error_px": 9999, "note": "cursor not visible in diff"})
            continue
        # The sprite's top-left approximates the arrow hotspot.
        actual = (region["x"] + diff_box[0], region["y"] + diff_box[1])
        results.append({
            "output": o.name, "target": list(target), "actual": list(actual),
            "error_px": max(abs(actual[0] - target[0]), abs(actual[1] - target[1])),
            "note": "approximate (sprite top-left vs hotspot)",
        })
    return results
