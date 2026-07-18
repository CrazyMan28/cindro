"""ask_bus.is_affirmative() — no prior dedicated test file existed (flagged by
/code-review high on PR #132) despite this function gating 5 call sites
(policy.py's gate/_phone_gate/_scan_command/_scan_tui_layout, and
present_plan's Approve & Build check)."""

import pytest

from computer_use_mcp import ask_bus


@pytest.mark.parametrize("answer,yes_label,expected", [
    # Exact button-label match always wins, whatever the label text is.
    ("allow", "allow", True),
    ("Approve & Build", "approve & build", True),
    ("ALLOW", "allow", True),
    # Whitelisted bare affirmatives.
    ("yes", "allow", True),
    ("sure", "allow", True),
    ("go ahead", "allow", True),
    # Trailing punctuation around a bare whitelisted word still counts.
    ("yes!", "allow", True),
    ("sure.", "allow", True),
    ("ok,", "allow", True),
    # A clear denial/off-topic reply stays fail-closed.
    ("no", "allow", False),
    ("deny", "allow", False),
    ("", "allow", False),
])
def test_is_affirmative_basic_cases(answer, yes_label, expected):
    assert ask_bus.is_affirmative(answer, yes_label) is expected


@pytest.mark.parametrize("revision_note", [
    # Code-review finding (PR #132): these all start with an affirmative word
    # but are genuine "Request Changes" revision notes, not approvals. A
    # naive prefix match (`answer.startswith("yeah ")`) misclassified these
    # as "Approve & Build", silently discarding the user's requested edit.
    "yeah but shorten the intro",
    "ok change the deploy target",
    "sure, drop step 3",
    "yes but skip the migration",
    "approve after you fix the typo",
])
def test_is_affirmative_does_not_match_a_longer_sentence(revision_note):
    assert ask_bus.is_affirmative(revision_note, "approve & build") is False
