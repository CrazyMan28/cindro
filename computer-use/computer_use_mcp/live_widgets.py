"""Live (auto-updating) widgets — a model-controlled, viewer-gated refresher.

The model can make ANY widget update on its own by attaching a background job:
run a shell `command` every `interval_sec`, take its stdout, substitute it into a
widget spec template (the literal token "{{value}}"), and re-render the widget
under the SAME id (so the desktop/phone replace the card in place).

Lifecycle / battery (the important part):
  * ONE detached *supervisor* process runs ALL jobs in-process (no per-widget
    process). `ensure_supervisor()` spawns it, guarded by an O_EXCL pid-file so
    only one ever exists regardless of how many engines start.
  * A job only does work (shell exec + bus append) while a fresh *viewer lease*
    covers it — a desktop/phone chat for its session, the Canvas tab ("all"), a
    popped-out widget window, or a phone home-screen pin. With nothing watching
    it idles (saves laptop AND phone battery) and resumes when a viewer returns.
  * Leases are written by the daemon (the always-on owner of desktop+phone
    connections) into ~/.local/share/jarvis/widget_viewers/*.json; the supervisor
    reads them with a TTL.
  * A *pinned* home-screen widget keeps a job alive but at a >=60s cadence floor
    (aggressive battery); unchanged values are deduped, but a render is forced on
    the first tick after a viewer newly appears so a freshly-opened view is current.
  * DELETING a canvas/widget stops its job: delete() unlinks the job file and
    appends a `remove` marker; the supervisor re-checks the job file immediately
    before each append, so a delete can't lose a race with an in-flight render.

Jobs live in ~/.local/share/jarvis/widget_jobs/<id>.json. Best-effort throughout;
a broken job never escapes into a tool call.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from computer_use_mcp import widgets_bus

# How often the supervisor wakes to evaluate jobs.
SUPERVISOR_TICK = 1.0
# A pinned-but-unwatched widget refreshes no faster than this (battery floor).
PIN_FLOOR_SEC = 60.0
# A viewer lease older than this is considered gone.
LEASE_TTL_MS = 45_000
# The supervisor exits after this long with no jobs at all (re-spawned on demand).
IDLE_EXIT_SEC = 90.0

_UNSET = object()


def _data_dir() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "jarvis"


def _jobs_dir() -> Path:
    override = os.environ.get("JARVIS_WIDGET_JOBS")
    base = Path(override) if override else _data_dir() / "widget_jobs"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _viewers_dir() -> Path:
    override = os.environ.get("JARVIS_WIDGET_VIEWERS")
    base = Path(override) if override else _data_dir() / "widget_viewers"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _supervisor_pidfile() -> Path:
    override = os.environ.get("JARVIS_WIDGET_SUPERVISOR_PID")
    return Path(override) if override else _data_dir() / "widget_supervisor.pid"


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in str(name)) or "w"


def _job_file(wid: str) -> Path:
    return _jobs_dir() / f"{_safe(wid)}.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip() or 0) or None
    except (OSError, ValueError):
        return None


def _substitute(template, value: str):
    """Replace the literal token {{value}} anywhere in the spec template with the
    command's output. Done on the JSON text so it works in any field (a number
    field as "value":"{{value}}" still works — the renderer coerces strings)."""
    text = json.dumps(template)
    text = text.replace("{{value}}", json.dumps(value)[1:-1])  # value, JSON-escaped, no quotes
    try:
        return json.loads(text)
    except ValueError:
        return template


# ----- viewer leases (written by the daemon, read by the supervisor) --------

def _lease_key(source: str, scope: str) -> str:
    return f"{_safe(source)}__{_safe(scope)}"


def write_lease(scope: str, kind: str, source: str, ts_ms: int | None = None) -> Path:
    """Register/refresh a viewer lease. Best-effort. The daemon owns this in
    production; exposed here for tests and any Python-side caller."""
    if ts_ms is None:
        ts_ms = int(time.time() * 1000)
    rec = {"scope": str(scope), "kind": str(kind), "source": str(source), "ts": int(ts_ms)}
    p = _viewers_dir() / f"{_lease_key(source, scope)}.json"
    try:
        p.write_text(json.dumps(rec), encoding="utf-8")
    except OSError:
        pass
    return p


def clear_lease(scope: str, source: str) -> None:
    try:
        (_viewers_dir() / f"{_lease_key(source, scope)}.json").unlink()
    except OSError:
        pass


def read_leases(now_ms: int | None = None) -> list:
    """All viewer leases that are still fresh (within LEASE_TTL_MS)."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    out = []
    for f in _viewers_dir().glob("*.json"):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        ts = int(rec.get("ts", 0) or 0)
        if now_ms - ts <= LEASE_TTL_MS:
            out.append(rec)
    return out


