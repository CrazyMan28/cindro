#include "jarvis/VoiceLibrary.h"

#include "jarvis/Config.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QProcess>
#include <QSaveFile>
#include <QStandardPaths>

namespace jarvis {

namespace {
const QString kJarvice = QStringLiteral("jarvice");
const QString kStockFallback = QStringLiteral("en_paul_neutral");
} // namespace

QString VoiceEntry::voiceSlug() const
{
    // The seed clip keeps the bare "jarvice" slug for back-compat with the
    // existing default; everything else is addressed as clone:<slug>. Both
    // resolve to <slug>_ref.<ext> via the daemon's resolver.
    return slug == kJarvice ? kJarvice : (QStringLiteral("clone:") + slug);
}

QJsonObject VoiceEntry::toJson(bool isDefault) const
{
    QJsonObject o;
    o.insert(QStringLiteral("id"), id);
    o.insert(QStringLiteral("name"), name);
    o.insert(QStringLiteral("slug"), slug);
    o.insert(QStringLiteral("ext"), ext);
    o.insert(QStringLiteral("source"), source);
    o.insert(QStringLiteral("raw"), raw);
    o.insert(QStringLiteral("created_at"), createdAt);
    o.insert(QStringLiteral("voice"), voiceSlug());
    o.insert(QStringLiteral("is_default"), isDefault);
    return o;
}

QString VoiceLibrary::defaultDir()
{
    return Config::configDir() + QStringLiteral("/voices");
}

QString VoiceLibrary::dir() const
{
    return m_dir.isEmpty() ? defaultDir() : m_dir;
}

QString VoiceLibrary::manifestPath() const
{
    return dir() + QStringLiteral("/voices.json");
}

QStringList VoiceLibrary::clipExtensions()
{
    return {QStringLiteral("mp3"), QStringLiteral("wav"), QStringLiteral("opus"),
            QStringLiteral("flac"), QStringLiteral("ogg")};
}

QString VoiceLibrary::normalizeExt(const QString &format)
{
    QString f = format.trimmed().toLower();
    if (f.startsWith(QLatin1Char('.')))
        f = f.mid(1);
    // common aliases / mime tails
    if (f == QStringLiteral("mpeg") || f == QStringLiteral("mpga") || f == QStringLiteral("mp3"))
        f = QStringLiteral("mp3");
    else if (f == QStringLiteral("wave") || f == QStringLiteral("x-wav") ||
             f == QStringLiteral("wav"))
        f = QStringLiteral("wav");
    else if (f == QStringLiteral("ogg") || f == QStringLiteral("oga"))
        f = QStringLiteral("ogg");
    if (clipExtensions().contains(f))
        return f;
    return QString();
}

QString VoiceLibrary::slug(const QString &name)
{
    QString out;
    for (const QChar &ch : name) {
        if (ch.isLetterOrNumber())
            out.append(ch.toLower());
        else if (ch == QLatin1Char('-') || ch == QLatin1Char('_'))
            out.append(ch);
        else if (ch.isSpace() || ch == QLatin1Char('/') || ch == QLatin1Char('.'))
            out.append(QLatin1Char('_'));
    }
    while (out.contains(QStringLiteral("__")))
        out.replace(QStringLiteral("__"), QStringLiteral("_"));
    while (out.startsWith(QLatin1Char('_')))
        out.remove(0, 1);
    while (out.endsWith(QLatin1Char('_')))
        out.chop(1);
    if (out.isEmpty())
        out = QStringLiteral("voice");
    return out;
}

void VoiceLibrary::load()
{
    m_default.clear();
    m_voices.clear();
    m_lastError.clear();

    QFile f(manifestPath());
    if (f.exists() && f.open(QIODevice::ReadOnly)) {
        const QJsonDocument d = QJsonDocument::fromJson(f.readAll());
        f.close();
        if (d.isObject()) {
            const QJsonObject root = d.object();
            m_default = root.value(QStringLiteral("default")).toString();
            const QJsonArray arr = root.value(QStringLiteral("voices")).toArray();
            for (const QJsonValue &v : arr) {
                const QJsonObject o = v.toObject();
                VoiceEntry e;
                e.slug = o.value(QStringLiteral("slug")).toString();
                e.id = o.value(QStringLiteral("id")).toString();
                if (e.id.isEmpty())
                    e.id = e.slug;
                if (e.slug.isEmpty())
                    e.slug = e.id;
                if (e.slug.isEmpty())
                    continue;
                e.name = o.value(QStringLiteral("name")).toString();
                if (e.name.isEmpty())
                    e.name = e.slug;
                e.ext = o.value(QStringLiteral("ext")).toString();
                e.source = o.value(QStringLiteral("source")).toString(QStringLiteral("upload"));
                e.raw = o.value(QStringLiteral("raw")).toBool();
                e.createdAt = o.value(QStringLiteral("created_at")).toString();
                m_voices.push_back(e);
            }
        }
    }

    if (m_voices.isEmpty())
        seedFromDisk(); // sets m_default + persists if anything found

    // Make sure the default always points at a real voice (or a stock fallback).
    if (repairDefault())
        save();
}

void VoiceLibrary::seedFromDisk()
{
    QDir d(dir());
    if (!d.exists())
        return;
    bool found = false;
    for (const QString &ext : clipExtensions()) {
        const QStringList files = d.entryList(
            {QStringLiteral("*_ref.") + ext}, QDir::Files, QDir::Name);
        for (const QString &fn : files) {
            QString base = fn;
            base.chop(QStringLiteral("_ref.").size() + ext.size()); // strip _ref.<ext>
            if (base.isEmpty())
                continue;
            // skip if we already have this slug (a clip in another ext)
            bool dup = false;
            for (const VoiceEntry &e : m_voices)
                if (e.slug == base) { dup = true; break; }
            if (dup)
                continue;
            VoiceEntry e;
            e.slug = base;
            e.id = base;
            e.ext = ext;
            e.source = QStringLiteral("seed");
            e.raw = false;
            e.createdAt = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);
            e.name = (base == kJarvice) ? QStringLiteral("Orin") : base;
            m_voices.push_back(e);
            found = true;
        }
    }
    if (found) {
        // Prefer jarvice as the seeded default; else the first discovered clip.
        for (const VoiceEntry &e : m_voices) {
            if (e.slug == kJarvice) { m_default = e.voiceSlug(); break; }
        }
        if (m_default.isEmpty() && !m_voices.isEmpty())
            m_default = m_voices.front().voiceSlug();
        save();
    }
}

