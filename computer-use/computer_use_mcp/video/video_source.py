"""Local-path validation + YouTube download/captions (yt_dlp PYTHON API).

Turns whatever the caller handed us (a local path or a YouTube URL) into a
real file on disk plus a SourceInfo describing where it came from. YouTube
downloads always go through yt_dlp's Python API — never the CLI binary — so
failures surface as normal Python exceptions and format selection stays under
our control. Downloads are cached by a hash of the URL so re-analyzing the
same video (or the same live session revisiting a clip) reuses the file
instead of re-downloading it.
"""

from __future__ import annotations

import hashlib
import html
import os
import re
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from computer_use_mcp.video import config as vconfig
from computer_use_mcp.video.types import AudioResult, SourceInfo, TranscriptionSegment

_YOUTUBE_HOSTS = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
})

# Preference order when several English-ish caption languages are on offer.
# Checked in order; "any key starting with en" is the last-resort fallback.
_CAPTION_LANG_PREFERENCE = ("en", "en-orig", "en-US", "en-GB")

_DESCRIPTION_MAX_CHARS = 4000

# Matches a WebVTT/SRT cue timing line's two timestamps and ignores any
# trailing VTT cue settings (align:, position:, ...) after the second one.
_CUE_TIME_RE = re.compile(
    r"^\s*((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)")
_TS_RE = re.compile(r"^(?:(\d+):)?(\d+):(\d+)[.,](\d+)$")
_TAG_RE = re.compile(r"<[^>]*>")  # <i>, <c.colorname>, <00:00:01.500> word timing


def is_youtube_url(s: str) -> bool:
    """True for an http(s) URL whose host is a known YouTube domain.

    Exact host match after lowercasing, and port-less only — a URL like
    https://youtube.com:8443/watch is not treated as YouTube."""
    try:
        parsed = urlparse(s)
        if parsed.scheme not in ("http", "https"):
            return False
        if parsed.port is not None:
            return False
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    return host in _YOUTUBE_HOSTS


def resolve_source(path_or_url: str, cfg: dict) -> tuple[str, SourceInfo]:
    """Resolve a caller-provided path/URL to a real local file + its SourceInfo.

    `cfg` is the loaded video config (config.load_video_config()); unused
    today but threaded through so future YouTube knobs (cookies, proxy, ...)
    have somewhere to come from without changing this signature."""
    parsed = urlparse(path_or_url)
    if parsed.scheme in ("http", "https"):
        if not is_youtube_url(path_or_url):
            raise ValueError(
                "only YouTube URLs are supported; download other videos locally first")
        return _resolve_youtube(path_or_url, cfg)

    local_path = Path(path_or_url).expanduser()
    if not local_path.is_file():
        raise FileNotFoundError(f"video file not found: {path_or_url}")
    return str(local_path), SourceInfo(kind="local", path=str(local_path))