# ----- coverage / cadence (pure decision logic) -----------------------------

def coverage(job: dict, leases: list) -> tuple:
    """Is `job` covered by a fresh lease, and is any covering lease a real VIEWER
    (chat/canvas/popout) as opposed to a battery-floored pin? Returns (covered,
    viewer)."""
    jid = str(job.get("id") or "")
    sid = str(job.get("session_id") or "")
    covered = False
    viewer = False
    for ls in leases:
        scope = str(ls.get("scope") or "")
        match = (scope == "all") or (bool(sid) and scope == sid) or (scope == f"widget:{jid}")
        if match:
            covered = True
            if str(ls.get("kind") or "") != "pin":
                viewer = True
    return covered, viewer


def effective_interval(job: dict, viewer: bool) -> float:
    base = max(1.0, float(job.get("interval_sec", 5) or 5))
    return base if viewer else max(base, PIN_FLOOR_SEC)


class Supervisor:
    """Holds per-job timing/dedup state and decides, each tick, which jobs to run
    and emit. Dependency-injected runner/emitter keep it unit-testable with a
    fake clock — no real shell or sleeps in tests."""

    def __init__(self):
        self.last_value: dict = {}
        self.last_run: dict = {}
        self.covered: dict = {}  # id -> covered last tick (for force-on-new-coverage)

    def tick(self, now: float, jobs: list, leases: list, runner, emitter) -> None:
        for job in jobs:
            jid = str(job.get("id") or "")
            covered, viewer = coverage(job, leases)
            if not covered:
                self.covered[jid] = False
                continue
            interval = effective_interval(job, viewer)
            newly = not self.covered.get(jid, False)
            self.covered[jid] = True
            due = newly or (now - self.last_run.get(jid, 0.0)) >= interval
            if not due:
                continue
            value = runner(job)
            self.last_run[jid] = now
            if (not newly) and value == self.last_value.get(jid, _UNSET):
                continue  # dedup unchanged value
            emitter(job, value)
            self.last_value[jid] = value
        # forget state for jobs that no longer exist
        ids = {str(j.get("id") or "") for j in jobs}
        for d in (self.last_value, self.last_run, self.covered):
            for gone in [k for k in d if k not in ids]:
                d.pop(gone, None)


# ----- job store ------------------------------------------------------------

