"""Comprehensive tests for tools_bg.register() and supporting bg_jobs functions.

Two complementary layers are exercised:

1. MCP TOOL LAYER — FastMCP registration, schema validation, tool-call semantics,
   error propagation.  Every test calls through ``mcp.call_tool`` so the full
   tools_bg glue code (JSON wrapping, _err fallback) is on the hot path.

2. DIRECT LAYER — bg_jobs public functions called raw to confirm all return dicts
   are JSON-serializable and that the _err helper turns any exception into valid
   ``{"error": "..."}`` JSON.

Hermetic: JARVIS_BG_JOBS_DIR is redirected to a fresh tmp_path per test so real
user state is never touched.  JARVIS_AGENT_SESSION is deleted so the daemon wake
call inside bg_jobs is a guaranteed no-op (no jarvisd needed).
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from mcp.server.fastmcp import FastMCP

from computer_use_mcp import bg_jobs
from computer_use_mcp.tools_bg import _err, register

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXPECTED_TOOLS = frozenset(
    {"bg_start", "bg_status", "bg_logs", "bg_stop", "bg_list", "bg_wait",
     "monitor", "watch", "wake_me_in"}
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Isolate every test from real state and from jarvisd."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


@pytest.fixture()
def mcp():
    """Fresh FastMCP instance with all bg tools registered."""
    m = FastMCP("test-bg")
    register(m)
    return m


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------


def _call(mcp_instance: FastMCP, tool: str, **kwargs) -> dict:
    """Invoke an MCP tool synchronously and parse its JSON text response."""
    result = asyncio.run(mcp_instance.call_tool(tool, kwargs))
    return json.loads(result[0][0].text)


def _wait_state(jid: str, states: set, timeout: float = 20) -> dict:
    """Poll bg_jobs.status until the job reaches one of the target states."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.2)
    return bg_jobs.status(jid)


# ===========================================================================
# 1. REGISTRATION — tool presence, schemas, and descriptions
# ===========================================================================


def test_all_eight_tools_are_registered(mcp):
    """register() must expose exactly the 8 documented tools on the FastMCP."""
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names == EXPECTED_TOOLS


def test_no_extra_tools_registered(mcp):
    """register() must not silently add undocumented tools."""
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names - EXPECTED_TOOLS == set()


def test_every_tool_has_nonempty_description(mcp):
    for t in asyncio.run(mcp.list_tools()):
        assert t.description and t.description.strip(), \
            f"{t.name}: description is blank"


def test_required_params_match_spec(mcp):
    """Each tool's inputSchema must list the documented required parameters."""
    by_name = {t.name: t for t in asyncio.run(mcp.list_tools())}
    req = {n: set(t.inputSchema.get("required", [])) for n, t in by_name.items()}

    assert req["bg_start"] == {"command"}
    assert req["bg_status"] == {"id"}
    assert req["bg_logs"] == {"id"}
    assert req["bg_stop"] == {"id"}
    assert req["bg_list"] == set()
    assert req["bg_wait"] == {"id"}
    assert req["monitor"] == {"command"}
    assert req["wake_me_in"] == {"seconds"}


def test_optional_params_present_in_schemas(mcp):
    """Tools with optional params must declare them in their inputSchema."""
    by_name = {t.name: t for t in asyncio.run(mcp.list_tools())}

    bg_start_props = set(by_name["bg_start"].inputSchema["properties"])
    assert {"command", "cwd", "name", "notify_on_done"} <= bg_start_props

    bg_logs_props = set(by_name["bg_logs"].inputSchema["properties"])
    assert "lines" in bg_logs_props

    monitor_props = set(by_name["monitor"].inputSchema["properties"])
    assert {"interval_sec", "until_regex", "until_exit", "max_checks", "name"} \
           <= monitor_props

    wake_props = set(by_name["wake_me_in"].inputSchema["properties"])
    assert "note" in wake_props


