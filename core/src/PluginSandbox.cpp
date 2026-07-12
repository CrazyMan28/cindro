#include "jarvis/PluginSandbox.h"

#include <QElapsedTimer>
#include <QFileInfo>
#include <QProcessEnvironment>
#include <QStandardPaths>

#include <csignal>

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
    // A user manager must exist for `--user` units. XDG_RUNTIME_DIR is the
    // cheap proxy (present in a real user session, absent in minimal CI).
    const QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    return env.contains(QStringLiteral("XDG_RUNTIME_DIR"));
}

QString PluginSandbox::unitNameFor(const QString &id)
{
    return QStringLiteral("jarvis-plugin-") + id + QStringLiteral(".service");
}

bool PluginSandbox::waitForUnitActive(const QString &unit, int timeoutMs,
                                      qint64 *mainPid, QString *err)
{
    // Busy-loop polling `systemctl --user show` — NO foreground sleep. We require
    // ActiveState in {active,activating} AND MainPID != 0 so a unit that failed
    // to exec (oneshot crash, missing binary) does not read as a success.
    QElapsedTimer timer;
    timer.start();
    QString lastState;
    QString lastSub;
    qint64 lastPid = 0;
    for (;;) {
        QProcess show;
        show.start(QStringLiteral("systemctl"),
                   {QStringLiteral("--user"), QStringLiteral("show"), unit,
                    QStringLiteral("-p"), QStringLiteral("ActiveState"),
                    QStringLiteral("-p"), QStringLiteral("SubState"),
                    QStringLiteral("-p"), QStringLiteral("MainPID")});
        show.waitForFinished(2000);
        const QString out = QString::fromUtf8(show.readAllStandardOutput());
        QString state, sub;
        qint64 pid = 0;
        for (const QString &line : out.split(QLatin1Char('\n'), Qt::SkipEmptyParts)) {
            const int eq = line.indexOf(QLatin1Char('='));
            if (eq < 0)
                continue;
            const QString k = line.left(eq);
            const QString v = line.mid(eq + 1).trimmed();
            if (k == QStringLiteral("ActiveState"))
                state = v;
            else if (k == QStringLiteral("SubState"))
                sub = v;
            else if (k == QStringLiteral("MainPID"))
                pid = v.toLongLong();
        }
        lastState = state;
        lastSub = sub;
        lastPid = pid;

        const bool up = (state == QStringLiteral("active") ||
                         state == QStringLiteral("activating"));
        if (up && pid != 0) {
            if (mainPid)
                *mainPid = pid;
            return true;
        }
        // A terminal failure: stop early instead of waiting out the timeout.
        if (state == QStringLiteral("failed") || state == QStringLiteral("inactive")) {
            if (err)
                *err = QStringLiteral("unit ") + unit + QStringLiteral(" is ") +
                       state + QStringLiteral("/") + sub;
            return false;
        }
        if (timer.elapsed() >= timeoutMs)
            break;
        // Cheap yield without a foreground sleep: a short event-loop spin.
        QProcess idle;
        idle.start(QStringLiteral("true"), {});
        idle.waitForFinished(50);
    }
    if (err)
        *err = QStringLiteral("unit ") + unit + QStringLiteral(" did not become "
               "active within ") + QString::number(timeoutMs) +
               QStringLiteral("ms (ActiveState=") + lastState +
               QStringLiteral(", SubState=") + lastSub +
               QStringLiteral(", MainPID=") + QString::number(lastPid) +
               QStringLiteral(")");
    return false;
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

    // Launch a TRANSIENT systemd .service (NOT a .scope): exec/sandbox
    // properties like ProtectHome=/ProtectSystem=/PrivateNetwork=/ReadWritePaths=
    // are accepted by service units only — a .scope unit rejects them with
    // "Unknown assignment: ProtectHome=...". --service-type=exec means the unit
    // counts as started once the child is exec()'d.
    p.program = QStringLiteral("systemd-run");
    QStringList a;
    a << QStringLiteral("--user")
      << (QStringLiteral("--unit=") + unitNameFor(m.id))
      << QStringLiteral("--service-type=exec")
      << QStringLiteral("--quiet")
      << QStringLiteral("--collect");
    // Confinement properties (-p Key=Value) — exec/service-only sandboxing.
    a << QStringLiteral("-p") << QStringLiteral("ProtectHome=read-only");
    a << QStringLiteral("-p") << QStringLiteral("ProtectSystem=strict");
    a << QStringLiteral("-p") << QStringLiteral("NoNewPrivileges=yes");
    // PrivateTmp=yes gives the unit a fresh private /tmp + /var/tmp. But that
    // SHADOWS any granted ReadWritePaths that live under /tmp or /var/tmp — the
    // path won't exist in the private namespace and unit start fails with
    // 226/NAMESPACE. So only enable PrivateTmp when no rw path is tmp-rooted.
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
    rp->usesSystemdRun = p.usesSystemdRun;

    if (p.usesSystemdRun) {
        // `systemd-run --service-type=exec` launches the transient unit and then
        // EXITS (the unit runs under the user manager, not as our child). Wait
        // for the wrapper to finish and surface its stderr (e.g. a property the
        // unit rejected), then VERIFY the unit actually came up — the wrapper
        // exiting 0 does NOT prove the sandbox is running (BUG 2).
        proc->waitForFinished(8000);
        const QString runErr =
            QString::fromUtf8(proc->readAllStandardError()).trimmed();
        if (proc->exitStatus() != QProcess::NormalExit ||
            proc->exitCode() != 0) {
            m_lastError = QStringLiteral("systemd-run failed (exit ") +
                          QString::number(proc->exitCode()) + QStringLiteral("): ") +
                          (runErr.isEmpty() ? proc->errorString() : runErr);
            return false;
        }

        const QString unit = unitNameFor(m.id);
        qint64 mainPid = 0;
        QString waitErr;
        if (!waitForUnitActive(unit, /*timeoutMs=*/5000, &mainPid, &waitErr)) {
            m_lastError = waitErr +
                          (runErr.isEmpty() ? QString()
                                            : QStringLiteral(" [systemd-run: ") +
                                                  runErr + QStringLiteral("]"));
            // Best-effort cleanup of a half-up/failed unit so a retry is clean.
            QProcess::execute(QStringLiteral("systemctl"),
                              {QStringLiteral("--user"), QStringLiteral("stop"), unit});
            QProcess::execute(QStringLiteral("systemctl"),
                              {QStringLiteral("--user"),
                               QStringLiteral("reset-failed"), unit});
            return false;
        }
        rp->unitName = unit;
        rp->pid = mainPid; // the sandboxed CHILD, not the systemd-run wrapper
        rp->process = std::move(proc);
    } else {
        // Fallback: the QProcess IS the plugin. Its pid is the thing to track.
        rp->pid = qint64(proc->processId());
        rp->process = std::move(proc);
    }

    m_running.emplace(m.id, std::move(rp));
    return true;
}

