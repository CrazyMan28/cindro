"""Windows-only MCP tools, registered on the engine's FastMCP instance.

``server_windows.main()`` calls ``register(computer_use_mcp.server.mcp)`` before
starting the server, so these sit next to the engine's own tools (same trust /
plan-mode gate -- ``policy.install`` wraps ``call_tool`` by name at call time).
Nothing under ``computer-use/`` is edited.

Groups:
  * human-style input -- real held drags, modifier clicks, hold/release,
    hover, fine scroll, paced typing, waiting on the screen
  * spreadsheet helpers -- address-based (Name Box via UIA) go-to / read /
    write of ranges through the clipboard (Excel for the web in Chrome, Google
    Sheets, desktop Excel all accept TSV paste / produce TSV on copy)
  * on-screen text (built-in Windows OCR) -- read, find and click by text
  * UI Automation -- read and drive controls by name (``ui_*``)
  * desktop Office COM -- Excel / Word / PowerPoint object models
  * Windows-correct overrides of two engine tools (desktop_calibrate,
    desktop_reset)
"""

from __future__ import annotations

import io
import json
import time

from mcp.server.fastmcp import FastMCP, Image

from computer_use_mcp import policy, screen, selfheal

import backend_windows as bw
import win_ocr as ocr
import win_office as office
import win_platform as wp
import win_sheet as sheet
import win_uia as uia

# Read-only tools that stay usable in PLAN mode (policy._PLAN_SAFE_TOOLS is a
# module global the gate reads per call, so extending it here is enough).
PLAN_SAFE = frozenset({
    "mouse_position", "wait_for_screen_change", "wait_for_screen_idle",
    "clipboard_get_table", "clipboard_formats",
    "ui_tree", "ui_find", "ui_focused", "ui_element_at",
    "office_status", "excel_read_range", "word_read", "ppt_list_slides",
    "screen_ocr", "screen_find_text", "window_screenshot", "sheet_active_cell",
})

# Engine tools whose Linux bodies are wrong on Windows; replaced in register().
OVERRIDDEN = ("desktop_calibrate", "desktop_reset")


def _err(exc: Exception, hint: str | None = None) -> str:
    out = {"error": str(exc)}
    if hint:
        out["hint"] = hint
    return json.dumps(out)


def _healed(tool: str, which: str, action) -> dict:
    """selfheal.run + lift self_heal.screen_changed to the top level."""
    res = selfheal.run(tool, which, action)
    if isinstance(res, dict):
        res = {**res, "screen_changed": (res.get("self_heal") or {}).get("screen_changed")}
    return res


# ---------------------------------------------------------------------------
# Screen-change waiting (reuses selfheal's thumbnail delta)
# ---------------------------------------------------------------------------
def _thumb(region: dict | None, which: str) -> bytes | None:
    if region is None:
        return selfheal._thumb(which)
    try:
        from PIL import Image as PILImage
        with screen._LOCK:
            saved = screen.LAST_SHOT
        try:
            png, _meta = screen.take_screenshot(region=region, max_width=256, which=which)
        finally:
            with screen._LOCK:
                screen.LAST_SHOT = saved
        img = PILImage.open(io.BytesIO(png)).convert("L").resize((32, 32), PILImage.BOX)
        return img.tobytes()
    except Exception:
        return None


def _region(x, y, w, h) -> dict | None:
    if None in (x, y, w, h):
        return None
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def wait_change(timeout_s: float, interval_s: float, region, which: str,
                clock=time.monotonic, sleep=time.sleep, thumb=_thumb) -> dict:
    start = clock()
    base = thumb(region, which)
    if base is None:
        raise RuntimeError("can't capture the screen to compare")
    while clock() - start < timeout_s:
        sleep(interval_s)
        cur = thumb(region, which)
        if cur is not None and selfheal._delta(base, cur) >= selfheal._DIFF_THRESHOLD:
            return {"changed": True, "waited_s": round(clock() - start, 2)}
    return {"changed": False, "waited_s": round(clock() - start, 2)}


