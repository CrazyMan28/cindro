"""ffmpeg audio extraction — 16kHz mono PCM WAV, transcription-ready.

Two entry points: extract_audio() pulls a (possibly windowed) slice of a
video's audio track to disk in the shape faster-whisper/whisper.cpp/cloud
backends all want. detect_silences() runs ffmpeg's silencedetect filter so
audio_chunker can align long-audio chunk boundaries on quiet moments instead
of cutting mid-word.

The argv builder and the stderr parser are exposed separately from the
subprocess-running functions so tests can assert on them without needing
ffmpeg on PATH for every case.
"""

from __future__ import annotations

import re
import subprocess

from computer_use_mcp.video.types import Interval

# ffmpeg has no bare "run silently" mode; -f null - discards output but still
# needs a sink argument. -nostats keeps stderr to just what we parse.
_PROBE_TIMEOUT_SECONDS = 120
_STDERR_EXCERPT_CHARS = 2000

_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?[0-9.]+)")


def build_extract_args(
    path: str,
    out_wav: str,
    *,
    start: float = 0.0,
    end: float | None = None,
) -> list[str]:
    """ffmpeg argv for a 16kHz mono PCM WAV slice of `path`'s audio.

    -ss goes AFTER -i (output seeking): input-seek is fast but frame-snapped,
    which is fine for frame extraction but not for transcription — an
    output-seeked -ss decodes from the start and drops samples up to the
    target, so segment timestamps stay sample-accurate. -to (also after -i)
    bounds the window; both are relative to the input, matching ffmpeg's
    contract when placed after -i.
    """
    args = ["ffmpeg", "-y", "-i", path]
    if start:
        args += ["-ss", str(start)]
    if end is not None:
        args += ["-to", str(end)]
    args += ["-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out_wav]
    return args


def extract_audio(
    path: str,
    out_wav: str,
    *,
    start: float = 0.0,
    end: float | None = None,
) -> str:
    """Extract a 16kHz mono WAV slice to `out_wav`, returning that path."""
    args = build_extract_args(path, out_wav, start=start, end=end)
    proc = subprocess.run(args, capture_output=True, text=True, timeout=_PROBE_TIMEOUT_SECONDS)
    if proc.returncode != 0:
        excerpt = (proc.stderr or "")[-_STDERR_EXCERPT_CHARS:]
        raise RuntimeError(f"ffmpeg audio extraction failed ({path}): {excerpt}")
    return out_wav


def parse_silencedetect(stderr: str, clip_end: float | None) -> list[Interval]:
    """Parse silencedetect's interleaved silence_start/silence_end lines.

    ffmpeg emits one silence_start line when a quiet run begins and a matching
    silence_end (with a duration:) once it ends. A silence_start with no
    following silence_end means the clip ended while still silent — close it
    at clip_end when we know the window's extent, else drop the dangling
    interval (we can't report an end we don't have).
    """
    intervals: list[Interval] = []
    pending_start: float | None = None
    for line in stderr.splitlines():
        start_match = _SILENCE_START_RE.search(line)
        if start_match:
            pending_start = float(start_match.group(1))
            continue
        end_match = _SILENCE_END_RE.search(line)
        if end_match and pending_start is not None:
            intervals.append(Interval(start=pending_start, end=float(end_match.group(1))))
            pending_start = None
    if pending_start is not None and clip_end is not None:
        intervals.append(Interval(start=pending_start, end=clip_end))
    return intervals


def detect_silences(
    path: str,
    *,
    noise_db: float = -40.0,
    min_duration: float = 0.5,
    start: float = 0.0,
    end: float | None = None,
) -> list[Interval]:
    """Silence intervals in `path`'s audio, optionally windowed to [start, end).

    clip_end feeds parse_silencedetect so a trailing silence that runs to the
    edge of the requested window still closes instead of being dropped.
    """
    args = ["ffmpeg", "-y", "-i", path]
    if start:
        args += ["-ss", str(start)]
    if end is not None:
        args += ["-to", str(end)]
    args += ["-af", f"silencedetect=n={noise_db}dB:d={min_duration}", "-f", "null", "-"]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=_PROBE_TIMEOUT_SECONDS)
    if proc.returncode != 0:
        excerpt = (proc.stderr or "")[-_STDERR_EXCERPT_CHARS:]
        raise RuntimeError(f"ffmpeg silencedetect failed ({path}): {excerpt}")
    clip_end = end if end is not None else None
    return parse_silencedetect(proc.stderr or "", clip_end)
