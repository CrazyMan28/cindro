// windows/shell/AgentDesktop.cpp -- Windows v2 "beside-you" agent desktop.
//
// The Linux original (core/src/AgentDesktop.cpp) spins a NESTED headless Sway
// compositor + a bound per-session computer-use engine: the agent works on its
// OWN screen with its OWN input, beside the user, mirrored back to the UI. This
// Windows copy realizes the SAME contract (same jarvis::AgentDesktop class, same
// read-only header) using an ISOLATED Windows desktop instead of nested Sway:
//
//   default tier = WINDOWS SANDBOX (a disposable Hyper-V micro-VM). The engine
//   runs INSIDE the sandbox, so its Win32 SendInput injection + mss capture are
//   scoped to that desktop by the OS boundary -- the Windows analogue of Linux's
//   nested compositor seat (no cursor sharing with the user). See
//   windows/isolation/DESIGN.md.
//
// Two windows/-local pieces make the rest of Cindro's pipeline reuse unchanged:
//   gap #1  the in-sandbox engine answers which="agent" for ITS desktop, via env
//           JARVIS_AGENT_INSANDBOX=1 (windows/engine/backend_windows.py).
//   gap #2  reachability -- the engine binds 0.0.0.0:<port> inside the box; the
//           host needs it at 127.0.0.1:<port> (what engineBase() returns + the
//           brain's MCP config bakes in). A Sandbox is NAT'd / not reachable
//           inbound, so a reverse tunnel (windows/isolation/relay) re-exposes it:
//           the in-sandbox jarvis-relay dials OUT to the host rendezvous port.
//
// Everything DOWNSTREAM is identical to Linux: DeviceServer's /video/mjpeg pump
// reads engineBase()+bearer; the brain gets the same per-session MCP url+bearer.
//
// Mode dispatch (windows.isolation.mode / env JARVIS_WINDOWS_ISOLATION_MODE):
//   sandbox  (default)  -> this file orchestrates it (Phase 1).
//   childsession/hyperv -> Phase 2/3: return up=false with a typed reason.
//   takeover/unsupported-> return up=false with a typed reason; the daemon falls
//                          back to the already-shipping v1 real-screen take-over.
//
// The portable, daemon-facing accessors (info/engineBase/bearer/teardown/...),
// defaultEngineDir(), genBearer(), nextPort(), killProc() and the (port,bearer)
// reservation are kept VERBATIM from the Linux twin. The Qt health/ready waiters
// are copied verbatim too (only the process-liveness probe targets the sandbox
// process d.sway instead of the Linux engine d.engine).
//
// This file is compiled INSTEAD of core/src/AgentDesktop.cpp on Windows; the
// Linux original is excluded from the Windows core target and never edited.

#include "jarvis/AgentDesktop.h"

#include "ReverseTunnel.h" // windows/isolation/relay (added to the include path)

// <windows.h> (with NOMINMAX/WIN32_LEAN_AND_MEAN) is force-included via
// windows/shell/posix_compat.h for every Windows target; include both
// explicitly too so this file is self-describing and also compiles if the
// /FI is ever dropped. tlhelp32.h (process snapshotting) is not pulled in by
// windows.h alone.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>
#include <tlhelp32.h>

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRandomGenerator>
#include <QSet>
#include <QStringList>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>

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

