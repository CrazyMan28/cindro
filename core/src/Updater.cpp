#include "jarvis/Updater.h"

#include <QCoreApplication>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStringList>
#include <QThread>
#include <QTimer>

#include <cstdio>

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
    // -CurrentVersion is passed EXPLICITLY: the script's env-var default
    // ($env:JARVIS_VERSION) was never set by the daemon, so `behind` could
    // never become true and Windows updates silently never fired.
    return QStringList{ QStringLiteral("powershell"), QStringLiteral("-NoProfile"),
                        QStringLiteral("-ExecutionPolicy"), QStringLiteral("Bypass"),
                        QStringLiteral("-File"), script,
                        QStringLiteral("-Mode"), mode,
                        QStringLiteral("-CurrentVersion"), runningVersion() };
#else
    return QStringList{ QStringLiteral("bash"), script, mode };
#endif
}

// --- native GitHub-release flow ----------------------------------------------

bool Updater::isAppImage()
{
#ifdef Q_OS_WIN
    return false; // AppImages don't exist on Windows — a leaked env var must not route here
#else
    // $APPIMAGE alone is NOT proof: AppImage-packaged terminals/IDEs leak it
    // into every child shell, and trusting it would make a dev jarvisd
    // overwrite SOMEONE ELSE'S AppImage on applyNow(). Require the running
    // binary to actually live inside this AppImage's mount ($APPDIR).
    const QString appimage = qEnvironmentVariable("APPIMAGE");
    const QString appdir = qEnvironmentVariable("APPDIR");
    if (appimage.isEmpty() || appdir.isEmpty())
        return false;
    return QCoreApplication::applicationFilePath().startsWith(appdir);
#endif
}

bool Updater::versionGreater(const QString &latest, const QString &current)
{
    auto nums = [](QString v) {
        if (v.startsWith(QLatin1Char('v')) || v.startsWith(QLatin1Char('V')))
            v = v.mid(1);
        QList<int> out;
        for (const QString &seg : v.split(QLatin1Char('.'))) {
            int i = 0;
            while (i < seg.size() && seg.at(i).isDigit())
                ++i;
            out << seg.left(i).toInt(); // "2-rc1" -> 2, "abc" -> 0
        }
        while (out.size() < 3)
            out << 0;
        return out;
    };
    auto isPre = [](const QString &v) { // "0.13.2-rc1" — any -suffix marker
        return v.contains(QLatin1Char('-'));
    };
    if (latest.trimmed().isEmpty() || current.trimmed().isEmpty())
        return false; // can't tell -> never report behind on incomplete data
    const QList<int> l = nums(latest), c = nums(current);
    for (int i = 0; i < qMax(l.size(), c.size()); ++i) {
        const int a = i < l.size() ? l.at(i) : 0;
        const int b = i < c.size() ? c.at(i) : 0;
        if (a != b)
            return a > b;
    }
    // Same numeric triple: the STABLE release is newer than its own
    // pre-release ("0.13.2" > "0.13.2-rc1") — an RC build must still be
    // offered the final release.
    return isPre(current) && !isPre(latest);
}

Updater::ReleaseAsset Updater::parseLatestRelease(const QByteArray &json,
                                                  const QString &assetGlob)
{
    ReleaseAsset out;
    const QJsonDocument doc = QJsonDocument::fromJson(json);
    if (!doc.isObject())
        return out;
    const QJsonObject o = doc.object();
    QString tag = o.value(QStringLiteral("tag_name")).toString();
    if (tag.startsWith(QLatin1Char('v')) || tag.startsWith(QLatin1Char('V')))
        tag = tag.mid(1);
    if (tag.isEmpty())
        return out;
    const QRegularExpression rx(QRegularExpression::wildcardToRegularExpression(assetGlob),
                                QRegularExpression::CaseInsensitiveOption);
    for (const QJsonValue &v : o.value(QStringLiteral("assets")).toArray()) {
        const QJsonObject a = v.toObject();
        const QString name = a.value(QStringLiteral("name")).toString();
        if (!rx.match(name).hasMatch())
            continue;
        out.tag = tag;
        out.name = name;
        out.url = a.value(QStringLiteral("browser_download_url")).toString();
        break;
    }
    return out;
}

QString Updater::assetGlob()
{
#ifdef Q_OS_WIN
    return QStringLiteral("Cindro-Setup-*.exe");
#else
    return QStringLiteral("*.AppImage");
#endif
}