def _resolve_youtube(url: str, cfg: dict) -> tuple[str, SourceInfo]:
    downloads_dir = vconfig.downloads_dir()
    url_hash = hashlib.sha256(url.encode()).hexdigest()[:12]

    cached = _find_cached_download(downloads_dir, url_hash)
    if cached is not None:
        os.utime(cached, None)  # fresh mtime so the expiry sweep keeps it
        return str(cached), SourceInfo(kind="youtube", path=str(cached), url=url)

    import yt_dlp  # heavy optional dep — only touched on an actual download

    opts = {
        "noplaylist": True,
        "restrictfilenames": True,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(downloads_dir / f"{url_hash}-%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        # quiet alone still lets the progress bar through to stdout, which
        # would interleave with MCP tool output — silence it explicitly.
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filepath = _extract_filepath(info, ydl)

    source = SourceInfo(
        kind="youtube",
        path=filepath,
        url=url,
        title=info.get("title") or "",
        channel=info.get("uploader") or "",
        duration_string=info.get("duration_string") or "",
        upload_date=info.get("upload_date") or "",
        view_count=int(info.get("view_count") or 0),
        description=(info.get("description") or "")[:_DESCRIPTION_MAX_CHARS],
    )
    choice = choose_caption_track(info)
    if choice is not None:
        source.caption_track, source.captions_manual = choice
    return filepath, source


def _find_cached_download(downloads_dir: Path, url_hash: str) -> Path | None:
    matches = sorted(p for p in downloads_dir.glob(f"{url_hash}-*") if p.is_file())
    return matches[0] if matches else None


def _extract_filepath(info: dict, ydl) -> str:
    requested = info.get("requested_downloads") or []
    if requested and requested[0].get("filepath"):
        return requested[0]["filepath"]
    return ydl.prepare_filename(info)


def choose_caption_track(info: dict) -> tuple[str, bool] | None:
    """Pick the best caption track out of a yt_dlp info dict.

    Manual captions (info["subtitles"]) always beat automatic captions
    (info["automatic_captions"]) — checked as a whole source, not per
    language, so a manual non-preferred English variant still wins over an
    auto-generated plain "en". Returns (lang, is_manual) or None when neither
    source has anything English."""
    for tracks, is_manual in ((info.get("subtitles") or {}, True),
                              (info.get("automatic_captions") or {}, False)):
        lang = _pick_english_lang(tracks)
        if lang is not None:
            return lang, is_manual
    return None


def _pick_english_lang(tracks: dict) -> str | None:
    for lang in _CAPTION_LANG_PREFERENCE:
        if lang in tracks:
            return lang
    for lang in tracks:
        if lang.lower().startswith("en"):
            return lang
    return None


def fetch_youtube_captions(info: dict, lang: str, is_manual: bool) -> AudioResult | None:
    """Fetch + parse the caption track choose_caption_track picked.

    Best-effort: any failure (missing variant, network error, bad content)
    returns None rather than raising — the caller falls back to "no
    transcript" instead of failing the whole request over a caption fetch."""
    try:
        tracks = (info.get("subtitles") if is_manual else info.get("automatic_captions")) or {}
        variant = _pick_subtitle_variant(tracks.get(lang) or [])
        if variant is None:
            return None
        with urllib.request.urlopen(variant["url"], timeout=10) as resp:
            text = resp.read().decode("utf-8", errors="replace")
        segments = parse_subtitle_content(text)
        source = "youtube_subtitles" if is_manual else "youtube_auto_captions"
        return AudioResult(segments=segments, transcription_source=source)
    except Exception:  # noqa: BLE001 — captions are best-effort, never fatal
        return None


def fetch_captions_for_url(url: str, cfg: dict) -> AudioResult | None:
    """Captions-first transcript for a YouTube URL, in one call.

    Re-fetches the metadata-only info dict (cheap, no download — needed
    because resolve_source's cached-download fast path never has one), picks
    the best track and fetches/parses it. Best-effort like
    fetch_youtube_captions: None on any failure, so callers just fall through
    to the whisper backend."""
    try:
        import yt_dlp  # heavy optional dep — only touched for YouTube input

        with yt_dlp.YoutubeDL({"noplaylist": True, "quiet": True,
                               "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        choice = choose_caption_track(info or {})
        if choice is None:
            return None
        return fetch_youtube_captions(info, choice[0], choice[1])
    except Exception:  # noqa: BLE001 — captions are best-effort, never fatal
        return None


def _pick_subtitle_variant(variants: list[dict]) -> dict | None:
    """srt preferred (simplest to parse), else vtt; json3 tracks are skipped
    entirely (variant list won't produce an srt/vtt hit for those)."""
    for wanted_ext in ("srt", "vtt"):
        for variant in variants:
            if variant.get("ext") == wanted_ext:
                return variant
    return None


def parse_subtitle_content(text: str) -> list[TranscriptionSegment]:
    """Parse SRT or WebVTT subtitle text into timestamped segments.

    Scanning for cue-timing lines (rather than splitting on blank lines) lets
    WEBVTT headers, NOTE/STYLE blocks and numeric SRT indices fall out for
    free — none of those look like a "TS --> TS" line so they're just skipped.
    Multi-line cue text is joined with spaces, tags/entities are cleaned, and
    consecutive cues with identical text (auto-captions repeating a line
    while it scrolls) are merged into one segment spanning both."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    segments: list[TranscriptionSegment] = []
    i, n = 0, len(lines)
    while i < n:
        m = _CUE_TIME_RE.match(lines[i])
        if not m:
            i += 1
            continue
        start, end = _parse_ts(m.group(1)), _parse_ts(m.group(2))
        i += 1
        cue_lines = []
        while i < n and lines[i].strip() != "" and not _CUE_TIME_RE.match(lines[i]):
            cue_lines.append(lines[i])
            i += 1
        cue_text = _clean_cue_text(" ".join(cue_lines))
        if not cue_text:
            continue
        if segments and segments[-1].text == cue_text:
            segments[-1] = TranscriptionSegment(
                start=segments[-1].start, end=end, text=cue_text)
        else:
            segments.append(TranscriptionSegment(start=start, end=end, text=cue_text))
    return segments


def _parse_ts(ts: str) -> float:
    m = _TS_RE.match(ts.strip())
    if not m:
        raise ValueError(f"bad subtitle timestamp: {ts!r}")
    h, mnt, sec, frac = m.groups()
    seconds = (int(h) if h else 0) * 3600 + int(mnt) * 60 + int(sec)
    millis = frac.ljust(3, "0")[:3]
    return seconds + int(millis) / 1000.0


def _clean_cue_text(raw: str) -> str:
    without_tags = _TAG_RE.sub("", raw)
    decoded = html.unescape(without_tags)
    return " ".join(decoded.split())


def caption_fallback_reason(captions: AudioResult | None, duration: float) -> str | None:
    """Why captions aren't good enough to stand in for a real transcription,
    or None when they're fine to use as-is.

    Coverage (total cue time / duration) is only checked past 30s — short
    clips legitimately have sparse cues (pauses, intro silence) without that
    meaning the captions are broken."""
    if captions is None:
        return "no_captions"
    if not captions.segments:
        return "empty_captions"
    if duration >= 30:
        covered = sum(seg.end - seg.start for seg in captions.segments)
        coverage = covered / duration if duration else 0.0
        if coverage < 0.5:
            return "low_caption_coverage"
    return None


def clean_expired_downloads(max_age_days: int) -> int:
    """Delete downloaded YouTube files older than max_age_days by mtime.

    Never raises — this runs from best-effort maintenance sweeps, and a
    filesystem hiccup here shouldn't take down whatever triggered it."""
    try:
        downloads_dir = vconfig.downloads_dir()
    except Exception:  # noqa: BLE001
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    try:
        entries = list(downloads_dir.iterdir())
    except OSError:
        return 0
    for p in entries:
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            continue
    return removed