// ---------------------------------------------------------------------------
// Windows isolation helpers (anonymous namespace).
// ---------------------------------------------------------------------------
namespace {

// sandbox | childsession | hyperv | takeover.
//
// v2 SHIP GATE, LIFTED for `sandbox` (jarvis#104, 2026-07-13): the isolated
// agent-desktop tiers used to NEVER auto-activate -- the daemon always fell back to
// v1 real-screen take-over unless an operator explicitly opted in with
// JARVIS_ENABLE_V2=1 -- because the CI runner can't boot nested Hyper-V, so this whole
// code path only ever COMPILED, never RAN, before that date. It has since been
// validated end-to-end on real Windows 11 Pro hardware (confirmed independently
// multiple times: session.create -> agent_desktop.up=true, with the in-sandbox engine
// itself corroborating a real screen capture) -- see docs/STATUS.md's 2026-07-13
// entry for the four real bugs that surfaced and were fixed doing so. `sandbox` now
// activates automatically whenever detect.ps1 recommends it (Pro/Ent/Edu +
// virtualization + the Containers-DisposableClientVM feature); detect.ps1's own
// capability check is what keeps this safe on a Home/no-virt/no-feature box, which
// still correctly falls through to takeover below -- JARVIS_ENABLE_V2 is no longer
// required for that. `childsession`/`hyperv` (Phases 2/3) are UNIMPLEMENTED stubs
// regardless of this gate -- ensure() returns up=false with a typed reason for them
// either way, so lifting the gate for them too is a no-op until they're actually
// built. Kept as an explicit opt-OUT for anyone who wants v1-only behavior back
// without recompiling: JARVIS_ENABLE_V2=0 (or false/no/off) forces takeover.
QString resolveMode()
{
    const QString m = qEnvironmentVariable("JARVIS_WINDOWS_ISOLATION_MODE")
                          .trimmed()
                          .toLower();
    if (m == QStringLiteral("takeover"))
        return m;

    const QString v2 =
        qEnvironmentVariable("JARVIS_ENABLE_V2").trimmed().toLower();
    const bool v2optOut = (v2 == QStringLiteral("0") || v2 == QStringLiteral("false") ||
                           v2 == QStringLiteral("no") || v2 == QStringLiteral("off"));
    if (!v2optOut &&
        (m == QStringLiteral("childsession") || m == QStringLiteral("hyperv") ||
         m == QStringLiteral("sandbox")))
        return m;

    return QStringLiteral("takeover");
}

// Reverse-tunnel reachability backend: tunnel (default, in-process QTcpServer) or
// portproxy (netsh MVP; needs a known sandbox IP via JARVIS_SANDBOX_IP).
QString resolveRelayKind()
{
    const QString r =
        qEnvironmentVariable("JARVIS_WINDOWS_RELAY").trimmed().toLower();
    return r == QStringLiteral("portproxy") ? r : QStringLiteral("tunnel");
}

QString sandboxExePath()
{
    const QString override = qEnvironmentVariable("JARVIS_WINDOWS_SANDBOX_EXE");
    if (!override.isEmpty())
        return override;
    QString sysRoot = qEnvironmentVariable("SystemRoot");
    if (sysRoot.isEmpty())
        sysRoot = QStringLiteral("C:/Windows");
    return QDir(sysRoot).absoluteFilePath(
        QStringLiteral("System32/WindowsSandbox.exe"));
}

// The directory that holds jarvis-engine.exe + jarvis-relay.exe + bootstrap.ps1
// (MappedFolder'd read-only to C:\engine inside the sandbox). Packaged layout is
// <exeDir>/engine; overridable with JARVIS_ENGINE_DIR; falls back to the dev
// engineDir passed in.
QString enginePayloadDir(const QString &fallback)
{
    const QString fromEnv = qEnvironmentVariable("JARVIS_ENGINE_DIR");
    if (!fromEnv.isEmpty() && QFileInfo::exists(fromEnv))
        return QDir(fromEnv).absolutePath();
    const QString beside = QDir(QCoreApplication::applicationDirPath())
                               .absoluteFilePath(QStringLiteral("engine"));
    if (QFileInfo::exists(QDir(beside).absoluteFilePath(
            QStringLiteral("jarvis-engine.exe"))))
        return QDir(beside).absolutePath();
    return fallback;
}

// The directory holding jarvis-agent.wsb.in + bootstrap.ps1 + detect.ps1. Packaged
// layout is <exeDir>/isolation; overridable with JARVIS_WINDOWS_ISOLATION_DIR;
// dev fallback is the source tree windows/isolation next to the build.
QString isolationDir()
{
    const QString fromEnv = qEnvironmentVariable("JARVIS_WINDOWS_ISOLATION_DIR");
    if (!fromEnv.isEmpty() && QFileInfo::exists(fromEnv))
        return QDir(fromEnv).absolutePath();
    const QString beside = QDir(QCoreApplication::applicationDirPath())
                               .absoluteFilePath(QStringLiteral("isolation"));
    if (QFileInfo::exists(QDir(beside).absoluteFilePath(
            QStringLiteral("sandbox/jarvis-agent.wsb.in"))))
        return QDir(beside).absolutePath();
    // Dev tree: windows/isolation relative to this source file's build.
    const QString dev = QDir(QCoreApplication::applicationDirPath())
                            .absoluteFilePath(QStringLiteral("../windows/isolation"));
    return QDir(dev).absolutePath();
}

// XML-escapes a string for safe insertion into the rendered .wsb's element text
// content. @BEARER@/@SESSION@/@ENGINEDIR@/@HOSTIP@ are opaque host-generated (or
// operator env-var) strings, not attacker-controlled in the threat model, but
// escaping them is cheap insurance against a stray '&'/'<' (e.g. a Windows path,
// or an operator-set JARVIS_HOST_IP) corrupting the XML -- see the REPORT 3 fix in
// ensure() for why a malformed rendered .wsb reproduces the exact "boots, no
// LogonCommand, no error" symptom this issue is about.
QString xmlEscape(const QString &s)
{
    // toHtmlEscaped() covers &/</>/" in one correct pass (no double-escape
    // ordering hazard); only the apostrophe needs adding on top.
    return s.toHtmlEscaped().replace(QLatin1Char('\''), QStringLiteral("&apos;"));
}

// Optional diagnostics MappedFolder, injected into the rendered .wsb ONLY when
// JARVIS_SANDBOX_DIAG_DIR is set. REPORT 6: earlier tonight this was a MappedFolder
// hand-patched directly into the payload's jarvis-agent.wsb.in with a hardcoded
// personal host path (C:\Users\<user>\jarvis-sbx-diag) that diverged from source and
// would have been silently wiped by the next build.ps1 run. Making it an explicit,
// env-gated opt-in means: (a) a personal path never ships in the template, (b) the
// mechanism survives rebuilds, (c) it's still one env var away for the next live
// debugging session. Host dir is created on demand; mapped READ-WRITE to C:\hostlog
// inside the box, which bootstrap.ps1 already self-detects (Test-Path "C:\hostlog")
// and uses in place of %USERPROFILE% for its trace log + IMMEDIATE-MARKER.txt +
// EXCEPTION.txt + engine/relay stdout -- see windows/isolation/sandbox/bootstrap.ps1.
QString diagMappedFolderXml()
{
    const QString diagDir = qEnvironmentVariable("JARVIS_SANDBOX_DIAG_DIR");
    if (diagDir.isEmpty())
        return QString();
    QDir().mkpath(diagDir);
    return QStringLiteral("    <MappedFolder>\n"
                           "      <HostFolder>%1</HostFolder>\n"
                           "      <SandboxFolder>C:\\hostlog</SandboxFolder>\n"
                           "      <ReadOnly>false</ReadOnly>\n"
                           "    </MappedFolder>\n")
        .arg(xmlEscape(QDir::toNativeSeparators(diagDir)));
}

// Per-user writable root for rendered .wsb files + per-session temp dirs.
QString agentTempRoot()
{
    QString base = qEnvironmentVariable("LOCALAPPDATA");
    if (base.isEmpty())
        base = QDir::tempPath();
    return QDir(base).absoluteFilePath(QStringLiteral("Jarvis/agent"));
}

// Rendezvous port for a session's reverse tunnel: engine port + 1000 (unique
// because the engine port is unique per session).
quint16 rendezvousPortFor(int enginePort) { return quint16(enginePort + 1000); }

// The marker the sandbox temp dir carries so sweepOrphans can recognize our own
// leftovers (never the user's files).
QString sessionTempDir(const QString &sessionId)
{
    return QDir(agentTempRoot())
        .absoluteFilePath(QStringLiteral("sess-") + sessionId);
}

// --- host firewall for the reverse-tunnel rendezvous port (SANDBOX-BLOCKING) --
// ReverseTunnel binds 0.0.0.0:<rport>; the in-sandbox dialer connects
// host_gateway:<rport>, an INBOUND TCP connection to the headless jarvisd.exe.
// Windows Defender Firewall default-blocks inbound to a background service with NO
// interactive prompt, so without an explicit allow rule the tunnel never pairs ->
// /health never returns 200 -> ensure() always fails on a default-firewall box.
// We add a per-port allow rule while the tunnel is up and delete it in teardown().
QString relayFirewallRuleName(quint16 rport)
{
    return QStringLiteral("Cindro-Agent-Relay-%1").arg(rport);
}

// Best-effort. Requires an elevated token to actually take effect; if jarvisd is
// not elevated netsh is a silent no-op and pairing then relies on the firewall
// already permitting the port (operator rule / disabled profile). Never fails
// ensure(): if the rule can't be added and the port is genuinely blocked, the
// health wait times out with its own typed reason. A stale same-named rule is
// deleted first so restarts don't stack duplicates.
void addRelayFirewallRule(quint16 rport)
{
    const QString name = relayFirewallRuleName(rport);
    QProcess::execute(QStringLiteral("netsh"),
                      {QStringLiteral("advfirewall"), QStringLiteral("firewall"),
                       QStringLiteral("delete"), QStringLiteral("rule"),
                       QStringLiteral("name=") + name});
    QProcess::execute(
        QStringLiteral("netsh"),
        {QStringLiteral("advfirewall"), QStringLiteral("firewall"),
         QStringLiteral("add"), QStringLiteral("rule"), QStringLiteral("name=") + name,
         QStringLiteral("dir=in"), QStringLiteral("action=allow"),
         QStringLiteral("protocol=TCP"),
         QStringLiteral("localport=%1").arg(rport), QStringLiteral("profile=any")});
}

void removeRelayFirewallRule(quint16 rport)
{
    QProcess::startDetached(
        QStringLiteral("netsh"),
        {QStringLiteral("advfirewall"), QStringLiteral("firewall"),
         QStringLiteral("delete"), QStringLiteral("rule"),
         QStringLiteral("name=") + relayFirewallRuleName(rport)});
}

// removeRelayFirewallRule() above is fire-and-forget (startDetached, called from
// teardown()) so it never runs at all if jarvisd exits abnormally (crash/kill)
// with a session still up -- the "any profile" inbound allow rule is then
// permanent until something notices. sweepOrphans() already runs once at daemon
// startup before any in-process session exists, so it's the natural place to
// catch these: enumerate every rule and delete the ones matching our
// "Cindro-Agent-Relay-*" naming scheme. netsh has no wildcard "show rule name=",
// so we list everything and grep for our prefix, then delete each by its exact
// name (synchronous -- this runs once at startup, not on a hot path). Best-effort
// like the add/remove helpers above: requires an elevated token to actually take
// effect. Returns the number of rules removed.
int sweepOrphanFirewallRules()
{
    QProcess show;
    show.start(QStringLiteral("netsh"),
               {QStringLiteral("advfirewall"), QStringLiteral("firewall"),
                QStringLiteral("show"), QStringLiteral("rule"), QStringLiteral("name=all")});
    if (!show.waitForFinished(5000))
        return 0;
    const QString out = QString::fromLocal8Bit(show.readAllStandardOutput());
    static const QString kRuleNamePrefix = QStringLiteral("Rule Name:");
    static const QString kOurPrefix = QStringLiteral("Cindro-Agent-Relay-");
    int reaped = 0;
    for (const QString &line : out.split(QLatin1Char('\n'))) {
        const QString trimmed = line.trimmed();
        if (!trimmed.startsWith(kRuleNamePrefix))
            continue;
        const QString name = trimmed.mid(kRuleNamePrefix.length()).trimmed();
        if (!name.startsWith(kOurPrefix))
            continue;
        QProcess::execute(QStringLiteral("netsh"),
                          {QStringLiteral("advfirewall"), QStringLiteral("firewall"),
                           QStringLiteral("delete"), QStringLiteral("rule"),
                           QStringLiteral("name=") + name});
        ++reaped;
    }
    return reaped;
}

// --- event-loop-pumping process capture -------------------------------------
// Run `program args` to completion and return its stdout, PUMPING this thread's
// event loop while it runs instead of blocking on QProcess::waitForStarted/
// waitForFinished. Same hazard httpGetOk()'s header documents at length: ensure()
// runs on jarvisd's single Qt thread, which also owns the in-process ReverseTunnel
// this whole flow is waiting to pair; a blocking waitFor*() starves that event loop
// for its full timeout, so a slow `tasklist` here can stall (or, at the health->
// ready hinge, self-deadlock) the very pairing we're waiting on. Driving a
// QEventLoop keeps ReverseTunnel's socket signals dispatching throughout. Returns
// an empty QByteArray on spawn failure or timeout (callers treat empty as
// "unknown," never as a definitive answer). Bounded so it can never block a session
// longer than timeoutMs; a timed-out child is reaped so it can't linger.
QByteArray captureProcessOutputPumping(const QString &program,
                                       const QStringList &args, int timeoutMs)
{
    QProcess proc;
    proc.setProcessChannelMode(QProcess::SeparateChannels);
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    bool exited = false;
    QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
    QObject::connect(&proc, &QProcess::finished, &loop,
                     [&](int, QProcess::ExitStatus) { exited = true; loop.quit(); });
    QObject::connect(&proc, &QProcess::errorOccurred, &loop, &QEventLoop::quit);
    proc.start(program, args);
    timer.start(qMax(1, timeoutMs));
    // start() is async: on success the process is Starting/Running and finished/
    // errorOccurred arrive via the loop below; on an immediate spawn failure it's
    // already NotRunning (errorOccurred queued), so skip exec() to avoid hanging
    // until the timer on a signal that already fired.
    if (proc.state() != QProcess::NotRunning)
        loop.exec();
    if (!exited) {
        // Spawn failure or timeout -- reap any survivor and report "unknown".
        if (proc.state() != QProcess::NotRunning) {
            proc.kill();
            proc.waitForFinished(1000);
        }
        return {};
    }
    return proc.readAllStandardOutput();
}

// --- single-instance guard --------------------------------------------------
// Windows Sandbox allows only ONE running instance per host. Detect an existing
// one (ours-after-a-crash or the USER's own) so ensure() can refuse a 2nd launch
// with a typed reason instead of spawning a WindowsSandbox.exe that fails opaquely.
// Best-effort: returns false when the probe can't run (we then fall through to the
// normal launch, which still fails safely if a sandbox truly exists). Matches each
// tasklist row's image name EXACTLY against the real session processes
// (WindowsSandbox.exe / WindowsSandboxClient.exe / WindowsSandboxServer.exe /
// WindowsSandboxRemoteSession.exe) -- NOT a blanket "contains WindowsSandbox"
// substring, which also matches vmmemWindowsSandbox.exe (it DOES contain that
// substring). vmmemWindowsSandbox is the Hyper-V VM worker that can linger
// 5-15 minutes after a real teardown (see closeSandboxHostProcesses()'s
// header) even once the session itself is fully gone; reproduced directly
// during testing -- a launch immediately following a clean teardown was
// refused as sandbox_busy solely because vmmemWindowsSandbox hadn't released
// yet, with WindowsSandboxClient/Server/RemoteSession already gone.
//
// The tasklist probe is event-loop-pumping (captureProcessOutputPumping), not a
// blocking waitFor*(): this runs on every ensure() and must not starve the
// ReverseTunnel's event loop -- see that helper's header.
bool sandboxAlreadyRunning()
{
    if (qEnvironmentVariableIsSet("JARVIS_SANDBOX_SKIP_RUNNING_CHECK"))
        return false;
    const QByteArray outBytes = captureProcessOutputPumping(
        QStringLiteral("tasklist"),
        {QStringLiteral("/nh"), QStringLiteral("/fo"), QStringLiteral("csv")}, 8000);
    if (outBytes.isEmpty())
        return false; // probe failed/timed out -> "unknown"; fall through to launch
    const QString out = QString::fromLocal8Bit(outBytes);
    for (const QString &line : out.split(QStringLiteral("\r\n"), Qt::SkipEmptyParts)) {
        const QString name =
            line.section(QLatin1Char(','), 0, 0).remove(QLatin1Char('"')).trimmed();
        if (name.compare(QStringLiteral("WindowsSandbox.exe"), Qt::CaseInsensitive) == 0 ||
            name.compare(QStringLiteral("WindowsSandboxClient.exe"), Qt::CaseInsensitive) == 0 ||
            name.compare(QStringLiteral("WindowsSandboxServer.exe"), Qt::CaseInsensitive) == 0 ||
            name.compare(QStringLiteral("WindowsSandboxRemoteSession.exe"),
                         Qt::CaseInsensitive) == 0)
            return true;
    }
    return false;
}

// --- in-process provisioning lock -------------------------------------------
// Closes a real concurrency gap in the single-instance guard below: m_desks
// isn't populated for a session until ITS sandbox is fully up (after both HTTP
// waiters succeed, tens of seconds to minutes later), so two ensure() calls
// arriving close together can both pass the m_desks/sandboxAlreadyRunning()
// guard while the first is still mid-boot. This is reachable, not theoretical:
// httpGetOk()'s event-loop-pumping (needed so ReverseTunnel can pair) lets a
// second incoming session.create RPC be dispatched on the SAME thread while the
// first ensure() call is still on the stack, inside the window between
// d.sway->start() and the service-hosted sandbox processes actually appearing
// in tasklist. Without this lock, a second call that slips through would race a
// doomed second WindowsSandbox.exe launch, and its OWN failure-path cleanup
// (closeSandboxHostProcesses(), host-wide by image name -- see above) could
// kill the first session's genuinely live, healthy sandbox. RAII'd via
// ProvisioningLock so every ensure() return path (there are several) releases
// it automatically.
//
// TWO nested scopes, because there are two distinct races:
//   * g_provisioningSessions (ProvisioningLock, whole ensure()) blocks a SECOND
//     ensure() from launching while the first is mid-boot -- the concurrency gap
//     described above.
//   * g_provisioningWaitSessions (ProvisioningWaitScope, tight wrap around each
//     event-loop-PUMPING step) marks the ONLY windows in which another queued RPC
//     can be dispatched re-entrantly on this thread -- the health/ready waiters and
//     the pumping tasklist probes. A session.cancel/session.delete for the SAME id
//     dispatched there would otherwise stop the ReverseTunnel + drop the firewall
//     rule + kill the sandbox host processes out from under the still-polling
//     waiter: the box stays healthy but becomes UNREACHABLE, so /health|/ready spin
//     their whole budget with no way to win (jarvis#113). teardown()/releaseSession()
//     therefore DEFER when this set contains the id (recording the request in
//     g_deferredTeardowns / g_deferredReleases), and ensure() honors the deferred
//     request the instant it finishes provisioning. ensure()'s OWN straight-line
//     failure-path cleanup always runs OUTSIDE any wait scope, so it is never
//     deferred -- only genuinely re-entrant calls are.
QSet<QString> g_provisioningSessions;     // an ensure() is in flight for these ids
QSet<QString> g_provisioningWaitSessions; // ...and is parked in a pumping step now
QSet<QString> g_deferredTeardowns;        // teardown deferred until ensure() ends
QSet<QString> g_deferredReleases;         // deferred teardowns that also free the reservation

struct ProvisioningLock
{
    QString sid;
    explicit ProvisioningLock(QString s) : sid(std::move(s))
    {
        g_provisioningSessions.insert(sid);
    }
    ~ProvisioningLock()
    {
        g_provisioningSessions.remove(sid);
        g_provisioningWaitSessions.remove(sid);
        g_deferredTeardowns.remove(sid);
        g_deferredReleases.remove(sid);
    }
};

// Tight RAII marker around a single event-loop-pumping step of ensure() (a health/
// ready waiter, or a pumping tasklist probe). Present ONLY while that step is on the
// stack, so a re-entrant teardown() dispatched during the pump is deferred, while
// ensure()'s subsequent straight-line handling (which runs after the scope closes)
// is not.
struct ProvisioningWaitScope
{
    QString sid;
    explicit ProvisioningWaitScope(QString s) : sid(std::move(s))
    {
        g_provisioningWaitSessions.insert(sid);
    }
    ~ProvisioningWaitScope() { g_provisioningWaitSessions.remove(sid); }
};

// sessionId -> the REAL session-host PIDs captured right after THIS session's
// sandbox was confirmed healthy (see closeSandboxHostProcesses()'s header).
// Windows-only bookkeeping kept OUT of the shared Desk struct
// (core/include/jarvis/AgentDesktop.h, also used by the Linux implementation)
// since Linux never needs it.
QHash<QString, QList<qint64>> g_sandboxHostPids;

// Snapshot the PIDs of the REAL Windows Sandbox session-host processes right
// now (WindowsSandboxRemoteSession/Server/Client -- NOT WindowsSandbox.exe,
// which has already exited by the time this is ever called, and NOT
// vmmemWindowsSandbox, the VM worker that's never targeted -- see
// closeSandboxHostProcesses()'s header). Returns an empty list if the probe
// fails or nothing matches; callers must treat empty as "unknown," not "safe
// to broad-kill by name."
QList<qint64> captureSandboxHostPids()
{
    QList<qint64> pids;
    // Event-loop-pumping tasklist (NOT a blocking waitFor*): this runs right at the
    // health->ready hinge, while the ReverseTunnel is actively serving on this same
    // thread -- a blocking probe here would starve exactly that. See
    // captureProcessOutputPumping()'s header.
    const QByteArray outBytes = captureProcessOutputPumping(
        QStringLiteral("tasklist"),
        {QStringLiteral("/nh"), QStringLiteral("/fo"), QStringLiteral("csv")}, 8000);
    if (outBytes.isEmpty())
        return pids;
    const QString out = QString::fromLocal8Bit(outBytes);
    for (const QString &line : out.split(QStringLiteral("\r\n"), Qt::SkipEmptyParts)) {
        const QStringList fields = line.split(QLatin1Char(','));
        if (fields.size() < 2)
            continue;
        const QString name = QString(fields[0]).remove(QLatin1Char('"')).trimmed();
        if (name.compare(QStringLiteral("WindowsSandboxRemoteSession.exe"), Qt::CaseInsensitive) == 0 ||
            name.compare(QStringLiteral("WindowsSandboxServer.exe"), Qt::CaseInsensitive) == 0 ||
            name.compare(QStringLiteral("WindowsSandboxClient.exe"), Qt::CaseInsensitive) == 0) {
            bool ok = false;
            const qint64 pid = QString(fields[1]).remove(QLatin1Char('"')).trimmed().toLongLong(&ok);
            if (ok)
                pids.append(pid);
        }
    }
    return pids;
}

// --- closing the REAL sandbox (teardown) ------------------------------------
// REAL-HARDWARE CORRECTION. The Linux-mirror design assumed WindowsSandbox.exe
// (our d.sway launcher) is the long-lived sandbox host, so teardown could just
// killProc(d.sway) to destroy the box. On a real Win11 Pro box that is FALSE:
// WindowsSandbox.exe fork-and-exits within ~1s and the live box is hosted by a set
// of service processes -- WindowsSandboxRemoteSession.exe (the session host, whose
// exit tears the box down), WindowsSandboxServer.exe, WindowsSandboxClient.exe --
// plus the Hyper-V VM worker vmmemWindowsSandbox. So killProc(d.sway) is a no-op
// that ORPHANS the running box (a stale one then trips sandboxAlreadyRunning() and
// blocks the next launch as sandbox_busy).
//
// SCOPED BY PID (jarvis#104 Codex review follow-up), not a blind image-name kill:
// an earlier version killed by IMAGE NAME only, reasoning "the single-instance
// guard guarantees any running box is the one WE launched." That guarantee holds
// only at the MOMENT ensure() checks it -- if this session's box later dies
// outside our control (crash, user closes the sandbox window) while m_desks
// still thinks it's up, and the user THEN manually opens their OWN separate
// Windows Sandbox for unrelated work, a later teardown/cleanup call for the
// long-dead session would have killed that unrelated, currently-live sandbox by
// name and lost the user's work in it. Now scoped to the specific PIDs
// captureSandboxHostPids() recorded for THIS session right after its own health
// check passed (see the ensure() call site) -- a stale/reused PID just fails
// silently ("not found"), never touching a process we weren't told about.
// Falls back to the old broad-by-name kill ONLY when no PIDs were ever captured
// (the session never reached a confirmed-healthy state, so nothing to scope to
// yet -- the residual risk there matches pre-fix behavior, but only in that
// narrow early window). /T also reaps child trees. vmmemWindowsSandbox is
// deliberately NOT targeted either way: it's the vmcompute-managed VM worker
// (resists even an elevated taskkill /F on this hardware) and releases on its
// own once the session host is gone. Requires an elevated token to fully take
// effect -- best-effort, and bounded so teardown never blocks a session
// tear-down on a slow kill.
void closeSandboxHostProcesses(const QList<qint64> &scopedPids = {})
{
    QStringList args;
    if (!scopedPids.isEmpty()) {
        args << QStringLiteral("/F") << QStringLiteral("/T");
        for (qint64 pid : scopedPids)
            args << QStringLiteral("/PID") << QString::number(pid);
    } else {
        args << QStringLiteral("/F") << QStringLiteral("/T")
             << QStringLiteral("/IM") << QStringLiteral("WindowsSandboxRemoteSession.exe")
             << QStringLiteral("/IM") << QStringLiteral("WindowsSandboxServer.exe")
             << QStringLiteral("/IM") << QStringLiteral("WindowsSandboxClient.exe")
             << QStringLiteral("/IM") << QStringLiteral("WindowsSandbox.exe");
    }
    QProcess p;
    p.start(QStringLiteral("taskkill"), args);
    if (!p.waitForStarted(2000))
        return;
    if (!p.waitForFinished(4000)) {
        p.kill();
        p.waitForFinished(1000);
    }
}

// --- sandbox cold-boot startup budget ---------------------------------------
// A cold Windows Sandbox boots a FULL Windows image (often 60-90s) BEFORE
// bootstrap.ps1 even starts the engine, so the Linux `uv run` budget (Options
// startupTimeoutMs, default 45s) is far too tight for a first launch. Use a
// mode-specific budget: max(configured, 120s), overridable via
// JARVIS_SANDBOX_STARTUP_MS. Applied to the tunnel pairing wait + both HTTP waiters.
int sandboxStartupBudgetMs(int configuredMs)
{
    int budget = qMax(configuredMs, 120000);
    const QString ov = qEnvironmentVariable("JARVIS_SANDBOX_STARTUP_MS").trimmed();
    if (!ov.isEmpty()) {
        bool ok = false;
        const int v = ov.toInt(&ok);
        if (ok && v > 0)
            budget = v;
    }
    return budget;
}

} // namespace

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

