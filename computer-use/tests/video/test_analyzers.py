"""Tests for computer_use_mcp.video.analyzers.

Parser tests use hand-written fixture strings shaped like real ffmpeg
stderr/metadata output (captured from an actual ffmpeg run while writing
this module) so they never need ffmpeg installed. Only the run_analysis()
integration tests at the bottom need a real ffmpeg binary.
"""

from __future__ import annotations

from computer_use_mcp.video.analyzers import (
    derive_content_profile,
    escape_lavfi_path,
    parse_blackdetect,
    parse_blurdetect_metadata,
    parse_ebur128,
    parse_freezedetect,
    parse_scdet_metadata,
    parse_signalstats_metadata,
    parse_silencedetect,
    parse_siti,
    run_analysis,
)
from computer_use_mcp.video.types import FrameStat, Interval, SceneChange


# ---- escape_lavfi_path ----------------------------------------------------

class TestEscapeLavfiPath:
    def test_windows_path_gets_slashed_and_drive_colon_escaped(self):
        result = escape_lavfi_path("C:\\Users\\x\\v.mp4")
        assert result == "C\\:/Users/x/v.mp4"

    def test_posix_path_passes_through_unchanged(self):
        result = escape_lavfi_path("/tmp/work/video.mp4")
        assert result == "/tmp/work/video.mp4"

    def test_lowercase_drive_letter(self):
        result = escape_lavfi_path("d:\\videos\\clip.mov")
        assert result == "d\\:/videos/clip.mov"

    def test_relative_windows_path_without_drive_letter(self):
        # No leading "X:" so nothing to escape, but backslashes still convert.
        result = escape_lavfi_path("sub\\dir\\file.mp4")
        assert result == "sub/dir/file.mp4"


# ---- parse_scdet_metadata --------------------------------------------------

class TestParseScdetMetadata:
    def test_finds_fired_scene_change(self):
        text = (
            "frame:29   pts:29696   pts_time:2.9\n"
            "lavfi.scd.mafd=0.000\n"
            "lavfi.scd.score=0.000\n"
            "frame:30   pts:30720   pts_time:3\n"
            "lavfi.scd.mafd=15.625\n"
            "lavfi.scd.score=15.625\n"
            "lavfi.scd.time=3\n"
            "frame:31   pts:31744   pts_time:3.1\n"
            "lavfi.scd.mafd=0.000\n"
            "lavfi.scd.score=0.000\n"
        )
        changes = parse_scdet_metadata(text)
        assert changes == [SceneChange(time=3.0, score=15.625)]

    def test_score_present_without_fired_time_is_not_a_scene_change(self):
        # Matches the spec's own example fixture: a score with no
        # lavfi.scd.time line means no cut actually fired on that frame.
        text = "frame:12 pts:12345 pts_time:3.1\nlavfi.scd.score=12.3\n"
        assert parse_scdet_metadata(text) == []

    def test_no_metadata_at_all(self):
        assert parse_scdet_metadata("") == []

    def test_multiple_fired_frames(self):
        text = (
            "frame:10   pts:10240   pts_time:1\n"
            "lavfi.scd.mafd=20.0\n"
            "lavfi.scd.score=20.0\n"
            "lavfi.scd.time=1\n"
            "frame:50   pts:51200   pts_time:5\n"
            "lavfi.scd.mafd=30.0\n"
            "lavfi.scd.score=30.0\n"
            "lavfi.scd.time=5\n"
        )
        changes = parse_scdet_metadata(text)
        assert changes == [SceneChange(time=1.0, score=20.0), SceneChange(time=5.0, score=30.0)]


# ---- parse_blackdetect ------------------------------------------------------

class TestParseBlackdetect:
    def test_single_interval(self):
        text = "[blackdetect @ 0x55d1] black_start:1.2 black_end:2.4 black_duration:1.2\n"
        assert parse_blackdetect(text) == [Interval(start=1.2, end=2.4)]

    def test_multiple_intervals(self):
        text = (
            "[Parsed_blackdetect_0 @ 0x7fd9] black_start:0 black_end:2 black_duration:2\n"
            "[Parsed_blackdetect_0 @ 0x7fd9] black_start:4 black_end:5.9 black_duration:1.9\n"
        )
        assert parse_blackdetect(text) == [
            Interval(start=0.0, end=2.0),
            Interval(start=4.0, end=5.9),
        ]

    def test_no_black_intervals(self):
        assert parse_blackdetect("some unrelated ffmpeg log line\n") == []


