"""Video understanding MCP tools — a perception layer, not an interpreter.

Turns a local video file or a YouTube URL into things the model can perceive:
frames (returned BOTH as inline MCP images and as on-disk paths) and a
timestamped transcript (local faster-whisper by default — fully offline).
The model does the reasoning; these tools only extract.

Settings live in jarvisd (Settings → Video Understanding; `video_*` keys) and
are re-read on every call, so a knob flipped in the UI applies to the next
tool call without restarting the engine. All failures return {"error": ...}
JSON — a tool never raises at the model.

Known limitation: the `api` brain's tool loop forwards only text content from
tool results, so frame IMAGES reach the claude/codex brains only. The
transcript + metadata (text) work everywhere.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Image

from computer_use_mcp import daemon_client
from computer_use_mcp.video import analyzers
from computer_use_mcp.video import config as vconfig
from computer_use_mcp.video import frames as vframes
from computer_use_mcp.video import platform_info, skill_seed, video_source
from computer_use_mcp.video.backends import faster_whisper_backend
from computer_use_mcp.video.backends import transcribe as vtranscribe
from computer_use_mcp.video.session import manager as vsession
from computer_use_mcp.video.session import manifest as vmanifest
from computer_use_mcp.video.timestamps import format_hms, parse_hms
from computer_use_mcp.video.types import AudioResult, Frame, Segment

_DESCRIBER_AGENT = "video-frame-describer"
_DESCRIBER_POLL_SECONDS = 2.0
_SCRATCH_MAX_AGE_SECONDS = 24 * 3600

FRAME_DESCRIBER_PROMPT = """\
You are a video-frame describer. You receive a list of video frames as
timestamp + image file path pairs. Read each image file and write EXACTLY one
line per frame, in the given order, formatted:

Frame at HH:MM:SS — <1-3 sentence factual description>