bool AgentDesktop::nestedDesktopSupported()
{
    // Only the v2 sandbox tier (JARVIS_ENABLE_V2 opt-in, resolveMode()=="sandbox")
    // can provision an isolated agent desktop on Windows. Everything else is the
    // shipped v1 real-screen take-over: ensure() always degrades, and the daemon
    // uses this predicate to fall back to the GLOBAL :8794 engine so sessions
    // still get computer-use MCP tools instead of none at all.
    return resolveMode() == QStringLiteral("sandbox");
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

// ---------------------------------------------------------------------------
// Engine readiness waiters -- adapted from core/src/AgentDesktop.cpp.
// The Linux twin's waiters short-circuit when the process they own (d.engine)
// exits, treating that as "the desktop died, fail fast". The obvious Windows
// mirror was to probe d.sway (the WindowsSandbox.exe launcher) the same way -- but
// that probe is a FALSE liveness signal on real Win11 hardware and has been REMOVED.
// WindowsSandbox.exe is only a thin launcher: it fork-and-exits within ~1s of start
// (handing the live box off to service-hosted WindowsSandbox* processes + the
// vmmemWindowsSandbox VM worker -- see closeSandboxHostProcesses()), so
// d.sway->state() reads NotRunning almost immediately, long before the box has even
// finished booting, let alone started the engine. Keeping the probe made both
// waiters bail on the very first poll on every real launch (confirmed on a Win11 Pro
// box: ~9 attempts all failed the same way regardless of payload). With no reliable
// host-side liveness handle for the box, we rely PURELY on the HTTP poll + the
// (generous, cold-boot-sized) timeout budget: if the box never comes up, /health
// simply never returns 200 and the wait times out with its typed reason -- slower to
// fail than the Linux twin, but correct. The HTTP probes hit 127.0.0.1:<port>, which
// the reverse tunnel forwards into the box, so the contract is unchanged.
// ---------------------------------------------------------------------------
// Event-loop-DRIVEN, minimal HTTP/1.1 GET over a QTcpSocket -- deliberately NOT
// QNetworkAccessManager, and (as of issue 104's live-hardware debugging) NOT
// QTcpSocket's blocking waitFor* family either. History:
//   1. The original implementation created a fresh QNetworkReply + QEventLoop +
//      QTimer PER ITERATION, driven via nested QEventLoop::exec() calls. On real
//      Windows Sandbox hardware that crashed jarvisd.exe with a deterministic
//      access violation at a fixed offset inside Qt6Core.dll (confirmed via
//      Windows Error Reporting: identical fault address across multiple
//      independent runs) -- reproducible only under sustained real polling, since
//      CI never exercises this loop (it can't boot nested Hyper-V).
//   2. That was "fixed" by swapping in QTcpSocket's blocking waitForConnected /
//      waitForBytesWritten / waitForReadyRead (Qt's documented pattern for
//      synchronous I/O without an event loop) plus QThread::msleep() between
//      polls. This built cleanly and no longer crashed, but introduced a WORSE,
//      more subtle bug: waitFor*() blocks the calling thread on a raw
//      select()/poll() scoped to just that one socket and does NOT pump Qt's
//      event loop -- so it starves every OTHER QObject on this thread for the
//      full timeoutMs of each call. ensure() runs synchronously on jarvisd's
//      single Qt thread (no worker thread / QtConcurrent), and that SAME thread
//      also owns the in-process ReverseTunnel this waiter exists to wait for
//      (see gap #2 in ensure()). Confirmed on real hardware via the ReverseTunnel/
//      TunnelDialer qDebug trail: the sandbox-side relay's TCP connects to the
//      rendezvous port succeed at the kernel level (accepted into the OS backlog,
//      relay logs "tunnel connected") but ReverseTunnel::onRendezvousConnection()
//      NEVER fires and the pairing never happens -- a genuine self-deadlock where
//      waiting for the tunnel to pair is exactly what prevents it from ever
//      pairing. (The connections then die with "remote host closed" once
//      teardown() finally runs after the health wait times out and tears the
//      tunnel's sockets down.)
// The fix: go back to an event-loop-driven wait (so ReverseTunnel's signals get
// a chance to dispatch between -- and while waiting on -- each step) but keep it
// built on QTcpSocket, never QNetworkAccessManager/QNetworkReply, so the original
// crash's suspected trigger (their abort()+deleteLater() lifecycle) stays out of
// the loop entirely.
bool httpGetOk(const QString &host, quint16 port, const QString &path,
               const QString &bearer, int timeoutMs)
{
    QTcpSocket sock;
    QElapsedTimer clock;
    clock.start();

    {
        QEventLoop loop;
        QTimer timer;
        timer.setSingleShot(true);
        QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
        QObject::connect(&sock, &QAbstractSocket::connected, &loop, &QEventLoop::quit);
        QObject::connect(&sock, &QAbstractSocket::errorOccurred, &loop, &QEventLoop::quit);
        sock.connectToHost(host, port);
        timer.start(timeoutMs);
        loop.exec();
    }
    if (sock.state() != QAbstractSocket::ConnectedState)
        return false;

    QString req = QStringLiteral("GET %1 HTTP/1.1\r\nHost: %2:%3\r\nConnection: close\r\n")
                      .arg(path, host, QString::number(port));
    if (!bearer.isEmpty())
        req += QStringLiteral("Authorization: Bearer %1\r\n").arg(bearer);
    req += QStringLiteral("\r\n");
    sock.write(req.toUtf8());

    QByteArray resp;
    while (clock.elapsed() < timeoutMs) {
        const int remaining = timeoutMs - int(clock.elapsed());
        if (resp.contains("\r\n\r\n") || remaining <= 0)
            break;
        QEventLoop loop;
        QTimer timer;
        timer.setSingleShot(true);
        QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
        QObject::connect(&sock, &QTcpSocket::readyRead, &loop, &QEventLoop::quit);
        QObject::connect(&sock, &QAbstractSocket::disconnected, &loop, &QEventLoop::quit);
        timer.start(qMax(50, remaining));
        loop.exec();
        if (sock.bytesAvailable() > 0)
            resp += sock.readAll();
        else if (sock.state() != QAbstractSocket::ConnectedState)
            break;
    }
    sock.disconnectFromHost();
    if (!resp.startsWith("HTTP/1."))
        return false;
    const int sp = resp.indexOf(' ');
    if (sp < 0)
        return false;
    return resp.mid(sp + 1, 3).toInt() == 200;
}

// Event-loop-driven inter-poll delay -- see httpGetOk()'s header. A plain
// QThread::msleep() here would (and did) starve the same thread's ReverseTunnel
// just as much as a blocking socket wait; QTimer::singleShot + QEventLoop::exec()
// pumps Qt's event loop for the delay instead of freezing it.
void pumpingDelay(int ms)
{
    QEventLoop loop;
    QTimer::singleShot(ms, &loop, &QEventLoop::quit);
    loop.exec();
}

namespace {
// Shared body for both public waiters below -- they must stay separate methods
// (the name/signature pair is fixed by the shared jarvis/AgentDesktop.h header,
// same as the Linux twin), but the polling loop itself is identical modulo the
// path/timeout/delay, so it's factored here rather than duplicated twice. Takes
// the port/bearer directly rather than a `const Desk &` since Desk is a private
// nested type of AgentDesktop, not visible to a free function at file scope.
// NB: no d.sway liveness short-circuit -- WindowsSandbox.exe exits ~1s after
// launch while the box keeps running, so its state is a false signal (see the
// waiter header above). The HTTP poll + timeout budget is the only readiness
// signal.
bool waitForHttpOk(int port, const QString &bearer, const QString &path,
                    int perRequestTimeoutMs, int pollDelayMs, int totalTimeoutMs)
{
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < totalTimeoutMs) {
        if (httpGetOk(QStringLiteral("127.0.0.1"), quint16(port), path, bearer,
                      perRequestTimeoutMs))
            return true;
        pumpingDelay(pollDelayMs);
    }
    return false;
}
} // namespace