# ---- parse_freezedetect ------------------------------------------------------

class TestParseFreezedetect:
    def test_closed_interval(self):
        text = (
            "[Parsed_freezedetect_0 @ 0x7f40] lavfi.freezedetect.freeze_start: 0\n"
            "[Parsed_freezedetect_0 @ 0x7f40] lavfi.freezedetect.freeze_duration: 3\n"
            "[Parsed_freezedetect_0 @ 0x7f40] lavfi.freezedetect.freeze_end: 3\n"
        )
        assert parse_freezedetect(text) == [Interval(start=0.0, end=3.0)]

    def test_unclosed_freeze_dropped_without_duration(self):
        text = "[Parsed_freezedetect_0 @ 0x7f40] lavfi.freezedetect.freeze_start: 3\n"
        assert parse_freezedetect(text) == []

    def test_unclosed_freeze_closed_at_given_duration(self):
        text = "[Parsed_freezedetect_0 @ 0x7f40] lavfi.freezedetect.freeze_start: 3\n"
        assert parse_freezedetect(text, duration=6.0) == [Interval(start=3.0, end=6.0)]

    def test_one_closed_one_unclosed(self):
        text = (
            "lavfi.freezedetect.freeze_start: 0\n"
            "lavfi.freezedetect.freeze_duration: 3\n"
            "lavfi.freezedetect.freeze_end: 3\n"
            "lavfi.freezedetect.freeze_start: 3\n"
        )
        assert parse_freezedetect(text, duration=6.0) == [
            Interval(start=0.0, end=3.0),
            Interval(start=3.0, end=6.0),
        ]


# ---- parse_silencedetect ------------------------------------------------------

class TestParseSilencedetect:
    def test_closed_interval(self):
        text = (
            "[Parsed_silencedetect_0 @ 0x7fd3] silence_start: 3\n"
            "[Parsed_silencedetect_0 @ 0x7fd3] silence_end: 6.016 | silence_duration: 3.016\n"
        )
        assert parse_silencedetect(text) == [Interval(start=3.0, end=6.016)]

    def test_no_silence(self):
        assert parse_silencedetect("nothing interesting here\n") == []


# ---- parse_siti --------------------------------------------------------------

class TestParseSiti:
    def test_takes_last_summary_block(self):
        # Real ffmpeg emits an empty "Total frames: 0" summary during
        # filtergraph negotiation before the real one — must ignore it.
        text = (
            "[Parsed_siti_0 @ 0x1] SITI Summary:\n"
            "Total frames: 0\n"
            "\n"
            "Spatial Information:\n"
            "Average: -nan\n"
            "Max: 0.000000\n"
            "Min: 0.000000\n"
            "\n"
            "Temporal Information:\n"
            "Average: -nan\n"
            "Max: 0.000000\n"
            "Min: 0.000000\n"
            "[Parsed_siti_0 @ 0x2] SITI Summary:\n"
            "Total frames: 60\n"
            "\n"
            "Spatial Information:\n"
            "Average: 142.215775\n"
            "Max: 150.975723\n"
            "Min: 131.861053\n"
            "\n"
            "Temporal Information:\n"
            "Average: 4.356764\n"
            "Max: 18.694952\n"
            "Min: 0.000000\n"
        )
        result = parse_siti(text)
        assert result == {"si": 142.215775, "ti": 4.356764}

    def test_no_summary_returns_zeros(self):
        assert parse_siti("no siti output here\n") == {"si": 0.0, "ti": 0.0}


# ---- parse_ebur128 ------------------------------------------------------------

class TestParseEbur128:
    def test_summary_block(self):
        text = (
            "[Parsed_ebur128_0 @ 0x1] Summary:\n"
            "\n"
            "  Integrated loudness:\n"
            "    I:         -21.9 LUFS\n"
            "    Threshold: -32.0 LUFS\n"
            "\n"
            "  Loudness range:\n"
            "    LRA:         9.9 LU\n"
            "    Threshold: -44.7 LUFS\n"
            "    LRA low:   -31.7 LUFS\n"
            "    LRA high:  -21.8 LUFS\n"
        )
        assert parse_ebur128(text) == {"integrated_lufs": -21.9, "loudness_range_lu": 9.9}

    def test_no_summary_returns_none(self):
        assert parse_ebur128("no ebur128 output here\n") is None


