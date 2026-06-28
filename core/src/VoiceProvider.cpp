#include "jarvis/VoiceProvider.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QProcess>
#include <QStandardPaths>
#include <QStringList>
#include <QTemporaryDir>
#include <QTemporaryFile>

namespace jarvis {
namespace VoiceProvider {

namespace {

// Map a TTS/STT mime hint to a file extension whisper-cli understands.
QString extForMime(const QString &mime)
{
    const QString m = mime.toLower();
    if (m.contains(QStringLiteral("wav")) || m.contains(QStringLiteral("x-wav")))
        return QStringLiteral("wav");
    if (m.contains(QStringLiteral("ogg")) || m.contains(QStringLiteral("opus")))
        return QStringLiteral("ogg");
    if (m.contains(QStringLiteral("flac")))
        return QStringLiteral("flac");
    if (m.contains(QStringLiteral("webm")))
        return QStringLiteral("webm");
    if (m.contains(QStringLiteral("m4a")) || m.contains(QStringLiteral("mp4")) ||
        m.contains(QStringLiteral("aac")))
        return QStringLiteral("m4a");
    return QStringLiteral("mp3"); // audio/mpeg and unknowns
}

QString findExe(const QString &name)
{
    return QStandardPaths::findExecutable(name);
}

// Resolve the whisper-cli (whisper.cpp) executable, or the openai-whisper one.
QString whisperExe()
{
    QString p = findExe(QStringLiteral("whisper-cli"));
    if (p.isEmpty())
        p = findExe(QStringLiteral("whisper"));
    return p;
}

QString piperExe()
{
    QString p = findExe(QStringLiteral("piper"));
    if (p.isEmpty())
        p = findExe(QStringLiteral("piper-tts"));
    return p;
}

QString jarvisShareDir(const QString &sub)
{
    return QDir::homePath() + QStringLiteral("/.local/share/jarvis/") + sub;
}

// Find a usable whisper ggml model file. Prefers an explicit `model` path when
// it points at a real file, else scans the jarvis whisper dir for a *.bin.
QString resolveWhisperModel(const QString &model)
{
    if (!model.isEmpty() && QFileInfo::exists(model) && QFileInfo(model).isFile())
        return model;
    const QString dir = jarvisShareDir(QStringLiteral("whisper"));
    // Common default first.
    const QStringList preferred = {QStringLiteral("ggml-base.en.bin"),
                                   QStringLiteral("ggml-base.bin")};
    for (const QString &name : preferred) {
        const QString p = dir + QLatin1Char('/') + name;
        if (QFileInfo::exists(p))
            return p;
    }
    QDir d(dir);
    if (d.exists()) {
        const QStringList bins =
            d.entryList(QStringList() << QStringLiteral("*.bin"), QDir::Files, QDir::Name);
        if (!bins.isEmpty())
            return d.absoluteFilePath(bins.first());
    }
    return QString();
}

// All candidate directories that may hold piper *.onnx voices.
QStringList piperVoiceDirs()
{
    QStringList dirs;
    dirs << jarvisShareDir(QStringLiteral("piper"));
    const QByteArray env = qgetenv("PIPER_VOICES");
    if (!env.isEmpty())
        dirs << QString::fromLocal8Bit(env);
    dirs << QDir::homePath() + QStringLiteral("/.local/share/piper-voices");
    return dirs;
}

// Resolve a piper voice id (a model basename) to its .onnx path. An empty voice
// uses the first discovered model.
QString resolvePiperModel(const QString &voice)
{
    for (const QString &dirPath : piperVoiceDirs()) {
        QDir d(dirPath);
        if (!d.exists())
            continue;
        const QStringList models =
            d.entryList(QStringList() << QStringLiteral("*.onnx"), QDir::Files, QDir::Name);
        if (models.isEmpty())
            continue;
        if (voice.isEmpty())
            return d.absoluteFilePath(models.first());
        for (const QString &m : models) {
            const QString basename = QFileInfo(m).completeBaseName();
            if (basename == voice || m == voice)
                return d.absoluteFilePath(m);
        }
    }
    return QString();
}

QString prettyVoiceLabel(const QString &basename)
{
    QString s = basename;
    s.replace(QLatin1Char('_'), QLatin1Char(' '));
    s.replace(QLatin1Char('-'), QLatin1Char(' '));
    return s;
}

} // namespace

bool whisperAvailable()
{
    static const bool ok = !whisperExe().isEmpty();
    return ok;
}

bool piperAvailable()
{
    static const bool ok = !piperExe().isEmpty();
    return ok;
}

bool sttLocalUsable(const QString &provider)
{
    if (provider == QStringLiteral("whisper"))
        return whisperAvailable() && !resolveWhisperModel(QString()).isEmpty();
    return false;
}

bool ttsLocalUsable(const QString &provider)
{
    if (provider == QStringLiteral("piper"))
        return piperAvailable() && !resolvePiperModel(QString()).isEmpty();
    return false;
}

QJsonArray sttProviders()
{
    QJsonArray arr;
    {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QStringLiteral("voxtral"));
        o.insert(QStringLiteral("label"), QStringLiteral("Voxtral (Mistral, cloud)"));
        o.insert(QStringLiteral("available"), true);
        arr.append(o);
    }
    {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QStringLiteral("whisper"));
        o.insert(QStringLiteral("label"), QStringLiteral("Whisper (local)"));
        o.insert(QStringLiteral("available"), whisperAvailable());
        arr.append(o);
    }
    return arr;
}

