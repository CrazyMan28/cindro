"""Linux-runnable tests for the isolated Windows backend (Win32 absent).

Run:  env -u PYTHONPATH computer-use/.venv/bin/python -m pytest windows/engine/tests -q
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest

import backend_windows as bw


# ---------------------------------------------------------------------------
# (a) absolute-coordinate normalization math  (desktop px -> 0..65535)
# ---------------------------------------------------------------------------
def test_normalize_endpoints_single_monitor():
    virt = (0, 0, 1920, 1080)
    assert bw._normalize_abs(0, 0, virt) == (0, 0)
    # last pixel maps to exactly ABS_MAX
    assert bw._normalize_abs(1919, 1079, virt) == (65535, 65535)


def test_normalize_interior_matches_convention():
    virt = (0, 0, 1920, 1080)
    gx, gy = 960, 540
    expect = (
        round(gx * 65535 / 1919),
        round(gy * 65535 / 1079),
    )
    assert bw._normalize_abs(gx, gy, virt) == expect


def test_normalize_multi_monitor_negative_origin():
    # Virtual desktop spanning a left monitor at x=-1920: origin maps to 0,
    # far-right pixel to ABS_MAX.
    virt = (-1920, 0, 3840, 1080)
    assert bw._normalize_abs(-1920, 0, virt) == (0, 0)
    assert bw._normalize_abs(1919, 1079, virt) == (65535, 65535)


def test_normalize_clamps_out_of_range():
    virt = (0, 0, 1920, 1080)
    assert bw._normalize_abs(-50, -50, virt) == (0, 0)
    assert bw._normalize_abs(9999, 9999, virt) == (65535, 65535)


# ---------------------------------------------------------------------------
# (b) VK-table completeness  (every input._resolve_combo key has a VK mapping)
# ---------------------------------------------------------------------------
def test_vk_table_covers_every_engine_key_name():
    from computer_use_mcp import input as engine_input

    missing = sorted(set(engine_input._KEY_CODES) - set(bw._VK_CODES))
    assert not missing, f"VK table missing key names: {missing}"


def test_resolve_vk_parses_combo_and_rejects_unknown():
    vks = bw._resolve_vk("ctrl+shift+t")
    assert [vk for vk, _ext in vks] == [0x11, 0x10, 0x54]  # Ctrl, Shift, T
    with pytest.raises(ValueError):
        bw._resolve_vk("ctrl+nope")
    with pytest.raises(ValueError):
        bw._resolve_vk("")


# ---------------------------------------------------------------------------
# (c) import backend_windows works on Linux with NO Win32 present
# ---------------------------------------------------------------------------
def test_import_succeeds_without_win32():
    # Re-import cleanly and confirm Win32-only deps were not eagerly imported.
    mod = importlib.reload(bw)
    assert mod is not None
    assert "mss" not in sys.modules, "mss must be imported lazily, not at module load"
    # The ctypes Win32 layer must refuse to build off-Windows (proves the guard).
    if sys.platform != "win32":
        with pytest.raises(RuntimeError):
            mod._winapi()


def test_get_session_agent_is_linux_only():
    with pytest.raises(RuntimeError):
        bw.get_session("agent")


def test_compositor_hint_is_windows():
    assert bw.compositor_hint() == "windows"


# ---------------------------------------------------------------------------
# (d) the server_windows monkeypatch rebinds the engine primitives to bw
# ---------------------------------------------------------------------------
def test_monkeypatch_rebinds_engine_primitives():
    import server_windows  # applies patches at import
    server_windows.apply_patches()  # idempotent

    from computer_use_mcp import input as _i, screen as _s, session as _se

    # identity: the engine modules now expose the bw functions
    assert _i.move is bw.move
    assert _i.click is bw.click
    assert _i.drag is bw.drag
    assert _i.scroll is bw.scroll
    assert _i.key_press is bw.key_press
    assert _i.type_text is bw.type_text
    assert _s.take_screenshot is bw.take_screenshot
    assert _s.grab_jpeg_frame is bw.grab_jpeg_frame
    assert _se.detect is bw.detect
    assert _se.get_session is bw.get_session
    assert _se.compositor_hint is bw.compositor_hint


def test_patched_move_routes_through_backend(monkeypatch):
    """End-to-end: the PATCHED engine input.move runs bw.move, which maps via the
    (unchanged) screen.map_to_desktop + bw.get_session, then emits the absolute
    move. Win32 internals are mocked, so this runs on Linux."""
    import server_windows  # ensures patches are applied
    server_windows.apply_patches()

    from computer_use_mcp import input as _i

    # Fake a single 1920x1080 monitor so map_to_desktop validates the point.
    monkeypatch.setattr(
        bw, "_enumerate_monitors",
        lambda: [bw.Output("DISPLAY1", 0, 0, 1920, 1080)],
    )
    bw.detect(refresh=True)  # rebuild the session cache with the fake monitor

    # Capture the absolute-move emit instead of calling SendInput.
    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(bw, "_mouse_move_abs", lambda gx, gy: calls.append((gx, gy)))

    gx, gy = _i.move(100, 200, coord_space="desktop")
    assert (gx, gy) == (100, 200)
    assert calls == [(100, 200)]


# ---------------------------------------------------------------------------
# (e) mouse ops publish to agent_bus, tagged like the Linux real-screen path
#     (jarvis#<windows-driving-overlay>: backend_windows never published, so
#     the desktop sidebar's "Jarvis is using your computer" banner + glowing
#     cursor overlay never auto-armed on Windows). Mirrors
#     computer-use/tests/test_agent_pointer_bus.py's contract exactly.
# ---------------------------------------------------------------------------
def _lines(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


@pytest.fixture
def bus_file(tmp_path, monkeypatch):
    path = tmp_path / "agent_pointer.jsonl"
    monkeypatch.setenv("JARVIS_AGENT_POINTER_LOG", str(path))
    return path


@pytest.fixture
def fake_win32(monkeypatch):
    """Stub every Win32 touchpoint (SendInput ctypes layer + absolute-move
    emit) so click/drag/scroll run hermetically off-Windows; map_to_desktop
    is pinned to identity (desktop coord_space) like the Linux bus tests."""
    fake = type("FakeWin32", (), {
        "MOUSEEVENTF_LEFTDOWN": 1, "MOUSEEVENTF_LEFTUP": 2,
        "MOUSEEVENTF_RIGHTDOWN": 3, "MOUSEEVENTF_RIGHTUP": 4,
        "MOUSEEVENTF_MIDDLEDOWN": 5, "MOUSEEVENTF_MIDDLEUP": 6,
        "MOUSEEVENTF_WHEEL": 7, "MOUSEEVENTF_HWHEEL": 8,
    })()
    monkeypatch.setattr(bw, "_winapi", lambda: fake)
    monkeypatch.setattr(bw, "_mouse_input", lambda *a, **k: None)
    monkeypatch.setattr(bw, "_send", lambda *a, **k: None)
    monkeypatch.setattr(bw, "_mouse_move_abs", lambda gx, gy: None)
    monkeypatch.setattr(
        bw._screen, "map_to_desktop",
        lambda x, y, cs="image", which="active": (int(x), int(y)),
    )
    monkeypatch.setattr(bw.time, "sleep", lambda *_a, **_k: None)


def test_move_publishes_real_session_event(bus_file, fake_win32):
    bw.move(5, 7, coord_space="desktop", which="active")
    events = _lines(bus_file)
    assert len(events) == 1
    assert events[0]["kind"] == "move"
    assert events[0]["session"] == "real"
    assert events[0]["x"] == 5 and events[0]["y"] == 7


def test_click_publishes_move_and_click_events(bus_file, fake_win32):
    bw.click(100, 200, button="left", coord_space="desktop", which="active")
    events = _lines(bus_file)
    kinds = [e["kind"] for e in events]
    assert "move" in kinds and "click" in kinds
    click_ev = next(e for e in events if e["kind"] == "click")
    assert click_ev["session"] == "real"
    assert click_ev["button"] == "left"
    assert click_ev["x"] == 100 and click_ev["y"] == 200


def test_click_in_place_publishes_nothing(bus_file, fake_win32):
    """No x/y => no desktop_pos => nothing to publish (matches Linux: a
    click-in-place has no meaningful position for the overlay to draw at)."""
    bw.click(button="left")
    assert _lines(bus_file) == []


def test_drag_emits_down_drag_up_tagged_real(bus_file, fake_win32):
    bw.drag(0, 0, 100, 100, coord_space="desktop", which="active", steps=4)
    events = _lines(bus_file)
    kinds = [e["kind"] for e in events]
    assert kinds[0] == "down"
    assert "drag" in kinds
    assert kinds[-1] == "up"
    assert all(e["session"] == "real" for e in events)


def test_scroll_publishes_scroll_event_tagged_real(bus_file, fake_win32):
    bw.scroll(amount=1, direction="down", x=10, y=20, coord_space="desktop",
              which="active")
    events = _lines(bus_file)
    scroll_ev = next(e for e in events if e["kind"] == "scroll")
    assert scroll_ev["session"] == "real"
    assert scroll_ev["button"] == "down"


def test_agent_which_tags_session_agent_not_real(bus_file, fake_win32):
    """which='agent' (the v2 isolated-sandbox desktop, jarvis#75-adjacent)
    tags events 'agent' so the real-screen take-over banner does NOT auto-arm
    for actions confined to the isolated agent desktop."""
    bw.move(1, 2, coord_space="desktop", which="agent")
    events = _lines(bus_file)
    assert events[0]["session"] == "agent"


def test_patched_click_routes_through_backend_and_publishes(bus_file, fake_win32):
    """End-to-end through the monkeypatch server_windows installs (mirrors
    test_patched_move_routes_through_backend but for click, which is the path
    an actual computer_use_click tool call takes on Windows)."""
    import server_windows
    server_windows.apply_patches()

    from computer_use_mcp import input as _i

    _i.click(50, 60, button="left", coord_space="desktop")
    events = _lines(bus_file)
    assert any(e["kind"] == "click" and e["session"] == "real" for e in events)


# ---------------------------------------------------------------------------
# (f) _mouse_move_abs verifies the cursor actually landed and falls back to
#     SetCursorPos on a mismatch -- SendInput has been observed (live, on a
#     field machine) to report success while the cursor never moves, which is
#     dangerous because click()/drag() fire button-down/up as a SEPARATE
#     zero-relative SendInput call that lands wherever the cursor CURRENTLY
#     is: a silently-swallowed move makes the click land at the OLD position
#     instead of the intended one ("clicks land somewhere else").
# ---------------------------------------------------------------------------
def _stub_winapi(monkeypatch):
    """A minimal fake _winapi() covering exactly what _mouse_move_abs touches
    directly (the flag constants + user32.SetCursorPos); _mouse_input/_send
    are separately no-op'd so no real ctypes structures are needed."""
    import types

    calls: list[tuple[int, int]] = []
    fake = types.SimpleNamespace(
        MOUSEEVENTF_MOVE=0, MOUSEEVENTF_ABSOLUTE=0, MOUSEEVENTF_VIRTUALDESK=0,
        user32=types.SimpleNamespace(
            SetCursorPos=lambda x, y: calls.append((x, y)) or True,
        ),
    )
    monkeypatch.setattr(bw, "_winapi", lambda: fake)
    monkeypatch.setattr(bw, "_normalize_abs", lambda gx, gy: (0, 0))
    monkeypatch.setattr(bw, "_mouse_input", lambda *a, **k: None)
    monkeypatch.setattr(bw, "_send", lambda *a, **k: None)
    return calls


def test_mouse_move_abs_falls_back_to_setcursorpos_on_mismatch(monkeypatch):
    calls = _stub_winapi(monkeypatch)
    monkeypatch.setattr(bw, "_cursor_pos", lambda: (0, 0))  # SendInput no-op'd
    bw._mouse_move_abs(500, 400)
    assert calls == [(500, 400)]


def test_mouse_move_abs_skips_fallback_when_cursor_landed(monkeypatch):
    calls = _stub_winapi(monkeypatch)
    monkeypatch.setattr(bw, "_cursor_pos", lambda: (500, 400))  # landed correctly
    bw._mouse_move_abs(500, 400)
    assert calls == []


def test_mouse_move_abs_skips_fallback_within_tolerance(monkeypatch):
    calls = _stub_winapi(monkeypatch)
    monkeypatch.setattr(bw, "_cursor_pos", lambda: (501, 399))  # off by <=2px
    bw._mouse_move_abs(500, 400)
    assert calls == []


def test_mouse_move_abs_skips_fallback_when_cursor_pos_unavailable(monkeypatch):
    calls = _stub_winapi(monkeypatch)
    monkeypatch.setattr(bw, "_cursor_pos", lambda: None)  # GetCursorPos failed
    bw._mouse_move_abs(500, 400)
    assert calls == []
