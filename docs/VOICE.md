# Jarvis Voice — Mistral Voxtral (STT + TTS)

User directive: **use Mistral for TTS and STT.** Key validated (GET /v1/models -> 200; account has the
voxtral-mini-tts + voxtral realtime/transcribe models).

## Credentials
- Key file: `~/.config/jarvis/mistral_api_key` (mode 0600, NOT in git). Also register it in the Jarvis
  SettingsStore as the `mistral` secret so `settings.get` reports it set. Bearer auth:
  `Authorization: Bearer <key>`. Base URL `https://api.mistral.ai`.

## STT (speech -> text) — Voxtral transcribe
- Endpoint: `POST https://api.mistral.ai/v1/audio/transcriptions` (multipart form: `file=<audio>`,
  `model=voxtral-mini-latest`; `voxtral-small-latest` for higher accuracy). Features: speaker
  diarization, word-level timestamps, context biasing, 13 languages. ~$0.003/min.
- Low-latency / live: `voxtral-mini-transcribe-realtime-*` / `voxtral-mini-realtime-*` via Mistral's
  realtime (streaming) API — use for "Hey Jarvis" continuous listening; otherwise push-to-talk +
  one-shot transcription is fine for v1.
- Docs: https://docs.mistral.ai/api/endpoint/audio/transcriptions , https://docs.mistral.ai/studio-api/audio/speech_to_text

## TTS (text -> speech) — Voxtral TTS
- Model `voxtral-mini-tts-latest` / `voxtral-mini-tts-2603`. `POST /v1/audio/speech`:
  `{model, input:<text>, voice:<slug> | ref_audio:<b64>, response_format:"pcm"|"wav"|"mp3"|"flac"|"opus"}`.
  Non-streaming response: `{audio_data:<base64>}`. A **voice OR ref_audio is required**.
  multilingual (en/fr/es/pt/it/nl/de/hi/ar). ~$0.016/1k chars.
- Docs: https://docs.mistral.ai/studio-api/audio/text_to_speech

## Voice cloning — "Jarvice" (the DEFAULT voice)
Mistral clones a voice **zero-shot per request** via `ref_audio` — there is **no** "create a saved
voice / `voice_id`" call (the `client.audio.voices.create(...)` you'll see in ChatGPT/Gemini snippets
does not exist for Mistral). You pass a short base64 **reference clip** on each `/v1/audio/speech`
call and it clones the timbre on the fly.

- **Reference clip:** a clean, single-speaker ~15–30s mono sample lives at
  `~/.config/jarvis/voices/jarvice_ref.{mp3,wav,opus,flac,ogg}` — **never in git** (source clips are
  often copyrighted). Cleaner beats longer: an interview's full audio includes the interviewer/music
  and muddies the clone; trim to one continuous answer.
- **CLI / Form-Coach hook:** `scripts/jarvice_voice.py`
  - `build-ref <source> --start S --dur D` — trim+clean a reference clip (high-pass, denoise, loudnorm).
  - `say "<text>" [-o out.wav] [--no-play]` — synth in the cloned voice (used for the boot greeting
    "Good morning, sir." and live coaching callouts like "Keep your guard up, sir.").
  - Reads the key from `$MISTRAL_API_KEY` or `~/.config/jarvis/mistral_api_key`; no SDK dependency.
- **In-app (Voice Mode / read-back):** selecting the **`jarvice`** voice slug (or `clone:<name>`)
  makes the daemon load the stored reference clip and synth via `ref_audio`. `jarvice` is the product
  **default** voice — used whenever no `tts_voice` is set — and is fully changeable in Settings on both
  desktop (TTS voice picker) and phone (TTS voice id field). If the reference clip is missing, the
  daemon falls back to the stock `en_paul_neutral` voice so TTS never breaks.
  - Plumbing: `VoiceService::tts(..., refAudioB64)` → `ref_audio`; `VoiceProvider::ttsWithProvider`
    routes clones straight to the cloud (local piper can't clone); `ControlServer::cloneRefAudioB64`
    resolves the slug → clip; `handleVoiceListVoices` lists Jarvice + reports it as the default.

## How Jarvis uses it
- **Daemon-proxied (recommended): the key stays on the laptop.** Add Contract C (device WS) + Contract A
  methods: `voice.stt{audio_b64, lang?} -> {text, words?}` and `voice.tts{text, voice?, format?} ->
  {audio_b64}` (or a streamed binary frame for PCM). jarvisd reads `~/.config/jarvis/mistral_api_key`
  and calls Mistral; phone/desktop just send audio / receive audio.
- **Android (#18):** "Hey Jarvis" wake (foreground service + notification) OR push-to-talk mic ->
  record -> `voice.stt` -> send as the chat message; assistant reply -> `voice.tts` -> stream-play PCM.
- **Desktop (#10):** a push-to-talk hotkey dictation into the input via `voice.stt`; optional TTS
  read-back of replies via `voice.tts`. Mic capture via PipeWire/pw-record or Qt Multimedia.
- Settings: a "Voice" section (provider=Mistral, STT model, TTS model+voice, wake on/off) on both
  desktop and phone.

## Spoken-reply playback ordering (desktop voice mode)

One assistant turn can arrive as **several** `message` events, and hands-free Voice Mode
(`VoiceMode.qml`) calls `bridge.speak()` on each one — so multiple `voice.tts` replies can come back
while a clip is still playing. The desktop **queues** these clips and plays them strictly in order:

- `Bridge::playTtsAudio()` **appends** each clip to `m_ttsQueue` instead of playing immediately.
- `Bridge::playNextTtsClip()` stages the head of the queue to a (ping-ponged) temp file and plays it;
  the next clip starts only when the current one fires `QMediaPlayer`'s `EndOfMedia` — not the
  transient `StoppedState` that source-swapping passes through.
- Hands-free **resume-listening / orb-idle happens once**, when the queue drains — not after every
  clip — so Jarvis never starts listening (and capturing its own TTS tail) mid-reply.
- Ending the conversation (Space / leaving the page) is a barge-in: `stopConversation()` clears the
  queue and stops the player.

Without the queue, each new clip's `setSource()`+`play()` interrupted the one still mid-sentence, so
multi-segment replies cut each other off / overlapped. (Android speaks only the turn's **final**
assistant message once on the `final` event, so it never had this overlap.)
