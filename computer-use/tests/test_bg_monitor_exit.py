"""Comprehensive edge-case tests for bg_jobs.monitor() — exit-code semantics,
combined regex-OR-exit, wake_on_match control, and log accumulation.

Design principles
-----------------
* Hermetic: JARVIS_BG_JOBS_DIR is a fresh pytest tmp_path; JARVIS_AGENT_SESSION
  is unset so no real daemon is ever contacted.
* In-process tests call _run_monitor() directly (bypassing subprocess spawn) so
  monkeypatch can intercept _wake() for precise "was wake called?" assertions.
* Detached tests exercise the real spawn path via the public monitor() API.
* interval_sec=0 in direct meta writes lets the loop spin without sleeping so
  tests that need multiple checks finish in milliseconds.
"""

from __future__ import annotations

import time

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _wait_state(jid: str, states: set, timeout: float = 20) -> dict:
    """Poll bg_jobs.status() until state is in ``states`` or timeout elapses."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


def _make_inprocess_job(
    tmp_path,
    *,
    command: str = "echo NOOP",
    until_regex: str = "",
    until_exit=None,
    max_checks: int = 2,
    interval_sec: int = 0,          # bypass max(2,...) — write meta directly
    wake_on_match: bool = True,
    session_id: str = "",
) -> str:
    """Write a monitor job.json to disk and return its jid.

    Unlike monitor(), this writes meta directly so we can set interval_sec=0
    and bypass _spawn_runner, letting the test call _run_monitor() inline.
    """
    jid = f"ip-{int(time.time() * 1000) % 100_000_000:08d}"
    bg_jobs._job_dir(jid).mkdir(parents=True, exist_ok=True)
    bg_jobs._log_path(jid).write_text("")
    meta = {
        "id": jid,
        "kind": "monitor",
        "name": "inprocess-test",
        "command": command,
        "cwd": str(tmp_path),
        "session_id": session_id,
        "interval_sec": interval_sec,
        "until_regex": until_regex,
        "until_exit": until_exit,
        "wake_on_match": wake_on_match,
        "max_checks": max_checks,
        "notify_on_done": True,
        "state": "running",
        "checks": 0,
        "started_at": time.time(),
        "ended_at": None,
        "matched": False,
        "runner_pid": None,
    }
    bg_jobs._write_meta(jid, meta)
    return jid


# ---------------------------------------------------------------------------
# Autouse hermetic fixture
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# until_exit: exact match and ignored cases
# ---------------------------------------------------------------------------


class TestUntilExit:
    """until_exit fires on exact match; None and -1 do not trigger normal exits."""

    def test_until_exit_exact_nonzero_match(self, tmp_path):
        """until_exit=3, command 'exit 3' → state done, matched=True on first check."""
        jid = _make_inprocess_job(tmp_path, command="exit 3", until_exit=3, max_checks=5)
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["matched"] is True
        assert m["checks"] == 1  # matched immediately, no further checks needed

    def test_until_exit_zero_match(self, tmp_path):
        """until_exit=0 with 'true' (exit 0) → matched on first check."""
        jid = _make_inprocess_job(tmp_path, command="true", until_exit=0, max_checks=5)
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["matched"] is True

    def test_until_exit_none_condition_entirely_skipped(self, tmp_path):
        """until_exit=None → the exit-code branch is never evaluated.

        The command exits 0 on every check, but the monitor has no matching
        condition so it runs to max_checks and expires.
        """
        jid = _make_inprocess_job(
            tmp_path, command="true", until_exit=None, until_regex="", max_checks=3
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "expired"
        assert m["matched"] is False
        assert m["checks"] == 3

    def test_until_exit_minus_one_never_fires(self, tmp_path):
        """until_exit=-1 is not a sentinel that disables the check — it is just
        compared against returncode.  A normal shell process cannot exit with -1,
        so the condition is evaluated but never trips.  Monitor expires.
        """
        jid = _make_inprocess_job(
            tmp_path, command="true", until_exit=-1, until_regex="", max_checks=2
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "expired"
        assert m["matched"] is False

    def test_until_exit_wrong_code_no_match(self, tmp_path):
        """until_exit=2 but command exits 1 — mismatch, no trip, expires."""
        jid = _make_inprocess_job(
            tmp_path, command="exit 1", until_exit=2, until_regex="", max_checks=3
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "expired"
        assert m["matched"] is False
        assert m["checks"] == 3


# ---------------------------------------------------------------------------
# Combined regex OR exit — either condition is sufficient
# ---------------------------------------------------------------------------


class TestCombinedConditions:
    """Regex match and exit-code match are OR'd — either one trips the monitor."""

    def test_regex_trips_when_exit_misses(self, tmp_path):
        """regex='READY', until_exit=5; command outputs READY and exits 0.
        Regex matches (exit 0 ≠ 5) → done."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo READY; exit 0",
            until_regex="READY",
            until_exit=5,
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["matched"] is True

    def test_exit_trips_when_regex_misses(self, tmp_path):
        """regex='NOPE', until_exit=0; command outputs 'nothing' and exits 0.
        Regex misses, exit 0 == 0 → done."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo nothing; exit 0",
            until_regex="NOPE",
            until_exit=0,
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["matched"] is True

    def test_both_conditions_met_simultaneously(self, tmp_path):
        """regex='HIT', until_exit=0; command outputs HIT and exits 0.
        Both conditions are True in the same check → done (OR semantics confirmed)."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo HIT; exit 0",
            until_regex="HIT",
            until_exit=0,
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["matched"] is True

    def test_neither_condition_met_expires(self, tmp_path):
        """regex='NEVER_SEEN', until_exit=99; command outputs 'hello' and exits 0.
        Neither condition trips → expires after max_checks."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo hello; exit 0",
            until_regex="NEVER_SEEN",
            until_exit=99,
            max_checks=3,
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "expired"
        assert m["matched"] is False
        assert m["checks"] == 3

    def test_exit_trips_on_later_check(self, tmp_path):
        """Command always exits 2; until_exit=2 but also has a regex that never fires.
        Should trip on the very first check, not wait for max_checks."""
        jid = _make_inprocess_job(
            tmp_path,
            command="exit 2",
            until_regex="ABSENT",
            until_exit=2,
            max_checks=10,
        )
        bg_jobs._run_monitor(jid)
        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert m["checks"] == 1  # matched check 1 — did not run remaining 9


