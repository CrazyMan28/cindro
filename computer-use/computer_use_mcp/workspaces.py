"""Workspace / virtual-desktop management across both compositors.

So the model can — from a plain chat, no buttons — say "make a new desktop named
'research'", "switch to workspace 2", or "work on my current desktop" and have it
happen. Covers BOTH compositors and honors the session target like the other
desktop tools:

  - Sway (host sway OR the nested agent desktop): swaymsg over the session's
    SWAYSOCK — `-t get_workspaces`, `workspace <num|name>`,
    `workspace number <n>`, `rename workspace to <name>`. Creating a named
    workspace is "switch to a workspace that doesn't exist yet" (sway makes it on
    demand), so workspace_create == switch-to-new-name.
  - KDE (KWin virtual desktops): the existing KWin scripting bridge —
    workspace.desktops / currentDesktop / createDesktop / removeDesktop, plus the
    VirtualDesktop `.name` setter for rename. (Scripting, not raw DBus, to reuse
    kwin_bridge and stay consistent with windows.py.)

`which` resolves through session.get_session() exactly like the other tools:
'active' targets the host seat — UNLESS this engine is bound to a nested agent
desktop, in which case 'active' is the agent session (see session.get_session).
'agent' explicitly targets the nested co-worker desktop, 'kde'/'sway' the host.
"""

from __future__ import annotations

import json
import subprocess

from computer_use_mcp import session
from computer_use_mcp.kwin_bridge import kwin


