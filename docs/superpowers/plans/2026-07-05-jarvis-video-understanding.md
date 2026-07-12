# Orin Video Understanding — all claude-video-vision features, implemented natively (no copied code)

> Canonical repo location once approved: `docs/superpowers/plans/2026-07-05-jarvis-video-understanding.md` (alongside the other superpowers plans).

## Context

Issac wants Orin to **watch and understand videos**: paste a YouTube URL (or local file path) into chat, say "watch this video", and Orin sees the frames as images and hears the audio as a timestamped transcript. The reference for the *feature set* is the `claude-video-vision` Claude Code plugin — Orin gets **every feature it has**, but the code is **written fresh in Orin's own idioms** (Python, Orin conventions). **We studied the reference to understand it; we do not copy its code.** Default transcription = **local faster-whisper, model large-v3** (user-confirmed; 60GB RAM + RTX 4070 → CUDA with CPU fallback). Settings editable in a new **"Video Understanding" section** (desktop QML + TUI), **skills teach Orin the video workflow**, and it must work on the **Windows build** too.

## No-copy methodology (user requirement)

- During exploration we produced a **complete behavior spec** of the reference (tools, parameters, defaults, algorithms like the auto-fps table and caption-fallback rules, storage layout, skill workflow). That spec — captured in this plan — is what implementation works from.
- **Implementation subagents get the spec, never the reference source files.** No porting, no transliterating TS to Python. Naming, structure, error handling, and style follow existing Orin modules (`tools_desktop.py`, `tools_jarvis_ops.py`, `VoiceProvider` fallback idiom), not the reference's layout.
- Algorithm-level facts (e.g. "fps auto: <60s→2, <300s→1, <900s→0.5, <3600s→0.2, else 0.1", "captions fall back to whisper when coverage <50% on ≥30s videos") are behavior we replicate; expressing them in our own code is not copying.
- The reference clone at `/tmp/claude-1000/-home-kihi2024-projects-computer-use/dc83c791-ece6-4217-962a-afed67f950c2/scratchpad/claude-video-vision` is **deleted at the end** (user requirement). It may be consulted read-only only to answer "what does the feature do?" questions the spec missed — never as a source to lift code from.

## Architecture (where everything goes)

```
paste YouTube URL in chat ──► builtin/video skill (model discovers via list_skills/skill_load)
                                   │
                    calls MCP tools in the computer-use engine
                                   ▼
computer-use/computer_use_mcp/tools_video.py   ← 6 tools: video_info / video_setup /
        │                                        video_configure / video_watch /
        ▼                                        video_analyze / video_detail
computer_use_mcp/video/  (new, original Python package)
        │  yt-dlp (Python API) · ffmpeg/ffprobe (subprocess) · faster-whisper (in-process)
        ▼
frames → MCP Image content blocks + on-disk paths; transcript → text blocks
settings → daemon SettingsStore (config.toml, `video_*` keys) via daemon_client settings.get/set
storage  → ~/.local/share/jarvis/video/{downloads,sessions,models}  (data_dir(), Windows-safe)
```

**No new daemon RPC verbs** — only settings plumbing. The pipeline is 100% Python in the engine (same host/process as the MCP call; matches how `tools_desktop.py` screenshots work). The daemon stores *preferences* only, exactly like the existing `stt_provider` precedent.

## Feature spec (full parity target)