bool PluginSandbox::stop(const QString &id)
{
    auto it = m_running.find(id);
    if (it == m_running.end())
        return false;

    RunningPlugin *rp = it->second.get();

    if (rp->usesSystemdRun && !rp->unitName.isEmpty()) {
        // Tear down the TRANSIENT UNIT by its exact name (never the systemd-run
        // wrapper, never pkill-by-name). `stop` kills the unit's processes; if
        // that somehow leaves the child, fall back to SIGKILL of the MainPID we
        // recorded — a scoped, by-PID kill of our own child only.
        QProcess::execute(QStringLiteral("systemctl"),
                          {QStringLiteral("--user"), QStringLiteral("stop"),
                           rp->unitName});
        QProcess::execute(QStringLiteral("systemctl"),
                          {QStringLiteral("--user"),
                           QStringLiteral("reset-failed"), rp->unitName});
        if (rp->pid > 0 && ::kill(static_cast<pid_t>(rp->pid), 0) == 0) {
            ::kill(static_cast<pid_t>(rp->pid), SIGKILL);
        }
    } else {
        QProcess *proc = rp->process.get();
        if (proc && proc->state() != QProcess::NotRunning) {
            // Terminate (SIGTERM to the child we spawned by PID), then SIGKILL if
            // it ignores us. This only ever touches OUR process — never a
            // name-match.
            proc->terminate();
            if (!proc->waitForFinished(3000)) {
                proc->kill();
                proc->waitForFinished(2000);
            }
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
    const RunningPlugin *rp = it->second.get();
    if (rp->usesSystemdRun) {
        // The systemd-run wrapper has already exited; liveness is the recorded
        // MainPID still existing (signal 0 = existence probe, no signal sent).
        return rp->pid > 0 && ::kill(static_cast<pid_t>(rp->pid), 0) == 0;
    }
    const QProcess *proc = rp->process.get();
    return proc && proc->state() != QProcess::NotRunning;
}

qint64 PluginSandbox::pidOf(const QString &id) const
{
    auto it = m_running.find(id);
    return it == m_running.end() ? 0 : it->second->pid;
}

bool PluginSandbox::isSandboxed(const QString &id) const
{
    auto it = m_running.find(id);
    if (it == m_running.end())
        return false;
    return it->second->usesSystemdRun;
}

} // namespace jarvis
