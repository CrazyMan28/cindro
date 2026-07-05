"""Video settings bridge + storage directories.

Preferences live in jarvisd's SettingsStore (~/.config/jarvis/config.toml,
video_* keys) so the desktop/TUI Settings pages edit the same values the
tools read. The engine merges the daemon's answer over DEFAULTS and keeps
working on defaults alone when the daemon is unreachable (tests, engine-only
setups) — video perception must never hard-depend on jarvisd being up.

Storage follows the shared Jarvis data-dir contract ($JARVIS_DATA_DIR else
$XDG_DATA_HOME else ~/.local/share, + /jarvis) — resolved via Path.home() so
it lands in the same shape on Windows (jarvis#81: never %APPDATA%).
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from computer_use_mcp import daemon_client

# Keys + defaults mirror SettingsStore exactly; the daemon is authoritative,
# these are the offline fallback. Keep both lists in sync when adding a knob.
DEFAULTS: dict = {
    "video_backend": "local",              # local | gemini-api | openai-api
    "video_whisper_engine": "faster-whisper",  # faster-whisper | whisper-cpp | openai-whisper
    "video_whisper_model": "large-v3",     # tiny..large-v3 | auto
    "video_whisper_device": "auto",        # auto | cpu | cuda
    "video_frame_mode": "images",          # images | descriptions
    "video_frame_format": "jpeg",          # jpeg | png | webp
    "video_frame_resolution": 512,         # scale width, 128..2048
    "video_default_fps": "auto",           # "auto" | numeric string
    "video_max_frames": 100,
    "video_frame_describer_model": "",     # "" = session default brain/model
    "video_frame_describer_timeout_sec": 180,
    "video_enable_index": False,           # persistent frame/session cache
    "video_session_max_age_days": 7,
    "video_downloads_max_age_days": 7,
    "video_audio_chunk_trigger_seconds": 1200,
    "video_audio_chunk_size_seconds": 600,
    "video_audio_chunk_overlap_seconds": 0,
    "video_gemini_model": "gemini-3-flash-preview",
    "video_gemini_max_output_tokens": 65536,
}


def load_video_config() -> dict:
    """DEFAULTS overlaid with whatever video_* keys the daemon has."""
    cfg = dict(DEFAULTS)
    try:
        settings = daemon_client.call("settings.get", {}, timeout=5)
        for key, fallback in DEFAULTS.items():
            if key not in settings:
                continue
            value = settings[key]
            # Coerce to the default's type so a "512" from TOML edits or a
            # bool-ish int can't leak surprises into ffmpeg args.
            if isinstance(fallback, bool):
                cfg[key] = bool(value)
            elif isinstance(fallback, int):
                try:
                    cfg[key] = int(value)
                except (TypeError, ValueError):
                    pass
            else:
                cfg[key] = str(value)
    except Exception:  # noqa: BLE001 — daemon down: defaults are the contract
        pass
    return cfg


def update_video_config(patch: dict) -> dict:
    """Write video_* keys through to the daemon. Raises when jarvisd is
    unreachable — configuration edits (unlike reads) must not silently no-op."""
    clean = {k: v for k, v in patch.items() if k in DEFAULTS}
    if not clean:
        return load_video_config()
    daemon_client.call("settings.set", {"patch": clean}, timeout=10)
    return load_video_config()


# ---- storage ---------------------------------------------------------------

def data_dir() -> Path:
    """<jarvis data root> — same resolution the daemon and CLI use."""
    override = os.environ.get("JARVIS_DATA_DIR")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "jarvis"


def video_dir() -> Path:
    return data_dir() / "video"


def downloads_dir() -> Path:
    d = video_dir() / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sessions_dir() -> Path:
    d = video_dir() / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def models_dir() -> Path:
    """ggml models for the whisper.cpp engine (faster-whisper uses the HF cache)."""
    d = video_dir() / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def clear_sessions() -> int:
    """Delete the whole session cache; returns how many session dirs went."""
    root = video_dir() / "sessions"
    if not root.is_dir():
        return 0
    count = sum(1 for p in root.iterdir() if p.is_dir())
    shutil.rmtree(root, ignore_errors=True)
    return count
