"""Forked-KWin routing: when the multi-seat KWin fork is running (jarvis_seat
.available() is True), REAL-screen input must go through the agent's own `jarvis`
seat (its own pointer + keyboard, no mixing with the user) instead of the shared
uinput pointer — while STILL publishing the global position to the overlay bus so
the blue glowing cursor tracks the agent.

These tests fake `jarvis_seat.available()` True and record which backend each op
hits; the uinput emitters must NOT fire on the fork path.
"""

from __future__ import annotations

import json

import pytest

from computer_use_mcp import input as inp


@pytest.fixture
def fork_running(tmp_path, monkeypatch):
    """Simulate the forked KWin: jarvis_seat available; record its calls and prove
    the uinput path is NOT taken."""
    monkeypatch.setenv("JARVIS_AGENT_POINTER_LOG", str(tmp_path / "p.jsonl"))
    seat: list[tuple] = []
    uinput: list[tuple] = []
    monkeypatch.setattr(inp.jarvis_seat, "available", lambda: True)
    monkeypatch.setattr(inp.jarvis_seat, "move",
                        lambda gx, gy: seat.append(("move", gx, gy)))
    monkeypatch.setattr(inp.jarvis_seat, "button",
                        lambda b, p: seat.append(("button", b, p)))
    monkeypatch.setattr(inp.jarvis_seat, "axis",
                        lambda o, d, v: seat.append(("axis", o, d, v)))
    # uinput emitters must stay silent on the fork path.
    monkeypatch.setattr(inp, "_emit_abs", lambda gx, gy: uinput.append(("abs", gx, gy)))
    monkeypatch.setattr(inp, "_emit_button", lambda b, s: uinput.append(("btn", b, s)))
    monkeypatch.setattr(inp.screen, "map_to_desktop",
                        lambda x, y, cs="image", which="active": (int(x), int(y)))
    monkeypatch.setattr(inp, "load_config", lambda: {"scroll_invert": False})
    monkeypatch.setattr(inp.time, "sleep", lambda *_a, **_k: None)
    return seat, uinput, tmp_path / "p.jsonl"


def _events(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def test_real_move_uses_jarvis_seat(fork_running):
    seat, uinput, busp = fork_running
    inp.move(640, 480, coord_space="desktop", which="active")
    assert ("move", 640, 480) in seat
    assert uinput == []                      # shared seat NOT touched
    evs = _events(busp)
    assert evs[-1]["session"] == "real" and evs[-1]["kind"] == "move"


def test_real_click_uses_jarvis_seat(fork_running):
    seat, uinput, busp = fork_running
    inp.click(10, 20, button="left", coord_space="desktop", which="active")
    assert ("button", "left", True) in seat and ("button", "left", False) in seat
    assert all(c[0] != "btn" for c in uinput)
    assert any(e["kind"] == "click" and e["session"] == "real" for e in _events(busp))


def test_real_drag_uses_jarvis_seat(fork_running):
    seat, uinput, busp = fork_running
    inp.drag(0, 0, 40, 40, coord_space="desktop", which="active", steps=4)
    assert ("button", "left", True) in seat and ("button", "left", False) in seat
    assert sum(1 for c in seat if c[0] == "move") >= 4   # path streamed on the seat
    assert uinput == []
    kinds = [e["kind"] for e in _events(busp)]
    assert kinds[0] == "down" and kinds[-1] == "up" and "drag" in kinds


def test_real_scroll_uses_jarvis_axis(fork_running):
    seat, uinput, busp = fork_running
    inp.scroll(amount=3, direction="down", x=5, y=5,
               coord_space="desktop", which="active")
    axes = [c for c in seat if c[0] == "axis"]
    assert len(axes) == 3                    # one axis event per notch
    assert axes[0][1] == 0 and axes[0][2] > 0  # vertical, +ve = down
    assert any(e["kind"] == "scroll" and e["session"] == "real" for e in _events(busp))
