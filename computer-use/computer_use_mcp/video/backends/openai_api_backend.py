"""OpenAI Whisper API cloud backend — speech transcription only.

whisper-1 has no notion of non-speech audio tagging, so audio_tags is always
empty for this backend (Gemini's backend is the one that fills it in).

Jarvis stores UI-entered API keys daemon-side and write-only, so cloud video
backends read the conventional provider env var directly — export
OPENAI_API_KEY to pick this backend. openai is a heavy optional dependency,
imported lazily inside functions so this module imports cleanly without it
installed (frozen Windows build, CI).
"""

from __future__ import annotations

import os
from typing import Any

from computer_use_mcp.video.types import AudioResult, TranscriptionSegment

_MISSING_KEY_MESSAGE = (
    "OPENAI_API_KEY is not set — export OPENAI_API_KEY with an OpenAI API key "
    "to use the openai-api video backend."
)


def probe() -> dict:
    """Availability check for video_setup: env key set + SDK importable. No network."""
    if not os.environ.get("OPENAI_API_KEY"):
        return {"available": False, "detail": "OPENAI_API_KEY not set"}
    try:
        import openai  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — missing/broken SDK is not fatal here
        return {"available": False, "detail": f"openai not importable: {exc}"}
    return {"available": True, "detail": "OPENAI_API_KEY set; openai importable"}


def _client():
    """An openai.OpenAI() client, or a RuntimeError telling the user what to export."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(_MISSING_KEY_MESSAGE)
    import openai

    return openai.OpenAI(api_key=api_key)


def _field(obj: Any, key: str) -> Any:
    """Normalize attr-style (SDK response objects) and dict-style (plain JSON,
    test fakes) access — the SDK's verbose_json responses have been observed
    as both across versions."""
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def transcribe(wav_path: str, cfg: dict) -> AudioResult:  # noqa: ARG001 — cfg unused, kept for protocol parity
    """Send `wav_path` to whisper-1; timestamps come back relative to the WAV."""
    client = _client()
    with open(wav_path, "rb") as fh:
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=fh,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    raw_segments = _field(response, "segments") or []
    segments = [
        TranscriptionSegment(
            start=float(_field(item, "start")),
            end=float(_field(item, "end")),
            text=str(_field(item, "text")),
        )
        for item in raw_segments
    ]
    return AudioResult(segments=segments, audio_tags=[], transcription_source="openai-api")