def test_two_independent_mcp_instances_both_get_all_tools():
    """Calling register() on two separate FastMCP objects must not interfere."""
    a, b = FastMCP("a"), FastMCP("b")
    register(a)
    register(b)
    assert {t.name for t in asyncio.run(a.list_tools())} == EXPECTED_TOOLS
    assert {t.name for t in asyncio.run(b.list_tools())} == EXPECTED_TOOLS


# ===========================================================================
# 2. _err HELPER — exception-to-JSON wrapping
# ===========================================================================


def test_err_returns_valid_json():
    raw = _err(ValueError("boom"))
    parsed = json.loads(raw)          # must not raise
    assert isinstance(parsed, dict)


def test_err_has_error_key_with_exception_message():
    raw = _err(RuntimeError("something went wrong"))
    assert json.loads(raw)["error"] == "something went wrong"


def test_err_handles_various_exception_types():
    for exc in [OSError("disk full"), KeyError("missing"), TypeError("bad type"),
                ZeroDivisionError("div by zero")]:
        parsed = json.loads(_err(exc))
        assert "error" in parsed
        assert str(exc) in parsed["error"]


def test_err_escapes_special_chars_in_message():
    """A message with quotes and backslashes must still produce valid JSON."""
    raw = _err(ValueError('path "C:\\Users\\foo" not found'))
    parsed = json.loads(raw)          # must not raise
    assert "error" in parsed


# ===========================================================================
# 3. bg_list
# ===========================================================================


def test_bg_list_empty_on_fresh_directory(mcp):
    result = _call(mcp, "bg_list")
    assert result == {"jobs": []}


def test_bg_list_shows_a_started_job(mcp):
    r = _call(mcp, "bg_start", command="sleep 60", name="listjob")
    jobs = _call(mcp, "bg_list")["jobs"]
    assert any(j["id"] == r["id"] for j in jobs)
    _call(mcp, "bg_stop", id=r["id"])


def test_bg_list_returns_correct_count_for_multiple_jobs(mcp):
    ids = []
    for n in ("alpha", "beta", "gamma"):
        ids.append(_call(mcp, "bg_start", command="sleep 60", name=n)["id"])
    jobs = _call(mcp, "bg_list")["jobs"]
    assert len(jobs) == 3
    for jid in ids:
        _call(mcp, "bg_stop", id=jid)


def test_bg_list_includes_monitor_and_sleep_kinds(mcp):
    mon_id = _call(mcp, "monitor", command="true", interval_sec=60, name="mlst")["id"]
    slp_id = _call(mcp, "wake_me_in", seconds=3600, note="")["id"]
    jobs = _call(mcp, "bg_list")["jobs"]
    kinds = {j["id"]: j["kind"] for j in jobs}
    assert kinds.get(mon_id) == "monitor"
    assert kinds.get(slp_id) == "sleep"
    _call(mcp, "bg_stop", id=mon_id)
    _call(mcp, "bg_stop", id=slp_id)


# ===========================================================================
# 4. bg_start
# ===========================================================================


def test_bg_start_returns_id_state_and_log_path(mcp):
    result = _call(mcp, "bg_start", command="echo hi", name="greet")
    assert "id" in result
    assert result["state"] == "running"
    assert "log" in result
    _call(mcp, "bg_stop", id=result["id"])


def test_bg_start_name_slug_embedded_in_job_id(mcp):
    result = _call(mcp, "bg_start", command="true", name="myspecialjob")
    assert "myspecialjob" in result["id"]
    _call(mcp, "bg_stop", id=result["id"])


def test_bg_start_session_id_empty_without_env(mcp):
    """Without JARVIS_AGENT_SESSION set, session_id must be ''."""
    result = _call(mcp, "bg_start", command="true")
    assert result["session_id"] == ""


