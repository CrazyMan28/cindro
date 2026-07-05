"""Gemini API cloud backend — speech transcription AND non-speech audio
tagging (music, applause, silence, sfx) via the google-genai SDK.

Jarvis stores UI-entered API keys daemon-side and write-only (the desktop/TUI
Settings page never reads secrets back out), so cloud video backends read the
conventional provider env var directly instead — export GEMINI_API_KEY to
pick this backend. google.genai is a heavy optional dependency, so it's
imported lazily inside functions; this module must import cleanly on a box
that never installed it (frozen Windows build, CI).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from computer_use_mcp.video.types import AudioResult, AudioTag, TranscriptionSegment

_MISSING_KEY_MESSAGE = (
    "GEMINI_API_KEY is not set — export GEMINI_API_KEY with a Gemini API key "
    "to use the gemini-api video backend."
)

_PROMPT = (
    "Transcribe all speech in this audio, with start/end timestamps in seconds "
    "on the audio's own timeline. Also identify non-speech audio events (music, "
    "applause, silence, sfx) with their own start/end timestamps. Respond with "
    "JSON only, no prose and no markdown code fences, matching this shape: "
    '{"transcription": [{"start": <seconds>, "end": <seconds>, "text": <string>}], '
    '"audio_tags": [{"start": <seconds>, "end": <seconds>, "tag": <string>}]}'
)

# Schema for the structured-output config path. Newer/older SDK builds spell
# this config key differently (response_schema vs response_json_schema) —
# _generate() below tries one and falls back to a plain-JSON prompt on
# TypeError rather than chasing every SDK version's exact field name.
_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "transcription": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "text": {"type": "string"},
                },
                "required": ["start", "end", "text"],
            },
        },
        "audio_tags": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "tag": {"type": "string"},
                },
                "required": ["start", "end", "tag"],
            },
        },
    },
    "required": ["transcription", "audio_tags"],
}


def probe() -> dict:
    """Availability check for video_setup: env key set + SDK importable. No network."""
    if not os.environ.get("GEMINI_API_KEY"):
        return {"available": False, "detail": "GEMINI_API_KEY not set"}
    try:
        from google import genai  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — missing/broken SDK is not fatal here
        return {"available": False, "detail": f"google-genai not importable: {exc}"}
    return {"available": True, "detail": "GEMINI_API_KEY set; google-genai importable"}


def _client():
    """A genai.Client(), or a RuntimeError telling the user what env var to set.

    The SDK itself reads GEMINI_API_KEY from the environment, but its own
    error when the key is missing is an opaque auth failure — check first so
    the message actually tells the user what to do.
    """
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError(_MISSING_KEY_MESSAGE)
    from google import genai

    return genai.Client()


def wait_for_file_active(client, name: str, *, timeout: float = 120.0, interval: float = 2.0,
                          sleeper=time.sleep, clock=time.monotonic):
    """Poll client.files.get(name=...) every `interval`s until state ACTIVE.

    Raises RuntimeError on FAILED and TimeoutError once `timeout` seconds have
    elapsed without reaching ACTIVE. `sleeper`/`clock` are injectable so tests
    can drive this without real wall-clock waits.
    """
    deadline = clock() + timeout
    while True:
        uploaded_file = client.files.get(name=name)
        state = getattr(uploaded_file, "state", None)
        state = getattr(state, "name", state)  # SDK enum -> plain str, if wrapped
        if state == "ACTIVE":
            return uploaded_file
        if state == "FAILED":
            raise RuntimeError(f"Gemini file upload failed for {name!r}")
        if clock() >= deadline:
            raise TimeoutError(f"Gemini file {name!r} did not become ACTIVE within {timeout}s")
        sleeper(interval)


def _strip_code_fence(text: str) -> str:
    """Strip a ```json / ``` wrapper some models add despite being told not to."""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    return stripped.strip()


def _generate(client, uploaded_file, cfg: dict) -> dict:
    """Ask Gemini to transcribe + tag; returns the parsed JSON payload.

    Tries the structured response_schema config first; some SDK builds raise
    TypeError on that config shape, so this falls back to a plain-JSON prompt
    and json.loads(response.text) — defensive against SDK version drift.
    """
    model = cfg.get("video_gemini_model", "gemini-3-flash-preview")
    max_tokens = cfg.get("video_gemini_max_output_tokens", 65536)
    try:
        response = client.models.generate_content(
            model=model,
            contents=[uploaded_file, _PROMPT],
            config={
                "response_mime_type": "application/json",
                "response_schema": _RESPONSE_SCHEMA,
                "max_output_tokens": max_tokens,
                "thinking_config": {"thinking_budget": 0},
            },
        )
    except TypeError:
        plain_prompt = _PROMPT + "\n\nRespond with ONLY the JSON object."
        response = client.models.generate_content(model=model, contents=[uploaded_file, plain_prompt])
    return json.loads(_strip_code_fence(response.text))


def _map_response(payload: dict) -> AudioResult:
    segments = [
        TranscriptionSegment(start=float(item["start"]), end=float(item["end"]),
                              text=str(item["text"]))
        for item in payload.get("transcription", []) or []
    ]
    tags = [
        AudioTag(start=float(item["start"]), end=float(item["end"]), tag=str(item["tag"]))
        for item in payload.get("audio_tags", []) or []
    ]
    return AudioResult(segments=segments, audio_tags=tags, transcription_source="gemini-api")


def transcribe(wav_path: str, cfg: dict) -> AudioResult:
    """Upload `wav_path` to Gemini, transcribe speech + tag non-speech events.

    Timestamps come back relative to the WAV; the orchestrator re-anchors them
    onto the original video timeline via timestamps.shift_audio_result(). The
    uploaded file is always deleted server-side, even on failure.
    """
    client = _client()
    uploaded = client.files.upload(file=wav_path)
    file_name = uploaded.name
    try:
        active_file = wait_for_file_active(client, file_name)
        payload = _generate(client, active_file, cfg)
    finally:
        client.files.delete(name=file_name)
    return _map_response(payload)


def transcribe_with_retry(wav_path: str, cfg: dict, retries: int = 1) -> AudioResult:
    """transcribe(), retrying up to `retries` times on any exception before
    giving up and re-raising the last failure. Cloud calls flake; one retry
    catches most of it without masking a genuinely broken setup."""
    attempt = 0
    while True:
        try:
            return transcribe(wav_path, cfg)
        except Exception:
            attempt += 1
            if attempt > retries:
                raise
