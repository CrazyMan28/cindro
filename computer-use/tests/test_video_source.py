"""Upgrade (3): screen.video_source yields valid JPEG frames of the agent output.

Spins a real nested headless Sway (HEADLESS-1), points the engine at it via the
JARVIS_AGENT_* env vars, and grabs one frame. Skips gracefully (via the
nested_sway fixture) when headless sway / grim are unavailable.
"""

from __future__ import annotations

import io

import pytest

from computer_use_mcp import screen, session


@pytest.fixture
def agent_env(nested_sway, monkeypatch):
    monkeypatch.setenv(session.AGENT_WAYLAND_ENV, nested_sway["wayland_display"])
    monkeypatch.setenv(session.AGENT_SWAYSOCK_ENV, nested_sway["swaysock"])
    monkeypatch.setenv(session.AGENT_RUNTIME_DIR_ENV, nested_sway["runtime_dir"])
    session._CACHE = None
    # The screenshot-tool probe caches per kind across the process; clear it so
    # this fresh 'agent' kind is probed against the live nested compositor.
    screen._GRIM_WORKS.clear()
    yield
    session._CACHE = None


def _is_jpeg(data: bytes) -> bool:
    # JPEG SOI marker 0xFFD8 ... EOI 0xFFD9.
    return len(data) > 4 and data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"


def test_agent_session_detected_live(agent_env):
    info = session.get_session("agent")
    assert info.kind == "agent"
    assert info.outputs, "nested sway should report HEADLESS-1"
    assert any(o.name == "HEADLESS-1" for o in info.outputs)


def test_grab_jpeg_frame_is_valid_jpeg(agent_env):
    jpeg = screen.grab_jpeg_frame("agent", width=800, quality=70)
    assert _is_jpeg(jpeg)
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg))
    assert img.format == "JPEG"
    assert img.width <= 800


def test_video_source_yields_a_jpeg_frame(agent_env):
    gen = screen.video_source("agent", fps=8, width=640, quality=60, max_frames=1)
    frame = next(gen)
    assert _is_jpeg(frame)
    from PIL import Image
    assert Image.open(io.BytesIO(frame)).format == "JPEG"
    gen.close()
