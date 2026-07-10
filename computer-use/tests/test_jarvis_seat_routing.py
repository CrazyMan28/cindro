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
    # Atomic click (refocus+motion+press+release in one DBus call) is the fork
    # path's click primitive; in-place clicks still fall back to button press.
    monkeypatch.setattr(inp.jarvis_seat, "click",
                        lambda b, gx, gy: seat.append(("click", b, gx, gy)))
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
    # Targeted click goes through the ATOMIC seat call (not separate press/release).
    assert ("click", "left", 10, 20) in seat
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


@pytest.fixture
def fork_keyboard(monkeypatch):
    """Fork path for the KEYBOARD ops: record jarvis-seat key calls, and fail the
    test loudly if the shared-seat ydotool path is touched (that path lands on
    the USER's focus — the input-mixing bug)."""
    seat: list[tuple] = []
    monkeypatch.setattr(inp.jarvis_seat, "available", lambda: True)
    monkeypatch.setattr(inp.jarvis_seat, "combo",
                        lambda resolved: seat.append(("combo", tuple(resolved))))
    monkeypatch.setattr(inp.jarvis_seat, "type_text",
                        lambda text: (seat.append(("type", text)), len(text))[1])
    monkeypatch.setattr(inp, "_ydotool",
                        lambda *a, **k: pytest.fail("ydotool (shared seat) used on fork path"))
    monkeypatch.setattr(inp, "_agent_keyboard_target", lambda: None)
    monkeypatch.setattr(inp.time, "sleep", lambda *_a, **_k: None)
    return seat


def test_key_press_combo_uses_jarvis_seat(fork_keyboard):
    out = inp.key_press("ctrl+v")
    assert fork_keyboard == [("combo", ("29:1", "47:1", "47:0", "29:0"))]
    assert out["seat"] == "jarvis"


def test_type_text_ascii_uses_jarvis_seat(fork_keyboard):
    out = inp.type_text("Hello World")
    assert fork_keyboard == [("type", "Hello World")]
    assert out["method"] == "jarvis-seat"


def test_available_retries_negative_probe(monkeypatch):
    """A failed probe must NOT be cached forever: the engine can start before the
    forked KWin registers the DBus iface, and a sticky False would exile all
    real-screen input to the shared seat (user/agent mixing) until restart."""
    from computer_use_mcp import jarvis_seat as js
    monkeypatch.setattr(js, "_available", False)
    monkeypatch.setattr(js, "_next_probe", 0.0)
    probes = []
    clock = {"t": 100.0}
    monkeypatch.setattr(js.time, "monotonic", lambda: clock["t"])

    monkeypatch.setattr(js, "_probe", lambda: probes.append("p") or False)
    assert js.available() is False
    assert js.available() is False           # within TTL: no second probe
    assert probes == ["p"]
    clock["t"] += js._PROBE_TTL + 1          # TTL elapsed: re-probes, fork now up
    monkeypatch.setattr(js, "_probe", lambda: probes.append("p") or True)
    assert js.available() is True
    assert probes == ["p", "p"]
    monkeypatch.setattr(js, "_probe", lambda: pytest.fail("positive result must stick"))
    assert js.available() is True
