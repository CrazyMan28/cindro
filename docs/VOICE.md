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
- Model `voxtral-mini-tts-latest`. Mistral "Speech Generation" endpoint (confirm exact path against
  docs — `POST /v1/audio/speech`-style: `{model, input:<text>, voice?, format: "pcm"|"mp3"}`). PCM
  streams with ~0.8s time-to-first-audio (queue + play as received); mp3 ~3s. Voice cloning from a
  2-3s sample; multilingual (en/fr/es/pt/it/nl/de/hi/ar). ~$0.016/1k chars.
- Docs: https://docs.mistral.ai/studio-api/audio/text_to_speech

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
