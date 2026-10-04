"""Windows UI Automation: read and drive app controls by NAME, not pixels.

Pixel clicking is the engine's universal fallback, but a vision model aiming at
a 20px button on a 4K screen misses. UI Automation (the accessibility API every
Win32 / WPF / UWP / Office / Chromium window exposes) gives exact control
names, types, rectangles and *patterns* (Invoke, Value, Toggle, ...), so a
button can be pressed or a text box filled without guessing coordinates.

Backed by the ``uiautomation`` package (pure Python over comtypes). Imported
LAZILY: this module imports on Linux for the test-suite, and every entry point
raises a clear RuntimeError off-Windows.

Element ids (``eid``) are ``"<hwnd>:<i>.<j>..."`` -- the child-index path from
the window root. ``ui_tree``/``ui_find`` also cache the live element objects so
the follow-up ``ui_click``/``ui_set_value`` hits the very same element; the path
is the fallback when the cache misses (the UI changed in between).
"""

from __future__ import annotations

import importlib
import sys
import time
from collections import deque

import backend_windows as _bw

_CACHE: dict[str, object] = {}
_CACHE_MAX = 4000
_VALUE_MAX = 200

# (uiautomation.PatternId attribute, label) -- probed per element. Uses the
# generic Control.GetPattern(id): the GetInvokePattern()-style helpers only
# exist on SOME control subclasses (a CustomControl that supports Invoke has no
# GetInvokePattern method), so they'd under-report what an element can do.
_PATTERNS = (
    ("InvokePattern", "invoke"),
    ("ValuePattern", "value"),
    ("TogglePattern", "toggle"),
    ("ExpandCollapsePattern", "expand"),
    ("SelectionItemPattern", "select"),
    ("ScrollPattern", "scroll"),
    ("RangeValuePattern", "range"),
)


def _pat(ctl, pattern: str):
    """The element's pattern object, or None when unsupported."""
    try:
        auto = sys.modules.get("uiautomation") or _auto()
        return ctl.GetPattern(getattr(auto.PatternId, pattern))
    except Exception:
        return None


def _auto():
    if sys.platform != "win32":
        raise RuntimeError("UI Automation requires Windows (sys.platform=='win32').")
    _bw._ensure_dpi_aware()   # UIA rects must be in the same physical px as SendInput
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass
    try:
        return importlib.import_module("uiautomation")
    except ImportError as exc:
        raise RuntimeError(
            "The 'uiautomation' package is missing from this engine build "
            f"({exc}); reinstall Cindro or pip install uiautomation.") from exc


def normalize_type(control_type: str | None) -> str | None:
    """'button' / 'Button' / 'ButtonControl' -> 'ButtonControl'."""
    if not control_type:
        return None
    t = control_type.strip()
    t = t[0].upper() + t[1:]
    return t if t.endswith("Control") else t + "Control"


def parse_eid(eid: str) -> tuple[int, list[int]]:
    """'1234:0.3.2' -> (1234, [0, 3, 2]); '1234:' / '1234' -> (1234, [])."""
    head, _, path = str(eid).partition(":")
    try:
        hwnd = int(head, 0)
        idx = [int(p) for p in path.split(".") if p != ""]
    except ValueError as exc:
        raise ValueError(f"bad element id {eid!r} (expected '<hwnd>:<i>.<j>...')") from exc
    return hwnd, idx


def _window_root(auto, window: str | None):
    if not window or window == "foreground":
        import ctypes
        hwnd = ctypes.windll.user32.GetForegroundWindow()
    else:
        import win_platform as _wp
        hwnd = _wp._resolve_hwnd(window)
    ctl = auto.ControlFromHandle(hwnd)
    if ctl is None:
        raise RuntimeError(f"no UI Automation element for window {window!r}")
    return hwnd, ctl


def _rect(ctl) -> list[int]:
    try:
        r = ctl.BoundingRectangle
        return [int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)]
    except Exception:
        return [0, 0, 0, 0]


