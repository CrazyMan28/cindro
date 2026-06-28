"""Comprehensive concurrency / isolation tests for bg_jobs.

Covers:
- 8-12 jobs started concurrently with distinct outputs — no cross-talk in
  logs or meta, each job gets the right exit code and terminal state.
- bg_jobs.listing() shows all entries with correct kinds/states while jobs
  are running and after they finish.
- IDs are unique across concurrently-spawned jobs with distinct names.
- Meta writes are atomic (write-via-rename) and never corrupt under load.
- Concurrent stop, concurrent status reads, independent completion ordering.

Hermetic: JARVIS_BG_JOBS_DIR is redirected to a fresh tmp_path/bg dir per
test; JARVIS_AGENT_SESSION is deleted so daemon wakes are no-ops.
"""

from __future__ import annotations

import concurrent.futures
import json
import time
from pathlib import Path

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _wait_all(
    jids: list[str],
    states: set[str],
    timeout: float = 30.0,
) -> dict[str, dict]:
    """Poll until every jid reaches one of *states*, or the timeout expires.

    Returns {jid: status_dict} for every requested jid.  Jobs that never
    reach a target state are included with their last-observed status.
    """
    deadline = time.time() + timeout
    remaining = set(jids)
    results: dict[str, dict] = {}
    while remaining and time.time() < deadline:
        for jid in list(remaining):
            m = bg_jobs.status(jid)
            if m.get("state") in states:
                results[jid] = m
                remaining.discard(jid)
        if remaining:
            time.sleep(0.1)
    for jid in remaining:
        results[jid] = bg_jobs.status(jid)
    return results


def _wait_one(jid: str, states: set[str], timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.1)
    return bg_jobs.status(jid)


# ---------------------------------------------------------------------------
# Hermetic fixture — applied to every test in this module
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Redirect all bg_jobs state to a fresh tmp dir; suppress session wakes."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# 1. Unique IDs under concurrent starts
# ---------------------------------------------------------------------------


