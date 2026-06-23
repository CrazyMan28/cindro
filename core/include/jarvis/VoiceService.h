#pragma once

// VoiceService — Mistral Voxtral STT + TTS, proxied by the daemon so the API key
// never leaves the laptop (docs/VOICE.md). Confirmed against the live Mistral API
// (2026-06): endpoints + shapes below.
//
// STT (speech -> text):  POST https://api.mistral.ai/v1/audio/transcriptions
//   multipart/form-data: file=<audio bytes>, model=voxtral-mini-latest,
//   [language=<code>]. Response JSON: {text, language?, segments[], usage}.
//
// TTS (text -> speech):  POST https://api.mistral.ai/v1/audio/speech
//   JSON: {model:voxtral-mini-tts-latest, input:<text>, voice:<slug>,
//   response_format:"pcm"|"wav"|"mp3"|"flac"|"opus"}. A voice (or ref_audio) is
//   REQUIRED. Non-streaming response JSON: {audio_data:<base64>}.
//
// Both calls are synchronous (QEventLoop with a timeout), matching the existing
// blocking-helper pattern in the daemon (McpRegistry::test, ollama model list).

#include <QByteArray>
#include <QString>

namespace jarvis {

class VoiceService {
public:
    struct Result {
        bool ok = false;
        QString error;

        // STT
        QString text;
        QString language;
        QByteArray wordsJson; // raw segments/words array JSON (may be empty)

        // TTS
        QByteArray audio;  // decoded audio bytes
        QString mime;      // e.g. audio/mpeg
    };

    // `apiKey` is the Mistral bearer (from ~/.config/jarvis/mistral_api_key or
    // the SettingsStore "mistral" secret). Empty defaults are used for model/
    // voice/format when the caller passes empty strings.
    explicit VoiceService(QString apiKey);

    // Speech -> text. `audio` is the raw audio bytes; `mime` hints the file
    // extension/content type (default audio/mpeg). `lang` is an optional BCP-47
    // language hint to boost accuracy.
    Result stt(const QByteArray &audio, const QString &mime = QString(),
               const QString &lang = QString(),
               const QString &model = QString(), int timeoutMs = 30000);

    // Text -> speech. `voice` is a Mistral voice slug (default en_paul_neutral);
    // `format` ∈ pcm|wav|mp3|flac|opus (default mp3).
    Result tts(const QString &text, const QString &voice = QString(),
               const QString &format = QString(), const QString &model = QString(),
               int timeoutMs = 30000);

    bool hasKey() const { return !m_apiKey.isEmpty(); }

    // Defaults (also referenced by tests/docs).
    static QString defaultSttModel() { return QStringLiteral("voxtral-mini-latest"); }
    static QString defaultTtsModel() { return QStringLiteral("voxtral-mini-tts-latest"); }
    static QString defaultVoice() { return QStringLiteral("en_paul_neutral"); }
    static QString defaultFormat() { return QStringLiteral("mp3"); }
    static QString base() { return QStringLiteral("https://api.mistral.ai/v1"); }
    // Map a TTS response_format to a MIME type.
    static QString mimeForFormat(const QString &format);

private:
    QString m_apiKey;
};

} // namespace jarvis
