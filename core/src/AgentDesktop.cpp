#include "jarvis/AgentDesktop.h"

#include <unistd.h> // getuid

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcessEnvironment>
#include <QRandomGenerator>
#include <QRegularExpression>
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

namespace {

QString runtimeRoot()
{
    const QByteArray xdg = qgetenv("XDG_RUNTIME_DIR");
    if (!xdg.isEmpty())
        return QString::fromLocal8Bit(xdg);
    return QStringLiteral("/run/user/") + QString::number(getuid());
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
    // The daemon binary lives in <root>/build/daemon; the engine in
    // <root>/computer-use. Prefer a path relative to the executable; fall back
    // to the known monorepo location.
    const QString fromExe = QDir(QCoreApplication::applicationDirPath())
                                .absoluteFilePath(QStringLiteral("../../computer-use"));
    if (QFileInfo::exists(QDir(fromExe).absoluteFilePath(QStringLiteral("pyproject.toml"))))
        return QDir(fromExe).absolutePath();
    return QStringLiteral("/home/user/projects/computer_use/computer-use");
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
        return false;
    };
    while (used(p))
        ++p;
    return p;
}

QString AgentDesktop::writeSwayConf(const QString &sessionId, int width, int height) const
{
    // A minimal nested-sway config: a single HEADLESS-1 output at the requested
    // size, no idle/lock, no bars. The loud cursor theme makes the agent
    // pointer visually distinct from the user's.
    const QString dir = QDir::homePath() + QStringLiteral("/.local/share/jarvis/agent");
    QDir().mkpath(dir);
    const QString path = QStringLiteral("%1/sway-%2.conf").arg(dir, sessionId);

    QString conf;
    conf += QStringLiteral("# Auto-generated nested agent-desktop sway config (jarvis AgentDesktop)\n");
    conf += QStringLiteral("output HEADLESS-1 resolution %1x%2 position 0 0\n")
                .arg(width).arg(height);
    conf += QStringLiteral("output HEADLESS-1 background #101820 solid_color\n");
    // No screen blanking / locking in the headless desktop. (Do NOT add
    // `hide_cursor` here: sway's grammar is `hide_cursor <timeout-ms>|when-typing`
    // — a bare keyword is a config error. The cursor is shown by default, which
    // is what we want so the loud agent pointer is always visible.)
    conf += QStringLiteral("default_border none\n");
    conf += QStringLiteral("focus_follows_mouse yes\n");
    // Loud cursor theme via seat (sway honors xcursor_theme on seat).
    conf += QStringLiteral("seat * xcursor_theme %1 %2\n")
                .arg(m_opts.cursorTheme).arg(m_opts.cursorSize);

    QFile f(path);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        f.write(conf.toUtf8());
        f.close();
    }
    return path;
}

void AgentDesktop::killProc(QProcess *p, int graceMs)
{
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

bool AgentDesktop::discoverSockets(Desk &d, int timeoutMs)
{
    // The nested sway, launched with its OWN isolated XDG_RUNTIME_DIR
    // (d.runtimeDir), creates wayland-N + wayland-N.lock and
    // sway-ipc.<uid>.<pid>.sock THERE. Because the runtime dir is per-session
    // there is exactly one nested compositor in it, so we take the single
    // sway-ipc + wayland-N sockets (no pid match needed; sway forks, so its IPC
    // pid differs from the launched process id). We still record the IPC pid for
    // diagnostics.
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs) {
        if (d.sway && d.sway->state() == QProcess::NotRunning)
            return false; // sway died during startup
        QDir rd(d.runtimeDir);
        const QStringList ipc = rd.entryList({QStringLiteral("sway-ipc.*.sock")},
                                             QDir::System | QDir::Files);
        if (!ipc.isEmpty()) {
            d.info.swaysock = rd.absoluteFilePath(ipc.first());
            const QRegularExpression re(QStringLiteral("sway-ipc\\.\\d+\\.(\\d+)\\.sock"));
            const auto m = re.match(ipc.first());
            if (m.hasMatch())
                d.info.swayPid = m.captured(1).toLongLong();
        }
        // The wayland display socket is wayland-N (skip the .lock companion).
        const QStringList wl = rd.entryList({QStringLiteral("wayland-*")},
                                            QDir::System | QDir::Files);
        for (const QString &name : wl) {
            if (name.endsWith(QStringLiteral(".lock")))
                continue;
            d.info.waylandDisplay = name;
        }
        if (!d.info.swaysock.isEmpty() && !d.info.waylandDisplay.isEmpty())
            return true;

        QEventLoop loop;
        QTimer::singleShot(150, &loop, &QEventLoop::quit);
        loop.exec();
    }
    return false;
}

