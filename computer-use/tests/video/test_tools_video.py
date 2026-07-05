"""Tests for the video MCP tool surface (tools_video.register)."""

from __future__ import annotations

import asyncio
import json

import pytest
from mcp.server.fastmcp import FastMCP

from computer_use_mcp import tools_video
from computer_use_mcp.video.config import DEFAULTS
from computer_use_mcp.video.frames import calculate_auto_fps
from computer_use_mcp.video.types import AudioResult, TranscriptionSegment

EXPECTED_TOOLS = {"video_info", "video_setup", "video_configure",
                  "video_watch", "video_analyze", "video_detail"}


@pytest.fixture()
def mcp(monkeypatch):
    """Fresh FastMCP with the video tools registered; startup maintenance is
    stubbed so tests never sweep real caches or talk to jarvisd."""
    monkeypatch.setattr(tools_video, "_startup_maintenance", lambda: None)
    m = FastMCP("test-video")
    tools_video.register(m)
    return m


def _cfg(**overrides) -> dict:
    cfg = dict(DEFAULTS)
    cfg.update(overrides)
    return cfg


def _call(mcp_instance: FastMCP, tool: str, **kwargs):
    result = asyncio.run(mcp_instance.call_tool(tool, kwargs))
    return result[0] if isinstance(result, tuple) else result


def _texts(contents) -> list[str]:
    return [c.text for c in contents if getattr(c, "type", "") == "text"]


def _images(contents) -> list:
    return [c for c in contents if getattr(c, "type", "") == "image"]


# ---- derive_fps -----------------------------------------------------------

def test_derive_fps_explicit_number():
    assert tools_video.derive_fps("2", window_len=100, view_sample=0,
                                  has_segments=False) == 2.0


def test_derive_fps_view_sample_spreads_over_window():
    assert tools_video.derive_fps("auto", window_len=20, view_sample=10,
                                  has_segments=False) == 0.5


def test_derive_fps_plain_auto_uses_duration_table():
    assert tools_video.derive_fps("auto", window_len=100, view_sample=0,
                                  has_segments=False) == calculate_auto_fps(100)


def test_derive_fps_segments_ignore_view_sample_shortcut():
    assert tools_video.derive_fps("auto", window_len=20, view_sample=10,
                                  has_segments=True) == calculate_auto_fps(20)


def test_derive_fps_rejects_nonpositive():
    with pytest.raises(ValueError):
        tools_video.derive_fps("0", window_len=10, view_sample=0,
                               has_segments=False)


# ---- registration ---------------------------------------------------------

def test_all_six_tools_registered(mcp):
    names = {t.name for t in asyncio.run(mcp.list_tools())}
    assert names == EXPECTED_TOOLS


def test_every_tool_has_description(mcp):
    for t in asyncio.run(mcp.list_tools()):
        assert t.description and t.description.strip()


def test_register_schedules_startup_maintenance(monkeypatch):
    ran = []
    monkeypatch.setattr(tools_video, "_startup_maintenance",
                        lambda: ran.append(True))
    tools_video._MAINTENANCE_STARTED.clear()  # once-per-process guard
    m = FastMCP("test-video-seed")
    tools_video.register(m)
    for _ in range(50):
        if ran:
            break
        import time
        time.sleep(0.02)
    assert ran == [True]


# ---- video_watch ----------------------------------------------------------

def _canned_audio() -> AudioResult:
    return AudioResult(
        segments=[TranscriptionSegment(start=0.5, end=2.5, text="tone plays")],
        transcription_source="faster-whisper")


@pytest.fixture()
def watch_env(monkeypatch, tmp_path):
    """Deterministic settings + no real transcription + isolated data dir."""
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(tools_video.vconfig, "load_video_config",
                        lambda: _cfg())
    monkeypatch.setattr(tools_video.vtranscribe, "transcribe_video",
                        lambda *a, **kw: _canned_audio())
    return tmp_path


def test_video_watch_returns_header_and_images(mcp, watch_env, fixture_video):
    contents = _call(mcp, "video_watch", path=fixture_video, fps="1")
    header = json.loads(_texts(contents)[0])
    assert "error" not in header
    assert 5 <= header["frames_extracted"] <= 7
    assert header["audio"]["segments"][0]["text"] == "tone plays"
    assert header["metadata"]["has_audio"] is True
    images = _images(contents)
    assert len(images) == len(header["frames"])
    assert len(images) == header["frames_extracted"]


