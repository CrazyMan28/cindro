"""Failure self-healing loop (jarvis#67).

Every screen-mutating input tool (click / drag / type / key / scroll) runs
through `run()`:

  1. TRANSIENT RETRY — the action itself is retried (2 retries, backoff) when
     it raises, so a flaky injection path doesn't surface as a tool error.
  2. POST-ACTION VERIFICATION — a tiny screen hash is taken before and after
     the action. If the screen did not visibly change, the result says so
     (`self_heal.screen_changed=false` + a hint), so the model finds out
     IMMEDIATELY instead of assuming the click landed and building on air.
     The check re-samples for a short settle window before declaring "no
     change" (slow UIs get time to repaint).
  3. RE-PLAN ESCALATION — after 3 consecutive no-change actions in a session
     the hint escalates to a hard "STOP and re-plan" directive.

Every verification is appended to ~/.local/share/jarvis/selfheal_log.jsonl
for the Activity page / debugging.

Honesty note: "the screen changed" is a heuristic (32x32 grayscale delta).
It cannot know the change was the INTENDED one — that judgement stays with
the model; this loop just guarantees silent no-ops can't hide. Disable with
JARVIS_SELF_HEAL=0 (verification only; transient retries always apply).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Callable

_LOG_FILE = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "jarvis" / "selfheal_log.jsonl"

_RETRIES = 2                       # extra attempts after the first failure
_BACKOFF = (0.25, 0.6)             # seconds before retry 1 / retry 2
_SETTLE_STEPS = (0.35, 0.45, 0.5)  # post-action re-sample waits (~1.3s max)
_DIFF_THRESHOLD = 2.0              # mean |pixel delta| (0..255) to call "changed"
# A click often repaints only a small widget (a tab, a nav highlight). On a
# multi-monitor desktop that is a tiny share of the whole-desktop thumbnail, so the
# global MEAN stays under the threshold and a click that WORKED is reported as "no
# change" (then the model is told to STOP/RE-PLAN and flails). So a handful of
# strongly-changed cells counts as a change too.
_CELL_THRESHOLD = 12               # per-cell |delta| that counts as a "hot" cell
_MIN_HOT_CELLS = 2                 # this many hot cells => changed, whatever the mean
_THUMB_CAPTURE_WIDTH = 512         # capture width before the 32x32 reduction
_REPLAN_AFTER = 3                  # consecutive no-change actions -> re-plan

# Consecutive no-change counter, per target session ("active"/"agent"/...).
_misses: dict[str, int] = {}


def _enabled() -> bool:
    return os.environ.get("JARVIS_SELF_HEAL", "1") not in ("0", "false", "no")


def _thumb(which: str) -> bytes | None:
    """A tiny grayscale thumbnail of the target screen. None = can't capture."""
    try:
        from io import BytesIO

        from PIL import Image as PILImage

        from . import screen
        # take_screenshot() records LAST_SHOT, the origin/scale the mouse tools use to
        # turn the model's image coordinates into desktop pixels. This verification
        # frame is a whole-desktop thumbnail (on a 3-monitor desktop: 6400px wide ->
        # scale ~0.08); if it were left as LAST_SHOT, every image-space click AFTER
        # the first action would be mapped with the thumbnail's origin/scale and land
        # far from where the model aimed. Save and restore the model's reference.
        with screen._LOCK:
            saved = screen.LAST_SHOT
        try:
            png, _meta = screen.take_screenshot(
                max_width=_THUMB_CAPTURE_WIDTH, which=which)
        finally:
            with screen._LOCK:
                screen.LAST_SHOT = saved
        img = PILImage.open(BytesIO(png)).convert("L").resize((32, 32), PILImage.BOX)
        return img.tobytes()
    except Exception:
        return None


def _delta(a: bytes, b: bytes) -> float:
    """Change score between two thumbnails; >= _DIFF_THRESHOLD means "changed"."""
    if len(a) != len(b) or not a:
        return 255.0
    diffs = [abs(x - y) for x, y in zip(a, b)]
    mean = sum(diffs) / len(diffs)
    hot = sum(1 for d in diffs if d >= _CELL_THRESHOLD)
    if hot >= _MIN_HOT_CELLS:
        return max(mean, _DIFF_THRESHOLD)
    return mean


def _log(entry: dict) -> None:
    try:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def run(tool: str, which: str, action: Callable[[], Any],
        *, expect_change: bool = True) -> Any:
    """Execute `action` with transient retries + screen-change verification.

    Returns the action's result; when it is a dict, a `self_heal` block is
    added ({attempts, screen_changed, hint?}). Non-dict results pass through
    untouched (they still get retries).
    """
    verify = _enabled() and expect_change
    before = _thumb(which) if verify else None

    attempts = 0
    last_exc: Exception | None = None
    result: Any = None
    for attempt in range(1 + _RETRIES):
        attempts = attempt + 1
        try:
            result = action()
            last_exc = None
            break
        except Exception as exc:  # noqa: BLE001 — transient injection hiccups
            last_exc = exc
            if attempt < _RETRIES:
                time.sleep(_BACKOFF[min(attempt, len(_BACKOFF) - 1)])
    if last_exc is not None:
        _log({"ts": int(time.time() * 1000), "tool": tool, "which": which,
              "attempts": attempts, "error": str(last_exc)})
        raise last_exc

    changed: bool | None = None
    if verify and before is not None:
        for wait in _SETTLE_STEPS:
            time.sleep(wait)
            after = _thumb(which)
            if after is None:
                changed = None
                break
            if _delta(before, after) >= _DIFF_THRESHOLD:
                changed = True
                break
            changed = False

    key = which or "active"
    if changed is False:
        _misses[key] = _misses.get(key, 0) + 1
    elif changed is True:
        _misses[key] = 0

    _log({"ts": int(time.time() * 1000), "tool": tool, "which": which,
          "attempts": attempts, "screen_changed": changed,
          "session": os.environ.get("JARVIS_AGENT_SESSION", "")})

    if isinstance(result, dict):
        heal: dict[str, Any] = {"attempts": attempts}
        if changed is not None:
            heal["screen_changed"] = changed
        if changed is False:
            if _misses.get(key, 0) >= _REPLAN_AFTER:
                heal["hint"] = (
                    f"{_misses[key]} consecutive actions produced NO visible "
                    "screen change — STOP repeating yourself and RE-PLAN: take "
                    "a screenshot, confirm the target window is focused and "
                    "your coordinates are right, then try a different approach."
                )
            else:
                heal["hint"] = (
                    "the screen did not visibly change after this action — it "
                    "may have missed. Verify with a screenshot before building "
                    "on it."
                )
        result = {**result, "self_heal": heal}
    return result
