"""One-pass ffmpeg structural analysis — scene cuts, black/silent/frozen
spans, motion/complexity, blur, exposure, loudness.

video_analyze wants "what's structurally interesting in this video" without
paying for a transcription pass every time, so every requested analyzer is
folded into as FEW ffmpeg invocations as possible (ideally exactly one: video
filters chained in -vf, audio filters chained in -af, `-f null -` output).
Transcription is deliberately NOT here — that's the tool layer's job, backed
by audio.py/backends/.

Every ffmpeg-output parser below is a pure `text -> parsed values` function so
its behavior is pinned down with hand-written fixture strings — no parser
needs a real ffmpeg run to get test coverage, only run_analysis() does.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass

from computer_use_mcp.video.types import (
    FrameStat,
    Interval,
    SceneChange,
    VideoAnalysis,
)

_PROBE_TIMEOUT = 10
_ANALYSIS_TIMEOUT = 600
_FRAME_STATS_CAP = 200

# filters= key -> the ffmpeg filter expression it turns on. Iterated in this
# fixed order so the composed -vf/-af string is deterministic regardless of
# what order the caller's dict happened to list keys in.
_VIDEO_FILTER_SPECS: dict[str, str] = {
    "scene_changes": "scdet=threshold=10",
    "black_intervals": "blackdetect=d=0.1:pic_th=0.98",
    "freeze": "freezedetect=n=-60dB:d=2",
    "motion": "siti=print_summary=1",
    "blur": "blurdetect",
    "exposure": "signalstats",
}
_AUDIO_FILTER_SPECS: dict[str, str] = {
    "silence": "silencedetect=n=-40dB:d=0.5",
    "loudness": "ebur128",
}
# These analyzers need per-frame data that only comes out via a metadata=
# print sink chained onto the end of -vf (scdet/blurdetect/signalstats don't
# put per-frame numbers in stderr, only in that accumulated metadata stream).
_METADATA_KEYS = ("scene_changes", "blur", "exposure")


@dataclass
class AnalysisRequest:
    """Typed shape for the "which analyzers to run" dict run_analysis() takes.

    A plain dict with these same keys (e.g. from tool-call JSON) works
    identically — run_analysis() only ever calls .get() on `filters`, so
    AnalysisRequest is purely a convenience for callers who want the fields
    spelled out and type-checked."""
    scene_changes: bool = False
    black_intervals: bool = False
    silence: bool = False
    freeze: bool = False
    motion: bool = False
    blur: bool = False
    exposure: bool = False
    loudness: bool = False

    def to_dict(self) -> dict[str, bool]:
        return asdict(self)


# ---- path escaping for lavfi filter option values --------------------------

_DRIVE_LETTER_RE = re.compile(r"^([A-Za-z]):/")


def escape_lavfi_path(p: str) -> str:
    """Make a filesystem path safe as an ffmpeg filtergraph option value.

    lavfi filter options treat ':' as the key/value and option separator and
    '\\' as an escape character, so a raw Windows path like
    'C:\\Users\\x\\v.mp4' breaks parsing on both counts if dropped straight
    into a `metadata=...:file=<path>` option. Convert every backslash to a
    forward slash (ffmpeg and Windows both accept '/' in paths), then escape
    a leading drive letter's colon so it isn't read as an option separator.
    Applied unconditionally — it's a no-op on POSIX paths, which have
    neither backslashes nor drive letters.
    """
    slashed = p.replace("\\", "/")
    return _DRIVE_LETTER_RE.sub(lambda m: f"{m.group(1)}\\:/", slashed)


# ---- probes ------------------------------------------------------------

def probe_has_audio(path: str, timeout: float = _PROBE_TIMEOUT) -> bool:
    """Tiny ffprobe call: True if `path` has at least one audio stream.

    Best-effort — any probe failure (bad file, missing ffprobe, timeout)
    reads as "no audio" so callers just skip audio filters rather than crash.
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(result.stdout.strip())


