"""Tests for computer_use_mcp.video.audio_chunker."""

from __future__ import annotations

from computer_use_mcp.video.audio_chunker import TOLERANCE_SECONDS, plan_chunks
from computer_use_mcp.video.types import Interval


def _never_called(loose: bool):
    raise AssertionError("silence_provider should not be called below the trigger")


def test_short_duration_is_a_single_clean_chunk():
    chunks, warnings = plan_chunks(90.0, chunk_size=600, trigger=1200, silence_provider=_never_called)
    assert warnings == []
    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.index == 0
    assert chunk.start == 0.0
    assert chunk.end == 90.0
    assert chunk.clean_cut is True
    assert chunk.loose_threshold is False


def test_duration_equal_to_trigger_is_a_single_chunk():
    chunks, warnings = plan_chunks(1200.0, chunk_size=600, trigger=1200, silence_provider=_never_called)
    assert warnings == []
    assert len(chunks) == 1
    assert chunks[0].end == 1200.0


def _tiling_ok(chunks, duration):
    assert chunks[0].start == 0.0
    assert chunks[-1].end == duration
    for prev, nxt in zip(chunks, chunks[1:]):
        assert prev.end == nxt.start
        assert prev.end > prev.start
    assert chunks[-1].clean_cut is True


def test_boundaries_snap_to_nearby_silence():
    calls = {"default": 0, "loose": 0}

    def provider(loose: bool):
        calls["loose" if loose else "default"] += 1
        return [Interval(590.0, 610.0), Interval(1190.0, 1210.0)]

    chunks, warnings = plan_chunks(1800.0, chunk_size=600, trigger=1200, silence_provider=provider)

    assert warnings == []
    assert len(chunks) == 3
    _tiling_ok(chunks, 1800.0)
    # Both ideal boundaries (600, 1200) had a silence dead center -> exact snap.
    assert chunks[0].end == 600.0
    assert chunks[1].end == 1200.0
    assert all(c.clean_cut for c in chunks)
    assert not any(c.loose_threshold for c in chunks)
    # Default-threshold silences were enough; loose pass never needed.
    assert calls["default"] == 1
    assert calls["loose"] == 0


def test_boundary_found_only_in_loose_pass_warns():
    def provider(loose: bool):
        if loose:
            return [Interval(595.0, 605.0)]
        return []

    chunks, warnings = plan_chunks(900.0, chunk_size=600, trigger=700, silence_provider=provider)

    assert len(chunks) == 2
    _tiling_ok(chunks, 900.0)
    assert chunks[0].end == 600.0  # midpoint of the loose interval
    assert chunks[0].loose_threshold is True
    assert chunks[0].clean_cut is True
    assert len(warnings) == 1
    assert warnings[0].kind == "loose_threshold"
    assert warnings[0].chunk_index == 0


def test_no_silence_anywhere_is_a_hard_cut_at_ideal_boundary():
    def provider(loose: bool):
        return []

    chunks, warnings = plan_chunks(900.0, chunk_size=600, trigger=700, silence_provider=provider)

    assert len(chunks) == 2
    _tiling_ok(chunks, 900.0)
    assert chunks[0].end == 600.0  # ideal boundary kept as-is
    assert chunks[0].clean_cut is False
    assert chunks[0].loose_threshold is False
    assert len(warnings) == 1
    assert warnings[0].kind == "hard_cut"
    assert warnings[0].chunk_index == 0


def test_silence_provider_called_at_most_once_per_loose_value():
    calls = {"default": 0, "loose": 0}

    def provider(loose: bool):
        calls["loose" if loose else "default"] += 1
        if loose:
            return []
        return []  # force every boundary through both passes

    # Three ideal boundaries (600, 1200, 1800), none satisfied even by loose ->
    # each boundary tries default then loose, but the provider itself must
    # only be invoked once per pass regardless of how many boundaries miss.
    chunks, warnings = plan_chunks(2400.0, chunk_size=600, trigger=700, silence_provider=provider)

    assert len(chunks) == 4
    assert calls["default"] == 1
    assert calls["loose"] == 1
    assert len(warnings) == 3
    assert all(w.kind == "hard_cut" for w in warnings)


def test_multiple_boundaries_mixed_outcomes_tile_exactly():
    def provider(loose: bool):
        if loose:
            return [Interval(1195.0, 1205.0)]  # only the 2nd boundary, loose
        return [Interval(597.0, 603.0)]         # only the 1st boundary, default

    # boundaries at 600, 1200, 1800; 1800 has nothing at all -> hard cut
    chunks, warnings = plan_chunks(2400.0, chunk_size=600, trigger=700, silence_provider=provider)

    assert len(chunks) == 4
    _tiling_ok(chunks, 2400.0)
    assert chunks[0].end == 600.0
    assert chunks[0].clean_cut is True
    assert chunks[0].loose_threshold is False

    assert chunks[1].end == 1200.0
    assert chunks[1].clean_cut is True
    assert chunks[1].loose_threshold is True

    assert chunks[2].end == 1800.0
    assert chunks[2].clean_cut is False
    assert chunks[2].loose_threshold is False

    kinds = sorted(w.kind for w in warnings)
    assert kinds == ["hard_cut", "loose_threshold"]


def test_silence_outside_tolerance_is_ignored():
    # Interval midpoint is 40s away from the ideal 600s boundary, i.e. beyond
    # TOLERANCE_SECONDS (30) -> should not be used, falls through to hard cut.
    assert TOLERANCE_SECONDS == 30.0

    def provider(loose: bool):
        return [Interval(635.0, 645.0)]  # midpoint 640, 40s from 600

    chunks, warnings = plan_chunks(900.0, chunk_size=600, trigger=700, silence_provider=provider)
    assert chunks[0].end == 600.0
    assert chunks[0].clean_cut is False
    assert warnings[0].kind == "hard_cut"


def test_boundaries_stay_strictly_increasing_when_snaps_collide():
    # With a small chunk_size relative to TOLERANCE_SECONDS, two different
    # ideal boundaries (40 and 80) can both fall within 30s of the SAME
    # silence (midpoint 70) — the clamp must still keep the sequence
    # strictly increasing and the chunks must still tile exactly.
    def provider(loose: bool):
        return [Interval(65.0, 75.0)]

    chunks, warnings = plan_chunks(130.0, chunk_size=40, trigger=50, silence_provider=provider)

    _tiling_ok(chunks, 130.0)
    assert len(chunks) == 4  # boundaries at 40, 80, 120
    assert chunks[0].end == 70.0
    assert chunks[0].clean_cut is True
    # Second boundary collided with the same silence -> clamped forward of it.
    assert chunks[1].end > chunks[0].end
    assert chunks[1].clean_cut is True
    # Third boundary (ideal 120) is 50s from the only silence -> beyond
    # tolerance in both passes -> hard cut at the ideal boundary.
    assert chunks[2].end == 120.0
    assert chunks[2].clean_cut is False
    assert warnings and warnings[-1].kind == "hard_cut"
