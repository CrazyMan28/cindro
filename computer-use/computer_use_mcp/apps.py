"""Enumerate and launch desktop applications (.desktop entries).

Launching goes through `systemd-run --user` with the ACTIVE session's env so
apps get the right Wayland display, land in their own transient unit (they
survive MCP server restarts — a plain child would die with the service
cgroup), and work for remote agents that have no shell here. Exec= field
codes (%u/%f/...) are stripped rather than going through gio, because gio
exits right after spawning and systemd would reap the orphaned app.
"""

from __future__ import annotations

import configparser
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from computer_use_mcp import session, windows

APP_DIRS = [
    Path.home() / ".local/share/applications",
    Path.home() / ".local/share/flatpak/exports/share/applications",
    Path("/var/lib/flatpak/exports/share/applications"),
    Path("/var/lib/snapd/desktop/applications"),
    Path("/usr/local/share/applications"),
    Path("/usr/share/applications"),
]


def list_apps(filter_text: str | None = None) -> list[dict]:
    apps: dict[str, dict] = {}
    for d in APP_DIRS:  # earlier dirs shadow later ones (XDG precedence)
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.desktop")):
            app_id = f.stem
            if app_id in apps:
                continue
            cp = configparser.RawConfigParser(strict=False)
            try:
                cp.read(f, encoding="utf-8")
            except (configparser.Error, OSError, UnicodeDecodeError):
                continue
            if not cp.has_section("Desktop Entry"):
                continue
            e = dict(cp.items("Desktop Entry"))
            if e.get("type", "Application") != "Application":
                continue
            if e.get("nodisplay", "").lower() == "true" or e.get("hidden", "").lower() == "true":
                continue
            if not e.get("exec"):
                continue
            apps[app_id] = {
                "id": app_id,
                "name": e.get("name", app_id),
                "comment": e.get("comment", ""),
                "exec": e["exec"],
                "terminal": e.get("terminal", "").lower() == "true",
                "path": str(f),
            }
    out = sorted(apps.values(), key=lambda a: a["name"].lower())
    if filter_text:
        ft = filter_text.lower()
        out = [a for a in out
               if ft in a["id"].lower() or ft in a["name"].lower() or ft in a["comment"].lower()]
    return out


def _resolve(app: str) -> dict | None:
    apps = list_apps()
    al = app.lower()
    for a in apps:
        if a["id"].lower() == al or a["name"].lower() == al:
            return a
    for pool in (
        [a for a in apps if a["id"].lower().startswith(al) or a["name"].lower().startswith(al)],
        [a for a in apps if al in a["id"].lower() or al in a["name"].lower()],
    ):
        if len(pool) == 1:
            return pool[0]
        if pool:
            names = ", ".join(f"{a['id']} ({a['name']})" for a in pool[:8])
            raise RuntimeError(f"Ambiguous app {app!r} — candidates: {names}")
    return None


def _exec_argv(exec_line: str) -> list[str]:
    """Strip .desktop Exec field codes (%u, %F, ...) down to a plain argv."""
    argv = [t for t in shlex.split(exec_line) if not (t.startswith("%") and len(t) == 2)]
    if not argv:
        raise RuntimeError(f"Unusable Exec line: {exec_line!r}")
    return argv


def launch(app: str, wait_for_window: bool = True, timeout: float = 10.0) -> dict:
    info = session.get_session("active")
    entry = _resolve(app)
    if entry:
        if entry["terminal"]:
            raise RuntimeError(f"{entry['name']} is a terminal app — run it from a shell instead.")
        argv = _exec_argv(entry["exec"])
        label = entry["name"]
    else:
        argv = shlex.split(app)
        if shutil.which(argv[0]) is None:
            raise RuntimeError(
                f"No installed app or command matches {app!r}. Use app_list to see "
                "installed applications."
            )
        label = app

    env = info.env()
    unit = f"cu-app-{int(time.time() * 1000)}"
    cmd = ["systemd-run", "--user", "--collect", "--quiet", f"--unit={unit}"]
    for key in ("WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR",
                "DBUS_SESSION_BUS_ADDRESS", "SWAYSOCK", "XDG_SESSION_TYPE"):
        if key in env:
            cmd.append(f"--setenv={key}={env[key]}")
    cmd += ["--", *argv]

    before = {w["id"] for w in windows.list_windows() if "error" not in w}
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    if proc.returncode != 0:
        raise RuntimeError(f"systemd-run failed: {proc.stderr.strip()}")

    result = {"launched": label, "argv": argv, "unit": unit, "new_windows": []}
    if wait_for_window:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(0.5)
            current = [w for w in windows.list_windows() if "error" not in w]
            new = [w for w in current if w["id"] not in before]
            if new:
                result["new_windows"] = new
                break
        if not result["new_windows"]:
            # Single-instance apps just raise their existing window.
            al = label.lower()
            existing = [w for w in windows.list_windows() if "error" not in w
                        and (al in (w.get("app") or "").lower() or al in (w.get("title") or "").lower())]
            result["existing_windows"] = existing
            result["note"] = ("no new window appeared (single-instance app already running, "
                              "still starting, or background service); see existing_windows")
    return result