std::optional<VoiceEntry> VoiceLibrary::find(const QString &id) const
{
    for (const VoiceEntry &e : m_voices) {
        if (e.id == id || e.slug == id || e.voiceSlug() == id)
            return e;
    }
    return std::nullopt;
}

QJsonArray VoiceLibrary::toListJson() const
{
    QJsonArray arr;
    for (const VoiceEntry &e : m_voices) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), e.voiceSlug());
        o.insert(QStringLiteral("label"), e.name);
        o.insert(QStringLiteral("custom"), true);
        o.insert(QStringLiteral("slug"), e.slug);
        o.insert(QStringLiteral("source"), e.source);
        o.insert(QStringLiteral("raw"), e.raw);
        o.insert(QStringLiteral("is_default"), e.voiceSlug() == m_default);
        arr.append(o);
    }
    return arr;
}

bool VoiceLibrary::ffmpegClean(const QString &inPath, const QString &outMp3, bool filters)
{
    const QString ff = QStandardPaths::findExecutable(QStringLiteral("ffmpeg"));
    if (ff.isEmpty())
        return false;
    QStringList args{QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"),
                     QStringLiteral("error"),        QStringLiteral("-y"),
                     QStringLiteral("-t"),           QStringLiteral("25"),
                     QStringLiteral("-i"),           inPath,
                     QStringLiteral("-ac"),          QStringLiteral("1"),
                     QStringLiteral("-ar"),          QStringLiteral("24000")};
    if (filters) {
        // 80 Hz high-pass kills rumble; loudnorm evens the level for a clean clone
        // (the same chain scripts/jarvice_voice.py uses for build-ref).
        args << QStringLiteral("-af")
             << QStringLiteral("highpass=f=80,loudnorm=I=-18:TP=-1.5:LRA=11");
    }
    args << QStringLiteral("-c:a") << QStringLiteral("libmp3lame") << QStringLiteral("-q:a")
         << QStringLiteral("2") << outMp3;
    QProcess p;
    p.start(ff, args);
    if (!p.waitForStarted(5000))
        return false;
    if (!p.waitForFinished(60000)) {
        p.kill();
        return false;
    }
    if (p.exitStatus() != QProcess::NormalExit || p.exitCode() != 0)
        return false;
    QFileInfo fi(outMp3);
    return fi.exists() && fi.size() > 0;
}

