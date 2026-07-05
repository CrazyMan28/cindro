"""openai-whisper — external pip-installed CLI transcription engine.

Alternative to faster-whisper for boxes that already have the reference
`openai-whisper` package (and its `whisper` console script) installed.
`whisper-at` is a drop-in replacement CLI that additionally tags non-speech
audio events (music, applause, ...) — preferred automatically when present.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from computer_use_mcp.video import platform_info
from computer_use_mcp.video.types import AudioResult, AudioTag, TranscriptionSegment


def resolve_model(cfg: dict) -> str:
    """cfg["video_whisper_model"], resolving "auto" to a RAM-based pick."""
    model = cfg.get("video_whisper_model", "large-v3")
    if model == "auto":
        return platform_info.recommend_whisper_model()
    return model


def _find_binary() -> tuple[str, bool]:
    """Returns (executable, is_whisper_at). whisper-at is preferred when
    installed since it emits the same transcript plus audio-tag events."""
    exe = platform_info.check_command("whisper-at")
    if exe:
        return exe, True
    exe = platform_info.check_command("whisper")
    if exe:
        return exe, False
    raise FileNotFoundError("whisper (or whisper-at) not found on PATH")


def _parse_audio_tags(data: dict) -> list[AudioTag]:
    """whisper-at augments the JSON with non-speech tag events; its schema
    isn't pinned across versions, so this checks the common key names it has
    used and returns [] when none match — a missing/renamed key degrades to
    "no tags", it never breaks the (plain-CLI-compatible) transcript parse."""
    raw = data.get("audio_tags") or data.get("audio_events") or data.get("tags") or []
    tags: list[AudioTag] = []
    for item in raw:
        try:
            start = float(item.get("start", item.get("onset", 0.0)))
            end = float(item.get("end", item.get("offset", start)))
        except (TypeError, ValueError):
            continue
        label = str(item.get("tag") or item.get("label") or item.get("event") or "").strip()
        if label:
            tags.append(AudioTag(start=start, end=end, tag=label))
    return tags


def transcribe(wav_path: str, cfg: dict) -> AudioResult:
    """Run the whisper CLI against `wav_path` and parse its JSON sidecar.

    Deliberately no --language flag: the CLI has no "auto" literal, and
    omitting the flag entirely IS its auto-detect behavior.
    """
    exe, is_whisper_at = _find_binary()
    model = resolve_model(cfg)
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(
            [exe, wav_path, "--model", model, "--output_format", "json", "--output_dir", tmpdir],
            capture_output=True, text=True, check=True)
        stem = Path(wav_path).stem
        with open(Path(tmpdir) / f"{stem}.json", encoding="utf-8") as f:
            data = json.load(f)

    segments = [
        TranscriptionSegment(start=float(seg["start"]), end=float(seg["end"]),
                             text=seg["text"].strip())
        for seg in data.get("segments", [])
    ]
    audio_tags = _parse_audio_tags(data) if is_whisper_at else []
    return AudioResult(segments=segments, audio_tags=audio_tags, transcription_source="openai-whisper")


def probe() -> dict:
    """Availability check for video_setup: which binary (if any) and whether
    it's the audio-tag-capable whisper-at variant."""
    exe = platform_info.check_command("whisper-at")
    if exe:
        return {"available": True, "detail": f"whisper-at (audio-tag-capable) at {exe}"}
    exe = platform_info.check_command("whisper")
    if exe:
        return {"available": True, "detail": f"whisper at {exe} (no audio-tag support)"}
    return {"available": False, "detail": "whisper (or whisper-at) not found on PATH"}