def wait_idle(quiet_s: float, timeout_s: float, interval_s: float, region, which: str,
              clock=time.monotonic, sleep=time.sleep, thumb=_thumb) -> dict:
    start = clock()
    prev = thumb(region, which)
    if prev is None:
        raise RuntimeError("can't capture the screen to compare")
    still_since = clock()
    while clock() - start < timeout_s:
        sleep(interval_s)
        cur = thumb(region, which)
        if cur is None:
            continue
        if selfheal._delta(prev, cur) >= selfheal._DIFF_THRESHOLD:
            still_since = clock()
        prev = cur
        if clock() - still_since >= quiet_s:
            return {"idle": True, "waited_s": round(clock() - start, 2)}
    return {"idle": False, "waited_s": round(clock() - start, 2)}


# ---------------------------------------------------------------------------
# Spreadsheet helpers
# ---------------------------------------------------------------------------
def _saved_clipboard() -> str | None:
    try:
        return wp.clipboard_paste()
    except Exception:
        return None


def _restore_clipboard(text: str | None) -> None:
    if text is None:
        return
    try:
        wp.clipboard_copy(text)
    except Exception:
        pass


def paste_table(rows, x=None, y=None, coord_space="image", include_html=False,
                restore_clipboard=True, settle_ms=1000, ref=None, window=None) -> dict:
    if not rows or not isinstance(rows, list):
        raise ValueError("rows must be a non-empty list of row lists")
    rows = [r if isinstance(r, list) else [r] for r in rows]
    prior = _saved_clipboard() if restore_clipboard else None
    if ref:
        sheet.goto(sheet.top_left(ref), window)
    elif x is not None and y is not None:
        bw.click(x, y, coord_space=coord_space)
        time.sleep(0.15)
    info = wp.clipboard_set_table(rows, include_html=include_html)
    bw.key_press("ctrl+v")
    # The app reads the clipboard asynchronously after the keystroke; restoring
    # too early would paste the OLD contents.
    time.sleep(max(0, min(5000, int(settle_ms))) / 1000.0)
    _restore_clipboard(prior)
    return {"pasted": True, **info}


def read_selection(restore_clipboard=True, timeout_ms=2500) -> dict:
    prior = _saved_clipboard() if restore_clipboard else None
    wp.clipboard_copy("")                 # so a failed copy can't return stale data
    bw.key_press("ctrl+c")
    deadline = time.monotonic() + max(200, int(timeout_ms)) / 1000.0
    text = ""
    while time.monotonic() < deadline:
        time.sleep(0.12)
        text = _saved_clipboard() or ""
        if text:
            break
    _restore_clipboard(prior)
    if not text:
        raise RuntimeError("nothing was copied -- select cells first (click / shift+click / "
                           "mouse_drag_smooth) and make sure the sheet has focus")
    rows = wp.tsv_to_rows(text)
    return {"rows": rows, "row_count": len(rows),
            "col_count": max((len(r) for r in rows), default=0)}


def read_range(ref, window=None, restore_clipboard=True) -> dict:
    sheet.goto(ref, window)
    time.sleep(0.2)
    out = read_selection(restore_clipboard)
    return {"ref": ref, **out}


def _area(window, region_x, region_y, region_w, region_h):
    return {"window": window or None, "region": _region(region_x, region_y, region_w, region_h)}


