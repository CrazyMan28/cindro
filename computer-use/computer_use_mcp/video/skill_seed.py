"""Seeds the built-in "video" skill + its two slash commands into jarvisd.

Jarvis has no repo-side builtin-skill loader (skills/commands live in the
daemon's store, ~/.local/share/jarvis/skills + /commands), so the engine has
to write these in at startup, on every machine — including a frozen Windows
install where there is no repo checkout to seed FROM. seed() is the one
entry point for that: it is safe to call unconditionally on every engine
boot because it is idempotent (checks before writing) and never raises.

Nothing here talks to ffmpeg/yt-dlp/whisper — it only talks to jarvisd via
computer_use_mcp.daemon_client, using the exact verbs create_skill/
create_slash_command already use (skills.create, skills.get, command.list,
command.create, command.remove).
"""

from __future__ import annotations

from computer_use_mcp import daemon_client

SKILL_NAME = "video"
SKILL_GROUP = "builtin"

SKILL_DESCRIPTION = (
    "Use when the user pastes a YouTube URL or a video file path "
    "(.mp4/.mov/.avi/.mkv/.webm), or asks to watch, analyze, review, "
    "or summarize a video."
)

# The leading line is a version marker, not a heading — seed() diffs it
# against whatever body is already installed to decide create/exists/update.
# Bump it ("v2", "v3", ...) whenever SKILL_BODY's guidance changes so
# existing installs pick up the edit instead of keeping a stale copy forever.
SKILL_BODY = """[video skill v1]
# Video understanding

Six tools on this MCP server turn a local file or a YouTube URL into things
you can actually perceive — frames and a transcript — rather than a black box.

## The tools

- `video_info` — cheap ffprobe facts: duration, resolution, fps, has_audio.
- `video_analyze` — one ffmpeg pass over the whole video for STRUCTURE:
  scene changes, black/silence/freeze intervals, motion, loudness, exposure —
  without extracting a single frame image.
- `video_watch` — the main entry point: extracts frames (+ transcribes audio)
  and returns a session you can keep referring back to.
- `video_detail` — zooms into a narrow time window of an existing session at
  higher density, for when the overview wasn't enough.
- `video_setup` — checks ffmpeg/whisper/GPU are actually installed and
  working, and pre-warms the configured model.
- `video_configure` — reads/writes the video_* settings (backend, whisper
  engine/model/device, frame resolution/format/mode) one key at a time.

## Standard workflow

1. ALWAYS call `video_info` first — it's nearly free and tells you duration,
   whether there's audio, and the native resolution, which everything else
   depends on.
2. If the video is longer than 30 seconds, call `video_analyze` BEFORE
   extracting any frames. Use its scene_changes/silence/motion output (plus
   the transcript once you have one) to decide where dense frame sampling is
   worth the tokens and where it isn't — don't guess a flat fps for a whole
   long video.
3. Call `video_watch`. For short videos, fps "auto" is fine. For long
   videos, pass segments built from step 2's analysis (dense fps around
   scene changes/motion, sparse elsewhere) and use view_sample rather than
   pulling every frame into context at once.
4. Drill into specific moments with `video_detail`, using narrow 3-5 second
   windows and view_sample 3 first. Treat this like binary search — narrow
   the window again if you still can't see what you need; never dump every
   frame in a long stretch just to look around.
5. On follow-up questions about the same video, reuse the session manifest
   you already have instead of re-extracting frames or re-transcribing audio.

## Question type -> which analyzers to reach for

| Question sounds like...              | Use these analyzers                    |
|---------------------------------------|-----------------------------------------|
| "What happens in this video?"         | scene_changes + silence (+ transcription) |
| "Find the scene transitions"          | scene_changes + black_intervals         |
| "Are there frozen/stuck parts?"       | freeze + blur                           |
| "Is this a talking head or action?"   | motion                                  |
| "When does the music start?"          | silence + loudness                      |
| "How's the lighting?"                 | exposure                                |
| "Summarize this lecture"              | transcription + scene_changes + silence |

## Token guidance

Frames are the expensive part — spend them where they matter:
- Long or mostly-static content: low fps, 0.1-0.5, is usually enough.
- High fps (1-3) only around scene changes, motion peaks, or a moment the
  transcript points at directly ("look at this", "as you can see here").
- Frame resolution: 512 is the default and is enough for composition/action.
  Only go to 1024 when you need to read on-screen text.
- Format: png for screen recordings (crisp text/UI edges); jpeg elsewhere.

## YouTube

Paste the URL straight into `path` on any tool — download and captions are
handled automatically, nothing extra to do. When a transcript exists, weigh
transcription_source: `youtube_subtitles` (manually authored) is stronger
evidence than `youtube_auto_captions` (ASR-generated by YouTube). Local
whisper is the fallback and kicks in automatically when captions are missing
or too thin to be useful.

## Privacy

The default transcription backend is local whisper — audio never leaves the
machine. It only leaves if the user has explicitly switched Settings to a
cloud backend (gemini-api/openai-api) via `video_configure`.

## Known limitation

Frame IMAGES only reach the claude and codex brains. The api brain currently
receives text only (transcript + metadata still work fine there) — don't
promise it frame-level visual detail.
"""

WATCH_VIDEO_COMMAND_NAME = "watch-video"
SETUP_VIDEO_COMMAND_NAME = "setup-video-vision"

WATCH_VIDEO_COMMAND_DESCRIPTION = (
    "Watch a video file or YouTube URL and answer a question about it (or "
    "give a structured summary)."
)

