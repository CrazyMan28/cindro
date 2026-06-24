// ctest: VoiceProvider enumeration + graceful local->voxtral fallback, and a
// SettingsStore stt_provider/tts_provider round-trip against a temp HOME.
//
// These assert the safety contract: a local provider with no binary/model
// behaves EXACTLY like voxtral (no crash, clean "no Mistral API key" error when
// the key is empty), and a bogus provider id normalizes to "voxtral".

#include "jarvis/SettingsStore.h"
#include "jarvis/VoiceProvider.h"
#include "jarvis/VoiceService.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QDir>
#include <QJsonArray>
#include <QJsonObject>
#include <QTemporaryDir>

#include <cstdio>

using jarvis::SettingsStore;
using jarvis::VoiceResult;
using jarvis::VoiceService;
namespace VP = jarvis::VoiceProvider;

namespace {
int g_failures = 0;
void check(bool cond, const char *msg)
{
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", msg); ++g_failures; }
    else { std::fprintf(stderr, "ok: %s\n", msg); }
}

// True iff `arr` contains an entry {id==id, available==true}.
bool hasAvailable(const QJsonArray &arr, const QString &id)
{
    for (const QJsonValue &v : arr) {
        const QJsonObject o = v.toObject();
        if (o.value(QStringLiteral("id")).toString() == id &&
            o.value(QStringLiteral("available")).toBool())
            return true;
    }
    return false;
}
} // namespace

int main(int argc, char **argv)
{
    // Point HOME at a temp dir BEFORE QCoreApplication so Config::configDir()
    // (QDir::homePath) writes config.toml under the sandbox, not the real home.
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FAIL: temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());

    QCoreApplication app(argc, argv);

    // --- (a) provider enumeration always includes voxtral(available) --------
    {
        const QJsonArray stt = VP::sttProviders();
        const QJsonArray tts = VP::ttsProviders();
        check(hasAvailable(stt, QStringLiteral("voxtral")),
              "sttProviders() includes voxtral available:true");
        check(hasAvailable(tts, QStringLiteral("voxtral")),
              "ttsProviders() includes voxtral available:true");
        check(stt.size() >= 2, "sttProviders() lists at least voxtral + whisper");
        check(tts.size() >= 2, "ttsProviders() lists at least voxtral + piper");
        // STT has no voices.
        check(VP::whisperVoices().isEmpty(), "whisperVoices() is empty (STT has no voices)");
        // No piper models in the temp HOME -> empty list, not a crash.
        check(VP::piperVoices().isEmpty(), "piperVoices() empty with no models in temp HOME");
    }

    // --- (b) whisper with no binary/model falls back to voxtral (no crash) --
    // With an empty Mistral key the voxtral path returns its well-defined error.
    {
        const VoiceService::Result baseline =
            VoiceService(QString()).stt(QByteArray("not-real-audio"));
        const VoiceResult fell =
            VP::sttWithProvider(QStringLiteral("whisper"), QString(),
                                QByteArray("not-real-audio"));
        check(!fell.ok, "whisper fallback STT is not ok (no key, fell to voxtral)");
        check(fell.error == baseline.error,
              "whisper fallback STT error matches voxtral's no-key error");
        check(baseline.error.contains(QStringLiteral("no Mistral API key")),
              "voxtral baseline error is the no-key message");

        // Same for piper TTS.
        const VoiceService::Result ttsBaseline =
            VoiceService(QString()).tts(QStringLiteral("hello"));
        const VoiceResult ttsFell =
            VP::ttsWithProvider(QStringLiteral("piper"), QString(),
                                QStringLiteral("hello"));
        check(!ttsFell.ok, "piper fallback TTS is not ok (no key, fell to voxtral)");
        check(ttsFell.error == ttsBaseline.error,
              "piper fallback TTS error matches voxtral's no-key error");

        // Local usability is false when no binary/model present.
        check(!VP::sttLocalUsable(QStringLiteral("whisper")),
              "sttLocalUsable(whisper) false with no binary/model");
        check(!VP::ttsLocalUsable(QStringLiteral("piper")),
              "ttsLocalUsable(piper) false with no binary/model");
        check(!VP::sttLocalUsable(QStringLiteral("voxtral")),
              "voxtral is never a local provider");
    }

    // --- (c) setSttProvider/setTtsProvider normalize bogus -> voxtral -------
    {
        SettingsStore s;
        s.setSttProvider(QStringLiteral("bogus"));
        check(s.sttProvider() == QStringLiteral("voxtral"),
              "setSttProvider(bogus) normalizes to voxtral");
        s.setTtsProvider(QStringLiteral("bogus"));
        check(s.ttsProvider() == QStringLiteral("voxtral"),
              "setTtsProvider(bogus) normalizes to voxtral");
        s.setSttProvider(QStringLiteral("whisper"));
        check(s.sttProvider() == QStringLiteral("whisper"),
              "setSttProvider(whisper) kept verbatim");
        s.setTtsProvider(QStringLiteral("piper"));
        check(s.ttsProvider() == QStringLiteral("piper"),
              "setTtsProvider(piper) kept verbatim");
    }

    // --- (d) SettingsStore round-trip through saveConfig -> load ------------
    {
        // Fresh config dir (under the temp HOME). Write then reload.
        SettingsStore writer;
        writer.load(); // start from defaults
        check(writer.sttProvider() == QStringLiteral("voxtral"),
              "default stt_provider is voxtral");
        check(writer.ttsProvider() == QStringLiteral("voxtral"),
              "default tts_provider is voxtral");
        writer.setSttProvider(QStringLiteral("whisper"));
        writer.setTtsProvider(QStringLiteral("piper"));
        check(writer.saveConfig(), "saveConfig() succeeds");

        SettingsStore reader;
        reader.load();
        check(reader.sttProvider() == QStringLiteral("whisper"),
              "stt_provider round-trips (whisper)");
        check(reader.ttsProvider() == QStringLiteral("piper"),
              "tts_provider round-trips (piper)");
    }

    if (g_failures) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::fprintf(stderr, "all checks passed\n");
    return 0;
}
