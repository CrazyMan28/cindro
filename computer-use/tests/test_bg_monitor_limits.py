"""Comprehensive edge-case tests for bg_jobs.monitor() limit and control behaviour.

Coverage:
  - max_checks reached without a match -> state "expired"
  - checks counter increments correctly each iteration
  - interval_sec floor (min 2) is enforced and persisted
  - stop() mid-monitor -> state "stopped" and the polling loop halts
  - a command that errors every check is handled gracefully

Hermetic: JARVIS_BG_JOBS_DIR is a fresh tmp_path sub-directory per test;
JARVIS_AGENT_SESSION is deleted so no real daemon wake is attempted.
"""

from __future__ import annotations

import time

import pytest

from computer_use_mcp import bg_jobs
from computer_use_mcp.bg_jobs import _alive


# ---------------------------------------------------------------------------
# Polling helpers
# ---------------------------------------------------------------------------


def _wait(jid: str, states: set, timeout: float = 20) -> dict:
    """Poll bg_jobs.status() until state is in *states* or timeout elapses."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.2)
    return bg_jobs.status(jid)


def _wait_checks(jid: str, min_checks: int, timeout: float = 15) -> dict:
    """Poll until checks >= min_checks or timeout; return final meta."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("checks", 0) >= min_checks:
            return m
        time.sleep(0.2)
    return bg_jobs.status(jid)