def ocr_find(text, exact, scale, lang, window, region) -> dict:
    res = ocr.read(region, window, scale, lang)
    # reading order: top-to-bottom (rows within ~8px count as one), then left-to-right
    hits = sorted(ocr.find_phrase(res["lines"], text, exact),
                  key=lambda h: (h["rect"][1] // 8, h["rect"][0]))
    return {"text": text, "count": len(hits), "matches": hits,
            "captured_rect": res["captured_rect"]}


def click_text_impl(text, occurrence=1, exact=False, button="left", clicks=1, modifiers="",
               scale=2.0, lang=None, window=None, region=None) -> dict:
    found = ocr_find(text, exact, scale, lang, window, region)
    hits = found["matches"]
    if not hits:
        raise RuntimeError(f"text {text!r} not found on screen (OCR). Screenshot to check "
                           "it's visible; try a shorter/partial phrase or a window= filter.")
    n = int(occurrence)
    if not 1 <= n <= len(hits):
        raise RuntimeError(f"only {len(hits)} match(es) for {text!r}; occurrence={n}")
    cx, cy = hits[n - 1]["center"]
    res = bw.click_ex(cx, cy, button, clicks, modifiers, 0, "desktop", "active")
    return {"clicked_text": hits[n - 1]["text"], "matches": len(hits), **res}


# ---------------------------------------------------------------------------
# Windows-correct overrides
# ---------------------------------------------------------------------------
def calibrate() -> dict:
    active = bw.get_session("active")
    results = []
    for o in active.outputs:
        target = (o.x + o.w // 2, o.y + o.h // 2)
        bw.move(target[0], target[1], "desktop")
        time.sleep(0.12)
        actual = bw._cursor_pos()
        if actual is None:
            results.append({"output": o.name, "target": list(target), "actual": None,
                            "error_px": None})
            continue
        results.append({"output": o.name, "target": list(target), "actual": list(actual),
                        "error_px": max(abs(actual[0] - target[0]), abs(actual[1] - target[1]))})
    errs = [r["error_px"] for r in results if r["error_px"] is not None]
    max_err = max(errs, default=None)
    return {"ok": max_err is not None and max_err <= 3, "max_error_px": max_err,
            "method": "getcursorpos", "outputs": results}


def reset_agent_desktop() -> dict:
    if not bw.in_sandbox():
        raise RuntimeError(
            "desktop_reset only resets the ISOLATED agent desktop. This engine drives "
            "your real Windows screen, where it would close YOUR windows -- so it's "
            "disabled here. Use window_close on specific windows instead.")
    closed = 0
    for w in wp.list_windows("agent"):
        try:
            wp.close(w["id"])
            closed += 1
        except Exception:
            pass
    return {"ok": True, "closed": closed}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------
def register(mcp: FastMCP) -> None:  # noqa: C901 - flat list of tool defs
    mgr = mcp._tool_manager
    for name in OVERRIDDEN:
        mgr._tools.pop(name, None)
    policy._PLAN_SAFE_TOOLS = frozenset(policy._PLAN_SAFE_TOOLS | PLAN_SAFE)

    # -- human-style input ---------------------------------------------------

    @mcp.tool()
    def mouse_drag_smooth(
        from_x: int, from_y: int, to_x: int, to_y: int,
        steps: int = 12, step_delay_ms: int = 30,
        coord_space: str = "desktop", button: str = "left", which: str = "active",
    ) -> str:
        """REAL hold-move-release drag (not a teleport): moves to (from_x,from_y),
        presses and HOLDS the button, glides through `steps` points (+-2px hand
        jitter, `step_delay_ms` apart) to (to_x,to_y), then releases there. Fires
        genuine mousedown / mousemove-with-button-held / mouseup inside browser
        content. Use it for: Excel/Sheets fill handle, selecting a cell range,
        resizing columns/rows, drag-and-drop, sliders, drawing. coord_space
        defaults to 'desktop' (read coordinates off the screenshot grid labels);
        'image' and 'output:NAME' also work. Slow it down (steps=25,
        step_delay_ms=40) if an app misses the drag. Returns {dragged,
        screen_changed}."""
        try:
            return json.dumps(_healed("mouse_drag_smooth", which, lambda: bw.drag_smooth(
                from_x, from_y, to_x, to_y, steps, step_delay_ms, button, coord_space, which)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_click_ex(
        x: float | None = None, y: float | None = None, button: str = "left",
        clicks: int = 1, modifiers: str = "", hold_ms: int = 0,
        coord_space: str = "image", which: str = "active",
    ) -> str:
        """Click like a person: hold modifier keys during the click
        (modifiers='shift' extends a selection -- e.g. click A1 then shift-click
        D20 to select A1:D20; 'ctrl' adds to a selection / opens links in a new
        tab; combos like 'ctrl+shift' work), clicks=2 double / 3 triple-click
        (select a whole line/paragraph), hold_ms>0 long-press. Modifiers are
        always released afterwards. Omit x/y to click in place."""
        try:
            return json.dumps(_healed("mouse_click_ex", which, lambda: bw.click_ex(
                x, y, button, clicks, modifiers, hold_ms, coord_space, which)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_down(x: float | None = None, y: float | None = None, button: str = "left",
                   coord_space: str = "image", which: str = "active") -> str:
        """Press and HOLD a mouse button (optionally moving to x/y first). Pair
        with mouse_move / mouse_up for custom drag paths. Anything still held
        after 15s is auto-released; input_release_all frees it immediately."""
        try:
            return json.dumps(bw.mouse_down(x, y, button, coord_space, which))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_up(x: float | None = None, y: float | None = None, button: str = "left",
                 coord_space: str = "image", which: str = "active") -> str:
        """Release a held mouse button (optionally moving to x/y first, which
        drops a drag there)."""
        try:
            return json.dumps(_healed("mouse_up", which, lambda: bw.mouse_up(
                x, y, button, coord_space, which)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def key_down(combo: str) -> str:
        """Press and HOLD key(s), e.g. 'shift' or 'ctrl+alt', so following
        clicks/keys are modified (shift + arrow keys to grow a selection, ctrl
        + clicks to multi-select). ALWAYS follow with key_up (same combo).
        Auto-released after 15s as a safety net."""
        try:
            return json.dumps(bw.key_down(combo))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def key_up(combo: str) -> str:
        """Release key(s) held by key_down."""
        try:
            return json.dumps(bw.key_up(combo))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def input_release_all() -> str:
        """Release every mouse button and key held by mouse_down/key_down. Use
        it if the user reports a stuck shift/ctrl or a never-ending drag."""
        try:
            return json.dumps(bw.release_all())
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_hover(x: float, y: float, dwell_ms: int = 600, coord_space: str = "image",
                    which: str = "active") -> str:
        """Glide to a point and rest there so hover UI opens (tooltips, menus
        that open on hover, Excel cell comments, link previews)."""
        try:
            return json.dumps(_healed("mouse_hover", which, lambda: bw.hover(
                x, y, dwell_ms, coord_space, which)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def mouse_position() -> str:
        """Where the real OS cursor is right now (desktop pixels)."""
        try:
            return json.dumps(bw.mouse_position())
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def scroll_smooth(amount: float = 1, direction: str = "down",
                      x: float | None = None, y: float | None = None,
                      delta_per_step: int = 40, coord_space: str = "image",
                      which: str = "active") -> str:
        """Fine-grained scrolling: `amount` wheel notches (fractions OK, e.g.
        0.5) sent in small deltas -- scrolls a spreadsheet grid / long page a few
        rows at a time instead of jumping a whole screen. Move to x/y first so it
        scrolls the right pane."""
        try:
            return json.dumps(_healed("scroll_smooth", which, lambda: bw.scroll_smooth(
                amount, direction, x, y, delta_per_step, coord_space, which)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def type_text_paced(text: str, delay_ms: int = 12) -> str:
        """Type like a person, one character at a time with `delay_ms` between
        -- for web apps that drop characters from a fast burst (Excel for the
        web, Google Sheets/Docs, chat boxes, remote desktops). \\n = Enter, \\t
        = Tab (moves to the next cell in a sheet)."""
        try:
            return json.dumps(_healed("type_text_paced", "active",
                                      lambda: bw.type_text_paced(text, delay_ms)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def wait_for_screen_change(timeout_s: float = 10, interval_s: float = 0.4,
                               region_x: int | None = None, region_y: int | None = None,
                               region_w: int | None = None, region_h: int | None = None,
                               which: str = "active") -> str:
        """Block until the screen (or a desktop-pixel region) visibly changes,
        or timeout. Use after an action whose effect is slow (page load, file
        open, a sheet recalculating) instead of sleeping blindly."""
        try:
            return json.dumps(wait_change(min(120.0, float(timeout_s)), max(0.1, float(interval_s)),
                                          _region(region_x, region_y, region_w, region_h), which))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def wait_for_screen_idle(quiet_s: float = 1.0, timeout_s: float = 15,
                             interval_s: float = 0.3,
                             region_x: int | None = None, region_y: int | None = None,
                             region_w: int | None = None, region_h: int | None = None,
                             which: str = "active") -> str:
        """Block until the screen (or region) has stopped changing for quiet_s
        seconds -- i.e. a page / app finished loading or animating."""
        try:
            return json.dumps(wait_idle(max(0.2, float(quiet_s)), min(120.0, float(timeout_s)),
                                        max(0.1, float(interval_s)),
                                        _region(region_x, region_y, region_w, region_h), which))
        except Exception as exc:
            return _err(exc)

    # -- clipboard tables / spreadsheets ---------------------------------------

    @mcp.tool()
    def clipboard_set_table(rows: list[list], include_html: bool = False) -> str:
        """Put a table on the clipboard as TSV (what Excel, Excel for the web
        and Google Sheets paste as separate cells). include_html=True also adds
        an HTML table (keeps it a table when pasting into Word/Outlook/Docs)."""
        try:
            return json.dumps(wp.clipboard_set_table(rows, include_html))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def clipboard_get_table() -> str:
        """Read the clipboard as a table (after copying cells from any
        spreadsheet or HTML table)."""
        try:
            rows = wp.clipboard_get_table()
            return json.dumps({"rows": rows, "row_count": len(rows)})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def clipboard_formats() -> str:
        """List the formats currently on the clipboard (text, HTML, image, files)."""
        try:
            return json.dumps({"formats": wp.clipboard_formats()})
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_paste_table(rows: list[list], ref: str | None = None,
                          x: float | None = None, y: float | None = None,
                          coord_space: str = "image", include_html: bool = False,
                          restore_clipboard: bool = True, settle_ms: int = 1000,
                          window: str = "foreground") -> str:
        """FASTEST way to fill a spreadsheet (Excel for the web in Chrome,
        Google Sheets, desktop Excel): pastes `rows` as real cells with ctrl+v,
        starting at cell `ref` (e.g. 'B2' -- jumps there via the Name Box, no
        coordinates needed) or at a cell you click via x/y, or at the current
        selection. Values starting with '=' become formulas (e.g.
        [["Item","Qty","Total"],["Pens","3","=B2*2"]]). Hundreds of cells land in
        one action instead of typing cell by cell, and Excel's AutoComplete
        can't alter them. The user's clipboard is restored afterwards.
        Screenshot to confirm."""
        try:
            return json.dumps(_healed("sheet_paste_table", "active", lambda: paste_table(
                rows, x, y, coord_space, include_html, restore_clipboard, settle_ms,
                ref, window)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_read_selection(restore_clipboard: bool = True, timeout_ms: int = 2500) -> str:
        """Read the currently SELECTED cells of a spreadsheet as rows (copies
        with ctrl+c and parses the TSV; the user's clipboard is restored).
        Select first: click a cell, shift-click the far corner
        (mouse_click_ex modifiers='shift'), ctrl+a for the whole sheet, or
        sheet_goto 'A1:F50'. Far more reliable than reading numbers off a
        screenshot."""
        try:
            return json.dumps(read_selection(restore_clipboard, timeout_ms))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_goto(ref: str, window: str = "foreground", method: str = "auto") -> str:
        """Jump to / select a cell or range BY ADDRESS in a web spreadsheet
        (Excel for the web in Chrome, Google Sheets) or desktop Excel: ref like
        'B7', 'A1:D20', 'C:C', 'Sheet2!C3'. Types into the Name Box (found via UI
        Automation, no pixel guessing); falls back to Excel's ctrl+g Go To box
        only after confirming it opened. window: 'foreground' or a title
        substring like 'Excel' (it's focused first)."""
        try:
            return json.dumps(_healed("sheet_goto", "active",
                                      lambda: sheet.goto(ref, window, method)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_read_range(ref: str, window: str = "foreground",
                         restore_clipboard: bool = True) -> str:
        """Read a range BY ADDRESS (e.g. 'A1:F40', 'Sheet2!B:B') from a web
        spreadsheet / Excel: selects it via the Name Box, copies, and returns the
        exact cell values as rows. Use this instead of reading numbers off a
        screenshot. (Formulas come back as their displayed values.)"""
        try:
            return json.dumps(read_range(ref, window, restore_clipboard))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_set_cell(ref: str, value: str, window: str = "foreground") -> str:
        """Put one value or formula (e.g. '=SUM(B2:B9)') into cell `ref` -- goes
        there by address and pastes, so AutoComplete can't change it. For many
        cells use sheet_paste_table."""
        try:
            return json.dumps(_healed("sheet_set_cell", "active", lambda: paste_table(
                [[value]], ref=sheet.top_left(ref), window=window)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_active_cell(window: str = "foreground") -> str:
        """Which cell is selected (Name Box address) and what the formula bar
        shows (its formula, not just the value) -- read through UI Automation,
        best effort."""
        try:
            return json.dumps(sheet.active_cell(window))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def sheet_shortcut(action: str, repeat: int = 1) -> str:
        """Run a named spreadsheet keyboard shortcut (works in Excel for the
        web): undo, redo, copy, cut, paste, paste_values, bold, italic,
        underline, fill_down, fill_right, select_all, select_column, select_row,
        extend_down/up/left/right, jump_down/up/left/right, go_top,
        go_last_cell, next_sheet, prev_sheet, edit_cell, clear, cancel, confirm,
        next_cell, new_line_in_cell, find, replace, insert_link, insert_cells,
        delete_cells, format_currency, format_percent, format_cells, save."""
        try:
            return json.dumps(_healed("sheet_shortcut", "active",
                                      lambda: sheet.shortcut(action, repeat)))
        except Exception as exc:
            return _err(exc)

    # -- on-screen text (Windows OCR) -----------------------------------------------

    @mcp.tool()
    def screen_ocr(window: str | None = None, region_x: int | None = None,
                   region_y: int | None = None, region_w: int | None = None,
                   region_h: int | None = None, scale: float = 2.0,
                   include_words: bool = False, lang: str | None = None) -> str:
        """Read the TEXT on screen with the built-in Windows OCR (offline):
        every line with its desktop-pixel box [x,y,w,h]. Limit it to a window
        (title substring, e.g. 'Excel') or a desktop region for speed and
        accuracy. Great for reading a spreadsheet grid, a web page, or any app
        whose text you need exactly."""
        try:
            area = _area(window, region_x, region_y, region_w, region_h)
            res = ocr.read(area["region"], area["window"], scale, lang)
            if not include_words:
                for line in res["lines"]:
                    line.pop("words", None)
            res["lines"] = res["lines"][:600]
            return json.dumps(res)
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def screen_find_text(text: str, window: str | None = None, exact: bool = False,
                         region_x: int | None = None, region_y: int | None = None,
                         region_w: int | None = None, region_h: int | None = None,
                         scale: float = 2.0, lang: str | None = None) -> str:
        """Find where a word/phrase appears on screen (OCR): every match with
        its desktop box and centre -- click a centre with coord_space='desktop'.
        Case-insensitive; exact=True requires the whole OCR word run to match."""
        try:
            area = _area(window, region_x, region_y, region_w, region_h)
            return json.dumps(ocr_find(text, exact, scale, lang, area["window"], area["region"]))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def click_text(text: str, occurrence: int = 1, window: str | None = None,
                   exact: bool = False, button: str = "left", clicks: int = 1,
                   modifiers: str = "",
                   region_x: int | None = None, region_y: int | None = None,
                   region_w: int | None = None, region_h: int | None = None,
                   scale: float = 2.0) -> str:
        """Click on visible TEXT, like a person reading the screen: 'Total',
        'Sheet2', 'Insert', a cell value, a link. occurrence picks the Nth
        match (top-to-bottom, left-to-right); clicks=2 double-clicks (e.g. to
        edit a cell or rename a sheet tab); modifiers='shift'/'ctrl' work too."""
        try:
            area = _area(window, region_x, region_y, region_w, region_h)
            return json.dumps(_healed("click_text", "active", lambda: click_text_impl(
                text, occurrence, exact, button, clicks, modifiers, scale, None,
                area["window"], area["region"])))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def window_screenshot(window: str = "foreground", max_width: int | None = None,
                          include_cursor: bool = False) -> list:
        """Screenshot just one window (default: the focused one; or a title
        substring like 'Excel' / 'Chrome'). Sharper than a whole-desktop shot on
        multi-monitor setups. Image coordinates work with the mouse tools like
        desktop_screenshot's."""
        try:
            if window == "foreground":
                import ctypes
                window = f"win:{ctypes.windll.user32.GetForegroundWindow()}"
            r = ocr._capture_rect(None, window)
            png, meta = screen.take_screenshot(region=r.as_dict(), max_width=max_width,
                                               include_cursor=include_cursor)
            return [Image(data=png, format="png"), json.dumps(meta)]
        except Exception as exc:
            return [_err(exc)]

    # -- UI Automation ----------------------------------------------------------

    @mcp.tool()
    def ui_tree(window: str = "foreground", max_depth: int = 6, max_nodes: int = 300,
                visible_only: bool = True) -> str:
        """Accessibility tree of a window (default: the focused one): every
        control's eid, name, type, desktop rect [x,y,w,h], value and supported
        actions (invoke/value/toggle/expand/select). window: 'foreground', a
        window_list id ('win:123') or a title substring. Then act by eid with
        ui_click / ui_set_value / ui_toggle -- exact, no pixel guessing. Works
        for native apps, Office, File Explorer, Settings, dialogs; for web page
        content prefer browser_snapshot."""
        try:
            return json.dumps(uia.tree(window, max_depth, max_nodes, visible_only))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_find(name: str | None = None, control_type: str | None = None,
                automation_id: str | None = None, window: str = "foreground",
                max_results: int = 20) -> str:
        """Find controls by name substring and/or type ('Button', 'Edit',
        'MenuItem', 'CheckBox', 'ListItem', 'TabItem', 'Hyperlink', ...) and/or
        automation id, searching the whole window."""
        try:
            return json.dumps(uia.find(name, control_type, automation_id, window, max_results))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_focused() -> str:
        """The control that currently has keyboard focus."""
        try:
            return json.dumps(uia.focused())
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_element_at(x: float, y: float, coord_space: str = "image") -> str:
        """Which control is under a screen point -- confirm what a click would
        hit BEFORE clicking."""
        try:
            return json.dumps(uia.element_at(x, y, coord_space))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_click(eid: str | None = None, name: str | None = None,
                 control_type: str | None = None, automation_id: str | None = None,
                 window: str = "foreground", method: str = "auto",
                 button: str = "left", double: bool = False) -> str:
        """Click a control by eid (from ui_tree/ui_find) or by name/type.
        method 'auto' uses its Invoke action when it has one (works even if
        partly covered), else a real mouse click on its centre; force with
        'invoke' or 'mouse'."""
        try:
            return json.dumps(_healed("ui_click", "active", lambda: uia.click(
                eid, name, control_type, automation_id, window, method, button, double)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_set_value(text: str, eid: str | None = None, name: str | None = None,
                     control_type: str | None = None, automation_id: str | None = None,
                     window: str = "foreground") -> str:
        """Set a text box / combo box / field's value directly (replaces its
        contents). Falls back to click + select-all + typing."""
        try:
            return json.dumps(_healed("ui_set_value", "active", lambda: uia.set_value(
                text, eid, name, control_type, automation_id, window)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_toggle(eid: str | None = None, name: str | None = None,
                  control_type: str | None = None, automation_id: str | None = None,
                  window: str = "foreground") -> str:
        """Flip a checkbox / toggle switch."""
        try:
            return json.dumps(_healed("ui_toggle", "active", lambda: uia.toggle(
                eid, name, control_type, automation_id, window)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_expand(expand: bool = True, eid: str | None = None, name: str | None = None,
                  control_type: str | None = None, automation_id: str | None = None,
                  window: str = "foreground") -> str:
        """Expand (or collapse with expand=False) a menu, combo box, tree node
        or ribbon group."""
        try:
            return json.dumps(_healed("ui_expand", "active", lambda: uia.expand(
                expand, eid, name, control_type, automation_id, window)))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ui_select(eid: str | None = None, name: str | None = None,
                  control_type: str | None = None, automation_id: str | None = None,
                  window: str = "foreground") -> str:
        """Select a list item / tab / radio button / tree item."""
        try:
            return json.dumps(_healed("ui_select", "active", lambda: uia.select(
                eid, name, control_type, automation_id, window)))
        except Exception as exc:
            return _err(exc)

    # -- desktop Office (COM) ---------------------------------------------------

    @mcp.tool()
    def office_status() -> str:
        """Which desktop Office apps (Excel/Word/PowerPoint) are installed and
        running, and their open documents. Desktop Office only -- Office on the
        web lives in the browser."""
        try:
            return json.dumps(office.status())
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def office_open(path: str) -> str:
        """Open a file in the matching desktop Office app (.xlsx/.csv -> Excel,
        .docx -> Word, .pptx -> PowerPoint)."""
        try:
            return json.dumps(office.open_file(path))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def excel_read_range(range: str | None = None, sheet: str | None = None,
                         book: str | None = None, formulas: bool = False) -> str:
        """Read cell values from DESKTOP Excel (default: the active sheet's used
        range) as rows; formulas=True also returns the formulas."""
        try:
            return json.dumps(office.excel_read(range, sheet, book, formulas))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def excel_write_range(start: str, rows: list[list], sheet: str | None = None,
                          book: str | None = None) -> str:
        """Write rows into DESKTOP Excel starting at cell `start` (e.g. 'A1').
        Strings starting with '=' are formulas."""
        try:
            return json.dumps(office.excel_write(start, rows, sheet, book))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def excel_run(action: str, arg: str | None = None, sheet: str | None = None,
                  book: str | None = None) -> str:
        """DESKTOP Excel workbook actions: save, save_as (arg=path), recalc,
        autofit, add_sheet (arg=name), activate_sheet (arg=name), list_sheets,
        select (arg=range), new_workbook."""
        try:
            return json.dumps(office.excel_run(action, arg, sheet, book))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def word_read(doc: str | None = None, max_chars: int = 20000) -> str:
        """Read the text of a DESKTOP Word document (default: the active one)."""
        try:
            return json.dumps(office.word_read(doc, max_chars))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def word_insert(text: str, where: str = "end", doc: str | None = None) -> str:
        """Insert text into a DESKTOP Word document: where = end / start /
        cursor."""
        try:
            return json.dumps(office.word_insert(text, where, doc))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def word_find_replace(find: str, replace: str, doc: str | None = None,
                          match_case: bool = False, whole_word: bool = False) -> str:
        """Find-and-replace all in a DESKTOP Word document."""
        try:
            return json.dumps(office.word_find_replace(find, replace, doc, match_case, whole_word))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def word_save_as(path: str, format: str = "docx", doc: str | None = None) -> str:
        """Save a DESKTOP Word document as docx / pdf / txt / rtf."""
        try:
            return json.dumps(office.word_save_as(path, format, doc))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ppt_list_slides(pres: str | None = None) -> str:
        """List the slides of a DESKTOP PowerPoint presentation with each
        shape's name and text."""
        try:
            return json.dumps(office.ppt_list(pres))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ppt_add_slide(title: str = "", body: str = "", layout: int = 2,
                      index: int | None = None, pres: str | None = None) -> str:
        """Add a slide to DESKTOP PowerPoint (layout 1 title, 2 title+content,
        11 title only, 12 blank); fills title/body placeholders."""
        try:
            return json.dumps(office.ppt_add_slide(title, body, layout, index, pres))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ppt_set_text(slide: int, shape: str, text: str, pres: str | None = None) -> str:
        """Replace the text of a shape (name or 1-based index from
        ppt_list_slides) on a DESKTOP PowerPoint slide."""
        try:
            return json.dumps(office.ppt_set_text(slide, shape, text, pres))
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def ppt_export(path: str, format: str = "pptx", pres: str | None = None) -> str:
        """Save a DESKTOP PowerPoint presentation as pptx or pdf."""
        try:
            return json.dumps(office.ppt_export(path, format, pres))
        except Exception as exc:
            return _err(exc)

    # -- Windows-correct overrides of engine tools ---------------------------------

    @mcp.tool()
    def desktop_calibrate() -> str:
        """Verify pointer accuracy: move the cursor to each monitor's centre and
        read back where it really landed (GetCursorPos). Reports per-monitor
        error in pixels."""
        try:
            return json.dumps(calibrate(), indent=1)
        except Exception as exc:
            return _err(exc)

    @mcp.tool()
    def desktop_reset() -> str:
        """Reset YOUR OWN isolated agent desktop (close every window on it).
        Only works inside the isolated Windows agent box -- on the real screen
        it refuses rather than close the user's windows."""
        try:
            return json.dumps(reset_agent_desktop())
        except Exception as exc:
            return _err(exc)
