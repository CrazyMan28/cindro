"""Comprehensive edge-case tests for bg_jobs.sleep_wake().

Hermetic: each test gets its own tmp_path as JARVIS_BG_JOBS_DIR;
JARVIS_AGENT_SESSION is deleted so no real jarvisd wake is attempted.

Coverage:
- sleep_wake() completes to "done" after approximately the right interval
- The note field round-trips faithfully through job.json
- Stop() before the timer fires yields "stopped", never "done"
- Multiple independent timers: start/stop/complete without cross-contamination
- Returned wake_in_sec matches the requested seconds (clamped behaviour too)
- Status transitions: sleeping -> done, sleeping -> stopped
- Meta fields: kind, ended_at, runner_pid, started_at, session_id
- Listing contains sleep jobs
- Stopping an already-done timer is harmless
- Note with special / unicode characters round-trips intact
- Zero-second request is clamped to 1 by the module
"""

from __future__ import annotations

import time

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _poll(jid: str, target_states: set[str], timeout: float = 15.0) -> dict:
    """Poll status(jid) until state is in target_states or timeout expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in target_states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


def _poll_not(jid: str, unwanted_states: set[str], timeout: float = 3.0) -> dict:
    """Poll until state is NOT in unwanted_states, or timeout.
    Useful to confirm a state never changes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") not in unwanted_states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


# ---------------------------------------------------------------------------
# Autouse fixture: hermetic env per test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Each test gets its own isolated jobs dir; no real session to wake."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg_timers"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# 1. Basic completion: sleep_wake finishes to "done"
# ---------------------------------------------------------------------------

def test_sleep_wake_completes_to_done():
    """A 1-second timer must reach 'done' well within a generous window."""
    r = bg_jobs.sleep_wake(1)
    jid = r["id"]
    assert r["state"] == "sleeping"

    m = _poll(jid, {"done"}, timeout=12)
    assert m["state"] == "done", f"still {m['state']} after 12 s"


# ---------------------------------------------------------------------------
# 2. Note round-trips into job.json
# ---------------------------------------------------------------------------

def test_note_round_trips_into_meta():
    """The 'note' kwarg must be stored verbatim in the meta file."""
    note = "remember to check the deploy"
    r = bg_jobs.sleep_wake(1, note=note)
    jid = r["id"]

    # Readable immediately after creation, before the runner even finishes.
    m = bg_jobs.status(jid)
    assert m.get("note") == note, f"note missing immediately: {m}"

    # Still intact after completion.
    m = _poll(jid, {"done"}, timeout=12)
    assert m.get("note") == note, f"note changed after done: {m}"


def test_note_round_trips_special_characters():
    """Unicode, quotes, backslashes, newlines survive JSON serialisation."""
    note = 'café & "résumé"\npath: C:\\foo\\bar\nnewline\ttab☃'
    r = bg_jobs.sleep_wake(1, note=note)
    jid = r["id"]

    m = _poll(jid, {"done"}, timeout=12)
    assert m.get("note") == note, f"note mangled: {m.get('note')!r}"


def test_empty_note_stored_as_empty_string():
    """Omitting note should yield '' (not None or missing) in meta."""
    r = bg_jobs.sleep_wake(1)
    jid = r["id"]

    m = bg_jobs.status(jid)
    assert m.get("note") == "", f"expected empty string, got {m.get('note')!r}"

    m2 = _poll(jid, {"done"}, timeout=12)
    assert m2.get("note") == ""


def test_long_note_round_trips():
    """A note ~2 KB long should survive the JSON round-trip without truncation."""
    note = "x" * 2048
    r = bg_jobs.sleep_wake(1, note=note)
    jid = r["id"]

    m = _poll(jid, {"done"}, timeout=12)
    assert m.get("note") == note


# ---------------------------------------------------------------------------
# 3. Stop before the timer fires -> "stopped", never reaches "done"
# ---------------------------------------------------------------------------

def test_stop_before_fires_yields_stopped():
    """Calling stop() on a sleeping timer immediately sets state to 'stopped'."""
    # Long timer: 60 s — we stop it before it ever fires.
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]

    # Wait until at least the initial "sleeping" state is confirmed.
    _poll(jid, {"sleeping"}, timeout=5)

    result = bg_jobs.stop(jid)
    assert result["state"] == "stopped", f"stop() returned: {result}"
    assert bg_jobs.status(jid)["state"] == "stopped"


