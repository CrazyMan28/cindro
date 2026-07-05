"""Unit tests for the transcription orchestrator (no ffmpeg, no real backends)."""

from __future__ import annotations

import sys
from types import SimpleNamespace

from computer_use_mcp.video.backends import transcribe
from computer_use_mcp.video.config import DEFAULTS
from computer_use_mcp.video.types import (
    AudioResult,
    ChunkPlan,
    ChunkWarning,
    TranscriptionSegment,
)


def _cfg(**overrides) -> dict:
    cfg = dict(DEFAULTS)
    cfg.update(overrides)
    return cfg


def _fake_extract(path, out_wav, *, start=0.0, end=None):
    with open(out_wav, "wb") as f:
        f.write(b"RIFFfake")
    return out_wav


def _segment_result(text: str = "hello", *, start: float = 0.0,
                    end: float = 1.0, source: str = "faster-whisper") -> AudioResult:
    return AudioResult(
        segments=[TranscriptionSegment(start=start, end=end, text=text)],
        transcription_source=source)


def test_no_audio_returns_none_result():
    result = transcribe.transcribe_video(
        "/nonexistent.mp4", duration=10.0, has_audio=False, cfg=_cfg())
    assert result.transcription_source == "none"
    assert result.segments == []


def test_short_path_single_extract_and_reanchor(monkeypatch):
    calls = []
    monkeypatch.setattr(transcribe.audio, "extract_audio",
                        lambda *a, **kw: calls.append((a, kw)) or _fake_extract(*a, **kw))
    fake_backend = SimpleNamespace(transcribe=lambda wav, cfg: _segment_result())
    monkeypatch.setattr(transcribe, "_pick_backend", lambda cfg: fake_backend)

    result = transcribe.transcribe_video(
        "/v.mp4", duration=100.0, has_audio=True, cfg=_cfg(), start=30.0, end=90.0)

    assert len(calls) == 1
    assert calls[0][1]["start"] == 30.0 and calls[0][1]["end"] == 90.0
    # 0-based backend timestamps re-anchored by the window start.
    assert result.segments[0].start == 30.0 and result.segments[0].end == 31.0
    assert result.transcription_source == "faster-whisper"


def test_chunked_merge_reanchor_and_failure_placeholder(monkeypatch):
    monkeypatch.setattr(transcribe.audio, "extract_audio", _fake_extract)
    plan = [ChunkPlan(index=0, start=0.0, end=10.0),
            ChunkPlan(index=1, start=10.0, end=20.0),
            ChunkPlan(index=2, start=20.0, end=30.0)]
    planner_warnings = [ChunkWarning(kind="hard_cut", chunk_index=1, message="w")]
    monkeypatch.setattr(transcribe.audio_chunker, "plan_chunks",
                        lambda *a, **kw: (list(plan), list(planner_warnings)))

    attempts: dict[str, int] = {}

    def fake_transcribe(wav, cfg):
        attempts[wav] = attempts.get(wav, 0) + 1
        if "chunk_001" in wav:
            raise RuntimeError("boom")
        return _segment_result()

    monkeypatch.setattr(transcribe, "_pick_backend",
                        lambda cfg: SimpleNamespace(transcribe=fake_transcribe))

    result = transcribe.transcribe_video(
        "/v.mp4", duration=100.0, has_audio=True,
        cfg=_cfg(video_audio_chunk_trigger_seconds=60,
                 video_audio_chunk_size_seconds=60),
        start=5.0, end=95.0)

    # 90s window > 60s trigger -> the (faked) chunked path ran.
    starts = [s.start for s in result.segments]
    assert starts == sorted(starts)
    # Chunk 0 re-anchored to window start 5.0; chunk 2 to 5+20.
    assert starts[0] == 5.0
    assert any(s.start == 25.0 for s in result.segments)
    # Chunk 1 failed twice -> placeholder spanning its absolute window.
    placeholder = [s for s in result.segments
                   if s.text == transcribe._CHUNK_FAILURE_TEXT]
    assert len(placeholder) == 1
    assert placeholder[0].start == 15.0 and placeholder[0].end == 25.0
    failed_wavs = [w for w in attempts if "chunk_001" in w]
    assert attempts[failed_wavs[0]] == 2  # exactly one retry
    kinds = {w.kind for w in result.warnings}
    assert kinds == {"hard_cut", "chunk_failed"}
    assert result.transcription_source == "faster-whisper"


def test_backend_pick_routes_to_gemini(monkeypatch):
    seen = {}

    def fake_transcribe(wav, cfg):
        seen["hit"] = True
        return _segment_result(source="gemini-api")

    fake = SimpleNamespace(transcribe=fake_transcribe)
    # Patch BOTH the module cache and the parent-package attribute: once any
    # earlier test has imported the real module, `from backends import
    # gemini_api_backend` resolves via the package attribute, not sys.modules.
    monkeypatch.setitem(
        sys.modules, "computer_use_mcp.video.backends.gemini_api_backend", fake)
    import computer_use_mcp.video.backends as backends_pkg
    if hasattr(backends_pkg, "gemini_api_backend"):
        monkeypatch.setattr(backends_pkg, "gemini_api_backend", fake)
    monkeypatch.setattr(transcribe.audio, "extract_audio", _fake_extract)

    result = transcribe.transcribe_video(
        "/v.mp4", duration=10.0, has_audio=True,
        cfg=_cfg(video_backend="gemini-api"))
    assert seen.get("hit") is True
    assert result.transcription_source == "gemini-api"


def test_unknown_engine_degrades_to_none():
    result = transcribe.transcribe_video(
        "/v.mp4", duration=10.0, has_audio=True,
        cfg=_cfg(video_whisper_engine="not-an-engine"))
    assert result.transcription_source == "none"
