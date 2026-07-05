"""Tests for computer_use_mcp.video.frames."""

from __future__ import annotations

import pytest
from PIL import Image

from computer_use_mcp.video.frames import (
    calculate_auto_fps,
    extract_frames,
    extract_frames_by_segments,
    get_video_metadata,
)
from computer_use_mcp.video.types import Segment

# ---- calculate_auto_fps -----------------------------------------------------

@pytest.mark.parametrize(
    "duration_seconds,expected",
    [
        (59.9, 2.0),
        (60, 1.0),
        (299, 1.0),
        (300, 0.5),
        (899, 0.5),
        (900, 0.2),
        (3599, 0.2),
        (3600, 0.1),
    ],
)
def test_calculate_auto_fps_boundaries(duration_seconds, expected):
    assert calculate_auto_fps(duration_seconds) == expected


# ---- get_video_metadata ------------------------------------------------------

def test_get_video_metadata_fixture_video(fixture_video):
    meta = get_video_metadata(fixture_video)
    assert abs(meta.duration_seconds - 6.0) < 0.3
    assert meta.width == 320
    assert meta.height == 240
    assert meta.has_audio is True


def test_get_video_metadata_noaudio(fixture_video_noaudio):
    meta = get_video_metadata(fixture_video_noaudio)
    assert meta.has_audio is False


def test_get_video_metadata_missing_file_raises_value_error(tmp_path):
    missing = tmp_path / "does_not_exist.mp4"
    with pytest.raises(ValueError):
        get_video_metadata(str(missing))


# ---- extract_frames ----------------------------------------------------------

def test_extract_frames_basic(fixture_video, tmp_path):
    out_dir = tmp_path / "frames"
    frames = extract_frames(fixture_video, str(out_dir), fps=1, resolution=160)

    assert 5 <= len(frames) <= 7
    for frame in frames:
        assert frame.resolution == 160
        assert frame.format == "jpeg"
        with Image.open(frame.path) as img:
            assert img.width == 160

    assert frames[0].timestamp == "00:00:00"
    # Each subsequent frame is one second after the previous at fps=1.
    for prev, cur in zip(frames, frames[1:]):
        assert abs((cur.seconds - prev.seconds) - 1.0) < 1e-6


def test_extract_frames_with_start_offset(fixture_video, tmp_path):
    out_dir = tmp_path / "frames_offset"
    frames = extract_frames(fixture_video, str(out_dir), fps=1, resolution=160, start=2.0)

    assert frames
    assert frames[0].timestamp == "00:00:02"


def test_extract_frames_unsupported_format_raises(fixture_video, tmp_path):
    with pytest.raises(ValueError):
        extract_frames(fixture_video, str(tmp_path / "bad"), fps=1, resolution=160, fmt="bmp")


# ---- extract_frames_by_segments ----------------------------------------------

def test_extract_frames_by_segments_mixed_resolutions(fixture_video, tmp_path):
    out_dir = tmp_path / "segments"
    segments = [
        Segment(start="00:00:00", end="00:00:03", fps=1, resolution=160),
        Segment(start="00:00:03", end="00:00:06", fps=1, resolution=80),
    ]
    frames = extract_frames_by_segments(fixture_video, str(out_dir), segments, default_resolution=320)

    assert frames
    # Frames must be sorted by seconds across segments.
    seconds = [f.seconds for f in frames]
    assert seconds == sorted(seconds)

    # Each segment's frames land in a distinct subdirectory (no filename collisions).
    dirs_seen = {str(f_path.parent) for f_path in (out_dir.rglob("frame_*.jpg"))}
    assert len(dirs_seen) == 2

    low_res_frames = [f for f in frames if f.resolution == 80]
    high_res_frames = [f for f in frames if f.resolution == 160]
    assert low_res_frames and high_res_frames
    for frame in low_res_frames + high_res_frames:
        assert frame.resolution in (80, 160)