QByteArray Updater::httpGet(const QString &url, int timeoutMs)
{
    QNetworkAccessManager nam;
    QNetworkRequest rq{QUrl(url)};
    rq.setRawHeader("User-Agent", "Cindro-Updater");
    rq.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                    QNetworkRequest::NoLessSafeRedirectPolicy);
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply = nam.get(rq);
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(qMax(1000, timeoutMs));
    loop.exec();
    QByteArray body;
    if (reply->error() == QNetworkReply::NoError)
        body = reply->readAll();
    reply->deleteLater();
    return body;
}

// Stream a (large) download straight to disk — the release assets are
// 100+MB and buffering them in a QByteArray spikes the daemon's RSS for no
// reason. Returns bytes written, or -1 on error/timeout.
static qint64 httpDownload(const QString &url, const QString &filePath, int timeoutMs)
{
    QFile out(filePath);
    if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return -1;
    QNetworkAccessManager nam;
    QNetworkRequest rq{QUrl(url)};
    rq.setRawHeader("User-Agent", "Cindro-Updater");
    rq.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                    QNetworkRequest::NoLessSafeRedirectPolicy);
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply = nam.get(rq);
    QObject::connect(reply, &QNetworkReply::readyRead, &loop, [&]() {
        out.write(reply->readAll());
    });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(qMax(1000, timeoutMs));
    loop.exec();
    out.write(reply->readAll()); // tail bytes after the last readyRead
    const bool ok = reply->error() == QNetworkReply::NoError;
    reply->deleteLater();
    out.close();
    if (!ok) {
        QFile::remove(filePath);
        return -1;
    }
    return QFileInfo(filePath).size();
}

Updater::ReleaseAsset Updater::latestRelease(int timeoutMs)
{
    // Overridable for forks/renames without a rebuild (the .ps1 has -Repo).
    QString repo = qEnvironmentVariable("JARVIS_UPDATE_REPO");
    if (repo.isEmpty())
        repo = QStringLiteral("CrazyMan28/jarvis");
    const QByteArray body = httpGet(
        QStringLiteral("https://api.github.com/repos/%1/releases/latest").arg(repo),
        timeoutMs);
    if (body.isEmpty())
        return {};
    return parseLatestRelease(body, assetGlob());
}

UpdateStatus Updater::releaseCheck(int timeoutMs)
{
    UpdateStatus st;
    st.version = runningVersion();
    st.current = runningVersion();
    const ReleaseAsset rel = latestRelease(qMin(timeoutMs, 10000));
    if (rel.tag.isEmpty()) {
        st.ok = false;
        st.reason = QStringLiteral("release check unreachable (offline?)");
        return st;
    }
    st.ok = true;
    st.latest = rel.tag;
    st.behind = versionGreater(rel.tag, runningVersion());
    if (!st.behind)
        st.reason = QStringLiteral("up to date with the latest release");
    return st;
}

QJsonObject Updater::releaseApply(int timeoutMs)
{
    QJsonObject out;
    const ReleaseAsset rel = latestRelease(10000);
    if (rel.tag.isEmpty() || rel.url.isEmpty()) {
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"),
                   QStringLiteral("release lookup failed (offline?)"));
        return out;
    }
    if (!versionGreater(rel.tag, runningVersion())) {
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("already up to date"));
        return out;
    }

    // The artifact is large (100+ MB) — STREAM it to disk (buffering it in a
    // QByteArray would spike the daemon's RSS by the asset size) and give the
    // download most of the budget.
#ifdef Q_OS_WIN
    const QString target =
        QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation))
            .absoluteFilePath(rel.name);
#else
    const QString self = qEnvironmentVariable("APPIMAGE");
    const QString target = self + QStringLiteral(".update");
#endif
    const qint64 size = httpDownload(rel.url, target, qMax(60000, timeoutMs - 15000));
    if (size < 1024 * 1024) { // a real installer/AppImage is many MB
        QFile::remove(target);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"),
                   QStringLiteral("download failed or truncated"));
        return out;
    }
    QByteArray magic;
    {
        QFile f(target);
        if (f.open(QIODevice::ReadOnly))
            magic = f.read(4);
    }