std::optional<VoiceEntry> VoiceLibrary::createClone(const QString &name, const QByteArray &audio,
                                                    const QString &format, bool clean,
                                                    const QString &source)
{
    m_lastError.clear();
    if (audio.isEmpty()) {
        m_lastError = QStringLiteral("empty audio");
        return std::nullopt;
    }
    QDir d(dir());
    if (!d.exists() && !d.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("cannot create voices dir: ") + dir();
        return std::nullopt;
    }

    const QString sl = slug(name);
    // create-or-replace by slug: a re-record under the same name overwrites.
    int existingIdx = -1;
    for (int i = 0; i < m_voices.size(); ++i)
        if (m_voices[i].slug == sl) { existingIdx = i; break; }

    // Write the incoming bytes to a temp input file for ffmpeg / verbatim copy.
    const QString inExt = normalizeExt(format).isEmpty()
                              ? QStringLiteral("bin")
                              : normalizeExt(format);
    const QString inPath = dir() + QStringLiteral("/.incoming_") + sl + QStringLiteral(".") + inExt;
    {
        QSaveFile sf(inPath);
        if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            m_lastError = QStringLiteral("cannot write temp clip: ") + sf.errorString();
            return std::nullopt;
        }
        sf.write(audio);
        if (!sf.commit()) {
            m_lastError = QStringLiteral("cannot commit temp clip: ") + sf.errorString();
            return std::nullopt;
        }
    }

    QString outExt;
    bool wasRaw = false;
    const QString outMp3 = dir() + QStringLiteral("/") + sl + QStringLiteral("_ref.mp3");

    if (clean && ffmpegClean(inPath, outMp3, /*filters=*/true)) {
        outExt = QStringLiteral("mp3");
    } else {
        // Raw / fallback path. Keep the bytes verbatim if the container is one the
        // resolver understands; otherwise transcode to mp3 (no clean filters) so a
        // .m4a/.webm upload still resolves. If neither works, fail loudly.
        const QString direct = normalizeExt(format);
        if (!direct.isEmpty()) {
            const QString outPath =
                dir() + QStringLiteral("/") + sl + QStringLiteral("_ref.") + direct;
            QFile::remove(outPath);
            if (!QFile::copy(inPath, outPath)) {
                QFile::remove(inPath);
                m_lastError = QStringLiteral("cannot store clip: ") + outPath;
                return std::nullopt;
            }
            outExt = direct;
            wasRaw = true;
        } else if (ffmpegClean(inPath, outMp3, /*filters=*/false)) {
            outExt = QStringLiteral("mp3");
            wasRaw = true;
        } else {
            QFile::remove(inPath);
            m_lastError = QStringLiteral(
                "unsupported audio format and ffmpeg unavailable for transcode");
            return std::nullopt;
        }
    }
    QFile::remove(inPath);

    // If replacing and the old clip used a different extension, remove the stale file.
    if (existingIdx >= 0) {
        const QString oldExt = m_voices[existingIdx].ext;
        if (!oldExt.isEmpty() && oldExt != outExt)
            QFile::remove(dir() + QStringLiteral("/") + sl + QStringLiteral("_ref.") + oldExt);
    }

    VoiceEntry e;
    e.slug = sl;
    e.id = sl;
    e.ext = outExt;
    e.name = name.trimmed().isEmpty() ? sl : name.trimmed();
    e.source = source;
    e.raw = wasRaw;
    e.createdAt = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);

    if (existingIdx >= 0)
        m_voices[existingIdx] = e;
    else
        m_voices.push_back(e);

    if (m_default.isEmpty())
        m_default = e.voiceSlug();
    if (!save())
        return std::nullopt;
    return e;
}

