"""Shared dataclasses for the video subsystem.

Everything crossing a module boundary lives here so frames/audio/analyzers/
backends agree on shapes without importing each other. Keep these plain
(dataclasses + primitives) — they get asdict()'d into tool JSON at the edge.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class VideoMetadata:
    """ffprobe-derived facts about one video file."""
    path: str
    duration_seconds: float
    width: int
    height: int
    codec: str
    fps: float
    size_bytes: int
    has_audio: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Frame:
    """One extracted frame on disk. `timestamp` is HH:MM:SS on the ORIGINAL
    video timeline (not the extracted slice)."""
    timestamp: str
    seconds: float
    path: str
    resolution: int = 0     # scale width it was extracted at
    format: str = "jpeg"


@dataclass
class Segment:
    """A caller-requested extraction window with its own density."""
    start: str              # HH:MM:SS
    end: str                # HH:MM:SS
    fps: float
    resolution: int | None = None


@dataclass
class TranscriptionSegment:
    start: float            # seconds on the original timeline
    end: float
    text: str


@dataclass
class AudioTag:
    """Non-speech event (music, applause, ...) — Gemini/whisper-at only."""
    start: float
    end: float
    tag: str


@dataclass
class ChunkWarning:
    """Something worth telling the model about long-audio chunking."""
    kind: str               # hard_cut | loose_threshold | chunk_failed
    chunk_index: int
    message: str


@dataclass
class AudioResult:
    """Transcription of (a slice of) a video, timestamps in seconds relative
    to whatever audio the backend was handed — shift_audio_result() re-anchors
    to the original timeline before anything leaves the tool layer."""
    segments: list[TranscriptionSegment] = field(default_factory=list)
    audio_tags: list[AudioTag] = field(default_factory=list)
    transcription_source: str = ""   # faster-whisper | whisper-cpp | openai-whisper
                                     # | gemini-api | openai-api
                                     # | youtube_subtitles | youtube_auto_captions | none
    warnings: list[ChunkWarning] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChunkPlan:
    """One planned slice of long audio (silence-aligned when possible)."""
    index: int
    start: float
    end: float
    clean_cut: bool = True   # boundary landed on detected silence
    loose_threshold: bool = False


@dataclass
class SceneChange:
    time: float
    score: float


@dataclass
class Interval:
    start: float
    end: float


@dataclass
class FrameStat:
    """Per-sampled-frame quality stats from blurdetect/signalstats."""
    time: float
    blur: float | None = None
    brightness: float | None = None
    saturation: float | None = None


@dataclass
class VideoAnalysis:
    """Structural pre-analysis (video_analyze) — everything optional; only the
    requested analyzers fill in."""
    scene_changes: list[SceneChange] | None = None
    black_intervals: list[Interval] | None = None
    silence_intervals: list[Interval] | None = None
    freeze_intervals: list[Interval] | None = None
    content_profile: dict[str, Any] | None = None    # from siti (motion/complexity)
    frame_stats: list[FrameStat] | None = None
    loudness_summary: dict[str, float] | None = None  # mean LUFS, loudness range
    transcription: AudioResult | None = None
    audio_warnings: list[ChunkWarning] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        # Drop ONLY None (analyzer not requested). An empty list must survive:
        # it means the analyzer RAN and found nothing, which the model needs
        # to distinguish from "you never asked for this". audio_warnings is
        # the exception — it defaults to [] rather than None, so empty just
        # means "nothing to warn about" and stays out of the JSON.
        d = asdict(self)
        if not d.get("audio_warnings"):
            d.pop("audio_warnings", None)
        return {k: v for k, v in d.items() if v is not None}


@dataclass
class SourceInfo:
    """Where a video came from (YouTube metadata when downloaded)."""
    kind: str                # local | youtube
    path: str                # resolved local file
    url: str = ""
    title: str = ""
    channel: str = ""
    duration_string: str = ""
    upload_date: str = ""
    view_count: int = 0
    description: str = ""
    caption_track: str = ""  # language code of the chosen caption track, if any
    captions_manual: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v not in ("", 0, False)} | {
            "kind": self.kind, "path": self.path}