# ---------------------------------------------------------------------------
# wake_on_match semantics — monkeypatched _wake so assertions are exact
# ---------------------------------------------------------------------------


class TestWakeOnMatch:
    """wake_on_match=False → state transitions but _wake is never called.
    Uses in-process _run_monitor so monkeypatch reaches the module-level _wake.
    """

    def test_wake_on_match_false_no_wake_called(self, tmp_path, monkeypatch):
        """wake_on_match=False with a non-empty session_id → matched=True, state done,
        but _wake is NOT invoked (the guard condition short-circuits on False)."""
        wake_calls: list = []
        monkeypatch.setattr(bg_jobs, "_wake", lambda *a, **kw: wake_calls.append(a))

        jid = _make_inprocess_job(
            tmp_path,
            command="echo MATCH",
            until_regex="MATCH",
            wake_on_match=False,
            session_id="fake-session-abc",
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)

        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done", f"Expected done, got {m['state']!r}"
        assert m["matched"] is True
        assert m["wake_on_match"] is False
        assert m["session_id"] == "fake-session-abc"  # session was set but unused
        assert len(wake_calls) == 0, (
            f"_wake should NOT be called with wake_on_match=False but got {wake_calls}"
        )

    def test_wake_on_match_true_wake_called_exactly_once(self, tmp_path, monkeypatch):
        """wake_on_match=True with a session_id → _wake called exactly once on match."""
        wake_calls: list = []
        monkeypatch.setattr(bg_jobs, "_wake", lambda *a, **kw: wake_calls.append(a))

        jid = _make_inprocess_job(
            tmp_path,
            command="echo READY",
            until_regex="READY",
            wake_on_match=True,
            session_id="fake-session-xyz",
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)

        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert len(wake_calls) == 1, (
            f"_wake should be called exactly once on match, got {len(wake_calls)}"
        )
        assert wake_calls[0][0] == "fake-session-xyz"  # correct session passed
        # Message should mention the job id and 'MONITOR TRIPPED'
        message = wake_calls[0][1]
        assert jid in message
        assert "MONITOR TRIPPED" in message

    def test_wake_on_match_false_exit_code_trigger_no_wake(self, tmp_path, monkeypatch):
        """wake_on_match=False, exit-code trigger (not regex) → done but no wake."""
        wake_calls: list = []
        monkeypatch.setattr(bg_jobs, "_wake", lambda *a, **kw: wake_calls.append(a))

        jid = _make_inprocess_job(
            tmp_path,
            command="exit 0",
            until_exit=0,
            until_regex="",
            wake_on_match=False,
            session_id="fake-session-nw",
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)

        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert len(wake_calls) == 0

    def test_wake_on_match_true_empty_session_no_wake(self, tmp_path, monkeypatch):
        """wake_on_match=True but session_id='' → _wake is NOT called because the
        guard in _run_monitor is ``wake_on_match AND session_id`` (both must be truthy)."""
        wake_calls: list = []
        monkeypatch.setattr(bg_jobs, "_wake", lambda *a, **kw: wake_calls.append(a))

        jid = _make_inprocess_job(
            tmp_path,
            command="echo MATCH",
            until_regex="MATCH",
            wake_on_match=True,
            session_id="",       # empty → falsy → guard fires
            max_checks=1,
        )
        bg_jobs._run_monitor(jid)

        m = bg_jobs._read_meta(jid)
        assert m["state"] == "done"
        assert len(wake_calls) == 0, (
            "_wake should not be called when session_id is empty, "
            f"even with wake_on_match=True; got {wake_calls}"
        )