bool AgentDesktop::waitForHeadlessOutput(const Desk &d, int timeoutMs)
{
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs) {
        QProcess sm;
        sm.setProgram(m_opts.swayProgram == QStringLiteral("sway")
                          ? QStringLiteral("swaymsg")
                          : QStringLiteral("swaymsg"));
        sm.setArguments({QStringLiteral("-s"), d.info.swaysock,
                         QStringLiteral("-t"), QStringLiteral("get_outputs")});
        sm.start();
        if (sm.waitForFinished(3000) && sm.exitCode() == 0) {
            const QByteArray out = sm.readAllStandardOutput();
            const QJsonDocument doc = QJsonDocument::fromJson(out);
            for (const QJsonValue &v : doc.array()) {
                if (v.toObject().value(QStringLiteral("name")).toString()
                        .compare(QStringLiteral("HEADLESS-1"), Qt::CaseInsensitive) == 0)
                    return true;
            }
        }
        QEventLoop loop;
        QTimer::singleShot(200, &loop, &QEventLoop::quit);
        loop.exec();
    }
    return false;
}

bool AgentDesktop::waitForEngineHealth(const Desk &d, int timeoutMs)
{
    QNetworkAccessManager nam;
    // Build the URL from the desk's own port — the desk is NOT yet registered in
    // m_desks during ensure(), so engineBase()/info() would return empty here.
    const QString url =
        QStringLiteral("http://127.0.0.1:%1/health").arg(d.info.port);
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < timeoutMs) {
        if (d.engine && d.engine->state() == QProcess::NotRunning)
            return false; // engine exited early
        QNetworkRequest rq{QUrl(url)};
        // /health is unauthenticated in the engine, but send the bearer anyway
        // (future-proof) so a token-gated health doesn't break this probe.
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

    auto desk = std::make_unique<Desk>();
    Desk &d = *desk;
    d.info.sessionId = sessionId;
    d.info.width = m_opts.width;
    d.info.height = m_opts.height;
    d.info.port = nextPort();
    d.info.bearer = genBearer();
    d.info.mcpUrl = QStringLiteral("http://127.0.0.1:%1/mcp").arg(d.info.port);

    // Per-session XDG_RUNTIME_DIR for the nested stack so its wayland-N +
    // sway-ipc sockets are isolated and discoverable. Lives under the real
    // runtime dir (tmpfs, 0700) to keep socket semantics + permissions.
    d.runtimeDir = runtimeRoot() + QStringLiteral("/jarvis-agent-") + sessionId;
    QDir().mkpath(d.runtimeDir);
    QFile::setPermissions(d.runtimeDir,
                          QFileDevice::ReadOwner | QFileDevice::WriteOwner |
                              QFileDevice::ExeOwner);

    d.confPath = writeSwayConf(sessionId, d.info.width, d.info.height);

    // --- 1) launch the nested headless sway -------------------------------
    d.sway = new QProcess(this);
    {
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.remove(QStringLiteral("PYTHONPATH"));
        env.insert(QStringLiteral("WLR_BACKENDS"), QStringLiteral("headless"));
        env.insert(QStringLiteral("WLR_LIBINPUT_NO_DEVICES"), QStringLiteral("1"));
        // Render with the pixman software renderer so a nested sway works
        // headless without a real GPU/DRM master.
        env.insert(QStringLiteral("WLR_RENDERER"), QStringLiteral("pixman"));
        env.insert(QStringLiteral("XDG_RUNTIME_DIR"), d.runtimeDir);
        // Loud cursor for the agent pointer (also set in the sway config).
        env.insert(QStringLiteral("XCURSOR_THEME"), m_opts.cursorTheme);
        env.insert(QStringLiteral("XCURSOR_SIZE"), QString::number(m_opts.cursorSize));
        // Marker env so session.py's _find_agent_sway() can distinguish this
        // nested compositor from the host sway by its process environment.
        env.insert(QStringLiteral("JARVIS_AGENT_SESSION"), sessionId);
        d.sway->setProcessEnvironment(env);
    }
    d.sway->setProgram(m_opts.swayProgram);
    d.sway->setArguments({QStringLiteral("-c"), d.confPath});
    d.sway->setStandardInputFile(QProcess::nullDevice());
    d.sway->setProcessChannelMode(QProcess::SeparateChannels);
    d.sway->start();
    if (!d.sway->waitForStarted(5000)) {
        m_lastError = QStringLiteral("nested sway failed to start: ") + d.sway->errorString();
        killProc(d.sway);
        d.sway = nullptr;
        if (err)
            *err = m_lastError;
        return {};
    }

    if (!discoverSockets(d, qMin(m_opts.startupTimeoutMs, 10000))) {
        m_lastError = QStringLiteral("nested sway: could not discover wayland/ipc sockets");
        killProc(d.sway);
        if (err)
            *err = m_lastError;
        return {};
    }
    if (!waitForHeadlessOutput(d, qMin(m_opts.startupTimeoutMs, 8000))) {
        m_lastError = QStringLiteral("nested sway: HEADLESS-1 output never appeared");
        killProc(d.sway);
        if (err)
            *err = m_lastError;
        return {};
    }

    // --- 2) launch the per-session computer-use engine --------------------
    // Its own config dir (so it gets its own bearer + port, NOT the global
    // ~/.computer-use), bound to the nested compositor via the JARVIS_AGENT_*
    // env the engine's session.py detects.
    d.configDir = QDir::homePath() +
                  QStringLiteral("/.local/share/jarvis/agent/cu-") + sessionId;
    QDir().mkpath(d.configDir);
    {
        // Seed a config.yaml with our bearer + port; the engine reads
        // ~/.computer-use/config.yaml, so point HOME-ish via CU_CONFIG_DIR is
        // not supported by the engine — instead we pass host/port/token through
        // the engine env and a generated config file it loads on first run.
        const QString cfgPath = d.configDir + QStringLiteral("/config.yaml");
        QFile cf(cfgPath);
        if (cf.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
            QString y;
            y += QStringLiteral("bearer_token: %1\n").arg(d.info.bearer);
            y += QStringLiteral("host: 127.0.0.1\n");
            y += QStringLiteral("port: %1\n").arg(d.info.port);
            y += QStringLiteral("advertise_host: 127.0.0.1\n");
            y += QStringLiteral("screenshot_tool: grim\n");
            cf.write(y.toUtf8());
            cf.close();
            QFile::setPermissions(cfgPath,
                                  QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        }
    }

    // Daemon-side launch glue (NOT an engine code change): a tiny bootstrap that
    // forces the per-session bearer/port onto the engine's config + uvicorn bind
    // BEFORE the server module decides its own host/port. This makes the
    // per-session engine bind to 127.0.0.1:<port> with our bearer whether or not
    // the engine's own config.py CU_CONFIG_DIR upgrade has landed yet. The
    // engine still consumes JARVIS_AGENT_* from os.environ to target the nested
    // desktop. If the upgraded engine already exposes /video/* + agent kind,
    // those work transparently; we only pin host/port/token here.
    const QString bootstrap = d.configDir + QStringLiteral("/_jarvis_launch.py");
    {
        QFile bf(bootstrap);
        if (bf.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
            QString py;
            py += QStringLiteral("import os\n");
            py += QStringLiteral("import computer_use_mcp.config as _cfg\n");
            py += QStringLiteral("_port = int(os.environ.get('COMPUTER_USE_PORT', '0') or 0)\n");
            py += QStringLiteral("_bearer = os.environ.get('COMPUTER_USE_BEARER', '')\n");
            py += QStringLiteral("_orig = _cfg.load_config\n");
            py += QStringLiteral("def _patched():\n");
            py += QStringLiteral("    c = dict(_orig())\n");
            py += QStringLiteral("    if _port: c['port'] = _port\n");
            py += QStringLiteral("    c['host'] = '127.0.0.1'\n");
            py += QStringLiteral("    if _bearer: c['bearer_token'] = _bearer\n");
            py += QStringLiteral("    return c\n");
            py += QStringLiteral("_cfg.load_config = _patched\n");
            py += QStringLiteral("from computer_use_mcp.server import main\n");
            py += QStringLiteral("main()\n");
            bf.write(py.toUtf8());
            bf.close();
        }
    }

    d.engine = new QProcess(this);
    {
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.remove(QStringLiteral("PYTHONPATH")); // host 3.14 PYTHONPATH breaks the venv
        // Bind the engine at the nested compositor (engine session.py reads
        // these to target the agent desktop instead of the host seat).
        env.insert(QStringLiteral("JARVIS_AGENT_WAYLAND_DISPLAY"), d.info.waylandDisplay);
        env.insert(QStringLiteral("JARVIS_AGENT_SWAYSOCK"), d.info.swaysock);
        env.insert(QStringLiteral("JARVIS_AGENT_SESSION"), sessionId);
        // The nested wayland-N socket lives in the per-session runtime dir, not
        // the host /run/user/<uid>. Tell the engine's session.py where to look
        // (UPGRADES.md JARVIS_AGENT_RUNTIME_DIR) so grim/input target the nested
        // socket and don't fall back to the host (KDE/spectacle) path.
        env.insert(QStringLiteral("JARVIS_AGENT_RUNTIME_DIR"), d.runtimeDir);
        // The engine itself talks to the nested compositor for grim/input.
        env.insert(QStringLiteral("XDG_RUNTIME_DIR"), d.runtimeDir);
        env.insert(QStringLiteral("WAYLAND_DISPLAY"), d.info.waylandDisplay);
        env.insert(QStringLiteral("SWAYSOCK"), d.info.swaysock);
        // Per-session config (bearer/port/host) lives here; the engine's
        // config.py honors CU_CONFIG_DIR when set (added in the engine upgrade),
        // else falls back to ~/.computer-use. We set it so the per-session
        // bearer/port take effect.
        env.insert(QStringLiteral("CU_CONFIG_DIR"), d.configDir);
        env.insert(QStringLiteral("COMPUTER_USE_PORT"), QString::number(d.info.port));
        env.insert(QStringLiteral("COMPUTER_USE_BEARER"), d.info.bearer);
        d.engine->setProcessEnvironment(env);
    }
    d.engine->setWorkingDirectory(m_opts.engineDir);
    d.engine->setProgram(m_opts.uvProgram);
    d.engine->setArguments({QStringLiteral("run"),
                            QStringLiteral("python"), bootstrap});
    d.engine->setStandardInputFile(QProcess::nullDevice());
    d.engine->setProcessChannelMode(QProcess::SeparateChannels);
    // Forward the engine's stderr to the daemon log (prefixed) so launch
    // failures (venv sync errors, bind clashes) are diagnosable.
    {
        QProcess *eng = d.engine;
        const QString sid = sessionId;
        QObject::connect(eng, &QProcess::readyReadStandardError, eng, [eng, sid]() {
            const QByteArray chunk = eng->readAllStandardError();
            for (const QByteArray &line : chunk.split('\n')) {
                if (!line.trimmed().isEmpty())
                    qWarning("jarvisd[agent %s engine] %s",
                             qPrintable(sid), line.constData());
            }
        });
    }
    d.engine->start();
    if (!d.engine->waitForStarted(5000)) {
        m_lastError = QStringLiteral("agent engine failed to start: ") + d.engine->errorString();
        killProc(d.engine);
        killProc(d.sway);
        if (err)
            *err = m_lastError;
        return {};
    }
    d.info.enginePid = qint64(d.engine->processId());

    if (!waitForEngineHealth(d, m_opts.startupTimeoutMs)) {
        m_lastError = QStringLiteral("agent engine /health never became ready on port ") +
                      QString::number(d.info.port);
        killProc(d.engine);
        killProc(d.sway);
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
    auto it = m_desks.find(sessionId);
    if (it == m_desks.end())
        return;
    Desk &d = *it->second;
    killProc(d.engine);
    d.engine = nullptr;
    killProc(d.sway);
    d.sway = nullptr;
    // Best-effort cleanup of the per-session runtime + config dirs.
    if (!d.runtimeDir.isEmpty())
        QDir(d.runtimeDir).removeRecursively();
    if (!d.configDir.isEmpty())
        QDir(d.configDir).removeRecursively();
    if (!d.confPath.isEmpty())
        QFile::remove(d.confPath);
    m_desks.erase(it);
}

void AgentDesktop::teardownAll()
{
    QStringList ids;
    for (const auto &[id, desk] : m_desks)
        ids << id;
    for (const QString &id : ids)
        teardown(id);
}

} // namespace jarvis
