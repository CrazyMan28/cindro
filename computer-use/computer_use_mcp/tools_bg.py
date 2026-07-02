"""Background-job / monitor / sleep-wake MCP tools for the co-work brain.

Exposed ON the computer-use engine (the same isolated MCP server the brain already
drives), so Jarvis can launch long-running work, then either keep going or "sleep"
and be AUTOMATICALLY WOKEN when the work finishes / a condition trips / a timer
fires — without the user babysitting it. State is managed by ``bg_jobs`` and the
wake is delivered through jarvisd's ``session.wake`` (daemon_client). Failures
return a JSON ``{"error": ...}``.
"""

from __future__ import annotations

import json
import time

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import bg_jobs


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def register(mcp: FastMCP) -> None:

    @mcp.tool()
    def bg_start(command: str, cwd: str = "", name: str = "",
                 notify_on_done: bool = True) -> str:
        """Start a shell COMMAND as a detached BACKGROUND JOB and return immediately
        with its id. The job keeps running after this call (and across engine
        restarts); its combined stdout/stderr is captured to a log. When it
        finishes you are AUTOMATICALLY woken with the exit code + a tail of the
        output (when notify_on_done), so you can act on the result without polling.

        Use for anything slow: model training/fine-tuning, builds, deploys, large
        downloads, test suites. Example: bg_start("python train.py", name="finetune").
        Then you can sleep (wake_me_in) or just stop — you'll be woken when it's done.
        Inspect with bg_status / bg_logs; cancel with bg_stop."""
        try:
            return json.dumps(bg_jobs.start(command, cwd, name, notify_on_done))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def bg_status(id: str) -> str:
        """Status of one background job/monitor/timer (state, pid, exit_code,
        timing). States: running, done, failed, stopped, expired, ended."""
        try:
            return json.dumps(bg_jobs.status(id))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def bg_logs(id: str, lines: int = 80) -> str:
        """Return the last N lines of a background job's combined stdout/stderr."""
        try:
            return json.dumps(bg_jobs.logs(id, lines))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def bg_stop(id: str) -> str:
        """Stop/kill a background job, monitor, or wake-timer by id (terminates the
        whole process group)."""
        try:
            return json.dumps(bg_jobs.stop(id))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def bg_list() -> str:
        """List all background jobs / monitors / wake-timers and their states."""
        try:
            return json.dumps(bg_jobs.listing())
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def bg_wait(id: str, timeout_sec: int = 7200) -> str:
        """BLOCK until a background job finishes (or timeout), then return its final
        status. Usually unnecessary — you're woken automatically — but use it when
        you specifically want to wait inline before doing the next thing."""
        try:
            end = time.time() + max(5, min(int(timeout_sec or 7200), 14400))
            while time.time() < end:
                m = bg_jobs.status(id)
                if m.get("state") in ("done", "failed", "stopped", "expired", "ended"):
                    return json.dumps(m)
                time.sleep(2)
            m = bg_jobs.status(id)
            m["timed_out"] = True
            return json.dumps(m)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def monitor(command: str, interval_sec: int = 30, until_regex: str = "",
                until_exit: int = -1, wake_on_match: bool = True,
                max_checks: int = 0, name: str = "") -> str:
        """Run COMMAND every interval_sec and WAKE you when a condition trips:
        either until_regex matches the command's output, OR the command exits with
        code until_exit (pass until_exit=-1 to ignore the exit code and match only
        on the regex). max_checks=0 means watch indefinitely; otherwise give up
        (and wake you) after that many checks.

        Use to watch something you can't get a completion callback for: a training
        run's metric file, a job queue, a service health endpoint, a file appearing.
        Example: monitor("nvidia-smi | grep python || true", interval_sec=60,
        until_regex="No running processes", name="gpu-idle")."""
        try:
            ue = None if int(until_exit) < 0 else int(until_exit)
            return json.dumps(bg_jobs.monitor(command, interval_sec, until_regex, ue,
                                              wake_on_match, max_checks, name))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def watch(command: str, interval_sec: int = 60, learn_checks: int = 5,
              sensitivity: str = "medium", mode: str = "auto",
              max_checks: int = 0, name: str = "") -> str:
        """PROACTIVE ANOMALY WATCHER (jarvis#68): silently watch something in the
        background and only WAKE you when it does something UNUSUAL — a low-noise
        guardian, not a firehose.

        Runs COMMAND every interval_sec. The first `learn_checks` runs LEARN a
        baseline (nothing fires during learning). After that:
          - if the output is a NUMBER (cpu %, queue depth, error count), it wakes
            you when the value deviates from the learned mean by more than the
            sensitivity threshold;
          - otherwise it treats output as LINES and wakes you when a NEW line
            appears that wasn't in the baseline (a new error in a log).
        sensitivity: low (only wild swings) | medium | high (twitchy). `mode`:
        auto|numeric|lines. max_checks=0 = watch forever (until bg_stop).

        A given anomaly alerts ONCE, not every interval — a persistent condition
        won't spam you. Examples:
        watch("cat /proc/loadavg", name="load"),
        watch("tail -n 40 /var/log/app.log", mode="lines", name="app-errors"),
        watch("systemctl is-failed --quiet x && echo DOWN || echo UP", name="svc")."""
        try:
            return json.dumps(bg_jobs.watch(command, interval_sec, learn_checks,
                                            sensitivity, mode, max_checks, name))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    @mcp.tool()
    def wake_me_in(seconds: int, note: str = "") -> str:
        """Sleep, then WAKE yourself after `seconds`, optionally with a note-to-self
        that's handed back to you on wake. Use to pause and resume later
        (e.g. wake_me_in(300, "re-check the deploy logs")). Returns a timer id you
        can cancel with bg_stop."""
        try:
            return json.dumps(bg_jobs.sleep_wake(seconds, note))
        except Exception as exc:  # noqa: BLE001
            return _err(exc)