def probe_duration(path: str, timeout: float = _PROBE_TIMEOUT) -> float:
    """Tiny ffprobe call for the container duration in seconds (0.0 on failure)."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=timeout)
        return float(result.stdout.strip())
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return 0.0


# ---- parsers: metadata=mode=print per-frame stream --------------------

_FRAME_HEADER_RE = re.compile(r"^frame:\d+\s+pts:-?\d+\s+pts_time:(-?[\d.]+)\s*$")
_METADATA_KV_RE = re.compile(r"^lavfi\.([\w.]+)=(.+)$")


def _iter_metadata_frames(text: str):
    """Yield (pts_time, {key: raw_value_str}) per frame block of a
    `metadata=mode=print:file=...` dump. Shared by every per-frame parser
    below since scdet/blurdetect/signalstats all write into the SAME
    accumulated metadata stream when chained in one -vf (see run_analysis) —
    each frame's block carries whichever filters ran upstream of the sink.
    """
    pts_time: float | None = None
    fields: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        header = _FRAME_HEADER_RE.match(line)
        if header:
            if pts_time is not None:
                yield pts_time, fields
            pts_time = float(header.group(1))
            fields = {}
            continue
        kv = _METADATA_KV_RE.match(line)
        if kv:
            fields[kv.group(1)] = kv.group(2)
    if pts_time is not None:
        yield pts_time, fields


def _safe_float(value: str | None) -> float | None:
    """None/missing/"-nan" (blurdetect's warm-up frames) -> None, else float."""
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return None if parsed != parsed else parsed  # NaN != NaN


def parse_scdet_metadata(text: str) -> list[SceneChange]:
    """scdet writes lavfi.scd.{mafd,score} on EVERY frame but only adds
    lavfi.scd.time on the frames where a cut actually fired — keep only those."""
    changes = []
    for pts_time, fields in _iter_metadata_frames(text):
        if "scd.time" not in fields:
            continue
        score = _safe_float(fields.get("scd.score")) or 0.0
        changes.append(SceneChange(time=pts_time, score=score))
    return changes


def parse_blurdetect_metadata(text: str) -> list[FrameStat]:
    stats = []
    for pts_time, fields in _iter_metadata_frames(text):
        blur = _safe_float(fields.get("blur"))
        if blur is not None:
            stats.append(FrameStat(time=pts_time, blur=blur))
    return stats


def parse_signalstats_metadata(text: str) -> list[FrameStat]:
    stats = []
    for pts_time, fields in _iter_metadata_frames(text):
        brightness = _safe_float(fields.get("signalstats.YAVG"))
        saturation = _safe_float(fields.get("signalstats.SATAVG"))
        if brightness is not None or saturation is not None:
            stats.append(FrameStat(time=pts_time, brightness=brightness, saturation=saturation))
    return stats


# ---- parsers: stderr log lines -----------------------------------------

_BLACKDETECT_RE = re.compile(r"black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)")


def parse_blackdetect(text: str) -> list[Interval]:
    """blackdetect logs one line per interval with start+end already paired:
    '[blackdetect @ 0x...] black_start:1.2 black_end:2.4 black_duration:1.2'."""
    return [Interval(start=float(s), end=float(e))
            for s, e in _BLACKDETECT_RE.findall(text)]


_FREEZE_START_RE = re.compile(r"freeze_start:\s*(-?[\d.]+)")
_FREEZE_END_RE = re.compile(r"freeze_end:\s*(-?[\d.]+)")


def parse_freezedetect(text: str, duration: float | None = None) -> list[Interval]:
    """freezedetect logs freeze_start and freeze_end as SEPARATE lines (unlike
    blackdetect), so pair them up in order. A freeze still in effect at EOF
    never gets a matching freeze_end line — when `duration` (the analyzed
    clip's length) is given, that trailing freeze is closed there; otherwise
    it's dropped since there's no way to know where it would have ended."""
    starts = [float(v) for v in _FREEZE_START_RE.findall(text)]
    ends = [float(v) for v in _FREEZE_END_RE.findall(text)]
    intervals = [Interval(start=s, end=e) for s, e in zip(starts, ends)]
    if len(starts) > len(ends) and duration is not None:
        intervals.append(Interval(start=starts[len(ends)], end=duration))
    return intervals


_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?[\d.]+)")


def parse_silencedetect(text: str) -> list[Interval]:
    """Same two-separate-lines shape as freezedetect, but silencedetect always
    closes an in-progress silence at EOF with its own silence_end line, so no
    duration/clip-end fallback is needed here."""
    starts = [float(v) for v in _SILENCE_START_RE.findall(text)]
    ends = [float(v) for v in _SILENCE_END_RE.findall(text)]
    return [Interval(start=s, end=e) for s, e in zip(starts, ends)]


# SITI prints an empty "Total frames: 0" summary during filtergraph negotiation
# BEFORE the real one covering all decoded frames — always take the LAST
# match, which is the one after processing actually finished.
_SITI_BLOCK_RE = re.compile(
    r"Spatial Information:\s*Average:\s*(-?[\d.]+|-?nan).*?"
    r"Temporal Information:\s*Average:\s*(-?[\d.]+|-?nan)",
    re.DOTALL | re.IGNORECASE,
)