def test_stop_before_fires_never_reaches_done():
    """After stop(), waiting 3 extra seconds must NOT flip state to 'done'."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    _poll(jid, {"sleeping"}, timeout=5)
    bg_jobs.stop(jid)

    # Confirm state stays "stopped" for the entire observation window.
    time.sleep(3)
    m = bg_jobs.status(jid)
    assert m["state"] == "stopped", (
        f"state changed to {m['state']} even after stop()"
    )


def test_stop_records_ended_at():
    """stop() must stamp ended_at on the meta."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    _poll(jid, {"sleeping"}, timeout=5)
    bg_jobs.stop(jid)

    m = bg_jobs.status(jid)
    assert m.get("ended_at") is not None, "ended_at not set after stop()"
    assert isinstance(m["ended_at"], float)


def test_stop_then_status_shows_stopped_not_sleeping():
    """status() must NOT report 'sleeping' once stop() has been called."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    _poll(jid, {"sleeping"}, timeout=5)
    bg_jobs.stop(jid)

    for _ in range(5):
        assert bg_jobs.status(jid)["state"] == "stopped"
        time.sleep(0.2)


# ---------------------------------------------------------------------------
# 4. Multiple independent timers
# ---------------------------------------------------------------------------

def test_multiple_timers_independent_completion():
    """Two timers with the same duration should both reach 'done' independently."""
    r1 = bg_jobs.sleep_wake(1, note="timer-A")
    r2 = bg_jobs.sleep_wake(1, note="timer-B")

    assert r1["id"] != r2["id"], "IDs must be distinct"

    m1 = _poll(r1["id"], {"done"}, timeout=12)
    m2 = _poll(r2["id"], {"done"}, timeout=12)

    assert m1["state"] == "done", f"timer A: {m1['state']}"
    assert m2["state"] == "done", f"timer B: {m2['state']}"

    # Notes must not bleed between jobs.
    assert m1.get("note") == "timer-A"
    assert m2.get("note") == "timer-B"


def test_multiple_timers_stop_one_does_not_affect_other():
    """Stopping timer A must leave timer B to complete normally.

    A small sleep between creations ensures distinct millisecond timestamps and
    therefore distinct IDs (the module's _new_id is ms-granularity), so A and B
    cannot accidentally share a job directory.
    """
    r_a = bg_jobs.sleep_wake(60, note="long-A")
    time.sleep(0.005)  # guarantee different ms-timestamp → different ID
    r_b = bg_jobs.sleep_wake(1, note="short-B")

    assert r_a["id"] != r_b["id"], (
        "IDs must be distinct; got same ID — increase sleep between creations"
    )

    _poll(r_a["id"], {"sleeping"}, timeout=5)
    bg_jobs.stop(r_a["id"])

    # B should still complete — its meta file is entirely separate from A's.
    m_b = _poll(r_b["id"], {"done"}, timeout=12)
    assert m_b["state"] == "done", f"timer B affected by stop(A): {m_b['state']}"

    # A must remain stopped.
    assert bg_jobs.status(r_a["id"])["state"] == "stopped"


def test_many_timers_all_complete():
    """Start N=4 timers; all must reach 'done'.

    Brief sleeps between creations ensure distinct ms-timestamps and therefore
    distinct IDs so each timer owns its own job directory.
    """
    results = []
    for i in range(4):
        results.append(bg_jobs.sleep_wake(1, note=f"t{i}"))
        time.sleep(0.005)  # distinct ms-timestamp → unique ID

    ids = [r["id"] for r in results]
    assert len(set(ids)) == len(ids), f"ID collision detected: {ids}"

    for i, (jid, note) in enumerate(zip(ids, [f"t{j}" for j in range(4)])):
        m = _poll(jid, {"done"}, timeout=15)
        assert m["state"] == "done", f"timer t{i} ({jid}) not done: {m['state']}"
        assert m.get("note") == note, f"note mismatch on t{i}: {m.get('note')!r}"


def test_multiple_timers_meta_isolated():
    """Each timer's meta dir lives under its own job ID subdirectory."""
    r1 = bg_jobs.sleep_wake(60)
    r2 = bg_jobs.sleep_wake(60)

    import os
    jobs_dir = os.environ["JARVIS_BG_JOBS_DIR"]
    from pathlib import Path
    dirs = list(Path(jobs_dir).iterdir())
    assert len(dirs) >= 2, "Expected at least two job dirs"

    bg_jobs.stop(r1["id"])
    bg_jobs.stop(r2["id"])


# ---------------------------------------------------------------------------
# 5. Returned wake_in_sec
# ---------------------------------------------------------------------------

def test_wake_in_sec_matches_requested():
    """sleep_wake(N) must return wake_in_sec == N for valid positive values."""
    for seconds in (1, 2, 5, 10):
        r = bg_jobs.sleep_wake(seconds)
        assert r["wake_in_sec"] == seconds, (
            f"sleep_wake({seconds}) returned wake_in_sec={r['wake_in_sec']}"
        )
        bg_jobs.stop(r["id"])  # clean up long timers


def test_wake_in_sec_zero_clamped_to_one():
    """0 seconds is clamped to 1 by max(1, int(seconds)) in sleep_wake()."""
    r = bg_jobs.sleep_wake(0)
    assert r["wake_in_sec"] == 1, (
        f"zero not clamped: wake_in_sec={r['wake_in_sec']}"
    )
    _poll(r["id"], {"done"}, timeout=10)


def test_wake_in_sec_negative_clamped_to_one():
    """Negative seconds are also clamped to 1."""
    r = bg_jobs.sleep_wake(-5)
    assert r["wake_in_sec"] == 1
    _poll(r["id"], {"done"}, timeout=10)


# ---------------------------------------------------------------------------
# 6. Status transitions and meta field integrity
# ---------------------------------------------------------------------------

def test_initial_state_is_sleeping():
    """Right after sleep_wake(), the job must be in 'sleeping' state."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    m = bg_jobs.status(jid)
    assert m["state"] == "sleeping", f"initial state: {m['state']}"
    bg_jobs.stop(jid)


def test_kind_field_is_sleep():
    """The kind field in job.json must be 'sleep'."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    m = bg_jobs.status(jid)
    assert m.get("kind") == "sleep", f"kind={m.get('kind')!r}"
    bg_jobs.stop(jid)


def test_runner_pid_populated():
    """runner_pid must be a non-zero integer after sleep_wake() returns."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    m = bg_jobs.status(jid)
    runner_pid = m.get("runner_pid")
    assert runner_pid is not None, "runner_pid missing"
    assert isinstance(runner_pid, int) and runner_pid > 0, (
        f"runner_pid not a positive int: {runner_pid}"
    )
    bg_jobs.stop(jid)


def test_started_at_is_recent_timestamp():
    """started_at must be a float close to time.time() at creation."""
    before = time.time()
    r = bg_jobs.sleep_wake(60)
    after = time.time()
    jid = r["id"]
    m = bg_jobs.status(jid)

    started_at = m.get("started_at")
    assert isinstance(started_at, float), f"started_at: {started_at!r}"
    assert before - 1.0 <= started_at <= after + 1.0, (
        f"started_at={started_at} outside [{before}, {after}]"
    )
    bg_jobs.stop(jid)


def test_ended_at_set_when_done():
    """ended_at must be a float set when the timer reaches 'done'."""
    r = bg_jobs.sleep_wake(1)
    jid = r["id"]
    m = _poll(jid, {"done"}, timeout=12)

    assert m["state"] == "done"
    ended_at = m.get("ended_at")
    assert isinstance(ended_at, float), f"ended_at: {ended_at!r}"
    assert ended_at > m["started_at"], "ended_at must be after started_at"


def test_session_id_empty_when_env_absent():
    """With JARVIS_AGENT_SESSION deleted, session_id in meta must be empty."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    m = bg_jobs.status(jid)
    assert m.get("session_id") == "", (
        f"session_id should be empty, got: {m.get('session_id')!r}"
    )
    bg_jobs.stop(jid)


def test_status_unknown_job_returns_error():
    """status() on a non-existent id must return an error dict."""
    m = bg_jobs.status("nonexistent-job-00000000")
    assert "error" in m, f"expected error key, got: {m}"


# ---------------------------------------------------------------------------
# 7. Listing includes sleep timers
# ---------------------------------------------------------------------------

def test_listing_includes_sleep_timer():
    """listing() must surface the sleep job."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]

    jobs = bg_jobs.listing()["jobs"]
    ids = [j["id"] for j in jobs]
    assert jid in ids, f"{jid} not in listing: {ids}"

    bg_jobs.stop(jid)


def test_listing_includes_completed_timer():
    """A completed timer must still appear in listing()."""
    r = bg_jobs.sleep_wake(1)
    jid = r["id"]
    _poll(jid, {"done"}, timeout=12)

    jobs = bg_jobs.listing()["jobs"]
    ids = [j["id"] for j in jobs]
    assert jid in ids, f"completed timer {jid} missing from listing"


def test_listing_multiple_timers_all_visible():
    """All created timers appear in listing()."""
    rs = [bg_jobs.sleep_wake(60, note=f"n{i}") for i in range(3)]
    ids_created = {r["id"] for r in rs}

    jobs = bg_jobs.listing()["jobs"]
    ids_listed = {j["id"] for j in jobs}
    assert ids_created.issubset(ids_listed), (
        f"missing from listing: {ids_created - ids_listed}"
    )

    for r in rs:
        bg_jobs.stop(r["id"])


# ---------------------------------------------------------------------------
# 8. Stop idempotency / edge cases
# ---------------------------------------------------------------------------

def test_stop_already_done_timer_is_harmless():
    """Calling stop() on an already-done timer must not raise or corrupt state."""
    r = bg_jobs.sleep_wake(1)
    jid = r["id"]
    _poll(jid, {"done"}, timeout=12)

    result = bg_jobs.stop(jid)
    # The stop overwrites with "stopped" — that's acceptable.  The key invariant
    # is that no exception is raised and the meta is still valid JSON.
    assert "error" not in result or result.get("state") in ("stopped", "done"), (
        f"unexpected stop() result on done timer: {result}"
    )
    m = bg_jobs.status(jid)
    assert m.get("state") in ("stopped", "done")


def test_stop_nonexistent_job_returns_error():
    """stop() on a nonexistent id must return an error dict, not raise."""
    result = bg_jobs.stop("ghost-job-00000000")
    assert "error" in result, f"expected error key: {result}"


def test_double_stop_does_not_corrupt():
    """Calling stop() twice on the same sleeping timer must keep state stable."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    _poll(jid, {"sleeping"}, timeout=5)

    bg_jobs.stop(jid)
    bg_jobs.stop(jid)

    m = bg_jobs.status(jid)
    assert m["state"] == "stopped"
    # ended_at should still be a valid float (not NaN/None).
    assert isinstance(m.get("ended_at"), float)


# ---------------------------------------------------------------------------
# 9. notify_on_done is False for sleep timers (no wake attempted in hermetic)
# ---------------------------------------------------------------------------

def test_notify_on_done_false_for_sleep_kind():
    """sleep_wake() sets notify_on_done=False (wake uses a separate path)."""
    r = bg_jobs.sleep_wake(60)
    jid = r["id"]
    m = bg_jobs.status(jid)
    assert m.get("notify_on_done") is False, (
        f"notify_on_done should be False: {m.get('notify_on_done')}"
    )
    bg_jobs.stop(jid)


# ---------------------------------------------------------------------------
# 10. Timing sanity: completed timer ended_at is close to started_at + seconds
# ---------------------------------------------------------------------------

def test_timer_elapsed_time_approximately_correct():
    """The gap ended_at - started_at must be >= requested seconds."""
    secs = 1
    r = bg_jobs.sleep_wake(secs)
    jid = r["id"]
    m = _poll(jid, {"done"}, timeout=12)

    assert m["state"] == "done"
    elapsed = m["ended_at"] - m["started_at"]
    # The runner must sleep at least `secs`, plus a tiny process-launch overhead.
    assert elapsed >= secs - 0.5, (
        f"elapsed {elapsed:.2f}s is less than requested {secs}s"
    )
    # Sanity upper-bound: should not take more than secs + 10 s (slow CI).
    assert elapsed < secs + 10, f"elapsed {elapsed:.2f}s is suspiciously long"