// --- hiding the sandbox's own RDP-style window ------------------------------
// Windows Sandbox renders its guest desktop through a host-side RDP session
// host (WindowsSandboxRemoteSession.exe) that pops up a normal, visible,
// moveable "Windows Sandbox" window on the HOST desktop -- there is no .wsb
// config knob or launch flag to suppress it. That's fine for a human manually
// poking at a sandbox, but wrong for an AGENT's own isolated desktop: the
// whole point is that the user's screen stays theirs, with the agent's screen
// visible only on demand via the Cindro app's WATCH feature (the in-sandbox
// engine's own screen capture, piped out over /video/frame + /video/mjpeg --
// entirely independent of this host-side window's visibility, since that
// capture reads pixels from INSIDE the guest, not from the host-side RDP
// window's client area). Hiding this window is therefore safe: it cannot
// affect the video feed the app actually uses. Best-effort and non-fatal --
// if the window can't be found/hidden the sandbox just stays visible, same as
// before this existed.
//
// CORRECTION (jarvis#104 follow-up): this was briefly reverted after a single
// A/B sample seemed to show hiding the window caused /ready to fail with
// "ScreenShotError: ... BitBlt". A multi-agent investigation (live re-test +
// log analysis across multiple runs) found TWO runs with hiding DISABLED in
// BOTH that still diverged from 60/60 BitBlt failures to passing in 2 probes
// -- proving that specific symptom is environmental/load-based flakiness in
// the sandbox guest's own screenshot library (`mss`'s ScreenShotError, not
// code in this repo), uncorrelated with window visibility. Restored.
namespace {
struct HideWindowCtx {
    DWORD targetPid = 0;
    bool hid = false;
};

BOOL CALLBACK hideWindowIfOwnedByPid(HWND hwnd, LPARAM lparam)
{
    auto *ctx = reinterpret_cast<HideWindowCtx *>(lparam);
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != ctx->targetPid || !IsWindowVisible(hwnd))
        return TRUE;
    ShowWindow(hwnd, SW_HIDE);
    ctx->hid = true;
    return TRUE; // keep enumerating -- the client can own more than one window
}

