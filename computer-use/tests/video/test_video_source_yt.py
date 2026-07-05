"""Tests for video_source.py — local-path resolution + YouTube (yt_dlp API).

No network in default runs: the YouTube download path is exercised through a
fake yt_dlp module monkeypatched into sys.modules. The one real-network test
is gated behind VIDEO_NET_TESTS.
"""

from __future__ import annotations

import os
import sys
import time
import types

import pytest

from computer_use_mcp.video import video_source as vs
from computer_use_mcp.video.types import AudioResult, TranscriptionSegment

# ---- is_youtube_url ---------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://youtube.com/watch?v=abc123",
    "http://youtube.com/watch?v=abc123",
    "https://www.youtube.com/watch?v=abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://music.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
    "http://youtu.be/abc123",
])
def test_is_youtube_url_positive(url):
    assert vs.is_youtube_url(url) is True


@pytest.mark.parametrize("url", [
    "https://vimeo.com/12345",
    "/local/path/video.mp4",
    "ftp://youtube.com/video.mp4",
    "https://notyoutube.com/watch?v=abc123",
    "https://youtube.com.evil.com/watch?v=abc",
    "https://youtube.com:8443/watch?v=abc123",  # port present -> rejected
])
def test_is_youtube_url_negative(url):
    assert vs.is_youtube_url(url) is False


# ---- parse_subtitle_content --------------------------------------------------

_SRT_SAMPLE = """1
00:00:01,000 --> 00:00:04,000
<i>Hello &amp; welcome</i>

2
00:00:04,500 --> 00:00:07,000
to the show
"""

_VTT_SAMPLE = """WEBVTT
Kind: captions
Language: en

NOTE
this is a note block, not a cue

00:00:00.000 --> 00:00:02.000
<c>hello</c><00:00:00.500><c> world</c>

00:00:02.000 --> 00:00:04.000
hello world

00:00:04.000 --> 00:00:06.000
hello world

00:01:06.000 --> 00:01:08.500
next line here
"""


def test_parse_subtitle_content_srt():
    segments = vs.parse_subtitle_content(_SRT_SAMPLE)
    assert segments == [
        TranscriptionSegment(start=1.0, end=4.0, text="Hello & welcome"),
        TranscriptionSegment(start=4.5, end=7.0, text="to the show"),
    ]


def test_parse_subtitle_content_vtt_dedup_and_tags():
    segments = vs.parse_subtitle_content(_VTT_SAMPLE)
    # the three "hello world" cues (one word-timed, two repeats) collapse
    # into a single segment spanning from the first cue's start to the last
    # dupe's end; the differently-worded final cue stays separate.
    assert len(segments) == 2
    assert segments[0].start == 0.0
    assert segments[0].end == 6.0
    assert segments[0].text == "hello world"
    assert segments[1] == TranscriptionSegment(
        start=66.0, end=68.5, text="next line here")


def test_parse_subtitle_content_short_form_timestamp():
    # MM:SS.mmm (no hours) is valid inside a VTT cue timing line.
    vtt = "WEBVTT\n\n01:02.500 --> 01:05.000\nshort form line\n"
    segments = vs.parse_subtitle_content(vtt)
    assert segments == [TranscriptionSegment(start=62.5, end=65.0, text="short form line")]


def test_parse_subtitle_content_empty_and_blank_cues_skipped():
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\ntext\n"
    segments = vs.parse_subtitle_content(vtt)
    assert segments == [TranscriptionSegment(start=3.0, end=4.0, text="text")]


# ---- choose_caption_track ----------------------------------------------------

def test_choose_caption_track_manual_beats_auto():
    info = {
        "subtitles": {"en": [{"ext": "vtt", "url": "https://x/manual.vtt"}]},
        "automatic_captions": {"en": [{"ext": "vtt", "url": "https://x/auto.vtt"}]},
    }
    assert vs.choose_caption_track(info) == ("en", True)


def test_choose_caption_track_falls_back_to_en_us():
    info = {
        "subtitles": {"en-US": [{"ext": "vtt", "url": "https://x/manual.vtt"}]},
        "automatic_captions": {},
    }
    assert vs.choose_caption_track(info) == ("en-US", True)


def test_choose_caption_track_falls_back_to_auto_when_manual_not_english():
    info = {
        "subtitles": {"de": [{"ext": "vtt", "url": "https://x/de.vtt"}]},
        "automatic_captions": {"en": [{"ext": "vtt", "url": "https://x/auto.vtt"}]},
    }
    assert vs.choose_caption_track(info) == ("en", False)


def test_choose_caption_track_none_when_nothing_english():
    info = {
        "subtitles": {"fr": [{"ext": "vtt", "url": "https://x/fr.vtt"}]},
        "automatic_captions": {"de": [{"ext": "vtt", "url": "https://x/de.vtt"}]},
    }
    assert vs.choose_caption_track(info) is None


# ---- caption_fallback_reason --------------------------------------------------

def test_caption_fallback_reason_none_captions():
    assert vs.caption_fallback_reason(None, 60.0) == "no_captions"


def test_caption_fallback_reason_empty_segments():
    result = AudioResult(segments=[], transcription_source="youtube_subtitles")
    assert vs.caption_fallback_reason(result, 60.0) == "empty_captions"


def test_caption_fallback_reason_low_coverage_long_video():
    # 60s video, only 10s of cue coverage -> well under the 50% floor.
    result = AudioResult(
        segments=[TranscriptionSegment(start=0.0, end=10.0, text="hi")],
        transcription_source="youtube_subtitles")
    assert vs.caption_fallback_reason(result, 60.0) == "low_caption_coverage"


