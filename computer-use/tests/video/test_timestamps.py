"""HH:MM:SS parse/format + timeline re-anchoring.

Pure functions, no fixtures needed — parse_hms/format_hms only touch strings
and floats, shift_audio_result only touches the dataclasses in video.types.
"""

from __future__ import annotations

import pytest

from computer_use_mcp.video.timestamps import format_hms, parse_hms, shift_audio_result
from computer_use_mcp.video.types import AudioResult, AudioTag, ChunkWarning, TranscriptionSegment


# ---- parse_hms --------------------------------------------------------------

@pytest.mark.parametrize("value, expected", [
    ("00:00:00", 0.0),
    ("01:02:03", 3723.0),
    ("1:02:03", 3723.0),        # single-digit hour accepted
    ("00:00:01.5", 1.5),        # fractional seconds
])
def test_parse_hms_happy_paths(value, expected):
    assert parse_hms(value) == expected


@pytest.mark.parametrize("value", [
    "90 seconds",   # not HH:MM:SS shape at all
    "1:99:00",      # minutes out of range
    "",             # empty
    "::",           # no digits anywhere
])
def test_parse_hms_rejects(value):
    with pytest.raises(ValueError):
        parse_hms(value)


# ---- format_hms ---------------------------------------------------------------

@pytest.mark.parametrize("seconds, expected", [
    (0, "00:00:00"),
    (59, "00:00:59"),
    (3600, "01:00:00"),
    (3725, "01:02:05"),
    (-5, "00:00:00"),      # negative clamps
    (3725.9, "01:02:05"),  # float floors, does not round
])
def test_format_hms(seconds, expected):
    assert format_hms(seconds) == expected


# ---- round trip ---------------------------------------------------------------

@pytest.mark.parametrize("value", ["00:00:00", "01:02:03", "23:59:59"])
def test_round_trip(value):
    assert format_hms(parse_hms(value)) == value


# ---- shift_audio_result -------------------------------------------------------

def _result() -> AudioResult:
    return AudioResult(
        segments=[
            TranscriptionSegment(start=0.0, end=1.0, text="hello"),
            TranscriptionSegment(start=1.0, end=2.5, text="world"),
        ],
        audio_tags=[AudioTag(start=0.5, end=1.0, tag="music")],
        transcription_source="faster-whisper",
        warnings=[ChunkWarning(kind="hard_cut", chunk_index=0, message="boundary")],
    )


def test_shift_audio_result_shifts_segments_and_tags():
    shifted = shift_audio_result(_result(), 10.0)
    assert [s.start for s in shifted.segments] == [10.0, 11.0]
    assert [s.end for s in shifted.segments] == [11.0, 12.5]
    assert [t.start for t in shifted.audio_tags] == [10.5]
    assert [t.end for t in shifted.audio_tags] == [11.0]


def test_shift_audio_result_preserves_source_and_warnings():
    original = _result()
    shifted = shift_audio_result(original, 10.0)
    assert shifted.transcription_source == original.transcription_source
    assert shifted.warnings == original.warnings
    # Text is untouched by the shift too.
    assert [s.text for s in shifted.segments] == ["hello", "world"]


def test_shift_audio_result_zero_offset_returns_same_object():
    original = _result()
    shifted = shift_audio_result(original, 0)
    assert shifted is original


def test_shift_audio_result_does_not_mutate_original():
    original = _result()
    shift_audio_result(original, 10.0)
    assert original.segments[0].start == 0.0
    assert original.audio_tags[0].start == 0.5