SETUP_VIDEO_COMMAND_DESCRIPTION = (
    "Interactive wizard to configure the video backend/model and verify "
    "ffmpeg/whisper are ready."
)

# action_kind="prompt" bodies are injected as a chat turn with {{ARGS}}
# substituted (see create_slash_command's docstring) — so these read as
# instructions TO the model, not documentation for a human.
WATCH_VIDEO_COMMAND = """The user ran /watch-video {{ARGS}}

Parse {{ARGS}} as `<path-or-url> [question]`: the first whitespace-separated
token (or quoted chunk) is a local file path or a YouTube URL, and whatever
text follows it is the user's question about the video. If {{ARGS}} is a bare
path/URL with no trailing text, there is no explicit question.

Load and follow the "video" skill's workflow (video_info first, video_analyze
before frames for anything over 30s, then video_watch/video_detail as
needed) against that path-or-url. If the user asked a question, answer it
using what you extracted, citing timestamps. If they didn't, give a
structured summary instead: what the video is, its duration, and a short
timeline of the notable moments you found."""

SETUP_VIDEO_COMMAND = """The user ran /setup-video-vision {{ARGS}}

Run the video subsystem's setup wizard. If {{ARGS}} contains "defaults"
(case-insensitive), skip straight to the dependency check below — don't ask
anything.

Otherwise ask ONE question at a time, waiting for the answer before the
next, and write each answer through `video_configure` as you get it:
1. Backend: local / gemini-api / openai-api?
2. If local: whisper engine (faster-whisper / whisper-cpp / openai-whisper),
   model size (tiny..large-v3), and device (auto/cpu/cuda)?
3. Frame resolution (default 512), format (jpeg/png/webp), and mode
   (images vs descriptions)?

Finish by calling `video_setup` to verify ffmpeg and the chosen whisper
engine are actually installed and working, and to pre-warm the model so the
first real video isn't slowed down by a cold load. Report what it found,
including any install hints for anything missing."""


def _version_marker(body: str) -> str:
    """The first line of a skill body is its version tag, e.g. '[video skill v1]'."""
    return body.splitlines()[0] if body else ""


def _seed_skill(force: bool) -> str:
    """Create or update the "video" skill. Returns 'created' | 'exists' | 'updated'.

    Raises on a real daemon failure (an unreachable daemon or a rejected
    write) — seed() is where that turns into an error string, never a crash.
    """
    existing_body: str | None = None
    try:
        existing = daemon_client.call("skills.get", {"name": SKILL_NAME})
        existing_body = existing.get("body", "")
    except Exception:  # noqa: BLE001 — "no such skill" and "daemon unreachable"
        # look identical from here (both raise); either way, treat as missing
        # and let the skills.create call below surface a real daemon outage.
        pass

    is_new = existing_body is None
    stale = existing_body is not None and (
        _version_marker(existing_body) != _version_marker(SKILL_BODY))
    if not (is_new or stale or force):
        return "exists"

    daemon_client.call("skills.create", {
        "name": SKILL_NAME, "description": SKILL_DESCRIPTION, "body": SKILL_BODY,
        "group": SKILL_GROUP, "tags": ["video"],
    })
    return "created" if is_new else "updated"


def _list_command_names() -> set[str]:
    result = daemon_client.call("command.list", {})
    return {c.get("name", "") for c in result.get("commands", [])}


def _seed_command(name: str, description: str, body: str, present: bool,
                  reseed: bool) -> str:
    """Create (or, on a version bump, drop-then-recreate) one slash command.

    command.create has no update verb — it fails outright on a name
    collision — so the only way to change an existing command's body is
    command.remove followed by a fresh command.create.
    """
    params = {"name": name, "description": description, "action_kind": "prompt",
              "action_target": "", "body": body}
    if not present:
        daemon_client.call("command.create", params)
        return "created"
    if not reseed:
        return "exists"
    daemon_client.call("command.remove", {"name": name})
    daemon_client.call("command.create", params)
    return "updated"


def seed(force: bool = False) -> dict:
    """Idempotently seed the video skill + its slash commands. Safe to call on
    every engine startup — creates only what's missing (or everything, when
    force=True), and NEVER raises: a down daemon becomes an "error: ..."
    entry, not an exception, since this runs unattended at boot."""
    result: dict = {}

    skill_status = None
    try:
        skill_status = _seed_skill(force)
        result["skill"] = skill_status
    except Exception as exc:  # noqa: BLE001 — daemon down/rejected write
        result["skill"] = f"error: {exc}"

    # The skill and its two commands ship as one package — a version bump
    # (or force) reseeds all three together, not just whichever one changed.
    reseed_commands = force or skill_status in ("created", "updated")

    commands: dict = {}
    try:
        existing_names = _list_command_names()
        listing_ok = True
    except Exception:  # noqa: BLE001 — daemon down; each command below reports it
        existing_names = set()
        listing_ok = False

    for name, description, body in (
        (WATCH_VIDEO_COMMAND_NAME, WATCH_VIDEO_COMMAND_DESCRIPTION, WATCH_VIDEO_COMMAND),
        (SETUP_VIDEO_COMMAND_NAME, SETUP_VIDEO_COMMAND_DESCRIPTION, SETUP_VIDEO_COMMAND),
    ):
        try:
            if not listing_ok:
                raise RuntimeError("could not list existing commands")
            commands[name] = _seed_command(
                name, description, body, name in existing_names, reseed_commands)
        except Exception as exc:  # noqa: BLE001 — never let one command's failure raise
            commands[name] = f"error: {exc}"
    result["commands"] = commands
    return result
