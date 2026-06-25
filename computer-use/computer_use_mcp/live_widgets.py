"""Live (auto-updating) widgets — a model-controlled background refresher.

The model can make ANY widget update on its own by attaching a background job:
run a shell `command` every `interval_sec`, take its stdout, substitute it into a
widget spec template (the literal token "{{value}}"), and append the result to the
widget bus under the SAME id (so the desktop replaces the card in place). Works for
anything a command can produce — CPU%, a price, a queue depth, the weather.

Two entry points:
  * start()/stop()/list_jobs() — the tool layer (tools_widgets.py) calls these.
  * `python -m computer_use_mcp.live_widgets <jobfile>` — the detached loop body
    each job runs. Reading params from a file keeps the spawn argv tiny and avoids
    quoting a whole spec on the command line.

Jobs live in ~/.local/share/jarvis/widget_jobs/<id>.json; each holds its params +
the running pid. Best-effort throughout; a broken job never escapes into a tool.
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


def _jobs_dir() -> Path:
    override = os.environ.get("JARVIS_WIDGET_JOBS")
    base = Path(override) if override else (
        Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        / "jarvis" / "widget_jobs"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _job_file(wid: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(wid)) or "w"
    return _jobs_dir() / f"{safe}.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


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


def start(widget_id: str, command: str, interval_sec: float, template,
          title: str = "", target: str = "canvas") -> dict:
    """Start (or restart) a live job for `widget_id`. Returns the job record."""
    wid = str(widget_id or "").strip()
    if not wid:
        wid = f"live{int(time.time()*1000)}"
    stop(wid)  # replace any existing job for this id
    interval = max(1.0, float(interval_sec or 5))
    job = {
        "id": wid,
        "command": str(command or ""),
        "interval_sec": interval,
        "template": template,
        "title": str(title or ""),
        "target": str(target or "canvas"),
        "bus": str(widgets_bus.bus_path()),
        "started": int(time.time() * 1000),
    }
    jf = _job_file(wid)
    jf.write_text(json.dumps(job), encoding="utf-8")
    # Spawn the loop detached so it outlives this (per-session) engine process.
    proc = subprocess.Popen(
        [sys.executable, "-m", "computer_use_mcp.live_widgets", str(jf)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
        env={**os.environ, "JARVIS_WIDGETS_LOG": job["bus"]},
    )
    job["pid"] = proc.pid
    jf.write_text(json.dumps(job), encoding="utf-8")
    return job


def stop(widget_id: str) -> bool:
    """Stop a live job (kill its loop) and forget it. True if one was running."""
    jf = _job_file(widget_id)
    if not jf.exists():
        return False
    try:
        job = json.loads(jf.read_text(encoding="utf-8"))
        pid = int(job.get("pid") or 0)
        if pid and _alive(pid):
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except OSError:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
    except (OSError, ValueError):
        pass
    try:
        jf.unlink()
    except OSError:
        pass
    return True


def list_jobs() -> list:
    out = []
    for jf in _jobs_dir().glob("*.json"):
        try:
            job = json.loads(jf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pid = int(job.get("pid") or 0)
        out.append({
            "id": job.get("id"),
            "command": job.get("command"),
            "interval_sec": job.get("interval_sec"),
            "running": bool(pid and _alive(pid)),
        })
    return out


def _run_loop(jobfile: str) -> None:
    """The detached loop body: refresh the widget until the job file disappears."""
    jf = Path(jobfile)
    try:
        job = json.loads(jf.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    wid = job.get("id", "")
    command = job.get("command", "")
    interval = max(1.0, float(job.get("interval_sec", 5)))
    template = job.get("template")
    title = job.get("title", "")
    target = job.get("target", "canvas")
    while True:
        if not jf.exists():
            return  # stopped
        value = ""
        try:
            res = subprocess.run(command, shell=True, capture_output=True,
                                 text=True, timeout=max(2.0, interval))
            value = (res.stdout or res.stderr or "").strip()
        except Exception:
            value = ""
        spec = _substitute(template, value)
        try:
            widgets_bus.append_widget(spec, title=title, widget_id=wid, target=target)
        except Exception:
            pass
        time.sleep(interval)


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        _run_loop(sys.argv[1])