DWORD findPidByImageName(const wchar_t *imageName)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return 0;
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    DWORD pid = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, imageName) == 0) {
                pid = pe.th32ProcessID;
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

// Repeating, self-stopping QTimer (not a blocking loop -- see pumpingDelay()'s
// header for why a blocking wait on this thread is off the table) that polls
// for WindowsSandboxRemoteSession.exe's window and hides it as soon as it
// appears. That process doesn't exist yet at the moment WindowsSandbox.exe
// launches, so this has to poll rather than fire once. Budget matches the
// same sandboxStartupBudgetMs() the health/ready waiters use, at a 1s
// cadence, so it stays alive at least as long as boot itself is allowed to
// take (a cold boot can take 60-90s+ before the RDP session host even
// exists).
//
// Parented to `sway` (the launcher QProcess) so killProc()/teardown()
// destroying it also destroys and stops this timer -- it never outlives the
// session it belongs to.
void hideSandboxWindowSoon(QProcess *sway, int budgetMs)
{
    auto *timer = new QTimer(sway);
    timer->setInterval(1000);
    int attemptsLeft = qMax(1, budgetMs / 1000);
    QObject::connect(timer, &QTimer::timeout, sway, [timer, attemptsLeft]() mutable {
        --attemptsLeft;
        const DWORD pid = findPidByImageName(L"WindowsSandboxRemoteSession.exe");
        bool hid = false;
        if (pid != 0) {
            HideWindowCtx ctx;
            ctx.targetPid = pid;
            EnumWindows(hideWindowIfOwnedByPid, reinterpret_cast<LPARAM>(&ctx));
            hid = ctx.hid;
        }
        if (hid || attemptsLeft <= 0)
            timer->stop();
    });
    timer->start();
}
} // namespace