def _wait_pid_dead(pid: int, timeout: float = 10) -> bool:
    """Return True once PID is no longer alive, False on timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.2)
    return not _alive(pid)


# ---------------------------------------------------------------------------
# Hermetic fixture (autouse)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Isolate every test: fresh jobs dir, no session -> no daemon calls."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# 1. max_checks expiry
# ---------------------------------------------------------------------------


def test_max_checks_reached_state_is_expired():
    """max_checks iterations with no regex/exit match produce state='expired'."""
    r = bg_jobs.monitor(
        "echo nothing",
        interval_sec=2,
        until_regex="THIS_WILL_NEVER_APPEAR_IN_OUTPUT_XYZ",
        max_checks=1,
        name="expire-basic",
    )
    m = _wait(r["id"], {"expired", "done"}, timeout=15)
    assert m["state"] == "expired", f"expected expired, got {m['state']}"
    assert m.get("matched") is False


def test_expired_checks_equals_max_checks_exactly():
    """At expiry the checks counter must equal max_checks (boundary condition)."""
    r = bg_jobs.monitor(
        "true",
        interval_sec=2,
        until_regex="NOPE",
        max_checks=2,
        name="expire-boundary",
    )
    m = _wait(r["id"], {"expired"}, timeout=25)
    assert m["state"] == "expired"
    assert m["checks"] == 2, f"expected checks==2 at expiry, got {m['checks']}"


def test_expired_has_ended_at_set():
    """ended_at must be populated when the monitor expires."""
    r = bg_jobs.monitor(
        "true",
        interval_sec=2,
        until_regex="NOPE",
        max_checks=1,
        name="expire-ended-at",
    )
    m = _wait(r["id"], {"expired"}, timeout=15)
    assert m.get("ended_at") is not None, "ended_at should be set on expiry"
    assert isinstance(m["ended_at"], float)


# ---------------------------------------------------------------------------
# 2. checks counter increments
# ---------------------------------------------------------------------------


def test_checks_counter_increments_step_by_step():
    """checks grows 0 -> 1 -> 2 -> 3 across successive iterations."""
    r = bg_jobs.monitor(
        "true",
        interval_sec=2,
        until_regex="NOPE",
        max_checks=3,
        name="counter-steps",
    )
    jid = r["id"]

    m1 = _wait_checks(jid, min_checks=1, timeout=10)
    assert m1["checks"] >= 1, "checks should reach 1 after first iteration"

    m2 = _wait_checks(jid, min_checks=2, timeout=12)
    assert m2["checks"] >= 2, "checks should reach 2 after second iteration"

    m3 = _wait(jid, {"expired"}, timeout=15)
    assert m3["checks"] == 3, f"final checks should be 3, got {m3['checks']}"


def test_checks_starts_at_zero_before_first_iteration():
    """metadata['checks'] is 0 immediately after monitor() before runner ticks."""
    r = bg_jobs.monitor(
        "sleep 60",  # command blocks long enough that checks stays 0 at read time
        interval_sec=2,
        max_checks=10,
        name="counter-initial",
    )
    jid = r["id"]
    # Read immediately — the runner may not have started the first check yet.
    # We allow checks == 0 or 1 to tolerate a race, but we must never see > 1
    # this early.
    m = bg_jobs.status(jid)
    assert m.get("checks", 0) <= 1, (
        f"checks should be 0 or 1 at startup, got {m.get('checks')}"
    )
    bg_jobs.stop(jid)
    _wait(jid, {"stopped"}, timeout=10)


# ---------------------------------------------------------------------------
# 3. interval_sec floor (min 2)
# ---------------------------------------------------------------------------


def test_interval_zero_clamped_to_two():
    """interval_sec=0 is clamped to 2 and persisted in the metadata."""
    r = bg_jobs.monitor("true", interval_sec=0, until_regex="NOPE",
                        max_checks=1, name="floor-zero")
    m = bg_jobs.status(r["id"])
    assert m["interval_sec"] == 2, (
        f"interval_sec=0 should be stored as 2, got {m['interval_sec']}"
    )
    _wait(r["id"], {"expired"}, timeout=15)


def test_interval_one_clamped_to_two():
    """interval_sec=1 is clamped to 2 (floor is strictly greater than 1)."""
    r = bg_jobs.monitor("true", interval_sec=1, until_regex="NOPE",
                        max_checks=1, name="floor-one")
    m = bg_jobs.status(r["id"])
    assert m["interval_sec"] == 2, (
        f"interval_sec=1 should be stored as 2, got {m['interval_sec']}"
    )
    _wait(r["id"], {"expired"}, timeout=15)


def test_interval_two_unchanged():
    """interval_sec=2 is already at the floor; must not be modified."""
    r = bg_jobs.monitor("true", interval_sec=2, until_regex="NOPE",
                        max_checks=1, name="floor-exact")
    m = bg_jobs.status(r["id"])
    assert m["interval_sec"] == 2
    _wait(r["id"], {"expired"}, timeout=15)


def test_interval_negative_clamped_to_two():
    """Negative interval_sec: max(2, negative) == 2, so stored as 2."""
    r = bg_jobs.monitor("true", interval_sec=-99, until_regex="NOPE",
                        max_checks=1, name="floor-neg")
    m = bg_jobs.status(r["id"])
    assert m["interval_sec"] == 2, (
        f"interval_sec=-99 should be stored as 2, got {m['interval_sec']}"
    )
    _wait(r["id"], {"expired"}, timeout=15)


def test_interval_large_value_preserved():
    """interval_sec above the floor is stored exactly as given (no upper cap)."""
    r = bg_jobs.monitor(
        "echo match_me",
        interval_sec=300,
        until_regex="match_me",  # matches on first check, so sleep never runs
        max_checks=1,
        name="large-interval",
    )
    m = bg_jobs.status(r["id"])
    assert m["interval_sec"] == 300, (
        f"large interval_sec should be preserved, got {m['interval_sec']}"
    )
    # Command matches on first check -> "done" without sleeping
    m2 = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m2["state"] == "done"


# ---------------------------------------------------------------------------
# 4. stop() mid-monitor
# ---------------------------------------------------------------------------


def test_stop_mid_monitor_state_becomes_stopped():
    """stop() while the loop is running immediately writes state='stopped'."""
    r = bg_jobs.monitor("true", interval_sec=2, max_checks=50, name="stop-state")
    jid = r["id"]
    _wait_checks(jid, min_checks=1, timeout=10)
    result = bg_jobs.stop(jid)
    assert result["state"] == "stopped"
    m = bg_jobs.status(jid)
    assert m["state"] == "stopped", f"expected stopped, got {m['state']}"


def test_stop_halts_loop_checks_do_not_grow():
    """After stop(), the loop detects 'stopped' and exits; checks stop growing.

    The runner is a detached subprocess that may become a zombie after SIGTERM
    (the test process doesn't reap it), so we avoid checking PID liveness —
    that would give a false positive on zombies.  Instead we observe the
    externally visible invariant: checks must not keep incrementing.
    """
    r = bg_jobs.monitor("true", interval_sec=2, max_checks=50, name="stop-halt")
    jid = r["id"]

    m_before = _wait_checks(jid, min_checks=1, timeout=10)
    checks_at_stop = m_before["checks"]

    bg_jobs.stop(jid)

    # Sleep for more than two full intervals; if the loop is still running we'd
    # see at least two more increments.
    time.sleep(5)

    m_after = bg_jobs.status(jid)
    # Allow at most +1 (runner could be mid-iteration when stop() wrote the file)
    assert m_after["checks"] <= checks_at_stop + 1, (
        f"checks grew from {checks_at_stop} to {m_after['checks']} after stop() "
        f"— the loop did not halt"
    )


def test_stop_before_any_checks_sets_stopped():
    """stop() called immediately (before any check completes) still sets 'stopped'."""
    r = bg_jobs.monitor(
        "sleep 120",  # would block indefinitely; we stop it immediately
        interval_sec=2,
        max_checks=20,
        name="stop-early",
    )
    jid = r["id"]
    bg_jobs.stop(jid)
    m = bg_jobs.status(jid)
    assert m["state"] == "stopped", f"expected stopped, got {m['state']}"


def test_stop_does_not_transition_to_expired():
    """A stopped monitor must never change to 'expired' after stop()."""
    r = bg_jobs.monitor("true", interval_sec=2, max_checks=2, name="stop-no-expire")
    jid = r["id"]
    _wait_checks(jid, min_checks=1, timeout=10)
    bg_jobs.stop(jid)

    # Give runner time to exit, then confirm it didn't flip to "expired"
    time.sleep(3)
    m = bg_jobs.status(jid)
    assert m["state"] == "stopped", (
        f"state should stay 'stopped', not revert to {m['state']}"
    )


# ---------------------------------------------------------------------------
# 5. command that errors every check
# ---------------------------------------------------------------------------


def test_error_command_monitor_does_not_crash():
    """A command that exits non-zero on every check does not crash the monitor."""
    r = bg_jobs.monitor(
        "exit 42",
        interval_sec=2,
        until_regex="NOPE",
        max_checks=2,
        name="err-no-crash",
    )
    m = _wait(r["id"], {"expired"}, timeout=20)
    assert m["state"] == "expired", f"expected expired, got {m['state']}"
    assert m["checks"] == 2


def test_error_command_log_has_check_entries():
    """Every failing check writes a [check N] entry to the log file."""
    r = bg_jobs.monitor(
        "echo ERR_OUT >&2; exit 1",
        interval_sec=2,
        until_regex="NOPE",
        max_checks=2,
        name="err-log",
    )
    jid = r["id"]
    m = _wait(jid, {"expired"}, timeout=20)
    assert m["state"] == "expired"
    log_text = bg_jobs.logs(jid, 100)["log"]
    assert "[check 1" in log_text, f"log should contain [check 1]: {log_text!r}"
    assert "[check 2" in log_text, f"log should contain [check 2]: {log_text!r}"


def test_error_command_checks_still_increment():
    """checks counter increments even when the command errors every iteration."""
    r = bg_jobs.monitor(
        "false",  # always exits 1, no output
        interval_sec=2,
        until_regex="NOPE",
        max_checks=2,
        name="err-counter",
    )
    m = _wait(r["id"], {"expired"}, timeout=20)
    assert m["checks"] == 2, (
        f"checks should reach max_checks=2 even with failing command, got {m['checks']}"
    )


# ---------------------------------------------------------------------------
# 6. Complementary / composite edge cases
# ---------------------------------------------------------------------------


def test_max_checks_zero_means_no_limit():
    """max_checks=0 is falsy; the loop never enters the expiry branch."""
    r = bg_jobs.monitor(
        "true",
        interval_sec=2,
        until_regex="WILL_NEVER_APPEAR_EVER",
        max_checks=0,
        name="no-limit",
    )
    jid = r["id"]

    # Wait for at least one check to confirm the monitor is active
    m = _wait_checks(jid, min_checks=1, timeout=10)
    assert m["state"] == "running", (
        f"max_checks=0 should keep monitor running, not {m['state']}"
    )
    assert m["checks"] >= 1

    bg_jobs.stop(jid)
    _wait(jid, {"stopped"}, timeout=10)


def test_regex_match_produces_done_not_expired():
    """A regex match sets state='done' and matched=True, not 'expired'."""
    r = bg_jobs.monitor(
        "echo CONDITION_TRIPPED",
        interval_sec=2,
        until_regex="CONDITION_TRIPPED",
        max_checks=5,
        name="regex-done",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "done", f"regex match should produce 'done', got {m['state']}"
    assert m["matched"] is True


def test_until_exit_match_produces_done():
    """Command matching until_exit code sets state='done' and matched=True."""
    r = bg_jobs.monitor(
        "exit 0",
        interval_sec=2,
        until_exit=0,
        max_checks=5,
        name="exit-done",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "done", (
        f"until_exit=0 match should produce 'done', got {m['state']}"
    )
    assert m.get("matched") is True


def test_initial_return_state_is_running():
    """monitor() must return {'state': 'running'} synchronously."""
    r = bg_jobs.monitor("true", interval_sec=2, max_checks=50, name="init-running")
    assert r["state"] == "running", f"monitor() return should have state='running'"
    bg_jobs.stop(r["id"])
    _wait(r["id"], {"stopped"}, timeout=10)