def _describe(ctl, eid: str, depth: int, with_patterns: bool = True) -> dict:
    node = {"eid": eid, "depth": depth, "name": (ctl.Name or "")[:200],
            "type": (ctl.ControlTypeName or "").replace("Control", ""),
            "rect": _rect(ctl)}
    aid = getattr(ctl, "AutomationId", "") or ""
    if aid:
        node["aid"] = aid[:120]
    try:
        if not ctl.IsEnabled:
            node["enabled"] = False
    except Exception:
        pass
    if with_patterns:
        found = {label: p for pattern, label in _PATTERNS
                 if (p := _pat(ctl, pattern)) is not None}
        if found:
            node["patterns"] = list(found)
        if "value" in found:
            try:
                v = found["value"].Value
                if v:
                    node["value"] = v[:_VALUE_MAX]
            except Exception:
                pass
        if "toggle" in found:
            try:
                node["toggled"] = int(found["toggle"].ToggleState) == 1
            except Exception:
                pass
    return node


def _remember(eid: str, ctl) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[eid] = ctl


def _walk(root, hwnd: int, max_depth: int, max_nodes: int, visible_only: bool):
    """BFS yielding (ctl, eid, depth)."""
    queue = deque([(root, f"{hwnd}:", 0)])
    seen = 0
    while queue and seen < max_nodes:
        ctl, eid, depth = queue.popleft()
        seen += 1
        yield ctl, eid, depth
        if depth >= max_depth:
            continue
        try:
            kids = ctl.GetChildren()
        except Exception:
            kids = []
        for i, kid in enumerate(kids):
            if visible_only:
                try:
                    if kid.IsOffscreen:
                        continue
                except Exception:
                    pass
            sep = "" if eid.endswith(":") else "."
            queue.append((kid, f"{eid}{sep}{i}", depth + 1))


def tree(window: str | None = "foreground", max_depth: int = 6, max_nodes: int = 300,
         visible_only: bool = True) -> dict:
    auto = _auto()
    hwnd, root = _window_root(auto, window)
    nodes = []
    for ctl, eid, depth in _walk(root, hwnd, max(0, int(max_depth)),
                                 max(1, min(3000, int(max_nodes))), visible_only):
        _remember(eid, ctl)
        nodes.append(_describe(ctl, eid, depth))
    return {"window": f"win:{hwnd}", "count": len(nodes), "elements": nodes,
            "truncated": len(nodes) >= max_nodes}


def _matches(ctl, name, ctype, aid) -> bool:
    try:
        if ctype and ctl.ControlTypeName != ctype:
            return False
        if aid and (getattr(ctl, "AutomationId", "") or "") != aid:
            return False
        if name and name.lower() not in (ctl.Name or "").lower():
            return False
        return True
    except Exception:
        return False


def find(name: str | None = None, control_type: str | None = None,
         automation_id: str | None = None, window: str | None = "foreground",
         max_results: int = 20, max_depth: int = 25, visible_only: bool = True,
         max_nodes: int = 5000) -> dict:
    if not (name or control_type or automation_id):
        raise ValueError("ui_find needs name, control_type and/or automation_id")
    auto = _auto()
    ctype = normalize_type(control_type)
    hwnd, root = _window_root(auto, window)
    hits = []
    for ctl, eid, depth in _walk(root, hwnd, int(max_depth), int(max_nodes), visible_only):
        if _matches(ctl, name, ctype, automation_id):
            _remember(eid, ctl)
            hits.append(_describe(ctl, eid, depth))
            if len(hits) >= max(1, int(max_results)):
                break
    return {"window": f"win:{hwnd}", "count": len(hits), "elements": hits}


def focused() -> dict:
    auto = _auto()
    ctl = auto.GetFocusedControl()
    if ctl is None:
        return {"element": None}
    return {"element": _describe(ctl, "focused", 0)}


def element_at(x: float, y: float, coord_space: str = "image") -> dict:
    auto = _auto()
    gx, gy = _bw._screen.map_to_desktop(x, y, coord_space, "active")
    ctl = auto.ControlFromPoint(gx, gy)
    if ctl is None:
        return {"element": None, "desktop_pos": [gx, gy]}
    return {"element": _describe(ctl, "at-point", 0), "desktop_pos": [gx, gy]}


