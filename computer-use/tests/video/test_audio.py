"""Tests for computer_use_mcp.video.audio."""

from __future__ import annotations

import wave

from computer_use_mcp.video.audio import (
    build_extract_args,
    detect_silences,
    extract_audio,
    parse_silencedetect,
)
from computer_use_mcp.video.types import Interval

# ---- build_extract_args (argv shape, no ffmpeg needed) ---------------------


def test_extract_args_seeks_after_input_for_accuracy():
    args = build_extract_args("in.mp4", "out.wav", start=1.5, end=4.0)
    # Accurate (output) seeking requires -ss AFTER -i, unlike frame extraction's
    # fast input seeking — transcription timestamps must be sample-accurate.
    assert args.index("-i") < args.index("-ss")
    assert args.index("-i") < args.index("-to")


def test_extract_args_pcm_16k_mono():
    args = build_extract_args("in.mp4", "out.wav")
    assert "-vn" in args
    assert "-acodec" in args and args[args.index("-acodec") + 1] == "pcm_s16le"
    assert "-ar" in args and args[args.index("-ar") + 1] == "16000"
    assert "-ac" in args and args[args.index("-ac") + 1] == "1"
    assert "-y" in args


def test_extract_args_no_window_omits_ss_and_to():
    args = build_extract_args("in.mp4", "out.wav")
    assert "-ss" not in args
    assert "-to" not in args


def test_extract_args_end_only():
    args = build_extract_args("in.mp4", "out.wav", end=5.0)
    assert "-ss" not in args
    assert args[args.index("-to") + 1] == "5.0"


def test_extract_args_includes_path_and_output():
    args = build_extract_args("in.mp4", "out.wav", start=2.0)
    assert "in.mp4" in args
    assert args[-1] == "out.wav"
    assert args[args.index("-ss") + 1] == "2.0"


# ---- parse_silencedetect (stderr parsing, no ffmpeg needed) ----------------


def test_parse_silencedetect_two_closed_intervals():
    stderr = (
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_end: 2.4 | silence_duration: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 5.0\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_end: 6.75 | silence_duration: 1.75\n"
    )
    intervals = parse_silencedetect(stderr, clip_end=None)
    assert intervals == [Interval(start=1.2, end=2.4), Interval(start=5.0, end=6.75)]


def test_parse_silencedetect_trailing_unclosed_with_clip_end():
    stderr = (
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_end: 2.4 | silence_duration: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 8.0\n"
    )
    intervals = parse_silencedetect(stderr, clip_end=10.0)
    assert intervals == [Interval(start=1.2, end=2.4), Interval(start=8.0, end=10.0)]


def test_parse_silencedetect_trailing_unclosed_without_clip_end_is_dropped():
    stderr = (
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_end: 2.4 | silence_duration: 1.2\n"
        "[Parsed_silencedetect_0 @ 0x1] silence_start: 8.0\n"
    )
    intervals = parse_silencedetect(stderr, clip_end=None)
    assert intervals == [Interval(start=1.2, end=2.4)]


def test_parse_silencedetect_no_silence_lines():
    assert parse_silencedetect("nothing to see here\n", clip_end=None) == []


# ---- integration: real ffmpeg on the fixture -------------------------------


def test_extract_audio_produces_16k_mono_wav(fixture_video, tmp_path):
    out = str(tmp_path / "out.wav")
    result = extract_audio(fixture_video, out)
    assert result == out
    with wave.open(out, "rb") as wav_file:
        assert wav_file.getframerate() == 16000
        assert wav_file.getnchannels() == 1
        assert wav_file.getsampwidth() == 2  # pcm_s16le


def test_extract_audio_windowed(fixture_video, tmp_path):
    out = str(tmp_path / "windowed.wav")
    extract_audio(fixture_video, out, start=1.0, end=2.0)
    with wave.open(out, "rb") as wav_file:
        frames = wav_file.getnframes()
        seconds = frames / wav_file.getframerate()
        assert 0.5 < seconds < 1.5  # ~1 second window, tolerant of encoder rounding


def test_detect_silences_finds_scene_cut_silence(fixture_video):
    intervals = detect_silences(fixture_video)
    assert intervals, "expected at least one detected silence"
    starts = [interval.start for interval in intervals]
    assert any(abs(start - 3.0) <= 0.5 for start in starts)


def test_detect_silences_none_before_silence_starts(fixture_video):
    # Windowing to the tone-only portion should find nothing quiet enough.
    intervals = detect_silences(fixture_video, end=2.5)
    assert intervals == []