Describe what is visible: people (appearance/actions, no identification),
on-screen text/code/UI verbatim where legible, objects, setting, and what
changed compared to the previous frame. Be factual and specific. Do NOT
interpret intent, do NOT summarize the video, do NOT skip frames."""


def _err(exc: Exception) -> str:
    return json.dumps({"error": str(exc)})


def derive_fps(fps: str, *, window_len: float, view_sample: int,
               has_segments: bool) -> float:
    """The fps actually used for extraction.

    Explicit number wins; "auto" + view_sample (and no segments) spreads
    exactly view_sample frames over the window; plain "auto" uses the
    duration-bucketed default table."""
    text = (fps or "auto").strip().lower()
    if text != "auto":
        value = float(text)
        if value <= 0:
            raise ValueError(f"fps must be positive, got {fps!r}")
        return value
    if view_sample > 0 and not has_segments and window_len > 0:
        return view_sample / window_len
    return vframes.calculate_auto_fps(window_len)


def _parse_segments(segments_json: str) -> list[Segment]:
    raw = json.loads(segments_json)
    if not isinstance(raw, list) or not raw:
        raise ValueError("segments must be a non-empty JSON array")
    out = []
    for item in raw:
        out.append(Segment(start=item["start"], end=item["end"],
                           fps=float(item["fps"]),
                           resolution=int(item["resolution"]) if item.get("resolution") else None))
    return out


def _scratch_dir() -> str:
    root = vconfig.video_dir() / "scratch"
    root.mkdir(parents=True, exist_ok=True)
    return tempfile.mkdtemp(prefix="watch-", dir=str(root))


def _sweep_scratch() -> None:
    root = vconfig.video_dir() / "scratch"
    if not root.is_dir():
        return
    cutoff = time.time() - _SCRATCH_MAX_AGE_SECONDS
    for entry in root.iterdir():
        try:
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _startup_maintenance() -> None:
    """Expiry sweeps + skill seeding, once per engine start, off-thread so a
    slow/down daemon can never block engine boot."""
    try:
        cfg = vconfig.load_video_config()
        vsession.clean_expired_sessions(int(cfg["video_session_max_age_days"]))
        video_source.clean_expired_downloads(int(cfg["video_downloads_max_age_days"]))
        _sweep_scratch()
    except Exception:  # noqa: BLE001 — maintenance is best-effort
        pass
    try:
        skill_seed.seed()
    except Exception:  # noqa: BLE001
        pass


def _session_frame_path(video_hash: str, resolution: int, fmt: str,
                        filename: str) -> Path:
    return (vsession.session_dir(video_hash) / "frames" / fmt
            / str(resolution) / filename)


def _index_frames(video_hash: str, video_path: str,
                  frames: list[Frame], fmt: str) -> tuple[dict, list[Frame]]:
    """Copy extracted frames into the session cache layout and merge the
    manifest. Returns (manifest, frames rewritten to their cached paths)."""
    manifest = vsession.load_manifest(video_hash) or vmanifest.new_manifest(
        video_hash, video_path)
    by_resolution: dict[int, list[dict]] = {}
    cached: list[Frame] = []
    for frame in frames:
        filename = vmanifest.frame_filename(frame.timestamp, fmt)
        dest = _session_frame_path(video_hash, frame.resolution, fmt, filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(frame.path, dest)
        by_resolution.setdefault(frame.resolution, []).append(
            {"timestamp": frame.timestamp, "file": filename})
        cached.append(Frame(timestamp=frame.timestamp, seconds=frame.seconds,
                            path=str(dest), resolution=frame.resolution,
                            format=fmt))
    for resolution, rows in by_resolution.items():
        vmanifest.merge_frames(manifest, resolution, fmt, rows)
    vsession.save_manifest(video_hash, manifest)
    return manifest, cached


def _describe_frames(frames: list[Frame], cfg: dict, describer_model: str) -> str:
    """Run the frame-describer subagent over ALL frames in ONE dispatch and
    return its text. Raises on any failure/timeout — the caller falls back to
    returning raw images."""
    daemon_client.call("agents.create", {
        "name": _DESCRIBER_AGENT,
        "description": "Converts video frames into compact factual text descriptions.",
        "when_to_use": "Dispatched automatically by video_watch/video_detail when "
                       "frame_mode=descriptions — not usually called by hand.",
        "system_prompt": FRAME_DESCRIBER_PROMPT,
        "brain": "", "model": "", "profile": "", "tools": [], "color": "",
    }, timeout=10)

    listing = "\n".join(f"- {f.timestamp}: {f.path}" for f in frames)
    params: dict = {
        "agent": _DESCRIBER_AGENT,
        "task": (f"Describe each of these {len(frames)} video frames. Read every "
                 f"image file and output one 'Frame at HH:MM:SS — ...' line per "
                 f"frame, in order:\n{listing}"),
    }
    model = describer_model or str(cfg.get("video_frame_describer_model") or "")
    if model:
        params["model"] = model
    parent = os.environ.get("JARVIS_AGENT_SESSION")
    if parent:
        params["parent_session_id"] = parent
    dispatched = daemon_client.call("agents.dispatch", params, timeout=30)
    session_id = str(dispatched.get("session_id") or "")
    if not session_id:
        raise RuntimeError(f"agents.dispatch returned no session_id: {dispatched}")

    deadline = time.monotonic() + float(cfg.get("video_frame_describer_timeout_sec", 180))
    while time.monotonic() < deadline:
        result = daemon_client.call("agents.result", {"session_id": session_id},
                                    timeout=10)
        if not result.get("running"):
            text = str(result.get("summary") or result.get("result")
                       or result.get("text") or "").strip()
            if text:
                return text
            raise RuntimeError("frame describer finished without output")
        time.sleep(_DESCRIBER_POLL_SECONDS)
    raise TimeoutError(f"frame describer exceeded "
                       f"{cfg.get('video_frame_describer_timeout_sec')}s")


def _load_image(frame: Frame, fmt: str) -> Image:
    with open(frame.path, "rb") as f:
        return Image(data=f.read(), format="jpeg" if fmt == "jpeg" else fmt)


def _audio_branch(local_path: str, source, meta, cfg: dict, *,
                  skip_audio: bool, start: float,
                  end: float | None) -> tuple[AudioResult, str | None]:
    """Captions first (YouTube), whisper fallback. Returns (audio, fallback_reason)."""
    if skip_audio or not meta.has_audio:
        return AudioResult(transcription_source="none"), None
    fallback_reason = None
    if source.kind == "youtube":
        captions = video_source.fetch_captions_for_url(source.url, cfg)
        fallback_reason = video_source.caption_fallback_reason(
            captions, meta.duration_seconds)
        if fallback_reason is None and captions is not None:
            return captions, None
    result = vtranscribe.transcribe_video(
        local_path, duration=meta.duration_seconds, has_audio=True, cfg=cfg,
        start=start, end=end)
    return result, fallback_reason


def register(mcp: FastMCP) -> None:
    threading.Thread(target=_startup_maintenance, daemon=True,
                     name="video-startup").start()

    # ---- INFO ---------------------------------------------------------------
    @mcp.tool()
    def video_info(path: str) -> str:
        """Get a video's metadata WITHOUT processing it — ALWAYS call this first.

        `path` is a local video file (.mp4/.mov/.avi/.mkv/.webm) or a YouTube
        URL (youtube.com / youtu.be — downloaded and cached automatically).
        Returns duration, resolution, codec, fps, size, has_audio, plus YouTube
        title/channel/description when the input was a URL. Cheap: one ffprobe.
        For videos longer than 30s, call video_analyze next — before extracting
        any frames — to plan WHERE to look."""
        try:
            cfg = vconfig.load_video_config()
            local_path, source = video_source.resolve_source(path, cfg)
            meta = vframes.get_video_metadata(local_path)
            return json.dumps({"metadata": meta.to_dict(),
                               "source": source.to_dict()})
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- SETUP --------------------------------------------------------------
    @mcp.tool()
    def video_setup(prewarm: bool = False) -> str:
        """Check the video-understanding stack: platform/GPU/RAM, ffmpeg/ffprobe,
        yt-dlp, every transcription backend, and the current settings. Run this
        when video tools fail, before first use on a new machine, or with
        `prewarm=true` to download/load the configured whisper model NOW so the
        first real video_watch isn't stuck behind a multi-GB download."""
        try:
            cfg = vconfig.load_video_config()
            plat = platform_info.detect_platform()
            lines = ["# Video understanding — setup report", "",
                     f"Platform: {plat['os']}/{plat['arch']}, "
                     f"RAM {plat['ram_gb']}GB, GPU: {plat['gpu'] or 'none'}, "
                     f"python {plat['python']}" + (" (frozen)" if plat["frozen"] else ""),
                     ""]
            for cmd in ("ffmpeg", "ffprobe"):
                found = platform_info.check_command(cmd)
                lines.append(f"- {cmd}: {found or 'MISSING — install: ' + platform_info.ffmpeg_install_hint()}")
            try:
                import yt_dlp
                lines.append(f"- yt-dlp: {yt_dlp.version.__version__} (bundled Python module)")
                if plat["frozen"]:
                    lines.append("  note: frozen builds can't self-update yt-dlp — a stale "
                                 "version is the usual cause of YouTube download failures; "
                                 "update Jarvis to refresh it.")
            except Exception as exc:  # noqa: BLE001
                lines.append(f"- yt-dlp: MISSING ({exc}) — YouTube URLs won't work")
            lines.append("")
            lines.append("Transcription backends:")
            for label, modname in (("faster-whisper (local, default)", "faster_whisper_backend"),
                                   ("whisper-cpp (local CLI)", "whisper_cpp_backend"),
                                   ("openai-whisper (local CLI)", "openai_whisper_backend"),
                                   ("gemini-api (cloud, GEMINI_API_KEY)", "gemini_api_backend"),
                                   ("openai-api (cloud, OPENAI_API_KEY)", "openai_api_backend")):
                try:
                    import importlib
                    mod = importlib.import_module(
                        f"computer_use_mcp.video.backends.{modname}")
                    probe = mod.probe()
                    mark = "OK" if probe.get("available") else "unavailable"
                    lines.append(f"- {label}: {mark} — {probe.get('detail', '')}")
                except Exception as exc:  # noqa: BLE001
                    lines.append(f"- {label}: probe failed ({exc})")
            lines.append("")
            lines.append(f"Recommended whisper model for this RAM: "
                         f"{platform_info.recommend_whisper_model()}")
            lines.append(f"Current settings: backend={cfg['video_backend']}, "
                         f"engine={cfg['video_whisper_engine']}, "
                         f"model={cfg['video_whisper_model']}, "
                         f"device={cfg['video_whisper_device']}, "
                         f"resolution={cfg['video_frame_resolution']}, "
                         f"frame_mode={cfg['video_frame_mode']}, "
                         f"enable_index={cfg['video_enable_index']}")
            lines.append("Frame images reach the claude/codex brains; the api brain "
                         "receives text only (transcript + metadata still work).")
            if prewarm and cfg["video_backend"] == "local" \
                    and cfg["video_whisper_engine"] == "faster-whisper":
                try:
                    model = faster_whisper_backend.ensure_model(cfg)
                    lines.append(f"\nPre-warm: faster-whisper model '{model}' is "
                                 f"downloaded and loads cleanly.")
                except Exception as exc:  # noqa: BLE001
                    lines.append(f"\nPre-warm FAILED: {exc}")
            return "\n".join(lines)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- CONFIGURE ----------------------------------------------------------
    @mcp.tool()
    def video_configure(settings_json: str = "", clear_sessions: bool = False) -> str:
        """Read or change video-understanding settings (they live in Jarvis
        Settings → Video Understanding; this tool edits the same values).

        `settings_json` is a JSON object of the keys to change; call with no
        arguments to just read everything. Keys: video_backend
        (local|gemini-api|openai-api), video_whisper_engine
        (faster-whisper|whisper-cpp|openai-whisper), video_whisper_model
        (auto|tiny|base|small|medium|large-v3-turbo|large-v3),
        video_whisper_device (auto|cpu|cuda), video_frame_mode
        (images|descriptions), video_frame_format (jpeg|png|webp),
        video_frame_resolution (128-2048), video_default_fps ("auto" or a
        number), video_max_frames, video_frame_describer_model,
        video_frame_describer_timeout_sec, video_enable_index (bool),
        video_session_max_age_days, video_downloads_max_age_days,
        video_audio_chunk_{trigger,size,overlap}_seconds, video_gemini_model,
        video_gemini_max_output_tokens. `clear_sessions=true` deletes the
        cached-frames store."""
        try:
            cleared = vconfig.clear_sessions() if clear_sessions else None
            if settings_json:
                cfg = vconfig.update_video_config(json.loads(settings_json))
            else:
                cfg = vconfig.load_video_config()
            out = dict(cfg)
            if cleared is not None:
                out["cleared_sessions"] = cleared
            return json.dumps(out)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- WATCH --------------------------------------------------------------
    @mcp.tool()
    def video_watch(path: str, fps: str = "", resolution: int = 0,
                    frame_mode: str = "", frame_format: str = "",
                    start_time: str = "", end_time: str = "",
                    skip_audio: bool = False, segments_json: str = "",
                    view_sample: int = 0, describer_model: str = "") -> list:
        """WATCH a video: extract frames (returned as images you can SEE) and
        transcribe the audio with timestamps — the main perception tool.

        `path`: local file or YouTube URL. `fps`: number or "auto" (auto picks
        by duration; with `view_sample` it spreads exactly that many frames
        over the window). `start_time`/`end_time`: HH:MM:SS window.
        `segments_json`: JSON array of {"start","end","fps","resolution"?} for
        variable-density extraction (plan these from video_analyze's scene
        changes). `view_sample`: return only N evenly-spaced frames.
        `skip_audio`: frames only. For videos > 2min prefer segments +
        view_sample over one giant extraction — frames are token-expensive.
        YouTube transcripts use the video's own captions when good
        (transcription_source: youtube_subtitles > youtube_auto_captions),
        falling back to the configured whisper backend."""
        try:
            cfg = vconfig.load_video_config()
            local_path, source = video_source.resolve_source(path, cfg)
            meta = vframes.get_video_metadata(local_path)

            start = parse_hms(start_time) if start_time else 0.0
            end = parse_hms(end_time) if end_time else None
            window_end = end if end is not None else meta.duration_seconds
            window_len = max(window_end - start, 0.0)

            segments = _parse_segments(segments_json) if segments_json else None
            fmt = (frame_format or cfg["video_frame_format"]).lower()
            mode = (frame_mode or cfg["video_frame_mode"]).lower()
            res = int(resolution) or int(cfg["video_frame_resolution"])
            max_frames = int(cfg["video_max_frames"])
            used_fps = derive_fps(fps or str(cfg["video_default_fps"]),
                                  window_len=window_len,
                                  view_sample=int(view_sample),
                                  has_segments=bool(segments))

            out_dir = _scratch_dir()
            with ThreadPoolExecutor(max_workers=2) as pool:
                frames_future = pool.submit(
                    lambda: vframes.extract_frames_by_segments(
                        local_path, out_dir, segments,
                        default_resolution=res, fmt=fmt)
                    if segments else vframes.extract_frames(
                        local_path, out_dir, fps=used_fps, resolution=res,
                        start=start, end=end, max_frames=max_frames, fmt=fmt))
                audio_future = pool.submit(
                    _audio_branch, local_path, source, meta, cfg,
                    skip_audio=skip_audio, start=start, end=end)
                frames_list = frames_future.result()
                audio, fallback_reason = audio_future.result()

            session_info = None
            if cfg["video_enable_index"]:
                video_hash = vsession.compute_video_hash(local_path)
                manifest, frames_list = _index_frames(
                    video_hash, local_path, frames_list, fmt)
                session_info = {
                    "video_hash": video_hash,
                    "cached_frames": sum(len(v.get("frames", []))
                                         for v in manifest["resolutions"].values()),
                }

            returned = frames_list
            if view_sample and len(frames_list) > int(view_sample):
                idx = vmanifest.sample_indices(len(frames_list), int(view_sample))
                returned = [frames_list[i] for i in idx]
            elif len(returned) > max_frames:
                idx = vmanifest.sample_indices(len(returned), max_frames)
                returned = [returned[i] for i in idx]

            header: dict = {
                "metadata": meta.to_dict(),
                "source": source.to_dict(),
                "audio": audio.to_dict(),
                "fps_used": used_fps,
                "frames": [{"timestamp": f.timestamp, "path": f.path,
                            "resolution": f.resolution} for f in returned],
                "frames_extracted": len(frames_list),
            }
            if fallback_reason:
                header["transcription_fallback_reason"] = fallback_reason
            if session_info:
                header["session"] = session_info

            if mode == "descriptions" and returned:
                try:
                    text = _describe_frames(returned, cfg, describer_model)
                    return [json.dumps(header), text]
                except Exception as exc:  # noqa: BLE001 — degrade to images
                    header["describer_fallback"] = str(exc)
            return [json.dumps(header)] + [_load_image(f, fmt) for f in returned]
        except Exception as exc:  # noqa: BLE001
            return [_err(exc)]

    # ---- ANALYZE ------------------------------------------------------------
    @mcp.tool()
    def video_analyze(path: str, scene_changes: bool = False,
                      black_intervals: bool = False, silence: bool = False,
                      freeze: bool = False, motion: bool = False,
                      blur: bool = False, exposure: bool = False,
                      loudness: bool = False, transcription: bool = False,
                      start_time: str = "", end_time: str = "") -> str:
        """Analyze a video's STRUCTURE before extracting frames — REQUIRED for
        videos longer than 30s. One fast ffmpeg pass, no images returned.

        Pick filters by question: "what happens?" → scene_changes+silence
        (+transcription); "find transitions" → scene_changes+black_intervals;
        "frozen/stuck parts?" → freeze+blur; "talking head or action?" →
        motion; "when does music start?" → silence+loudness; "lighting?" →
        exposure; "summarize lecture" → transcription+scene_changes+silence.
        Use the scene-change timestamps + transcript to build video_watch's
        `segments_json` (low fps everywhere, high fps only where it matters)."""
        try:
            cfg = vconfig.load_video_config()
            local_path, source = video_source.resolve_source(path, cfg)
            meta = vframes.get_video_metadata(local_path)
            start = parse_hms(start_time) if start_time else 0.0
            end = parse_hms(end_time) if end_time else None

            analysis = analyzers.run_analysis(
                local_path,
                {"scene_changes": scene_changes, "black_intervals": black_intervals,
                 "silence": silence, "freeze": freeze, "motion": motion,
                 "blur": blur, "exposure": exposure, "loudness": loudness},
                start=start, end=end)
            if transcription:
                audio, fallback_reason = _audio_branch(
                    local_path, source, meta, cfg,
                    skip_audio=False, start=start, end=end)
                analysis.transcription = audio
                analysis.audio_warnings = list(audio.warnings)
                if fallback_reason:
                    analysis.audio_warnings = analysis.audio_warnings or []

            result = {"metadata": meta.to_dict(), "source": source.to_dict(),
                      "analysis": analysis.to_dict()}
            if cfg["video_enable_index"]:
                video_hash = vsession.compute_video_hash(local_path)
                manifest = vsession.load_manifest(video_hash) \
                    or vmanifest.new_manifest(video_hash, local_path)
                manifest["analysis"] = analysis.to_dict()
                vsession.save_manifest(video_hash, manifest)
                result["session"] = {"video_hash": video_hash}
            return json.dumps(result)
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    # ---- DETAIL -------------------------------------------------------------
    @mcp.tool()
    def video_detail(path: str, segments_json: str = "", view_json: str = "",
                     view_sample: int = 0, frame_format: str = "",
                     skip_cached: bool = True) -> list:
        """Drill into specific MOMENTS of a video you already watched —
        extraction and viewing are separate so you can extract a wide net once
        and view a few frames at a time (binary-search style; never view
        everything at once).

        `segments_json`: JSON array of {"start","end","fps","resolution"?} to
        EXTRACT (cached on disk when enable_index is on; `skip_cached` skips
        already-cached timestamps). `view_json`: JSON array of "HH:MM:SS"
        timestamps to VIEW from the extracted/cached pool. `view_sample`:
        view N evenly-spaced frames from the pool instead. With neither view
        option, everything just extracted is returned (capped)."""
        try:
            cfg = vconfig.load_video_config()
            local_path, source = video_source.resolve_source(path, cfg)
            fmt = (frame_format or cfg["video_frame_format"]).lower()
            enable_index = bool(cfg["video_enable_index"])
            max_frames = int(cfg["video_max_frames"])

            video_hash = vsession.compute_video_hash(local_path)
            manifest = (vsession.load_manifest(video_hash)
                        or vmanifest.new_manifest(video_hash, local_path)) \
                if enable_index else None

            extracted: list[Frame] = []
            if segments_json:
                segments = _parse_segments(segments_json)
                if enable_index and skip_cached and manifest is not None:
                    segments = [s for s in segments if _segment_uncached(
                        manifest, s, cfg, fmt)]
                if segments:
                    out_dir = _scratch_dir()
                    extracted = vframes.extract_frames_by_segments(
                        local_path, out_dir, segments,
                        default_resolution=int(cfg["video_frame_resolution"]),
                        fmt=fmt)
                    if enable_index:
                        manifest, extracted = _index_frames(
                            video_hash, local_path, extracted, fmt)

            # The viewable pool: what we just extracted, else the whole cache.
            pool: list[Frame] = extracted
            if not pool and manifest is not None:
                pool = []
                for row in vmanifest.viewable_pool(manifest, fmt):
                    frame_path = _session_frame_path(
                        video_hash, int(row["resolution"]), fmt, row["file"])
                    if frame_path.is_file():
                        pool.append(Frame(
                            timestamp=row["timestamp"],
                            seconds=parse_hms(row["timestamp"]),
                            path=str(frame_path),
                            resolution=int(row["resolution"]), format=fmt))
            pool.sort(key=lambda f: f.seconds)

            missing: list[str] = []
            if view_json:
                wanted = [format_hms(parse_hms(t)) for t in json.loads(view_json)]
                by_ts = {f.timestamp: f for f in pool}
                viewed = []
                for ts in wanted:
                    if ts in by_ts:
                        viewed.append(by_ts[ts])
                    else:
                        missing.append(ts)
            elif view_sample:
                idx = vmanifest.sample_indices(len(pool), int(view_sample))
                viewed = [pool[i] for i in idx]
            else:
                viewed = extracted[:max_frames]

            header: dict = {
                "extracted": len(extracted),
                "pool_size": len(pool),
                "viewed": [{"timestamp": f.timestamp, "path": f.path,
                            "resolution": f.resolution} for f in viewed],
            }
            if missing:
                header["missing_timestamps"] = missing
            if enable_index:
                header["session"] = {"video_hash": video_hash}
            return [json.dumps(header)] + [_load_image(f, fmt) for f in viewed]
        except Exception as exc:  # noqa: BLE001
            return [_err(exc)]


def _segment_uncached(manifest: dict, segment: Segment, cfg: dict,
                      fmt: str) -> bool:
    """True when at least one of the segment's expected timestamps is missing
    from the cache (i.e. extraction is still needed)."""
    resolution = segment.resolution or int(cfg["video_frame_resolution"])
    start = parse_hms(segment.start)
    end = parse_hms(segment.end)
    wanted = []
    t = start
    index = 0
    while t < end and index < 10000:
        wanted.append(format_hms(t))
        index += 1
        t = start + index / segment.fps
    return bool(vmanifest.uncached_timestamps(manifest, resolution, fmt, wanted))
