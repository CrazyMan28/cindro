"""Comprehensive lifecycle tests for bg_jobs.start().

Hermetic: JARVIS_BG_JOBS_DIR is redirected to a fresh tmp_path per test;
JARVIS_AGENT_SESSION is deleted so the daemon wake is a no-op.  All tests
run with no running jarvisd required.

Coverage:
- exit 0  -> state "done"  + exit_code 0
- nonzero exits (1, 2, 3, 42, 127) -> state "failed" + correct exit_code
- state machine: start() returns "running"; running -> done/failed after command
- started_at / ended_at: both present after completion, ended_at >= started_at
- ended_at is None while the job is still running
- name defaults to command[:40] when not supplied; explicit name overrides
- job id slug derived from name
- returned dict shape: id, state, log, session_id
- session_id reflects JARVIS_AGENT_SESSION at start time (or "" when absent)
- full status() meta shape on completion
- stdout and stderr both land in out.log
- out.log file exists immediately after start()
- two concurrent jobs get independent ids and states
- listing() includes all started jobs
- status() on unknown job id returns an error dict (not an exception)
- logs() on unknown job id returns an error dict (not an exception)
- a command that does not exist exits non-zero and transitions to "failed"
- stop() transitions a running job to "stopped"
- stop() sets ended_at
- log file created even when job fails immediately
- multiple different nonzero exit codes are each captured exactly
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from computer_use_mcp import bg_jobs


# ── helpers ───────────────────────────────────────────────────────────────────

def _wait(jid: str, states, *, timeout: float = 20) -> dict:
    """Poll bg_jobs.status until state is in `states` or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Per-test hermetic env: fresh jobs dir, no real session to wake."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ── exit 0: state "done" + exit_code 0 ───────────────────────────────────────

def test_exit_zero_state_is_done():
    """exit 0 -> state 'done'."""
    r = bg_jobs.start("exit 0", name="ok")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"


def test_exit_zero_exit_code_is_zero():
    """exit 0 -> exit_code 0, not None."""
    r = bg_jobs.start("exit 0", name="ok-ec")
    m = _wait(r["id"], {"done", "failed"})
    assert m["exit_code"] == 0


# ── nonzero exits -> "failed" + correct exit_code ────────────────────────────

def test_exit_one_state_and_code():
    r = bg_jobs.start("exit 1", name="fail-1")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 1


def test_exit_two_state_and_code():
    r = bg_jobs.start("exit 2", name="fail-2")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 2


def test_exit_three_state_and_code():
    r = bg_jobs.start("exit 3", name="fail-3")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 3


def test_exit_42_state_and_code():
    r = bg_jobs.start("exit 42", name="fail-42")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 42


def test_exit_127_state_and_code():
    """127 is the shell's 'command not found' sentinel; must be captured exactly."""
    r = bg_jobs.start("exit 127", name="fail-127")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 127


def test_nonzero_exit_codes_are_distinct():
    """Each exit code value is preserved independently, not collapsed to a flag."""
    codes = [1, 2, 3, 42, 127]
    jobs = {c: bg_jobs.start(f"exit {c}", name=f"dist-{c}") for c in codes}
    for c, r in jobs.items():
        m = _wait(r["id"], {"done", "failed"})
        assert m["exit_code"] == c, f"exit {c}: got {m['exit_code']}"


# ── state machine: starting -> running -> done / failed ───────────────────────

def test_start_returns_running_state():
    """start() is synchronous and always returns state='running' to the caller."""
    r = bg_jobs.start("sleep 10", name="sm-init")
    assert r["state"] == "running"
    bg_jobs.stop(r["id"])


def test_running_state_visible_before_completion():
    """status() shows 'running' while a slow job is still alive."""
    r = bg_jobs.start("sleep 10", name="sm-running")
    saw_running = False
    deadline = time.time() + 5
    while time.time() < deadline:
        if bg_jobs.status(r["id"]).get("state") == "running":
            saw_running = True
            break
        time.sleep(0.1)
    bg_jobs.stop(r["id"])
    assert saw_running, "never observed 'running' state"


def test_state_transitions_running_to_done():
    """Successful job: running -> done (verifies the full terminal transition)."""
    r = bg_jobs.start("exit 0", name="sm-done")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"


def test_state_transitions_running_to_failed():
    """Failing job: running -> failed."""
    r = bg_jobs.start("exit 5", name="sm-fail")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"


def test_state_never_done_before_ended_at_set():
    """Once state is 'done', ended_at must also be present — they're written atomically."""
    r = bg_jobs.start("exit 0", name="sm-atomic")
    m = _wait(r["id"], {"done", "failed"})
    # Both fields set in the same _write_meta call by _run_job.
    assert m["state"] == "done"
    assert m.get("ended_at") is not None


