"""Pure functions over the session manifest dict.

The manifest is the on-disk record of what a video's session cache holds:
which frames have been extracted at which resolution/format, plus whatever
analysis (video_analyze output) has already been computed for that video.
Nothing here touches disk — manager.py owns load/save; this module only
shapes and queries the dict so both the CLI and the tools agree on it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def new_manifest(video_hash: str, video_path: str) -> dict[str, Any]:
    """A fresh, empty manifest for a video that has no session cache yet."""
    return {
        "video_hash": video_hash,
        "video_path": video_path,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "resolutions": {},
    }


def cache_key(resolution: int, fmt: str) -> str:
    """Manifest key for a given extraction density — one bucket per
    resolution/format pair since frames at 512/jpeg and 1024/png don't mix."""
    return f"{resolution}/{fmt}"


def frame_filename(timestamp: str, fmt: str) -> str:
    """'HH:MM:SS' -> 'HH-MM-SS.<ext>' — colons are illegal in Windows filenames."""
    return f"{timestamp.replace(':', '-')}.{fmt}"


def merge_frames(
    manifest: dict[str, Any], resolution: int, fmt: str, frames: list[dict[str, Any]],
) -> dict[str, Any]:
    """Add newly-extracted frames into the manifest, deduped by exact
    timestamp within that resolution/format bucket, sorted by timestamp.
    Returns the same manifest object, mutated, for convenient chaining."""
    key = cache_key(resolution, fmt)
    bucket = manifest.setdefault("resolutions", {}).setdefault(key, {"frames": []})
    by_timestamp = {f["timestamp"]: f for f in bucket["frames"]}
    for frame in frames:
        by_timestamp[frame["timestamp"]] = frame
    bucket["frames"] = sorted(by_timestamp.values(), key=lambda f: f["timestamp"])
    return manifest


def uncached_timestamps(
    manifest: dict[str, Any], resolution: int, fmt: str, wanted: list[str],
) -> list[str]:
    """Which of `wanted` timestamps are NOT already cached at this
    resolution/format — order preserved so callers can re-request in the
    same sequence they asked for."""
    key = cache_key(resolution, fmt)
    bucket = manifest.get("resolutions", {}).get(key)
    if not bucket:
        return list(wanted)
    have = {f["timestamp"] for f in bucket.get("frames", [])}
    return [t for t in wanted if t not in have]


def sample_indices(total: int, n: int) -> list[int]:
    """n evenly spaced indices over range(total).

    n<=0 or n>=total means "everything" (no downsampling possible/wanted);
    n==1 picks the first frame rather than a mid-point average — callers
    that want "one representative frame" almost always mean the start."""
    if total <= 0:
        return []
    if n <= 0 or n >= total:
        return list(range(total))
    if n == 1:
        return [0]
    step = (total - 1) / (n - 1)
    return [round(i * step) for i in range(n)]


def viewable_pool(manifest: dict[str, Any], fmt: str) -> list[dict[str, Any]]:
    """Union of cached frames across ALL resolutions for `fmt`, deduped by
    timestamp preferring the HIGHEST resolution copy (best quality already
    on disk), sorted by timestamp. Each entry: {timestamp, file, resolution}."""
    best: dict[str, dict[str, Any]] = {}
    for key, bucket in manifest.get("resolutions", {}).items():
        res_str, _, key_fmt = key.partition("/")
        if key_fmt != fmt:
            continue
        try:
            resolution = int(res_str)
        except ValueError:
            continue
        for frame in bucket.get("frames", []):
            ts = frame["timestamp"]
            current = best.get(ts)
            if current is None or resolution > current["resolution"]:
                best[ts] = {
                    "timestamp": ts,
                    "file": frame["file"],
                    "resolution": resolution,
                }
    return sorted(best.values(), key=lambda f: f["timestamp"])
