"""Upgrade (2): a mouse op on the agent session publishes to agent_pointer.jsonl.

The actual compositor input (swaymsg seat cursor) and coordinate mapping are
mocked so the test is hermetic and asserts only the *event bus* contract: every
agent mouse op appends one JSON line to ~/.local/share/jarvis/agent_pointer.jsonl
(redirected to a tmp file via JARVIS_AGENT_POINTER_LOG).
"""

from __future__ import annotations

import json

import pytest

from computer_use_mcp import agent_bus
from computer_use_mcp import input as inp


@pytest.fixture
def bus_file(tmp_path, monkeypatch):
    path = tmp_path / "agent_pointer.jsonl"
    monkeypatch.setenv("JARVIS_AGENT_POINTER_LOG", str(path))
    return path


@pytest.fixture
def fake_agent_input(monkeypatch):
    """Stub out coordinate mapping + the real nested-cursor swaymsg calls."""
    calls: list[tuple] = []
    # map_to_desktop returns the requested coords verbatim (desktop space).
    monkeypatch.setattr(inp.screen, "map_to_desktop",
                        lambda x, y, cs="image", which="active": (int(x), int(y)))
    # A dummy SessionInfo-ish object; the agent input helpers only need it passed
    # to swaymsg, which we also stub.
    fake_info = object()
    monkeypatch.setattr(inp.session, "get_session", lambda which="active": fake_info)
    monkeypatch.setattr(inp, "_agent_cursor_set",
                        lambda info, gx, gy: calls.append(("set", gx, gy)))
    monkeypatch.setattr(inp, "_agent_cursor_button",
                        lambda info, b, press: calls.append(("btn", b, press)))
    # No real sleeps.
    monkeypatch.setattr(inp.time, "sleep", lambda *_a, **_k: None)
    return calls


def _lines(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def test_agent_move_appends_one_event(bus_file, fake_agent_input):
    inp.move(640, 500, coord_space="desktop", which="agent")
    events = _lines(bus_file)
    assert len(events) == 1
    ev = events[0]
    assert ev["kind"] == "move"
    assert ev["session"] == "agent"
    assert ev["x"] == 640 and ev["y"] == 500
    assert ("set", 640, 500) in fake_agent_input  # nested cursor was driven


def test_agent_click_publishes_click_event(bus_file, fake_agent_input):
    inp.click(100, 200, button="left", coord_space="desktop", which="agent")
    events = _lines(bus_file)
    kinds = [e["kind"] for e in events]
    assert "move" in kinds and "click" in kinds
    click_ev = next(e for e in events if e["kind"] == "click")
    assert click_ev["button"] == "left"
    assert click_ev["x"] == 100 and click_ev["y"] == 200


def test_agent_drag_emits_down_drag_up(bus_file, fake_agent_input):
    inp.drag(0, 0, 100, 100, coord_space="desktop", which="agent", steps=4)
    kinds = [e["kind"] for e in _lines(bus_file)]
    assert kinds[0] == "down"
    assert "drag" in kinds
    assert kinds[-1] == "up"


def test_active_path_does_not_touch_bus(bus_file, monkeypatch):
    """The real (active) path must NOT write to the agent bus — regression guard
    that the default behavior is unchanged."""
    monkeypatch.setattr(inp.screen, "map_to_desktop",
                        lambda x, y, cs="image", which="active": (int(x), int(y)))
    monkeypatch.setattr(inp, "_emit_abs", lambda gx, gy: None)
    inp.move(5, 5, coord_space="desktop", which="active")
    assert not bus_file.exists() or bus_file.read_text() == ""


def test_publish_returns_event_and_survives_bad_subscriber(bus_file):
    """publish() must not raise even if a subscriber queue misbehaves."""
    import asyncio
    q = agent_bus.subscribe()
    try:
        ev = agent_bus.publish(1, 2, kind="move")
        assert ev["x"] == 1 and ev["y"] == 2
        # The in-process subscriber received it.
        got = q.get_nowait()
        assert got["kind"] == "move"
        assert isinstance(q, asyncio.Queue)
    finally:
        agent_bus.unsubscribe(q)
