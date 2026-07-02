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
