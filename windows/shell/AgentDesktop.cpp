// windows/shell/AgentDesktop.cpp — Windows COPY of core/src/AgentDesktop.cpp.
//
// The Linux original spins up a NESTED headless Sway compositor plus a bound
// per-session computer-use engine (the "beside-you" agent desktop), using
// POSIX-only machinery: <signal.h>/<unistd.h>, getuid(), ::kill(), and /proc
// scanning for orphan reaping. None of that exists on Windows.
//
// This copy implements the SAME jarvis::AgentDesktop class (same header,
// core/include/jarvis/AgentDesktop.h, compiled read-only) so the rest of the
// daemon links unchanged — but the nested-desktop spawn/teardown is a no-op stub:
//   ensure()        -> fails with "nested agent desktop not available on Windows
//                      (v2)" (Windows v1 drives the REAL screen via take-over; a
//                      child-RDP / Windows-Sandbox / VM is the planned v2).
//   sweepOrphans()  -> 0 (nothing to reap; no /proc).
// The portable, daemon-facing accessors (info/engineBase/bearer/teardown/...) and
// the env/exe-relative defaultEngineDir() are kept verbatim, so any code path that
// merely queries an (always-empty) desktop set behaves identically to Linux.
//
// This file is compiled INSTEAD of core/src/AgentDesktop.cpp on Windows; the Linux
// original is excluded from the Windows core target and never edited.

#include "jarvis/AgentDesktop.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QProcess>
#include <QRandomGenerator>
#include <QStringList>

namespace jarvis {

QJsonObject AgentDesktopInfo::toJson() const
{
    QJsonObject o;
    o.insert(QStringLiteral("session_id"), sessionId);
    o.insert(QStringLiteral("port"), port);
    o.insert(QStringLiteral("mcp_url"), mcpUrl);
    o.insert(QStringLiteral("wayland_display"), waylandDisplay);
    o.insert(QStringLiteral("swaysock"), swaysock);
    o.insert(QStringLiteral("sway_pid"), double(swayPid));
    o.insert(QStringLiteral("engine_pid"), double(enginePid));
    o.insert(QStringLiteral("width"), width);
    o.insert(QStringLiteral("height"), height);
    o.insert(QStringLiteral("up"), up);
    // NB: bearer is intentionally omitted (never echoed to clients).
    return o;
}

AgentDesktop::AgentDesktop(Options opts, QObject *parent)
    : QObject(parent), m_opts(std::move(opts))
{
    if (m_opts.engineDir.isEmpty())
        m_opts.engineDir = defaultEngineDir();
    if (m_opts.basePort <= 0)
        m_opts.basePort = 8810;
}

AgentDesktop::~AgentDesktop()
{
    teardownAll();
}

QString AgentDesktop::defaultEngineDir()
{
    // Kept identical to Linux: prefer a path relative to the running executable
    // (on Windows the engine ships next to the exe / under the install dir), then
    // an explicit JARVIS_ENGINE_DIR override, else the exe-relative guess.
    const QString fromExe = QDir(QCoreApplication::applicationDirPath())
                                .absoluteFilePath(QStringLiteral("../../computer-use"));
    if (QFileInfo::exists(QDir(fromExe).absoluteFilePath(QStringLiteral("pyproject.toml"))))
        return QDir(fromExe).absolutePath();
    const QString fromEnv = qEnvironmentVariable("JARVIS_ENGINE_DIR");
    return fromEnv.isEmpty() ? QDir(fromExe).absolutePath() : fromEnv;
}

QString AgentDesktop::genBearer()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(24, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QString::fromLatin1(bytes.toHex());
}

int AgentDesktop::nextPort() const
{
    int p = m_opts.basePort;
    auto used = [&](int port) {
        for (const auto &[id, desk] : m_desks)
            if (desk->info.port == port)
                return true;
        for (const auto &[id, res] : m_reserved)
            if (res.first == port)
                return true;
        return false;
    };
    while (used(p))
        ++p;
    return p;
}

void AgentDesktop::killProc(QProcess *p, int graceMs)
{
    // Portable on Windows (terminate()->WM_CLOSE/console-ctrl, kill()->TerminateProcess).
    if (!p)
        return;
    p->disconnect();
    if (p->state() != QProcess::NotRunning) {
        p->terminate();
        if (!p->waitForFinished(graceMs))
            p->kill();
        p->waitForFinished(graceMs);
    }
    p->deleteLater();
}

AgentDesktopInfo AgentDesktop::ensure(const QString &sessionId, QString *err)
{
    // Windows v1 has no nested "beside-you" agent desktop (the Linux path nests a
    // headless Sway compositor + a bound per-session engine). Fail cleanly so the
    // caller (ControlServer::createSession for a coworker+agent session) surfaces
    // a clear message instead of half-provisioning. The agent still works on the
    // REAL screen via the take-over path. A child-RDP / Windows-Sandbox / VM
    // isolated desktop is the planned v2 (see windows/README.md).
    Q_UNUSED(sessionId);
    m_lastError = QStringLiteral("nested agent desktop not available on Windows (v2)");
    if (err)
        *err = m_lastError;
    return {};
}

AgentDesktopInfo AgentDesktop::info(const QString &sessionId) const
{
    if (auto it = m_desks.find(sessionId); it != m_desks.end())
        return it->second->info;
    return {};
}

QString AgentDesktop::engineBase(const QString &sessionId) const
{
    if (auto it = m_desks.find(sessionId); it != m_desks.end())
        return QStringLiteral("http://127.0.0.1:%1").arg(it->second->info.port);
    return {};
}

QString AgentDesktop::bearer(const QString &sessionId) const
{
    if (auto it = m_desks.find(sessionId); it != m_desks.end())
        return it->second->info.bearer;
    return {};
}

void AgentDesktop::teardown(const QString &sessionId)
{
    // m_desks is always empty on Windows (ensure() never populates it), but keep
    // the exact same shape as Linux so the call is a safe no-op for a missing id
    // and would correctly clean up if a future v2 ever fills it.
    auto it = m_desks.find(sessionId);
    if (it == m_desks.end())
        return;
    Desk &d = *it->second;
    killProc(d.engine);
    d.engine = nullptr;
    killProc(d.sway);
    d.sway = nullptr;
    if (!d.runtimeDir.isEmpty())
        QDir(d.runtimeDir).removeRecursively();
    if (!d.configDir.isEmpty())
        QDir(d.configDir).removeRecursively();
    if (!d.confPath.isEmpty())
        QFile::remove(d.confPath);
    m_desks.erase(it);
}

void AgentDesktop::releaseSession(const QString &sessionId)
{
    teardown(sessionId);
    m_reserved.erase(sessionId);
}

void AgentDesktop::teardownAll()
{
    QStringList ids;
    for (const auto &[id, desk] : m_desks)
        ids << id;
    for (const QString &id : ids)
        teardown(id);
}

int AgentDesktop::sweepOrphans()
{
    // No /proc on Windows and nothing is ever spawned, so there are no orphan
    // nested compositors/engines to reap. Safe, idempotent no-op.
    return 0;
}

} // namespace jarvis
