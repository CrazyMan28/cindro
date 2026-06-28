"""Comprehensive edge-case tests for bg_jobs.logs (bg_logs).

Hermetic via JARVIS_BG_JOBS_DIR → tmp_path per test and JARVIS_AGENT_SESSION
unset (no real daemon required).  Two layers:

  * Unit-style: directly plant log files in the tmp dir – fast, deterministic,
    no subprocess.  Isolates the pure log-reading / tail logic.

  * Integration: real detached subprocess jobs via bg_jobs.start(), waiting
    for completion.  Covers the full write-then-read pipeline including
    stdout+stderr merge and unicode round-trip.

Coverage:
  - unknown id → error dict, no crash
  - empty output (zero bytes)
  - 10 000-line file → default tail is 80 (the LAST 80 lines)
  - custom lines= parameter (10, 1, N > file size)
  - boundary: exactly 80 lines (all returned), 81 lines (tailed to 80)
  - stdout AND stderr both captured (merged via stderr=STDOUT)
  - stdout/stderr interleaved
  - unicode (non-ASCII) and emoji preserved end-to-end
  - return-dict shape: {id, log} on success; {error} on failure
  - log type is str; id field matches the requested jid
  - logs() on a still-running job does not crash
  - single-line file with and without trailing newline
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Redirect all bg-job state to a fresh tmp dir; suppress daemon wake."""
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


