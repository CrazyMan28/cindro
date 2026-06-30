"""Linux-runnable tests for the isolated Windows backend (Win32 absent).

Run:  env -u PYTHONPATH computer-use/.venv/bin/python -m pytest windows/engine/tests -q
"""

from __future__ import annotations

import importlib
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