#ifdef Q_OS_WIN
    if (!magic.startsWith("MZ")) { // PE magic — never run a non-executable
        QFile::remove(target);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("asset is not a Windows installer"));
        return out;
    }
    // Inno silent install: closes the running apps, installs, relaunches them.
    // Detached — the installer will kill THIS process mid-install.
    const bool launched = QProcess::startDetached(
        target, {QStringLiteral("/VERYSILENT"), QStringLiteral("/SUPPRESSMSGBOXES"),
                 QStringLiteral("/NORESTART"), QStringLiteral("/CLOSEAPPLICATIONS"),
                 QStringLiteral("/RESTARTAPPLICATIONS")});
    out.insert(QStringLiteral("updated"), launched);
    out.insert(QStringLiteral("to"), rel.tag);
    out.insert(QStringLiteral("installer_launched"), launched);
    if (!launched)
        out.insert(QStringLiteral("reason"), QStringLiteral("failed to launch installer"));
    return out;
#else
    if (!magic.startsWith("\x7f" "ELF")) { // never overwrite self with junk
        QFile::remove(target);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("asset is not an executable"));
        return out;
    }
    {
        QFile f(target);
        f.setPermissions(f.permissions() | QFileDevice::ExeOwner |
                         QFileDevice::ExeGroup | QFileDevice::ExeOther);
    }
    // ROLLBACK story: keep the current build as .old — a downloaded build
    // that passes the (weak) magic/size checks but is broken would otherwise
    // be a one-way door with nothing left to fall back to.
    const QString backup = self + QStringLiteral(".old");
    QFile::remove(backup);
    if (std::rename(self.toLocal8Bit().constData(),
                    backup.toLocal8Bit().constData()) != 0) {
        QFile::remove(target);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("failed to back up the AppImage"));
        return out;
    }
    // POSIX rename() atomically replaces the destination; the running process
    // keeps its mmap'd old inode, the NEXT launch gets the new build. (QFile::
    // rename refuses to overwrite, so use std::rename.)
    if (std::rename(target.toLocal8Bit().constData(),
                    self.toLocal8Bit().constData()) != 0) {
        std::rename(backup.toLocal8Bit().constData(),
                    self.toLocal8Bit().constData()); // restore the original
        QFile::remove(target);
        out.insert(QStringLiteral("updated"), false);
        out.insert(QStringLiteral("reason"), QStringLiteral("failed to replace the AppImage"));
        return out;
    }
    out.insert(QStringLiteral("updated"), true);
    out.insert(QStringLiteral("to"), rel.tag);
    out.insert(QStringLiteral("restart_required"), true);
    out.insert(QStringLiteral("backup"), backup);
    return out;
#endif
}

UpdateStatus Updater::checkNow(int timeoutMs)
{
    // Packaged installs (a REAL AppImage; Windows with no repo scripts on
    // disk) use the native release flow — the scripts only exist in git
    // checkouts, where they stay authoritative.
    const QString script = scriptPath();
    if (isAppImage())
        return releaseCheck(timeoutMs);
#ifdef Q_OS_WIN
    if (script.isEmpty())
        return releaseCheck(timeoutMs);
#endif
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
    if (isAppImage())
        return releaseApply(timeoutMs);
#ifdef Q_OS_WIN
    if (script.isEmpty())
        return releaseApply(timeoutMs);
#endif
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

void Updater::configureAuto(bool enabled, int intervalHours, bool autoApply)
{
    m_autoEnabled = enabled;
    m_autoApply = autoApply;
    m_intervalHours = intervalHours >= 1 ? intervalHours : 6;
    if (!m_timer) {
        m_timer = new QTimer(this);
        m_timer->setSingleShot(false);
        connect(m_timer, &QTimer::timeout, this, [this]() {
            const UpdateStatus st = checkNow();
            if (st.ok && st.behind) {
                emit updateAvailable(st);
                // "Install updates automatically" (auto_update_apply=on):
                // download + apply, then report what happened. On a WORKER
                // thread — the 100+MB download would otherwise stall every
                // control RPC/chat turn for minutes on the daemon thread
                // (fine for the user-initiated update.apply RPC, not for an
                // unattended timer). Guarded against overlapping timer fires.
                if (m_autoApply && !m_applyInFlight) {
                    m_applyInFlight = true;
                    QThread *worker = QThread::create([this]() {
                        const QJsonObject r = applyNow();
                        QMetaObject::invokeMethod(this, [this, r]() {
                            m_applyInFlight = false;
                            emit autoApplied(r);
                        }, Qt::QueuedConnection);
                    });
                    connect(worker, &QThread::finished, worker, &QObject::deleteLater);
                    worker->start();
                }
            } else if (!st.ok) {
                emit checkFailed(st.reason);
            }
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
