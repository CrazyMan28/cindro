"""Local transcription engines — one module per engine, one shared protocol.

Every backend module (this package's three plus the sibling cloud two) exposes:

    transcribe(wav_path: str, cfg: dict) -> AudioResult

`cfg` is the dict from `computer_use_mcp.video.config.load_video_config()`.
Timestamps returned are relative to the WAV handed in — the orchestrator
(audio_chunker / tools_video) re-anchors them to the original video timeline
via `timestamps.shift_audio_result()`. `transcription_source` is set to the
module's own id (e.g. "faster-whisper").

Heavy deps (faster_whisper, ctranslate2, whisper-cpp CLI, ...) are imported
lazily inside each backend module's functions, never here or at their own
module top — this package must import cleanly on a box with none of them
installed (frozen Windows build, CI without GPU wheels).
"""

from __future__ import annotations

import importlib
from types import ModuleType

from computer_use_mcp.video import platform_info

# Engine ids as they appear in video_whisper_engine settings + transcription_source.
LOCAL_ENGINES = ("faster-whisper", "whisper-cpp", "openai-whisper")

_MODULE_BY_ENGINE = {
    "faster-whisper": "faster_whisper_backend",
    "whisper-cpp": "whisper_cpp_backend",
    "openai-whisper": "openai_whisper_backend",
}


def get_local_backend(engine: str) -> ModuleType:
    """Import and return the backend module for `engine`.

    Raises ValueError for anything not in LOCAL_ENGINES (cloud engines live in
    their own gemini_api_backend/openai_api_backend modules, dispatched
    separately — this function is for the local/in-process trio only).
    """
    modname = _MODULE_BY_ENGINE.get(engine)
    if modname is None:
        raise ValueError(
            f"unknown local whisper engine {engine!r}; expected one of {LOCAL_ENGINES}")
    return importlib.import_module(f"computer_use_mcp.video.backends.{modname}")


def resolve_model(cfg: dict) -> str:
    """cfg["video_whisper_model"], resolving "auto" to a RAM-based pick.

    Shared by all three local engines so the "auto" policy can never drift
    between them."""
    model = cfg.get("video_whisper_model", "large-v3")
    if model == "auto":
        return platform_info.recommend_whisper_model()
    return model
