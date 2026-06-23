"""Detect the concurrent Wayland sessions (KDE + Sway) and route env per call.

This machine runs KDE Plasma and Sway on different TTYs at the same time.
loginctl's Type/Desktop fields are unreliable here (the KDE session shows
Type=tty because Plasma was started from a console login), so compositors are
mapped to sessions through their processes:

  - kwin_wayland: /proc/PID/environ is readable -> XDG_SESSION_ID
  - sway: non-dumpable (environ unreadable), but its IPC socket filename
    embeds its PID -> /proc/PID/cgroup -> session-N.scope

Wayland display sockets are attributed via `ss -xlp` (kwin shows up by name);
with two compositors the remaining socket belongs to sway by elimination.

uinput input always lands in the ACTIVE seat session, so input tools always
use the active session's geometry; only read-type tools take a session param.
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field

UID = os.getuid()
RUNTIME_DIR = f"/run/user/{UID}"
USER_BUS = f"unix:path={RUNTIME_DIR}/bus"

# The daemon (jarvisd) spawns a nested headless Sway for the co-worker "agent"
# session and tells this engine which compositor to drive by exporting these
# env vars into the engine process. Their presence is what makes detect()
# surface an "agent" SessionInfo at all.
AGENT_WAYLAND_ENV = "JARVIS_AGENT_WAYLAND_DISPLAY"
AGENT_SWAYSOCK_ENV = "JARVIS_AGENT_SWAYSOCK"
# Optional: lets a test/daemon point grim/swaymsg at a non-default runtime dir.
AGENT_RUNTIME_DIR_ENV = "JARVIS_AGENT_RUNTIME_DIR"

_CACHE: tuple[float, dict] | None = None
_CACHE_TTL = 2.0


def _run(cmd: list[str], env: dict | None = None, timeout: float = 5) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"{cmd[0]}: command not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]}: timed out after {timeout}s"


@dataclass
class Output:
    name: str
    x: int
    y: int
    w: int
    h: int
    scale: float = 1.0

    def as_dict(self) -> dict:
        return {"name": self.name, "x": self.x, "y": self.y, "w": self.w,
                "h": self.h, "scale": self.scale}

    def contains(self, gx: float, gy: float) -> bool:
        return self.x <= gx < self.x + self.w and self.y <= gy < self.y + self.h


@dataclass
class SessionInfo:
    # "kde" | "sway" | "agent" (alias: nested-agent-desktop). The "agent" kind
    # is the headless nested Sway the co-worker brain drives — it is selected
    # explicitly via the JARVIS_AGENT_WAYLAND_DISPLAY / JARVIS_AGENT_SWAYSOCK
    # env vars, NOT discovered on seat0, and is never the host "active" session.
    kind: str
    session_id: str | None = None
    tty: str | None = None
    active: bool = False
    wayland_display: str | None = None
    swaysock: str | None = None
    display: str | None = None  # Xwayland
    compositor_pid: int | None = None
    outputs: list[Output] = field(default_factory=list)
    outputs_unavailable_reason: str | None = None
    runtime_dir: str | None = None  # override XDG_RUNTIME_DIR (agent session)

    @property
    def bbox(self) -> dict | None:
        if not self.outputs:
            return None
        min_x = min(o.x for o in self.outputs)
        min_y = min(o.y for o in self.outputs)
        max_x = max(o.x + o.w for o in self.outputs)
        max_y = max(o.y + o.h for o in self.outputs)
        return {"x": min_x, "y": min_y, "w": max_x - min_x, "h": max_y - min_y}

    def env(self) -> dict:
        """Subprocess env overlay for tools that talk to this session."""
        e = dict(os.environ)
        e.pop("PYTHONPATH", None)  # victus exports a 3.14 PYTHONPATH that breaks venvs
        runtime_dir = self.runtime_dir or RUNTIME_DIR
        e["XDG_RUNTIME_DIR"] = runtime_dir
        e["DBUS_SESSION_BUS_ADDRESS"] = USER_BUS
        if self.wayland_display:
            e["WAYLAND_DISPLAY"] = self.wayland_display
        if self.swaysock:
            e["SWAYSOCK"] = self.swaysock
        else:
            e.pop("SWAYSOCK", None)
        if self.display:
            e["DISPLAY"] = self.display
        else:
            e.pop("DISPLAY", None)
        return e

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "session_id": self.session_id,
            "tty": self.tty,
            "active": self.active,
            "wayland_display": self.wayland_display,
            "swaysock": self.swaysock,
            "display": self.display,
            "compositor_pid": self.compositor_pid,
            "outputs": [o.as_dict() for o in self.outputs],
            "outputs_unavailable_reason": self.outputs_unavailable_reason,
            "runtime_dir": self.runtime_dir,
            "bbox": self.bbox,
        }


def _proc_environ(pid: int) -> dict[str, str]:
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read()
    except OSError:
        return {}
    out = {}
    for chunk in raw.split(b"\0"):
        if b"=" in chunk:
            k, _, v = chunk.partition(b"=")
            out[k.decode(errors="replace")] = v.decode(errors="replace")
    return out


def _proc_session_id(pid: int) -> str | None:
    try:
        cg = open(f"/proc/{pid}/cgroup").read()
    except OSError:
        return None
    m = re.search(r"session-(\w+)\.scope", cg)
    return m.group(1) if m else None


def _session_tty(session_id: str) -> str | None:
    rc, out, _ = _run(["loginctl", "show-session", session_id, "-p", "TTY", "--value"])
    return out or None


def _active_session_id() -> str | None:
    rc, out, _ = _run(["loginctl", "show-seat", "seat0", "-p", "ActiveSession", "--value"])
    return out or None


def _wayland_socket_owners() -> dict[str, str | None]:
    """Map wayland socket name -> owning process name (None if unattributable)."""
    sockets = {
        os.path.basename(p): None
        for p in glob.glob(f"{RUNTIME_DIR}/wayland-*")
        if not p.endswith(".lock")
    }
    rc, out, _ = _run(["ss", "-xlp"])
    if rc == 0:
        for line in out.splitlines():
            for sock in sockets:
                if f"{RUNTIME_DIR}/{sock}" in line:
                    m = re.search(r'users:\(\("([^"]+)"', line)
                    if m:
                        sockets[sock] = m.group(1)
    return sockets


def _find_sway() -> SessionInfo | None:
    for sock in glob.glob(f"{RUNTIME_DIR}/sway-ipc.*.sock"):
        rc, _, _ = _run(["swaymsg", "-s", sock, "-t", "get_version"])
        if rc != 0:
            continue
        info = SessionInfo(kind="sway", swaysock=sock)
        m = re.match(rf"sway-ipc\.{UID}\.(\d+)\.sock", os.path.basename(sock))
        if m:
            info.compositor_pid = int(m.group(1))
            info.session_id = _proc_session_id(info.compositor_pid)
        if info.session_id is None:
            # Fallback: the session loginctl labels Desktop=sway.
            rc, out, _ = _run(["loginctl", "list-sessions", "--no-legend"])
            for line in out.splitlines():
                sid = line.split()[0] if line.split() else None
                if not sid:
                    continue
                rc2, desk, _ = _run(["loginctl", "show-session", sid, "-p", "Desktop", "--value"])
                if desk == "sway":
                    info.session_id = sid
                    break
        return info
    return None


def _find_agent_sway(environ: dict[str, str] | None = None) -> SessionInfo | None:
    """Discover the nested headless-Sway *agent* desktop from explicit env.

    Unlike the host compositors, the agent desktop is NOT on seat0 and is not the
    loginctl ActiveSession, so it cannot be matched by process/socket elimination.
    The daemon (jarvisd) that spawned the nested `sway -c <conf>` exports
    JARVIS_AGENT_WAYLAND_DISPLAY (+ JARVIS_AGENT_SWAYSOCK) into this engine
    process; we trust those and build the SessionInfo directly. Returns None when
    the env vars are absent (the default real/active path is unaffected)."""
    env = environ if environ is not None else os.environ
    wl = env.get(AGENT_WAYLAND_ENV)
    sock = env.get(AGENT_SWAYSOCK_ENV)
    if not wl and not sock:
        return None
    # The nested compositor's wayland-N socket lives in its OWN isolated runtime
    # dir (the daemon spawns sway with a per-session XDG_RUNTIME_DIR), which is
    # NOT the host /run/user/<uid>. Resolve that dir, in priority order:
    #   1. an explicit JARVIS_AGENT_RUNTIME_DIR (daemon may set it);
    #   2. the directory holding the absolute JARVIS_AGENT_SWAYSOCK (the nested
    #      sway-ipc + wayland-N sockets are co-located there) — robust even when
    #      the daemon doesn't pass (1);
    #   3. the engine process's own XDG_RUNTIME_DIR (set to the nested dir by the
    #      daemon) if it differs from the host default;
    #   4. fall back to the host RUNTIME_DIR.
    runtime_dir = env.get(AGENT_RUNTIME_DIR_ENV)
    if not runtime_dir and sock and os.path.isabs(sock):
        runtime_dir = os.path.dirname(sock)
    if not runtime_dir:
        proc_xdg = env.get("XDG_RUNTIME_DIR")
        if proc_xdg and proc_xdg != RUNTIME_DIR:
            runtime_dir = proc_xdg
    runtime_dir = runtime_dir or RUNTIME_DIR
    # WAYLAND_DISPLAY may be an absolute socket path or a bare name (wayland-1).
    wayland_display = None
    if wl:
        wayland_display = os.path.basename(wl) if os.path.isabs(wl) else wl
    info = SessionInfo(
        kind="agent",
        session_id="agent",
        wayland_display=wayland_display,
        swaysock=sock or None,
        runtime_dir=runtime_dir,
        active=False,  # the host seat stays active; agent is never "active"
    )
    # Best-effort: identify the nested sway pid from its IPC socket name
    # (sway-ipc.<UID>.<PID>.sock) so callers can see what they're driving.
    if sock:
        m = re.match(rf"sway-ipc\.{UID}\.(\d+)\.sock", os.path.basename(sock))
        if m:
            info.compositor_pid = int(m.group(1))
    return info


def _find_kwin() -> SessionInfo | None:
    rc, out, _ = _run(["pgrep", "-x", "kwin_wayland"])
    if rc != 0 or not out:
        return None
    pid = int(out.splitlines()[0])
    info = SessionInfo(kind="kde", compositor_pid=pid)
    # kwin_wayland is capability-elevated: its environ is root-owned and its
    # cgroup is plasma-kwin_wayland.service (no session scope). The display ->
    # session mapping comes from _display_session_map() in detect() instead.
    env = _proc_environ(pid)
    info.session_id = env.get("XDG_SESSION_ID") or _proc_session_id(pid)
    return info


def _display_session_map() -> dict[str, str]:
    """Map WAYLAND_DISPLAY -> XDG_SESSION_ID by majority vote over the user's
    readable session processes (plasmashell, swaybar, terminals, ...). Works
    when the compositor itself is unreadable (kwin is capability-elevated)."""
    votes: dict[str, dict[str, int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        path = f"/proc/{entry}/environ"
        try:
            if os.stat(path).st_uid != UID:
                continue
        except OSError:
            continue
        env = _proc_environ(int(entry))
        disp, sid = env.get("WAYLAND_DISPLAY"), env.get("XDG_SESSION_ID")
        if disp and sid:
            votes.setdefault(disp, {})
            votes[disp][sid] = votes[disp].get(sid, 0) + 1
    return {
        disp: max(counts, key=counts.get)
        for disp, counts in votes.items()
    }


def _kde_outputs(info: SessionInfo) -> None:
    rc, out, err = _run(["kscreen-doctor", "--json"], env=info.env(), timeout=10)
    if rc != 0 or not out:
        info.outputs_unavailable_reason = f"kscreen-doctor failed: {err or rc}"
        return
    try:
        data = json.loads(out)
        for o in data.get("outputs", []):
            if not o.get("enabled"):
                continue
            info.outputs.append(Output(
                name=o.get("name", "?"),
                x=int(o["pos"]["x"]), y=int(o["pos"]["y"]),
                w=int(o["size"]["width"]), h=int(o["size"]["height"]),
                scale=float(o.get("scale", 1.0)),
            ))
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        info.outputs_unavailable_reason = f"kscreen-doctor parse error: {exc}"


def _sway_outputs(info: SessionInfo) -> None:
    if info.swaysock:
        cmd = ["swaymsg", "-s", info.swaysock, "-t", "get_outputs"]
        env = None
    else:
        # Agent session may carry only WAYLAND_DISPLAY; let swaymsg locate the
        # IPC socket itself from SWAYSOCK/WAYLAND_DISPLAY in info.env().
        cmd = ["swaymsg", "-t", "get_outputs"]
        env = info.env()
    rc, out, err = _run(cmd, env=env, timeout=10)
    if rc != 0:
        info.outputs_unavailable_reason = f"swaymsg get_outputs failed: {err}"
        return
    try:
        outputs = json.loads(out)
    except json.JSONDecodeError as exc:
        info.outputs_unavailable_reason = f"swaymsg parse error: {exc}"
        return
    if not outputs:
        info.outputs_unavailable_reason = (
            "sway reports no outputs — it is the inactive session (KDE holds the "
            "displays). Screenshots/geometry resume when sway's TTY is active."
        )
        return
    for o in outputs:
        if not o.get("active", True):
            continue
        rect = o.get("rect", {})
        info.outputs.append(Output(
            name=o.get("name", "?"),
            x=int(rect.get("x", 0)), y=int(rect.get("y", 0)),
            w=int(rect.get("width", 0)), h=int(rect.get("height", 0)),
            scale=float(o.get("scale", 1.0)),
        ))


def _xwayland_displays() -> dict[int, str]:
    """Map Xwayland parent compositor pid -> DISPLAY (e.g. ':1')."""
    rc, out, _ = _run(["pgrep", "-ax", "Xwayland"])
    result: dict[int, str] = {}
    if rc != 0:
        return result
    for line in out.splitlines():
        parts = line.split()
        pid = int(parts[0])
        display = next((p for p in parts[1:] if re.fullmatch(r":\d+", p)), None)
        if display is None:
            continue
        try:
            ppid_line = open(f"/proc/{pid}/status").read()
            m = re.search(r"^PPid:\s+(\d+)", ppid_line, re.M)
            if m:
                result[int(m.group(1))] = display
        except OSError:
            continue
    return result


def detect(refresh: bool = False) -> dict:
    """Return {"active": SessionInfo|None, "sessions": [SessionInfo, ...]}."""
    global _CACHE
    now = time.monotonic()
    if not refresh and _CACHE and now - _CACHE[0] < _CACHE_TTL:
        return _CACHE[1]

    sessions: list[SessionInfo] = []
    kde = _find_kwin()
    sway = _find_sway()

    owners = _wayland_socket_owners()
    kwin_sockets = [s for s, owner in owners.items() if owner and "kwin" in owner]
    other_sockets = [s for s, owner in owners.items() if s not in kwin_sockets]
    if kde and kwin_sockets:
        kde.wayland_display = sorted(kwin_sockets)[0]
    if sway:
        # sway is non-dumpable so ss can't attribute its socket; with two
        # compositors the non-kwin socket is sway's by elimination.
        candidates = [s for s in other_sockets if owners.get(s) is None or "sway" in (owners.get(s) or "")]
        if candidates:
            sway.wayland_display = sorted(candidates)[0]

    xdisplays = _xwayland_displays()
    for info in (kde, sway):
        if info and info.compositor_pid in xdisplays:
            info.display = xdisplays[info.compositor_pid]

    if any(info and info.session_id is None for info in (kde, sway)):
        disp_map = _display_session_map()
        for info in (kde, sway):
            if info and info.session_id is None and info.wayland_display:
                info.session_id = disp_map.get(info.wayland_display)

    active_id = _active_session_id()
    for info in (kde, sway):
        if info is None:
            continue
        if info.session_id:
            info.tty = _session_tty(info.session_id)
            info.active = info.session_id == active_id
        sessions.append(info)

    # Active flag fallback: if exactly one session exists, it's the target.
    if active_id and not any(s.active for s in sessions) and len(sessions) == 1:
        sessions[0].active = True

    # The nested agent desktop is additive and selected explicitly via env vars;
    # it is appended AFTER the active-flag logic so it can never become active.
    agent = _find_agent_sway()
    if agent is not None:
        agent.active = False
        sessions.append(agent)

    for info in sessions:
        if info.kind == "kde":
            _kde_outputs(info)
        else:  # sway or agent (both wlroots; grim/swaymsg)
            _sway_outputs(info)

    result = {"active": next((s for s in sessions if s.active and s.kind != "agent"), None),
              "sessions": sessions}
    _CACHE = (now, result)
    return result


def compositor_hint() -> str | None:
    """A CHEAP active-compositor hint for /health — no kscreen-doctor / output
    enumeration, just env + a quick pgrep. The per-session agent engine runs with
    an isolated XDG_RUNTIME_DIR where the host KDE output probe (kscreen-doctor)
    blocks; /health must never depend on it. Returns "agent" when this engine is
    bound to a nested agent desktop, else "kde"/"sway" by process presence, else
    None."""
    if os.environ.get(AGENT_WAYLAND_ENV) or os.environ.get(AGENT_SWAYSOCK_ENV):
        return "agent"
    rc, out, _ = _run(["pgrep", "-x", "kwin_wayland"], timeout=2)
    if rc == 0 and out:
        return "kde"
    rc, out, _ = _run(["pgrep", "-x", "sway"], timeout=2)
    if rc == 0 and out:
        return "sway"
    return None


def get_session(which: str = "active") -> SessionInfo:
    """Resolve 'active' | 'kde' | 'sway' | 'agent' to a live session or raise.

    'agent' is the nested headless-Sway co-worker desktop; it only exists when
    JARVIS_AGENT_WAYLAND_DISPLAY/JARVIS_AGENT_SWAYSOCK are set in this process."""
    d = detect()
    if which == "active":
        if d["active"] is None:
            raise RuntimeError(
                "No active graphical session detected on seat0 "
                f"(sessions seen: {[s.kind for s in d['sessions']]})"
            )
        return d["active"]
    for s in d["sessions"]:
        if s.kind == which:
            return s
    raise RuntimeError(
        f"Session {which!r} not found (running: {[s.kind for s in d['sessions']] or 'none'})"
    )
