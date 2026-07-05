"""HH:MM:SS handling + re-anchoring backend timestamps to the video timeline.

Backends transcribe whatever audio slice they were handed, so their timestamps
start at 0 for that slice. Frames extracted with start_time have the same
problem. Everything user-visible must be on the ORIGINAL video timeline —
shift_audio_result() is the single place that correction happens.
"""

from __future__ import annotations

import re
from dataclasses import replace

from computer_use_mcp.video.types import AudioResult

_HMS = re.compile(r"^(\d{1,2}):([0-5]?\d):([0-5]?\d)(?:\.(\d+))?$")


def parse_hms(value: str) -> float:
    """'HH:MM:SS[.fff]' -> seconds. Raises ValueError on anything else."""
    m = _HMS.match(value.strip())
    if not m:
        raise ValueError(f"expected HH:MM:SS, got {value!r}")
    h, mnt, sec, frac = m.groups()
    seconds = int(h) * 3600 + int(mnt) * 60 + int(sec)
    if frac:
        seconds += float(f"0.{frac}")
    return float(seconds)


def format_hms(seconds: float) -> str:
    """Seconds -> 'HH:MM:SS' (floored to whole seconds, never negative)."""
    total = max(0, int(seconds))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def format_hms_frac(seconds: float) -> str:
    """Seconds -> 'HH:MM:SS' or 'HH:MM:SS.mmm' when there is a sub-second part.

    Frame timestamps use this so two frames inside the same second (any fps
    above 1) keep DISTINCT labels — a whole-second format would collide their
    cache filenames and manifest entries, silently dropping frames. parse_hms
    round-trips both shapes."""
    clamped = max(0.0, seconds)
    millis = round(clamped * 1000)
    whole, frac = divmod(millis, 1000)
    base = f"{whole // 3600:02d}:{(whole % 3600) // 60:02d}:{whole % 60:02d}"
    return f"{base}.{frac:03d}" if frac else base


def shift_audio_result(result: AudioResult, offset_seconds: float) -> AudioResult:
    """Return a copy with every segment/tag moved by offset_seconds."""
    if not offset_seconds:
        return result
    return AudioResult(
        segments=[replace(s, start=s.start + offset_seconds,
                          end=s.end + offset_seconds) for s in result.segments],
        audio_tags=[replace(t, start=t.start + offset_seconds,
                            end=t.end + offset_seconds) for t in result.audio_tags],
        transcription_source=result.transcription_source,
        warnings=list(result.warnings),
    )