def parse_siti(text: str) -> dict[str, float]:
    """siti=print_summary=1's stderr Summary block -> {"si": avg, "ti": avg}."""
    matches = _SITI_BLOCK_RE.findall(text)
    if not matches:
        return {"si": 0.0, "ti": 0.0}
    si_raw, ti_raw = matches[-1]
    si = 0.0 if "nan" in si_raw.lower() else float(si_raw)
    ti = 0.0 if "nan" in ti_raw.lower() else float(ti_raw)
    return {"si": si, "ti": ti}


_EBUR128_I_RE = re.compile(r"Integrated loudness:.*?I:\s+(-?[\d.]+)\s*LUFS", re.DOTALL)
_EBUR128_LRA_RE = re.compile(r"Loudness range:.*?LRA:\s+(-?[\d.]+)\s*LU\b", re.DOTALL)


def parse_ebur128(text: str) -> dict[str, float] | None:
    """ebur128's stderr Summary block -> {"integrated_lufs", "loudness_range_lu"}.
    None when no Summary block is present (e.g. the audio filter never ran)."""
    i_matches = _EBUR128_I_RE.findall(text)
    lra_matches = _EBUR128_LRA_RE.findall(text)
    if not i_matches or not lra_matches:
        return None
    return {
        "integrated_lufs": float(i_matches[-1]),
        "loudness_range_lu": float(lra_matches[-1]),
    }


# ---- content profile ----------------------------------------------------

def derive_content_profile(si: float, ti: float) -> dict:
    """Bucket siti's spatial (si) / temporal (ti) complexity into low/medium/
    high plus a human label. si/ti are unbounded but typically land in
    single/double digits for ordinary video, so:

      ti <  5            -> temporal "low"    (mostly static)
      5 <= ti <= 20       -> temporal "medium" (moderate movement)
      ti > 20             -> temporal "high"   (fast motion / action)
      si <  40            -> spatial "low"     (flat, simple scenes)
      40 <= si <= 80       -> spatial "medium"  (typical detail level)
      si > 80             -> spatial "high"    (busy/detailed/textured)

    The label leans on temporal complexity first (motion reads as "activity"
    more than detail does) with spatial complexity only breaking the tie at
    the static end (a busy still frame isn't a "talking head").
    """
    if ti < 5:
        ti_bucket = "low"
    elif ti <= 20:
        ti_bucket = "medium"
    else:
        ti_bucket = "high"

    if si < 40:
        si_bucket = "low"
    elif si <= 80:
        si_bucket = "medium"
    else:
        si_bucket = "high"

    if ti_bucket == "low":
        label = "static" if si_bucket == "low" else "talking-head / low motion"
    elif ti_bucket == "medium":
        label = "moderate activity"
    else:
        label = "high action"

    return {
        "si": si,
        "ti": ti,
        "spatial_complexity": si_bucket,
        "temporal_complexity": ti_bucket,
        "label": label,
    }


# ---- frame_stats merge + cap --------------------------------------------

def _merge_frame_stats(blur_stats: list[FrameStat], exposure_stats: list[FrameStat]) -> list[FrameStat]:
    """Merge blur-only and brightness/saturation-only samples by nearest
    timestamp. Both lists are usually sampled from the exact same decoded
    frames in the same ffmpeg pass (identical pts_time), so this is normally
    an exact match — nearest-time is just slack for any filter-specific
    rounding, not a real alignment problem."""
    if not blur_stats:
        return list(exposure_stats)
    if not exposure_stats:
        return list(blur_stats)

    merged = []
    used = set()
    for b in blur_stats:
        nearest = min(range(len(exposure_stats)), key=lambda i: abs(exposure_stats[i].time - b.time))
        used.add(nearest)
        e = exposure_stats[nearest]
        merged.append(FrameStat(time=b.time, blur=b.blur, brightness=e.brightness, saturation=e.saturation))
    for i, e in enumerate(exposure_stats):
        if i not in used:
            merged.append(FrameStat(time=e.time, brightness=e.brightness, saturation=e.saturation))
    merged.sort(key=lambda f: f.time)
    return merged


def _cap_frame_stats(stats: list[FrameStat], cap: int = _FRAME_STATS_CAP) -> list[FrameStat]:
    """Evenly downsample to ~`cap` entries so a long video's frame_stats can't
    blow up the JSON payload leaving run_analysis."""
    if len(stats) <= cap:
        return stats
    step = len(stats) / cap
    seen: set[int] = set()
    sampled = []
    for i in range(cap):
        idx = int(i * step)
        if idx not in seen:
            seen.add(idx)
            sampled.append(stats[idx])
    return sampled


# ---- timeline re-anchoring ------------------------------------------------
# run_analysis trims with input-side -ss (see below), which rebases every
# filter's reported pts_time/interval to 0 at the seek point — these put
# everything back on the ORIGINAL video's timeline, matching the convention
# timestamps.shift_audio_result() already uses for transcription.

