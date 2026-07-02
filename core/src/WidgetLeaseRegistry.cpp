#include "jarvis/WidgetLeaseRegistry.h"

#include "jarvis/DataPaths.h"
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>

namespace jarvis {

namespace {

// Mirror the Python live_widgets._safe(): keep [A-Za-z0-9-_], else '_'.
QString sanitize(const QString &s)
{
    QString out;
    out.reserve(s.size());
    for (const QChar ch : s) {
        if (ch.isLetterOrNumber() || ch == QLatin1Char('-') || ch == QLatin1Char('_'))
            out.append(ch);
        else
            out.append(QLatin1Char('_'));
    }
    return out.isEmpty() ? QStringLiteral("w") : out;
}

} // namespace

QString WidgetLeaseRegistry::defaultDir()
{
    const QByteArray override = qgetenv("JARVIS_WIDGET_VIEWERS");
    if (!override.isEmpty())
        return QString::fromLocal8Bit(override);
    // Honor XDG_DATA_HOME like the engine's live-widget supervisor so the daemon
    // writes leases to the SAME dir the supervisor reads (DataPaths.h). Unchanged on
    // the default (~/.local/share/jarvis/widget_viewers) on Linux and Windows.
    return jarvis::dataDir() + QStringLiteral("/widget_viewers");
}

WidgetLeaseRegistry::WidgetLeaseRegistry(const QString &dir)
    : m_dir(dir.isEmpty() ? defaultDir() : dir)
{
    QDir().mkpath(m_dir);
}

QString WidgetLeaseRegistry::keyFor(const QString &source, const QString &scope) const
{
    return sanitize(source) + QStringLiteral("__") + sanitize(scope);
}

void WidgetLeaseRegistry::touch(const QString &scope, const QString &kind,
                                const QString &source, qint64 tsMs)
{
    if (scope.isEmpty())
        return;
    if (tsMs < 0)
        tsMs = QDateTime::currentMSecsSinceEpoch();
    QJsonObject rec;
    rec.insert(QStringLiteral("scope"), scope);
    rec.insert(QStringLiteral("kind"), kind);
    rec.insert(QStringLiteral("source"), source);
    rec.insert(QStringLiteral("ts"), tsMs);
    QDir().mkpath(m_dir);
    QFile f(m_dir + QStringLiteral("/") + keyFor(source, scope) + QStringLiteral(".json"));
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(QJsonDocument(rec).toJson(QJsonDocument::Compact));
        f.close();
    }
}

void WidgetLeaseRegistry::clear(const QString &scope, const QString &source)
{
    QFile::remove(m_dir + QStringLiteral("/") + keyFor(source, scope) + QStringLiteral(".json"));
}

void WidgetLeaseRegistry::clearSource(const QString &source)
{
    const QString prefix = sanitize(source) + QStringLiteral("__");
    const QDir d(m_dir);
    const QStringList files = d.entryList(QStringList{QStringLiteral("*.json")}, QDir::Files);
    for (const QString &name : files) {
        if (name.startsWith(prefix))
            QFile::remove(d.filePath(name));
    }
}

void WidgetLeaseRegistry::wipeAll()
{
    const QDir d(m_dir);
    const QStringList files = d.entryList(QStringList{QStringLiteral("*.json")}, QDir::Files);
    for (const QString &name : files)
        QFile::remove(d.filePath(name));
}

int WidgetLeaseRegistry::sweep(qint64 ttlMs, qint64 nowMs)
{
    if (nowMs < 0)
        nowMs = QDateTime::currentMSecsSinceEpoch();
    int removed = 0;
    const QDir d(m_dir);
    const QStringList files = d.entryList(QStringList{QStringLiteral("*.json")}, QDir::Files);
    for (const QString &name : files) {
        const QString path = d.filePath(name);
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly))
            continue;
        const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
        f.close();
        const qint64 ts = qint64(o.value(QStringLiteral("ts")).toDouble());
        if (nowMs - ts > ttlMs) {
            if (QFile::remove(path))
                ++removed;
        }
    }
    return removed;
}

QStringList WidgetLeaseRegistry::activeScopes(qint64 ttlMs, qint64 nowMs) const
{
    if (nowMs < 0)
        nowMs = QDateTime::currentMSecsSinceEpoch();
    QStringList scopes;
    const QDir d(m_dir);
    const QStringList files = d.entryList(QStringList{QStringLiteral("*.json")}, QDir::Files);
    for (const QString &name : files) {
        QFile f(d.filePath(name));
        if (!f.open(QIODevice::ReadOnly))
            continue;
        const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
        f.close();
        const qint64 ts = qint64(o.value(QStringLiteral("ts")).toDouble());
        if (nowMs - ts <= ttlMs) {
            const QString scope = o.value(QStringLiteral("scope")).toString();
            if (!scope.isEmpty() && !scopes.contains(scope))
                scopes.append(scope);
        }
    }
    return scopes;
}

} // namespace jarvis