# ---- parse_blurdetect_metadata / parse_signalstats_metadata ------------------

class TestParseBlurdetectMetadata:
    def test_per_frame_blur(self):
        text = (
            "frame:0    pts:0       pts_time:0\n"
            "lavfi.blur=5.109724\n"
            "frame:1    pts:1024    pts_time:0.1\n"
            "lavfi.blur=4.999706\n"
        )
        stats = parse_blurdetect_metadata(text)
        assert stats == [
            FrameStat(time=0.0, blur=5.109724),
            FrameStat(time=0.1, blur=4.999706),
        ]

    def test_nan_blur_is_skipped(self):
        text = "frame:0    pts:0       pts_time:0\nlavfi.blur=-nan\n"
        assert parse_blurdetect_metadata(text) == []


class TestParseSignalstatsMetadata:
    def test_brightness_and_saturation(self):
        text = (
            "frame:0    pts:0       pts_time:0\n"
            "lavfi.signalstats.YMIN=7\n"
            "lavfi.signalstats.YAVG=126.037\n"
            "lavfi.signalstats.SATAVG=87.5794\n"
        )
        stats = parse_signalstats_metadata(text)
        assert stats == [FrameStat(time=0.0, brightness=126.037, saturation=87.5794)]

    def test_no_signalstats_fields(self):
        text = "frame:0    pts:0       pts_time:0\nlavfi.blur=5.0\n"
        assert parse_signalstats_metadata(text) == []


# ---- derive_content_profile -----------------------------------------------

class TestDeriveContentProfile:
    def test_static_low_si_low_ti(self):
        profile = derive_content_profile(si=10.0, ti=1.0)
        assert profile["spatial_complexity"] == "low"
        assert profile["temporal_complexity"] == "low"
        assert profile["label"] == "static"
        assert profile["si"] == 10.0
        assert profile["ti"] == 1.0

    def test_talking_head_high_si_low_ti(self):
        profile = derive_content_profile(si=90.0, ti=2.0)
        assert profile["spatial_complexity"] == "high"
        assert profile["temporal_complexity"] == "low"
        assert profile["label"] == "talking-head / low motion"

    def test_moderate_activity_mid_ti(self):
        profile = derive_content_profile(si=50.0, ti=10.0)
        assert profile["temporal_complexity"] == "medium"
        assert profile["label"] == "moderate activity"

    def test_high_action_high_ti(self):
        profile = derive_content_profile(si=60.0, ti=25.0)
        assert profile["temporal_complexity"] == "high"
        assert profile["label"] == "high action"

    def test_bucket_edges_ti(self):
        assert derive_content_profile(si=0, ti=4.999)["temporal_complexity"] == "low"
        assert derive_content_profile(si=0, ti=5.0)["temporal_complexity"] == "medium"
        assert derive_content_profile(si=0, ti=20.0)["temporal_complexity"] == "medium"
        assert derive_content_profile(si=0, ti=20.001)["temporal_complexity"] == "high"

    def test_bucket_edges_si(self):
        assert derive_content_profile(si=39.999, ti=0)["spatial_complexity"] == "low"
        assert derive_content_profile(si=40.0, ti=0)["spatial_complexity"] == "medium"
        assert derive_content_profile(si=80.0, ti=0)["spatial_complexity"] == "medium"
        assert derive_content_profile(si=80.001, ti=0)["spatial_complexity"] == "high"


# ---- run_analysis integration (needs real ffmpeg) --------------------------

class TestRunAnalysisIntegration:
    def test_scene_change_and_silence_on_fixture_video(self, fixture_video):
        result = run_analysis(
            fixture_video,
            {"scene_changes": True, "silence": True, "black_intervals": True},
        )

        assert result.scene_changes, "expected at least one detected scene change"
        assert any(abs(c.time - 3.0) <= 0.6 for c in result.scene_changes)

        assert result.silence_intervals, "expected at least one silence interval"
        assert any(abs(i.start - 3.0) <= 0.6 for i in result.silence_intervals)

        assert result.black_intervals == []

    def test_noaudio_video_silence_request_does_not_crash(self, fixture_video_noaudio):
        result = run_analysis(fixture_video_noaudio, {"silence": True})
        assert not result.silence_intervals

    def test_no_filters_requested_returns_empty_analysis_without_running_ffmpeg(self, fixture_video):
        result = run_analysis(fixture_video, {})
        assert result.to_dict() == {}
