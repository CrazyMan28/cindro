"""Failure self-healing loop (jarvis#67): retries, verification, escalation."""

import pytest

from computer_use_mcp import selfheal


@pytest.fixture(autouse=True)
def _fast_and_isolated(monkeypatch, tmp_path):
    # No real sleeps, no real screen, no shared miss-counter, tmp log.
    monkeypatch.setattr(selfheal.time, "sleep", lambda s: None)
    monkeypatch.setattr(selfheal, "_LOG_FILE", tmp_path / "selfheal_log.jsonl")
    monkeypatch.setattr(selfheal, "_misses", {})
    monkeypatch.setenv("JARVIS_SELF_HEAL", "1")


def thumbs(monkeypatch, seq):
    """Feed _thumb() a fixed sequence of frames (last repeats forever)."""
    frames = list(seq)

    def fake(which):
        return frames.pop(0) if len(frames) > 1 else frames[0]
    monkeypatch.setattr(selfheal, "_thumb", fake)


A = bytes([0] * 1024)
B = bytes([50] * 1024)  # mean delta 50 >> threshold


def test_change_detected(monkeypatch):
    thumbs(monkeypatch, [A, B])
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert out["self_heal"]["screen_changed"] is True
    assert out["self_heal"]["attempts"] == 1
    assert "hint" not in out["self_heal"]


def test_no_change_gets_hint(monkeypatch):
    thumbs(monkeypatch, [A, A])
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert out["self_heal"]["screen_changed"] is False
    assert "did not visibly change" in out["self_heal"]["hint"]


def test_slow_ui_settles_into_change(monkeypatch):
    # first two post-samples identical, third differs -> changed (slow repaint)
    thumbs(monkeypatch, [A, A, A, B])
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert out["self_heal"]["screen_changed"] is True


def test_replan_escalation_after_three_misses(monkeypatch):
    thumbs(monkeypatch, [A])  # screen never changes
    for _ in range(2):
        out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
        assert "RE-PLAN" not in out["self_heal"]["hint"]
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert "RE-PLAN" in out["self_heal"]["hint"]
    # a successful change resets the counter
    thumbs(monkeypatch, [A, B])
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert out["self_heal"]["screen_changed"] is True
    thumbs(monkeypatch, [A])
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert "RE-PLAN" not in out["self_heal"]["hint"]


def test_transient_failure_retried(monkeypatch):
    thumbs(monkeypatch, [A, B])
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("injection hiccup")
        return {"ok": True}

    out = selfheal.run("key_press", "active", flaky)
    assert calls["n"] == 3
    assert out["self_heal"]["attempts"] == 3


def test_persistent_failure_raises(monkeypatch):
    thumbs(monkeypatch, [A])

    def broken():
        raise RuntimeError("dead")

    with pytest.raises(RuntimeError, match="dead"):
        selfheal.run("key_press", "active", broken)


def test_capture_failure_degrades_gracefully(monkeypatch):
    monkeypatch.setattr(selfheal, "_thumb", lambda which: None)
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert "screen_changed" not in out["self_heal"]  # unknown, not asserted


def test_disabled_skips_verification(monkeypatch):
    monkeypatch.setenv("JARVIS_SELF_HEAL", "0")
    called = {"n": 0}

    def fake(which):
        called["n"] += 1
        return A
    monkeypatch.setattr(selfheal, "_thumb", fake)
    out = selfheal.run("mouse_click", "active", lambda: {"ok": True})
    assert called["n"] == 0
    assert out["self_heal"] == {"attempts": 1}


def test_non_dict_results_pass_through(monkeypatch):
    thumbs(monkeypatch, [A, B])
    assert selfheal.run("mouse_click", "active", lambda: "plain") == "plain"


def test_decisions_logged(monkeypatch, tmp_path):
    import json as _json
    thumbs(monkeypatch, [A, A])
    selfheal.run("mouse_click", "agent", lambda: {"ok": True})
    rows = [_json.loads(l) for l in selfheal._LOG_FILE.read_text().splitlines()]
    assert rows[-1]["tool"] == "mouse_click"
    assert rows[-1]["screen_changed"] is False


# ---------------------------------------------------------------------------
# Multi-monitor regressions: the verification thumbnail must not hijack the
# image-coordinate reference, and a small repaint must still count as a change.
# ---------------------------------------------------------------------------
def test_thumb_preserves_last_shot(monkeypatch):
    """_thumb() goes through screen.take_screenshot, which records LAST_SHOT. That
    frame is a whole-desktop thumbnail; leaving it as LAST_SHOT made every later
    image-space click use the thumbnail's origin/scale and land far off-target."""
    import io

    from PIL import Image

    from computer_use_mcp import screen

    model_shot = {"origin": (0, 0), "scale": 0.6, "session_kind": "kde",
                  "image_w": 1536, "image_h": 864, "taken_at": 1.0}
    monkeypatch.setattr(screen, "LAST_SHOT", model_shot)

    def fake_take_screenshot(max_width=None, which="active", **_kw):
        buf = io.BytesIO()
        Image.new("RGB", (512, 140), (10, 20, 30)).save(buf, format="PNG")
        # what the real take_screenshot does: clobber LAST_SHOT with the thumb's
        with screen._LOCK:
            screen.LAST_SHOT = {"origin": (-1920, 0), "scale": 0.08,
                                "session_kind": "kde", "taken_at": 2.0}
        return buf.getvalue(), {}

    monkeypatch.setattr(screen, "take_screenshot", fake_take_screenshot)
    frame = selfheal._thumb("active")
    assert frame is not None and len(frame) == 1024
    assert screen.LAST_SHOT is model_shot


def test_small_repaint_counts_as_change():
    """A click that repaints a small widget barely moves the global mean on a
    wide multi-monitor thumbnail, but it did change the screen."""
    base = bytearray([100] * 1024)
    after = bytearray(base)
    for i in (10, 11, 42):                  # three cells flip strongly
        after[i] = 220
    mean_only = sum(abs(a - b) for a, b in zip(base, after)) / 1024
    assert mean_only < selfheal._DIFF_THRESHOLD       # the old rule says "no change"
    assert selfheal._delta(bytes(base), bytes(after)) >= selfheal._DIFF_THRESHOLD


def test_single_noisy_cell_is_not_a_change():
    base = bytearray([100] * 1024)
    after = bytearray(base)
    after[500] = 160                                   # one flickering cell (cursor/clock)
    assert selfheal._delta(bytes(base), bytes(after)) < selfheal._DIFF_THRESHOLD