def test_concurrent_unique_ids():
    """Starting 10 jobs concurrently from distinct threads produces 10 unique IDs.

    Uses unique name= arguments so the slug portion differs, giving uniqueness
    even if multiple threads hit the same millisecond timestamp.
    """
    N = 10

    def _start(i: int) -> dict:
        return bg_jobs.start(f"echo job-{i}", name=f"uid-test-{i}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_start, i) for i in range(N)]
        starts = [f.result() for f in concurrent.futures.as_completed(futs)]

    ids = [r["id"] for r in starts]
    assert len(ids) == N
    assert len(set(ids)) == N, f"Duplicate IDs found: {sorted(ids)}"


# ---------------------------------------------------------------------------
# 2. No log cross-talk across 10 concurrent jobs
# ---------------------------------------------------------------------------


def test_concurrent_no_log_crosstalk():
    """Each of 10 concurrent jobs writes a unique sentinel token.

    After all complete, every log must contain ONLY its own token — no token
    from any other job may appear.  This verifies that log file descriptors
    and routing are strictly per-job.
    """
    N = 10
    tokens = [f"CROSSTALK_SENTINEL_{i:04d}" for i in range(N)]

    def _start(i: int) -> dict:
        return bg_jobs.start(f"printf '{tokens[i]}\\n'", name=f"crosstalk-{i}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_start, i) for i in range(N)]
        starts = [f.result() for f in futs]

    jids = [r["id"] for r in starts]
    _wait_all(jids, {"done", "failed"}, timeout=30)

    for i, jid in enumerate(jids):
        log = bg_jobs.logs(jid, 500)["log"]
        assert tokens[i] in log, f"Job {i} ({jid}) log is missing its own token"
        for j in range(N):
            if j != i:
                assert tokens[j] not in log, (
                    f"Cross-talk: job {i} log contains token from job {j}"
                )


# ---------------------------------------------------------------------------
# 3. Correct exit codes — no state pollution between jobs
# ---------------------------------------------------------------------------


def test_concurrent_correct_exit_codes():
    """10 jobs started concurrently each record their own exit code independently.

    A mix of zero and non-zero exit codes ensures the done/failed classification
    is per-job and not shared.
    """
    pairs: list[tuple[int, str]] = [
        (0, "done"), (1, "failed"), (2, "failed"), (3, "failed"),
        (0, "done"), (5, "failed"), (0, "done"), (7, "failed"),
        (0, "done"), (4, "failed"),
    ]

    def _start(i: int) -> dict:
        code, _ = pairs[i]
        return bg_jobs.start(f"exit {code}", name=f"exitcode-{i}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(pairs)) as pool:
        futs = [pool.submit(_start, i) for i in range(len(pairs))]
        starts = [f.result() for f in futs]

    jids = [r["id"] for r in starts]
    results = _wait_all(jids, {"done", "failed"}, timeout=30)

    for i, jid in enumerate(jids):
        expected_code, expected_state = pairs[i]
        m = results[jid]
        assert m.get("state") == expected_state, (
            f"Job {i} ({jid}): expected state={expected_state!r}, "
            f"got {m.get('state')!r}"
        )
        assert m.get("exit_code") == expected_code, (
            f"Job {i} ({jid}): expected exit_code={expected_code}, "
            f"got {m.get('exit_code')}"
        )


# ---------------------------------------------------------------------------
# 4. listing() includes all 8 concurrent jobs once they finish
# ---------------------------------------------------------------------------


def test_listing_shows_all_concurrent_jobs():
    """listing() must return an entry for each of 8 jobs started concurrently."""
    N = 8

    def _start(i: int) -> dict:
        return bg_jobs.start(f"echo listing-job-{i}", name=f"listjob-{i}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_start, i) for i in range(N)]
        starts = [f.result() for f in futs]

    jids = {r["id"] for r in starts}
    _wait_all(list(jids), {"done", "failed"}, timeout=30)

    listed_ids = {j["id"] for j in bg_jobs.listing()["jobs"]}
    missing = jids - listed_ids
    assert not missing, f"Jobs not present in listing(): {missing}"


# ---------------------------------------------------------------------------
# 5. listing() reports correct kinds for mixed job/sleep/monitor entries
# ---------------------------------------------------------------------------


def test_listing_correct_kinds_for_mixed_concurrent():
    """listing() must report the right kind for each of the three job types."""
    job_r = bg_jobs.start("echo hi", name="kind-job")
    slp_r = bg_jobs.sleep_wake(1, note="kind-test")
    mon_r = bg_jobs.monitor(
        "echo READY", interval_sec=2, until_regex="READY", name="kind-mon"
    )

    all_jids = [job_r["id"], slp_r["id"], mon_r["id"]]
    _wait_all(all_jids, {"done", "failed", "expired"}, timeout=20)

    by_id = {j["id"]: j for j in bg_jobs.listing()["jobs"]}

    for jid, expected_kind in [
        (job_r["id"], "job"),
        (slp_r["id"], "sleep"),
        (mon_r["id"], "monitor"),
    ]:
        assert jid in by_id, f"{expected_kind} job {jid} missing from listing()"
        got_kind = by_id[jid]["kind"]
        assert got_kind == expected_kind, (
            f"Expected kind={expected_kind!r} for {jid}, got {got_kind!r}"
        )


# ---------------------------------------------------------------------------
# 6. Meta JSON integrity under concurrent load (12 jobs)
# ---------------------------------------------------------------------------


def test_meta_not_corrupted_under_concurrent_load():
    """After 12 concurrent jobs complete, every job.json must be valid JSON
    with the expected schema fields and consistent id/state values.

    The _write_meta() atomic-rename pattern should prevent partial writes.
    """
    N = 12
    REQUIRED = {"id", "kind", "state", "exit_code", "started_at", "ended_at"}

    def _start(i: int) -> dict:
        return bg_jobs.start(
            f"echo meta-stress-{i}; exit {i % 3}", name=f"metastress-{i}"
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_start, i) for i in range(N)]
        starts = [f.result() for f in futs]

    jids = [r["id"] for r in starts]
    _wait_all(jids, {"done", "failed"}, timeout=30)

    for jid in jids:
        raw = Path(bg_jobs._meta_path(jid)).read_text()
        try:
            meta = json.loads(raw)
        except json.JSONDecodeError as exc:
            pytest.fail(
                f"Corrupted meta JSON for {jid}: {exc}\n"
                f"Raw snippet: {raw[:300]}"
            )

        for field in REQUIRED:
            assert field in meta, (
                f"Required field {field!r} missing from meta for {jid}"
            )
        assert meta["id"] == jid, (
            f"meta['id']={meta['id']!r} != job dir name {jid!r}"
        )
        assert meta["state"] in ("done", "failed"), (
            f"Unexpected terminal state {meta['state']!r} for {jid}"
        )
        assert meta["exit_code"] is not None, (
            f"exit_code is None in completed meta for {jid}"
        )
        assert isinstance(meta["started_at"], (int, float)), (
            f"started_at not numeric for {jid}: {meta['started_at']!r}"
        )
        assert isinstance(meta["ended_at"], (int, float)), (
            f"ended_at not numeric for {jid}: {meta['ended_at']!r}"
        )
        assert meta["ended_at"] >= meta["started_at"], (
            f"ended_at < started_at for {jid}"
        )


# ---------------------------------------------------------------------------
# 7. Independent completion order — fast jobs don't affect slow ones
# ---------------------------------------------------------------------------


def test_independent_completion_order():
    """Fast jobs (0.1 s) completing must not alter the state of still-running
    slow jobs (0.8 s), and all jobs must eventually reach state=done.

    Three speed tiers: fast (×3), medium (×3), slow (×2).
    """
    fast_starts = [
        bg_jobs.start(f"sleep 0.1; echo fast-{i}", name=f"speed-fast-{i}")
        for i in range(3)
    ]
    med_starts = [
        bg_jobs.start(f"sleep 0.4; echo med-{i}", name=f"speed-med-{i}")
        for i in range(3)
    ]
    slow_starts = [
        bg_jobs.start(f"sleep 0.8; echo slow-{i}", name=f"speed-slow-{i}")
        for i in range(2)
    ]

    fast_jids = [r["id"] for r in fast_starts]
    slow_jids = [r["id"] for r in slow_starts]
    all_jids = fast_jids + [r["id"] for r in med_starts] + slow_jids

    # Wait for fast tier to finish first.
    fast_results = _wait_all(fast_jids, {"done", "failed"}, timeout=10)
    for jid in fast_jids:
        assert fast_results[jid]["state"] == "done", (
            f"Fast job {jid} ended with state={fast_results[jid]['state']!r}"
        )

    # Slow jobs must be alive (not corrupted or prematurely ended).
    VALID_SLOW_STATES = {"starting", "running", "done", "failed"}
    for jid in slow_jids:
        m = bg_jobs.status(jid)
        assert "error" not in m, f"Error reading status for slow job {jid}: {m}"
        assert m.get("state") in VALID_SLOW_STATES, (
            f"Slow job {jid} in unexpected state={m.get('state')!r} "
            f"after fast jobs finished"
        )

    # All jobs must ultimately succeed.
    all_results = _wait_all(all_jids, {"done", "failed"}, timeout=20)
    for jid in all_jids:
        assert all_results[jid]["state"] == "done", (
            f"Job {jid} ended with state={all_results[jid]['state']!r}, expected done"
        )


# ---------------------------------------------------------------------------
# 8. Concurrent stop of 8 long-running jobs
# ---------------------------------------------------------------------------


def test_concurrent_stop_all():
    """Stopping 8 long-running jobs simultaneously must mark every one as stopped
    in both the return value of stop() and the persisted meta file.
    """
    N = 8
    starts = [bg_jobs.start("sleep 60", name=f"stoppable-{i}") for i in range(N)]
    jids = [r["id"] for r in starts]

    # Ensure all runners have transitioned to "running" before we stop them.
    _wait_all(jids, {"running"}, timeout=15)

    def _stop(jid: str) -> dict:
        return bg_jobs.stop(jid)

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_stop, jid) for jid in jids]
        stop_results = [f.result() for f in concurrent.futures.as_completed(futs)]

    # stop() return values must all report "stopped".
    for res in stop_results:
        assert res.get("state") == "stopped", (
            f"stop() returned unexpected result: {res}"
        )

    # Persisted meta must also reflect "stopped".
    for jid in jids:
        m = bg_jobs.status(jid)
        assert m["state"] == "stopped", (
            f"Persisted state for {jid} is {m['state']!r}, expected stopped"
        )


# ---------------------------------------------------------------------------
# 9. Log files are separate and isolated per job
# ---------------------------------------------------------------------------


def test_log_files_are_separate_per_job():
    """10 jobs must produce 10 distinct log file paths, each containing only
    its own token and none from any other job.
    """
    N = 10
    tokens = [f"LOGTOKEN_{i:05d}" for i in range(N)]

    starts = [
        bg_jobs.start(f"printf '%s\\n' '{tokens[i]}'", name=f"logfile-{i}")
        for i in range(N)
    ]
    jids = [r["id"] for r in starts]
    _wait_all(jids, {"done", "failed"}, timeout=30)

    log_paths = [str(bg_jobs._log_path(jid)) for jid in jids]
    assert len(set(log_paths)) == N, f"Duplicate log paths detected: {log_paths}"

    for i, jid in enumerate(jids):
        content = Path(log_paths[i]).read_text(errors="replace")
        assert tokens[i] in content, (
            f"Log for job {i} ({jid}) is missing its own token"
        )
        for j in range(N):
            if j != i:
                assert tokens[j] not in content, (
                    f"Log for job {i} contains token from job {j} — "
                    f"file descriptor leak?"
                )


# ---------------------------------------------------------------------------
# 10. listing() timestamps are well-formed after completion
# ---------------------------------------------------------------------------


def test_listing_timestamps_after_completion():
    """After 8 jobs complete, listing() entries must carry numeric started_at
    and ended_at values where ended_at >= started_at.
    """
    N = 8
    starts = [bg_jobs.start(f"echo ts-{i}", name=f"timestamp-{i}") for i in range(N)]
    jids = [r["id"] for r in starts]
    jid_set = set(jids)
    _wait_all(jids, {"done", "failed"}, timeout=30)

    for entry in bg_jobs.listing()["jobs"]:
        if entry["id"] not in jid_set:
            continue
        jid = entry["id"]
        assert entry["started_at"] is not None, f"started_at is None for {jid}"
        assert isinstance(entry["started_at"], (int, float)), (
            f"started_at not numeric for {jid}: {entry['started_at']!r}"
        )
        assert entry["ended_at"] is not None, f"ended_at is None for {jid}"
        assert isinstance(entry["ended_at"], (int, float)), (
            f"ended_at not numeric for {jid}: {entry['ended_at']!r}"
        )
        assert entry["ended_at"] >= entry["started_at"], (
            f"ended_at < started_at for {jid}: "
            f"{entry['ended_at']} < {entry['started_at']}"
        )


# ---------------------------------------------------------------------------
# 11. Concurrent monitors — each trips only on its own regex
# ---------------------------------------------------------------------------


def test_concurrent_monitor_jobs_no_crosstalk():
    """5 monitors started concurrently each trip on their own unique regex token.

    Each monitor must reach state=done with matched=True, and its log must
    contain its own token.  No monitor must trip because of another monitor's
    output.
    """
    N = 5
    tokens = [f"MTRIP_{i:04d}" for i in range(N)]

    starts = [
        bg_jobs.monitor(
            f"echo {tokens[i]}",
            interval_sec=2,
            until_regex=tokens[i],
            name=f"conmon-{i}",
        )
        for i in range(N)
    ]
    jids = [r["id"] for r in starts]
    results = _wait_all(jids, {"done", "expired"}, timeout=30)

    for i, jid in enumerate(jids):
        m = results[jid]
        assert m["state"] == "done", (
            f"Monitor {i} ({jid}) did not trip — state={m['state']!r}"
        )
        assert m.get("matched") is True, (
            f"Monitor {i} ({jid}) matched flag is not True: {m.get('matched')!r}"
        )
        log = bg_jobs.logs(jid, 200)["log"]
        assert tokens[i] in log, f"Monitor {i} log is missing its own token"


# ---------------------------------------------------------------------------
# 12. listing() is consistent while jobs are still running
# ---------------------------------------------------------------------------


def test_listing_shows_running_jobs():
    """listing() called mid-run must include all 8 running jobs and report
    state=running for each of them.  Jobs are stopped for clean-up afterwards.
    """
    N = 8
    starts = [bg_jobs.start("sleep 10", name=f"midrun-{i}") for i in range(N)]
    jids = {r["id"] for r in starts}

    # Wait until every runner has written state=running.
    _wait_all(list(jids), {"running"}, timeout=15)

    snap = bg_jobs.listing()
    by_id = {j["id"]: j for j in snap["jobs"]}

    missing = jids - set(by_id.keys())
    assert not missing, f"Jobs missing from listing() while running: {missing}"

    for jid in jids:
        state = by_id[jid]["state"]
        assert state == "running", (
            f"Job {jid} expected state=running in mid-run listing, got {state!r}"
        )

    # Clean up so the tmp dir can be released promptly.
    for jid in jids:
        bg_jobs.stop(jid)


# ---------------------------------------------------------------------------
# 13. Concurrent status reads while meta files are being written
# ---------------------------------------------------------------------------


def test_concurrent_reads_while_meta_writes():
    """status() polled concurrently across 10 jobs while those jobs are writing
    meta files must never return malformed data, raise, or report an impossible
    state value.
    """
    N = 10
    VALID_STATES = {"starting", "running", "done", "failed", "stopped", "ended"}
    starts = [
        bg_jobs.start(f"sleep 0.3; echo rw-{i}", name=f"readwrite-{i}")
        for i in range(N)
    ]
    jids = [r["id"] for r in starts]
    errors: list[str] = []

    def _poll(jid: str) -> None:
        deadline = time.time() + 1.5
        while time.time() < deadline:
            try:
                m = bg_jobs.status(jid)
                if not isinstance(m, dict):
                    errors.append(f"{jid}: status() returned non-dict {type(m)}")
                    continue
                state = m.get("state")
                if state is not None and state not in VALID_STATES:
                    errors.append(f"{jid}: unexpected state {state!r}")
                ec = m.get("exit_code")
                if ec is not None and not isinstance(ec, int):
                    errors.append(f"{jid}: exit_code not int: {ec!r}")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{jid}: status() raised {exc!r}")
            time.sleep(0.05)

    with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
        futs = [pool.submit(_poll, jid) for jid in jids]
        for f in concurrent.futures.as_completed(futs):
            f.result()

    assert not errors, (
        "Errors during concurrent status reads:\n" + "\n".join(errors)
    )


# ---------------------------------------------------------------------------
# 14. stop() called twice on the same job is safe
# ---------------------------------------------------------------------------


def test_stop_already_stopped_is_idempotent():
    """Calling stop() a second time on an already-stopped job must not raise
    and must still return state=stopped.  This exercises the path where stop()
    tries to kill a pid that no longer exists.
    """
    r = bg_jobs.start("sleep 60", name="idempotent-stop")
    jid = r["id"]
    _wait_one(jid, {"running"}, timeout=10)

    first = bg_jobs.stop(jid)
    assert first["state"] == "stopped"

    second = bg_jobs.stop(jid)
    assert second["state"] == "stopped", (
        f"Second stop() returned state={second['state']!r}, expected stopped"
    )

    assert bg_jobs.status(jid)["state"] == "stopped"


# ---------------------------------------------------------------------------
# 15. Graceful error returns for unknown job IDs
# ---------------------------------------------------------------------------


def test_status_unknown_job_returns_error():
    """status() for a completely unknown job ID returns an error dict, not an exception."""
    result = bg_jobs.status("nonexistent-job-id-xyzzy-99999999")
    assert isinstance(result, dict), "status() must return a dict"
    assert "error" in result, (
        f"Expected 'error' key for unknown job, got keys: {list(result.keys())}"
    )


def test_logs_unknown_job_returns_error():
    """logs() for a completely unknown job ID returns an error dict, not an exception."""
    result = bg_jobs.logs("nonexistent-job-id-xyzzy-88888888", lines=10)
    assert isinstance(result, dict), "logs() must return a dict"
    assert "error" in result, (
        f"Expected 'error' key for unknown job logs, got keys: {list(result.keys())}"
    )
