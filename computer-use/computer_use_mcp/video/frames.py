"""ffmpeg frame extraction — metadata probing, auto-fps, timestamped frames.

One ffprobe call gets the facts (get_video_metadata); one ffmpeg call per
extraction window pulls frames. Frame timestamps are computed from index/fps
rather than trusted to ffmpeg's own frame naming — deterministic and immune
to frame-rate rounding or dropped/duplicated frames in the encoder.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from computer_use_mcp.video.timestamps import format_hms_frac, parse_hms
from computer_use_mcp.video.types import Frame, Segment, VideoMetadata

_PROBE_TIMEOUT = 30
_EXTRACT_TIMEOUT = 300

# Per-format ffmpeg encoder args + output file extension. webp pins the
# still-image encoder explicitly: with a numbered-pattern .webp output ffmpeg
# otherwise auto-selects libwebp_anim and silently bundles EVERY frame into
# one animated frame_0001.webp instead of one file per frame.
_FORMAT_ARGS: dict[str, tuple[list[str], str]] = {
    "jpeg": (["-q:v", "5"], "jpg"),
    "png": ([], "png"),
    "webp": (["-c:v", "libwebp", "-quality", "80"], "webp"),
}


def get_video_metadata(path: str) -> VideoMetadata:
    """Probe one video file with ffprobe and return its shape.

    Raises ValueError (never FileNotFoundError/CalledProcessError) so callers
    can treat "bad video" as one case whether the file is missing, unreadable,
    or not something ffprobe understands.
    """
    if not os.path.isfile(path):
        raise ValueError(f"video file not found: {path}")

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, text=True, timeout=_PROBE_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"ffprobe failed to run on {path}: {exc}") from exc

    if result.returncode != 0:
        raise ValueError(f"ffprobe rejected {path}: {result.stderr.strip()}")

    try:
        probe = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"ffprobe returned unparseable output for {path}: {exc}") from exc

    fmt = probe.get("format", {}) or {}
    streams = probe.get("streams", []) or []
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video_stream is None:
        raise ValueError(f"{path} has no video stream")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    try:
        duration = float(fmt.get("duration", 0.0))
    except (TypeError, ValueError):
        duration = 0.0

    try:
        size_bytes = int(fmt.get("size", 0))
    except (TypeError, ValueError):
        size_bytes = 0

    return VideoMetadata(
        path=path,
        duration_seconds=duration,
        width=int(video_stream.get("width", 0) or 0),
        height=int(video_stream.get("height", 0) or 0),
        codec=str(video_stream.get("codec_name", "") or ""),
        fps=_parse_frame_rate(str(video_stream.get("r_frame_rate", "0/0"))),
        size_bytes=size_bytes,
        has_audio=has_audio,
    )


def _parse_frame_rate(value: str) -> float:
    """ffprobe r_frame_rate fraction ('30/1', '30000/1001') -> float fps.

    Guards a zero (or missing) denominator instead of raising — some streams
    report "0/0" and callers shouldn't crash over an fps we can't compute.
    """
    num_str, _, den_str = value.partition("/")
    try:
        num = float(num_str)
        den = float(den_str) if den_str else 1.0
    except ValueError:
        return 0.0
    if den == 0:
        return 0.0
    return num / den


def calculate_auto_fps(duration_seconds: float) -> float:
    """Sampling density that keeps long videos from producing huge frame counts."""
    if duration_seconds < 60:
        return 2.0
    if duration_seconds < 300:
        return 1.0
    if duration_seconds < 900:
        return 0.5
    if duration_seconds < 3600:
        return 0.2
    return 0.1


def extract_frames(
    path: str,
    out_dir: str,
    *,
    fps: float,
    resolution: int,
    start: float = 0.0,
    end: float | None = None,
    max_frames: int = 100,
    fmt: str = "jpeg",
) -> list[Frame]:
    """Extract frames from [start, end) at `fps`, scaled to `resolution` width.

    -ss goes BEFORE -i (fast input-side seek) — safe here because each frame's
    timestamp is computed from its index rather than trusted to ffmpeg's own
    pts, so sample-accurate seeking isn't required. When `end` is given, -t
    goes AFTER -i since with input seeking that's the reliable way to bound
    the extraction window (an output -to would be measured from the seek
    point in some ffmpeg versions and from zero in others).
    """
    if fmt not in _FORMAT_ARGS:
        raise ValueError(f"unsupported frame format: {fmt!r} (use jpeg/png/webp)")
    encoder_args, ext = _FORMAT_ARGS[fmt]

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    pattern = str(out_path / f"frame_%04d.{ext}")

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-i", path]
    if end is not None:
        cmd += ["-t", str(max(0.0, end - start))]
    cmd += [
        "-vf", f"fps={fps},scale={resolution}:-1",
        "-frames:v", str(max_frames),
        *encoder_args,
        pattern,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=_EXTRACT_TIMEOUT)
    if result.returncode != 0:
        if fmt == "webp" and "Unknown encoder" in result.stderr:
            raise RuntimeError(
                "This ffmpeg build has no webp encoder — use fmt='jpeg' or "
                "fmt='png' instead, or install an ffmpeg build with libwebp.")
        raise RuntimeError(f"ffmpeg frame extraction failed: {result.stderr.strip()}")

    frames: list[Frame] = []
    for index, frame_path in enumerate(sorted(out_path.glob(f"frame_*.{ext}"))):
        seconds = start + index / fps
        frames.append(Frame(
            # Fractional formatter: at any fps > 1 several frames share one
            # whole second — a plain HH:MM:SS label would collide their cache
            # filenames/manifest entries and silently drop frames.
            timestamp=format_hms_frac(seconds),
            seconds=seconds,
            path=str(frame_path),
            resolution=resolution,
            format=fmt,
        ))
    return frames


def extract_frames_by_segments(
    path: str,
    out_dir: str,
    segments: list[Segment],
    *,
    default_resolution: int,
    fmt: str = "jpeg",
    max_frames_per_segment: int = 1000,
) -> list[Frame]:
    """Extract each segment at its own fps/resolution, then merge by time.

    Every segment gets its own "res<NNN>/seg<NNN>" subdirectory under out_dir —
    keyed by resolution (per spec, so mixed resolutions never collide on the
    frame_%04d filenames) and then by segment index (so two segments that
    happen to share a resolution don't overwrite each other's frame_0001 either).
    """
    out_path = Path(out_dir)
    all_frames: list[Frame] = []
    for index, segment in enumerate(segments):
        resolution = segment.resolution or default_resolution
        start = parse_hms(segment.start)
        end = parse_hms(segment.end)
        segment_dir = out_path / f"res{resolution}" / f"seg{index:04d}"
        frames = extract_frames(
            path, str(segment_dir),
            fps=segment.fps, resolution=resolution,
            start=start, end=end,
            max_frames=max_frames_per_segment, fmt=fmt,
        )
        all_frames.extend(frames)
    all_frames.sort(key=lambda f: f.seconds)
    return all_frames