# ---------------------------------------------------------------------------
# Per-check log accumulation
# ---------------------------------------------------------------------------


class TestLogAccumulation:
    """Each monitor loop iteration appends a '[check N rc=X] ...' line to out.log."""

    def test_log_line_written_per_check(self, tmp_path):
        """3 checks (no match → expired) produce exactly 3 '[check N rc=...]' lines."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo sentinel; exit 0",
            until_regex="NEVER",
            until_exit=None,
            max_checks=3,
            interval_sec=0,
        )
        bg_jobs._run_monitor(jid)

        log_text = bg_jobs._log_path(jid).read_text()
        for i in range(1, 4):
            assert f"[check {i} rc=" in log_text, (
                f"Expected '[check {i} rc=...]' in log; full log:\n{log_text!r}"
            )

    def test_log_contains_stdout_of_command(self, tmp_path):
        """Each check line includes the truncated command output."""
        marker = "UNIQUE_MARKER_9182"
        jid = _make_inprocess_job(
            tmp_path,
            command=f"echo {marker}",
            until_regex="NEVER",
            until_exit=None,
            max_checks=2,
            interval_sec=0,
        )
        bg_jobs._run_monitor(jid)

        log_text = bg_jobs._log_path(jid).read_text()
        assert marker in log_text, (
            f"Command stdout ({marker!r}) should appear in log; got:\n{log_text!r}"
        )

    def test_checks_counter_equals_max_checks_after_expiry(self, tmp_path):
        """After expiring, meta['checks'] is exactly max_checks."""
        jid = _make_inprocess_job(
            tmp_path,
            command="true",
            until_exit=None,
            until_regex="",
            max_checks=4,
            interval_sec=0,
        )
        bg_jobs._run_monitor(jid)

        m = bg_jobs._read_meta(jid)
        assert m["state"] == "expired"
        assert m["checks"] == 4, f"Expected checks==4, got {m['checks']}"

    def test_log_lines_in_sequential_order(self, tmp_path):
        """Log lines for check 1, 2, 3 appear in that order with correct indices."""
        jid = _make_inprocess_job(
            tmp_path,
            command="echo line",
            until_regex="ABSENT",
            until_exit=None,
            max_checks=3,
            interval_sec=0,
        )
        bg_jobs._run_monitor(jid)

        log_text = bg_jobs._log_path(jid).read_text()
        check_lines = [l for l in log_text.splitlines() if l.startswith("[check ")]
        assert len(check_lines) == 3, (
            f"Expected 3 check lines, found {len(check_lines)}:\n{log_text!r}"
        )
        assert check_lines[0].startswith("[check 1 "), check_lines[0]
        assert check_lines[1].startswith("[check 2 "), check_lines[1]
        assert check_lines[2].startswith("[check 3 "), check_lines[2]

    def test_log_empty_when_stopped_before_first_check(self, tmp_path):
        """If the meta state is 'stopped' before _run_monitor enters its loop,
        no check ever runs and the log file remains empty."""
        jid = _make_inprocess_job(
            tmp_path, command="echo SHOULD_NOT_RUN", until_regex="SHOULD_NOT_RUN",
            max_checks=5, interval_sec=0
        )
        # Overwrite state → stopped before the runner starts
        m = bg_jobs._read_meta(jid)
        m["state"] = "stopped"
        bg_jobs._write_meta(jid, m)

        bg_jobs._run_monitor(jid)

        log_text = bg_jobs._log_path(jid).read_text()
        assert "[check " not in log_text, (
            f"No check should have run, but log contains:\n{log_text!r}"
        )
        final = bg_jobs._read_meta(jid)
        assert final["state"] == "stopped"


# ---------------------------------------------------------------------------
# Detached process smoke tests (real spawn via monitor() public API)
# ---------------------------------------------------------------------------


class TestDetachedMonitor:
    """Exercise the real detached-spawn path so coverage includes _spawn_runner."""

    def test_detached_until_exit_match(self):
        """Detached: until_exit=1, 'exit 1' → state done quickly."""
        r = bg_jobs.monitor(
            "exit 1", interval_sec=2, until_exit=1, max_checks=10, name="det-exit1"
        )
        m = _wait_state(r["id"], {"done", "expired"}, timeout=15)
        assert m["state"] == "done", f"Expected done, got {m['state']!r}"
        assert m["matched"] is True

    def test_detached_until_exit_none_expires(self):
        """Detached: until_exit=None + regex='NOPE', max_checks=2 → expired."""
        r = bg_jobs.monitor(
            "echo nothing",
            interval_sec=2,
            until_exit=None,
            until_regex="NOPE",
            max_checks=2,
            name="det-none-exit",
        )
        m = _wait_state(r["id"], {"done", "expired"}, timeout=25)
        assert m["state"] == "expired", f"Expected expired, got {m['state']!r}"
        assert m["matched"] is False

    def test_detached_combined_exit_code_fires_first_check(self):
        """Detached: regex='MISS', until_exit=0, command 'true' → exit trips check 1,
        does not wait for remaining max_checks."""
        r = bg_jobs.monitor(
            "true",
            interval_sec=2,
            until_regex="MISS",
            until_exit=0,
            max_checks=10,
            name="det-combo-exit",
        )
        m = _wait_state(r["id"], {"done", "expired"}, timeout=15)
        assert m["state"] == "done"
        assert m["matched"] is True
        # Should match on first check — not burn all 10
        assert m.get("checks", 999) <= 2, (
            f"Expected checks<=2 (quick match), got {m.get('checks')}"
        )

    def test_detached_log_written_by_runner_process(self):
        """Detached: the runner subprocess writes to out.log in JARVIS_BG_JOBS_DIR."""
        marker = "DETACHED_LOG_MARKER_7742"
        r = bg_jobs.monitor(
            f"echo {marker}",
            interval_sec=2,
            until_regex=marker,
            max_checks=5,
            name="det-log-check",
        )
        m = _wait_state(r["id"], {"done", "expired"}, timeout=15)
        assert m["state"] == "done"
        log_result = bg_jobs.logs(r["id"], 50)
        assert marker in log_result.get("log", ""), (
            f"Expected {marker!r} in log; got:\n{log_result}"
        )
