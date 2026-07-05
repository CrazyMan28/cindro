"""bg_jobs runs REAL detached jobs and records their results.

Hermetic via JARVIS_BG_JOBS_DIR (honored by the detached runner too, since it
inherits the env) and an empty session_id so the daemon wake is skipped — these
tests need no running jarvisd. Exercises the job state machine + log capture for a
plain job, a failing job, a wake timer, and a monitor regex match.
"""

from __future__ import annotations

import time

import pytest

from computer_use_mcp import bg_jobs


def _wait(jid, states, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.2)
    return bg_jobs.status(jid)


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    # No session to wake => fully offline/hermetic (the wake is a no-op).
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


def test_job_success_captures_log():
    r = bg_jobs.start("printf 'hello-bg\\n'; exit 0", name="t1")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "done"
    assert m["exit_code"] == 0
    assert "hello-bg" in bg_jobs.logs(r["id"], 50)["log"]


def test_job_failure_records_exit_code():
    r = bg_jobs.start("echo boom; exit 3", name="t2")
    m = _wait(r["id"], {"done", "failed"})
    assert m["state"] == "failed"
    assert m["exit_code"] == 3


def test_wake_timer_completes():
    r = bg_jobs.sleep_wake(1, note="ping")
    m = _wait(r["id"], {"done"}, timeout=10)
    assert m["state"] == "done"


def test_monitor_regex_match():
    r = bg_jobs.monitor("echo READY", interval_sec=2, until_regex="READY", name="mon")
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_monitor_until_exit_then_expire():
    # Never matches (regex won't hit, exit always 0 but until_exit=1); expires.
    r = bg_jobs.monitor("true", interval_sec=2, until_regex="NOPE",
                        until_exit=1, max_checks=2, name="exp")
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "expired"


def test_listing_and_stop():
    r = bg_jobs.start("sleep 30", name="long")
    jid = r["id"]
    _wait(jid, {"running"}, timeout=6)
    assert jid in [j["id"] for j in bg_jobs.listing()["jobs"]]
    bg_jobs.stop(jid)
    # stop() signals the detached process; the "stopped" state lands once the
    # runner records the terminated exit, which isn't instant — poll for it
    # instead of asserting on the same tick (fixed a CI flake).
    m = _wait(jid, {"stopped"}, timeout=10)
    assert m["state"] == "stopped"
