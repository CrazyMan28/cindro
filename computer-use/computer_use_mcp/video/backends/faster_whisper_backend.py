"""faster-whisper — the default local transcription engine.

In-process (no subprocess), pip-installed already on this box. Model weights
auto-download from Hugging Face on first use (faster-whisper's own behavior,
not ours to reimplement) and get cached under the HF cache dir. GPU is used
opportunistically: CUDA when a CUDA device is visible, CPU otherwise, with a
load-time fallback so a half-working CUDA install degrades instead of
crashing video_watch.
"""

from __future__ import annotations

import threading
from typing import Any

from computer_use_mcp.video import platform_info
from computer_use_mcp.video.types import AudioResult, TranscriptionSegment
from computer_use_mcp.video.backends import resolve_model

# Loaded WhisperModel instances, keyed by (model, device, compute_type).
# Loading large-v3 takes real seconds (weight load + CUDA context) — this
# cache makes repeated video_watch calls in the same engine process free.
# The lock closes the check-then-set race: two chunk-worker threads missing
# the cache together would otherwise BOTH load a multi-GB model.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_MODEL_CACHE_LOCK = threading.Lock()
# ctranslate2 does not guarantee concurrent transcribe() on ONE model instance
# is safe, and two independent MCP tool calls can share the cached instance —
# serialize inference per model. (Chunk workers are already sequential; this
# closes the cross-request path.)
_INFERENCE_LOCKS: dict[tuple[str, str, str], threading.Lock] = {}


def _inference_lock(key: tuple[str, str, str]) -> threading.Lock:
    with _MODEL_CACHE_LOCK:
        return _INFERENCE_LOCKS.setdefault(key, threading.Lock())




def resolve_device(cfg: dict) -> tuple[str, str]:
    """cfg["video_whisper_device"] -> (device, compute_type).

    "auto" probes ctranslate2 for a visible CUDA device; any failure at all
    (not installed, driver missing, no GPU) is treated as "no CUDA" rather
    than an error — device selection must never be why video_watch fails.
    compute_type follows the device: float16 is the standard CUDA choice,
    int8 keeps CPU inference fast without a meaningful quality hit.
    """
    device = cfg.get("video_whisper_device", "auto")
    if device == "auto":
        device = "cpu"
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
        except Exception:  # noqa: BLE001 — no CUDA is a normal outcome, not a bug
            device = "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


def _get_model(model: str, device: str, compute_type: str) -> Any:
    key = (model, device, compute_type)
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        import faster_whisper

        instance = faster_whisper.WhisperModel(model, device=device,
                                               compute_type=compute_type)
        _MODEL_CACHE[key] = instance
        return instance


def _run_transcription(model: Any, wav_path: str) -> list[TranscriptionSegment]:
    # vad_filter=True skips silence so segment boundaries land on speech, not
    # on the whole-file span. The generator must be drained HERE: faster-whisper
    # decodes lazily, so CUDA runtime failures can surface mid-iteration.
    segments, _info = model.transcribe(wav_path, vad_filter=True)
    return [
        TranscriptionSegment(start=float(seg.start), end=float(seg.end), text=seg.text.strip())
        for seg in segments
    ]


def transcribe(wav_path: str, cfg: dict) -> AudioResult:
    """Transcribe `wav_path` (relative timestamps) with faster-whisper.

    CUDA can fail at LOAD (bad driver, OOM) or only at RUNTIME (a visible GPU
    but missing CUDA libs like libcublas — ctranslate2's device probe still
    says "cuda"). Either way we retry once on cpu/int8 rather than propagating
    — degrade, don't error — and evict the broken CUDA instance from the cache
    so later calls go straight to the working CPU model.
    """
    model_name = resolve_model(cfg)
    device, compute_type = resolve_device(cfg)
    try:
        model = _get_model(model_name, device, compute_type)
        with _inference_lock((model_name, device, compute_type)):
            result_segments = _run_transcription(model, wav_path)
    except Exception:  # noqa: BLE001 — CUDA fails in ways the probe can't predict
        if device != "cuda":
            raise
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE.pop((model_name, device, compute_type), None)
        model = _get_model(model_name, "cpu", "int8")
        with _inference_lock((model_name, "cpu", "int8")):
            result_segments = _run_transcription(model, wav_path)
    return AudioResult(segments=result_segments, transcription_source="faster-whisper")


def ensure_model(cfg: dict) -> str:
    """Force-load (downloading if needed) the configured model; used by
    video_setup to pre-warm so the ~3GB large-v3 download doesn't happen
    inside a user-facing video_watch call."""
    model_name = resolve_model(cfg)
    device, compute_type = resolve_device(cfg)
    _get_model(model_name, device, compute_type)
    return model_name


def probe() -> dict:
    """Availability check for video_setup: is faster-whisper importable, and
    is a CUDA device visible?"""
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "detail": f"faster_whisper not importable: {exc}"}

    cuda_detail = "cpu only"
    try:
        import ctranslate2

        count = ctranslate2.get_cuda_device_count()
        if count > 0:
            cuda_detail = f"{count} CUDA device(s) visible"
    except Exception as exc:  # noqa: BLE001 — ctranslate2 missing/broken is not fatal here
        cuda_detail = f"cpu only (ctranslate2 CUDA check failed: {exc})"

    return {"available": True, "detail": f"faster-whisper importable; {cuda_detail}"}
