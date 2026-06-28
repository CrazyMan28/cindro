"""Comprehensive regex-focused tests for bg_jobs.monitor().

Coverage:
  - until_regex match on stdout
  - until_regex match on stderr (stdout+stderr combined in out)
  - multi-line output + DOTALL inline flag (?s)
  - state="done" and matched=True set together on hit
  - pattern needing multiple checks before matching (counter-file trick)
  - checks counter tracked correctly across loops
  - anchored regex (^ start, $ end)
  - ^EXACT$ does NOT match when pattern is embedded in a longer line
  - alternation (foo|bar), first branch and second branch
  - named-capture group (?P<name>...)
  - case-insensitive via inline flag (?i)
  - default regex IS case-sensitive (no match → expire)
  - digit escape \\d+
  - whitespace escape \\s+
  - quantifier + literal pattern (e.g. [A-Z]{3,}-[0-9]+)
  - expired state when pattern never matches → matched stays False
  - substring match anywhere in long line (re.search, not fullmatch)
  - no until_regex + until_exit=0 still trips matched=True
  - stderr-only pattern in combined stdout+stderr stream
"""

from __future__ import annotations

import time

import pytest

from computer_use_mcp import bg_jobs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait(jid: str, states: set, timeout: float = 20.0) -> dict:
    """Poll status until the job reaches one of *states* or *timeout* expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = bg_jobs.status(jid)
        if m.get("state") in states:
            return m
        time.sleep(0.15)
    return bg_jobs.status(jid)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _hermetic(tmp_path, monkeypatch):
    """Redirect all job state to an isolated tmp dir; suppress daemon wakes.

    JARVIS_BG_JOBS_DIR is inherited by the detached runner subprocess (it calls
    env = dict(os.environ) before Popen), so the runner writes state to the
    same tmp tree.  Deleting JARVIS_AGENT_SESSION makes the wake call a no-op
    (session_id == "" → _wake returns immediately), so jarvisd is not needed.
    """
    monkeypatch.setenv("JARVIS_BG_JOBS_DIR", str(tmp_path / "bg"))
    monkeypatch.delenv("JARVIS_AGENT_SESSION", raising=False)
    yield


# ---------------------------------------------------------------------------
# 1. Stdout regex match → state=done, matched=True
# ---------------------------------------------------------------------------

def test_stdout_regex_match_state_done_and_matched():
    """Command emits READY to stdout; monitor must finish with state=done and matched=True."""
    r = bg_jobs.monitor(
        "echo READY",
        interval_sec=2,
        until_regex="READY",
        name="stdout-basic",
    )
    m = _wait(r["id"], {"done", "expired", "failed"})
    assert m["state"] == "done", f"unexpected state: {m['state']}"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 2. Stderr regex match
# ---------------------------------------------------------------------------

def test_stderr_regex_match():
    """Pattern appears on stderr.

    _run_monitor concatenates r.stdout + r.stderr into *out*, so a pattern
    that only appears on stderr must still trigger a match.
    """
    r = bg_jobs.monitor(
        "echo ERROR_CODE >&2",
        interval_sec=2,
        until_regex="ERROR_CODE",
        name="stderr-match",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_stderr_only_combined_stream():
    """stdout='ignore this', stderr='TRIGGER'; TRIGGER must still match."""
    r = bg_jobs.monitor(
        'echo "ignore this"; echo "TRIGGER" >&2',
        interval_sec=2,
        until_regex=r"TRIGGER",
        name="combined-streams",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 3. Multi-line output + special-regex patterns
# ---------------------------------------------------------------------------

def test_multiline_dotall_inline_flag():
    """(?s) inline flag makes . cross newline boundaries in multi-line output."""
    r = bg_jobs.monitor(
        'printf "BEGIN\\nMIDDLE\\nEND\\n"',
        interval_sec=2,
        until_regex=r"(?s)BEGIN.*END",
        name="multiline-dotall",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_multiline_regex_last_line_match():
    """Regex anchored to the final token in multi-line output."""
    r = bg_jobs.monitor(
        'printf "alpha\\nbeta\\ngamma\\n"',
        interval_sec=2,
        until_regex=r"gamma",
        name="multiline-last-line",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_multiline_pattern_not_in_single_line_fails(tmp_path):
    """Pattern requires two tokens that only co-exist across lines via (?s).

    Without (?s), the . won't cross \\n, so 'START.+FINISH' won't match when
    START and FINISH are on different lines — monitor must expire.
    """
    r = bg_jobs.monitor(
        'printf "START\\nFINISH\\n"',
        interval_sec=2,
        until_regex=r"START.+FINISH",   # no (?s) — . won't cross \n
        max_checks=2,
        name="dotall-missing-expire",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "expired"
    assert m.get("matched") is False


# ---------------------------------------------------------------------------
# 4. Several checks before matching (counter-file trick)
# ---------------------------------------------------------------------------

def test_several_checks_before_match(tmp_path):
    """Condition only trips on the 3rd check.

    Uses a file-based counter so successive invocations of the shell command
    produce incrementing output.  Validates that the monitor loops correctly
    and that checks >= 3 in the final metadata.
    """
    counter = tmp_path / "cnt.txt"
    counter.write_text("0")
    cmd = (
        f"c=$(cat {counter}); "
        f"c=$((c + 1)); "
        f"echo $c > {counter}; "
        f"[ $c -ge 3 ] && echo DONE || echo NOT_YET"
    )
    r = bg_jobs.monitor(
        cmd,
        interval_sec=2,
        until_regex="DONE",
        max_checks=10,
        name="multi-check",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=30)
    assert m["state"] == "done"
    assert m["matched"] is True
    assert m["checks"] >= 3, f"expected checks >= 3, got {m['checks']}"


def test_checks_counter_exact_at_match(tmp_path):
    """Condition trips on exactly check 2; final metadata must show checks==2."""
    counter = tmp_path / "cnt2.txt"
    counter.write_text("0")
    cmd = (
        f"c=$(cat {counter}); "
        f"c=$((c + 1)); "
        f"echo $c > {counter}; "
        f"[ $c -ge 2 ] && echo TARGET || echo NOPE"
    )
    r = bg_jobs.monitor(
        cmd,
        interval_sec=2,
        until_regex="TARGET",
        max_checks=5,
        name="check-count-exact",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=25)
    assert m["state"] == "done"
    assert m["checks"] == 2, f"expected checks==2, got {m['checks']}"


def test_four_checks_before_match(tmp_path):
    """Condition trips on check 4; validates the counter increments through four loops."""
    counter = tmp_path / "cnt4.txt"
    counter.write_text("0")
    cmd = (
        f"c=$(cat {counter}); "
        f"c=$((c + 1)); "
        f"echo $c > {counter}; "
        f"[ $c -ge 4 ] && echo HIT || echo MISS"
    )
    r = bg_jobs.monitor(
        cmd,
        interval_sec=2,
        until_regex="HIT",
        max_checks=10,
        name="four-checks",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=35)
    assert m["state"] == "done"
    assert m["matched"] is True
    assert m["checks"] >= 4


# ---------------------------------------------------------------------------
# 5. Anchored regex
# ---------------------------------------------------------------------------

def test_anchored_start_of_string():
    """^BEGIN matches multi-line output whose first token is BEGIN.

    re.search without MULTILINE: ^ anchors to the very start of the string.
    printf emits BEGIN first, so ^BEGIN must match.
    """
    r = bg_jobs.monitor(
        'printf "BEGIN\\nSECOND\\n"',
        interval_sec=2,
        until_regex=r"^BEGIN",
        name="anchor-start",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_anchored_end_of_line():
    """Regex ending with $ matches 'status: ok' where 'ok' is the last word."""
    r = bg_jobs.monitor(
        'echo "status: ok"',
        interval_sec=2,
        until_regex=r"ok$",
        name="anchor-end",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_anchored_exact_line_no_match_expires():
    """^EXACT$ must NOT match 'not EXACT here'; monitor expires after max_checks."""
    r = bg_jobs.monitor(
        'echo "not EXACT here"',
        interval_sec=2,
        until_regex=r"^EXACT$",
        max_checks=2,
        name="anchor-no-match",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "expired"
    assert m.get("matched") is False


def test_anchored_exact_line_matches():
    """^EXACT$ matches when the output line is exactly 'EXACT'."""
    r = bg_jobs.monitor(
        'echo "EXACT"',
        interval_sec=2,
        until_regex=r"^EXACT$",
        name="anchor-exact-match",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 6. Grouped / alternation regex
# ---------------------------------------------------------------------------

def test_alternation_first_branch():
    """(foo|bar) matches when output contains 'foo' (first branch)."""
    r = bg_jobs.monitor(
        'echo "result: foo"',
        interval_sec=2,
        until_regex=r"(foo|bar)",
        name="alt-foo",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_alternation_second_branch():
    """(foo|bar) matches when output contains 'bar' (second branch)."""
    r = bg_jobs.monitor(
        'echo "result: bar"',
        interval_sec=2,
        until_regex=r"(foo|bar)",
        name="alt-bar",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_named_group_regex():
    """Named-capture group (?P<status>PASS|FAIL) still produces a regex match."""
    r = bg_jobs.monitor(
        'echo "test result: PASS"',
        interval_sec=2,
        until_regex=r"(?P<status>PASS|FAIL)",
        name="named-group",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_alternation_neither_branch_expires():
    """Neither 'foo' nor 'bar' in output → (foo|bar) never matches → expire."""
    r = bg_jobs.monitor(
        'echo "result: baz"',
        interval_sec=2,
        until_regex=r"^(foo|bar)$",
        max_checks=2,
        name="alt-no-match",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "expired"
    assert m.get("matched") is False


# ---------------------------------------------------------------------------
# 7. Case sensitivity — inline (?i) flag
# ---------------------------------------------------------------------------

def test_case_insensitive_inline_flag():
    """(?i) makes lowercase 'ready' match uppercase 'READY' in output."""
    r = bg_jobs.monitor(
        'echo "READY"',
        interval_sec=2,
        until_regex=r"(?i)ready",
        name="case-insensitive",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_case_sensitive_lowercase_pattern_no_match():
    """Without (?i), 'ready' (lower) must NOT match 'READY' (upper) → expire."""
    r = bg_jobs.monitor(
        'echo "READY"',
        interval_sec=2,
        until_regex=r"ready",      # lowercase, no flag → case-sensitive
        max_checks=2,
        name="case-sensitive-no-match",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "expired"
    assert m.get("matched") is False


# ---------------------------------------------------------------------------
# 8. Special escape sequences
# ---------------------------------------------------------------------------

def test_digit_escape_sequence():
    r"""'\d+' matches a string of digits in the output."""
    r = bg_jobs.monitor(
        'echo "12345"',
        interval_sec=2,
        until_regex=r"\d+",
        name="digit-seq",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_whitespace_escape_sequence():
    r"""'hello\s+world' matches 'hello world' (single space counts as \s)."""
    r = bg_jobs.monitor(
        'echo "hello world"',
        interval_sec=2,
        until_regex=r"hello\s+world",
        name="whitespace-seq",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_quantifier_plus_literal():
    """[A-Z]{3,}-[0-9]+ matches a JIRA-style ticket token like 'TICKET-42'."""
    r = bg_jobs.monitor(
        'echo "Deploying TICKET-42 now"',
        interval_sec=2,
        until_regex=r"[A-Z]{3,}-[0-9]+",
        name="quantifier-literal",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 9. No-match expiry — matched stays False
# ---------------------------------------------------------------------------

def test_no_match_expires_matched_stays_false():
    """Pattern never appears; after max_checks=2 state is 'expired' and matched is False."""
    r = bg_jobs.monitor(
        'echo "hello world"',
        interval_sec=2,
        until_regex=r"NEVER_IN_OUTPUT_XYZ123",
        max_checks=2,
        name="no-match-expire",
    )
    m = _wait(r["id"], {"done", "expired"}, timeout=15)
    assert m["state"] == "expired"
    assert m.get("matched") is False


# ---------------------------------------------------------------------------
# 10. Substring search (re.search, not fullmatch)
# ---------------------------------------------------------------------------

def test_regex_substring_match_in_long_line():
    """Short regex must match anywhere in a long line (re.search semantics)."""
    r = bg_jobs.monitor(
        'echo "aaaa bbb ccc TARGET ddd eee ffff"',
        interval_sec=2,
        until_regex=r"TARGET",
        name="substr-match",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 11. No until_regex — until_exit=0 still trips matched=True
# ---------------------------------------------------------------------------

def test_no_regex_until_exit_zero():
    """until_regex='' + until_exit=0: 'true' exits 0, so matched must be True.

    With an empty until_regex, rx is None and regex matching is skipped.
    The until_exit branch then sets matched=True because returncode==0.
    """
    r = bg_jobs.monitor(
        "true",
        interval_sec=2,
        until_regex="",
        until_exit=0,
        name="exit-zero",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


def test_no_regex_until_exit_nonzero():
    """until_exit=1 with a command that exits 1 → matched=True via exit-code path."""
    r = bg_jobs.monitor(
        "exit 1",
        interval_sec=2,
        until_regex="",
        until_exit=1,
        name="exit-one",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 12. Regex with lookahead
# ---------------------------------------------------------------------------

def test_positive_lookahead_regex():
    """Lookahead (?=.*DONE) verifies pattern without consuming characters."""
    r = bg_jobs.monitor(
        'echo "status DONE ok"',
        interval_sec=2,
        until_regex=r"status(?=.*DONE)",
        name="lookahead",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["matched"] is True


# ---------------------------------------------------------------------------
# 13. Checks still increment when max_checks not set and regex matches immediately
# ---------------------------------------------------------------------------

def test_checks_is_one_on_immediate_match():
    """When the regex matches on the very first check, checks must equal 1."""
    r = bg_jobs.monitor(
        "echo IMMEDIATE",
        interval_sec=2,
        until_regex="IMMEDIATE",
        name="immediate-match",
    )
    m = _wait(r["id"], {"done", "expired"})
    assert m["state"] == "done"
    assert m["checks"] == 1, f"expected checks==1, got {m['checks']}"