def test_caption_fallback_reason_fine_on_short_video():
    # 10s video with only 2s of cue coverage would fail the 50% floor, but
    # duration < 30s means coverage isn't checked at all.
    result = AudioResult(
        segments=[TranscriptionSegment(start=0.0, end=2.0, text="hi")],
        transcription_source="youtube_subtitles")
    assert vs.caption_fallback_reason(result, 10.0) is None


def test_caption_fallback_reason_fine_on_good_coverage():
    result = AudioResult(
        segments=[TranscriptionSegment(start=0.0, end=55.0, text="hi")],
        transcription_source="youtube_subtitles")
    assert vs.caption_fallback_reason(result, 60.0) is None


# ---- resolve_source: local paths ---------------------------------------------

def test_resolve_source_local_file_ok(tmp_path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"not really a video")
    path, info = vs.resolve_source(str(f), {})
    assert path == str(f)
    assert info.kind == "local"
    assert info.path == str(f)


def test_resolve_source_missing_file_raises(tmp_path):
    missing = tmp_path / "nope.mp4"
    with pytest.raises(FileNotFoundError):
        vs.resolve_source(str(missing), {})


def test_resolve_source_non_youtube_url_raises():
    with pytest.raises(ValueError, match="only YouTube URLs"):
        vs.resolve_source("https://vimeo.com/12345", {})


# ---- resolve_source: YouTube (fake yt_dlp) -----------------------------------

class _FakeYoutubeDL:
    """Stand-in for yt_dlp.YoutubeDL that never touches the network: writes a
    placeholder file at the resolved outtmpl and counts invocations so tests
    can assert the cache short-circuits a second resolve_source call."""

    call_count = 0

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        type(self).call_count += 1
        filepath = self.opts["outtmpl"].replace("%(id)s", "vid123").replace("%(ext)s", "mp4")
        from pathlib import Path
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)
        Path(filepath).write_bytes(b"fake downloaded video")
        return {
            "id": "vid123",
            "title": "A Test Video",
            "uploader": "A Test Channel",
            "duration_string": "5:00",
            "upload_date": "20260101",
            "view_count": 4242,
            "description": "x" * 5000,  # exercise the 4000-char truncation
            "requested_downloads": [{"filepath": filepath}],
            "subtitles": {"en": [{"ext": "vtt", "url": "https://x/manual.vtt"}]},
            "automatic_captions": {},
        }

    def prepare_filename(self, info):  # pragma: no cover — fallback path only
        return self.opts["outtmpl"]


@pytest.fixture
def fake_yt_dlp(monkeypatch):
    _FakeYoutubeDL.call_count = 0
    module = types.ModuleType("yt_dlp")
    module.YoutubeDL = _FakeYoutubeDL
    monkeypatch.setitem(sys.modules, "yt_dlp", module)
    return module


@pytest.fixture
def isolated_downloads_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "jarvis-data"))
    return tmp_path / "jarvis-data" / "video" / "downloads"


def test_resolve_source_youtube_downloads_and_fills_metadata(fake_yt_dlp, isolated_downloads_dir):
    url = "https://www.youtube.com/watch?v=vid123"
    path, info = vs.resolve_source(url, {})

    assert _FakeYoutubeDL.call_count == 1
    assert os.path.isfile(path)
    assert info.kind == "youtube"
    assert info.url == url
    assert info.title == "A Test Video"
    assert info.channel == "A Test Channel"
    assert info.view_count == 4242
    assert len(info.description) == 4000
    assert info.caption_track == "en"
    assert info.captions_manual is True


def test_resolve_source_youtube_cache_hit_short_circuits(fake_yt_dlp, isolated_downloads_dir):
    url = "https://www.youtube.com/watch?v=vid123"
    first_path, _ = vs.resolve_source(url, {})
    assert _FakeYoutubeDL.call_count == 1

    # Make the cached file look stale, then resolve again.
    old_time = time.time() - 999_999
    os.utime(first_path, (old_time, old_time))

    second_path, info = vs.resolve_source(url, {})

    assert _FakeYoutubeDL.call_count == 1  # no second "download"
    assert second_path == first_path
    assert info.kind == "youtube"
    # mtime was touched fresh by the cache-hit path.
    assert os.stat(second_path).st_mtime > old_time + 1000


# ---- clean_expired_downloads --------------------------------------------------

def test_clean_expired_downloads_removes_old_files_only(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "jarvis-data"))
    from computer_use_mcp.video import config as vconfig
    ddir = vconfig.downloads_dir()

    old_file = ddir / "old-vid.mp4"
    new_file = ddir / "new-vid.mp4"
    old_file.write_bytes(b"old")
    new_file.write_bytes(b"new")

    old_time = time.time() - (10 * 86400)  # 10 days old
    os.utime(old_file, (old_time, old_time))

    removed = vs.clean_expired_downloads(max_age_days=7)

    assert removed == 1
    assert not old_file.exists()
    assert new_file.exists()


def test_clean_expired_downloads_never_raises_on_missing_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "does-not-exist-parent"))
    monkeypatch.setattr(
        "computer_use_mcp.video.config.downloads_dir",
        lambda: tmp_path / "does-not-exist-parent" / "missing")
    assert vs.clean_expired_downloads(max_age_days=7) == 0


# ---- optional real-network test ----------------------------------------------

@pytest.mark.skipif(not os.environ.get("VIDEO_NET_TESTS"), reason="network")
def test_resolve_source_real_youtube_download(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "jarvis-data"))
    # A short, stable, public clip (Big Buck Bunny trailer). Real network I/O.
    url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
    path, info = vs.resolve_source(url, {})
    assert os.path.isfile(path)
    assert info.kind == "youtube"
    assert info.title
