"""Background jobs, monitors, and sleep/wake timers for the co-work brain.

Lets Jarvis kick off a long-running shell job (a training run, a build, a deploy,
a big download), then go do other things — or sleep — and be AUTOMATICALLY WOKEN
when it finishes, after N seconds, or when a watched condition trips. The wake
injects a turn back into the originating Jarvis session via the daemon's
``session.wake`` method (over ``daemon_client``), reusing the exact mechanism that
wakes a parent agent when a subagent finishes.

Each job is a DETACHED process tree rooted at a small runner (this module run with
``--run`` / ``--monitor`` / ``--sleep``), so it survives the MCP tool call
returning and even the engine restarting. State + logs live under
``~/.local/share/jarvis/bg_jobs/<id>/`` (``job.json`` + ``out.log``).

The session to wake is taken from the ``JARVIS_AGENT_SESSION`` env (the same one
``agent_start`` uses) at start time and frozen into ``job.json``.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from computer_use_mcp import anomaly, daemon_client

def _jobs_root() -> Path:
    # Honors $JARVIS_BG_JOBS_DIR (used by tests, and lets ops relocate state).
    # Resolved at call time so the detached runner — which re-execs this module —
    # picks up the same root the parent used (it inherits the env).
    override = os.environ.get("JARVIS_BG_JOBS_DIR")
    return Path(override) if override else Path(
        os.path.expanduser("~/.local/share/jarvis/bg_jobs"))


def _now() -> float:
    return time.time()


def _job_dir(jid: str) -> Path:
    return _jobs_root() / jid


def _meta_path(jid: str) -> Path:
    return _job_dir(jid) / "job.json"


def _log_path(jid: str) -> Path:
    return _job_dir(jid) / "out.log"


def _new_id(name: str = "") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "job").lower()).strip("-")[:24] or "job"
    return f"{slug}-{int(_now() * 1000) % 100000000:08d}"


def _read_meta(jid: str) -> dict:
    try:
        return json.loads(_meta_path(jid).read_text())
    except Exception:
        return {}


def _write_meta(jid: str, meta: dict) -> None:
    p = _meta_path(jid)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Unique temp file per write (mkstemp), NOT a shared "job.tmp": two writers for
    # the same job (e.g. a concurrent stop + a status update) would otherwise both
    # write the same job.tmp, the first os.replace() renames it to job.json, and the
    # second os.replace() dies with FileNotFoundError (job.tmp already gone). That was
    # the flaky test_concurrent_stop_all / test_ended_at_none_while_job_running race.
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=p.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(meta, indent=2))
        os.replace(tmp, p)  # atomic
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def _tail(text: str, n: int) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if len(lines) > n else text


def _session_default(session_id: str = "") -> str:
    return session_id or os.environ.get("JARVIS_AGENT_SESSION", "")


def _wake(session_id: str, message: str, critical: bool = False) -> None:
    """Best-effort: inject a wake turn into the originating session via jarvisd."""
    if not session_id:
        return
    try:
        daemon_client.call(
            "session.wake",
            {"session_id": session_id, "message": message, "critical": bool(critical)},
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001 — best effort
        sys.stderr.write(f"bg_jobs: wake({session_id}) failed: {exc}\n")


# ---- public API (called by tools_bg.py) ------------------------------------


def start(command: str, cwd: str = "", name: str = "",
          notify_on_done: bool = True, session_id: str = "") -> dict:
    jid = _new_id(name)
    _job_dir(jid).mkdir(parents=True, exist_ok=True)
    _log_path(jid).write_text("")
    meta = {
        "id": jid, "kind": "job", "name": name or command[:40],
        "command": command, "cwd": cwd or os.getcwd(),
        "session_id": _session_default(session_id),
        "notify_on_done": bool(notify_on_done),
        "state": "starting", "pid": None, "runner_pid": None,
        "started_at": _now(), "ended_at": None, "exit_code": None,
    }
    _write_meta(jid, meta)
    meta["runner_pid"] = _spawn_runner(["--run", "--job", jid])
    meta["state"] = "running"
    _write_meta(jid, meta)
    return {"id": jid, "state": "running", "log": str(_log_path(jid)),
            "session_id": meta["session_id"]}


def monitor(command: str, interval_sec: int = 30, until_regex: str = "",
            until_exit=None, wake_on_match: bool = True, max_checks: int = 0,
            name: str = "", session_id: str = "") -> dict:
    jid = _new_id(name or "monitor")
    _job_dir(jid).mkdir(parents=True, exist_ok=True)
    _log_path(jid).write_text("")
    meta = {
        "id": jid, "kind": "monitor", "name": name or "monitor",
        "command": command, "cwd": os.getcwd(),
        "session_id": _session_default(session_id),
        "interval_sec": max(2, int(interval_sec)),
        "until_regex": until_regex, "until_exit": until_exit,
        "wake_on_match": bool(wake_on_match), "max_checks": int(max_checks),
        "notify_on_done": True, "state": "running", "checks": 0,
        "started_at": _now(), "ended_at": None, "matched": False, "runner_pid": None,
    }
    _write_meta(jid, meta)
    meta["runner_pid"] = _spawn_runner(["--monitor", "--job", jid])
    _write_meta(jid, meta)
    return {"id": jid, "state": "running"}


def watch(command: str, interval_sec: int = 60, learn_checks: int = 5,
          sensitivity: str = "medium", mode: str = "auto", max_checks: int = 0,
          name: str = "", session_id: str = "") -> dict:
    """Proactive anomaly watcher (jarvis#68): poll `command` every interval,
    learn a baseline, and WAKE the session only when something unusual appears.
    Runs indefinitely (until stopped) unless max_checks is set."""
    jid = _new_id(name or "watch")
    _job_dir(jid).mkdir(parents=True, exist_ok=True)
    _log_path(jid).write_text("")
    meta = {
        "id": jid, "kind": "watch", "name": name or "watch",
        "command": command, "cwd": os.getcwd(),
        "session_id": _session_default(session_id),
        "interval_sec": max(5, int(interval_sec)),
        "max_checks": int(max_checks),
        "notify_on_done": False, "state": "watching",
        "anomalies": 0, "started_at": _now(), "ended_at": None, "runner_pid": None,
        "watch_state": anomaly.new_state(mode, learn_checks, sensitivity),
    }
    _write_meta(jid, meta)
    meta["runner_pid"] = _spawn_runner(["--watch", "--job", jid])
    _write_meta(jid, meta)
    return {"id": jid, "state": "watching",
            "learning_checks": meta["watch_state"]["learn_checks"]}


def sleep_wake(seconds: int, note: str = "", session_id: str = "") -> dict:
    jid = _new_id("wake")
    _job_dir(jid).mkdir(parents=True, exist_ok=True)
    meta = {
        "id": jid, "kind": "sleep", "name": f"wake in {int(seconds)}s",
        "session_id": _session_default(session_id),
        "seconds": max(1, int(seconds)), "note": note,
        "notify_on_done": False, "state": "sleeping",
        "started_at": _now(), "ended_at": None, "runner_pid": None,
    }
    _write_meta(jid, meta)
    meta["runner_pid"] = _spawn_runner(["--sleep", "--job", jid])
    _write_meta(jid, meta)
    return {"id": jid, "state": "sleeping", "wake_in_sec": meta["seconds"]}


def status(jid: str) -> dict:
    m = _read_meta(jid)
    if not m:
        return {"error": f"unknown job {jid}"}
    # If the runner vanished without recording an exit, surface that.
    if m.get("state") in ("running", "sleeping") and m.get("runner_pid") \
            and not _alive(m.get("runner_pid")):
        m["state"] = "ended"
    return m


def logs(jid: str, lines: int = 80) -> dict:
    try:
        return {"id": jid, "log": _tail(_log_path(jid).read_text(errors="replace"),
                                        int(lines))}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def stop(jid: str) -> dict:
    m = _read_meta(jid)
    if not m:
        return {"error": f"unknown job {jid}"}
    for key in ("pid", "runner_pid"):
        pid = m.get(key)
        if pid and _alive(pid):
            try:
                os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
            except Exception:
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except Exception:
                    pass
    m["state"] = "stopped"
    m["ended_at"] = _now()
    _write_meta(jid, m)
    return {"id": jid, "state": "stopped"}


def listing() -> dict:
    out = []
    root = _jobs_root()
    if root.exists():
        for d in sorted(root.iterdir()):
            m = _read_meta(d.name)
            if m:
                out.append({k: m.get(k) for k in
                            ("id", "kind", "name", "state", "started_at",
                             "ended_at", "exit_code")})
    return {"jobs": out}


# ---- runner (detached child process) ---------------------------------------


def _spawn_runner(args) -> int:
    # Re-exec THIS module detached in its own session/process group. Strip
    # PYTHONPATH so a leaked user site-packages can't break the venv import.
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    cmd = [sys.executable, "-m", "computer_use_mcp.bg_jobs", *args]
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, env=env)
    return p.pid


def _run_job(jid: str) -> None:
    m = _read_meta(jid)
    log = open(_log_path(jid), "a", buffering=1)
    rc = 127
    try:
        proc = subprocess.Popen(m["command"], shell=True, cwd=m.get("cwd") or None,
                                stdout=log, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
        m["pid"] = proc.pid
        m["state"] = "running"
        _write_meta(jid, m)
        rc = proc.wait()
    except Exception as exc:  # noqa: BLE001
        log.write(f"\n[bg_jobs] runner error: {exc}\n")
    m = _read_meta(jid)
    if m.get("state") == "stopped":
        log.close()
        return
    m["exit_code"] = rc
    m["state"] = "done" if rc == 0 else "failed"
    m["ended_at"] = _now()
    _write_meta(jid, m)
    log.close()
    if m.get("notify_on_done") and m.get("session_id"):
        tail = _tail(_log_path(jid).read_text(errors="replace"), 40)
        verdict = "succeeded" if rc == 0 else f"FAILED (exit {rc})"
        _wake(m["session_id"],
              f"[BACKGROUND JOB {verdict}] \"{m.get('name')}\" (id {jid}).\n"
              f"Command: {m.get('command')}\n"
              f"Last output:\n{tail}\n\nPick the task back up based on this result.",
              critical=(rc != 0))


def _run_monitor(jid: str) -> None:
    m = _read_meta(jid)
    log = open(_log_path(jid), "a", buffering=1)
    rx = re.compile(m["until_regex"]) if m.get("until_regex") else None
    checks = 0
    while True:
        m = _read_meta(jid)
        if m.get("state") == "stopped":
            break
        checks += 1
        out = ""
        r = None
        try:
            r = subprocess.run(m["command"], shell=True, cwd=m.get("cwd") or None,
                               capture_output=True, text=True, timeout=120)
            out = (r.stdout or "") + (r.stderr or "")
            log.write(f"[check {checks} rc={r.returncode}] {out.strip()[:400]}\n")
        except Exception as exc:  # noqa: BLE001
            log.write(f"[check {checks}] error: {exc}\n")
        matched = bool(rx and rx.search(out))
        if m.get("until_exit") is not None and r is not None \
                and r.returncode == int(m["until_exit"]):
            matched = True
        m["checks"] = checks
        if matched:
            m["matched"] = True
            m["state"] = "done"
            m["ended_at"] = _now()
            _write_meta(jid, m)
            if m.get("wake_on_match") and m.get("session_id"):
                _wake(m["session_id"],
                      f"[MONITOR TRIPPED] \"{m.get('name')}\" (id {jid}) — condition met "
                      f"after {checks} checks.\nCommand: {m.get('command')}\n"
                      f"Last output:\n{out.strip()[:600]}\n\nAct on this.")
            break
        if m.get("max_checks") and checks >= int(m["max_checks"]):
            m["state"] = "expired"
            m["ended_at"] = _now()
            _write_meta(jid, m)
            if m.get("session_id"):
                _wake(m["session_id"],
                      f"[MONITOR EXPIRED] \"{m.get('name')}\" (id {jid}) ran {checks} "
                      f"checks without the condition tripping.")
            break
        _write_meta(jid, m)
        time.sleep(m.get("interval_sec", 30))
    log.close()


def _run_watch(jid: str) -> None:
    m = _read_meta(jid)
    log = open(_log_path(jid), "a", buffering=1)
    while True:
        m = _read_meta(jid)
        if m.get("state") == "stopped":
            break
        out = ""
        try:
            r = subprocess.run(m["command"], shell=True, cwd=m.get("cwd") or None,
                               capture_output=True, text=True, timeout=120)
            out = (r.stdout or "") + (r.stderr or "")
        except Exception as exc:  # noqa: BLE001
            out = f"__probe_error__ {exc}"
        st = m.get("watch_state") or anomaly.new_state()
        report = anomaly.observe(st, out)
        m["watch_state"] = st
        tag = "LEARN" if report["learning"] else ("!! ANOMALY" if report["anomaly"] else "ok")
        log.write(f"[check {report['check']} {tag}] {report.get('detail','')}\n")
        if report["anomaly"] and m.get("session_id"):
            m["anomalies"] = m.get("anomalies", 0) + 1
            _wake(m["session_id"],
                  f"[ANOMALY DETECTED] watcher \"{m.get('name')}\" (id {jid}) — "
                  f"{report.get('detail','')}\nProbe: {m.get('command')}\n"
                  f"Latest output:\n{out.strip()[:600]}\n\n"
                  "This deviates from the learned baseline. Investigate; if it's "
                  "actually fine, you can ignore it (it won't re-alert while it "
                  "persists).", critical=True)
        if m.get("max_checks") and report["check"] >= int(m["max_checks"]):
            m["state"] = "expired"
            m["ended_at"] = _now()
            _write_meta(jid, m)
            break
        _write_meta(jid, m)
        time.sleep(m.get("interval_sec", 60))
    log.close()


def _run_sleep(jid: str) -> None:
    m = _read_meta(jid)
    time.sleep(m.get("seconds", 1))
    m = _read_meta(jid)
    if m.get("state") == "stopped":
        return
    m["state"] = "done"
    m["ended_at"] = _now()
    _write_meta(jid, m)
    note = m.get("note") or ""
    _wake(m.get("session_id", ""),
          f"[WAKE TIMER] You asked to be woken after {m.get('seconds')}s."
          + (f"\nNote to self: {note}" if note else "")
          + "\nResume what you were doing.")


def _main(argv) -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--monitor", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--sleep", action="store_true")
    ap.add_argument("--job", required=True)
    a = ap.parse_args(argv)
    if a.run:
        _run_job(a.job)
    elif a.monitor:
        _run_monitor(a.job)
    elif a.watch:
        _run_watch(a.job)
    elif a.sleep:
        _run_sleep(a.job)


if __name__ == "__main__":
    _main(sys.argv[1:])
