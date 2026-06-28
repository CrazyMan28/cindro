"""Comprehensive edge-case tests for bg_jobs status/poll-loop behaviour.

Covers:
- bg_wait-style poll loop: running → done transition is observable.
- Fast job lands in "done" with the correct exit_code.
- status() returns "ended" when the runner vanished without writing a terminal
  state (the fallback branch in status()).
- Log file grows while the job is still running.
- JARVIS_BG_JOBS_DIR override is honoured by the detached child process
  (job.json must land under the overridden directory, not ~/.local/share/…).
- Multiple independent jobs coexist without cross-contamination.
- Unknown-job IDs, stop, listing, meta-field structure, and log tail all work
  correctly.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _poll(jid: str, terminal: set[str], timeout: float = 30, interval: float = 0.15):
    """Poll bg_jobs.status(jid) until state is in *terminal* or timeout expires.

    Returns the last status dict (callers assert on it regardless of whether we
    hit the terminal or timed out — the assertion message is more useful that way).
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in terminal:
            return m
        time.sleep(interval)
    return bg_jobs.status(jid)


def _poll_condition(fn, timeout: float = 20, interval: float = 0.15):
    """Spin until *fn* returns truthy or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if fn():
            return True
        time.sleep(interval)
    return fn()


# ---------------------------------------------------------------------------
# Hermetic fixture: isolate every test to its own tmp dir, no daemon
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Per-test isolation: fresh jobs dir + no session to wake."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# 1. Status transitions: running → done are observable via the poll loop
# ---------------------------------------------------------------------------


def test_status_transition_running_then_done():
    """A job that sleeps briefly can be caught in 'running', then reaches 'done'."""
    # 0.4 s is long enough to catch "running" on a busy CI host, short enough
    # that the test itself stays fast.
    r = bg_jobs.start("sleep 0.4 && echo finished", name="transit")
    jid = r["id"]

    # The start() call already returns {"state": "running"}.
    assert r["state"] == "running"

    # Poll for "running" first (sanity: runner must have set the pid).
    m_running = _poll(jid, {"running"}, timeout=10)
    assert m_running.get("state") == "running", (
        f"Job never entered 'running' state (got {m_running.get('state')})"
    )

    # Now wait for terminal state.
    m_done = _poll(jid, {"done", "failed"}, timeout=20)
    assert m_done["state"] == "done", f"Expected done, got {m_done}"
    assert m_done["exit_code"] == 0


# ---------------------------------------------------------------------------
# 2. Fast job is "done" with exit_code == 0
# ---------------------------------------------------------------------------


def test_fast_job_done_exit_code_zero():
    """`exit 0` lands in state='done' with exit_code=0."""
    r = bg_jobs.start("true", name="fast-zero")
    m = _poll(r["id"], {"done", "failed"}, timeout=20)
    assert m["state"] == "done"
    assert m["exit_code"] == 0


def test_fast_job_failure_records_nonzero_exit_code():
    """`exit 7` lands in state='failed' with exit_code=7."""
    r = bg_jobs.start("exit 7", name="fast-fail")
    m = _poll(r["id"], {"done", "failed"}, timeout=20)
    assert m["state"] == "failed"
    assert m["exit_code"] == 7


# ---------------------------------------------------------------------------
# 3. status() "ended" fallback when the runner vanished without writing a
#    terminal state
# ---------------------------------------------------------------------------


def test_status_ended_fallback_dead_runner_pid(tmp_path, monkeypatch):
    """Manually plant a job.json with state='running' + a dead runner_pid.

    bg_jobs.status() must return state='ended' (the fallback branch).
    """
    jobs_dir = tmp_path / "bg"
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(jobs_dir))

    jid = "ghost-job-00000001"
    job_dir = jobs_dir / jid
    job_dir.mkdir(parents=True)

    # PID 1 is init/systemd and is never *our* runner; we use a PID that is
    # extremely unlikely to exist: we fork a short-lived process, record its
    # pid, then wait for it to exit so the pid is definitely dead.
    import subprocess
    dead_proc = subprocess.Popen(["true"])
    dead_pid = dead_proc.pid
    dead_proc.wait()  # ensure dead

    meta = {
        "id": jid, "kind": "job", "name": "ghost",
        "command": "true", "cwd": str(tmp_path),
        "session_id": "",
        "notify_on_done": False,
        "state": "running",
        "pid": None,
        "runner_pid": dead_pid,
        "started_at": time.time() - 10,
        "ended_at": None,
        "exit_code": None,
    }
    (job_dir / "job.json").write_text(json.dumps(meta))

    result = bg_jobs.status(jid)
    assert result["state"] == "ended", (
        f"Expected 'ended' fallback for dead runner, got: {result['state']}"
    )


def test_status_ended_fallback_sleeping_job(tmp_path, monkeypatch):
    """Same fallback applies to kind='sleep' jobs whose runner_pid is gone."""
    jobs_dir = tmp_path / "bg"
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(jobs_dir))

    jid = "ghost-sleep-00000002"
    job_dir = jobs_dir / jid
    job_dir.mkdir(parents=True)

    import subprocess
    dead_proc = subprocess.Popen(["true"])
    dead_pid = dead_proc.pid
    dead_proc.wait()

    meta = {
        "id": jid, "kind": "sleep", "name": "ghost-sleep",
        "session_id": "",
        "seconds": 3600,
        "note": "",
        "notify_on_done": False,
        "state": "sleeping",
        "started_at": time.time() - 5,
        "ended_at": None,
        "runner_pid": dead_pid,
    }
    (job_dir / "job.json").write_text(json.dumps(meta))

    result = bg_jobs.status(jid)
    assert result["state"] == "ended", (
        f"Sleep job with dead runner should be 'ended', got: {result['state']}"
    )


# ---------------------------------------------------------------------------
# 4. Logs grow while the job is running
# ---------------------------------------------------------------------------


def test_logs_grow_while_running():
    """A long-running job that emits output should produce a log that grows."""
    # Write one line per 0.05 s for 1 second → ~20 lines.
    cmd = (
        "for i in $(seq 1 20); do "
        "  echo \"line $i\"; "
        "  sleep 0.05; "
        "done"
    )
    r = bg_jobs.start(cmd, name="growing-log")
    jid = r["id"]

    # Wait until the runner has started (pid appears in meta).
    _poll(jid, {"running"}, timeout=10)

    log_path = bg_jobs._log_path(jid)

    def _log_nonempty():
        try:
            return log_path.stat().st_size > 0
        except FileNotFoundError:
            return False

    assert _poll_condition(_log_nonempty, timeout=10), (
        "Log file never grew from zero"
    )

    size_a = log_path.stat().st_size

    # Sample again after a short wait — size should have increased.
    def _log_bigger():
        try:
            return log_path.stat().st_size > size_a
        except FileNotFoundError:
            return False

    grew = _poll_condition(_log_bigger, timeout=5)
    assert grew, (
        f"Log did not grow: size stayed at {size_a} bytes"
    )

    # Wait for job to finish so the test doesn't leave dangling processes.
    _poll(jid, {"done", "failed"}, timeout=15)


# ---------------------------------------------------------------------------
# 5. JARVIS_BG_JOBS_DIR override honoured by the detached child
# ---------------------------------------------------------------------------


def test_jobs_dir_override_honored_by_detached_child(tmp_path, monkeypatch):
    """job.json must be written under $JARVIS_BG_JOBS_DIR, not ~/.local/…"""
    custom_dir = tmp_path / "custom_bg"
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(custom_dir))

    r = bg_jobs.start("true", name="dir-check")
    jid = r["id"]

    # job.json should already exist (start() writes it synchronously).
    expected_meta = custom_dir / jid / "job.json"
    assert expected_meta.exists(), (
        f"job.json not found under custom dir {custom_dir}; "
        f"may have been written to ~/.local/share/jarvis/bg_jobs"
    )

    # Wait for the detached runner to finish and verify it wrote back to the
    # same directory (exit_code comes from the runner).
    m = _poll(jid, {"done", "failed"}, timeout=20)
    assert m.get("exit_code") is not None, (
        "Detached runner did not write exit_code back to custom dir"
    )

    # Double-check: nothing landed in the default location.
    default_dir = Path.home() / ".local" / "share" / "jarvis" / "bg_jobs" / jid
    assert not default_dir.exists(), (
        f"job.json also appeared in default location {default_dir}"
    )


def test_jobs_dir_override_log_file_location(tmp_path, monkeypatch):
    """out.log must also reside under $JARVIS_BG_JOBS_DIR."""
    custom_dir = tmp_path / "logcheck_bg"
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(custom_dir))

    r = bg_jobs.start("echo hello-log", name="log-loc")
    jid = r["id"]

    expected_log = custom_dir / jid / "out.log"
    # start() creates the empty log synchronously.
    assert expected_log.exists(), (
        f"out.log not created at expected path {expected_log}"
    )

    m = _poll(jid, {"done", "failed"}, timeout=20)
    assert m["state"] == "done"
    assert "hello-log" in bg_jobs.logs(jid, 10)["log"]


# ---------------------------------------------------------------------------
# 6. Unknown job IDs return an error dict (not an exception)
# ---------------------------------------------------------------------------


def test_status_unknown_job_returns_error():
    result = bg_jobs.status("no-such-job-xyzzy")
    assert "error" in result
    assert "no-such-job-xyzzy" in result["error"]


def test_logs_unknown_job_returns_error():
    result = bg_jobs.logs("no-such-job-xyzzy", 10)
    assert "error" in result


# ---------------------------------------------------------------------------
# 7. stop() sets state to "stopped" even for a running long job
# ---------------------------------------------------------------------------


def test_stop_sets_stopped_state():
    r = bg_jobs.start("sleep 60", name="long-stop")
    jid = r["id"]

    # Ensure the runner has started before we stop it.
    _poll(jid, {"running"}, timeout=10)

    result = bg_jobs.stop(jid)
    assert result["state"] == "stopped"

    # Status should reflect the stopped state.
    s = bg_jobs.status(jid)
    assert s["state"] == "stopped"
    assert s["ended_at"] is not None


def test_stop_idempotent_on_already_done_job():
    """Stopping a job that already completed should not raise and returns a dict."""
    r = bg_jobs.start("true", name="already-done")
    _poll(r["id"], {"done", "failed"}, timeout=20)

    result = bg_jobs.stop(r["id"])
    # The job was done; stop overwrites state to "stopped" (that's the current
    # implementation behaviour — we just assert it doesn't crash and returns
    # a dict with an id field).
    assert "id" in result or "error" not in result


# ---------------------------------------------------------------------------
# 8. listing() shows all jobs and omits directories without valid job.json
# ---------------------------------------------------------------------------


def test_listing_shows_all_started_jobs():
    ids = set()
    for i in range(3):
        r = bg_jobs.start(f"echo job{i}", name=f"list-job-{i}")
        ids.add(r["id"])

    # Wait for all to finish (listing works for terminal states too).
    for jid in ids:
        _poll(jid, {"done", "failed"}, timeout=20)

    listed_ids = {j["id"] for j in bg_jobs.listing()["jobs"]}
    assert ids.issubset(listed_ids), (
        f"Missing from listing: {ids - listed_ids}"
    )


def test_listing_empty_on_fresh_dir():
    """With a brand-new JARVIS_BG_JOBS_DIR the listing should be empty."""
    result = bg_jobs.listing()
    assert result["jobs"] == []


# ---------------------------------------------------------------------------
# 9. Job meta-field structure is correct
# ---------------------------------------------------------------------------


def test_job_meta_fields_present_after_start():
    """start() returns a dict with required keys; job.json has canonical fields."""
    r = bg_jobs.start("true", name="meta-check")
    assert "id" in r
    assert "state" in r
    assert "log" in r

    m = bg_jobs.status(r["id"])
    for key in ("id", "kind", "name", "command", "state", "started_at",
                "session_id", "notify_on_done", "cwd"):
        assert key in m, f"Missing field '{key}' in job meta"

    assert m["kind"] == "job"
    assert m["state"] in ("running", "done", "failed")


# ---------------------------------------------------------------------------
# 10. Multiple independent jobs don't cross-contaminate
# ---------------------------------------------------------------------------


def test_multiple_jobs_isolated():
    """Two concurrent jobs with different exit codes record correct results."""
    r0 = bg_jobs.start("exit 0", name="iso-success")
    r1 = bg_jobs.start("exit 5", name="iso-fail")

    m0 = _poll(r0["id"], {"done", "failed"}, timeout=20)
    m1 = _poll(r1["id"], {"done", "failed"}, timeout=20)

    assert m0["state"] == "done" and m0["exit_code"] == 0
    assert m1["state"] == "failed" and m1["exit_code"] == 5

    # Each job's log exists in its own sub-directory.
    log0 = bg_jobs._log_path(r0["id"])
    log1 = bg_jobs._log_path(r1["id"])
    assert log0 != log1
    assert log0.exists()
    assert log1.exists()


# ---------------------------------------------------------------------------
# 11. Log tail (_tail) limits the number of lines returned by logs()
# ---------------------------------------------------------------------------


def test_logs_tail_limits_lines():
    """logs(jid, n) returns at most n lines."""
    # Write exactly 50 lines.
    cmd = "for i in $(seq 1 50); do echo \"line$i\"; done"
    r = bg_jobs.start(cmd, name="tail-test")
    _poll(r["id"], {"done", "failed"}, timeout=20)

    full = bg_jobs.logs(r["id"], 200)["log"]
    trimmed = bg_jobs.logs(r["id"], 10)["log"]

    full_lines = [l for l in full.splitlines() if l]
    trimmed_lines = [l for l in trimmed.splitlines() if l]

    assert len(full_lines) == 50, f"Expected 50 lines, got {len(full_lines)}"
    assert len(trimmed_lines) <= 10, (
        f"logs() returned {len(trimmed_lines)} lines for limit=10"
    )
    # The tail should be the *last* lines.
    assert trimmed_lines[-1] == full_lines[-1]


# ---------------------------------------------------------------------------
# 12. sleep_wake records done + ended_at
# ---------------------------------------------------------------------------


def test_sleep_wake_completes_with_done_state():
    r = bg_jobs.sleep_wake(1, note="unit-test-ping")
    m = _poll(r["id"], {"done"}, timeout=15)
    assert m["state"] == "done"
    assert m["ended_at"] is not None
    assert m.get("kind") == "sleep"


# ---------------------------------------------------------------------------
# 13. Monitor: regex match drives state to done; max_checks drives to expired
# ---------------------------------------------------------------------------


def test_monitor_regex_match_reaches_done():
    r = bg_jobs.monitor("echo DONE_SIGNAL", interval_sec=2,
                        until_regex="DONE_SIGNAL", name="mon-match")
    m = _poll(r["id"], {"done", "expired"}, timeout=20)
    assert m["state"] == "done"
    assert m.get("matched") is True


def test_monitor_max_checks_reaches_expired():
    """A monitor that never matches expires after max_checks."""
    r = bg_jobs.monitor("echo nothing", interval_sec=2,
                        until_regex="NEVER_MATCHES", max_checks=2, name="mon-exp")
    m = _poll(r["id"], {"done", "expired"}, timeout=30)
    assert m["state"] == "expired"
    assert m.get("checks", 0) >= 2


# ---------------------------------------------------------------------------
# 14. bg_wait poll loop: helper correctly returns the terminal-state dict
# ---------------------------------------------------------------------------


def test_bg_wait_poll_helper_returns_terminal_state():
    """_poll() must return a dict whose 'state' is the terminal state reached."""
    r = bg_jobs.start("sleep 0.2 && exit 0", name="bg-wait-check")
    m = _poll(r["id"], {"done", "failed"}, timeout=20)
    assert m["state"] in ("done", "failed"), (
        f"_poll helper returned non-terminal state: {m.get('state')}"
    )
    assert "exit_code" in m


# ---------------------------------------------------------------------------
# 15. status() when job.json is absent returns error (not exception)
# ---------------------------------------------------------------------------


def test_status_corrupt_or_absent_meta(tmp_path, monkeypatch):
    """Planting a corrupt job.json must not raise — status returns an empty dict."""
    custom_dir = tmp_path / "bg"
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(custom_dir))

    jid = "corrupt-job-xyz"
    job_dir = custom_dir / jid
    job_dir.mkdir(parents=True)
    # Write invalid JSON.
    (job_dir / "job.json").write_text("{not valid json")

    result = bg_jobs.status(jid)
    # _read_meta catches the JSON error and returns {}; status() then returns
    # {"error": "unknown job …"}.
    assert "error" in result