def _shift_intervals(intervals: list[Interval], offset: float) -> list[Interval]:
    if not offset:
        return intervals
    return [Interval(start=i.start + offset, end=i.end + offset) for i in intervals]


def _shift_scene_changes(changes: list[SceneChange], offset: float) -> list[SceneChange]:
    if not offset:
        return changes
    return [SceneChange(time=c.time + offset, score=c.score) for c in changes]


def _shift_frame_stats(stats: list[FrameStat], offset: float) -> list[FrameStat]:
    if not offset:
        return stats
    return [FrameStat(time=s.time + offset, blur=s.blur, brightness=s.brightness,
                       saturation=s.saturation) for s in stats]


# ---- the one-pass run ----------------------------------------------------

def run_analysis(
    path: str,
    filters: dict,
    *,
    start: float = 0.0,
    end: float | None = None,
    work_dir: str | None = None,
) -> VideoAnalysis:
    """Run every requested structural analyzer in one ffmpeg pass and return
    a merged VideoAnalysis. NOT responsible for transcription — that's the
    tool layer's job (audio.py/backends/).

    `filters` is a plain dict of booleans keyed like AnalysisRequest's fields
    (scene_changes, black_intervals, silence, freeze, motion, blur, exposure,
    loudness); unset/false keys are skipped and their VideoAnalysis field
    stays None (never requested) vs. an empty list (requested, found nothing).

    `start`/`end` are absolute seconds on the video's own timeline. -ss goes
    BEFORE -i (fast input-side seek, same choice frames.py makes) which
    rebases every filter's own timestamps to 0 at the seek point — every
    timestamp this function returns is shifted back by `start` before it
    leaves, so callers always see the ORIGINAL video's timeline.
    """
    video_filters = [spec for key, spec in _VIDEO_FILTER_SPECS.items() if filters.get(key)]
    audio_filters = [spec for key, spec in _AUDIO_FILTER_SPECS.items() if filters.get(key)]

    # No audio stream at all -> audio filters are dropped, not errored on.
    if audio_filters and not probe_has_audio(path):
        audio_filters = []

    if not video_filters and not audio_filters:
        return VideoAnalysis()

    wants_metadata = any(filters.get(key) for key in _METADATA_KEYS)
    tmpdir: str | None = None
    try:
        metadata_path = None
        if wants_metadata:
            tmpdir = tempfile.mkdtemp(dir=work_dir)
            metadata_path = os.path.join(tmpdir, "analysis_meta.txt")
            video_filters = video_filters + [
                f"metadata=mode=print:file={escape_lavfi_path(metadata_path)}"
            ]

        cmd = ["ffmpeg", "-nostdin", "-y", "-loglevel", "info"]
        if start:
            cmd += ["-ss", str(start)]
        cmd += ["-i", path]
        if end is not None:
            cmd += ["-t", str(max(0.0, end - start))]
        if video_filters:
            cmd += ["-vf", ",".join(video_filters)]
        if audio_filters:
            cmd += ["-af", ",".join(audio_filters)]
        cmd += ["-f", "null", "-"]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=_ANALYSIS_TIMEOUT)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg analysis failed: {result.stderr.strip()[-4000:]}")
        stderr = result.stderr

        metadata_text = ""
        if metadata_path and os.path.isfile(metadata_path):
            with open(metadata_path, encoding="utf-8", errors="replace") as f:
                metadata_text = f.read()

        analysis = VideoAnalysis()

        if filters.get("scene_changes"):
            analysis.scene_changes = _shift_scene_changes(
                parse_scdet_metadata(metadata_text), start)

        if filters.get("black_intervals"):
            analysis.black_intervals = _shift_intervals(parse_blackdetect(stderr), start)

        if filters.get("freeze"):
            clip_len = (end - start) if end is not None else max(0.0, probe_duration(path) - start)
            analysis.freeze_intervals = _shift_intervals(
                parse_freezedetect(stderr, duration=clip_len), start)

        if filters.get("motion"):
            siti = parse_siti(stderr)
            analysis.content_profile = derive_content_profile(siti["si"], siti["ti"])

        blur_stats = parse_blurdetect_metadata(metadata_text) if filters.get("blur") else []
        exposure_stats = parse_signalstats_metadata(metadata_text) if filters.get("exposure") else []
        if blur_stats or exposure_stats:
            combined = _merge_frame_stats(blur_stats, exposure_stats)
            analysis.frame_stats = _shift_frame_stats(_cap_frame_stats(combined), start)

        if filters.get("silence"):
            analysis.silence_intervals = _shift_intervals(parse_silencedetect(stderr), start)

        if filters.get("loudness"):
            analysis.loudness_summary = parse_ebur128(stderr)

        return analysis
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