def _swaymsg(info: session.SessionInfo, *args: str) -> str:
    """Run swaymsg against this session's IPC socket (nested agent OR host sway)."""
    if not info.swaysock:
        # An agent session may carry only WAYLAND_DISPLAY; let swaymsg find the
        # IPC socket from the session env overlay (SWAYSOCK/WAYLAND_DISPLAY).
        cmd = ["swaymsg", *args]
        env = info.env()
    else:
        cmd = ["swaymsg", "-s", info.swaysock, *args]
        env = None
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10, env=env)
    if proc.returncode != 0:
        raise RuntimeError(
            f"swaymsg {' '.join(args)} failed: "
            f"{proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


def _sway_run_command(info: session.SessionInfo, command: str) -> None:
    """Run a sway COMMAND (not a -t query) and raise if any reply reports failure.

    swaymsg returns rc!=0 only for transport errors; a rejected command shows up
    as {"success": false, "error": ...} in the JSON reply, so check that too."""
    out = _swaymsg(info, command)
    try:
        replies = json.loads(out)
    except json.JSONDecodeError:
        return  # some commands reply with non-JSON; rc==0 already means accepted
    for r in replies if isinstance(replies, list) else [replies]:
        if isinstance(r, dict) and r.get("success") is False:
            raise RuntimeError(f"sway rejected {command!r}: {r.get('error', 'unknown')}")


# -- sway backend -------------------------------------------------------------


def _sway_list(info: session.SessionInfo) -> list[dict]:
    out = _swaymsg(info, "-t", "get_workspaces")
    rows = json.loads(out)
    return [{
        "num": w.get("num"),
        "name": w.get("name"),
        "focused": bool(w.get("focused")),
        "visible": bool(w.get("visible")),
        "output": w.get("output"),
    } for w in rows]


def _sway_switch(info: session.SessionInfo, name: str | None, num: int | None) -> dict:
    if num is not None:
        _sway_run_command(info, f"workspace number {int(num)}")
        target = str(num)
    elif name is not None:
        # `workspace "<name>"` switches to it, CREATING it if absent (sway
        # creates workspaces lazily on first focus).
        _sway_run_command(info, f'workspace "{name}"')
        target = name
    else:
        raise ValueError("workspace_switch needs name or num")
    return {"switched_to": target, "compositor": "sway", "which": info.kind}


def _sway_create(info: session.SessionInfo, name: str) -> dict:
    # In sway there is no separate "create": focusing a non-existent workspace
    # materializes it. So create == switch-to-new-name (and naming it is free).
    _sway_run_command(info, f'workspace "{name}"')
    return {"created": name, "compositor": "sway", "which": info.kind,
            "note": "sway creates a workspace on first focus; now focused"}


def _sway_rename(info: session.SessionInfo, name: str, old: str | None) -> dict:
    if old is not None:
        _sway_run_command(info, f'rename workspace "{old}" to "{name}"')
    else:
        _sway_run_command(info, f'rename workspace to "{name}"')
    return {"renamed_to": name, "from": old or "current",
            "compositor": "sway", "which": info.kind}


# -- KDE (KWin virtual desktops) backend --------------------------------------

_KWIN_LIST_JS = """
var out = [];
var ds = workspace.desktops;
var cur = workspace.currentDesktop;
for (var i = 0; i < ds.length; i++) {
  out.push({
    id: ds[i].id, name: ds[i].name, num: ds[i].x11DesktopNumber,
    focused: cur && ds[i].id === cur.id,
  });
}
return out;
"""


def _kwin_list() -> list[dict]:
    rows = kwin.run_js(_KWIN_LIST_JS) or []
    return [{
        "num": r["num"], "name": r["name"], "id": r["id"],
        "focused": bool(r["focused"]), "visible": bool(r["focused"]),
        "output": None,
    } for r in rows]


def _kwin_switch(name: str | None, num: int | None) -> dict:
    if num is not None:
        sel = f"ds[i].x11DesktopNumber === {int(num)}"
        target = str(num)
    elif name is not None:
        sel = f"ds[i].name === {json.dumps(name)}"
        target = name
    else:
        raise ValueError("workspace_switch needs name or num")
    js = f"""
var ds = workspace.desktops;
for (var i = 0; i < ds.length; i++) {{
  if ({sel}) {{ workspace.currentDesktop = ds[i]; return {{ok: true, id: ds[i].id, name: ds[i].name}}; }}
}}
return {{ok: false}};
"""
    r = kwin.run_js(js)
    if not r or not r.get("ok"):
        raise RuntimeError(f"KDE virtual desktop {target!r} not found "
                           "(use workspace_list to see names/numbers)")
    return {"switched_to": r["name"], "num_or_name": target,
            "compositor": "kde", "which": "kde"}


def _kwin_create(name: str, switch: bool = True) -> dict:
    js = f"""
var pos = workspace.desktops.length;
workspace.createDesktop(pos, {json.dumps(name)});
var ds = workspace.desktops;
var created = null;
for (var i = ds.length - 1; i >= 0; i--) {{ if (ds[i].name === {json.dumps(name)}) {{ created = ds[i]; break; }} }}
if (created === null) return {{ok: false}};
if ({str(switch).lower()}) workspace.currentDesktop = created;
return {{ok: true, id: created.id, name: created.name, num: created.x11DesktopNumber}};
"""
    r = kwin.run_js(js)
    if not r or not r.get("ok"):
        raise RuntimeError(f"KDE createDesktop({name!r}) failed")
    return {"created": r["name"], "num": r["num"], "id": r["id"],
            "switched": switch, "compositor": "kde", "which": "kde"}


def _kwin_rename(name: str, old: str | None) -> dict:
    if old is not None:
        sel = f"ds[i].name === {json.dumps(old)}"
    else:
        sel = "cur && ds[i].id === cur.id"
    js = f"""
var ds = workspace.desktops;
var cur = workspace.currentDesktop;
for (var i = 0; i < ds.length; i++) {{
  if ({sel}) {{ ds[i].name = {json.dumps(name)}; return {{ok: true, id: ds[i].id, name: ds[i].name}}; }}
}}
return {{ok: false}};
"""
    r = kwin.run_js(js)
    if not r or not r.get("ok"):
        raise RuntimeError(f"KDE rename target {old or 'current'!r} not found")
    return {"renamed_to": r["name"], "from": old or "current",
            "compositor": "kde", "which": "kde"}


# -- dispatch -----------------------------------------------------------------


def _resolve(which: str) -> session.SessionInfo:
    """Resolve the target session and reject non-workspace kinds early."""
    info = session.get_session(which)
    if info.kind not in ("kde", "sway", "agent"):
        raise RuntimeError(f"workspace tools don't support session kind {info.kind!r}")
    return info


def list_workspaces(which: str = "active") -> dict:
    info = _resolve(which)
    if info.kind == "kde":
        rows = _kwin_list()
    else:  # sway or agent (both wlroots)
        rows = _sway_list(info)
    return {"compositor": info.kind, "which": which,
            "workspaces": rows}


def switch_workspace(name: str | None = None, num: int | None = None,
                     which: str = "active") -> dict:
    info = _resolve(which)
    if info.kind == "kde":
        return _kwin_switch(name, num)
    return _sway_switch(info, name, num)


def create_workspace(name: str, switch: bool = True, which: str = "active") -> dict:
    info = _resolve(which)
    if info.kind == "kde":
        return _kwin_create(name, switch=switch)
    return _sway_create(info, name)


def rename_workspace(name: str, old: str | None = None, which: str = "active") -> dict:
    info = _resolve(which)
    if info.kind == "kde":
        return _kwin_rename(name, old)
    return _sway_rename(info, name, old)