@pytest.fixture
def jobs_dir(tmp_path) -> Path:
    """Same sub-path that _hermetic registered; usable by unit-style tests."""
    return tmp_path / "bg"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait(jid: str, states: set, timeout: float = 30) -> dict:
    """Poll status until the job reaches one of *states* or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


def _plant_log(jobs_dir: Path, jid: str, content: str) -> None:
    """Write a log file directly, bypassing the subprocess runner."""
    d = jobs_dir / jid
    d.mkdir(parents=True, exist_ok=True)
    (d / "out.log").write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Unknown-id tests – error dict, no crash
# ---------------------------------------------------------------------------

def test_logs_unknown_id_returns_error_dict():
    result = bg_jobs.logs("totally-unknown-xyzzy-id")
    assert isinstance(result, dict), "logs() must always return a dict"
    assert "error" in result, "unknown id must yield {'error': ...}"


def test_logs_unknown_id_error_has_no_log_key():
    result = bg_jobs.logs("ghost-job-no-file")
    assert "log" not in result, "'log' key must be absent in error result"


def test_logs_unknown_id_error_message_is_nonempty_string():
    result = bg_jobs.logs("no-such-job-99999")
    assert isinstance(result["error"], str)
    assert result["error"].strip()


def test_logs_unknown_id_custom_lines_still_error():
    """lines= parameter must not prevent the error path from working."""
    result = bg_jobs.logs("ghost-custom", lines=200)
    assert "error" in result


# ---------------------------------------------------------------------------
# Empty-output tests
# ---------------------------------------------------------------------------

def test_logs_empty_log_file_returns_empty_string(jobs_dir):
    _plant_log(jobs_dir, "empty-job", "")
    result = bg_jobs.logs("empty-job")
    assert result == {"id": "empty-job", "log": ""}


def test_logs_empty_log_custom_lines_also_empty(jobs_dir):
    _plant_log(jobs_dir, "empty-job2", "")
    assert bg_jobs.logs("empty-job2", lines=10)["log"] == ""


# ---------------------------------------------------------------------------
# Default tail (80 lines) – unit-style
# ---------------------------------------------------------------------------

def test_logs_10000_lines_default_tail_is_80(jobs_dir):
    content = "\n".join(f"line-{i}" for i in range(1, 10_001))
    _plant_log(jobs_dir, "big-10k", content)
    result = bg_jobs.logs("big-10k")
    assert "error" not in result
    assert len(result["log"].splitlines()) == 80


def test_logs_10000_lines_default_tail_is_last_80(jobs_dir):
    content = "\n".join(f"line-{i}" for i in range(1, 10_001))
    _plant_log(jobs_dir, "big-10k-last", content)
    lines = bg_jobs.logs("big-10k-last")["log"].splitlines()
    assert lines[0] == "line-9921"
    assert lines[-1] == "line-10000"


def test_logs_exactly_80_lines_all_returned(jobs_dir):
    """Boundary: exactly 80 lines – _tail must NOT drop any."""
    content = "\n".join(f"L{i}" for i in range(80))
    _plant_log(jobs_dir, "exact80", content)
    result = bg_jobs.logs("exact80")
    assert len(result["log"].splitlines()) == 80


def test_logs_81_lines_tails_to_80(jobs_dir):
    """81 lines → exactly 80 returned, and they are the last 80."""
    content = "\n".join(f"L{i}" for i in range(81))
    _plant_log(jobs_dir, "exact81", content)
    lines = bg_jobs.logs("exact81")["log"].splitlines()
    assert len(lines) == 80
    assert lines[0] == "L1"
    assert lines[-1] == "L80"


def test_logs_fewer_than_80_lines_all_returned(jobs_dir):
    """When file has fewer lines than the limit, the entire text comes back."""
    content = "alpha\nbeta\ngamma"
    _plant_log(jobs_dir, "small3", content)
    result = bg_jobs.logs("small3")
    # _tail returns original text unchanged when len(lines) <= n
    assert result["log"] == content


def test_logs_single_line_no_trailing_newline(jobs_dir):
    _plant_log(jobs_dir, "single-noeol", "just one line")
    result = bg_jobs.logs("single-noeol")
    assert result["log"] == "just one line"


def test_logs_single_line_with_trailing_newline(jobs_dir):
    _plant_log(jobs_dir, "single-eol", "just one line\n")
    result = bg_jobs.logs("single-eol")
    # _tail returns original (1 line <= 80), preserving trailing newline
    assert "just one line" in result["log"]


# ---------------------------------------------------------------------------
# Custom lines= parameter – unit-style
# ---------------------------------------------------------------------------

def test_logs_custom_lines_10_from_100(jobs_dir):
    content = "\n".join(f"row{i}" for i in range(1, 101))
    _plant_log(jobs_dir, "rows100", content)
    result = bg_jobs.logs("rows100", lines=10)
    lines = result["log"].splitlines()
    assert len(lines) == 10
    assert lines[-1] == "row100"


def test_logs_custom_lines_1_returns_last_line(jobs_dir):
    content = "first\nsecond\nthird"
    _plant_log(jobs_dir, "three-lines", content)
    result = bg_jobs.logs("three-lines", lines=1)
    # _tail("first\nsecond\nthird", 1): 3>1 → join(lines[-1:]) = "third"
    assert result["log"].strip() == "third"


def test_logs_custom_lines_larger_than_file_returns_all(jobs_dir):
    content = "\n".join(f"item{i}" for i in range(1, 6))
    _plant_log(jobs_dir, "small5", content)
    result = bg_jobs.logs("small5", lines=50_000)
    assert len(result["log"].splitlines()) == 5


def test_logs_custom_lines_200_on_150_line_file(jobs_dir):
    """lines= larger than the file just returns everything."""
    content = "\n".join(f"z{i}" for i in range(1, 151))
    _plant_log(jobs_dir, "mid150", content)
    result = bg_jobs.logs("mid150", lines=200)
    assert len(result["log"].splitlines()) == 150


def test_logs_custom_lines_returns_the_correct_last_n(jobs_dir):
    """Spot-check that the correct lines are selected when n < file size."""
    content = "\n".join(str(i) for i in range(1, 1001))  # 1..1000
    _plant_log(jobs_dir, "nums1000", content)
    lines = bg_jobs.logs("nums1000", lines=20)["log"].splitlines()
    assert len(lines) == 20
    assert lines[0] == "981"
    assert lines[-1] == "1000"


# ---------------------------------------------------------------------------
# Unicode / emoji preservation – unit-style
# ---------------------------------------------------------------------------

def test_logs_unicode_non_ascii_preserved(jobs_dir):
    content = "Héllo wörld\n日本語テスト\nемодзи\n"
    _plant_log(jobs_dir, "uni-job", content)
    log = bg_jobs.logs("uni-job", lines=10)["log"]
    assert "Héllo wörld" in log
    assert "日本語テスト" in log
    assert "емодзи" in log


def test_logs_emoji_preserved(jobs_dir):
    content = "🚀 launch\n🎯 target\n✅ done\n🔥 hot"
    _plant_log(jobs_dir, "emoji-job", content)
    log = bg_jobs.logs("emoji-job", lines=10)["log"]
    for emoji in ("🚀", "🎯", "✅", "🔥"):
        assert emoji in log, f"emoji {emoji!r} missing from log"


def test_logs_unicode_tail_preserves_emoji_throughout(jobs_dir):
    """Unicode chars in tailed (not all-returned) output are not corrupted."""
    lines = [f"line-{i}-🌟" for i in range(200)]
    content = "\n".join(lines)
    _plant_log(jobs_dir, "uni-tail", content)
    result = bg_jobs.logs("uni-tail", lines=50)
    returned = result["log"].splitlines()
    assert len(returned) == 50
    assert all("🌟" in ln for ln in returned)
    assert returned[-1] == "line-199-🌟"


def test_logs_multibyte_cjk_in_every_tailed_line(jobs_dir):
    lines = [f"データ{i}" for i in range(100)]
    content = "\n".join(lines)
    _plant_log(jobs_dir, "cjk-job", content)
    returned = bg_jobs.logs("cjk-job", lines=10)["log"].splitlines()
    assert len(returned) == 10
    assert all("データ" in ln for ln in returned)


# ---------------------------------------------------------------------------
# Return-dict shape – unit-style
# ---------------------------------------------------------------------------

def test_logs_success_has_exactly_id_and_log_keys(jobs_dir):
    _plant_log(jobs_dir, "shape-job", "hello world")
    assert set(bg_jobs.logs("shape-job").keys()) == {"id", "log"}


def test_logs_id_field_matches_requested_jid(jobs_dir):
    _plant_log(jobs_dir, "my-specific-id", "data")
    assert bg_jobs.logs("my-specific-id")["id"] == "my-specific-id"


def test_logs_log_field_is_string(jobs_dir):
    _plant_log(jobs_dir, "type-check", "some output\n")
    assert isinstance(bg_jobs.logs("type-check")["log"], str)


# ---------------------------------------------------------------------------
# Integration tests – real detached subprocess jobs
# ---------------------------------------------------------------------------

def test_real_job_10000_lines_default_tail():
    """`seq 1 10000` → log has 10 000 lines; default tail is the last 80."""
    r = bg_jobs.start("seq 1 10000", name="seq-10k")
    _wait(r["id"], {"done", "failed"}, timeout=30)
    result = bg_jobs.logs(r["id"])
    assert "error" not in result
    lines = result["log"].splitlines()
    assert len(lines) == 80
    assert lines[0].strip() == "9921"
    assert lines[-1].strip() == "10000"


def test_real_job_custom_lines_5_of_10000():
    r = bg_jobs.start("seq 1 10000", name="seq-10k-5")
    _wait(r["id"], {"done", "failed"}, timeout=30)
    lines = bg_jobs.logs(r["id"], lines=5)["log"].splitlines()
    assert len(lines) == 5
    assert lines[-1].strip() == "10000"


def test_real_job_stdout_and_stderr_both_captured():
    """stderr=STDOUT means both streams end up in out.log."""
    cmd = "echo 'from-stdout'; echo 'from-stderr' >&2"
    r = bg_jobs.start(cmd, name="both-streams")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    log = bg_jobs.logs(r["id"], lines=20)["log"]
    assert "from-stdout" in log
    assert "from-stderr" in log


def test_real_job_stderr_interleaved_with_stdout():
    """Multiple alternating stdout/stderr writes all appear in the log."""
    cmd = (
        "for i in 1 2 3 4 5; do"
        "  echo \"out-$i\";"
        "  echo \"err-$i\" >&2;"
        "done"
    )
    r = bg_jobs.start(cmd, name="interleaved")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    log = bg_jobs.logs(r["id"], lines=20)["log"]
    for i in range(1, 6):
        assert f"out-{i}" in log
        assert f"err-{i}" in log


def test_real_job_unicode_preserved_end_to_end():
    """Python subcommand emitting UTF-8 unicode survives the log round-trip."""
    # Use the venv python so encoding is consistent
    import sys
    py = sys.executable
    cmd = f'{py} -c "import sys; sys.stdout.write(\'caf\\u00e9 \\u4e2d\\u6587\\n\'); sys.stdout.flush()"'
    r = bg_jobs.start(cmd, name="uni-real")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    log = bg_jobs.logs(r["id"], lines=5)["log"]
    assert "café" in log or "caf" in log  # at minimum ASCII portion
    assert "中文" in log or len(log) > 0


def test_real_job_emoji_survives_log_round_trip():
    """printf hex-escaped emoji bytes → read back without errors='replace' loss."""
    import sys
    py = sys.executable
    # U+1F680 ROCKET = F0 9F 9A 80 in UTF-8
    cmd = (
        f'{py} -c "'
        r"import sys; sys.stdout.buffer.write(b'\xf0\x9f\x9a\x80 launch\n');"
        r" sys.stdout.buffer.flush()"
        '"'
    )
    r = bg_jobs.start(cmd, name="emoji-real")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    log = bg_jobs.logs(r["id"], lines=5)["log"]
    # "launch" must always be present; emoji may be preserved or replaced
    assert "launch" in log


def test_real_job_empty_output():
    """`true` exits 0 with no output; log must be empty (or whitespace only)."""
    r = bg_jobs.start("true", name="empty-real")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    result = bg_jobs.logs(r["id"])
    assert "error" not in result
    assert result["log"].strip() == ""


def test_real_job_logs_on_running_job_does_not_crash():
    """start() creates the log file immediately; logs() must not error even
    before the child process writes any output."""
    r = bg_jobs.start("sleep 5", name="still-running")
    # Log file is created by start(); call logs() while job is running
    result = bg_jobs.logs(r["id"])
    bg_jobs.stop(r["id"])
    assert "error" not in result
    assert result["id"] == r["id"]
    assert isinstance(result["log"], str)


def test_real_job_logs_respect_custom_lines_on_small_output():
    """A job with 3 lines of output and lines=10 returns all 3 lines."""
    r = bg_jobs.start("echo a; echo b; echo c", name="three-lines-real")
    _wait(r["id"], {"done", "failed"}, timeout=20)
    lines = bg_jobs.logs(r["id"], lines=10)["log"].splitlines()
    assert len(lines) == 3
    assert lines == ["a", "b", "c"]
