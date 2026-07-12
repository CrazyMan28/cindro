# Named Voice Library + "Set as Default" — Design

_2026-06-29. Status: approved (verbal), implementing on `dev`._

## Goal

Let the user build a **library of named voices** — record their own voice (mic) or
upload/drop in a clip, give it a name, and **set one as the default** — so that the
default voice is used **everywhere Orin speaks**: desktop TTS / voice mode, the Orin
phone app's spoken replies, and **real phone calls** (when Orin calls you, and when it
answers). Generalizes today's single hard-wired "Jarvice" clone into a managed library.
**Nothing is removed:** `jarvice`/"Orin" stays as the seeded default; all existing voice
behavior, pickers, per-agent call voices, emotion sliders, speaking-rate, etc. remain.

## What exists today (verified from code, not guessed)

- **Mistral Voxtral** does zero-shot cloning per request via `ref_audio` (base64 clip on
  every `/v1/audio/speech`). There is **no** saved-`voice_id` clone concept.
- **Desktop daemon already supports multiple named clones.** `ControlServer::cloneRefAudioB64`
  resolves slug `jarvice` → `~/.config/jarvis/voices/jarvice_ref.*` and `clone:<name>` →
  `~/.config/jarvis/voices/<name>_ref.*` (ext order: mp3, wav, opus, flac, ogg).
  `handleVoiceTts` resolution chain: explicit `voice` → `tts_voice` (SettingsStore /
  `config.toml`) → `jarvice` → fallback `en_paul_neutral` if the clip is missing.
  `handleVoiceListVoices` returns a hardcoded list (jarvice + 6 stock).
- **Phone server (vendored verbatim)** clones a **single global** `MISTRAL_TTS_REF_AUDIO_FILE`
  (read once at startup from `~/.config/jarvis/phone.env`). Per-extension voice profile is
  `{voiceId, speed, name}` stored as JSON in `extensions.metadata.voice`; `voiceId` is a
  Mistral UUID or `local:<name>` only. `/api/voices` = local Piper + Mistral catalog.
  `audioGateway.synthesizeForCall` applies the speaking extension's profile.
- **Android Orin app** (`com.jarvis.app`) Settings → Voice: wake toggle, Speak-replies
  toggle, free-form **TTS voice ID** field (SharedPreferences `jarvis_voice`, local; passed
  as `voice` to the `voice.tts` RPC). `AudioRecorder` (16 kHz mono WAV) exists (STT/wake).
- **Android agent-phone app** (`com.agentphone.*`, vendored verbatim) `AgentConfigScreen`:
  per-extension voice picker from `/api/voices`, emotion chips, speed slider, preview.
- **No record/upload/enroll UI** exists on any surface. `scripts/jarvice_voice.py` has the
  ffmpeg clean/trim pipeline (trim window, mono 24 kHz, high-pass 80 Hz, loudnorm).

## Decisions (user-approved)

1. **Library lives in the daemon** (`~/.config/jarvis/voices/` + a `voices.json` manifest) —
   single source of truth, reachable from every surface over the existing WS.
2. **Manager UI in BOTH places on phone:** primary daemon-backed manager in the **Orin app
   Settings** (mirrors desktop), **and** the custom voices surface in the **agent-phone
   per-agent picker** (the one small, contained, user-approved edit to the vendored tree).
3. **Auto-clean clips by default, with a "raw" toggle** (ffmpeg pipeline reused from
   `jarvice_voice.py`; raw stores the upload/recording as-is).
4. **Set-default propagates to calls by restarting the phone service:** daemon rewrites
   `MISTRAL_TTS_REF_AUDIO_FILE` in `phone.env` (or clears it for a stock default) and bounces
   `jarvis-phone.service`. Keeps the vendored server's *global-default* path byte-for-byte.

## Architecture

### 1. Daemon-owned library + manifest
- Files stay `~/.config/jarvis/voices/<slug>_ref.<ext>` (compatible with the existing
  resolver). New manifest `~/.config/jarvis/voices/voices.json`:
  ```json
  { "default": "jarvice",
    "voices": [ { "id": "jarvice", "name": "Orin", "slug": "jarvice", "ext": "mp3",
                  "source": "seed", "raw": false, "created_at": "..." } ] }
  ```
- `slug` = filename-safe slug of `name` (e.g. "Dad's voice" → `dads_voice`), addressed as
  `clone:<slug>` (or bare `jarvice`). Collisions get a numeric suffix.
- Seed: on first load, if `jarvice_ref.*` exists and no manifest, create a `jarvice`/"Orin"
  entry and set it default. `default` mirrors `tts_voice`.
