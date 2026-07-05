"""Fixtures for the video-understanding tests.

`fixture_video` is generated with ffmpeg at collection time (never committed):
6.0s, 320x240 — red for 0-3s then blue for 3-6s (one hard scene cut at 3s),
a 440Hz tone for 0-3s then silence for 3-6s. That gives scene detection,
silence detection, frame extraction, and duration math real, known values.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

FIXTURE_DURATION = 6.0
FIXTURE_WIDTH = 320
FIXTURE_HEIGHT = 240
FIXTURE_SCENE_CUT_AT = 3.0     # red -> blue
FIXTURE_SILENCE_FROM = 3.0     # tone ends, silence to EOF


@pytest.fixture(scope="session")
def fixture_video(tmp_path_factory) -> str:
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    out = tmp_path_factory.mktemp("video") / "fixture.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=red:s=320x240:d=3:r=10",
         "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=3:r=10",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=16000",
         "-filter_complex",
         "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]apad=whole_dur=6[a]",
         "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-t", "6", str(out)],
        check=True, capture_output=True)
    return str(out)


@pytest.fixture(scope="session")
def fixture_video_noaudio(tmp_path_factory) -> str:
    """3s video-only clip for the has_audio=False paths."""
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    out = tmp_path_factory.mktemp("video") / "noaudio.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=green:s=320x240:d=3:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True)
    return str(out)
