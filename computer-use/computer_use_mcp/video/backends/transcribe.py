"""Transcription orchestrator — the ONE entry point the tool layer calls.

Hides three concerns from tools_video:
  1. backend pick (local engine trio vs the two cloud APIs, from settings),
  2. long-audio chunking (silence-aligned plans, parallel per-chunk transcribe
     with one retry, placeholder segments for chunks that fail twice),
  3. timeline re-anchoring (backends see a WAV that starts at 0; every
     timestamp leaving this module is on the ORIGINAL video timeline).

detect_silences() reports original-timeline stamps (its -ss sits after -i)
while plan_chunks() reasons in window-relative [0, window_len] — the provider
wrapper below shifts silences into window coordinates so the two agree.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from types import ModuleType

from computer_use_mcp.video import audio, audio_chunker, backends
from computer_use_mcp.video.timestamps import shift_audio_result
from computer_use_mcp.video.types import (
    AudioResult,
    ChunkPlan,
    ChunkWarning,
    Interval,
    TranscriptionSegment,
)

_CHUNK_FAILURE_TEXT = "[transcription failed for this segment]"


def _pick_backend(cfg: dict) -> ModuleType:
    """Backend module for the configured video_backend/engine (lazy imports)."""
    backend = str(cfg.get("video_backend", "local"))
    if backend == "gemini-api":
        from computer_use_mcp.video.backends import gemini_api_backend
        return gemini_api_backend
    if backend == "openai-api":
        from computer_use_mcp.video.backends import openai_api_backend
        return openai_api_backend
    return backends.get_local_backend(
        str(cfg.get("video_whisper_engine", "faster-whisper")))


def _window_silence_provider(path: str, start: float, window_end: float):
    """make_silence_provider shifted into window-relative coordinates."""
    raw = audio_chunker.make_silence_provider(path, start=start, end=window_end)

    def provider(loose: bool) -> list[Interval]:
        return [Interval(start=i.start - start, end=i.end - start)
                for i in raw(loose)]

    return provider


def transcribe_video(
    video_path: str,
    *,
    duration: float,
    has_audio: bool,
    cfg: dict,
    start: float = 0.0,
    end: float | None = None,
    work_dir: str | None = None,
) -> AudioResult:
    """Transcribe [start, end or duration] of `video_path` per settings."""
    if not has_audio:
        return AudioResult(transcription_source="none")
    try:
        backend = _pick_backend(cfg)
    except Exception:  # noqa: BLE001 — unknown engine/backend: no transcript
        return AudioResult(transcription_source="none")

    window_end = end if end is not None else duration
    window_len = window_end - start
    if window_len <= 0:
        return AudioResult(transcription_source="none")

    trigger = float(cfg.get("video_audio_chunk_trigger_seconds", 1200))
    tmp = tempfile.mkdtemp(prefix="video-transcribe-", dir=work_dir)
    try:
        if window_len <= trigger:
            wav = audio.extract_audio(
                video_path, os.path.join(tmp, "audio.wav"), start=start,
                end=end)
            return shift_audio_result(backend.transcribe(wav, cfg), start)
        return _transcribe_chunked(
            video_path, backend, cfg, tmp,
            start=start, window_end=window_end, window_len=window_len)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _transcribe_chunked(
    video_path: str,
    backend: ModuleType,
    cfg: dict,
    tmp: str,
    *,
    start: float,
    window_end: float,
    window_len: float,
) -> AudioResult:
    chunks, warnings = audio_chunker.plan_chunks(
        window_len,
        chunk_size=float(cfg.get("video_audio_chunk_size_seconds", 600)),
        trigger=float(cfg.get("video_audio_chunk_trigger_seconds", 1200)),
        silence_provider=_window_silence_provider(video_path, start, window_end),
    )

    # Cloud calls are network-bound (3 in flight is fine); the local engines
    # share one in-process model, so keep it at 2 to bound memory while the
    # GIL-releasing inference still overlaps with the next chunk's ffmpeg.
    cloud = str(cfg.get("video_backend")) in ("gemini-api", "openai-api")
    max_workers = 3 if cloud else 2

    def work(chunk: ChunkPlan) -> AudioResult:
        wav = audio.extract_audio(
            video_path, os.path.join(tmp, f"chunk_{chunk.index:03d}.wav"),
            start=start + chunk.start, end=start + chunk.end)
        last: Exception | None = None
        for _attempt in range(2):  # one retry per chunk
            try:
                return shift_audio_result(backend.transcribe(wav, cfg),
                                          start + chunk.start)
            except Exception as exc:  # noqa: BLE001
                last = exc
        raise last  # type: ignore[misc]  # loop always ran

    results: dict[int, AudioResult] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(work, c): c for c in chunks}
        for fut in as_completed(futures):
            chunk = futures[fut]
            try:
                results[chunk.index] = fut.result()
            except Exception as exc:  # noqa: BLE001 — placeholder, keep going
                warnings.append(ChunkWarning(
                    kind="chunk_failed", chunk_index=chunk.index,
                    message=f"chunk {chunk.index} failed after retry: {exc}"))
                results[chunk.index] = AudioResult(segments=[
                    TranscriptionSegment(start=start + chunk.start,
                                         end=start + chunk.end,
                                         text=_CHUNK_FAILURE_TEXT)])

    merged = AudioResult(warnings=warnings)
    for index in sorted(results):
        part = results[index]
        merged.segments.extend(part.segments)
        merged.audio_tags.extend(part.audio_tags)
        merged.warnings.extend(part.warnings)
        if not merged.transcription_source and part.transcription_source:
            merged.transcription_source = part.transcription_source
    merged.segments.sort(key=lambda s: s.start)
    merged.audio_tags.sort(key=lambda t: t.start)
    if not merged.transcription_source:
        merged.transcription_source = "none"
    return merged
