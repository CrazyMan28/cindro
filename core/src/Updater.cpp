#include "jarvis/Updater.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QProcess>
#include <QStringList>
#include <QTimer>

namespace jarvis {

Updater::Updater(QObject *parent) : QObject(parent) {}
Updater::~Updater() = default;

QString Updater::runningVersion()
{
#ifdef JARVIS_VERSION
    return QStringLiteral(JARVIS_VERSION);
#else
    return QStringLiteral("unknown");
#endif
}

QString Updater::runningSha()
{
#ifdef JARVIS_GIT_SHA
    return QStringLiteral(JARVIS_GIT_SHA);
#else
    return QStringLiteral("unknown");
#endif
}

QString Updater::scriptPath()
{
#ifdef Q_OS_WIN
    const QString rel = QStringLiteral("windows/scripts/update.ps1");
#else
    const QString rel = QStringLiteral("packaging/update.sh");
#endif
    QStringList candidates;
    // 1) Explicit override (set by a packaged install if the layout differs).
    const QString root = qEnvironmentVariable("JARVIS_REPO_ROOT");
    if (!root.isEmpty())
        candidates << QDir(root).absoluteFilePath(rel);
    // 2) Exe-relative (AgentDesktop precedent): jarvisd lives at <root>/build/daemon,
    //    the UI at <root>/build/desktop — both reach the repo root via ../../.
    const QString exeDir = QCoreApplication::applicationDirPath();
    candidates << QDir(exeDir).absoluteFilePath(QStringLiteral("../../") + rel);
    candidates << QDir(exeDir).absoluteFilePath(QStringLiteral("../../../") + rel);
    candidates << QDir(exeDir).absoluteFilePath(QStringLiteral("../") + rel);
    candidates << QDir(exeDir).absoluteFilePath(rel);
    for (const QString &c : candidates) {
        if (QFileInfo::exists(c))
            return QDir::cleanPath(c);
    }
    return QString();
}

bool Updater::computeBehind(const QString &current, const QString &latest, bool scriptBehind)
{
    if (scriptBehind)
        return true;
    // Can't tell with a missing side; never report behind on incomplete data.
    if (current.isEmpty() || latest.isEmpty())
        return false;
    return current != latest;
}

UpdateStatus Updater::parseCheckResult(const QByteArray &json,
                                       const QString &runningVersion,
                                       const QString &runningSha)
{
    UpdateStatus st;
    st.version = runningVersion;
    const QJsonDocument doc = QJsonDocument::fromJson(json);
    if (!doc.isObject()) {
        st.ok = false;
        st.current = runningSha;
        st.reason = QStringLiteral("invalid update-check output");
        return st;
    }
    const QJsonObject o = doc.object();
    st.ok = true;
    // `current`/`latest` may be null (e.g. non-git install) -> empty string.
    st.current = o.value(QStringLiteral("current")).toString();
    if (st.current.isEmpty())
        st.current = runningSha;
    st.latest = o.value(QStringLiteral("latest")).toString();
    st.reason = o.value(QStringLiteral("reason")).toString();
    const bool scriptBehind = o.value(QStringLiteral("behind")).toBool(false);
    st.behind = computeBehind(o.value(QStringLiteral("current")).toString(),
                              st.latest, scriptBehind);
    return st;
}

QStringList Updater::scriptCommand(const QString &script, const QString &mode)
{
#ifdef Q_OS_WIN
    return QStringList{ QStringLiteral("powershell"), QStringLiteral("-NoProfile"),
                        QStringLiteral("-ExecutionPolicy"), QStringLiteral("Bypass"),
                        QStringLiteral("-File"), script,
                        QStringLiteral("-Mode"), mode };
#else
    return QStringList{ QStringLiteral("bash"), script, mode };
#endif
}

UpdateStatus Updater::checkNow(int timeoutMs)
{
    const QString script = scriptPath();
    if (script.isEmpty()) {
        UpdateStatus st;
        st.ok = false;
        st.version = runningVersion();
        st.current = runningSha();
        st.reason = QStringLiteral("update script not found");
        return st;
    }
    QProcess p;
    const QStringList cmd = scriptCommand(script, QStringLiteral("check"));
    p.setProgram(cmd.first());
    p.setArguments(cmd.mid(1));
    p.start();
    if (!p.waitForStarted(5000) || !p.waitForFinished(timeoutMs)) {
        p.kill();
        p.waitForFinished(2000);
        UpdateStatus st;
        st.ok = false;
        st.version = runningVersion();
        st.current = runningSha();
        st.reason = QStringLiteral("update check did not complete");
        return st;
    }
    return parseCheckResult(p.readAllStandardOutput(), runningVersion(), runningSha());
}

QJsonObject Updater::applyNow(int timeoutMs)
{
    QJsonObject out;
    const QString script = scriptPath();
    if (script.isEmpty()) {
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("update script not found"));
        return out;
    }
    QProcess p;
    const QStringList cmd = scriptCommand(script, QStringLiteral("apply"));
    p.setProgram(cmd.first());
    p.setArguments(cmd.mid(1));
    p.start();
    if (!p.waitForStarted(5000) || !p.waitForFinished(timeoutMs)) {
        p.kill();
        p.waitForFinished(2000);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("update apply did not complete"));
        return out;
    }
    const QByteArray raw = p.readAllStandardOutput();
    // The apply script may print progress lines to stderr and the JSON result on
    // the LAST stdout line; take the last non-empty line as the result object.
    const QList<QByteArray> lines = raw.split('\n');
    for (int i = lines.size() - 1; i >= 0; --i) {
        const QByteArray t = lines.at(i).trimmed();
        if (t.isEmpty())
            continue;
        const QJsonDocument d = QJsonDocument::fromJson(t);
        if (d.isObject()) {
            out = d.object();
            break;
        }
    }
    if (out.isEmpty()) {
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("no result from update script"));
    }
    return out;
}

void Updater::configureAuto(bool enabled, int intervalHours)
{
    m_autoEnabled = enabled;
    m_intervalHours = intervalHours >= 1 ? intervalHours : 6;
    if (!m_timer) {
        m_timer = new QTimer(this);
        m_timer->setSingleShot(false);
        connect(m_timer, &QTimer::timeout, this, [this]() {
            const UpdateStatus st = checkNow();
            if (st.ok && st.behind)
                emit updateAvailable(st);
            else if (!st.ok)
                emit checkFailed(st.reason);
        });
    }
    m_timer->stop();
    if (m_autoEnabled) {
        // Hours -> ms as qint64, then clamp to the QTimer int range (max ~24 days).
        const qint64 ms = static_cast<qint64>(m_intervalHours) * 3600 * 1000;
        m_timer->setInterval(static_cast<int>(qMin<qint64>(ms, 2'000'000'000)));
        m_timer->start();
    }
}

} // namespace jarvis