def _resolve(eid: str | None, name: str | None, control_type: str | None,
             automation_id: str | None, window: str | None):
    auto = _auto()
    if eid:
        ctl = _CACHE.get(eid)
        if ctl is not None:
            try:
                ctl.Name  # still alive?
                return ctl, eid
            except Exception:
                pass
        hwnd, path = parse_eid(eid)
        ctl = auto.ControlFromHandle(hwnd)
        for i in path:
            kids = ctl.GetChildren() if ctl is not None else []
            if i >= len(kids):
                raise RuntimeError(f"element {eid!r} no longer exists (UI changed) -- "
                                   "re-run ui_tree/ui_find")
            ctl = kids[i]
        return ctl, eid
    res = find(name=name, control_type=control_type, automation_id=automation_id,
               window=window, max_results=1)
    if not res["elements"]:
        raise RuntimeError(f"no element matches name={name!r} type={control_type!r} "
                           f"aid={automation_id!r} in {res['window']}")
    e = res["elements"][0]["eid"]
    return _CACHE[e], e


def _center(ctl) -> tuple[int, int]:
    x, y, w, h = _rect(ctl)
    if w <= 0 or h <= 0:
        raise RuntimeError("element has no on-screen rectangle (scrolled away or hidden)")
    return x + w // 2, y + h // 2


def click(eid=None, name=None, control_type=None, automation_id=None,
          window="foreground", method: str = "auto", button: str = "left",
          double: bool = False) -> dict:
    """method: 'auto' (Invoke pattern when the element has one, else a real
    mouse click at its centre), 'invoke', or 'mouse'."""
    ctl, e = _resolve(eid, name, control_type, automation_id, window)
    desc = _describe(ctl, e, 0, with_patterns=False)
    inv = None
    if method in ("auto", "invoke") and button == "left" and not double:
        inv = _pat(ctl, "InvokePattern")
    if inv is not None:
        inv.Invoke()
        try:  # keep the take-over overlay in the loop even without a mouse move
            cx, cy = _center(ctl)
            _bw._agent_bus.publish(cx, cy, button="left", kind="click", session="real")
        except Exception:
            pass
        return {"clicked": desc, "via": "invoke"}
    if method == "invoke":
        raise RuntimeError(f"element {e!r} has no Invoke pattern -- use method='mouse'")
    cx, cy = _center(ctl)
    _bw.click(cx, cy, button=button, double=double, coord_space="desktop")
    return {"clicked": desc, "via": "mouse", "desktop_pos": [cx, cy]}


def set_value(text: str, eid=None, name=None, control_type=None, automation_id=None,
              window="foreground") -> dict:
    ctl, e = _resolve(eid, name, control_type, automation_id, window)
    vp = _pat(ctl, "ValuePattern")
    try:
        if vp is not None and vp.IsReadOnly:
            vp = None
    except Exception:
        vp = None
    if vp is not None:
        vp.SetValue(text)
        return {"set": _describe(ctl, e, 0), "via": "value_pattern"}
    cx, cy = _center(ctl)
    _bw.click(cx, cy, coord_space="desktop")
    time.sleep(0.1)
    _bw.key_press("ctrl+a")
    _bw.type_text(text)
    return {"set": _describe(ctl, e, 0, with_patterns=False), "via": "keyboard"}


def toggle(eid=None, name=None, control_type=None, automation_id=None,
           window="foreground") -> dict:
    ctl, e = _resolve(eid, name, control_type, automation_id, window)
    tp = _pat(ctl, "TogglePattern")
    if tp is None:
        raise RuntimeError(f"element {e!r} can't be toggled (no Toggle pattern)")
    tp.Toggle()
    return {"toggled": _describe(ctl, e, 0)}


def expand(expand_: bool = True, eid=None, name=None, control_type=None,
           automation_id=None, window="foreground") -> dict:
    ctl, e = _resolve(eid, name, control_type, automation_id, window)
    ep = _pat(ctl, "ExpandCollapsePattern")
    if ep is None:
        raise RuntimeError(f"element {e!r} can't expand/collapse")
    ep.Expand() if expand_ else ep.Collapse()
    return {"expanded" if expand_ else "collapsed": _describe(ctl, e, 0, with_patterns=False)}


def select(eid=None, name=None, control_type=None, automation_id=None,
           window="foreground") -> dict:
    ctl, e = _resolve(eid, name, control_type, automation_id, window)
    sp = _pat(ctl, "SelectionItemPattern")
    if sp is None:
        raise RuntimeError(f"element {e!r} isn't selectable (no SelectionItem pattern)")
    sp.Select()
    return {"selected": _describe(ctl, e, 0, with_patterns=False)}
