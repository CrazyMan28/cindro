"""ffmpeg audio extraction — 16kHz mono PCM WAV, transcription-ready.

Two entry points: extract_audio() pulls a (possibly windowed) slice of a
video's audio track to disk in the shape faster-whisper/whisper.cpp/cloud
backends all want. detect_silences() runs ffmpeg's silencedetect filter so
audio_chunker can align long-audio chunk boundaries on quiet moments instead
of cutting mid-word.

Both use INPUT-side -ss/-t seeking. Output-side -ss looks tempting for
"sample accuracy" but is wrong here twice over: an -af filter still sees the
ENTIRE decoded stream (silencedetect would report silences outside the
window, with a full-file decode every call), and chunked extraction of an
N-chunk video would re-decode from t=0 for every chunk (O(n²) total decode).
Input-side seeking on an audio stream lands within one audio frame (~20ms)
of the target — far inside transcription tolerance. Timestamps in ffmpeg's
output are rebased to 0 at the seek point; detect_silences() shifts them
back so its results stay on the ORIGINAL video timeline.

The argv builder and the stderr parser are exposed separately from the
subprocess-running functions so tests can assert on them without needing
ffmpeg on PATH for every case.
"""

from __future__ import annotations

import re
import subprocess

from computer_use_mcp.video.types import Interval

# Full-file audio decodes (extraction, silencedetect over a 2h+ video) are
# legitimately slow on weak hardware — the ceiling exists only to convert a
# truly wedged ffmpeg into an error instead of an infinite hang.
_DECODE_TIMEOUT_SECONDS = 3600
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

    -ss goes BEFORE -i (input seek: the demuxer jumps near the target instead
    of decoding everything before it — essential for chunked long-video
    extraction) and the window is bounded with -t <duration> after -i, the
    reliable way to bound an input-seeked run across ffmpeg versions.
    """
    args = ["ffmpeg", "-y"]
    if start:
        args += ["-ss", str(start)]
    args += ["-i", path]
    if end is not None:
        args += ["-t", str(max(0.0, end - start))]
    args += ["-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out_wav]
    return args


def extract_audio(
    path: str,
    out_wav: str,
    *,
    start: float = 0.0,
    end: float | None = None,
) -> str:
    """Extract a 16kHz mono WAV slice to `out_wav`, returning that path.

    The WAV's timestamps start at 0 regardless of `start` — callers re-anchor
    transcription output via timestamps.shift_audio_result().
    """
    args = build_extract_args(path, out_wav, start=start, end=end)
    proc = subprocess.run(args, capture_output=True, text=True,
                          timeout=_DECODE_TIMEOUT_SECONDS)
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
    """Silence intervals in [start, end) of `path`'s audio, reported on the
    ORIGINAL video timeline.

    Input-side -ss means ffmpeg only decodes the requested window (and the
    filter genuinely can't see outside it), with the filter's timestamps
    rebased to 0 at the seek point — so results are shifted back by `start`
    before returning. clip_end feeds parse_silencedetect so a trailing
    silence that runs to the window's edge still closes instead of being
    dropped.
    """
    args = ["ffmpeg", "-y"]
    if start:
        args += ["-ss", str(start)]
    args += ["-i", path]
    if end is not None:
        args += ["-t", str(max(0.0, end - start))]
    args += ["-af", f"silencedetect=n={noise_db}dB:d={min_duration}", "-f", "null", "-"]
    proc = subprocess.run(args, capture_output=True, text=True,
                          timeout=_DECODE_TIMEOUT_SECONDS)
    if proc.returncode != 0:
        excerpt = (proc.stderr or "")[-_STDERR_EXCERPT_CHARS:]
        raise RuntimeError(f"ffmpeg silencedetect failed ({path}): {excerpt}")
    window_end = (end - start) if end is not None else None
    intervals = parse_silencedetect(proc.stderr or "", window_end)
    if start:
        intervals = [Interval(start=i.start + start, end=i.end + start)
                     for i in intervals]
    return intervals
