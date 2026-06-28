"""Comprehensive edge-case tests for bg_jobs.py.

Hermetic: JARVIS_BG_JOBS_DIR redirected to a fresh tmp dir per test;
JARVIS_AGENT_SESSION deleted so the daemon wake is a no-op — no running
jarvisd required.

Coverage targets
----------------
* Unknown job ID passed to status / logs / stop  → graceful error dicts
* Empty command
* Commands containing shell metacharacters: quotes, $(), pipes, &&
* Very long name  → slug is truncated to ≤24 chars in the job ID
* Name consisting entirely of non-slug chars  → ID falls back to "job"
* Unicode in name + command
* Rapid start-then-immediate-stop of a long-running job
* Command that does not exist on PATH  → exit code 127
* stop() on an already-finished job  → graceful, no exception
* stop() called twice (idempotent)
* Listing is empty before any jobs start
* Listing shows all previously started jobs
* logs() shape is correct immediately after start (before job finishes)
* logs() `lines` parameter actually caps the returned log
* ID slug matches the job name
"""

from __future__ import annotations

import re
import time

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait(jid: str, states, timeout: float = 20) -> dict:
    """Poll until state is in `states` or timeout; return the last meta."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


# ---------------------------------------------------------------------------
# Hermetic fixture — applied to every test in this module
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ===========================================================================
# Group 1 — Unknown job IDs
# ===========================================================================

def test_status_unknown_id_returns_error_dict():
    """status() with a made-up ID must return a dict with an 'error' key."""
    result = bg_jobs.status("totally-bogus-id-does-not-exist")
    assert isinstance(result, dict), "return value must be a dict"
    assert "error" in result, "must contain 'error' key"
    assert "totally-bogus-id-does-not-exist" in result["error"]


def test_logs_unknown_id_returns_error_dict():
    """logs() with a missing log file must return an error dict, not raise."""
    result = bg_jobs.logs("totally-bogus-id-does-not-exist")
    assert isinstance(result, dict), "return value must be a dict"
    assert "error" in result, "must contain 'error' key for missing log"


def test_stop_unknown_id_returns_error_dict():
    """stop() with a made-up ID must return a dict with an 'error' key."""
    result = bg_jobs.stop("totally-bogus-id-does-not-exist")
    assert isinstance(result, dict), "return value must be a dict"
    assert "error" in result, "must contain 'error' key"
    assert "totally-bogus-id-does-not-exist" in result["error"]


# ===========================================================================
# Group 2 — Empty command
# ===========================================================================

def test_empty_command_does_not_crash():
    """`sh -c ''` exits 0 on POSIX; start/wait must complete without raising."""
    r = bg_jobs.start("", name="empty-cmd")
    assert "id" in r, "start() must return a dict with 'id'"
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    # Accept either outcome — the key invariant is no exception and a terminal state
    assert m["state"] in {"done", "failed"}, f"unexpected state: {m['state']!r}"
    assert m.get("exit_code") is not None, "exit_code must be recorded"


# ===========================================================================
# Group 3 — Shell metacharacters
# ===========================================================================

def test_command_with_double_quotes():
    """A command containing double quotes must be handled by the shell correctly."""
    r = bg_jobs.start('printf "%s\\n" "quoted-output"', name="quotes")
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] == "done", f"unexpected state: {m['state']!r}"
    log = bg_jobs.logs(r["id"])["log"]
    assert "quoted-output" in log, "quoted argument must appear in log"


def test_command_with_dollar_subshell():
    """$() command substitution must expand correctly via the shell."""
    r = bg_jobs.start("echo $(echo subshell-value)", name="dollar-sub")
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] == "done"
    log = bg_jobs.logs(r["id"])["log"]
    assert "subshell-value" in log, "$() expansion must appear in captured output"


def test_command_with_pipe():
    """Commands joined by a pipe must execute both sides in sequence."""
    r = bg_jobs.start("printf 'hello\\n' | tr 'a-z' 'A-Z'", name="pipe-test")
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] == "done"
    log = bg_jobs.logs(r["id"])["log"]
    assert "HELLO" in log, "tr output must appear in log"


def test_command_with_double_ampersand():
    """Both sides of && must run and be captured when the first exits 0."""
    r = bg_jobs.start("echo step-one && echo step-two", name="and-and")
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] == "done"
    log = bg_jobs.logs(r["id"])["log"]
    assert "step-one" in log, "first command output must be in log"
    assert "step-two" in log, "second command (after &&) must be in log"


# ===========================================================================
# Group 4 — Very long name / ID slug truncation
# ===========================================================================

def test_very_long_name_slug_is_truncated_to_24_chars():
    """_new_id() truncates the slug part to 24 characters."""
    long_name = "a" * 100
    r = bg_jobs.start("true", name=long_name)
    jid = r["id"]
    # ID format: <slug>-<8-digit-timestamp-suffix>
    m = re.match(r"^(.+)-(\d{8})$", jid)
    assert m is not None, f"ID format unexpected: {jid!r}"
    slug = m.group(1)
    assert len(slug) <= 24, f"slug longer than 24 chars: {slug!r} ({len(slug)} chars)"


def test_name_only_special_chars_fallback_to_job_slug():
    """When all chars in the name are non-slug, the ID starts with 'job'."""
    r = bg_jobs.start("true", name="!@#$%^&*()")
    jid = r["id"]
    assert jid.startswith("job"), (
        f"expected ID to start with 'job' for all-special-char name, got: {jid!r}"
    )


def test_slug_contains_only_lowercase_alnum_and_hyphens():
    """Regardless of name contents, the slug must be [a-z0-9-] only."""
    r = bg_jobs.start("true", name="Hello World -- Version 2.0 FINAL!")
    jid = r["id"]
    slug = re.sub(r"-\d{8}$", "", jid)
    assert re.fullmatch(r"[a-z0-9-]+", slug), (
        f"slug contains disallowed chars: {slug!r}"
    )
    assert len(slug) <= 24


# ===========================================================================
# Group 5 — Unicode in name and command
# ===========================================================================

def test_unicode_in_name_does_not_crash():
    """Non-ASCII name chars get stripped from the slug but the job still runs."""
    r = bg_jobs.start("true", name="测试 job unicode")
    assert "id" in r
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] in {"done", "failed"}


def test_unicode_in_command_does_not_crash():
    """A command containing non-ASCII characters must not crash the runner."""
    r = bg_jobs.start('echo "héllo wörld"', name="unicode-cmd")
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    # The exact echoed output depends on locale, but no crash is the key invariant
    assert m["state"] in {"done", "failed"}
    log_result = bg_jobs.logs(r["id"])
    assert "log" in log_result, "logs() must return a dict with 'log' key"
    assert isinstance(log_result["log"], str)


def test_unicode_emoji_in_name():
    """Emoji-only names must reduce to the 'job' fallback without crashing."""
    r = bg_jobs.start("true", name="🚀 🎉 🤖")
    assert "id" in r
    m = _wait(r["id"], {"done", "failed"}, timeout=15)
    assert m["state"] in {"done", "failed"}
    # Emoji are not [a-z0-9] so the slug falls back to "job"
    assert r["id"].startswith("job"), (
        f"emoji-only name should produce 'job' prefix: {r['id']!r}"
    )


# ===========================================================================
# Group 6 — Rapid start → immediate stop
# ===========================================================================

def test_rapid_start_then_immediate_stop():
    """Stop a long-running job immediately after start — must record 'stopped'."""
    r = bg_jobs.start("sleep 300", name="instant-stop")
    jid = r["id"]
    # Do NOT wait — call stop before the runner even runs the command
    result = bg_jobs.stop(jid)
    assert "error" not in result, f"stop() returned error: {result}"
    assert result.get("state") == "stopped"
    # Subsequent status call must also reflect stopped
    s = bg_jobs.status(jid)
    assert s["state"] == "stopped"


# ===========================================================================
# Group 7 — Command not found → exit 127
# ===========================================================================

def test_nonexistent_command_records_exit_127():
    """When the shell cannot find the binary, exit code must be 127."""
    r = bg_jobs.start(
        "this_binary_absolutely_does_not_exist_xyz_abc_99999",
        name="no-such-cmd",
    )
    m = _wait(r["id"], {"done", "failed"}, timeout=20)
    assert m["state"] == "failed", f"expected 'failed', got {m['state']!r}"
    assert m["exit_code"] == 127, (
        f"shell should return 127 for command-not-found, got {m['exit_code']!r}"
    )


# ===========================================================================
# Group 8 — stop() on an already-finished / already-stopped job
# ===========================================================================

def test_stop_on_already_done_job_is_graceful():
    """stop() must not raise and must not return an error for a finished job."""
    r = bg_jobs.start("echo done-already; exit 0", name="already-done")
    jid = r["id"]
    m = _wait(jid, {"done", "failed"}, timeout=20)
    assert m["state"] in {"done", "failed"}
    # Now call stop — job is already in a terminal state
    result = bg_jobs.stop(jid)
    assert "error" not in result, f"stop() on done job returned error: {result}"
    # stop() always writes "stopped" unconditionally
    assert result.get("state") == "stopped"


def test_stop_twice_is_idempotent():
    """Calling stop() a second time on an already-stopped job must be harmless."""
    r = bg_jobs.start("sleep 300", name="stop-twice")
    jid = r["id"]
    bg_jobs.stop(jid)
    # Second call — process group is already gone
    result2 = bg_jobs.stop(jid)
    assert "error" not in result2, f"second stop() returned error: {result2}"
    assert result2["state"] == "stopped"


# ===========================================================================
# Group 9 — Listing edge cases
# ===========================================================================

def test_listing_empty_before_any_jobs():
    """A fresh (hermetic) root must yield an empty jobs list."""
    assert bg_jobs.listing() == {"jobs": []}


def test_listing_shows_all_started_jobs():
    """Every started job must appear in listing() output."""
    r1 = bg_jobs.start("true", name="job-alpha")
    r2 = bg_jobs.start("true", name="job-beta")
    _wait(r1["id"], {"done", "failed"})
    _wait(r2["id"], {"done", "failed"})
    ids = {j["id"] for j in bg_jobs.listing()["jobs"]}
    assert r1["id"] in ids, "first job missing from listing"
    assert r2["id"] in ids, "second job missing from listing"


def test_listing_entry_has_required_keys():
    """Each listing entry must have the documented summary keys."""
    r = bg_jobs.start("true", name="key-check")
    _wait(r["id"], {"done", "failed"})
    jobs = bg_jobs.listing()["jobs"]
    entry = next(j for j in jobs if j["id"] == r["id"])
    for key in ("id", "kind", "name", "state", "started_at"):
        assert key in entry, f"listing entry missing key: {key!r}"


# ===========================================================================
# Group 10 — logs() edge cases
# ===========================================================================

def test_logs_returns_correct_shape_immediately_after_start():
    """logs() must return {'id': ..., 'log': ...} even before the job finishes."""
    r = bg_jobs.start("sleep 60", name="log-shape-check")
    try:
        result = bg_jobs.logs(r["id"])
        assert "log" in result, "logs() must have a 'log' key"
        assert result.get("id") == r["id"], "logs() must echo back the job id"
        assert isinstance(result["log"], str), "log value must be a string"
    finally:
        bg_jobs.stop(r["id"])


def test_logs_line_limit_caps_output():
    """`lines` param must cap the returned output to at most N lines."""
    # Generate 60 lines of output
    r = bg_jobs.start(
        "for i in $(seq 1 60); do echo _line_; done",
        name="many-lines",
    )
    m = _wait(r["id"], {"done", "failed"}, timeout=20)
    assert m["state"] == "done"
    result = bg_jobs.logs(r["id"], lines=10)
    assert "log" in result
    actual_lines = result["log"].splitlines()
    assert len(actual_lines) <= 10, (
        f"expected ≤10 lines, got {len(actual_lines)}"
    )
    # The last 10 lines of 60 identical "_line_" lines must all contain "_line_"
    assert all("_line_" in ln for ln in actual_lines)


# ===========================================================================
# Group 11 — ID slug format
# ===========================================================================

def test_id_slug_reflects_name():
    """The job ID must start with a slug derived from the provided name."""
    r = bg_jobs.start("true", name="my-special-job")
    assert r["id"].startswith("my-special-job"), (
        f"ID {r['id']!r} does not start with 'my-special-job'"
    )


def test_id_format_matches_slug_dash_8digits():
    """Job ID must match the pattern <slug>-<8 digits>."""
    r = bg_jobs.start("true", name="fmt-check")
    jid = r["id"]
    assert re.fullmatch(r"[a-z0-9-]+-\d{8}", jid), (
        f"ID does not match expected pattern: {jid!r}"
    )