# ── timestamps: started_at / ended_at ────────────────────────────────────────

def test_started_at_is_float_and_set_immediately():
    """started_at is a Unix timestamp recorded before the runner spawns."""
    before = time.time()
    r = bg_jobs.start("exit 0", name="ts-start")
    m = _wait(r["id"], {"done", "failed"})
    assert isinstance(m.get("started_at"), (int, float))
    assert m["started_at"] >= before


def test_ended_at_set_after_completion():
    """ended_at is a Unix timestamp recorded by the runner after the command exits."""
    r = bg_jobs.start("exit 0", name="ts-end")
    m = _wait(r["id"], {"done", "failed"})
    assert isinstance(m.get("ended_at"), (int, float))


def test_ended_at_not_before_started_at():
    """Time runs forward: ended_at >= started_at."""
    r = bg_jobs.start("exit 0", name="ts-order")
    m = _wait(r["id"], {"done", "failed"})
    assert m["ended_at"] >= m["started_at"]


def test_ended_at_none_while_job_running():
    """ended_at is None in the meta while the job has not yet finished."""
    r = bg_jobs.start("sleep 10", name="ts-none")
    # Give the runner time to write the pid update, but not to finish.
    time.sleep(0.4)
    m = bg_jobs.status(r["id"])
    if m.get("state") == "running":  # guard against extreme scheduling jitter
        assert m.get("ended_at") is None
    bg_jobs.stop(r["id"])


def test_failed_job_also_sets_ended_at():
    """ended_at is populated even when the job exits non-zero."""
    r = bg_jobs.start("exit 99", name="ts-fail")
    m = _wait(r["id"], {"done", "failed"})
    assert m.get("ended_at") is not None


# ── name defaulting ───────────────────────────────────────────────────────────

def test_name_defaults_to_command_prefix_when_omitted():
    """No name supplied -> meta name is the first 40 chars of command."""
    cmd = "echo no-name-supplied"
    r = bg_jobs.start(cmd)
    m = _wait(r["id"], {"done", "failed"})
    # The code: name or command[:40]
    assert m["name"] == cmd[:40]


def test_explicit_name_stored_verbatim():
    """Supplied name is stored unchanged; command is NOT used as fallback."""
    r = bg_jobs.start("echo ignored-cmd", name="explicit-label")
    m = _wait(r["id"], {"done", "failed"})
    assert m["name"] == "explicit-label"


def test_job_id_slug_derived_from_name():
    """The ID prefix is the lowercased, slugified name (non-alnum -> '-')."""
    r = bg_jobs.start("exit 0", name="Hello World 42!")
    # _new_id slugifies: "hello-world-42-" strip -> "hello-world-42"
    assert r["id"].startswith("hello-world-42")
    bg_jobs.stop(r["id"])


def test_job_id_slug_defaults_to_job_when_no_name():
    """Without a name, _new_id falls back to 'job' as the slug prefix."""
    r = bg_jobs.start("exit 0")
    # _new_id: (name or "job") -> "job" when name=""
    assert r["id"].startswith("job-")
    bg_jobs.stop(r["id"])


# ── return dict shape: id, state, log, session_id ─────────────────────────────

def test_start_returns_all_required_keys():
    """start() return value has exactly the four documented top-level keys."""
    r = bg_jobs.start("exit 0", name="shape")
    for key in ("id", "state", "log", "session_id"):
        assert key in r, f"missing key: {key}"
    bg_jobs.stop(r["id"])


def test_start_id_is_non_empty_string():
    r = bg_jobs.start("exit 0", name="id-str")
    assert isinstance(r["id"], str) and r["id"]
    bg_jobs.stop(r["id"])


def test_start_log_is_path_to_out_log():
    """'log' value is a string path that ends with out.log inside the job dir."""
    r = bg_jobs.start("exit 0", name="log-path")
    assert isinstance(r["log"], str)
    assert r["log"].endswith("out.log")
    bg_jobs.stop(r["id"])


def test_session_id_empty_when_env_unset():
    """JARVIS_AGENT_SESSION absent -> session_id is '' in the return dict."""
    r = bg_jobs.start("exit 0", name="no-sess")
    assert r["session_id"] == ""
    bg_jobs.stop(r["id"])


def test_session_id_captured_from_env(monkeypatch):
    """JARVIS_AGENT_SESSION set -> session_id is that value in the return dict."""
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "sess-abc-123")
    r = bg_jobs.start("exit 0", name="with-sess")
    assert r["session_id"] == "sess-abc-123"
    bg_jobs.stop(r["id"])


def test_status_meta_has_full_shape():
    """status() on a completed job contains all expected lifecycle fields."""
    r = bg_jobs.start("exit 0", name="full-shape")
    m = _wait(r["id"], {"done", "failed"})
    for key in ("id", "kind", "name", "command", "state",
                "exit_code", "started_at", "ended_at",
                "pid", "runner_pid", "session_id"):
        assert key in m, f"status() missing field: {key}"


