#pragma once

// VoiceProvider — a thin pluggable-provider layer in front of VoiceService.
//
// Today STT/TTS is hardcoded Mistral Voxtral (VoiceService). This adds optional
// LOCAL providers that run a binary on the laptop:
//   STT: "voxtral" (default, cloud) | "whisper" (whisper.cpp `whisper-cli` /
//        openai-whisper `whisper`)
//   TTS: "voxtral" (default, cloud) | "piper" (`piper` / `piper-tts`)
//
// The contract is GRACEFUL DEGRADE: if a local provider is selected but its
// binary or model is absent (or the run fails), we fall straight through to
// VoiceService (voxtral). A missing local provider therefore behaves EXACTLY
// like voxtral — never a crash, never a new error code. The Result type is the
// existing VoiceService::Result so callers thread one shape everywhere.

#include "jarvis/VoiceService.h"

#include <QByteArray>
#include <QJsonArray>
#include <QString>

namespace jarvis {

using VoiceResult = VoiceService::Result;

namespace VoiceProvider {

// Provider id constants (string-typed so they round-trip in config.toml / JSON).
inline QString sttDefault() { return QStringLiteral("voxtral"); }
inline QString ttsDefault() { return QStringLiteral("voxtral"); }

// --- availability (cached static const, like NotifyService) ------------------
bool whisperAvailable();
bool piperAvailable();

// True when `provider` names a usable local STT/TTS path right now (binary
// present). The daemon uses this to decide whether a Mistral key is required.
bool sttLocalUsable(const QString &provider);
bool ttsLocalUsable(const QString &provider);

// --- enumeration for the picker ---------------------------------------------
// Each entry: {id, label, available}. voxtral is always available:true; the
// local providers reflect binary presence (so the UI can show-but-disable).
QJsonArray sttProviders();
QJsonArray ttsProviders();

// STT has no "voices"; kept for symmetry (always empty).
QJsonArray whisperVoices();
// Discover *.onnx piper models under ~/.local/share/jarvis/piper/, $PIPER_VOICES
// or ~/.local/share/piper-voices. Each entry: {id:<basename>, label:<pretty>}.
QJsonArray piperVoices();

// --- dispatch ----------------------------------------------------------------
// Route to the local provider when usable, else VoiceService(mistralKey). Any
// local failure falls back to VoiceService so the result is always voxtral-shaped.
VoiceResult sttWithProvider(const QString &provider, const QString &mistralKey,
                            const QByteArray &audio, const QString &mime = QString(),
                            const QString &lang = QString(),
                            const QString &model = QString(), int timeoutMs = 30000);

// `refAudioB64`, when set, requests zero-shot voice cloning (Mistral ref_audio).
// Cloning is cloud-only, so a clone request never routes through a local piper
// voice — it always goes to VoiceService.
VoiceResult ttsWithProvider(const QString &provider, const QString &mistralKey,
                            const QString &text, const QString &voice = QString(),
                            const QString &format = QString(),
                            const QString &model = QString(), int timeoutMs = 30000,
                            const QString &refAudioB64 = QString());

} // namespace VoiceProvider

} // namespace jarvis
