"""Window management across both sessions.

Unified window ids: "kwin:<internalId-uuid>" and "sway:<con_id>", so
window_activate/window_close route on the prefix. KWin operations run JS via
the DBus bridge; sway uses swaymsg criteria (works even while sway is the
inactive session).
"""

from __future__ import annotations

import json
import subprocess

from computer_use_mcp import session
from computer_use_mcp.kwin_bridge import kwin

_KWIN_LIST_JS = """
var out = [];
var list = workspace.windowList();
for (var i = 0; i < list.length; i++) {
  var w = list[i];
  if (!w.normalWindow && !w.dialog) continue;
  if (w.deleted) continue;
  out.push({
    id: String(w.internalId), title: w.caption, app: w.resourceClass,
    pid: w.pid, x: w.frameGeometry.x, y: w.frameGeometry.y,
    w: w.frameGeometry.width, h: w.frameGeometry.height,
    active: w.active, minimized: w.minimized,
    output: w.output ? w.output.name : null,
  });
}
return out;
"""


def _kwin_windows() -> list[dict]:
    rows = kwin.run_js(_KWIN_LIST_JS) or []
    return [{
        "id": f"kwin:{r['id']}", "title": r["title"], "app": r["app"],
        "pid": r["pid"], "rect": {"x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]},
        "active": r["active"], "minimized": r["minimized"],
        "output": r["output"], "session": "kde",
    } for r in rows]


def _kwin_by_id(internal_id: str, action_js: str):
    """Run action_js with `w` bound to the window with the given internalId."""
    js = f"""
var list = workspace.windowList();
for (var i = 0; i < list.length; i++) {{
  var w = list[i];
  if (String(w.internalId) === {json.dumps(internal_id)}) {{
    {action_js}
    return true;
  }}
}}
return false;
"""
    return kwin.run_js(js)


def _swaymsg(info: session.SessionInfo, *args: str) -> str:
    proc = subprocess.run(
        ["swaymsg", "-s", info.swaysock, *args],
        capture_output=True, text=True, timeout=10,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"swaymsg failed: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


def _sway_windows(info: session.SessionInfo) -> list[dict]:
    tree = json.loads(_swaymsg(info, "-t", "get_tree"))
    out: list[dict] = []

    def walk(node: dict, output: str | None):
        if node.get("type") == "output":
            output = node.get("name")
        is_window = (
            node.get("type") in ("con", "floating_con")
            and (node.get("app_id") or node.get("window_properties") or node.get("pid"))
            and node.get("name") is not None
            and not node.get("nodes") and not node.get("floating_nodes")
        )
        if is_window:
            props = node.get("window_properties") or {}
            rect = node.get("rect") or {}
            out.append({
                "id": f"sway:{node['id']}",
                "title": node.get("name"),
                "app": node.get("app_id") or props.get("class"),
                "pid": node.get("pid"),
                "rect": {"x": rect.get("x"), "y": rect.get("y"),
                         "w": rect.get("width"), "h": rect.get("height")},
                "active": bool(node.get("focused")),
                "minimized": False,
                "output": output if output != "__i3" else None,
                "session": "sway",
            })
        for child in (node.get("nodes") or []) + (node.get("floating_nodes") or []):
            walk(child, output)

    walk(tree, None)
    return out


def list_windows(which: str = "all") -> list[dict]:
    """Windows from 'all', 'kde', or 'sway' sessions; errors per backend are
    reported inline rather than failing the whole list."""
    d = session.detect()
    out: list[dict] = []
    for info in d["sessions"]:
        if which not in ("all", info.kind):
            continue
        try:
            if info.kind == "kde":
                out.extend(_kwin_windows())
            elif info.swaysock:
                out.extend(_sway_windows(info))
        except Exception as exc:
            out.append({"id": f"{info.kind}:error", "error": str(exc), "session": info.kind})
    return out


def _split_id(window_id: str) -> tuple[str, str]:
    if ":" not in window_id:
        raise ValueError(f"Bad window id {window_id!r} — expected 'kwin:<uuid>' or 'sway:<id>'")
    kind, _, rest = window_id.partition(":")
    if kind not in ("kwin", "sway") or not rest:
        raise ValueError(f"Bad window id {window_id!r}")
    return kind, rest


def activate(window_id: str) -> dict:
    kind, ident = _split_id(window_id)
    if kind == "kwin":
        found = _kwin_by_id(ident, "w.minimized = false; workspace.activeWindow = w;")
        if not found:
            raise RuntimeError(f"KWin window {ident} not found (stale id? re-run window_list)")
    else:
        info = session.get_session("sway")
        _swaymsg(info, f"[con_id={int(ident)}]", "focus")
    return {"activated": window_id}


_KWIN_SET_ACTIONS = {
    "minimize": "w.minimized = true;",
    "unminimize": "w.minimized = false;",
    "maximize": "w.minimized = false; w.setMaximize(true, true);",
    "fullscreen": "w.minimized = false; w.fullScreen = true;",
    "restore": "w.minimized = false; w.fullScreen = false; w.setMaximize(false, false);",
}


def set_state(window_id: str, action: str,
              x: int | None = None, y: int | None = None,
              w: int | None = None, h: int | None = None) -> dict:
    """minimize | unminimize | maximize | fullscreen | restore | move_resize."""
    kind, ident = _split_id(window_id)
    if action not in (*_KWIN_SET_ACTIONS, "move_resize"):
        raise ValueError(f"Unknown action {action!r}")

    if kind == "kwin":
        if action == "move_resize":
            js = (
                "var g = w.frameGeometry;"
                f"w.frameGeometry = {{x: {x if x is not None else 'g.x'},"
                f" y: {y if y is not None else 'g.y'},"
                f" width: {w if w is not None else 'g.width'},"
                f" height: {h if h is not None else 'g.height'}}};"
            )
        else:
            js = _KWIN_SET_ACTIONS[action]
        if not _kwin_by_id(ident, js):
            raise RuntimeError(f"KWin window {ident} not found (stale id? re-run window_list)")
    else:
        info = session.get_session("sway")
        crit = f"[con_id={int(ident)}]"
        if action == "move_resize":
            if x is not None and y is not None:
                _swaymsg(info, crit, "floating", "enable")
                _swaymsg(info, crit, "move", "position", str(x), str(y))
            if w is not None and h is not None:
                _swaymsg(info, crit, "resize", "set", str(w), str(h))
        elif action == "minimize":
            _swaymsg(info, crit, "move", "scratchpad")  # sway's closest equivalent
        elif action == "unminimize":
            _swaymsg(info, crit, "scratchpad", "show")
        elif action in ("maximize", "fullscreen"):
            _swaymsg(info, crit, "fullscreen", "enable")
        else:  # restore
            _swaymsg(info, crit, "fullscreen", "disable")
    return {"window": window_id, "action": action}


def close(window_id: str) -> dict:
    kind, ident = _split_id(window_id)
    if kind == "kwin":
        found = _kwin_by_id(ident, "w.closeWindow();")
        if not found:
            raise RuntimeError(f"KWin window {ident} not found (stale id? re-run window_list)")
    else:
        info = session.get_session("sway")
        _swaymsg(info, f"[con_id={int(ident)}]", "kill")
    return {"closed": window_id, "note": "apps with unsaved changes may show a confirm dialog"}