def test_video_watch_view_sample_limits_returned_images(mcp, watch_env,
                                                        fixture_video):
    contents = _call(mcp, "video_watch", path=fixture_video, fps="1",
                     view_sample=3)
    header = json.loads(_texts(contents)[0])
    assert len(_images(contents)) == 3
    assert len(header["frames"]) == 3
    assert header["frames_extracted"] >= 5  # extraction unaffected by sampling


def test_video_watch_skip_audio(mcp, watch_env, fixture_video):
    contents = _call(mcp, "video_watch", path=fixture_video, fps="1",
                     skip_audio=True)
    header = json.loads(_texts(contents)[0])
    assert header["audio"]["transcription_source"] == "none"


def test_video_watch_descriptions_mode(mcp, watch_env, fixture_video,
                                       monkeypatch):
    def fake_call(method, params=None, timeout=15.0):
        if method == "agents.create":
            return {}
        if method == "agents.dispatch":
            return {"session_id": "s1"}
        if method == "agents.result":
            return {"running": False,
                    "summary": "Frame at 00:00:00 — a red frame."}
        raise AssertionError(method)

    monkeypatch.setattr(tools_video.daemon_client, "call", fake_call)
    contents = _call(mcp, "video_watch", path=fixture_video, fps="1",
                     frame_mode="descriptions")
    texts = _texts(contents)
    assert len(_images(contents)) == 0
    assert any("Frame at 00:00:00" in t for t in texts)


def test_video_watch_descriptions_falls_back_to_images(mcp, watch_env,
                                                       fixture_video,
                                                       monkeypatch):
    monkeypatch.setattr(
        tools_video.daemon_client, "call",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("daemon down")))
    contents = _call(mcp, "video_watch", path=fixture_video, fps="1",
                     frame_mode="descriptions")
    header = json.loads(_texts(contents)[0])
    assert "describer_fallback" in header
    assert len(_images(contents)) == header["frames_extracted"]


def test_video_watch_bad_path_is_error_json(mcp, watch_env):
    contents = _call(mcp, "video_watch", path="/nope/missing.mp4")
    assert "error" in json.loads(_texts(contents)[0])


# ---- video_detail ---------------------------------------------------------

def test_video_detail_extract_then_view_exact_timestamps(mcp, fixture_video,
                                                         monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(tools_video.vconfig, "load_video_config",
                        lambda: _cfg(video_enable_index=True))
    segments = json.dumps([{"start": "00:00:00", "end": "00:00:04", "fps": 1}])
    contents = _call(mcp, "video_detail", path=fixture_video,
                     segments_json=segments, view_json='["00:00:02"]')
    header = json.loads(_texts(contents)[0])
    assert header["extracted"] >= 3
    assert [v["timestamp"] for v in header["viewed"]] == ["00:00:02"]
    assert len(_images(contents)) == 1

    # Second call: everything cached -> nothing re-extracted, view from cache.
    contents2 = _call(mcp, "video_detail", path=fixture_video,
                      segments_json=segments, view_json='["00:00:01"]')
    header2 = json.loads(_texts(contents2)[0])
    assert header2["extracted"] == 0
    assert [v["timestamp"] for v in header2["viewed"]] == ["00:00:01"]


# ---- video_configure / video_info ------------------------------------------

def test_video_configure_reads_and_patches(mcp, monkeypatch):
    state = _cfg()

    def fake_update(patch):
        state.update({k: v for k, v in patch.items() if k in DEFAULTS})
        return dict(state)

    monkeypatch.setattr(tools_video.vconfig, "load_video_config",
                        lambda: dict(state))
    monkeypatch.setattr(tools_video.vconfig, "update_video_config", fake_update)

    out = json.loads(_texts(_call(mcp, "video_configure"))[0])
    assert out["video_whisper_model"] == "large-v3"
    out = json.loads(_texts(_call(
        mcp, "video_configure",
        settings_json='{"video_whisper_model": "tiny"}'))[0])
    assert out["video_whisper_model"] == "tiny"


def test_video_info_local_file(mcp, fixture_video, monkeypatch):
    monkeypatch.setattr(tools_video.vconfig, "load_video_config",
                        lambda: _cfg())
    out = json.loads(_texts(_call(mcp, "video_info", path=fixture_video))[0])
    assert out["metadata"]["has_audio"] is True
    assert out["source"]["kind"] == "local"