- **`video_watch`** (main): local path or YouTube URL; fps number|"auto" (auto table above, and `view_sample/duration` when sampling); resolution 128–2048 (width-fixed scaling, aspect preserved); formats jpeg/png/webp; `frame_mode` images|descriptions; `start_time`/`end_time` HH:MM:SS; `skip_audio`; `segments[{start,end,fps,resolution}]` for variable-density extraction; `view_sample` (N evenly spaced); max-frames cap (default 100); frames and audio processed **in parallel**; all timestamps re-anchored to the original video timeline; fast input-seek for frames, accurate seek for audio.
- **`video_analyze`** (structure, no frames): one ffmpeg pass with selectable analyzers — scene changes, black intervals, silence, freeze, motion/complexity → content profile, blur, exposure/brightness stats, loudness summary, optional transcription; results guide segment planning. Windows path-escaping for lavfi filter args (drive-letter colon + backslashes).
- **`video_detail`** (drill-down): separates *extracting* frames to disk from *viewing* them (explicit timestamps, evenly-spaced sample, or all); respects the session cache; "binary-search" progressive viewing.
- **`video_info`**: ffprobe metadata only (duration/resolution/codec/fps/size/has_audio) — cheapest first call.
- **`video_setup`**: platform/GPU/RAM detection, dependency check (ffmpeg/ffprobe/whisper engines/API keys), RAM-based model recommendation (<4GB tiny, <8 small, <16 large-v3-turbo, else large-v3), OS-specific install commands, model pre-warm/download.
- **`video_configure`**: read/patch every setting + `clear_sessions` cache-nuke.
- **YouTube**: yt-dlp download (no playlists, mp4 merge, hash-prefixed filenames, expiring downloads cache), metadata (title/channel/duration/views/description), **captions-first transcripts** — manual subs > auto captions > whisper fallback when captions missing/empty/<50% coverage — with `transcription_source` provenance; SRT/VTT parsing with tag/entity stripping.
- **Audio backends**: local **faster-whisper (default)** in-process with HF auto-download and device auto (cuda→cpu); whisper.cpp (`whisper-cli`, ggml + Silero VAD model download with SHA-256 verification); openai-whisper CLI; **Gemini API** (audio-only upload, poll until file ACTIVE, structured JSON with transcription + non-speech audio_tags); **OpenAI whisper API** (segment timestamps). **Chunking** for >20min audio: ~10min chunks with silence-aligned boundaries (±30s tolerance, looser-threshold retry, hard-cut warnings), parallel transcription with per-chunk retry, warnings surfaced to the model.
- **Sessions/caching** (`enable_index`): video identity = hash of first 64KB + file size; per-video manifest of extracted frames keyed by resolution/format; timestamp-dedup merge preferring highest resolution; frames stored per format/resolution; age-based expiry sweeps at engine startup; manual clear.
- **Skills/commands**: builtin `video` skill (workflow: info → analyze required for >30s → plan per-segment fps from scene/silence/transcript data → watch → detail drill-down → reuse manifest on follow-ups; question-type → analyzer-selection table; low-fps-by-default token guidance), `/watch-video` and `/setup-video-vision` slash commands (the latter a one-question-at-a-time wizard writing through `video_configure`), and a **frame-describer** mode: when `frame_mode=descriptions`, frames go to an Orin subagent (`agents.dispatch`, one dispatch carrying all frame paths; system prompt: factual 1–3 sentence per-frame descriptions, no interpretation) so the main context stays image-free; graceful fallback to raw images on failure/timeout.

## Phases & files (all code original, Orin-idiomatic)

### Phase 1 — Core video library + tests
New package `computer-use/computer_use_mcp/video/`: `types.py`, `timestamps.py`, `platform_info.py`, `frames.py`, `audio.py`, `audio_chunker.py`, `analyzers.py`. Tests in **`computer-use/tests/video/`** (name `tests/test_video_source.py` is taken by an unrelated screen-capture test) with an ffmpeg-generated fixture video (session-scoped conftest fixture: known scene cut + tone/silence; no committed binaries).

### Phase 2 — Video source (YouTube + local)
`video/video_source.py` using the **`yt_dlp.YoutubeDL` Python API** (freezes into PyInstaller; one code path on both OSes): URL detection, download+cache with expiry, metadata, captions fetch/parse/coverage-fallback.

### Phase 3 — Audio backends
`video/backends/`: `faster_whisper_backend.py` (default; device auto cuda→cpu, compute type auto, **default model large-v3**), `whisper_cpp_backend.py`, `openai_whisper_backend.py`, plus chunked-transcription orchestration. Unit tests mock the heavy parts; one slow real-audio integration test on the fixture.

### Phase 4 — Cloud backends
`gemini_api_backend.py` + `openai_api_backend.py`, optional-extra deps, gated on API keys already stored in Orin's API-keys settings.

### Phase 5 — Session/cache layer
`video/session/` (manager + manifest); expiry sweeps run in `server.py` lifespan next to `live_widgets.ensure_supervisor()`.

### Phase 6 — MCP tool surface
`tools_video.py` registering all 6 tools; `tools_video.register(mcp)` added in `computer-use/computer_use_mcp/server.py` (pattern at lines 33–42). `video/config.py` bridges settings: `daemon_client.call("settings.get")` merged over defaults, full defaults when the daemon is unreachable. Frames returned as FastMCP `Image` content **plus** on-disk paths (CLI brains can also `Read` them). Descriptions mode via `agents.dispatch`/`agents.result` with configurable timeout and image fallback.

### Phase 7 — Daemon settings
`core/include/jarvis/SettingsStore.h` + `core/src/SettingsStore.cpp`: 18 flat keys, normalize-on-set (idiom: `sttProvider`):
`video_backend`("local"|gemini-api|openai-api, default **local**), `video_whisper_engine`("faster-whisper"|whisper-cpp|openai-whisper), `video_whisper_model`(default **"large-v3"**), `video_whisper_device`("auto"|cpu|cuda), `video_frame_mode`("images"), `video_frame_format`("jpeg"), `video_frame_resolution`(512), `video_default_fps`("auto"), `video_max_frames`(100), `video_frame_describer_model`(""), `video_frame_describer_timeout_sec`(180), `video_enable_index`(false), `video_session_max_age_days`(7), `video_downloads_max_age_days`(7), `video_audio_chunk_trigger_seconds`(1200), `video_audio_chunk_size_seconds`(600), `video_audio_chunk_overlap_seconds`(0), `video_gemini_model`("gemini-3-flash-preview") (+`video_gemini_max_output_tokens` 65536).
`daemon/src/ControlServer.cpp` `handleSettingsGet` (~779, after the stt/tts block) / `handleSettingsSet` (~946): round-trip all keys + a `video_backends` availability array `[{id,label,available}]` keyed off `hasApiKey("gemini"/"openai")`; add `gemini` to `providerKeys()` if missing.

