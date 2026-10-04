"""Spreadsheet-on-a-website helpers (Excel for the web in Chrome, Google Sheets).

The grid of a web spreadsheet has no object model the engine can reach, so
everything here is done the way a person does it, with real keyboard and mouse
input:

  * GO TO a cell/range by its address through the Name Box (the box left of
    the formula bar). It is found through UI Automation -- Chrome exposes page
    controls to UIA -- so no pixel guessing. If it can't be found, Excel's Go
    To dialog (ctrl+g) is used. That fallback first verifies the dialog really
    opened, so the address is never typed into a cell by mistake.
  * READ/WRITE ranges through the clipboard (TSV), which Excel for the web,
    Sheets and desktop Excel all speak (see tools_windows.paste_table /
    read_selection).
  * Named keyboard SHORTCUTS that work in Excel for the web.
"""

from __future__ import annotations

import re
import time

from computer_use_mcp import selfheal

import backend_windows as _bw
import win_uia as _uia

# action -> key combo. Only shortcuts that Excel for the web documents (most
# also work in Google Sheets and desktop Excel).
SHORTCUTS: dict[str, str] = {
    "undo": "ctrl+z", "redo": "ctrl+y",
    "copy": "ctrl+c", "cut": "ctrl+x", "paste": "ctrl+v",
    "paste_values": "ctrl+shift+v",
    "bold": "ctrl+b", "italic": "ctrl+i", "underline": "ctrl+u",
    "fill_down": "ctrl+d", "fill_right": "ctrl+r",
    "select_all": "ctrl+a", "select_column": "ctrl+space", "select_row": "shift+space",
    "extend_down": "ctrl+shift+down", "extend_up": "ctrl+shift+up",
    "extend_right": "ctrl+shift+right", "extend_left": "ctrl+shift+left",
    "jump_down": "ctrl+down", "jump_up": "ctrl+up",
    "jump_right": "ctrl+right", "jump_left": "ctrl+left",
    "go_top": "ctrl+home", "go_last_cell": "ctrl+end",
    "next_sheet": "ctrl+pagedown", "prev_sheet": "ctrl+pageup",
    "edit_cell": "f2", "clear": "delete", "cancel": "escape", "confirm": "enter",
    "next_cell": "tab", "new_line_in_cell": "alt+enter",
    "find": "ctrl+f", "replace": "ctrl+h", "insert_link": "ctrl+k",
    "insert_cells": "ctrl+shift+equal", "delete_cells": "ctrl+minus",
    "format_currency": "ctrl+shift+4", "format_percent": "ctrl+shift+5",
    "format_cells": "ctrl+1", "save": "ctrl+s",
}

_REF_RE = re.compile(r"^(?:(?:'[^']+'|[^!]+)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$"
                     r"|^(?:(?:'[^']+'|[^!]+)!)?\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$"
                     r"|^(?:(?:'[^']+'|[^!]+)!)?\$?\d+:\$?\d+$")

_NAMEBOX_CACHE: dict[str, str] = {}   # window key -> eid of its Name Box


def valid_ref(ref: str) -> bool:
    """A1 refs: 'B7', 'A1:D20', '$A$1', 'Sheet2!C3', "'My Sheet'!A1:B2",
    whole columns 'A:C' and rows '3:5'."""
    return bool(_REF_RE.match(ref.strip()))


def top_left(ref: str) -> str:
    """'Sheet2!B2:D9' -> 'Sheet2!B2'; 'A:C' -> 'A1'; '3:5' -> 'A3'."""
    ref = ref.strip()
    prefix = ""
    if "!" in ref:
        sheet, _, ref = ref.rpartition("!")
        prefix = sheet + "!"
    first = ref.split(":")[0].replace("$", "")
    if first.isalpha():
        first += "1"
    elif first.isdigit():
        first = "A" + first
    return prefix + first


def _win_key(window: str | None) -> str:
    """Cache key = the concrete hwnd, so a cached Name Box never belongs to a
    window that is no longer the one being targeted."""
    if not window or window == "foreground":
        import ctypes
        return str(ctypes.windll.user32.GetForegroundWindow())
    import win_platform as _wp
    return str(_wp._resolve_hwnd(window))