bool VoiceLibrary::removeClone(const QString &id)
{
    int idx = -1;
    for (int i = 0; i < m_voices.size(); ++i)
        if (m_voices[i].id == id || m_voices[i].slug == id ||
            m_voices[i].voiceSlug() == id) { idx = i; break; }
    if (idx < 0) {
        m_lastError = QStringLiteral("no such voice: ") + id;
        return false;
    }
    const VoiceEntry e = m_voices[idx];
    // Remove every clip-ext variant for this slug (be thorough).
    for (const QString &ext : clipExtensions())
        QFile::remove(dir() + QStringLiteral("/") + e.slug + QStringLiteral("_ref.") + ext);
    m_voices.removeAt(idx);
    repairDefault();
    return save();
}

bool VoiceLibrary::setDefault(const QString &id)
{
    const auto e = find(id);
    if (!e) {
        m_lastError = QStringLiteral("no such voice: ") + id;
        return false;
    }
    m_default = e->voiceSlug();
    return save();
}

bool VoiceLibrary::setDefaultSlug(const QString &voiceSlug)
{
    m_default = voiceSlug;
    return save();
}

bool VoiceLibrary::rename(const QString &id, const QString &name)
{
    int idx = -1;
    for (int i = 0; i < m_voices.size(); ++i)
        if (m_voices[i].id == id || m_voices[i].slug == id ||
            m_voices[i].voiceSlug() == id) { idx = i; break; }
    if (idx < 0) {
        m_lastError = QStringLiteral("no such voice: ") + id;
        return false;
    }
    const QString newSlug = slug(name);
    VoiceEntry &e = m_voices[idx];
    const bool wasDefault = (e.voiceSlug() == m_default);
    if (newSlug != e.slug) {
        const QString from =
            dir() + QStringLiteral("/") + e.slug + QStringLiteral("_ref.") + e.ext;
        const QString to =
            dir() + QStringLiteral("/") + newSlug + QStringLiteral("_ref.") + e.ext;
        if (QFile::exists(from)) {
            QFile::remove(to);
            QFile::rename(from, to);
        }
        e.slug = newSlug;
        e.id = newSlug;
    }
    e.name = name.trimmed().isEmpty() ? e.slug : name.trimmed();
    if (wasDefault)
        m_default = e.voiceSlug();
    return save();
}

QString VoiceLibrary::clipPath(const QString &voiceOrId) const
{
    QString s = voiceOrId.trimmed();
    if (s.isEmpty())
        return QString();
    if (s.startsWith(QStringLiteral("clone:")))
        s = s.mid(6);
    // "jarvice"/bare slug/id all map to a slug; check the manifest first so an id
    // resolves, then fall through to a bare slug on disk.
    QString sl = s;
    if (const auto e = find(voiceOrId))
        sl = e->slug;
    for (const QString &ext : clipExtensions()) {
        const QString p = dir() + QStringLiteral("/") + sl + QStringLiteral("_ref.") + ext;
        if (QFile::exists(p))
            return p;
    }
    return QString();
}

QString VoiceLibrary::defaultClipPath() const
{
    return clipPath(m_default);
}

bool VoiceLibrary::repairDefault()
{
    // Already valid?
    if (!m_default.isEmpty()) {
        for (const VoiceEntry &e : m_voices)
            if (e.voiceSlug() == m_default)
                return false;
    }
    const QString before = m_default;
    // Prefer jarvice, else first custom, else a stock voice so TTS never breaks.
    QString next;
    for (const VoiceEntry &e : m_voices)
        if (e.slug == kJarvice) { next = e.voiceSlug(); break; }
    if (next.isEmpty() && !m_voices.isEmpty())
        next = m_voices.front().voiceSlug();
    if (next.isEmpty())
        next = kStockFallback;
    m_default = next;
    return m_default != before;
}

bool VoiceLibrary::save()
{
    QDir d(dir());
    if (!d.exists() && !d.mkpath(QStringLiteral("."))) {
        m_lastError = QStringLiteral("cannot create voices dir: ") + dir();
        return false;
    }
    QJsonObject root;
    root.insert(QStringLiteral("default"), m_default);
    QJsonArray arr;
    for (const VoiceEntry &e : m_voices)
        arr.append(e.toJson(e.voiceSlug() == m_default));
    root.insert(QStringLiteral("voices"), arr);

    QSaveFile sf(manifestPath());
    if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_lastError = QStringLiteral("cannot write voices.json: ") + sf.errorString();
        return false;
    }
    sf.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    if (!sf.commit()) {
        m_lastError = QStringLiteral("cannot commit voices.json: ") + sf.errorString();
        return false;
    }
    return true;
}

} // namespace jarvis