QJsonArray ttsProviders()
{
    QJsonArray arr;
    {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QStringLiteral("voxtral"));
        o.insert(QStringLiteral("label"), QStringLiteral("Voxtral (Mistral, cloud)"));
        o.insert(QStringLiteral("available"), true);
        arr.append(o);
    }
    {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QStringLiteral("piper"));
        o.insert(QStringLiteral("label"), QStringLiteral("Piper (local)"));
        o.insert(QStringLiteral("available"), piperAvailable());
        arr.append(o);
    }
    return arr;
}

QJsonArray whisperVoices()
{
    return QJsonArray(); // STT has no voices.
}

QJsonArray piperVoices()
{
    QJsonArray arr;
    QStringList seen;
    for (const QString &dirPath : piperVoiceDirs()) {
        QDir d(dirPath);
        if (!d.exists())
            continue;
        const QStringList models =
            d.entryList(QStringList() << QStringLiteral("*.onnx"), QDir::Files, QDir::Name);
        for (const QString &m : models) {
            const QString id = QFileInfo(m).completeBaseName();
            if (seen.contains(id))
                continue;
            seen << id;
            QJsonObject o;
            o.insert(QStringLiteral("id"), id);
            o.insert(QStringLiteral("label"), prettyVoiceLabel(id));
            arr.append(o);
        }
    }
    return arr;
}

// --- local impls -------------------------------------------------------------