### Phase 8 — Settings UI
- `desktop/qml/SettingsPage.qml`: new `// VIDEO UNDERSTANDING` `Widgets.SectionCard` after Voice (~line 858), reusing the existing `StyledCombo` + `providerLabels()/providerIdForIndex()` idioms: backend, local engine, whisper model, device, frame resolution/format/mode, cache toggle, "Clear video cache" button, hint ("say 'run video_setup' in chat for a live check").
- `tui/src/pages/Settings.tsx`: `"VIDEO"` in `SECTIONS` + a `VIDEO_KNOBS` table (same generic enum-knob pattern as MODE & AUTONOMY). **Don't touch the uncommitted TUI-v2 files** (`app.tsx`, `Chat.tsx`, `Transcript.tsx`, `session.ts`, `Widget.tsx`); `Settings.tsx` is clean.
- Optional: `settings_sections` entry in `core/src/UiManifest.cpp` for manifest parity.

### Phase 9 — Skills & commands
Skill/command text ships as constants in `computer_use_mcp/video/skill_seed.py`, **written by us for Orin** (the workflow knowledge from the spec, phrased for Orin's tool surface and settings), **idempotently seeded at engine startup** via daemon `skills.create` / `commands.*` (verified: `builtin/phone` was self-authored at runtime; there is no repo seeding mechanism — engine-side seeding also makes Windows installs get the skills automatically). Seeds: `builtin/video` skill, `/watch-video`, `/setup-video-vision`.

### Phase 10 — Windows
- Deps in **both** `computer-use/pyproject.toml` (faster-whisper, yt-dlp, huggingface-hub; openai+google-genai as a `cloud-video` extra) **and** `windows/engine/requirements-windows.txt` (Windows build installs the package `--no-deps`).
- `windows/scripts/build.ps1` PyInstaller flags: `--collect-all faster_whisper --collect-all ctranslate2 --collect-all av --collect-data huggingface_hub --copy-metadata huggingface_hub --copy-metadata tokenizers --collect-submodules yt_dlp --collect-data yt_dlp` (AGENTS.md:381 collect-data gotcha), plus an early `& $venvPy -c "import faster_whisper, ctranslate2, av, yt_dlp"` smoke probe so bad wheels fail before the freeze.
- ffmpeg stays an external binary: `video_setup` Windows guidance = `winget install Gyan.FFmpeg` + "restart Orin after installing so PATH updates". yt-dlp needs nothing (frozen in).
- Verify via Windows CI build (`windows-build.yml` on the self-hosted runner, triggers on PR to main) + winlab/testlab manual pass (frozen-exe `shutil.which("ffmpeg")`, first-run HF model download, CUDA→CPU degrade).

### Phase 11 — Verification, review, cleanup
- pytest green: auto-fps boundary table, timestamp shifting, chunk planning (snap-to-silence, loose retry, hard-cut warnings), URL detection, SRT/VTT parsing, caption-fallback rules, lavfi escaping incl. `C:\` case, session hash/manifest merge/dedup, evenly-spaced sampling, config-bridge daemon-unreachable fallback, tool-registration smoke test.
- E2E: real YouTube URL pasted in chat → skill triggers → info/analyze/watch → frames visible in desktop+TUI chat + timestamped transcript; local-file variant; Settings knob change round-trips live; descriptions mode keeps images out of the top-level context.
- Run `/code-review` and fix all findings before push (standing rule), commit on `dev`, PR to `main` (user merges).
- **Delete the reference clone from the scratchpad** and update the project tracker.

## Known limitations to document (not blockers)
- `ApiBrain::callMcpTool` (core/src/ApiBrain.cpp:988) drops MCP image content — pre-existing gap (affects screenshots too): with the `api` brain, frames-as-images don't reach the model (transcript/metadata still do). Documented in `video_setup` output + skill; noted as a small follow-up C++ fix candidate.
- Frozen Windows exe can't self-update yt-dlp (stale yt-dlp is the #1 cause of YouTube download failures) — `video_setup` says so explicitly.
- First `video_watch` with large-v3 triggers a ~3GB HF download; `video_setup` pre-warms the model so it doesn't happen inside a user-facing call.

## Execution notes
- First action after approval: copy this plan to `docs/superpowers/plans/2026-07-05-jarvis-video-understanding.md` (its requested home).
- Work on `dev`, incremental commits; sonnet subagents/workflows for implementation (user-authorized ultracode, capped at sonnet/opus, prefer sonnet) — **subagents receive this spec, never the reference source**.
- Agent check-in via project-tracker MCP at execution start.
- Storage paths via the shared `data_dir()` resolvers (never %APPDATA% — GitHub #81 lesson).