- New core type `VoiceLibrary` (in `core/`) owns load/save/CRUD of the manifest + slugging +
  clip-file placement, with a ctest. Daemon uses it.

### 2. Daemon Contract A API (exposed on control **and** device surfaces)
- `voice.list_voices` — **extended** to merge manifest customs into the existing stock list,
  each flagged `{ custom:true, slug, isDefault, source }`. Stock entries unchanged.
- `voice.create_clone { name, audio_b64, format, clean=true }` → decode → if `clean`, run the
  ffmpeg pipeline → write `<slug>_ref.mp3`; else write raw `<slug>_ref.<ext>`. Add manifest
  row. Returns the new voice. (ffmpeg missing → silently store raw + warn; never fail save.)
- `voice.delete_clone { id }` → remove the clip file + manifest row. Any voice is deletable
  (including `jarvice`). If the deleted voice was the default, the default falls back to
  `jarvice` if it still exists, else the first remaining custom, else a stock voice
  (`en_paul_neutral`) — and that fallback is propagated (§4) just like an explicit set.
- `voice.set_default { voice }` → set `tts_voice` + manifest `default`; propagate (§4).
- `voice.preview_clone { id, text? }` → reuse `handleVoiceTts` to synth a short sample.
- (Stretch) `voice.rename_clone { id, name }` → rename file + row.

### 3. Record / upload UX (matches each surface)
- **Desktop** (`SettingsPage.qml` Voice section): a "Default Voice" card = library list (name
  · ✓default · ▶preview · 🗑) + **Record** (Bridge → `pw-record` to a temp wav, 15–30 s, stop
  button + level meter reusing the orb) + **Upload** (`FileDialog`, audio/*) + name field +
  Save + Set-default + a "store raw" advanced checkbox. New `Bridge` methods wrap `voice.*`;
  `voiceCombo` now lists customs.
- **Android Orin app** (`SettingsScreen.kt` Voice section, keeping wake/Speak-replies/
  TTS-id): same list + **Record** (reuse `AudioRecorder` → WAV) + **Upload** (SAF
  `ACTION_OPEN_DOCUMENT` audio/*) + raw toggle → `JarvisRepository` calls the `voice.*` RPCs.

### 4. Set-default → everywhere
- Desktop TTS + voice mode: keyed off `tts_voice` → instant.
- Orin app speak-replies: blank local field already resolves to daemon `tts_voice` → follows.
- Phone calls: daemon writes/clears `MISTRAL_TTS_REF_AUDIO_FILE` in `phone.env`, restarts
  `jarvis-phone.service` (~1–2 s; doesn't affect a call you're not on).

### 5. "Both places" — agent-phone picker (contained vendored edit)
- New `phone/server/src/voices/cloneVoices.ts` (mirrors `localVoices.ts`): lists
  `~/.config/jarvis/voices/*_ref.*` (+ manifest names) as `clone:<slug>` voices, merged into
  `GET /api/voices` so they appear in `AgentConfigScreen`'s picker.
- `voiceProfiles.set` accepts a `clone:<slug>` voiceId (today: UUID or `local:…`).
- `audioGateway.synthesizeForCall` loads that clip as `ref_audio` for that extension (so a
  specific clone can be assigned to a specific agent, not just the global default).
- Keep all 168 phone-server tests green; add tests for the new path.

### 6. Error handling / fallbacks
- Missing clip → existing `en_paul_neutral` fallback stays (TTS/calls never break).
- ffmpeg absent → raw fallback + warning.
- Reject empty/oversized/bad audio; slug collisions suffixed.
- phone.env rewrite is atomic (temp + rename); service restart failure surfaces a warning but
  doesn't roll back the desktop default.

### 7. Testing
- Core: `VoiceLibrary` ctest (CRUD, slug, collisions, default fallback, seed).
- Daemon: create→list→set-default writes `config.toml` + `phone.env`; missing-clip fallback.
- Phone server: `cloneVoices` listing + `clone:<slug>` accepted by `voiceProfiles.set` +
  resolved in `synthesizeForCall`; keep existing suite green.
- Smoke: extend `scripts/voice_roundtrip_test.py` with create→list→set-default→preview.
- Build desktop (cmake/ctest) + Android (`assembleDebug`) + phone server (`npm run build` +
  `npm test`). Push updated APK to the phone store via phone-installer MCP (per CLAUDE.md).

### 8. Ship
- Commit on `dev`, push; promote `dev → qa`, push; open PR `qa → main` (main is protected,
  PR-only). Update `docs/STATUS.md` + `docs/VOICE.md`.

## Out of scope (YAGNI)
- Per-voice emotion presets, voice versioning/history, multi-clip-per-voice blending, cloud
  storage/sync of clips, sharing voices between users.
