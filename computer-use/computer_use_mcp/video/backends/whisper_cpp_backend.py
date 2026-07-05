"""whisper.cpp — external CLI transcription engine.

An alternative to in-process faster-whisper for boxes that already have a
whisper.cpp build (or want its lower memory footprint). Ggml model weights
are fetched straight from the whisper.cpp Hugging Face mirror on first use
and cached under video/config.models_dir() (faster-whisper instead uses the
shared HF cache — these are a different weight format, hence a separate
store).

Model validation trade-off: there is no per-model SHA-256 table to check
against (that table would need updating every time upstream adds a model),
so a completed download is accepted when either its header matches a
plausible GGML/GGUF magic OR its size clears a "this could not possibly be a
truncated/error-page download" floor. This will not catch a corrupted-but-
large file; it is deliberately cheap insurance against the common failure
(HTML error page saved as .bin), not a supply-chain guarantee.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from computer_use_mcp.video import config, platform_info
from computer_use_mcp.video.types import AudioResult, TranscriptionSegment

_HF_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Plausible first bytes of a real ggml/gguf model file. ggml's classic magic
# constant (0x67676d6c) lands on disk as b"lmgg" on little-endian hosts —
# whisper.cpp has shipped both that and modern GGUF files, so check both.
_MAGIC_PREFIXES = (b"ggml", b"lmgg", b"GGUF")

# "This is definitely not an HTML error page" floor — the smallest real ggml
# whisper model (tiny, quantized) is tens of MB, so 10MB is comfortably below
# any genuine model and comfortably above any error-page download. Module
# level so tests can lower it and exercise the validator with tiny fixtures.
_MIN_PLAUSIBLE_BYTES = 10 * 1024 * 1024


def resolve_model(cfg: dict) -> str:
    """cfg["video_whisper_model"], resolving "auto" to a RAM-based pick."""
    model = cfg.get("video_whisper_model", "large-v3")
    if model == "auto":
        return platform_info.recommend_whisper_model()
    return model


def _find_binary() -> str:
    """"whisper-cli" is the modern whisper.cpp binary name; "whisper-cpp" is
    the legacy one some package managers still ship."""
    exe = platform_info.check_command("whisper-cli")
    if exe:
        return exe
    exe = platform_info.check_command("whisper-cpp")
    if exe:
        return exe
    raise FileNotFoundError("whisper-cli (or legacy whisper-cpp) not found on PATH")


def _looks_like_valid_model(head: bytes, size: int) -> bool:
    if any(head.startswith(magic) for magic in _MAGIC_PREFIXES):
        return True
    return size > _MIN_PLAUSIBLE_BYTES


def _download_model(model_name: str, dest: Path) -> None:
    """Download ggml-<model_name>.bin to a .part file, validate, then
    os.replace() it into place — the rename is atomic on the same
    filesystem, so a crash mid-download never leaves a half-written file at
    the path callers check for existence."""
    url = f"{_HF_BASE_URL}/ggml-{model_name}.bin"
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=30) as resp, open(part, "wb") as f:
            shutil.copyfileobj(resp, f)
    except (urllib.error.URLError, OSError):
        part.unlink(missing_ok=True)
        raise

    size = part.stat().st_size
    with open(part, "rb") as f:
        head = f.read(8)
    if not _looks_like_valid_model(head, size):
        part.unlink(missing_ok=True)
        raise RuntimeError(
            f"download for ggml-{model_name}.bin failed validation ({size} bytes)")
    os.replace(part, dest)


def ensure_model_file(model_name: str) -> str:
    """Path to ggml-<model_name>.bin under models_dir(), downloading it first
    if it isn't already cached."""
    path = config.models_dir() / f"ggml-{model_name}.bin"
    if not path.exists():
        _download_model(model_name, path)
    return str(path)


def _parse_segments(data: dict) -> list[TranscriptionSegment]:
    """whisper.cpp's -oj output has changed shape across versions: offsets
    have shown up both as top-level from/to on each segment and nested under
    "offsets": {"from", "to"} — both are milliseconds. Handle either."""
    raw_segments = data.get("transcription") or data.get("segments") or []
    result: list[TranscriptionSegment] = []
    for seg in raw_segments:
        offsets = seg.get("offsets")
        if offsets:
            start_ms, end_ms = offsets.get("from", 0), offsets.get("to", 0)
        else:
            start_ms, end_ms = seg.get("from", 0), seg.get("to", 0)
        text = (seg.get("text") or "").strip()
        result.append(TranscriptionSegment(start=start_ms / 1000.0, end=end_ms / 1000.0, text=text))
    return result


def transcribe(wav_path: str, cfg: dict) -> AudioResult:
    """Run whisper-cli against `wav_path` and parse its JSON sidecar.

    "-l", "auto" lets whisper.cpp detect the spoken language itself; "-np"
    suppresses its progress printing so stdout stays quiet for the caller.
    """
    exe = _find_binary()
    model_path = ensure_model_file(resolve_model(cfg))
    with tempfile.TemporaryDirectory() as tmpdir:
        out_prefix = os.path.join(tmpdir, "out")
        subprocess.run(
            [exe, "-m", model_path, "-f", wav_path, "-oj", "-of", out_prefix, "-l", "auto", "-np"],
            capture_output=True, text=True, check=True)
        with open(f"{out_prefix}.json", encoding="utf-8") as f:
            data = json.load(f)
    return AudioResult(segments=_parse_segments(data), transcription_source="whisper-cpp")


def probe() -> dict:
    """Availability check for video_setup: which binary (if any), and which
    ggml models are already cached (models download lazily on first use, so
    an empty cache is normal, not a failure)."""
    exe = platform_info.check_command("whisper-cli") or platform_info.check_command("whisper-cpp")
    if not exe:
        return {"available": False, "detail": "whisper-cli (or legacy whisper-cpp) not found on PATH"}

    cached = sorted(p.name for p in config.models_dir().glob("ggml-*.bin"))
    detail = f"binary: {exe}"
    detail += f"; cached models: {', '.join(cached)}" if cached else "; no cached ggml models yet"
    return {"available": True, "detail": detail}
