// windows/shell/PluginSandbox.cpp — Windows COPY of core/src/PluginSandbox.cpp.
//
// The Linux original confines a stdio MCP plugin in a TRANSIENT systemd `.service`
// (`systemd-run --user … ProtectHome=/ProtectSystem=/PrivateNetwork=/ReadWritePaths=`)
// and reaps it with `systemctl --user stop` + a by-PID ::kill() backstop. None of
// that exists on Windows, so this copy compiles the SAME jarvis::PluginSandbox
// class (same header, core/include/jarvis/PluginSandbox.h, compiled read-only) with
// the systemd path removed:
//
//   - systemdRunAvailable() -> false (so plan() always resolves the FALLBACK launch).
//   - plan() is kept verbatim — its pure permission→argv logic is portable and the
//     unit tests (Linux) still cover it; on Windows it only ever returns the
//     fallback (the plugin's own program + a scrubbed env).
//   - start()/stop()/isRunning() drive a plain, consent-gated QProcess: we launch
//     ONLY a declared stdio mcp/both plugin, with the environment scrubbed to the
//     plugin's declared env_keys (+ PATH), and tear it down strictly BY PID
//     (terminate()->TerminateProcess, never a name match). A Win32 Job Object
//     (kill-on-close) is the planned v2 hardening for child-tree teardown.
//
// This file is compiled INSTEAD of core/src/PluginSandbox.cpp on Windows; the Linux
// original is excluded from the Windows core target and never edited.

#include "jarvis/PluginSandbox.h"

#include <QFileInfo>
#include <QProcessEnvironment>
#include <QStandardPaths>