bool AgentDesktop::waitForEngineHealth(const Desk &d, int timeoutMs)
{
    return waitForHttpOk(d.info.port, d.info.bearer, QStringLiteral("/health"), 1000, 300,
                          timeoutMs);
}

bool AgentDesktop::waitForEngineReady(const Desk &d, int timeoutMs)
{
    return waitForHttpOk(d.info.port, d.info.bearer, QStringLiteral("/ready"), 5000, 350,
                          timeoutMs);
}

// ---------------------------------------------------------------------------
// ensure() -- provision the isolated agent desktop. Mode-dispatched; only the
// default `sandbox` tier is implemented (Phase 1). childsession/hyperv/takeover
// return up=false with a typed reason -> the daemon's v1 real-screen fallback.
// ---------------------------------------------------------------------------
AgentDesktopInfo AgentDesktop::ensure(const QString &sessionId, QString *err)
{
    m_lastError.clear();
    if (sessionId.isEmpty()) {
        m_lastError = QStringLiteral("empty session id");
        if (err)
            *err = m_lastError;
        return {};
    }
    if (auto it = m_desks.find(sessionId); it != m_desks.end() && it->second->info.up)
        return it->second->info;

    const QString mode = resolveMode();
    if (mode != QStringLiteral("sandbox")) {
        // Phase 2/3 (childsession/hyperv) not wired yet; takeover is the v1 path.
        // A typed reason tells ControlServer to degrade to real-screen take-over.
        m_lastError = QStringLiteral(
                          "windows isolation mode '%1' has no isolated agent "
                          "desktop yet; using v1 real-screen take-over")
                          .arg(mode);
        if (err)
            *err = m_lastError;
        return {};
    }

    // --- single-instance guard (Windows Sandbox is one-per-host) ----------
    // This session's own up desk already early-returned above, so a non-empty
    // m_desks here is ALWAYS a DIFFERENT session's live sandbox. A non-empty
    // g_provisioningSessions catches a second call that's still mid-boot (m_desks not
    // populated yet -- see ProvisioningLock above). A typed 'sandbox_busy' reason
    // tells ControlServer to degrade to v1 take-over rather than launch a doomed 2nd
    // WindowsSandbox.exe.
    if (!m_desks.empty() || !g_provisioningSessions.isEmpty()) {
        m_lastError = QStringLiteral(
            "sandbox_busy: a Windows Sandbox agent desktop is already running "
            "(Windows Sandbox allows only one instance per host); using v1 "
            "real-screen take-over");
        if (err)
            *err = m_lastError;
        return {};
    }
    // Claim the provisioning slot BEFORE the out-of-band check below: that check is
    // now event-loop-pumping (sandboxAlreadyRunning -> captureProcessOutputPumping),
    // so holding the lock first stops a second ensure() dispatched DURING the pump
    // from slipping past the guard above.
    ProvisioningLock provisioningLock(sessionId);

    // Also refuse if a Windows Sandbox is already running out-of-band (the user's
    // own, or ours orphaned by a daemon crash -- we can't safely taskkill it).
    // sweepOrphans() only tidies our on-disk artifacts, never a running sandbox, so
    // this guard is the enforcement. Wrapped in a wait scope since the probe pumps.
    bool alreadyRunning;
    {
        ProvisioningWaitScope waitScope(sessionId);
        alreadyRunning = sandboxAlreadyRunning();
    }
    if (alreadyRunning) {
        // Honor a cancel/delete deferred during the (pumping) probe above before we
        // bail. Nothing was provisioned this call, but a PRIOR reservation for this
        // id may still need dropping; we're outside the wait scope now, so this runs
        // for real. (teardown() here is a near no-op -- no tunnel/box exists yet.)
        if (g_deferredTeardowns.contains(sessionId)) {
            const bool alsoRelease = g_deferredReleases.contains(sessionId);
            g_deferredTeardowns.remove(sessionId);
            g_deferredReleases.remove(sessionId);
            teardown(sessionId);
            if (alsoRelease)
                m_reserved.erase(sessionId);
        }
        m_lastError = QStringLiteral(
            "sandbox_busy: a Windows Sandbox agent desktop is already running "
            "(Windows Sandbox allows only one instance per host); using v1 "
            "real-screen take-over");
        if (err)
            *err = m_lastError;
        return {};
    }

    // --- reservation (VERBATIM from the Linux twin) -----------------------
    auto desk = std::make_unique<Desk>();
    Desk &d = *desk;
    d.info.sessionId = sessionId;
    d.info.width = m_opts.width;
    d.info.height = m_opts.height;
    if (auto r = m_reserved.find(sessionId); r != m_reserved.end()) {
        d.info.port = r->second.first;
        d.info.bearer = r->second.second;
    } else {
        d.info.port = nextPort();
        d.info.bearer = genBearer();
        m_reserved.emplace(sessionId, std::make_pair(d.info.port, d.info.bearer));
    }
    d.info.mcpUrl = QStringLiteral("http://127.0.0.1:%1/mcp").arg(d.info.port);

    // --- preconditions ----------------------------------------------------
    const QString sbExe = sandboxExePath();
    if (!QFileInfo::exists(sbExe)) {
        m_lastError = QStringLiteral(
                          "WindowsSandbox.exe not found (%1) -- enable the "
                          "'Containers-DisposableClientVM' feature on Windows "
                          "Pro/Enterprise/Education, or set the isolation mode to "
                          "takeover")
                          .arg(QDir::toNativeSeparators(sbExe));
        if (err)
            *err = m_lastError;
        return {};
    }
    const QString engDir = enginePayloadDir(m_opts.engineDir);
    const QString wsbTemplate = QDir(isolationDir())
                                    .absoluteFilePath(
                                        QStringLiteral("sandbox/jarvis-agent.wsb.in"));
    if (!QFileInfo::exists(wsbTemplate)) {
        m_lastError = QStringLiteral("sandbox template missing: ") +
                      QDir::toNativeSeparators(wsbTemplate);
        if (err)
            *err = m_lastError;
        return {};
    }

    // Per-session writable temp dir for the rendered .wsb (also our orphan marker).
    d.runtimeDir = sessionTempDir(sessionId);
    QDir().mkpath(d.runtimeDir);

    const quint16 rport = rendezvousPortFor(d.info.port);
    // Mode-specific cold-boot budget (a Windows Sandbox boots a full image before
    // the engine starts); applied to the tunnel pairing wait + both HTTP waiters.
    const int startupMs = sandboxStartupBudgetMs(m_opts.startupTimeoutMs);

    // --- gap #2: host reachability (reverse tunnel or netsh portproxy) -----
    const QString relayKind = resolveRelayKind();
    if (relayKind == QStringLiteral("tunnel")) {
        // In-process reverse tunnel, parented to `this` and named per session so
        // teardown()/sweepOrphans() can find + stop it (the read-only Desk struct
        // has no slot for it).
        auto *tunnel = new ReverseTunnel(this);
        tunnel->setObjectName(QStringLiteral("jarvis-relay-") + sessionId);
        tunnel->setPairTimeoutMs(startupMs);
        // AUTH GATE (jarvis#104 Codex review follow-up): require the in-sandbox
        // dialer to present this session's bearer before its rendezvous
        // connection is ever admitted to the pairing pool -- see
        // ReverseTunnel::setExpectedHandshake()'s header. bootstrap.ps1 passes
        // the matching --bearer to jarvis-relay.exe dial.
        tunnel->setExpectedHandshake(d.info.bearer);
        if (!tunnel->start(quint16(d.info.port), rport)) {
            m_lastError = QStringLiteral(
                              "reverse tunnel failed to bind 127.0.0.1:%1 / "
                              "rendezvous 0.0.0.0:%2")
                              .arg(d.info.port)
                              .arg(rport);
            tunnel->deleteLater();
            QDir(d.runtimeDir).removeRecursively();
            if (err)
                *err = m_lastError;
            return {};
        }
        // BLOCKING FIX: permit the in-sandbox dialer's inbound connect to rport
        // through Windows Defender Firewall (default-blocks a headless service with
        // no prompt). Best-effort; dropped in teardown(). Without it the tunnel
        // never pairs on a default-firewall box and /health never returns.
        addRelayFirewallRule(rport);
    } else {
        // MVP: netsh portproxy host loopback -> a KNOWN sandbox IP. Requires the
        // operator to pin the sandbox NAT IP (JARVIS_SANDBOX_IP); without it the
        // tunnel mode is the reliable path. Best-effort, torn down in teardown().
        const QString sbIp = qEnvironmentVariable("JARVIS_SANDBOX_IP");
        if (sbIp.isEmpty()) {
            m_lastError = QStringLiteral(
                "relay mode 'portproxy' needs JARVIS_SANDBOX_IP (the sandbox NAT "
                "address); use the default 'tunnel' relay instead");
            QDir(d.runtimeDir).removeRecursively();
            if (err)
                *err = m_lastError;
            return {};
        }
        QProcess::execute(
            QStringLiteral("netsh"),
            {QStringLiteral("interface"), QStringLiteral("portproxy"),
             QStringLiteral("add"), QStringLiteral("v4tov4"),
             QStringLiteral("listenaddress=127.0.0.1"),
             QStringLiteral("listenport=%1").arg(d.info.port),
             QStringLiteral("connectaddress=%1").arg(sbIp),
             QStringLiteral("connectport=%1").arg(d.info.port)});
    }

    // --- render the .wsb (tokens @PORT@/@BEARER@/@HOSTIP@/@RENDEZVOUS@/...) -
    QString wsb;
    {
        QFile tf(wsbTemplate);
        if (!tf.open(QIODevice::ReadOnly | QIODevice::Text)) {
            m_lastError = QStringLiteral("cannot read sandbox template: ") + wsbTemplate;
            teardown(sessionId);
            if (err)
                *err = m_lastError;
            return {};
        }
        wsb = QString::fromUtf8(tf.readAll());
        tf.close();
    }
    // REPORT 3 fix: emit the rendered .wsb starting directly at <Configuration> --
    // no XML prolog, no leading doc comment. Both stay in jarvis-agent.wsb.in for
    // humans; Windows Sandbox's own config parser is undocumented and strict, and a
    // prolog+comment ahead of the root element was the ONE thing identical across
    // every failed launch tonight (trivial-echo test AND the real engine test),
    // matching the symptom exactly: VM boots, LogonCommand silently never fires, no
    // error surfaced anywhere. Stripping here (rather than trying to keep the
    // comment and injecting tokens only inside <Configuration>) also removes any
    // chance of a token value containing "--" corrupting an XML comment, since no
    // comment reaches the rendered file at all.
    //
    // Split on a dedicated sentinel line, NOT a literal "<Configuration" search: an
    // indexOf("<Configuration") is one accidental doc-prose edit away from matching
    // INSIDE the leading comment instead of the real element (e.g. a future sentence
    // mentioning "the <Configuration> element") and silently reintroducing this exact
    // bug with no error. The sentinel can't collide with prose by construction.
    const QString sentinel = QStringLiteral("<!-- WSB-TEMPLATE-DOCS-END -->");
    const int sentinelPos = wsb.indexOf(sentinel);
    if (sentinelPos < 0) {
        m_lastError = QStringLiteral("sandbox template malformed (missing '") + sentinel +
                      QStringLiteral("' marker): ") + wsbTemplate;
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }
    wsb = wsb.mid(sentinelPos + sentinel.length()).trimmed();
    if (!wsb.startsWith(QStringLiteral("<Configuration"))) {
        m_lastError = QStringLiteral("sandbox template malformed (no <Configuration> "
                                      "element immediately after the docs-end marker): ") +
                      wsbTemplate;
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }
    wsb.replace(QStringLiteral("@ENGINEDIR@"),
                xmlEscape(QDir::toNativeSeparators(engDir)));
    wsb.replace(QStringLiteral("@PORT@"), QString::number(d.info.port));
    wsb.replace(QStringLiteral("@BEARER@"), xmlEscape(d.info.bearer));
    wsb.replace(QStringLiteral("@RENDEZVOUS@"), QString::number(rport));
    // The host gateway as seen from inside the box is the sandbox's default
    // gateway -- bootstrap.ps1 resolves it ("auto") unless an operator pins it.
    const QString hostIp = qEnvironmentVariable("JARVIS_HOST_IP");
    wsb.replace(QStringLiteral("@HOSTIP@"),
                xmlEscape(hostIp.isEmpty() ? QStringLiteral("auto") : hostIp));
    wsb.replace(QStringLiteral("@SESSION@"), xmlEscape(sessionId));

    // Optional diagnostics MappedFolder (REPORT 6: NOT hardcoded -- opt-in via
    // JARVIS_SANDBOX_DIAG_DIR so a personal host path never ships in the template).
    // Inserted right before </MappedFolders> so it's additive to whatever the
    // template already declares. bootstrap.ps1 self-detects C:\hostlog and mirrors
    // its trace there instead of %USERPROFILE% when present -- see
    // windows/isolation/sandbox/bootstrap.ps1.
    const QString diagXml = diagMappedFolderXml();
    if (!diagXml.isEmpty()) {
        const int closeIdx = wsb.indexOf(QStringLiteral("</MappedFolders>"));
        if (closeIdx >= 0)
            wsb.insert(closeIdx, diagXml);
    }

    d.confPath = QDir(d.runtimeDir)
                     .absoluteFilePath(QStringLiteral("jarvis-agent-") + sessionId +
                                       QStringLiteral(".wsb"));
    {
        QFile wf(d.confPath);
        if (!wf.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
            m_lastError = QStringLiteral("cannot write rendered .wsb: ") + d.confPath;
            teardown(sessionId);
            if (err)
                *err = m_lastError;
            return {};
        }
        // REPORT 3 #4 fix: check the write actually landed. A short/failed write
        // (disk full, AV lock, etc.) would launch WindowsSandbox.exe against a
        // truncated/garbage .wsb -- the same silent "boots, no LogonCommand" symptom
        // as the XML bug above, just from a different cause; catch it here instead
        // of burning a whole sandbox launch to discover it.
        const QByteArray bytes = wsb.toUtf8();
        const qint64 written = wf.write(bytes);
        const bool flushed = wf.flush();
        wf.close();
        if (written != qint64(bytes.size()) || !flushed || wf.error() != QFile::NoError) {
            m_lastError = QStringLiteral(
                              "short/failed write of rendered .wsb (%1 of %2 bytes, "
                              "error=%3): ")
                              .arg(written)
                              .arg(bytes.size())
                              .arg(wf.errorString()) +
                          d.confPath;
            teardown(sessionId);
            if (err)
                *err = m_lastError;
            return {};
        }
    }

    // --- launch the sandbox ------------------------------------------------
    // REAL-HARDWARE CORRECTION: the Linux-mirror design ASSUMED WindowsSandbox.exe
    // stays running as a long-lived host-window process for the whole session -- so
    // d.sway could track the box's lifetime and closing it would destroy the box.
    // On a real Win11 Pro box that is FALSE: WindowsSandbox.exe is a thin launcher
    // that fork-and-exits within ~1s, handing the live box off to service-hosted
    // processes (WindowsSandboxRemoteSession/Server/Client + the vmmemWindowsSandbox
    // VM worker). So d.sway goes NotRunning almost immediately while the box keeps
    // running -- which is why the waiters no longer probe it (see the waiter header)
    // and teardown() closes the box via those host processes, NOT via d.sway (see
    // closeSandboxHostProcesses()). We still keep d.sway to catch a launch that
    // fails to even start. The LogonCommand (bootstrap.ps1) runs INSIDE the box, so
    // there is no host-side engine QProcess.
    d.sway = new QProcess(this);
    d.sway->setProgram(sbExe);
    d.sway->setArguments({d.confPath});
    d.sway->setProcessChannelMode(QProcess::SeparateChannels);
    d.sway->start();
    if (!d.sway->waitForStarted(5000)) {
        m_lastError = QStringLiteral("WindowsSandbox.exe failed to start: ") +
                      d.sway->errorString();
        // Not in m_desks yet, so kill the proc we made, then teardown() stops the
        // relay + tidies the temp dir.
        killProc(d.sway);
        d.sway = nullptr;
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }
    d.info.swayPid = qint64(d.sway->processId());
    // Best-effort, non-blocking: hide the sandbox's own RDP-client window as
    // soon as it appears (see hideSandboxWindowSoon()'s header). Started here,
    // not awaited -- it polls opportunistically while the health/ready waiters
    // below pump this same thread's event loop.
    hideSandboxWindowSoon(d.sway, startupMs);

    // --- wait for the in-box engine via the relay --------------------------
    // Each waiter/capture below PUMPS this thread's event loop (so ReverseTunnel can
    // pair). That's exactly when a concurrent session.cancel/delete for THIS id can
    // be dispatched re-entrantly -- so each pumping step is wrapped in a
    // ProvisioningWaitScope, under which teardown()/releaseSession() DEFER rather
    // than yank the tunnel/firewall/box out from under us (jarvis#113). The scope is
    // released the instant the step returns, so the failure handling that follows
    // (its own teardown()) runs for real, never deferred.
    bool healthOk;
    {
        ProvisioningWaitScope waitScope(sessionId);
        healthOk = waitForEngineHealth(d, startupMs);
    }
    if (!healthOk) {
        m_lastError = QStringLiteral(
                          "agent sandbox engine /health never became ready on "
                          "127.0.0.1:%1 (sandbox boot or relay failure)")
                          .arg(d.info.port);
        killProc(d.sway);
        d.sway = nullptr;
        // The desk isn't tracked yet, so the teardown() below won't reach its
        // sandbox-close branch -- close the real box here (d.sway is just the
        // already-exited launcher, see closeSandboxHostProcesses()).
        closeSandboxHostProcesses();
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }
    // Health passed -- the box is genuinely ours (single-instance guard) and up.
    // Capture its host PIDs NOW so any later close (this ready-check failure
    // path, or teardown() much further down the line) can be scoped to exactly
    // these processes instead of a blind by-name kill (see
    // closeSandboxHostProcesses()'s header for why that matters).
    {
        ProvisioningWaitScope waitScope(sessionId);
        g_sandboxHostPids[sessionId] = captureSandboxHostPids();
    }
    bool readyOk;
    {
        ProvisioningWaitScope waitScope(sessionId);
        readyOk = waitForEngineReady(d, startupMs);
    }
    if (!readyOk) {
        m_lastError = QStringLiteral(
                          "agent sandbox engine /ready (capture not serviceable) "
                          "never succeeded on 127.0.0.1:%1")
                          .arg(d.info.port);
        killProc(d.sway);
        d.sway = nullptr;
        closeSandboxHostProcesses(g_sandboxHostPids.take(sessionId)); // close the real box (untracked desk; see above)
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }

    // Honor a cancel/delete that arrived (and was deferred) while we were parked in
    // the waiters above: we now hold a fully-provisioned, healthy box, but the caller
    // has since asked to tear this session down -- so do it instead of publishing it
    // as up. Publish into m_desks FIRST so teardown() takes its tracked-desk branch
    // (closing the real box via the captured host PIDs); an untracked teardown would
    // skip that and orphan the running sandbox. We're outside every ProvisioningWait
    // scope here, so this teardown() runs for real rather than deferring again.
    if (g_deferredTeardowns.contains(sessionId)) {
        const bool alsoRelease = g_deferredReleases.contains(sessionId);
        g_deferredTeardowns.remove(sessionId);
        g_deferredReleases.remove(sessionId);
        m_desks.emplace(sessionId, std::move(desk));
        teardown(sessionId);
        if (alsoRelease)
            m_reserved.erase(sessionId);
        m_lastError =
            QStringLiteral("session %1 was cancelled during sandbox provisioning")
                .arg(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }

    d.info.up = true;
    AgentDesktopInfo result = d.info;
    m_desks.emplace(sessionId, std::move(desk));
    return result;
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
    // DEFER if ensure() is mid-flight for this same session, parked in a pumping
    // waiter (which is how this very call got dispatched re-entrantly): stopping the
    // ReverseTunnel / dropping the firewall rule / killing the sandbox host
    // processes now would leave the box healthy but UNREACHABLE, so the waiter spins
    // its whole budget then fails (jarvis#113). Record the request; ensure() honors
    // it the instant it finishes provisioning. Only genuinely re-entrant calls hit
    // this -- ensure()'s own straight-line failure cleanup runs outside any wait
    // scope, and any normal (post-provisioning) teardown finds the set empty.
    if (g_provisioningWaitSessions.contains(sessionId)) {
        g_deferredTeardowns.insert(sessionId);
        return;
    }
    // Stop the per-session reverse tunnel (parented to `this`, named per session).
    const QString relayName = QStringLiteral("jarvis-relay-") + sessionId;
    if (auto *tunnel = findChild<ReverseTunnel *>(relayName)) {
        tunnel->stop();
        tunnel->deleteLater();
    }
    // Resolve this session's engine port (tracked desk or, if ensure() failed
    // mid-flight, the surviving reservation) for the per-session relay cleanup.
    int port = 0;
    if (auto d = m_desks.find(sessionId); d != m_desks.end())
        port = d->second->info.port;
    else if (auto r = m_reserved.find(sessionId); r != m_reserved.end())
        port = r->second.first;
    if (resolveRelayKind() == QStringLiteral("portproxy")) {
        // Best-effort: drop any netsh portproxy rule for this session's port.
        if (port > 0)
            QProcess::startDetached(
                QStringLiteral("netsh"),
                {QStringLiteral("interface"), QStringLiteral("portproxy"),
                 QStringLiteral("delete"), QStringLiteral("v4tov4"),
                 QStringLiteral("listenaddress=127.0.0.1"),
                 QStringLiteral("listenport=%1").arg(port)});
    } else if (port > 0) {
        // Drop the reverse-tunnel firewall allow-rule (rendezvous = engine+1000).
        removeRelayFirewallRule(rendezvousPortFor(port));
    }

    auto it = m_desks.find(sessionId);
    if (it == m_desks.end()) {
        // Not tracked yet (ensure() failed mid-flight) -- still tidy the temp dir.
        QDir(sessionTempDir(sessionId)).removeRecursively();
        return;
    }
    Desk &d = *it->second;
    // Close the REAL sandbox first: d.sway is only the launcher (long since exited,
    // see the ensure() launch note), so killing it does NOT stop the running box --
    // the service-hosted WindowsSandbox* processes do (see closeSandboxHostProcesses).
    // Scoped to the PIDs captured for THIS session when it went healthy -- see
    // closeSandboxHostProcesses()'s header for why a blind by-name kill here is
    // unsafe once a session has been alive long enough for the user to plausibly
    // have started their own separate sandbox in the meantime.
    closeSandboxHostProcesses(g_sandboxHostPids.take(sessionId));
    killProc(d.sway); // just cleans up the (already-exited) launcher QProcess handle
    d.sway = nullptr;
    killProc(d.engine); // null on Windows (engine lives in the box); safe no-op
    d.engine = nullptr;
    if (!d.runtimeDir.isEmpty())
        QDir(d.runtimeDir).removeRecursively();
    if (!d.configDir.isEmpty())
        QDir(d.configDir).removeRecursively();
    if (!d.confPath.isEmpty())
        QFile::remove(d.confPath);
    m_desks.erase(it);
    // NB: the (port, bearer) reservation is intentionally KEPT (releaseSession()
    // drops it) so a later ensure() re-provisions an identical engine.
}

void AgentDesktop::releaseSession(const QString &sessionId)
{
    // Same mid-flight deferral as teardown() (see its header): if ensure() is parked
    // in a pumping waiter for this id, defer BOTH the teardown and the reservation
    // erase. erasing m_reserved out from under the in-flight ensure() would drop the
    // (port,bearer) it is provisioning against; ensure() replays both once it's done.
    if (g_provisioningWaitSessions.contains(sessionId)) {
        g_deferredTeardowns.insert(sessionId);
        g_deferredReleases.insert(sessionId);
        return;
    }
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
    // Windows Sandbox is SINGLE-INSTANCE: at most one sandbox runs per host, and
    // each is disposable (closing WindowsSandbox.exe destroys it -- nothing
    // persists across a daemon crash). So unlike the Linux nested-Sway sweep there
    // are no long-lived orphan compositors/engines to kill: we cannot safely
    // taskkill a running WindowsSandbox.exe because it might be the USER'S own
    // sandbox, not ours. We therefore reap our ON-DISK leftovers -- stale
    // per-session temp dirs (rendered .wsb files) under agentTempRoot() that no
    // tracked desk owns -- mirroring the Linux sweep's "tidy stale artifacts"
    // step -- plus any leftover reverse-tunnel firewall allow-rules from a prior
    // abnormal exit (see sweepOrphanFirewallRules()). Returns the total number of
    // stale artifacts removed (session dirs + firewall rules).
    QSet<QString> trackedDirs;
    for (const auto &[id, desk] : m_desks) {
        if (!desk->runtimeDir.isEmpty())
            trackedDirs.insert(QDir(desk->runtimeDir).absolutePath());
    }
    QDir root(agentTempRoot());
    if (!root.exists())
        return 0;
    int reaped = 0;
    const auto entries = root.entryList({QStringLiteral("sess-*")},
                                        QDir::Dirs | QDir::NoDotAndDotDot);
    for (const QString &name : entries) {
        const QString abs = root.absoluteFilePath(name);
        if (trackedDirs.contains(QDir(abs).absolutePath()))
            continue;
        if (QDir(abs).removeRecursively())
            ++reaped;
    }
    reaped += sweepOrphanFirewallRules();
    return reaped;
}

} // namespace jarvis
