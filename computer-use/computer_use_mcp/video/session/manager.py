"""Persistent per-video frame cache — only touched when video_enable_index
is on. Keys the cache off content (not path), so re-analyzing the same file
from a different location or after a rename/move is still a cache hit, and
analyzing a different file that happens to share a path is not.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from computer_use_mcp.video import config

_HASH_PREFIX_BYTES = 64 * 1024  # first 64KB — fast even on multi-GB files
_MANIFEST_NAME = "manifest.json"


def compute_video_hash(path: str) -> str:
    """sha256(first 64KB of file bytes + str(file size in bytes)), hex[:12].

    Trade-off: two different files with an identical 64KB prefix AND
    identical total size collide (astronomically unlikely for real video).
    In exchange, hashing a multi-GB file is a single small read, and a file
    that gets moved/renamed but not touched keeps its cache."""
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        digest.update(f.read(_HASH_PREFIX_BYTES))
    digest.update(str(size).encode())
    return digest.hexdigest()[:12]


def session_dir(video_hash: str) -> Path:
    """Directory for this video's cached frames/manifest, created on demand."""
    d = config.sessions_dir() / video_hash
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_manifest(video_hash: str) -> dict | None:
    """The saved manifest, or None if there isn't one / it's unreadable.
    Corruption (partial write, disk full, hand-edited garbage) must never
    crash a video tool — treat it the same as "no cache yet"."""
    path = session_dir(video_hash) / _MANIFEST_NAME
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def save_manifest(video_hash: str, manifest: dict) -> None:
    """Atomic write: tmp file + os.replace, so a crash mid-write never leaves
    a half-written manifest.json for load_manifest to trip over."""
    d = session_dir(video_hash)
    tmp = d / f".{_MANIFEST_NAME}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, d / _MANIFEST_NAME)


def clean_expired_sessions(max_age_days: int) -> int:
    """Remove session dirs whose manifest is older than max_age_days.

    Age comes from the manifest's created_at when readable; a dir with a
    missing/corrupt manifest falls back to the DIRECTORY's mtime so garbage
    still gets swept instead of living forever. Never raises — this runs on
    a best-effort maintenance path and one bad dir must not block the rest."""
    root = config.sessions_dir()
    if not root.is_dir():
        return 0
    cutoff = datetime.now(timezone.utc).timestamp() - max_age_days * 86400
    removed = 0
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        try:
            age_cutoff_seconds = _session_age_reference(entry)
            if age_cutoff_seconds < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        except Exception:  # noqa: BLE001 — one bad dir must not abort the sweep
            continue
    return removed


def _session_age_reference(entry: Path) -> float:
    """Unix timestamp to compare against the cutoff: manifest created_at when
    present and parseable, else the directory's own mtime."""
    manifest = load_manifest(entry.name)
    if manifest and "created_at" in manifest:
        with contextlib.suppress(ValueError, TypeError):
            return datetime.fromisoformat(manifest["created_at"]).timestamp()
    return entry.stat().st_mtime