def _load_jobs() -> list:
    out = []
    for jf in _jobs_dir().glob("*.json"):
        try:
            out.append(json.loads(jf.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _run_command(job: dict) -> str:
    command = str(job.get("command") or "")
    interval = max(1.0, float(job.get("interval_sec", 5) or 5))
    try:
        res = subprocess.run(command, shell=True, capture_output=True, text=True,
                             timeout=max(2.0, min(interval, 30.0)))
        return (res.stdout or res.stderr or "").strip()
    except Exception:
        return ""


def _emit(job: dict, value: str) -> None:
    jid = str(job.get("id") or "")
    # Tombstone check: if the job was deleted mid-iteration, don't resurrect it.
    if not _job_file(jid).exists():
        return
    spec = _substitute(job.get("template"), value)
    try:
        widgets_bus.append_widget(spec, title=job.get("title", ""), widget_id=jid,
                                 target=job.get("target", "canvas"),
                                 session_id=job.get("session_id", ""))
    except Exception:
        pass


# ----- public API (called by tools_widgets.py) ------------------------------

def start(widget_id: str, command: str, interval_sec: float, template,
          title: str = "", target: str = "canvas", session_id: str | None = None) -> dict:
    """Create/replace a live job for `widget_id`, render it once immediately so the
    card exists, and make sure the supervisor is running. Returns the job record."""
    wid = str(widget_id or "").strip() or f"live{int(time.time() * 1000)}"
    if session_id is None:
        session_id = os.environ.get("JARVIS_AGENT_SESSION", "")
    job = {
        "id": wid,
        "command": str(command or ""),
        "interval_sec": max(1.0, float(interval_sec or 5)),
        "template": template,
        "title": str(title or ""),
        "target": str(target or "canvas"),
        "session_id": str(session_id or ""),
        "bus": str(widgets_bus.bus_path()),
        "started": int(time.time() * 1000),
    }
    try:
        _job_file(wid).write_text(json.dumps(job), encoding="utf-8")
    except OSError:
        pass
    # One immediate render so the card shows right away (the supervisor takes over
    # updates once a viewer is present).
    try:
        _emit(job, _run_command(job))
    except Exception:
        pass
    ensure_supervisor()
    return job


def delete(widget_id: str) -> bool:
    """Stop a live job and drop its card. True if a job file existed. Unlinks the
    job file (the supervisor's tombstone check then refuses any further append) and
    appends a `remove` marker so every surface drops the card immediately."""
    jf = _job_file(widget_id)
    existed = jf.exists()
    try:
        jf.unlink()
    except OSError:
        pass
    try:
        widgets_bus.append_op("remove", str(widget_id))
    except Exception:
        pass
    return existed


def stop(widget_id: str) -> bool:
    """Backwards-compatible alias — widget_live_stop deletes the job."""
    return delete(widget_id)


def delete_all(session_id: str | None = None) -> int:
    """Stop live jobs. If `session_id` is given, only that session's jobs (so one
    session's canvas_clear can't kill another session's live widgets). Returns the
    count stopped."""
    n = 0
    for job in _load_jobs():
        if session_id is None or str(job.get("session_id") or "") == str(session_id):
            delete(str(job.get("id") or ""))
            n += 1
    return n


def list_jobs() -> list:
    sup = _read_pid(_supervisor_pidfile())
    sup_alive = bool(sup and _alive(sup))
    leases = read_leases()
    out = []
    for job in _load_jobs():
        covered, _ = coverage(job, leases)
        out.append({
            "id": job.get("id"),
            "command": job.get("command"),
            "interval_sec": job.get("interval_sec"),
            "running": sup_alive,
            "active": covered,  # currently being driven (a viewer is watching)
        })
    return out


# ----- the supervisor process ----------------------------------------------

def ensure_supervisor() -> int:
    """Spawn the single detached supervisor if none is alive. Idempotent and
    best-effort; guarded by an O_EXCL pid-file with stale-pid takeover."""
    try:
        pf = _supervisor_pidfile()
        pf.parent.mkdir(parents=True, exist_ok=True)
        pid = _read_pid(pf)
        if pid and _alive(pid):
            return pid
        try:
            fd = os.open(str(pf), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pid = _read_pid(pf)
            if pid and _alive(pid):
                return pid
            # Stale pid-file: a concrete dead pid (or empty file we created and
            # never filled). Reclaim it and retry once.
            try:
                pf.unlink()
            except OSError:
                pass
            try:
                fd = os.open(str(pf), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                return _read_pid(pf) or 0
        os.close(fd)
        proc = subprocess.Popen(
            [sys.executable, "-m", "computer_use_mcp.live_widgets", "--supervise"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            pf.write_text(str(proc.pid), encoding="utf-8")
        except OSError:
            pass
        return proc.pid
    except Exception:
        return 0


def _supervise_loop() -> None:
    pf = _supervisor_pidfile()
    mypid = os.getpid()
    try:
        pf.parent.mkdir(parents=True, exist_ok=True)
        pf.write_text(str(mypid), encoding="utf-8")
    except OSError:
        pass
    sup = Supervisor()
    idle_since = None
    try:
        while True:
            owner = _read_pid(pf)
            if owner and owner != mypid and _alive(owner):
                return  # another supervisor won; stand down
            if owner is None or owner != mypid:
                try:
                    pf.write_text(str(mypid), encoding="utf-8")
                except OSError:
                    pass
            now = time.time()
            jobs = _load_jobs()
            if jobs:
                idle_since = None
                sup.tick(now, jobs, read_leases(int(now * 1000)), _run_command, _emit)
            else:
                if idle_since is None:
                    idle_since = now
                elif now - idle_since >= IDLE_EXIT_SEC:
                    return  # nothing to do; free the process (respawned on demand)
            time.sleep(SUPERVISOR_TICK)
    finally:
        try:
            if _read_pid(pf) == mypid:
                pf.unlink()
        except OSError:
            pass


def _sigterm(_signum, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--supervise":
        signal.signal(signal.SIGTERM, _sigterm)
        _supervise_loop()
