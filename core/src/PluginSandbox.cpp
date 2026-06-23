#include "jarvis/PluginSandbox.h"

#include <QFileInfo>
#include <QProcessEnvironment>
#include <QStandardPaths>

namespace jarvis {

namespace {

// Split a stdio command line into argv. Honors simple single/double quoting so
// `foo "bar baz"` -> ["foo","bar baz"]. Good enough for launcher command lines.
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
// network grant. Permission grammar (BUILD_SPEC):
//   "computer-use" | "filesystem:<path>" | "network:<host>"
// (legacy flat perms like "network"/"fs.write" are tolerated: "network"
// alone => network allowed; nothing maps to a path.)
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
    if (QStandardPaths::findExecutable(QStringLiteral("systemd-run")).isEmpty())
        return false;
    // A user manager must exist for `--user` scopes. XDG_RUNTIME_DIR is the
    // cheap proxy (present in a real user session, absent in minimal CI).
    const QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    return env.contains(QStringLiteral("XDG_RUNTIME_DIR"));
}

SandboxPlan PluginSandbox::plan(const PluginManifest &m,
                                const QStringList &permissions,
                                const QProcessEnvironment &baseEnv,
                                bool forceSystemdRun, bool forceFallback)
{
    SandboxPlan p;

    QStringList rwPaths;
    bool networkAllowed = false;
    splitPermissions(permissions, &rwPaths, &networkAllowed);
    p.networkAllowed = networkAllowed;
    p.readWritePaths = rwPaths;

    // Only the env vars the plugin DECLARED may cross the sandbox boundary.
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
        // Fallback: the plugin's own program, env scrubbed by the caller.
        p.program = inner.first();
        p.arguments = inner.mid(1);
        return p;
    }

    // systemd-run --user --scope with the derived confinement.
    p.program = QStringLiteral("systemd-run");
    QStringList a;
    a << QStringLiteral("--user") << QStringLiteral("--scope")
      << (QStringLiteral("--unit=jarvis-plugin-") + m.id)
      << QStringLiteral("--quiet")
      << QStringLiteral("--collect");
    // Confinement properties (-p Key=Value).
    a << QStringLiteral("-p") << QStringLiteral("ProtectHome=read-only");
    a << QStringLiteral("-p") << QStringLiteral("ProtectSystem=strict");
    a << QStringLiteral("-p") << QStringLiteral("NoNewPrivileges=yes");
    a << QStringLiteral("-p") << QStringLiteral("PrivateTmp=yes");
    for (const QString &rw : rwPaths)
        a << QStringLiteral("-p")
          << (QStringLiteral("ReadWritePaths=") + rw);
    if (!networkAllowed)
        a << QStringLiteral("-p") << QStringLiteral("PrivateNetwork=yes");
    // Scrub the environment to nothing, then re-export only declared keys.
    a << QStringLiteral("-p") << QStringLiteral("Environment=");
    for (const QString &kv : p.allowedEnv)
        a << QStringLiteral("--setenv=") + kv.section(QLatin1Char('='), 0, 0)
                 + QLatin1Char('=') + kv.section(QLatin1Char('='), 1);
    a << QStringLiteral("--"); // end of systemd-run opts; inner argv follows
    a << inner;
    p.arguments = a;
    return p;
}

bool PluginSandbox::start(const PluginManifest &m,
                          const QStringList &grantedPermissions)
{
    if (m_running.count(m.id))
        return true; // already running (idempotent)

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
                               /*forceSystemdRun=*/false, /*forceFallback=*/false);
    if (p.program.isEmpty()) {
        m_lastError = QStringLiteral("could not resolve sandbox plan");
        return false;
    }

    auto proc = std::make_unique<QProcess>();

    // Build the child environment: for the fallback path we scrub here (since
    // there's no systemd unit). For systemd-run the env is set via --setenv, so
    // we still hand systemd-run a minimal env (it needs PATH/DBUS to reach the
    // user manager).
    QProcessEnvironment childEnv;
    if (p.usesSystemdRun) {
        for (const QString &k : {QStringLiteral("PATH"),
                                 QStringLiteral("XDG_RUNTIME_DIR"),
                                 QStringLiteral("DBUS_SESSION_BUS_ADDRESS"),
                                 QStringLiteral("HOME")}) {
            if (base.contains(k))
                childEnv.insert(k, base.value(k));
        }
    } else {
        // Always keep PATH so the inner program resolves; add declared keys.
        if (base.contains(QStringLiteral("PATH")))
            childEnv.insert(QStringLiteral("PATH"), base.value(QStringLiteral("PATH")));
        for (const QString &k : m.mcpEnvKeys) {
            if (base.contains(k))
                childEnv.insert(k, base.value(k));
        }
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
    rp->pid = qint64(proc->processId());
    rp->usesSystemdRun = p.usesSystemdRun;
    rp->scopeName = QStringLiteral("jarvis-plugin-") + m.id + QStringLiteral(".scope");
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
        // Terminate (SIGTERM to the child we spawned by PID), then SIGKILL if it
        // ignores us. This only ever touches OUR process — never a name-match.
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
