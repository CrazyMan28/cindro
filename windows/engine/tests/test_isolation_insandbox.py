"""Windows v2 isolation -- Gap #1: the which='agent' in-sandbox alias.

These run on LINUX (Win32 / mss absent): the only Windows-specific bit exercised
is ``backend_windows.get_session`` / ``in_sandbox`` (pure ``os.environ`` logic)
plus the capture routing, with mss/Win32 mocked out. The behaviour is gated on
the ``JARVIS_AGENT_INSANDBOX`` env flag that ``bootstrap.ps1`` sets INSIDE the
isolated agent desktop, so every test drives that flag via monkeypatch and never
leaks it.

Run:  env -u PYTHONPATH computer-use/.venv/bin/python -m pytest windows/engine/tests -q
"""

from __future__ import annotations

import pytest

import backend_windows as bw


# ---------------------------------------------------------------------------
# in_sandbox() truthiness -- the env flag bootstrap.ps1 sets inside the box.
# ---------------------------------------------------------------------------
def test_in_sandbox_false_when_unset(monkeypatch):
    monkeypatch.delenv("JARVIS_AGENT_INSANDBOX", raising=False)
    assert bw.in_sandbox() is False


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on", "anything"])
def test_in_sandbox_true_for_truthy(monkeypatch, val):
    monkeypatch.setenv("JARVIS_AGENT_INSANDBOX", val)
    assert bw.in_sandbox() is True


@pytest.mark.parametrize("val", ["", "0", "false", "False", "no", "off", "  "])
def test_in_sandbox_false_for_falsy(monkeypatch, val):
    monkeypatch.setenv("JARVIS_AGENT_INSANDBOX", val)
    assert bw.in_sandbox() is False


# ---------------------------------------------------------------------------
# get_session('agent') -- raises OUTSIDE the box (v1), aliases INSIDE it (v2).
# ---------------------------------------------------------------------------
def test_get_session_agent_raises_without_flag(monkeypatch):
    monkeypatch.delenv("JARVIS_AGENT_INSANDBOX", raising=False)
    with pytest.raises(RuntimeError):
        bw.get_session("agent")


def test_get_session_agent_aliases_active_in_sandbox(monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_INSANDBOX", "1")
    # Fake a single 1920x1080 monitor so the session has outputs without mss.
    monkeypatch.setattr(
        bw, "_enumerate_monitors",
        lambda: [bw.Output("DISPLAY1", 0, 0, 1920, 1080)],
    )
    active = bw.detect(refresh=True)["active"]
    agent = bw.get_session("agent")
    # The in-sandbox 'agent' session IS this (the only) desktop.
    assert agent.kind == active.kind == "windows"
    assert [o.as_dict() for o in agent.outputs] == [o.as_dict() for o in active.outputs]
    assert agent.bbox == active.bbox


# ---------------------------------------------------------------------------
# Capture routing -- grab_jpeg_frame / take_screenshot accept which='agent'
# once the in-sandbox flag is set (they resolve through get_session(which)).
# ---------------------------------------------------------------------------
def _fake_grab(monkeypatch):
    """Mock mss capture: return a small solid RGB image for any rect."""
    Image = pytest.importorskip("PIL.Image")
    monkeypatch.setattr(
        bw, "_enumerate_monitors",
        lambda: [bw.Output("DISPLAY1", 0, 0, 1920, 1080)],
    )
    bw.detect(refresh=True)
    monkeypatch.setattr(
        bw, "_grab_region",
        lambda rect: Image.new("RGB", (rect.w, rect.h), (16, 24, 32)),
    )


def test_grab_jpeg_frame_agent_routes_in_sandbox(monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_INSANDBOX", "1")
    _fake_grab(monkeypatch)
    jpeg = bw.grab_jpeg_frame("agent", width=320, quality=60)
    assert jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9"  # SOI..EOI


def test_grab_jpeg_frame_agent_raises_without_flag(monkeypatch):
    monkeypatch.delenv("JARVIS_AGENT_INSANDBOX", raising=False)
    _fake_grab(monkeypatch)
    with pytest.raises(RuntimeError):
        bw.grab_jpeg_frame("agent", width=320)


def test_take_screenshot_agent_routes_in_sandbox(monkeypatch):
    monkeypatch.setenv("JARVIS_AGENT_INSANDBOX", "1")
    _fake_grab(monkeypatch)
    png, meta = bw.take_screenshot(which="agent", max_width=320)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert meta["session"] == "windows"
