"""Silence-aligned chunk planning for long audio.

Whisper-family backends only accept so much audio per call, so long clips get
sliced into chunk_size-ish pieces before transcription. Cutting exactly on the
chunk_size boundary risks slicing mid-word/mid-sentence, which loses words at
the seam — so we nudge each boundary onto the middle of a nearby detected
silence instead. When nothing quiet is nearby we widen the silence threshold
before giving up and admitting the cut is hard (both are reported as warnings
so the model knows a seam might have dropped audio).
"""

from __future__ import annotations

from computer_use_mcp.video import audio
from computer_use_mcp.video.types import ChunkPlan, ChunkWarning, Interval

# How far a boundary may drift from its ideal chunk_size multiple to land on
# a detected silence. Wide enough to find real pauses, narrow enough that a
# chunk's actual length never surprises the caller by much.
TOLERANCE_SECONDS = 30.0

# Boundary clamps: strictly-increasing is enforced by nudging a snap that
# would land on/before the previous boundary forward by this much rather than
# rejecting it outright — real silences are never this close together.
_EPSILON_SECONDS = 1e-6


def _closest_midpoint(intervals: list[Interval], target: float, tolerance: float) -> float | None:
    """Midpoint of whichever interval in `intervals` is nearest `target`,
    or None if none fall within `tolerance` seconds of it."""
    best: float | None = None
    best_distance = tolerance
    for interval in intervals:
        midpoint = (interval.start + interval.end) / 2.0
        distance = abs(midpoint - target)
        if distance <= best_distance:
            best = midpoint
            best_distance = distance
    return best


def _clamp_boundary(candidate: float, prev_boundary: float, duration: float) -> float:
    """Keep a snapped boundary strictly between the previous boundary and the
    clip end — two ideal boundaries within TOLERANCE_SECONDS of each other
    could otherwise snap to the same (or a crossing) silence midpoint."""
    if candidate <= prev_boundary:
        candidate = prev_boundary + _EPSILON_SECONDS
    if candidate >= duration:
        candidate = duration - _EPSILON_SECONDS
    return candidate


def plan_chunks(
    duration: float,
    *,
    chunk_size: float,
    trigger: float,
    silence_provider,
) -> tuple[list[ChunkPlan], list[ChunkWarning]]:
    """Split [0, duration] into silence-aligned chunks no caller need chunk at
    all below `trigger` seconds. `silence_provider(loose: bool) -> list[Interval]`
    is supplied by the caller (see make_silence_provider) so this stays testable
    without ffmpeg; it is invoked at most once per loose value, only if needed.
    """
    if duration <= trigger:
        return [ChunkPlan(index=0, start=0.0, end=duration, clean_cut=True)], []

    ideal_boundaries: list[float] = []
    boundary = chunk_size
    while boundary < duration:
        ideal_boundaries.append(boundary)
        boundary += chunk_size

    # Cache so a run of boundaries that all miss the default threshold doesn't
    # re-run ffmpeg's loose silencedetect pass once per boundary.
    silence_cache: dict[bool, list[Interval]] = {}

    def silences(loose: bool) -> list[Interval]:
        if loose not in silence_cache:
            silence_cache[loose] = silence_provider(loose)
        return silence_cache[loose]

    chunks: list[ChunkPlan] = []
    warnings: list[ChunkWarning] = []
    chunk_start = 0.0
    for index, ideal in enumerate(ideal_boundaries):
        clean_cut = True
        loose_threshold = False
        snapped = _closest_midpoint(silences(False), ideal, TOLERANCE_SECONDS)
        if snapped is None:
            snapped = _closest_midpoint(silences(True), ideal, TOLERANCE_SECONDS)
            if snapped is not None:
                loose_threshold = True
                warnings.append(ChunkWarning(
                    kind="loose_threshold", chunk_index=index,
                    message=(f"chunk {index}: no silence at the default threshold near "
                             f"{ideal:.1f}s, used a quieter/shorter one instead")))
        if snapped is None:
            snapped = ideal
            clean_cut = False
            warnings.append(ChunkWarning(
                kind="hard_cut", chunk_index=index,
                message=f"chunk {index}: no silence found near {ideal:.1f}s, cutting mid-audio"))

        snapped = _clamp_boundary(snapped, chunk_start, duration)
        chunks.append(ChunkPlan(index=index, start=chunk_start, end=snapped,
                                 clean_cut=clean_cut, loose_threshold=loose_threshold))
        chunk_start = snapped

    # The tail always runs to the real end of the clip — nothing to snap, so
    # nothing to warn about.
    chunks.append(ChunkPlan(index=len(ideal_boundaries), start=chunk_start,
                             end=duration, clean_cut=True))
    return chunks, warnings


def make_silence_provider(path: str, *, start: float = 0.0, end: float | None = None):
    """silence_provider(loose: bool) -> list[Interval] bound to `path`, for
    plan_chunks. loose widens the silencedetect threshold (quieter cutoff,
    shorter minimum run) when the default pass finds nothing near a boundary."""

    def provider(loose: bool) -> list[Interval]:
        if loose:
            return audio.detect_silences(path, noise_db=-30.0, min_duration=0.2,
                                          start=start, end=end)
        return audio.detect_silences(path, noise_db=-40.0, min_duration=0.5,
                                      start=start, end=end)

    return provider