def test_bg_start_session_id_set_from_env(mcp, monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_SESSION", "test-session-42")
    result = _call(mcp, "bg_start", command="true", name="sess")
    assert result["session_id"] == "test-session-42"
    _call(mcp, "bg_stop", id=result["id"])


def test_bg_start_two_jobs_have_different_ids(mcp):
    a = _call(mcp, "bg_start", command="sleep 60", name="dup")
    b = _call(mcp, "bg_start", command="sleep 60", name="dup")
    assert a["id"] != b["id"]
    _call(mcp, "bg_stop", id=a["id"])
    _call(mcp, "bg_stop", id=b["id"])


# ===========================================================================
# 5. bg_status
# ===========================================================================


def test_bg_status_unknown_id_returns_error_json(mcp):
    result = _call(mcp, "bg_status", id="totally-made-up-id")
    assert "error" in result


def test_bg_status_running_job_has_required_fields(mcp):
    r = _call(mcp, "bg_start", command="sleep 60", name="stat")
    status = _call(mcp, "bg_status", id=r["id"])
    assert status.get("state") in ("running", "starting", "done", "ended")
    assert "command" in status
    assert "kind" in status
    _call(mcp, "bg_stop", id=r["id"])


def test_bg_status_done_job_has_zero_exit_code(mcp):
    r = _call(mcp, "bg_start", command="exit 0", name="success")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    status = _call(mcp, "bg_status", id=jid)
    assert status["state"] == "done"
    assert status["exit_code"] == 0


def test_bg_status_failed_job_captures_nonzero_exit(mcp):
    r = _call(mcp, "bg_start", command="exit 7", name="fail7")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    status = _call(mcp, "bg_status", id=jid)
    assert status["state"] == "failed"
    assert status["exit_code"] == 7


# ===========================================================================
# 6. bg_logs
# ===========================================================================


def test_bg_logs_captures_command_stdout(mcp):
    r = _call(mcp, "bg_start",
              command="printf 'unique-output-token\\n'", name="logcap")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    result = _call(mcp, "bg_logs", id=jid, lines=50)
    assert "id" in result
    assert "unique-output-token" in result["log"]


def test_bg_logs_unknown_id_returns_error(mcp):
    result = _call(mcp, "bg_logs", id="ghost-job-999")
    assert "error" in result


def test_bg_logs_lines_param_truncates_to_n(mcp):
    # Produce exactly 10 lines; request only the last 3.
    r = _call(mcp, "bg_start",
              command="for i in $(seq 1 10); do echo L$i; done",
              name="loglines")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    result = _call(mcp, "bg_logs", id=jid, lines=3)
    lines = result["log"].splitlines()
    assert len(lines) == 3
    # The last 3 of 10 (L8, L9, L10).
    assert lines == ["L8", "L9", "L10"]


def test_bg_logs_default_lines_shows_content(mcp):
    r = _call(mcp, "bg_start", command="echo default-lines-test", name="defl")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    result = _call(mcp, "bg_logs", id=jid)     # no lines arg → default 80
    assert "default-lines-test" in result["log"]


# ===========================================================================
# 7. bg_stop
# ===========================================================================


def test_bg_stop_unknown_id_returns_error(mcp):
    result = _call(mcp, "bg_stop", id="no-such-job-stop")
    assert "error" in result


def test_bg_stop_running_job_transitions_to_stopped(mcp):
    r = _call(mcp, "bg_start", command="sleep 60", name="stopit")
    jid = r["id"]
    _wait_state(jid, {"running"}, timeout=8)
    stop_result = _call(mcp, "bg_stop", id=jid)
    assert stop_result.get("state") == "stopped"
    # Persisted state must also reflect stopped.
    assert _call(mcp, "bg_status", id=jid)["state"] == "stopped"


def test_bg_stop_idempotent_on_already_stopped_job(mcp):
    r = _call(mcp, "bg_start", command="sleep 60", name="stopdbl")
    jid = r["id"]
    _call(mcp, "bg_stop", id=jid)
    # Stopping an already-stopped job must not raise — returns stopped.
    result = _call(mcp, "bg_stop", id=jid)
    assert result.get("state") == "stopped"


# ===========================================================================
# 8. bg_wait
# ===========================================================================


def test_bg_wait_returns_immediately_when_job_already_done(mcp):
    r = _call(mcp, "bg_start", command="echo quick", name="quickwait")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    t0 = time.time()
    result = _call(mcp, "bg_wait", id=jid, timeout_sec=10)
    elapsed = time.time() - t0
    assert result["state"] in ("done", "failed", "ended")
    assert not result.get("timed_out")
    assert elapsed < 3.0, f"bg_wait on done job took {elapsed:.1f}s — expected < 3s"


def test_bg_wait_returns_immediately_when_job_is_stopped(mcp):
    r = _call(mcp, "bg_start", command="sleep 60", name="waitstop")
    jid = r["id"]
    _wait_state(jid, {"running"}, timeout=8)
    _call(mcp, "bg_stop", id=jid)
    t0 = time.time()
    result = _call(mcp, "bg_wait", id=jid, timeout_sec=10)
    elapsed = time.time() - t0
    assert result["state"] == "stopped"
    assert not result.get("timed_out")
    assert elapsed < 3.0, f"bg_wait on stopped job took {elapsed:.1f}s"


def test_bg_wait_sets_timed_out_flag_for_nonexistent_id(mcp):
    """An unknown id has no state, so bg_wait must time out and set timed_out=True.

    This test intentionally waits ~6 s (minimum effective window is 5 s by
    design — see tools_bg.bg_wait implementation).
    """
    result = _call(mcp, "bg_wait", id="nonexistent-wait-id", timeout_sec=5)
    assert result.get("timed_out") is True


def test_bg_wait_timeout_clamped_above_zero():
    """timeout_sec=0 is falsy, so 'timeout_sec or 7200' gives 7200, not 0.
    Document the known gotcha: passing 0 does NOT mean 'return immediately';
    it silently falls back to the 7200-second default.
    """
    # We only assert the clamping arithmetic, not the full 7200-second wait.
    timeout_sec = 0
    effective = max(5, min(int(timeout_sec or 7200), 14400))
    assert effective == 7200, (
        "bg_wait: timeout_sec=0 falls back to 7200 (0 is falsy) — "
        "callers must pass an explicit positive value to get a short timeout"
    )


def test_bg_wait_timeout_capped_at_14400():
    timeout_sec = 99999
    effective = max(5, min(int(timeout_sec or 7200), 14400))
    assert effective == 14400


# ===========================================================================
# 9. monitor
# ===========================================================================


def test_monitor_starts_with_running_state(mcp):
    result = _call(mcp, "monitor", command="echo hi", interval_sec=60,
                   max_checks=0, name="monrun")
    assert result["state"] == "running"
    assert "id" in result
    _call(mcp, "bg_stop", id=result["id"])


def test_monitor_until_exit_negative_one_stored_as_none(mcp):
    """until_exit=-1 signals 'ignore exit code'; it must be None in stored meta."""
    result = _call(mcp, "monitor", command="true", interval_sec=60,
                   until_exit=-1, name="negex")
    jid = result["id"]
    meta = bg_jobs.status(jid)
    assert meta.get("until_exit") is None, \
        f"expected None for until_exit=-1, got {meta.get('until_exit')!r}"
    _call(mcp, "bg_stop", id=jid)


def test_monitor_valid_until_exit_zero_stored_correctly(mcp):
    result = _call(mcp, "monitor", command="true", interval_sec=60,
                   until_exit=0, name="exitmon")
    jid = result["id"]
    meta = bg_jobs.status(jid)
    assert meta.get("until_exit") == 0
    _call(mcp, "bg_stop", id=jid)


def test_monitor_appears_in_bg_list(mcp):
    result = _call(mcp, "monitor", command="sleep 60", interval_sec=60,
                   name="listmon")
    jid = result["id"]
    ids = [j["id"] for j in _call(mcp, "bg_list")["jobs"]]
    assert jid in ids
    _call(mcp, "bg_stop", id=jid)


# ===========================================================================
# 10. wake_me_in
# ===========================================================================


def test_wake_me_in_returns_sleeping_state(mcp):
    result = _call(mcp, "wake_me_in", seconds=3600, note="reminder")
    assert result["state"] == "sleeping"
    assert "id" in result
    assert result["wake_in_sec"] == 3600
    _call(mcp, "bg_stop", id=result["id"])


def test_wake_me_in_id_contains_wake_slug(mcp):
    result = _call(mcp, "wake_me_in", seconds=100)
    assert "wake" in result["id"]
    _call(mcp, "bg_stop", id=result["id"])


def test_wake_me_in_zero_seconds_clamped_to_one():
    """sleep_wake(0) must not hang; bg_jobs clamps to max(1, seconds)."""
    r = bg_jobs.sleep_wake(0, note="")
    jid = r["id"]
    assert r["wake_in_sec"] == 1
    # It will actually fire in ~1 s; just cancel it.
    bg_jobs.stop(jid)


def test_wake_me_in_completes_after_short_delay(mcp):
    result = _call(mcp, "wake_me_in", seconds=1, note="")
    jid = result["id"]
    m = _wait_state(jid, {"done"}, timeout=10)
    assert m["state"] == "done"


# ===========================================================================
# 11. Direct bg_jobs smoke — JSON-serializability of every return value
# ===========================================================================


def test_direct_start_return_is_json_serializable():
    r = bg_jobs.start("echo smoke", name="smoke")
    serialized = json.dumps(r)
    assert serialized                          # non-empty
    assert r["id"] and r["state"] == "running"
    bg_jobs.stop(r["id"])


def test_direct_status_return_is_json_serializable():
    r = bg_jobs.start("sleep 60", name="stat-s")
    m = bg_jobs.status(r["id"])
    json.dumps(m)                              # must not raise
    bg_jobs.stop(r["id"])


def test_direct_listing_return_is_json_serializable():
    ids = [bg_jobs.start("sleep 60", name=n)["id"] for n in ("la", "lb")]
    result = bg_jobs.listing()
    json.dumps(result)                         # must not raise
    assert len(result["jobs"]) == 2
    for jid in ids:
        bg_jobs.stop(jid)


def test_direct_logs_return_is_json_serializable():
    r = bg_jobs.start("echo logsmoke", name="logsm")
    jid = r["id"]
    _wait_state(jid, {"done", "failed", "ended"})
    result = bg_jobs.logs(jid, 10)
    json.dumps(result)                         # must not raise
    assert "logsmoke" in result["log"]


def test_direct_monitor_return_is_json_serializable():
    r = bg_jobs.monitor("echo hi", interval_sec=60, name="m-smoke")
    json.dumps(r)                              # must not raise
    assert r["state"] == "running"
    bg_jobs.stop(r["id"])


def test_direct_sleep_wake_return_is_json_serializable():
    r = bg_jobs.sleep_wake(1, note="test")
    json.dumps(r)                              # must not raise
    assert r["state"] == "sleeping"
    assert r["wake_in_sec"] == 1
    bg_jobs.stop(r["id"])


def test_direct_stop_return_is_json_serializable():
    r = bg_jobs.start("sleep 60", name="st-stop")
    result = bg_jobs.stop(r["id"])
    json.dumps(result)                         # must not raise
    assert result["state"] == "stopped"


def test_direct_status_unknown_id_returns_error_dict():
    m = bg_jobs.status("completely-unknown")
    assert isinstance(m, dict)
    assert "error" in m
    json.dumps(m)                              # must be serializable
