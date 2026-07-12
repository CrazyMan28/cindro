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
// Two windows/-local pieces make the rest of Jarvis's pipeline reuse unchanged:
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

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRandomGenerator>
#include <QSet>
#include <QStringList>
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
// v2 SHIP GATE: the isolated agent-desktop tiers (sandbox/hyperv/childsession) are not
// yet validated on real Windows hardware (the CI runner is a nested VM that can't boot
// nested Hyper-V, so they only COMPILE here). Until someone trials them on a real
// Windows Pro box, they NEVER auto-activate: the daemon uses the shipping-safe v1
// real-screen take-over unless the operator explicitly opts in with JARVIS_ENABLE_V2=1
// (set it, then windows.isolation.mode / detect.ps1 pick the tier as usual). This keeps
// an untested nested-Hyper-V path from hanging a release machine ~120s before it falls
// back to v1. The installer/launcher still sets JARVIS_WINDOWS_ISOLATION_MODE from
// windows/isolation/detect.ps1 — it's just ignored for the v2 tiers without the opt-in.
QString resolveMode()
{
    const QString m = qEnvironmentVariable("JARVIS_WINDOWS_ISOLATION_MODE")
                          .trimmed()
                          .toLower();
    if (m == QStringLiteral("takeover"))
        return m;

    const QString v2 =
        qEnvironmentVariable("JARVIS_ENABLE_V2").trimmed().toLower();
    const bool v2optin = (v2 == QStringLiteral("1") || v2 == QStringLiteral("true") ||
                          v2 == QStringLiteral("yes") || v2 == QStringLiteral("on"));
    if (v2optin &&
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
    return QStringLiteral("Jarvis-Agent-Relay-%1").arg(rport);
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
// "Jarvis-Agent-Relay-*" naming scheme. netsh has no wildcard "show rule name=",
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
    static const QString kOurPrefix = QStringLiteral("Jarvis-Agent-Relay-");
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

// --- single-instance guard --------------------------------------------------
// Windows Sandbox allows only ONE running instance per host. Detect an existing
// one (ours-after-a-crash or the USER's own) so ensure() can refuse a 2nd launch
// with a typed reason instead of spawning a WindowsSandbox.exe that fails opaquely.
// Best-effort: returns false when the probe can't run (we then fall through to the
// normal launch, which still fails safely if a sandbox truly exists). The broad
// "WindowsSandbox" substring covers WindowsSandbox.exe / WindowsSandboxClient.exe /
// WindowsSandboxServer.exe.
bool sandboxAlreadyRunning()
{
    if (qEnvironmentVariableIsSet("JARVIS_SANDBOX_SKIP_RUNNING_CHECK"))
        return false;
    QProcess ps;
    ps.start(QStringLiteral("tasklist"),
             {QStringLiteral("/nh"), QStringLiteral("/fo"), QStringLiteral("csv")});
    if (!ps.waitForStarted(3000))
        return false;
    if (!ps.waitForFinished(5000)) {
        ps.kill();
        ps.waitForFinished(1000);
        return false;
    }
    const QString out = QString::fromLocal8Bit(ps.readAllStandardOutput());
    return out.contains(QStringLiteral("WindowsSandbox"), Qt::CaseInsensitive);
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
// Engine readiness waiters -- copied VERBATIM from core/src/AgentDesktop.cpp.
// The ONLY change: the "process exited early" probe targets the sandbox process
// (d.sway) instead of the Linux engine process (d.engine), because on Windows the
// engine runs INSIDE the sandbox (no host-side engine QProcess); d.sway is the
// WindowsSandbox.exe host handle. The HTTP probes hit 127.0.0.1:<port>, which the
// reverse tunnel forwards into the box, so the contract is unchanged.
// ---------------------------------------------------------------------------
bool AgentDesktop::waitForEngineHealth(const Desk &d, int timeoutMs)
{
    QNetworkAccessManager nam;
    const QString url =
        QStringLiteral("http://127.0.0.1:%1/health").arg(d.info.port);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs) {
        if (d.sway && d.sway->state() == QProcess::NotRunning)
            return false; // sandbox exited early
        QNetworkRequest rq{QUrl(url)};
        if (!d.info.bearer.isEmpty())
            rq.setRawHeader("Authorization", QByteArray("Bearer ") + d.info.bearer.toUtf8());
        QNetworkReply *reply = nam.get(rq);
        QEventLoop loop;
        QTimer t;
        t.setSingleShot(true);
        QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(&t, &QTimer::timeout, &loop, [&]() {
            reply->abort();
            loop.quit();
        });
        t.start(1000);
        loop.exec();
        const bool ok = reply->isFinished() &&
                        reply->error() == QNetworkReply::NoError &&
                        reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200;
        reply->deleteLater();
        if (ok)
            return true;
        QEventLoop wait;
        QTimer::singleShot(300, &wait, &QEventLoop::quit);
        wait.exec();
    }
    return false;
}

bool AgentDesktop::waitForEngineReady(const Desk &d, int timeoutMs)
{
    QNetworkAccessManager nam;
    const QString url =
        QStringLiteral("http://127.0.0.1:%1/ready").arg(d.info.port);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs) {
        if (d.sway && d.sway->state() == QProcess::NotRunning)
            return false; // sandbox exited early
        QNetworkRequest rq{QUrl(url)};
        if (!d.info.bearer.isEmpty())
            rq.setRawHeader("Authorization", QByteArray("Bearer ") + d.info.bearer.toUtf8());
        QNetworkReply *reply = nam.get(rq);
        QEventLoop loop;
        QTimer t;
        t.setSingleShot(true);
        QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(&t, &QTimer::timeout, &loop, [&]() {
            reply->abort();
            loop.quit();
        });
        t.start(5000);
        loop.exec();
        const bool ok = reply->isFinished() &&
                        reply->error() == QNetworkReply::NoError &&
                        reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200;
        reply->deleteLater();
        if (ok)
            return true;
        QEventLoop wait;
        QTimer::singleShot(350, &wait, &QEventLoop::quit);
        wait.exec();
    }
    return false;
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
    // m_desks here is ALWAYS a DIFFERENT session's live sandbox. Also refuse if a
    // WindowsSandbox.exe is already running out-of-band (the user's own, or ours
    // orphaned by a daemon crash -- we can't safely taskkill it). A typed
    // 'sandbox_busy' reason tells ControlServer to degrade to v1 take-over rather
    // than launch a doomed 2nd WindowsSandbox.exe. sweepOrphans() only tidies our
    // on-disk artifacts, never a running sandbox, so this guard is the enforcement.
    if (!m_desks.empty() || sandboxAlreadyRunning()) {
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
    wsb.replace(QStringLiteral("@ENGINEDIR@"), QDir::toNativeSeparators(engDir));
    wsb.replace(QStringLiteral("@PORT@"), QString::number(d.info.port));
    wsb.replace(QStringLiteral("@BEARER@"), d.info.bearer);
    wsb.replace(QStringLiteral("@RENDEZVOUS@"), QString::number(rport));
    // The host gateway as seen from inside the box is the sandbox's default
    // gateway -- bootstrap.ps1 resolves it ("auto") unless an operator pins it.
    const QString hostIp = qEnvironmentVariable("JARVIS_HOST_IP");
    wsb.replace(QStringLiteral("@HOSTIP@"),
                hostIp.isEmpty() ? QStringLiteral("auto") : hostIp);
    wsb.replace(QStringLiteral("@SESSION@"), sessionId);

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
        wf.write(wsb.toUtf8());
        wf.close();
    }

    // --- launch the sandbox ------------------------------------------------
    // WindowsSandbox.exe <wsb> STAYS RUNNING as the sandbox's host window process
    // for the whole session -- it does NOT fork-and-exit; closing it destroys the
    // disposable box (nothing persists). So our QProcess handle (d.sway) tracks the
    // sandbox's lifetime: the health/ready waiters probe d.sway->state() as the
    // "boundary gone" signal and teardown() kills d.sway to close the box. (This is
    // the single riskiest mirror assumption -- verify on a real Win Pro/Ent box;
    // see windows/isolation/DESIGN.md's honest constraint.) The LogonCommand
    // (bootstrap.ps1) runs INSIDE the box, so no host-side engine QProcess exists.
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

    // --- wait for the in-box engine via the relay --------------------------
    if (!waitForEngineHealth(d, startupMs)) {
        m_lastError = QStringLiteral(
                          "agent sandbox engine /health never became ready on "
                          "127.0.0.1:%1 (sandbox boot or relay failure)")
                          .arg(d.info.port);
        killProc(d.sway);
        d.sway = nullptr;
        teardown(sessionId);
        if (err)
            *err = m_lastError;
        return {};
    }
    if (!waitForEngineReady(d, startupMs)) {
        m_lastError = QStringLiteral(
                          "agent sandbox engine /ready (capture not serviceable) "
                          "never succeeded on 127.0.0.1:%1")
                          .arg(d.info.port);
        killProc(d.sway);
        d.sway = nullptr;
        teardown(sessionId);
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
    killProc(d.sway); // closes the Windows Sandbox (disposable -> nothing persists)
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