def test_status_id_matches_start_id():
    """The 'id' in status() is the same value returned by start()."""
    r = bg_jobs.start("exit 0", name="id-match")
    m = _wait(r["id"], {"done", "failed"})
    assert m["id"] == r["id"]


# ── log capture ───────────────────────────────────────────────────────────────

def test_stdout_captured_in_log():
    """stdout from the command is captured in out.log."""
    r = bg_jobs.start("printf 'stdout-line\\n'", name="log-out")
    _wait(r["id"], {"done", "failed"})
    assert "stdout-line" in bg_jobs.logs(r["id"], 100)["log"]


def test_stderr_captured_in_log():
    """stderr is merged into out.log (subprocess stderr=STDOUT)."""
    r = bg_jobs.start("echo stderr-line >&2", name="log-err")
    _wait(r["id"], {"done", "failed"})
    assert "stderr-line" in bg_jobs.logs(r["id"], 100)["log"]


def test_log_file_exists_immediately_after_start():
    """out.log is created by start() before the runner even runs, so it's always present."""
    r = bg_jobs.start("sleep 10", name="log-exists")
    assert Path(r["log"]).exists()
    bg_jobs.stop(r["id"])


def test_failed_job_log_is_readable():
    """Even a failing job has an accessible (possibly empty) log file."""
    r = bg_jobs.start("echo before-fail; exit 9", name="fail-log")
    _wait(r["id"], {"done", "failed"})
    result = bg_jobs.logs(r["id"], 50)
    assert "error" not in result
    # stdout was captured before exit
    assert "before-fail" in result["log"]


# ── isolation / concurrent jobs ───────────────────────────────────────────────

def test_two_concurrent_jobs_have_different_ids():
    r1 = bg_jobs.start("exit 0", name="iso-a")
    r2 = bg_jobs.start("exit 0", name="iso-b")
    assert r1["id"] != r2["id"]
    _wait(r1["id"], {"done", "failed"})
    _wait(r2["id"], {"done", "failed"})


def test_concurrent_jobs_track_independent_states():
    """One succeeding, one failing job report independent states and exit codes."""
    r_ok = bg_jobs.start("exit 0", name="ci-ok")
    r_fail = bg_jobs.start("exit 8", name="ci-fail")
    m_ok = _wait(r_ok["id"], {"done", "failed"})
    m_fail = _wait(r_fail["id"], {"done", "failed"})
    assert m_ok["state"] == "done" and m_ok["exit_code"] == 0
    assert m_fail["state"] == "failed" and m_fail["exit_code"] == 8


def test_listing_includes_all_started_jobs():
    """listing()['jobs'] contains every job that was started in this session."""
    r1 = bg_jobs.start("exit 0", name="lst-1")
    r2 = bg_jobs.start("exit 0", name="lst-2")
    _wait(r1["id"], {"done", "failed"})
    _wait(r2["id"], {"done", "failed"})
    ids = {j["id"] for j in bg_jobs.listing()["jobs"]}
    assert r1["id"] in ids
    assert r2["id"] in ids


# ── edge cases and error handling ─────────────────────────────────────────────

def test_status_unknown_job_returns_error_dict():
    """status() on a fabricated id returns {'error': ...}, not an exception."""
    m = bg_jobs.status("nonexistent-job-xyzzy-00000000")
    assert "error" in m


def test_logs_unknown_job_returns_error_dict():
    """logs() on a fabricated id returns {'error': ...}, not an exception."""
    result = bg_jobs.logs("no-such-job-xyzzy-00000000", 10)
    assert "error" in result


def test_bad_command_exits_nonzero_and_fails():
    """A command that the shell cannot find exits 127 and transitions to 'failed'."""
    r = bg_jobs.start("__cmd_definitely_does_not_exist_xyzzy__", name="bad-cmd")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    # Shell convention: 127 for command not found.
    assert m.get("exit_code") not in (None, 0)


def test_stop_sets_state_stopped():
    """stop() on a running job transitions state to 'stopped'."""
    r = bg_jobs.start("sleep 60", name="stop-state")
    _wait(r["id"], {"running"}, timeout=8)
    bg_jobs.stop(r["id"])
    assert bg_jobs.status(r["id"])["state"] == "stopped"


def test_stop_sets_ended_at():
    """stop() records ended_at in the meta so the job has a clear wall time."""
    r = bg_jobs.start("sleep 60", name="stop-ts")
    _wait(r["id"], {"running"}, timeout=8)
    bg_jobs.stop(r["id"])
    m = bg_jobs.status(r["id"])
    assert m.get("ended_at") is not None