namespace jarvis {

namespace {

// Split a stdio command line into argv (honors simple single/double quoting).
QStringList splitCommand(const QString &cmd)
{
    QStringList out;
    QString cur;
    QChar quote;
    bool inQuote = false;
    for (QChar c : cmd) {
        if (inQuote) {
            if (c == quote) {
                inQuote = false;
            } else {
                cur += c;
            }
        } else if (c == QLatin1Char('"') || c == QLatin1Char('\'')) {
            inQuote = true;
            quote = c;
        } else if (c.isSpace()) {
            if (!cur.isEmpty()) {
                out << cur;
                cur.clear();
            }
        } else {
            cur += c;
        }
    }
    if (!cur.isEmpty())
        out << cur;
    return out;
}

// From the granted permissions, pull the read-write filesystem paths and any
// network grant (same grammar as Linux: filesystem:<path> / network[:<host>]).
void splitPermissions(const QStringList &perms, QStringList *rwPaths,
                      bool *networkAllowed)
{
    *networkAllowed = false;
    for (const QString &p : perms) {
        if (p == QStringLiteral("network") ||
            p.startsWith(QStringLiteral("network:"))) {
            *networkAllowed = true;
        } else if (p.startsWith(QStringLiteral("filesystem:"))) {
            const QString path = p.mid(QStringLiteral("filesystem:").size());
            if (!path.isEmpty())
                *rwPaths << path;
        }
    }
}

} // namespace

PluginSandbox::PluginSandbox(QObject *parent) : QObject(parent) {}

PluginSandbox::~PluginSandbox()
{
    // Tear down every process we spawned, by PID — never broad kills.
    QStringList ids;
    for (const auto &kv : m_running)
        ids << kv.first;
    for (const QString &id : ids)
        stop(id);
}

bool PluginSandbox::systemdRunAvailable()
{
    // No systemd on Windows — always take the QProcess fallback in plan()/start().
    return false;
}

QString PluginSandbox::unitNameFor(const QString &id)
{
    // Unused on Windows (kept for header-interface parity + the shared tests).
    return QStringLiteral("jarvis-plugin-") + id + QStringLiteral(".service");
}

bool PluginSandbox::waitForUnitActive(const QString &unit, int timeoutMs,
                                      qint64 *mainPid, QString *err)
{
    // The systemd path is never taken on Windows; this stub satisfies the header.
    Q_UNUSED(unit);
    Q_UNUSED(timeoutMs);
    Q_UNUSED(mainPid);
    if (err)
        *err = QStringLiteral("systemd units are not supported on Windows");
    return false;
}

SandboxPlan PluginSandbox::plan(const PluginManifest &m,
                                const QStringList &permissions,
                                const QProcessEnvironment &baseEnv,
                                bool forceSystemdRun, bool forceFallback)
{
    // Kept identical to the Linux original. On Windows systemdRunAvailable() is
    // false, so unless a test forces it the systemd branch is never reached and
    // the resolved plan is always the portable fallback (program + scrubbed env).
    SandboxPlan p;

    QStringList rwPaths;
    bool networkAllowed = false;
    splitPermissions(permissions, &rwPaths, &networkAllowed);
    p.networkAllowed = networkAllowed;
    p.readWritePaths = rwPaths;

    for (const QString &k : m.mcpEnvKeys) {
        if (baseEnv.contains(k))
            p.allowedEnv << (k + QLatin1Char('=') + baseEnv.value(k));
    }

    const QStringList inner = splitCommand(m.effectiveEndpoint());
    if (inner.isEmpty())
        return p; // nothing to launch

    const bool useSystemd =
        forceSystemdRun || (!forceFallback && systemdRunAvailable());
    p.usesSystemdRun = useSystemd;

    if (!useSystemd) {
        p.program = inner.first();
        p.arguments = inner.mid(1);
        return p;
    }

    // (Systemd branch — unreachable on Windows; retained for parity with Linux.)
    p.program = QStringLiteral("systemd-run");
    QStringList a;
    a << QStringLiteral("--user")
      << (QStringLiteral("--unit=") + unitNameFor(m.id))
      << QStringLiteral("--service-type=exec")
      << QStringLiteral("--quiet")
      << QStringLiteral("--collect");
    a << QStringLiteral("-p") << QStringLiteral("ProtectHome=read-only");
    a << QStringLiteral("-p") << QStringLiteral("ProtectSystem=strict");
    a << QStringLiteral("-p") << QStringLiteral("NoNewPrivileges=yes");
    bool rwUnderTmp = false;
    for (const QString &rw : rwPaths) {
        if (rw.startsWith(QStringLiteral("/tmp/")) ||
            rw == QStringLiteral("/tmp") ||
            rw.startsWith(QStringLiteral("/var/tmp/")) ||
            rw == QStringLiteral("/var/tmp")) {
            rwUnderTmp = true;
            break;
        }
    }
    if (!rwUnderTmp)
        a << QStringLiteral("-p") << QStringLiteral("PrivateTmp=yes");
    for (const QString &rw : rwPaths)
        a << QStringLiteral("-p") << (QStringLiteral("ReadWritePaths=") + rw);
    if (!networkAllowed)
        a << QStringLiteral("-p") << QStringLiteral("PrivateNetwork=yes");
    a << QStringLiteral("-p") << QStringLiteral("Environment=");
    for (const QString &kv : p.allowedEnv)
        a << QStringLiteral("--setenv=") + kv.section(QLatin1Char('='), 0, 0)
                 + QLatin1Char('=') + kv.section(QLatin1Char('='), 1);
    a << QStringLiteral("--");
    a << inner;
    p.arguments = a;
    return p;
}

bool PluginSandbox::start(const PluginManifest &m,
                          const QStringList &grantedPermissions)
{
    if (m_running.count(m.id))
        return true; // already running (idempotent)

    // Consent gate (same as Linux): only a DECLARED stdio mcp/both plugin with a
    // launch command is ever spawned. http plugins are URLs handled elsewhere.
    if (m.kind != QStringLiteral("mcp") && m.kind != QStringLiteral("both")) {
        m_lastError = QStringLiteral("not an mcp plugin: ") + m.id;
        return false;
    }
    if (m.effectiveTransport() != QStringLiteral("stdio")) {
        m_lastError = QStringLiteral("only stdio plugins are sandbox-launched (http "
                                     "plugins are URLs): ") + m.id;
        return false;
    }
    if (m.effectiveEndpoint().isEmpty()) {
        m_lastError = QStringLiteral("plugin has no launch command: ") + m.id;
        return false;
    }

    const QProcessEnvironment base = QProcessEnvironment::systemEnvironment();
    const SandboxPlan p = plan(m, grantedPermissions, base,
                               /*forceSystemdRun=*/false, /*forceFallback=*/true);
    if (p.program.isEmpty()) {
        m_lastError = QStringLiteral("could not resolve sandbox plan");
        return false;
    }

    auto proc = std::make_unique<QProcess>();

    // Scrub the child environment to the plugin's DECLARED keys (+ PATH so the
    // program resolves). This is the weaker, fallback isolation the header
    // documents for hosts without systemd — which on Windows is all of them.
    QProcessEnvironment childEnv;
    if (base.contains(QStringLiteral("PATH")))
        childEnv.insert(QStringLiteral("PATH"), base.value(QStringLiteral("PATH")));
    // Windows resolves DLLs/console via a few more vars; keep the safe minimum.
    for (const QString &k : {QStringLiteral("SystemRoot"),
                             QStringLiteral("SYSTEMROOT"),
                             QStringLiteral("TEMP"),
                             QStringLiteral("TMP"),
                             QStringLiteral("USERPROFILE")}) {
        if (base.contains(k))
            childEnv.insert(k, base.value(k));
    }
    for (const QString &k : m.mcpEnvKeys) {
        if (base.contains(k))
            childEnv.insert(k, base.value(k));
    }
    proc->setProcessEnvironment(childEnv);
    proc->setProcessChannelMode(QProcess::SeparateChannels);

    proc->start(p.program, p.arguments);
    if (!proc->waitForStarted(5000)) {
        m_lastError = QStringLiteral("failed to start ") + p.program +
                      QStringLiteral(": ") + proc->errorString();
        return false;
    }

    auto rp = std::make_unique<RunningPlugin>();
    rp->id = m.id;
    rp->usesSystemdRun = false;
    rp->pid = qint64(proc->processId());
    rp->process = std::move(proc);
    m_running.emplace(m.id, std::move(rp));
    return true;
}

bool PluginSandbox::stop(const QString &id)
{
    auto it = m_running.find(id);
    if (it == m_running.end())
        return false;

    RunningPlugin *rp = it->second.get();
    QProcess *proc = rp->process.get();
    if (proc && proc->state() != QProcess::NotRunning) {
        // Terminate the child we spawned BY PID (QProcess tracks the handle):
        // terminate() posts WM_CLOSE/Ctrl event; kill() calls TerminateProcess if
        // it ignores us. Only ever touches OUR process — never a name match.
        proc->terminate();
        if (!proc->waitForFinished(3000)) {
            proc->kill();
            proc->waitForFinished(2000);
        }
    }
    m_running.erase(it);
    return true;
}

bool PluginSandbox::isRunning(const QString &id) const
{
    auto it = m_running.find(id);
    if (it == m_running.end())
        return false;
    const QProcess *proc = it->second->process.get();
    return proc && proc->state() != QProcess::NotRunning;
}

qint64 PluginSandbox::pidOf(const QString &id) const
{
    auto it = m_running.find(id);
    return it == m_running.end() ? 0 : it->second->pid;
}

} // namespace jarvis