def _name_box(window: str | None) -> dict | None:
    """The Name Box element (UIA) of the spreadsheet in `window`, or None."""
    try:
        key = _win_key(window)
    except Exception:
        return None
    eid = _NAMEBOX_CACHE.get(key)
    if eid:
        try:
            ctl, _e = _uia._resolve(eid, None, None, None, window)
            node = _uia._describe(ctl, eid, 0, with_patterns=False)
            if "name box" in node["name"].lower() and node["rect"][2] > 0:
                return node
        except Exception:
            pass
        _NAMEBOX_CACHE.pop(key, None)
    try:
        res = _uia.find(name="name box", window=window, max_results=6, max_depth=40,
                        max_nodes=8000)
    except Exception:
        return None
    els = [e for e in res["elements"] if e["rect"][2] > 0 and e["rect"][3] > 0]
    els.sort(key=lambda e: (e["type"] not in ("Edit", "ComboBox"), e["rect"][2] * e["rect"][3]))
    if not els:
        return None
    _NAMEBOX_CACHE[key] = els[0]["eid"]
    return els[0]


def _type_into_box(node: dict, text: str) -> None:
    x, y, w, h = node["rect"]
    _bw.click(x + w // 2, y + h // 2, coord_space="desktop")
    time.sleep(0.15)
    _bw.key_press("ctrl+a")
    _bw.type_text_paced(text, 8)
    time.sleep(0.05)
    _bw.key_press("enter")
    time.sleep(0.25)


def goto(ref: str, window: str | None = None, method: str = "auto") -> dict:
    """Select a cell/range by address. method: auto | namebox | dialog."""
    if not valid_ref(ref):
        raise ValueError(f"{ref!r} isn't a cell reference (e.g. 'B7', 'A1:D20', 'Sheet2!C3')")
    if window and window != "foreground":
        import win_platform as _wp
        _wp.activate(window)
        time.sleep(0.2)
    if method in ("auto", "namebox"):
        node = _name_box(window)
        if node is not None:
            _type_into_box(node, ref)
            return {"goto": ref, "via": "name_box"}
        if method == "namebox":
            raise RuntimeError("couldn't find the Name Box through UI Automation")
    # Go To dialog (Excel desktop + Excel for the web). Verify it opened BEFORE
    # typing, or the address would be typed into the active cell.
    before = selfheal._thumb("active")
    _bw.key_press("ctrl+g")
    opened = False
    for wait in (0.35, 0.45, 0.6):
        time.sleep(wait)
        after = selfheal._thumb("active")
        if before is None or after is None or selfheal._delta(before, after) >= selfheal._DIFF_THRESHOLD:
            opened = True
            break
    if not opened:
        raise RuntimeError(
            "couldn't open a Go To box (no Name Box found and ctrl+g did nothing). Click "
            "the Name Box left of the formula bar yourself, type the address, press Enter.")
    _bw.type_text_paced(ref, 8)
    time.sleep(0.05)
    _bw.key_press("enter")
    time.sleep(0.3)
    return {"goto": ref, "via": "goto_dialog"}


def active_cell(window: str | None = None) -> dict:
    """Address in the Name Box + text in the formula bar (UIA, best effort)."""
    out: dict = {"cell": None, "formula_bar": None}
    node = _name_box(window)
    if node is not None:
        try:
            ctl, _e = _uia._resolve(node["eid"], None, None, None, window)
            vp = _uia._pat(ctl, "ValuePattern")
            out["cell"] = (vp.Value if vp is not None else None) or None
        except Exception:
            pass
    try:
        res = _uia.find(name="formula", window=window, max_results=6, max_depth=40,
                        max_nodes=8000)
        for e in res["elements"]:
            if e.get("value") is not None or e["type"] in ("Edit", "Document"):
                out["formula_bar"] = e.get("value", "")
                break
    except Exception:
        pass
    if out["cell"] is None and out["formula_bar"] is None:
        out["hint"] = ("this page doesn't expose its Name Box / formula bar to UI "
                       "Automation -- read cells with sheet_read_range or screen_ocr")
    return out


def shortcut(action: str, repeat: int = 1) -> dict:
    combo = SHORTCUTS.get(action.strip().lower())
    if combo is None:
        raise ValueError(f"unknown action {action!r}. Known: {', '.join(sorted(SHORTCUTS))}")
    _bw.key_press(combo, repeat)
    return {"action": action, "keys": combo, "repeat": max(1, int(repeat))}