namespace {

// Run whisper locally. Returns a populated Result on success; leaves r.ok=false
// (with no error set) when the local path could not be used, signalling the
// caller to fall back to voxtral.
VoiceResult runWhisper(const QByteArray &audio, const QString &mime,
                       const QString &lang, const QString &model, int timeoutMs)
{
    VoiceResult r;
    const QString exe = whisperExe();
    const QString modelPath = resolveWhisperModel(model);
    if (exe.isEmpty() || modelPath.isEmpty() || audio.isEmpty())
        return r; // not usable -> fall back

    QTemporaryDir tmp;
    if (!tmp.isValid())
        return r;

    const QString inPath =
        tmp.path() + QStringLiteral("/in.") + extForMime(mime);
    {
        QFile f(inPath);
        if (!f.open(QIODevice::WriteOnly))
            return r;
        f.write(audio);
        f.close();
    }
    const QString outBase = tmp.path() + QStringLiteral("/out");

    QStringList args;
    args << QStringLiteral("-m") << modelPath
         << QStringLiteral("-f") << inPath
         << QStringLiteral("-otxt")
         << QStringLiteral("-of") << outBase;
    if (!lang.isEmpty())
        args << QStringLiteral("-l") << lang;

    QProcess proc;
    proc.start(exe, args);
    if (!proc.waitForStarted(5000))
        return r;
    if (!proc.waitForFinished(timeoutMs)) {
        proc.kill();
        proc.waitForFinished(1000);
        return r;
    }
    if (proc.exitStatus() != QProcess::NormalExit || proc.exitCode() != 0)
        return r;

    QFile out(outBase + QStringLiteral(".txt"));
    if (!out.open(QIODevice::ReadOnly | QIODevice::Text))
        return r;
    const QString text = QString::fromUtf8(out.readAll()).trimmed();
    out.close();
    if (text.isEmpty())
        return r;

    r.ok = true;
    r.text = text;
    if (!lang.isEmpty())
        r.language = lang;
    return r;
}

// Run piper locally. Same fall-back contract as runWhisper.
VoiceResult runPiper(const QString &text, const QString &voice, int timeoutMs)
{
    VoiceResult r;
    const QString exe = piperExe();
    const QString modelPath = resolvePiperModel(voice);
    if (exe.isEmpty() || modelPath.isEmpty() || text.trimmed().isEmpty())
        return r; // not usable -> fall back

    QTemporaryDir tmp;
    if (!tmp.isValid())
        return r;
    const QString outPath = tmp.path() + QStringLiteral("/out.wav");

    QStringList args;
    args << QStringLiteral("--model") << modelPath
         << QStringLiteral("--output_file") << outPath;

    QProcess proc;
    proc.start(exe, args);
    if (!proc.waitForStarted(5000))
        return r;
    proc.write(text.toUtf8());
    proc.closeWriteChannel();
    if (!proc.waitForFinished(timeoutMs)) {
        proc.kill();
        proc.waitForFinished(1000);
        return r;
    }
    if (proc.exitStatus() != QProcess::NormalExit || proc.exitCode() != 0)
        return r;

    QFile out(outPath);
    if (!out.open(QIODevice::ReadOnly))
        return r;
    const QByteArray wav = out.readAll();
    out.close();
    if (wav.isEmpty())
        return r;

    r.ok = true;
    r.audio = wav;
    r.mime = QStringLiteral("audio/wav");
    return r;
}

} // namespace

VoiceResult sttWithProvider(const QString &provider, const QString &mistralKey,
                            const QByteArray &audio, const QString &mime,
                            const QString &lang, const QString &model, int timeoutMs)
{
    if (provider == QStringLiteral("whisper") && whisperAvailable()) {
        const VoiceResult local = runWhisper(audio, mime, lang, model, timeoutMs);
        if (local.ok)
            return local; // local succeeded
        // else: binary/model missing or run failed -> fall through to voxtral
    }
    return VoiceService(mistralKey).stt(audio, mime, lang, model, timeoutMs);
}

VoiceResult ttsWithProvider(const QString &provider, const QString &mistralKey,
                            const QString &text, const QString &voice,
                            const QString &format, const QString &model, int timeoutMs,
                            const QString &refAudioB64)
{
    // Voice cloning (ref_audio) is a Mistral capability; a local piper voice can't
    // clone, so a clone request always goes straight to the cloud VoiceService.
    if (refAudioB64.isEmpty() && provider == QStringLiteral("piper") && piperAvailable()) {
        const VoiceResult local = runPiper(text, voice, timeoutMs);
        if (local.ok)
            return local; // local succeeded
        // else: binary/model missing or run failed -> fall through to voxtral
    }
    return VoiceService(mistralKey).tts(text, voice, format, model, timeoutMs, refAudioB64);
}

} // namespace VoiceProvider
} // namespace jarvis
