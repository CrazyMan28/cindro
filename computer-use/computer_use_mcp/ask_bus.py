"""Ask-the-user bus.

Lets the co-work model PAUSE and ask the user a question with tappable answers,
instead of guessing (e.g. "drive my REAL screen or your own agent desktop?").
The model calls the `ask_user` MCP tool; this module drops a question file the
Jarvis desktop/phone watches, then blocks until the user answers (or times out).

  question:  ~/.local/share/jarvis/questions/<qid>.json   {id, question, options, ts}
  answer:    ~/.local/share/jarvis/questions/<qid>.answer  {answer}

Both files are removed once consumed. Nothing here raises into the tool path —
a missing UI just yields a timeout the model can handle.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

_QDIR = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "questions"


def questions_dir() -> Path:
    override = os.environ.get("JARVIS_QUESTIONS_DIR")
    return Path(override) if override else _QDIR


def _qid() -> str:
    # session + monotonic-ish stamp; unique enough across concurrent agents.
    sid = os.environ.get("JARVIS_AGENT_SESSION", "host")
    return f"{sid}-{int(time.time() * 1000)}"


def ask(question: str, options: list[str] | None = None,
        timeout: float = 180.0) -> dict:
    """Post a question for the user and BLOCK until they answer or `timeout`.

    Returns {"answer": <str>, "answered": bool, "timed_out": bool}.
    """
    d = questions_dir()
    d.mkdir(parents=True, exist_ok=True)
    qid = _qid()
    qfile = d / f"{qid}.json"
    afile = d / f"{qid}.answer"
    opts = [str(o) for o in (options or [])]
    try:
        afile.unlink()
    except OSError:
        pass
    qfile.write_text(json.dumps({
        "id": qid, "question": str(question), "options": opts,
        "ts": round(time.time(), 3),
    }))

    deadline = time.time() + max(5.0, float(timeout))
    answer = None
    try:
        while time.time() < deadline:
            if afile.exists():
                try:
                    answer = json.loads(afile.read_text()).get("answer")
                except (OSError, ValueError):
                    answer = None
                break
            time.sleep(0.4)
    finally:
        for f in (qfile, afile):
            try:
                f.unlink()
            except OSError:
                pass

    if answer is None:
        return {"answer": "", "answered": False, "timed_out": True}
    return {"answer": str(answer), "answered": True, "timed_out": False}


# Free-text answers a user could reasonably type as "yes" to an Allow/Deny-
# style ask, beyond the exact button label. The Question card's buttons always
# send the option label VERBATIM (so a tap is a guaranteed exact match), but
# its custom-text box explicitly invites the user to type anything instead —
# and every caller of ask() used to do a strict `answer == "allow"` that
# silently treated "yes"/"sure"/"go ahead" as a DENIAL. Live-tested regression
# (2026-07-17): a user answered a tool-permission ask with "yes", got blocked
# anyway, retried, got blocked again — a confusing allow/deny loop with no
# visible cause. Deliberately a small, literal whitelist (not fuzzy NLU) so a
# genuinely ambiguous or off-topic reply still falls through to the safe
# "not approved" default instead of guessing wrong in the permissive
# direction.
_AFFIRMATIVE_WORDS = {
    "yes", "y", "yeah", "yea", "yep", "yup", "sure", "ok", "okay", "k",
    "allow", "allow it", "approve", "approved", "confirm", "confirmed",
    "go ahead", "do it", "please", "fine",
}


def is_affirmative(answer: str, yes_label: str = "allow") -> bool:
    """True if `answer` should count as approving an Allow/Deny-style ask.

    `yes_label` is the exact button label THIS ask used (e.g. "allow",
    "approve & build") — matched verbatim first (case-insensitive) so a
    button tap always works regardless of the whitelist below. Free text is
    then checked against a small set of common affirmatives, including a
    prefix match ("yes please", "sure, go ahead") so a short affirmative
    phrase still counts — but a longer sentence that merely CONTAINS a "yes"
    substring (e.g. "no, not that one") does NOT match, keeping the default
    fail-closed for anything actually ambiguous.
    """
    a = (answer or "").strip().lower()
    if not a:
        return False
    if a == yes_label.strip().lower():
        return True
    if a in _AFFIRMATIVE_WORDS:
        return True
    return any(a.startswith(w + " ") for w in
               ("yes", "yeah", "yep", "sure", "allow", "approve", "ok", "okay"))
