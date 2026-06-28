"""Comprehensive tests for session.wake payload emitted by bg_jobs — hermetic.

Strategy: monkeypatch bg_jobs.daemon_client.call to CAPTURE every call instead
of touching a real jarvisd socket.  The internal runner functions (_run_job,
_run_monitor, _run_sleep) execute in-process so the patch applies in the same
interpreter that issues the wake.

Environment contract enforced by autouse fixture:
  JARVIS_BG_JOBS_DIR  → fresh tmp dir per test   (state isolation)
  JARVIS_AGENT_SESSION deleted                    (no real session ever woken)

Coverage matrix:
  • Job success  → exactly one session.wake, message has name/succeeded/tail,
                   critical=False, session_id forwarded verbatim
  • Job failure  → critical=True, exit code + FAILED in message
  • notify_on_done=False  → zero wake calls
  • empty session_id      → zero wake calls
  • output tail in message; first lines stripped when output > 40 lines
  • Monitor regex match   → [MONITOR TRIPPED], name, output in message
  • Monitor wake_on_match=False  → no wake on match
  • Monitor no session    → no wake
  • Monitor max_checks exhausted → expiry wake, state=expired
  • Monitor until_exit match     → wake on matching exit code
  • sleep_wake            → [WAKE TIMER], seconds, note in message; no-session noop
  • _wake() helper edge cases: empty session, critical flag, exception suppression,
    timeout propagation
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Wake-call capture
# ---------------------------------------------------------------------------

class WakeCapture:
    """Replaces daemon_client.call; records every invocation for assertions."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, method: str, params: dict | None = None,
                 timeout: float = 15.0) -> dict:
        self.calls.append({"method": method, "params": params or {},
                           "timeout": timeout})
        return {}

    def wake_calls(self) -> list[dict]:
        return [c for c in self.calls if c["method"] == "session.wake"]

    def wake_params(self) -> list[dict]:
        return [c["params"] for c in self.wake_calls()]

    def sole_wake(self) -> dict:
        """Assert exactly one session.wake call and return its params."""
        wakes = self.wake_calls()
        assert len(wakes) == 1, f"Expected exactly 1 session.wake, got {len(wakes)}"
        return wakes[0]["params"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Isolate job state and prevent any real daemon wake."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)


@pytest.fixture
def capture(monkeypatch) -> WakeCapture:
    cap = WakeCapture()
    monkeypatch.setattr(bg_jobs.daemon_client, "call", cap)
    return cap


# ---------------------------------------------------------------------------
# In-process meta helpers (write job.json + log; no runner subprocess)
# ---------------------------------------------------------------------------

def _mk_job(jid: str, *, command: str = "true", name: str = "test-job",
            session_id: str = "sess-test", notify_on_done: bool = True,
            **extra) -> None:
    meta = {
        "id": jid, "kind": "job", "name": name,
        "command": command, "cwd": "/tmp",
        "session_id": session_id, "notify_on_done": notify_on_done,
        "state": "running", "pid": None, "runner_pid": None,
        "started_at": time.time(), "ended_at": None, "exit_code": None,
    }
    meta.update(extra)
    bg_jobs._write_meta(jid, meta)
    bg_jobs._log_path(jid).write_text("")


def _mk_monitor(jid: str, *, command: str = "echo MATCH",
                name: str = "test-monitor", session_id: str = "sess-test",
                until_regex: str = "MATCH", until_exit=None,
                wake_on_match: bool = True, interval_sec: int = 2,
                max_checks: int = 0, **extra) -> None:
    meta = {
        "id": jid, "kind": "monitor", "name": name,
        "command": command, "cwd": "/tmp",
        "session_id": session_id, "interval_sec": interval_sec,
        "until_regex": until_regex, "until_exit": until_exit,
        "wake_on_match": wake_on_match, "max_checks": max_checks,
        "notify_on_done": True, "state": "running",
        "checks": 0, "started_at": time.time(), "ended_at": None,
        "matched": False, "runner_pid": None,
    }
    meta.update(extra)
    bg_jobs._write_meta(jid, meta)
    bg_jobs._log_path(jid).write_text("")


def _mk_sleep(jid: str, *, session_id: str = "sess-test",
              seconds: int = 0, note: str = "", **extra) -> None:
    meta = {
        "id": jid, "kind": "sleep", "name": f"wake in {seconds}s",
        "session_id": session_id, "seconds": seconds, "note": note,
        "notify_on_done": False, "state": "sleeping",
        "started_at": time.time(), "ended_at": None, "runner_pid": None,
    }
    meta.update(extra)
    bg_jobs._write_meta(jid, meta)


# ===========================================================================
# Job (_run_job) wake-payload tests
# ===========================================================================

def test_job_success_triggers_exactly_one_wake(capture):
    """Exit-0 job with notify_on_done + session_id → exactly one session.wake."""
    _mk_job("j-01", command="true", name="build")
    bg_jobs._run_job("j-01")
    assert len(capture.wake_calls()) == 1


def test_job_success_method_is_session_wake(capture):
    """daemon_client.call is invoked with method 'session.wake', not any other."""
    _mk_job("j-02", command="true")
    bg_jobs._run_job("j-02")
    assert capture.calls[0]["method"] == "session.wake"


def test_job_success_message_contains_job_name(capture):
    _mk_job("j-03", command="true", name="nightly-build")
    bg_jobs._run_job("j-03")
    assert "nightly-build" in capture.sole_wake()["message"]


def test_job_success_message_contains_succeeded(capture):
    """Exit-0 message uses the word 'succeeded' (not 'FAILED')."""
    _mk_job("j-04", command="true", name="deploy")
    bg_jobs._run_job("j-04")
    msg = capture.sole_wake()["message"]
    assert "succeeded" in msg
    assert "FAILED" not in msg


def test_job_success_critical_is_false(capture):
    _mk_job("j-05", command="true")
    bg_jobs._run_job("j-05")
    assert capture.sole_wake()["critical"] is False


def test_job_success_session_id_forwarded_verbatim(capture):
    """The exact session_id stored in meta reaches daemon_client."""
    target = "session-exact-match-abc123"
    _mk_job("j-06", command="true", session_id=target)
    bg_jobs._run_job("j-06")
    assert capture.sole_wake()["session_id"] == target


def test_job_success_output_tail_in_message(capture):
    """Stdout of the job appears in the wake message."""
    marker = "UNIQUE_OUTPUT_TAG_X1Y2Z3"
    _mk_job("j-07", command=f"echo {marker}", name="tail-test")
    bg_jobs._run_job("j-07")
    assert marker in capture.sole_wake()["message"]


def test_job_success_output_tail_truncated(capture):
    """Only the last ~40 lines appear in the message; early lines are stripped.

    The 'Last output:' section is isolated so the head marker in the command
    line (which _run_job includes in the message) doesn't pollute the check.
    """
    head = "UNIQUE_HEADMARK_LLLL"
    tail = "UNIQUE_TAILMARK_MMMM"
    # 52 lines: 1 head + 50 mid + 1 tail; _tail(text, 40) keeps last 40 (lines 13-52)
    cmd = (
        f"echo {head}; "
        "for i in $(seq 1 50); do echo mid$i; done; "
        f"echo {tail}"
    )
    _mk_job("j-08", command=cmd, name="trunc-test")
    bg_jobs._run_job("j-08")
    msg = capture.sole_wake()["message"]
    # Isolate just the output section after "Last output:\n"
    output_section = msg.split("Last output:\n", 1)[1] if "Last output:\n" in msg else msg
    assert tail in output_section, "tail marker should be in the last-output section"
    assert head not in output_section, "head marker should have been truncated away"


def test_job_failed_critical_is_true(capture):
    """Non-zero exit code sets critical=True in the wake params."""
    _mk_job("j-09", command="exit 2", name="broken-step")
    bg_jobs._run_job("j-09")
    assert len(capture.wake_calls()) == 1
    assert capture.sole_wake()["critical"] is True


def test_job_failed_exit_code_in_message(capture):
    """The exact non-zero exit code appears in the wake message."""
    _mk_job("j-10", command="exit 13", name="exit-code-test")
    bg_jobs._run_job("j-10")
    msg = capture.sole_wake()["message"]
    assert "13" in msg
    assert "FAILED" in msg


def test_job_failed_name_in_message(capture):
    """Job name appears in the failure wake message too."""
    _mk_job("j-11", command="false", name="my-failing-task")
    bg_jobs._run_job("j-11")
    assert "my-failing-task" in capture.sole_wake()["message"]


def test_job_notify_on_done_false_no_wake(capture):
    """notify_on_done=False suppresses the wake even with a valid session_id."""
    _mk_job("j-12", command="echo silent", notify_on_done=False,
            session_id="sess-quiet")
    bg_jobs._run_job("j-12")
    assert len(capture.wake_calls()) == 0, "notify_on_done=False should suppress wake"


def test_job_empty_session_id_no_wake(capture):
    """Empty session_id causes _wake to short-circuit; no daemon call at all."""
    _mk_job("j-13", command="echo nosess", session_id="", notify_on_done=True)
    bg_jobs._run_job("j-13")
    assert len(capture.calls) == 0, "empty session_id should suppress all daemon calls"


def test_job_notify_false_and_no_session_still_zero_calls(capture):
    """Belt-and-suspenders: both flags false → zero daemon calls."""
    _mk_job("j-14", command="true", notify_on_done=False, session_id="")
    bg_jobs._run_job("j-14")
    assert len(capture.calls) == 0


def test_job_wake_timeout_is_20(capture):
    """_wake passes timeout=20 to daemon_client.call (matches the module constant)."""
    _mk_job("j-15", command="true")
    bg_jobs._run_job("j-15")
    assert capture.calls[0]["timeout"] == 20


# ===========================================================================
# Monitor (_run_monitor) wake-payload tests
# ===========================================================================

def test_monitor_match_triggers_exactly_one_wake(capture):
    _mk_monitor("m-01", command="echo READY", until_regex="READY")
    bg_jobs._run_monitor("m-01")
    assert len(capture.wake_calls()) == 1


def test_monitor_match_message_contains_tripped_keyword(capture):
    _mk_monitor("m-02", command="echo DONE", until_regex="DONE")
    bg_jobs._run_monitor("m-02")
    assert "MONITOR TRIPPED" in capture.sole_wake()["message"]


def test_monitor_match_message_contains_monitor_name(capture):
    _mk_monitor("m-03", command="echo HIT", until_regex="HIT",
                name="deploy-readiness-check")
    bg_jobs._run_monitor("m-03")
    assert "deploy-readiness-check" in capture.sole_wake()["message"]


def test_monitor_match_message_includes_command_output(capture):
    """The text that triggered the regex match appears in the wake message."""
    _mk_monitor("m-04", command="echo BUILDPASS_UNIQUE_TOKEN",
                until_regex="BUILDPASS_UNIQUE_TOKEN")
    bg_jobs._run_monitor("m-04")
    assert "BUILDPASS_UNIQUE_TOKEN" in capture.sole_wake()["message"]


def test_monitor_wake_on_match_false_suppresses_wake(capture):
    """wake_on_match=False: condition met but no wake issued."""
    _mk_monitor("m-05", command="echo MATCH", until_regex="MATCH",
                wake_on_match=False, session_id="sess-nowake")
    bg_jobs._run_monitor("m-05")
    assert len(capture.wake_calls()) == 0


def test_monitor_empty_session_no_wake_on_match(capture):
    """Empty session_id suppresses the monitor match wake."""
    _mk_monitor("m-06", command="echo HIT", until_regex="HIT", session_id="")
    bg_jobs._run_monitor("m-06")
    assert len(capture.wake_calls()) == 0


def test_monitor_expired_fires_expiry_wake(capture):
    """Monitor that exhausts max_checks sends an expiry-notification wake."""
    _mk_monitor("m-07", command="echo NOMATCH", until_regex="NEVERMATCHES",
                max_checks=1, name="expiry-probe")
    bg_jobs._run_monitor("m-07")
    assert len(capture.wake_calls()) == 1
    assert bg_jobs._read_meta("m-07")["state"] == "expired"


def test_monitor_expired_message_contains_expired_keyword(capture):
    _mk_monitor("m-08", command="echo X", until_regex="NEVER",
                max_checks=1, name="my-expiry-mon")
    bg_jobs._run_monitor("m-08")
    msg = capture.sole_wake()["message"]
    assert "MONITOR EXPIRED" in msg


def test_monitor_expired_empty_session_no_wake(capture):
    """Expiry wake is also suppressed when session_id is empty."""
    _mk_monitor("m-09", command="echo Y", until_regex="NEVER",
                max_checks=1, session_id="")
    bg_jobs._run_monitor("m-09")
    assert len(capture.wake_calls()) == 0
    assert bg_jobs._read_meta("m-09")["state"] == "expired"


def test_monitor_until_exit_zero_triggers_wake(capture):
    """until_exit=0 matches 'true' (exit 0) and fires a wake."""
    _mk_monitor("m-10", command="true", until_regex="", until_exit=0)
    bg_jobs._run_monitor("m-10")
    assert len(capture.wake_calls()) == 1
    assert bg_jobs._read_meta("m-10")["state"] == "done"
    assert bg_jobs._read_meta("m-10")["matched"] is True


def test_monitor_until_exit_mismatch_falls_through_to_expire(capture):
    """until_exit=1 doesn't match 'true' (exit 0); expires after max_checks=1."""
    _mk_monitor("m-11", command="true", until_regex="",
                until_exit=1, max_checks=1)
    bg_jobs._run_monitor("m-11")
    # Should expire (one expiry wake), state=expired
    m = bg_jobs._read_meta("m-11")
    assert m["state"] == "expired"
    # Expiry wake is issued because session_id is non-empty
    assert len(capture.wake_calls()) == 1


# ===========================================================================
# sleep_wake (_run_sleep) wake-payload tests
# ===========================================================================

def test_sleep_wake_fires_exactly_one_wake(capture):
    _mk_sleep("s-01", session_id="sess-slp", seconds=0)
    bg_jobs._run_sleep("s-01")
    assert len(capture.wake_calls()) == 1


def test_sleep_wake_message_contains_wake_timer(capture):
    _mk_sleep("s-02", session_id="sess-kw", seconds=0)
    bg_jobs._run_sleep("s-02")
    assert "WAKE TIMER" in capture.sole_wake()["message"]


def test_sleep_wake_note_in_message(capture):
    _mk_sleep("s-03", session_id="sess-note", seconds=0,
               note="finish-the-report-step")
    bg_jobs._run_sleep("s-03")
    assert "finish-the-report-step" in capture.sole_wake()["message"]


def test_sleep_wake_no_note_omits_note_section(capture):
    """When note is empty the 'Note to self:' line must not appear."""
    _mk_sleep("s-04", session_id="sess-nonote", seconds=0, note="")
    bg_jobs._run_sleep("s-04")
    assert "Note to self:" not in capture.sole_wake()["message"]


def test_sleep_wake_seconds_value_in_message(capture):
    """The scheduled duration appears in the wake message (e.g. '0s')."""
    _mk_sleep("s-05", session_id="sess-dur", seconds=0)
    bg_jobs._run_sleep("s-05")
    # Message says "...after 0s."
    assert "0s" in capture.sole_wake()["message"]


def test_sleep_wake_empty_session_no_wake(capture):
    _mk_sleep("s-06", session_id="", seconds=0)
    bg_jobs._run_sleep("s-06")
    assert len(capture.wake_calls()) == 0


def test_sleep_wake_session_id_forwarded_to_daemon(capture):
    target_session = "waker-session-zyx987"
    _mk_sleep("s-07", session_id=target_session, seconds=0)
    bg_jobs._run_sleep("s-07")
    assert capture.sole_wake()["session_id"] == target_session


# ===========================================================================
# _wake() helper edge cases (unit-level)
# ===========================================================================

def test_wake_helper_empty_session_is_noop(capture):
    """_wake('', ...) returns without touching daemon_client at all."""
    bg_jobs._wake("", "some message")
    assert len(capture.calls) == 0


def test_wake_helper_nonempty_session_calls_daemon(capture):
    bg_jobs._wake("sess-abc", "hello")
    assert len(capture.calls) == 1
    assert capture.calls[0]["method"] == "session.wake"


def test_wake_helper_critical_true_propagates(capture):
    bg_jobs._wake("sess-x", "alert!", critical=True)
    assert capture.calls[0]["params"]["critical"] is True


def test_wake_helper_critical_defaults_to_false(capture):
    """critical keyword defaults to False when not supplied."""
    bg_jobs._wake("sess-x", "info")
    assert capture.calls[0]["params"]["critical"] is False


def test_wake_helper_message_passed_verbatim(capture):
    unique_msg = "verbatim-message-payload-abc123"
    bg_jobs._wake("sess-x", unique_msg)
    assert capture.calls[0]["params"]["message"] == unique_msg


def test_wake_helper_timeout_is_20_seconds(capture):
    """_wake always calls daemon_client with timeout=20."""
    bg_jobs._wake("sess-t", "msg")
    assert capture.calls[0]["timeout"] == 20


def test_wake_helper_exception_from_daemon_suppressed(monkeypatch):
    """_wake must be best-effort: a daemon exception must not propagate."""
    def _boom(*a, **kw):
        raise RuntimeError("connection refused — daemon down")
    monkeypatch.setattr(bg_jobs.daemon_client, "call", _boom)
    # Must complete without raising
    bg_jobs._wake("sess-err", "hello")
