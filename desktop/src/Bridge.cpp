#include "Bridge.h"
#include "FrameProvider.h"
#include "jarvis/DataPaths.h"

#include <QWebSocket>
#include <QSet>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonValue>
#include <QFile>
#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>
#include <QUrl>
#include <QUrlQuery>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QFileSystemWatcher>
#include <QProcess>
#include <QStandardPaths>
#include <QDateTime>
#include <QtMath>
#include <QDebug>
#include <QGuiApplication>
#include <QScreen>
#include <QBuffer>
#include <QImage>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QClipboard>
#include <QDataStream>
#include <QAudioSource>
#include <QAudioFormat>
#include <QAudioDevice>
#include <QMediaDevices>
#include <QMediaPlayer>
#include <QAudioOutput>

#ifdef Q_OS_WIN
// <windows.h> is already pulled in (WIN32_LEAN_AND_MEAN + NOMINMAX) via the
// force-included windows/shell/posix_compat.h, which means <windows.h> does
// NOT drag in the legacy Winsock 1 headers -- so <iphlpapi.h> (GetIfTable2 /
// MIB_IF_TABLE2 / FreeMibTable, the NET stats source below; it pulls in
// <netioapi.h> itself) needs <winsock2.h> + <ws2tcpip.h> included FIRST,
// exactly as documented at the top of the SDK's netioapi.h. Linked via
// windows/CMakeLists.txt (iphlpapi is Windows-only).
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#endif

Bridge::Bridge(QObject *parent)
    : QObject(parent)
    , m_socket(new QWebSocket(QString(), QWebSocketProtocol::VersionLatest, this))
{
    connect(m_socket, &QWebSocket::connected, this, &Bridge::onConnected);
    connect(m_socket, &QWebSocket::disconnected, this, &Bridge::onDisconnected);
    connect(m_socket, &QWebSocket::textMessageReceived, this, &Bridge::onTextMessageReceived);
    connect(m_socket, QOverload<QAbstractSocket::SocketError>::of(&QWebSocket::errorOccurred),
            this, &Bridge::onSocketError);

    // ---- COMPUTER page: live-video poller (engine GET /video/frame) ---------
    m_net = new QNetworkAccessManager(this);
    m_videoBearer = computeUseBearer();
    m_frameTimer = new QTimer(this);
    m_frameTimer->setInterval(125);   // ~8 fps local preview poll
    connect(m_frameTimer, &QTimer::timeout, this, &Bridge::pollFrame);

    // Watch for ask_user questions from the model (file bus → chat card).
    startQuestionWatch();
    // Watch for model-rendered widgets (render_widget file bus → CANVAS page).
    startWidgetWatch();
    // Always tail the agent-pointer bus so the take-over overlay can AUTO-ARM the
    // instant the agent acts on the REAL screen (which="real"), even outside an
    // explicit take-over.
    startPointerTail();

    // ---- Real system stats (HUD strip + Home dashboard) --------------------
    m_statsTimer = new QTimer(this);
    m_statsTimer->setInterval(1500);   // 1.5 s — cheap /proc reads
    connect(m_statsTimer, &QTimer::timeout, this, &Bridge::pollStats);
    pollStats();          // prime once so the UI isn't blank on first paint
    probeGpu();           // one-shot nvidia-smi probe
    m_statsTimer->start();

    // Whenever the active session changes, ask the daemon whether it has a nested
    // agent desktop so the in-chat peek can mirror it live (works for plain chats,
    // not just explicit co-work). A small delay lets the daemon finish provisioning.
    connect(this, &Bridge::sessionIdChanged, this, [this]() {
        setHasAgentDesktop(false);          // unknown until the query answers
        QTimer::singleShot(400, this, &Bridge::refreshAgentDesktop);
    });
}

Bridge::~Bridge()
{
    stopPointerTail();
}

// ---- Real system stats ----------------------------------------------------
// Cheap, dependency-free: parse /proc/stat (CPU), /proc/meminfo (RAM), and
// /proc/net/dev (throughput) on a 1.5 s timer; GPU comes from an async
// nvidia-smi probe (best-effort, disabled after the first miss). All deltas are
// computed against the previous sample so the first tick just primes baselines.
void Bridge::pollStats()
{
    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    const qreal dtSec = m_statsPrevMs > 0 ? (nowMs - m_statsPrevMs) / 1000.0 : 0.0;

#ifdef Q_OS_WIN
    // --- CPU: GetSystemTimes (100ns ticks: idle/kernel/user) -----------------
    // Windows has no /proc/stat. kernelTime INCLUDES idle time (documented
    // GetSystemTimes behavior), so total=kernel+user mirrors /proc/stat's "sum
    // of all jiffies incl. idle", keeping the same delta math as Linux below.
    {
        FILETIME idleFt, kernelFt, userFt;
        if (::GetSystemTimes(&idleFt, &kernelFt, &userFt)) {
            auto toU64 = [](const FILETIME &ft) -> quint64 {
                return (quint64(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
            };
            const quint64 idle = toU64(idleFt);
            const quint64 total = toU64(kernelFt) + toU64(userFt);
            if (m_cpuPrevTotal > 0 && total > m_cpuPrevTotal) {
                const quint64 dTotal = total - m_cpuPrevTotal;
                const quint64 dIdle = idle >= m_cpuPrevIdle ? idle - m_cpuPrevIdle : 0;
                const qreal busy = dTotal > 0 ? 100.0 * (dTotal - dIdle) / dTotal : 0.0;
                m_cpuPercent = qBound(0.0, busy, 100.0);
            }
            m_cpuPrevTotal = total;
            m_cpuPrevIdle = idle;
        }
    }

    // --- RAM: GlobalMemoryStatusEx (physical bytes) ---------------------------
    {
        MEMORYSTATUSEX ms;
        ms.dwLength = sizeof(ms);
        if (::GlobalMemoryStatusEx(&ms)) {
            const quint64 totalKb = static_cast<quint64>(ms.ullTotalPhys) / 1024;
            const quint64 availKb = static_cast<quint64>(ms.ullAvailPhys) / 1024;
            if (totalKb > 0) {
                const quint64 usedKb = totalKb > availKb ? totalKb - availKb : 0;
                m_ramTotalGb = totalKb / 1048576.0;
                m_ramUsedGb = usedKb / 1048576.0;
                m_ramPercent = 100.0 * usedKb / totalKb;
            }
        }
    }

    // --- NET: GetIfTable2 (iphlpapi), sum real (non-loopback, up) ifaces -----
    {
        MIB_IF_TABLE2 *table = nullptr;
        if (::GetIfTable2(&table) == NO_ERROR && table) {
            quint64 rx = 0, tx = 0;
            for (ULONG i = 0; i < table->NumEntries; ++i) {
                const MIB_IF_ROW2 &row = table->Table[i];
                if (row.Type == IF_TYPE_SOFTWARE_LOOPBACK)
                    continue;
                if (row.OperStatus != IfOperStatusUp)
                    continue;
                rx += row.InOctets;
                tx += row.OutOctets;
            }
            ::FreeMibTable(table);
            if (m_netPrevRx > 0 && dtSec > 0.05) {
                const qreal dRx = rx >= m_netPrevRx ? rx - m_netPrevRx : 0;
                const qreal dTx = tx >= m_netPrevTx ? tx - m_netPrevTx : 0;
                m_netDownMbps = (dRx * 8.0 / 1e6) / dtSec;   // megabits/s
                m_netUpMbps = (dTx * 8.0 / 1e6) / dtSec;
            }
            m_netPrevRx = rx;
            m_netPrevTx = tx;
        }
    }
#else
    // --- CPU: aggregate jiffies delta from /proc/stat's first "cpu" line ---
    {
        QFile f(QStringLiteral("/proc/stat"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QString line = QString::fromUtf8(f.readLine());
            f.close();
            const QStringList p = line.split(QLatin1Char(' '), Qt::SkipEmptyParts);
            if (p.size() >= 8 && p.at(0) == QStringLiteral("cpu")) {
                quint64 total = 0, idle = 0;
                for (int i = 1; i < p.size(); ++i) {
                    const quint64 v = p.at(i).toULongLong();
                    total += v;
                    if (i == 4 || i == 5) idle += v;   // idle + iowait
                }
                if (m_cpuPrevTotal > 0 && total > m_cpuPrevTotal) {
                    const quint64 dTotal = total - m_cpuPrevTotal;
                    const quint64 dIdle = idle - m_cpuPrevIdle;
                    const qreal busy = dTotal > 0 ? 100.0 * (dTotal - dIdle) / dTotal : 0.0;
                    m_cpuPercent = qBound(0.0, busy, 100.0);
                }
                m_cpuPrevTotal = total;
                m_cpuPrevIdle = idle;
            }
        }
    }

    // --- RAM: MemTotal - MemAvailable from /proc/meminfo (kB) ---
    {
        QFile f(QStringLiteral("/proc/meminfo"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            quint64 totalKb = 0, availKb = 0;
            // NB: /proc files report size 0, so QFile::atEnd() is unreliable —
            // read until readLine() returns empty instead.
            QByteArray raw;
            while (!(raw = f.readLine()).isEmpty()) {
                const QString l = QString::fromUtf8(raw);
                if (l.startsWith(QStringLiteral("MemTotal:")))
                    totalKb = l.split(QLatin1Char(' '), Qt::SkipEmptyParts).value(1).toULongLong();
                else if (l.startsWith(QStringLiteral("MemAvailable:"))) {
                    availKb = l.split(QLatin1Char(' '), Qt::SkipEmptyParts).value(1).toULongLong();
                    break;
                }
            }
            f.close();
            if (totalKb > 0) {
                const quint64 usedKb = totalKb > availKb ? totalKb - availKb : 0;
                m_ramTotalGb = totalKb / 1048576.0;
                m_ramUsedGb = usedKb / 1048576.0;
                m_ramPercent = 100.0 * usedKb / totalKb;
            }
        }
    }

    // --- NET: sum rx/tx bytes across real ifaces from /proc/net/dev ---
    {
        QFile f(QStringLiteral("/proc/net/dev"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            quint64 rx = 0, tx = 0;
            QByteArray raw;
            while (!(raw = f.readLine()).isEmpty()) {
                const QString l = QString::fromUtf8(raw);
                const int colon = l.indexOf(QLatin1Char(':'));
                if (colon < 0) continue;
                const QString iface = l.left(colon).trimmed();
                if (iface == QStringLiteral("lo") || iface.isEmpty()) continue;
                const QStringList c = l.mid(colon + 1).split(QLatin1Char(' '), Qt::SkipEmptyParts);
                if (c.size() >= 9) { rx += c.at(0).toULongLong(); tx += c.at(8).toULongLong(); }
            }
            f.close();
            if (m_netPrevRx > 0 && dtSec > 0.05) {
                const qreal dRx = rx >= m_netPrevRx ? rx - m_netPrevRx : 0;
                const qreal dTx = tx >= m_netPrevTx ? tx - m_netPrevTx : 0;
                m_netDownMbps = (dRx * 8.0 / 1e6) / dtSec;   // megabits/s
                m_netUpMbps = (dTx * 8.0 / 1e6) / dtSec;
            }
            m_netPrevRx = rx;
            m_netPrevTx = tx;
        }
    }
#endif

    m_statsPrevMs = nowMs;
    emit statsChanged();
}

void Bridge::probeGpu()
{
    if (m_gpuProbed)
        return;
    auto *proc = new QProcess(this);
    connect(proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            [this, proc](int code, QProcess::ExitStatus) {
        m_gpuProbed = true;
        if (code == 0) {
            const QString out = QString::fromUtf8(proc->readAllStandardOutput()).trimmed();
            // CSV: name, utilization.gpu [%], memory.used [MiB], memory.total [MiB]
            const QStringList row = out.split(QLatin1Char('\n')).value(0).split(QLatin1Char(','));
            if (row.size() >= 4) {
                m_gpuName = row.at(0).trimmed();
                m_gpuPercent = row.at(1).trimmed().toDouble();
                m_gpuMemUsedMb = row.at(2).trimmed().toDouble();
                m_gpuMemTotalMb = row.at(3).trimmed().toDouble();
                m_gpuPresent = true;
            }
        }
        emit statsChanged();
        proc->deleteLater();
        // Keep GPU fresh while present: re-probe every few stats ticks.
        if (m_gpuPresent) {
            m_gpuProbed = false;
            QTimer::singleShot(4500, this, &Bridge::probeGpu);
        }
    });
    proc->start(QStringLiteral("nvidia-smi"),
                {QStringLiteral("--query-gpu=name,utilization.gpu,memory.used,memory.total"),
                 QStringLiteral("--format=csv,noheader,nounits")});
}

namespace {

// The daemon's config root, resolved EXACTLY like jarvis::Config::configDir()
// (the sidebar deliberately does not link jarvis-core): JARVIS_CONFIG_DIR
// override for profile isolation (jarvis#76 item 15), else ~/.config/jarvis.
QString jarvisConfigDir()
{
    const QString override = qEnvironmentVariable("JARVIS_CONFIG_DIR");
    return override.isEmpty()
               ? QDir::homePath() + QStringLiteral("/.config/jarvis")
               : override;
}

// The profile's control port from config.toml [ports] control=N (default 8795).
// A hardcoded 8795 silently connected a second-profile sidebar to the WRONG
// daemon. Mirrors jarvis::Config::parseToml's [ports] handling.
int configuredControlPort()
{
    QFile f(jarvisConfigDir() + QStringLiteral("/config.toml"));
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return 8795;
    QString section;
    for (const QString &raw :
         QString::fromUtf8(f.readAll()).split(QLatin1Char('\n'))) {
        const QString line = raw.trimmed();
        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']'))) {
            section = line.mid(1, line.size() - 2).trimmed();
            continue;
        }
        if (section != QStringLiteral("ports") ||
            !line.startsWith(QStringLiteral("control")))
            continue;
        const int eq = line.indexOf(QLatin1Char('='));
        if (eq < 0)
            continue;
        bool ok = false;
        const int p = line.mid(eq + 1).trimmed().toInt(&ok);
        if (ok && p > 0 && p < 65536)
            return p;
    }
    return 8795;
}

} // namespace

QString Bridge::readControlToken()
{
    // MUST match the daemon's write path byte-for-byte. jarvisd writes the token via
    // jarvis::Config::controlTokenPath() == QDir::homePath()/.config/jarvis/control_token
    // on EVERY platform — the daemon does NOT use QStandardPaths. If we resolve the
    // path differently here the token is never found and the control-WS auth fails.
    //   * Linux: QStandardPaths::ConfigLocation == ~/.config, so the old code matched —
    //     EXCEPT when XDG_CONFIG_HOME was set (daemon ignores it → drift).
    //   * Windows: QStandardPaths::ConfigLocation == %APPDATA%\... which is a DIFFERENT
    //     directory than $HOME/.config → "control_token not found", the whole HUD stays
    //     offline, and setup re-runs every launch. Reading $HOME/.config fixes it.
    const QString path = jarvisConfigDir() + QStringLiteral("/control_token");

    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QString();
    QString tok = QString::fromUtf8(f.readAll()).trimmed();
    return tok;
}

QString Bridge::computeUseBearer()
{
    // The per-session computer-use engine inherits the tailnet bearer from
    // ~/.computer-use/config.yaml (key: bearer_token / token). We only need it to
    // poll GET /video/frame for the local preview. Parse leniently — it is a tiny
    // YAML file of "key: value" lines, so a regex-free line scan is enough and
    // avoids pulling in a YAML dependency.
    const QString path = QDir::homePath() + QStringLiteral("/.computer-use/config.yaml");
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QString();
    const QStringList lines = QString::fromUtf8(f.readAll()).split(QLatin1Char('\n'));
    for (const QString &raw : lines) {
        const QString line = raw.trimmed();
        for (const QString &key : { QStringLiteral("bearer_token"),
                                    QStringLiteral("bearer"),
                                    QStringLiteral("token") }) {
            if (line.startsWith(key + QLatin1Char(':'))) {
                QString val = line.mid(key.size() + 1).trimmed();
                if (val.startsWith(QLatin1Char('"')) && val.endsWith(QLatin1Char('"'))
                    && val.size() >= 2)
                    val = val.mid(1, val.size() - 2);
                if (val.startsWith(QLatin1Char('\'')) && val.endsWith(QLatin1Char('\''))
                    && val.size() >= 2)
                    val = val.mid(1, val.size() - 2);
                if (!val.isEmpty())
                    return val;
            }
        }
    }
    return QString();
}

QString Bridge::controlUrl()
{
    QUrl url;
    url.setScheme(QStringLiteral("ws"));
    url.setHost(QStringLiteral("127.0.0.1"));
    // Respect the profile's configured control port (config.toml [ports]) —
    // a second isolated daemon (JARVIS_CONFIG_DIR profile, jarvis#76 item 15)
    // binds elsewhere; a hardcoded 8795 silently connected to the WRONG daemon.
    url.setPort(configuredControlPort());
    url.setPath(QStringLiteral("/control/ws"));

    QUrlQuery q;
    q.addQueryItem(QStringLiteral("token"), readControlToken());
    url.setQuery(q);
    return url.toString();
}

void Bridge::setStatus(const QString &s)
{
    if (m_status == s)
        return;
    m_status = s;
    emit statusChanged();
}

void Bridge::connectToDaemon()
{
    if (m_connected) {
        return;
    }
    const QString tok = readControlToken();
    if (tok.isEmpty()) {
        setStatus(QStringLiteral("no token"));
        emit errorOccurred(QStringLiteral("control_token not found at ~/.config/jarvis/control_token"));
        // Still attempt connect; daemon may reject, which surfaces a clear error.
    }
    setStatus(QStringLiteral("connecting"));
    m_socket->open(QUrl(controlUrl()));
}

void Bridge::onConnected()
{
    m_connected = true;
    emit connectedChanged();
    setStatus(QStringLiteral("connected"));
    // Liveness check per Contract A.
    request(QStringLiteral("ping"), {});
    // Real-time phone events (jarvis#76 item 3): opt in so incoming_call /
    // call_message frames push to the overlay instead of it polling.
    request(QStringLiteral("phone.event.subscribe"),
            QVariantMap{{QStringLiteral("on"), true}});
    // Declare our (currently empty) session view so the daemon scopes event delivery
    // to us from the start — a foreign session's events are never sent here.
    syncSubscriptions();
}

void Bridge::syncSubscriptions()
{
    if (!m_connected)
        return;
    // The complete set of sessions this desktop renders: the current chat, the
    // co-worker (COMPUTER page), and the voice-mode session. Empty entries are
    // skipped, so a fresh chat with no session subscribes to nothing.
    QStringList ids;
    if (!m_sessionId.isEmpty())
        ids << m_sessionId;
    if (!m_coworkerSessionId.isEmpty() && !ids.contains(m_coworkerSessionId))
        ids << m_coworkerSessionId;
    if (!m_voiceSessionId.isEmpty() && !ids.contains(m_voiceSessionId))
        ids << m_voiceSessionId;
    QVariantMap params;
    params.insert(QStringLiteral("session_ids"), ids);
    request(QStringLiteral("session.subscribe"), params);
}

void Bridge::onDisconnected()
{
    const bool was = m_connected;
    m_connected = false;
    if (was)
        emit connectedChanged();
    setStatus(QStringLiteral("disconnected"));
}

void Bridge::onSocketError()
{
    setStatus(QStringLiteral("error"));
    emit errorOccurred(m_socket->errorString());
}

int Bridge::nextId()
{
    return ++m_idCounter;
}

void Bridge::send(const QString &method, const QVariantMap &params, int id)
{
    QJsonObject obj;
    obj.insert(QStringLiteral("v"), 1);
    obj.insert(QStringLiteral("id"), id);
    obj.insert(QStringLiteral("method"), method);
    obj.insert(QStringLiteral("params"), QJsonObject::fromVariantMap(params));

    const QByteArray payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
    if (m_socket->state() != QAbstractSocket::ConnectedState) {
        // Best-effort telemetry (viewer-lease heartbeats, pins) must NEVER spam
        // the chat with "dropped" errors during a reconnect — they're fire-and-
        // forget and the next heartbeat re-establishes them. Only surface drops
        // for methods the user actually issued.
        static const QSet<QString> kQuiet = {
            QStringLiteral("widget.viewing"),
            QStringLiteral("widget.pin"),
            QStringLiteral("widget.unpin")
        };
        if (!kQuiet.contains(method))
            emit errorOccurred(QStringLiteral("not connected: dropped ") + method);
        return;
    }
    m_socket->sendTextMessage(QString::fromUtf8(payload));
}

int Bridge::request(const QString &method, const QVariantMap &params, const QString &ctx)
{
    const int id = nextId();
    m_pending.insert(id, method);
    if (!ctx.isEmpty())
        m_pendingCtx.insert(id, ctx);
    send(method, params, id);
    return id;
}

void Bridge::createSession(const QString &profile, const QString &brain, const QString &model)
{
    QVariantMap params;
    params.insert(QStringLiteral("profile"), profile.isEmpty() ? QStringLiteral("coder") : profile);
    // Omit brain when unspecified so the daemon applies its configured default_brain
    // (from settings / config.toml) instead of the desktop hardcoding a value.
    if (!brain.isEmpty())
        params.insert(QStringLiteral("brain"), brain);
    if (!model.isEmpty())
        params.insert(QStringLiteral("model"), model);
    m_creatingSession = true;  // ignore our own session.opened echo until the reply
    request(QStringLiteral("session.create"), params);
}

void Bridge::startAgentChat(const QString &agent)
{
    if (agent.trimmed().isEmpty())
        return;
    QVariantMap params;
    // The daemon resolves the agent's brain/model/profile from its AGENT.md and
    // injects its system prompt; we pass only the agent name.
    params.insert(QStringLiteral("agent"), agent.trimmed());
    m_creatingSession = true;
    request(QStringLiteral("session.create"), params);
}

void Bridge::sendMessage(const QString &text)
{
    sendMessageWithImages(text, {});
}

void Bridge::sendMessageWithImages(const QString &text, const QVariantList &images)
{
    if (m_sessionId.isEmpty()) {
        // NO BUTTONS: the composer fires createSession() (async) right before this.
        // The session id hasn't arrived yet, so don't error — QUEUE the message and
        // let the session.create response flush it the moment the session is ready.
        // (Auto-creates the session + its computer-use desktop on the first turn.)
        m_pendingText = text;
        m_pendingImages = images;
        setStatus(QStringLiteral("starting session…"));
        return;
    }
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), m_sessionId);
    params.insert(QStringLiteral("text"), text);
    if (!images.isEmpty()) {
        // Strip the QML-only preview thumbnails — the daemon wants {mime,b64}.
        QVariantList wire;
        for (const QVariant &v : images) {
            const QVariantMap m = v.toMap();
            QVariantMap img;
            img.insert(QStringLiteral("mime"), m.value(QStringLiteral("mime")));
            img.insert(QStringLiteral("b64"), m.value(QStringLiteral("b64")));
            wire.append(img);
        }
        params.insert(QStringLiteral("images"), wire);
    }
    request(QStringLiteral("session.send"), params);
}

bool Bridge::clipboardHasImage() const
{
    const QClipboard *cb = QGuiApplication::clipboard();
    return cb && !cb->image().isNull();
}

QVariantMap Bridge::pasteImage() const
{
    QVariantMap out;
    out.insert(QStringLiteral("ok"), false);
    const QClipboard *cb = QGuiApplication::clipboard();
    if (!cb)
        return out;
    QImage img = cb->image();
    if (img.isNull())
        return out;
    // Same budget as the Android attach path: longest edge 1600, JPEG q82 —
    // plenty for the model, small enough to ship over the control WS.
    constexpr int kMaxEdge = 1600;
    if (img.width() > kMaxEdge || img.height() > kMaxEdge)
        img = img.scaled(kMaxEdge, kMaxEdge, Qt::KeepAspectRatio,
                         Qt::SmoothTransformation);
    QByteArray bytes;
    QBuffer buf(&bytes);
    buf.open(QIODevice::WriteOnly);
    if (!img.save(&buf, "JPEG", 82))
        return out;
    const QString b64 = QString::fromLatin1(bytes.toBase64());
    out.insert(QStringLiteral("ok"), true);
    out.insert(QStringLiteral("mime"), QStringLiteral("image/jpeg"));
    out.insert(QStringLiteral("b64"), b64);
    out.insert(QStringLiteral("preview"),
               QStringLiteral("data:image/jpeg;base64,") + b64);
    return out;
}

bool Bridge::supportsVision(const QString &brain, const QString &model) const
{
    // Client-side mirror of what each brain does with attachments: codex passes
    // --image (all its models are multimodal), claude reads the file with its
    // Read tool (all current claude models see images). The api brain builds a
    // vision content array for whatever model is configured, and the daemon's
    // ApiBrain never gates on model name — so most configured chat models
    // (including e.g. Ollama's llava, gpt-5.x, gemini, grok, pixtral, etc.) DO
    // accept images. Default to ALLOWING and only deny the model families we
    // KNOW are text/audio-only, so a drift here degrades to a harmless extra
    // notice (see JarvisPanel's pasteImageFromClipboard) instead of silently
    // blocking a working vision model.
    // TODO: source a real vision flag from model.list instead of this heuristic.
    if (brain == QStringLiteral("codex") || brain == QStringLiteral("claude"))
        return true;
    const QString m = model.toLower();
    const bool knownTextOnly =
        m.contains(QStringLiteral("embed")) || m.contains(QStringLiteral("whisper")) ||
        m.contains(QStringLiteral("tts")) || m.contains(QStringLiteral("dall-e")) ||
        m.contains(QStringLiteral("moderation")) ||
        m.startsWith(QStringLiteral("davinci")) || m.startsWith(QStringLiteral("babbage")) ||
        m.startsWith(QStringLiteral("gpt-3.5-turbo-instruct"));
    return !knownTextOnly;
}

void Bridge::cancelSession()
{
    if (m_sessionId.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), m_sessionId);
    request(QStringLiteral("session.cancel"), params);
}

void Bridge::respondApproval(const QString &approvalId, const QString &decision)
{
    if (m_sessionId.isEmpty()) {
        emit errorOccurred(QStringLiteral("no active session for approval response"));
        return;
    }
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), m_sessionId);
    params.insert(QStringLiteral("approval_id"), approvalId);
    params.insert(QStringLiteral("decision"), decision);
    request(QStringLiteral("approval.respond"), params);
}

void Bridge::listModels(const QString &brain)
{
    QVariantMap params;
    // Omit brain when unspecified so the daemon applies its configured default_brain.
    if (!brain.isEmpty())
        params.insert(QStringLiteral("brain"), brain);
    request(QStringLiteral("model.list"), params);
}

void Bridge::listVoices()
{
    request(QStringLiteral("voice.list_voices"), {});
}

// ---- Contract A v2 ---------------------------------------------------------

void Bridge::openSession(const QString &sessionId)
{
    if (sessionId.isEmpty())
        return;
    m_sessionId = sessionId;
    emit sessionIdChanged();
    syncSubscriptions();   // start receiving THIS session's events (and only it)
    setStatus(QStringLiteral("session ready"));
    emit sessionOpened(sessionId);
    // Load this session's history so the Chat page can replay it.
    m_openingSession = true;
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), sessionId);
    request(QStringLiteral("session.history"), params, sessionId);
}

void Bridge::deleteSession(const QString &sessionId)
{
    if (sessionId.isEmpty())
        return;
    // If we're deleting the session that's currently loaded, drop it locally so the
    // next send starts a fresh one (don't leave a dangling current session id).
    if (sessionId == m_sessionId)
        newSession();
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), sessionId);
    // Tag with the id so the response handler can emit sessionDeleted(id).
    request(QStringLiteral("session.delete"), params, sessionId);
}

void Bridge::newSession()
{
    // Forget the current session WITHOUT touching the daemon: the next createSession
    // (fired by the composer on first send) will spin up a brand-new one. Also drop
    // any queued first-turn text so it can't land in a future unrelated session.
    m_pendingText.clear();
    m_pendingImages.clear();
    if (!m_sessionId.isEmpty()) {
        m_sessionId.clear();
        emit sessionIdChanged();
    }
    // Back to a sessionless chat: re-declare our (now empty, unless a coworker/voice
    // session is still live) view so the daemon stops fanning the old session to us.
    syncSubscriptions();
    setStatus(QStringLiteral("ready"));
}

void Bridge::loadSettings()
{
    request(QStringLiteral("settings.get"), {});
}

void Bridge::saveSettings(const QVariantMap &patch)
{
    QVariantMap params;
    params.insert(QStringLiteral("patch"), patch);
    request(QStringLiteral("settings.set"), params);
}

void Bridge::checkForUpdates()
{
    request(QStringLiteral("update.check"), {});
}

void Bridge::applyUpdate()
{
    request(QStringLiteral("update.apply"), {});
}

QString Bridge::extensionPath() const
{
#ifdef Q_OS_WIN
    // Installed next to the app: %ProgramFiles%\Jarvis\extension
    return QDir::toNativeSeparators(
        QCoreApplication::applicationDirPath() + QStringLiteral("/extension"));
#else
    // Staged by packaging/install.sh
    return jarvis::dataDir() + QStringLiteral("/extension");
#endif
}

void Bridge::openExtensionsPage()
{
    // Launch a Chromium-family browser straight at chrome://extensions (xdg-open
    // can't route a chrome:// URL, so we exec the browser with it directly).
    static const QStringList cands = {
#ifdef Q_OS_WIN
        QStringLiteral("chrome"), QStringLiteral("msedge"), QStringLiteral("brave"),
#else
        QStringLiteral("google-chrome"), QStringLiteral("google-chrome-stable"),
        QStringLiteral("chromium"), QStringLiteral("chromium-browser"),
        QStringLiteral("brave-browser"), QStringLiteral("microsoft-edge"),
        QStringLiteral("msedge"),
#endif
    };
    for (const QString &c : cands) {
        const QString exe = QStandardPaths::findExecutable(c);
        if (!exe.isEmpty()) {
            QProcess::startDetached(exe, {QStringLiteral("chrome://extensions")});
            return;
        }
    }
    // No Chromium browser found — open the folder so the user can drag it in.
    openExtensionFolder();
}

void Bridge::openExtensionFolder()
{
    QDesktopServices::openUrl(QUrl::fromLocalFile(extensionPath()));
}

void Bridge::copyToClipboard(const QString &text)
{
    if (QClipboard *cb = QGuiApplication::clipboard())
        cb->setText(text);
}

void Bridge::setAgentMode(const QString &mode)
{
    QString m = mode;
    if (m != QStringLiteral("plan") && m != QStringLiteral("build"))
        m = QStringLiteral("coworker");
    if (m != m_agentMode) {
        m_agentMode = m;
        emit agentModeChanged();
    }
    // Persist via settings.set (round-trips to config.toml; applies to the preamble
    // of the next turn).
    QVariantMap patch;
    patch.insert(QStringLiteral("agent_mode"), m);
    saveSettings(patch);
}

// --- Trust policies (jarvis#71) ---------------------------------------------

void Bridge::policyList()
{
    request(QStringLiteral("policy.list"), {});
}

void Bridge::policyAdd(const QString &tool, const QString &app,
                       const QString &action, const QString &note)
{
    QVariantMap p;
    p.insert(QStringLiteral("tool"), tool);
    p.insert(QStringLiteral("app"), app);
    p.insert(QStringLiteral("action"), action);
    p.insert(QStringLiteral("note"), note);
    request(QStringLiteral("policy.add"), p);
}

void Bridge::policyUpdate(const QString &id, const QString &action)
{
    QVariantMap p;
    p.insert(QStringLiteral("id"), id);
    p.insert(QStringLiteral("action"), action);
    request(QStringLiteral("policy.update"), p);
}

void Bridge::policyRemove(const QString &id)
{
    QVariantMap p;
    p.insert(QStringLiteral("id"), id);
    request(QStringLiteral("policy.remove"), p);
}

void Bridge::policySetDefault(const QString &action)
{
    QVariantMap p;
    p.insert(QStringLiteral("action"), action);
    request(QStringLiteral("policy.set_default"), p);
}

void Bridge::policyTest(const QString &tool, const QString &app)
{
    QVariantMap p;
    p.insert(QStringLiteral("tool"), tool);
    p.insert(QStringLiteral("app"), app);
    request(QStringLiteral("policy.test"), p);
}

void Bridge::listMcp()
{
    request(QStringLiteral("mcp.list"), {});
}

void Bridge::addMcp(const QVariantMap &server)
{
    request(QStringLiteral("mcp.add"), server);
}

void Bridge::removeMcp(const QString &id)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("mcp.remove"), params);
}

void Bridge::setMcpEnabled(const QString &id, bool enabled)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    params.insert(QStringLiteral("enabled"), enabled);
    request(QStringLiteral("mcp.set_enabled"), params);
}

void Bridge::testMcp(const QString &id)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("mcp.test"), params, id);
}

void Bridge::mcpCliList()
{
    request(QStringLiteral("mcp.cli_list"), {});
}

void Bridge::mcpCliSetEnabled(const QString &brain, const QString &name, bool enabled)
{
    if (brain.isEmpty() || name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("brain"), brain);
    params.insert(QStringLiteral("name"), name);
    params.insert(QStringLiteral("enabled"), enabled);
    request(QStringLiteral("mcp.cli_set_enabled"), params);
}

void Bridge::connectorsList()
{
    request(QStringLiteral("connectors.list"), {});
}

void Bridge::connectorAdd(const QString &service, const QString &clientId,
                          const QString &clientSecret, const QString &refreshToken)
{
    if (service.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("service"), service);
    params.insert(QStringLiteral("client_id"), clientId);
    params.insert(QStringLiteral("client_secret"), clientSecret);
    params.insert(QStringLiteral("refresh_token"), refreshToken);
    request(QStringLiteral("connectors.add"), params);
}

void Bridge::loadPlugins()
{
    request(QStringLiteral("plugins.catalog"), {});
}

void Bridge::installPlugin(const QString &id)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("plugins.install"), params);
}

void Bridge::setPluginEnabled(const QString &id, bool enabled)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    params.insert(QStringLiteral("enabled"), enabled);
    request(QStringLiteral("plugins.set_enabled"), params);
}

void Bridge::removePlugin(const QString &id)
{
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("plugins.remove"), params);
}

void Bridge::listSessions()
{
    request(QStringLiteral("session.list"), {});
}

void Bridge::loadSessionHistory(const QString &sessionId)
{
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), sessionId);
    request(QStringLiteral("session.history"), params, sessionId);
}

void Bridge::loadReplay(const QString &sessionId)
{
    // Mission Control Replay (jarvis#66): fetch ANY session's full timeline for
    // scrubbing. Tagged so its reply is NOT gated to the active chat (unlike
    // loadSessionHistory) and KEEPS per-event ts for the timeline.
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), sessionId);
    request(QStringLiteral("session.history"), params,
            QStringLiteral("__replay__:") + sessionId);
}

// ---- Devices (pairing) -----------------------------------------------------

void Bridge::devicesPairStart()
{
    request(QStringLiteral("devices.pair_start"), {});
}

void Bridge::extensionPairStart()
{
    request(QStringLiteral("extension.pair_start"), {});
}

void Bridge::devicesList()
{
    request(QStringLiteral("devices.list"), {});
}

void Bridge::devicesRevoke(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("devices.revoke"), params);
}

// ---- 2FA + fingerprint cross-device unlock (LockGate) ----------------------

void Bridge::authRequest(const QString &origin)
{
    QVariantMap params;
    params.insert(QStringLiteral("origin"),
                  origin.isEmpty() ? QStringLiteral("desktop") : origin);
    request(QStringLiteral("auth.request"), params);
}

void Bridge::authStatus(const QString &challengeId)
{
    if (challengeId.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("challenge_id"), challengeId);
    request(QStringLiteral("auth.status"), params);
}

void Bridge::authDeny(const QString &challengeId)
{
    if (challengeId.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("challenge_id"), challengeId);
    request(QStringLiteral("auth.deny"), params);
}

void Bridge::verifyPin(const QString &challengeId, const QString &pin)
{
    QVariantMap params;
    params.insert(QStringLiteral("challenge_id"), challengeId);
    params.insert(QStringLiteral("pin"), pin);
    request(QStringLiteral("auth.verify_pin"), params, QStringLiteral("__pin__"));
}

// ---- Memory (Contract A v3) ------------------------------------------------

void Bridge::memoryList(int limit)
{
    QVariantMap params;
    if (limit > 0)
        params.insert(QStringLiteral("limit"), limit);
    request(QStringLiteral("memory.list"), params);
}

void Bridge::memorySearch(const QString &q)
{
    const QString query = q.trimmed();
    if (query.isEmpty()) {
        // Empty query is just a full-list refresh.
        memoryList();
        return;
    }
    QVariantMap params;
    params.insert(QStringLiteral("q"), query);
    // This is the memory-browser page's own search box — a human deliberately
    // searching their memory, not automatic LLM-context injection — so opt
    // in to seeing agent-scoped facts too (matches empty-query memoryList()).
    params.insert(QStringLiteral("include_agent_scoped"), true);
    request(QStringLiteral("memory.search"), params);
}

void Bridge::memoryAdd(const QString &text, const QStringList &tags)
{
    const QString body = text.trimmed();
    if (body.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("text"), body);
    if (!tags.isEmpty())
        params.insert(QStringLiteral("tags"), tags);
    request(QStringLiteral("memory.add"), params);
}

void Bridge::memoryRemove(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("memory.remove"), params);
}

void Bridge::memoryGraph(const QString &root, int depth)
{
    QVariantMap params;
    if (!root.isEmpty())
        params.insert(QStringLiteral("root"), root);
    params.insert(QStringLiteral("depth"), depth);
    request(QStringLiteral("memory.graph"), params);
}

void Bridge::memoryEntitiesList(int limit)
{
    QVariantMap params;
    if (limit > 0)
        params.insert(QStringLiteral("limit"), limit);
    request(QStringLiteral("memory.entities.list"), params);
}

void Bridge::memoryEntityGet(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("memory.entity.get"), params);
}

void Bridge::memoryLink(const QString &fromId, const QString &toId, const QString &relation)
{
    if (fromId.isEmpty() || toId.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("from"), fromId);
    params.insert(QStringLiteral("to"), toId);
    if (!relation.isEmpty())
        params.insert(QStringLiteral("relation"), relation);
    request(QStringLiteral("memory.link"), params);
}

// ---- Skills (Contract A v3, self-authoring) --------------------------------

void Bridge::skillsList()
{
    request(QStringLiteral("skills.list"), {});
}

void Bridge::skillPin(const QString &name, bool pinned)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    params.insert(QStringLiteral("pinned"), pinned);
    request(QStringLiteral("skills.pin"), params);
}

void Bridge::skillsListArchived()
{
    request(QStringLiteral("skills.list_archived"), {});
}

void Bridge::skillUnarchive(const QString &name)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    request(QStringLiteral("skills.unarchive"), params);
}

void Bridge::skillGet(const QString &name)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    request(QStringLiteral("skills.get"), params, name);
}

void Bridge::skillCreate(const QString &name, const QString &description,
                         const QString &body, const QString &group)
{
    const QString n = name.trimmed();
    if (n.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), n);
    params.insert(QStringLiteral("description"), description.trimmed());
    params.insert(QStringLiteral("body"), body);
    if (!group.trimmed().isEmpty())
        params.insert(QStringLiteral("group"), group.trimmed());
    request(QStringLiteral("skills.create"), params);
}

void Bridge::skillInvoke(const QString &name, const QString &args)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    if (!args.trimmed().isEmpty())
        params.insert(QStringLiteral("args"), args.trimmed());
    request(QStringLiteral("skills.invoke"), params, name);
}

void Bridge::skillRemove(const QString &name)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    request(QStringLiteral("skills.remove"), params);
}

void Bridge::skillsToday()
{
    request(QStringLiteral("skills.today"), {});
}

// ---- Agents (custom subagents) ---------------------------------------------

void Bridge::agentsList()
{
    request(QStringLiteral("agents.list"), {});
}

void Bridge::agentGet(const QString &name)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    request(QStringLiteral("agents.get"), params, name);
}

void Bridge::agentCreate(const QString &name, const QString &description,
                         const QString &whenToUse, const QString &systemPrompt,
                         const QString &brain, const QString &model,
                         const QString &profile)
{
    const QString n = name.trimmed();
    if (n.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), n);
    params.insert(QStringLiteral("description"), description.trimmed());
    params.insert(QStringLiteral("when_to_use"), whenToUse.trimmed());
    params.insert(QStringLiteral("system_prompt"), systemPrompt);
    if (!brain.trimmed().isEmpty())
        params.insert(QStringLiteral("brain"), brain.trimmed());
    if (!model.trimmed().isEmpty())
        params.insert(QStringLiteral("model"), model.trimmed());
    if (!profile.trimmed().isEmpty())
        params.insert(QStringLiteral("profile"), profile.trimmed());
    request(QStringLiteral("agents.create"), params);
}

void Bridge::agentRemove(const QString &name)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    request(QStringLiteral("agents.remove"), params);
}

void Bridge::agentDispatch(const QString &name, const QString &task)
{
    if (name.trimmed().isEmpty() || task.trimmed().isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("agent"), name.trimmed());
    params.insert(QStringLiteral("task"), task.trimmed());
    // Link the child to the session the user is currently viewing (if any), so
    // the SubAgentTree groups it under the right parent.
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("parent_session_id"), m_sessionId);
    request(QStringLiteral("agents.dispatch"), params);
}

// ---- Schedules (Contract A additions) --------------------------------------

void Bridge::scheduleList()
{
    request(QStringLiteral("schedule.list"), {});
}

void Bridge::scheduleCreate(const QVariantMap &spec)
{
    // Required: name + prompt + (cron | when). brain/model/profile/enabled optional.
    QVariantMap params = spec;
    if (params.value(QStringLiteral("name")).toString().trimmed().isEmpty()
        || params.value(QStringLiteral("prompt")).toString().trimmed().isEmpty()) {
        emit errorOccurred(QStringLiteral("schedule needs a name and a prompt"));
        return;
    }
    if (params.value(QStringLiteral("cron")).toString().trimmed().isEmpty()
        && params.value(QStringLiteral("when")).toString().trimmed().isEmpty()) {
        emit errorOccurred(QStringLiteral("schedule needs a cron or a 'when'"));
        return;
    }
    request(QStringLiteral("schedule.create"), params);
}

void Bridge::scheduleSetEnabled(const QString &id, bool enabled)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    params.insert(QStringLiteral("enabled"), enabled);
    request(QStringLiteral("schedule.set_enabled"), params);
}

void Bridge::scheduleRemove(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("schedule.remove"), params);
}

void Bridge::scheduleRunNow(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("schedule.run_now"), params);
}

// ---- Outpost: paired remote machines + gated exec/screenshot ---------------

void Bridge::outpostList()
{
    request(QStringLiteral("outpost.list"), {});
}

void Bridge::outpostPairStart()
{
    request(QStringLiteral("outpost.pair_start"), {});
}

void Bridge::outpostPairStatus(const QString &bootstrapId)
{
    const QString id = bootstrapId.trimmed();
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("bootstrap_id"), id);
    request(QStringLiteral("outpost.pair_status"), params);
}

void Bridge::outpostExec(const QString &machine, const QString &cmd)
{
    const QString m = machine.trimmed();
    const QString c = cmd.trimmed();
    if (m.isEmpty() || c.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("cmd"), c);
    // Tag the request with the machine so the response can label the output line.
    request(QStringLiteral("outpost.exec"), params, m);
}

void Bridge::outpostScreenshot(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    // Tag the request with the machine so the response can label the image.
    request(QStringLiteral("outpost.screenshot"), params, m);
}

void Bridge::outpostRevoke(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("outpost.revoke"), params, m);
}

void Bridge::outpostInstallWorkload(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("outpost.install_workload"), params, m);
}

// ---- Proxmox Workload Manager (per-machine, once installed) ---------------

namespace {
// Several proxmox.* requests pack "machine:id" (vmid/qid) into the request's
// ctx string so the reply can address the right row without a second
// round-trip (see proxmoxRestartVm/proxmoxVmProfile/proxmoxAnswer below) —
// one splitter shared by every dispatch site instead of six copies of the
// same lastIndexOf(':') dance.
QString splitMachineCtx(const QString &ctx, QString *rest)
{
    const int sep = ctx.lastIndexOf(QLatin1Char(':'));
    if (rest)
        *rest = sep >= 0 ? ctx.mid(sep + 1) : QString();
    return sep >= 0 ? ctx.left(sep) : ctx;
}
} // namespace

void Bridge::proxmoxStatus(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.status"), params, m);
}

void Bridge::proxmoxReport(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.report"), params, m);
}

void Bridge::proxmoxRestartVm(const QString &machine, int vmid)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("vmid"), vmid);
    // ctx packs both machine + vmid ("machine:vmid") so the response can
    // address the right row without a second round-trip.
    request(QStringLiteral("proxmox.restart_vm"), params,
            m + QStringLiteral(":") + QString::number(vmid));
}

void Bridge::proxmoxSetBlocklist(const QString &machine, const QVariantList &vmids)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("vmids"), vmids);
    request(QStringLiteral("proxmox.set_blocklist"), params, m);
}

void Bridge::proxmoxScout(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.scout"), params, m);
}

void Bridge::proxmoxScoutStatus(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.scout_status"), params, m);
}

void Bridge::proxmoxVmProfile(const QString &machine, int vmid)
{
    const QString m = machine.trimmed();
    if (m.isEmpty() || vmid <= 0)
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("vmid"), vmid);
    // ctx packs machine + vmid (same convention as proxmoxRestartVm).
    request(QStringLiteral("proxmox.vm_profile"), params,
            m + QStringLiteral(":") + QString::number(vmid));
}

void Bridge::proxmoxQuestions(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.questions"), params, m);
}

void Bridge::proxmoxAnswer(const QString &machine, const QString &qid,
                           const QString &answer)
{
    const QString m = machine.trimmed();
    if (m.isEmpty() || qid.trimmed().isEmpty() || answer.trimmed().isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("qid"), qid);
    params.insert(QStringLiteral("answer"), answer);
    // ctx packs machine + qid; qids never contain ':' so lastIndexOf is safe.
    request(QStringLiteral("proxmox.answer"), params,
            m + QStringLiteral(":") + qid);
}

void Bridge::proxmoxPingedList(const QString &machine)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    request(QStringLiteral("proxmox.pinged_list"), params, m);
}

void Bridge::proxmoxPingedAdd(const QString &machine, const QString &name,
                              const QString &action, int vmid,
                              const QString &condition, const QString &timeOfDay)
{
    const QString m = machine.trimmed();
    if (m.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("name"), name);
    params.insert(QStringLiteral("action"), action);
    params.insert(QStringLiteral("vmid"), vmid);
    params.insert(QStringLiteral("condition"), condition);
    params.insert(QStringLiteral("time"), timeOfDay);
    request(QStringLiteral("proxmox.pinged_add"), params, m);
}

void Bridge::proxmoxPingedRemove(const QString &machine, const QString &ruleId)
{
    const QString m = machine.trimmed();
    if (m.isEmpty() || ruleId.trimmed().isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("machine"), m);
    params.insert(QStringLiteral("rule_id"), ruleId);
    request(QStringLiteral("proxmox.pinged_remove"), params, m);
}

// ---- Audit log -------------------------------------------------------------

void Bridge::auditList(int limit)
{
    QVariantMap params;
    if (limit > 0)
        params.insert(QStringLiteral("limit"), limit);
    request(QStringLiteral("audit.list"), params);
}

// ---- Diff review actions ---------------------------------------------------

void Bridge::diffStage(const QString &path)
{
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    if (!path.isEmpty())
        params.insert(QStringLiteral("path"), path);
    request(QStringLiteral("diff.stage"), params, path);
}

void Bridge::diffRevert(const QString &path)
{
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    if (!path.isEmpty())
        params.insert(QStringLiteral("path"), path);
    request(QStringLiteral("diff.revert"), params, path);
}

void Bridge::diffCommit(const QString &message)
{
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    if (!message.trimmed().isEmpty())
        params.insert(QStringLiteral("message"), message.trimmed());
    request(QStringLiteral("diff.commit"), params, QStringLiteral("__commit__"));
}

void Bridge::diffOpenPr(const QString &title)
{
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    if (!title.trimmed().isEmpty())
        params.insert(QStringLiteral("title"), title.trimmed());
    request(QStringLiteral("diff.open_pr"), params, QStringLiteral("__pr__"));
}

// ---- Phone (Contract A phone.mcp proxy) ------------------------------------

void Bridge::phoneMcp(const QString &callId, const QString &name,
                      const QVariantMap &arguments)
{
    if (name.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("name"), name);
    if (!arguments.isEmpty())
        params.insert(QStringLiteral("arguments"), arguments);
    // Store callId as ctx so the reply routing in handleResponse can echo it back.
    request(QStringLiteral("phone.mcp"), params, callId);
}

// ---- Phone (Contract A phone.http proxy) -----------------------------------

void Bridge::phoneHttp(const QString &callId, const QString &method,
                       const QString &path, const QVariantMap &body)
{
    if (path.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("method"), method.isEmpty() ? QStringLiteral("GET") : method);
    params.insert(QStringLiteral("path"), path);
    if (!body.isEmpty())
        params.insert(QStringLiteral("body"), body);
    // Store callId as ctx so the reply routing in handleResponse can echo it back.
    request(QStringLiteral("phone.http"), params, callId);
}

// ---- Phone/Twilio config (Contract A phone.config, CONTROL channel) --------
// All three actions land back in handleResponse tagged with ctx = the action, so
// the reply can be routed to the right signal without sniffing the result shape.

void Bridge::phoneConfigGet()
{
    QVariantMap params;
    params.insert(QStringLiteral("action"), QStringLiteral("get"));
    request(QStringLiteral("phone.config"), params, QStringLiteral("get"));
}

void Bridge::phoneConfigSet(const QVariantMap &patch)
{
    // Callers must only include secret keys (twilio_account_sid / twilio_auth_token
    // / admin_token / device_token / agent_token) when the user typed a NEW value,
    // so an unchanged masked secret is never wiped. The daemon writes only the keys
    // present in the patch.
    QVariantMap params;
    params.insert(QStringLiteral("action"), QStringLiteral("set"));
    params.insert(QStringLiteral("patch"), patch);
    request(QStringLiteral("phone.config"), params, QStringLiteral("set"));
}

void Bridge::phoneConfigTest()
{
    QVariantMap params;
    params.insert(QStringLiteral("action"), QStringLiteral("test"));
    request(QStringLiteral("phone.config"), params, QStringLiteral("test"));
}

// ---- Notifications ---------------------------------------------------------

void Bridge::setNotificationsEnabled(bool enabled)
{
    if (m_notify == enabled) {
        // still emit once so an initial bind settles
        emit notificationsChanged();
        return;
    }
    m_notify = enabled;
    emit notificationsChanged();
    // Persist so the daemon's NotifyService honors the same flag.
    QVariantMap patch;
    QVariantMap n;
    n.insert(QStringLiteral("enabled"), enabled);
    patch.insert(QStringLiteral("notifications"), n);
    saveSettings(patch);
}

void Bridge::notify(const QString &title, const QString &body)
{
    if (!m_notify)
        return;
    if (!hasExecutable(QStringLiteral("notify-send")))
        return;
    QStringList args;
    args << QStringLiteral("-a") << QStringLiteral("Jarvis")
         << (title.isEmpty() ? QStringLiteral("Jarvis") : title)
         << body;
    QProcess::startDetached(QStringLiteral("notify-send"), args);
}

// ---- Voice dictation (pw-record -> voice.stt; voice.tts -> playback) --------

bool Bridge::hasExecutable(const QString &name)
{
    return !QStandardPaths::findExecutable(name).isEmpty();
}

bool Bridge::voiceAvailable() const
{
#ifdef Q_OS_WIN
    // Windows has no pw-record; a present default input device (WASAPI via Qt
    // Multimedia) is what makes the mic usable — gating on pw-record alone hid
    // the mic button on every Windows install. defaultAudioInput() (not
    // audioInputs()) so the button only shows when the capture paths' device
    // lookup will actually succeed.
    return !QMediaDevices::defaultAudioInput().isNull();
#else
    // Linux: PipeWire is the product target — pw-record IS the probe. Don't
    // consult QMediaDevices here: this runs inside QML `visible:` bindings at
    // UI load, and initializing the multimedia backend / enumerating devices on
    // an audio-less box (the CI container's FFmpeg backend) blew gui_selftest's
    // 30s budget.
    return hasExecutable(QStringLiteral("pw-record"));
#endif
}

void Bridge::setRecordingState(const QString &s)
{
    if (m_recordingState == s)
        return;
    m_recordingState = s;
    emit recordingStateChanged();
}

QString Bridge::recordWavPath() const
{
    QString base = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    if (base.isEmpty())
        base = QDir::tempPath();
    return base + QStringLiteral("/jarvis_dictate.wav");
}

void Bridge::voiceDictate(int seconds)
{
    if (m_recProc || m_dictSource) {
        emit errorOccurred(QStringLiteral("already recording"));
        return;
    }
    if (!voiceAvailable()) {
        emit errorOccurred(QStringLiteral("no microphone found; voice dictation unavailable"));
        return;
    }
    const int secs = (seconds > 0 && seconds <= 30) ? seconds : 6;

    if (!hasExecutable(QStringLiteral("pw-record"))) {
        // Qt Multimedia capture (Windows/WASAPI & other non-PipeWire boxes):
        // accumulate s16 mono 16k PCM, wrapped via pcmToWav() on stop.
        QAudioFormat fmt;
        fmt.setSampleRate(16000);
        fmt.setChannelCount(1);
        fmt.setSampleFormat(QAudioFormat::Int16);
        const QAudioDevice dev = QMediaDevices::defaultAudioInput();
        if (dev.isNull()) {
            emit errorOccurred(QStringLiteral("no audio input device"));
            return;
        }
        m_dictSource = new QAudioSource(dev, fmt, this);
        m_dictPcm.clear();
        m_dictIo = m_dictSource->start();
        if (!m_dictIo) {
            emit errorOccurred(QStringLiteral("failed to start audio capture"));
            m_dictSource->deleteLater();
            m_dictSource = nullptr;
            return;
        }
        connect(m_dictIo, &QIODevice::readyRead, this, [this]() {
            if (m_dictIo)
                m_dictPcm.append(m_dictIo->readAll());
        });
        m_recAutoStop = true;
        setRecordingState(QStringLiteral("recording"));
        // Capture the generation so a stale timer from an earlier recording
        // (stopped early, restarted within its window) can't truncate this one.
        QTimer::singleShot(secs * 1000, this, [this, gen = ++m_dictGen]() {
            if (m_dictSource && m_recAutoStop && gen == m_dictGen)
                voiceDictateStop();
        });
        return;
    }

    m_recPath = recordWavPath();
    QFile::remove(m_recPath);

    m_recProc = new QProcess(this);
    // pw-record writes a WAV; cap the capture so a forgotten recording self-stops.
    m_recAutoStop = true;
    QStringList args;
    // Mono 16k is plenty for speech and keeps the upload small.
    args << QStringLiteral("--rate") << QStringLiteral("16000")
         << QStringLiteral("--channels") << QStringLiteral("1")
         << m_recPath;
    connect(m_recProc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int, QProcess::ExitStatus) { finishDictation(); });
    setRecordingState(QStringLiteral("recording"));
    m_recProc->start(QStringLiteral("pw-record"), args);
    if (!m_recProc->waitForStarted(1500)) {
        emit errorOccurred(QStringLiteral("failed to start pw-record"));
        m_recProc->deleteLater();
        m_recProc = nullptr;
        setRecordingState(QStringLiteral("idle"));
        return;
    }
    // Auto-stop after `secs`; SIGTERM lets pw-record finalize the WAV header.
    QTimer::singleShot(secs * 1000, this, [this]() {
        if (m_recProc && m_recProc->state() != QProcess::NotRunning && m_recAutoStop)
            m_recProc->terminate();
    });
}

void Bridge::voiceDictateStop()
{
    if (m_dictSource) {
        // Qt Multimedia path: drain, wrap the PCM as WAV, transcribe.
        m_recAutoStop = false;
        if (m_dictIo)
            m_dictPcm.append(m_dictIo->readAll());
        m_dictSource->stop();
        m_dictSource->deleteLater();
        m_dictSource = nullptr;
        m_dictIo = nullptr;
        const QByteArray pcm = m_dictPcm;
        m_dictPcm.clear();
        if (pcm.size() < 1024) {   // an empty/aborted capture
            setRecordingState(QStringLiteral("idle"));
            return;
        }
        finishDictationWav(pcmToWav(pcm, 16000, 1));
        return;
    }
    if (m_recProc && m_recProc->state() != QProcess::NotRunning) {
        m_recAutoStop = false;
        m_recProc->terminate();   // finished() -> finishDictation()
    }
}

void Bridge::finishDictation()
{
    if (m_recProc) {
        m_recProc->deleteLater();
        m_recProc = nullptr;
    }
    QFile f(m_recPath);
    if (!f.open(QIODevice::ReadOnly)) {
        setRecordingState(QStringLiteral("idle"));
        emit errorOccurred(QStringLiteral("no audio captured"));
        return;
    }
    const QByteArray wav = f.readAll();
    f.close();
    if (wav.size() < 256) {   // an empty/aborted capture
        setRecordingState(QStringLiteral("idle"));
        return;
    }
    finishDictationWav(wav);
}

void Bridge::finishDictationWav(const QByteArray &wav)
{
    setRecordingState(QStringLiteral("transcribing"));
    QVariantMap params;
    params.insert(QStringLiteral("audio_b64"), QString::fromLatin1(wav.toBase64()));
    params.insert(QStringLiteral("mime"), QStringLiteral("audio/wav"));
    if (!m_sttProvider.isEmpty())
        params.insert(QStringLiteral("provider"), m_sttProvider);
    request(QStringLiteral("voice.stt"), params);
}

// ---- Named voice library (record/upload, name, set-default) ----------------

void Bridge::setVoiceCloneState(const QString &s)
{
    if (m_voiceCloneState == s)
        return;
    m_voiceCloneState = s;
    emit voiceCloneStateChanged();
}

void Bridge::recordVoiceClone(int seconds)
{
    if (m_cloneRecProc || m_cloneSource) {
        emit errorOccurred(QStringLiteral("already recording a voice clip"));
        return;
    }
    if (!voiceAvailable()) {
        emit errorOccurred(
            QStringLiteral("no microphone found; can't record a voice clip"));
        return;
    }
    const int secs = (seconds > 0 && seconds <= 60) ? seconds : 20;

    if (!hasExecutable(QStringLiteral("pw-record"))) {
        // Qt Multimedia capture (Windows/WASAPI & other non-PipeWire boxes).
        QAudioFormat fmt;
        fmt.setSampleRate(24000);
        fmt.setChannelCount(1);
        fmt.setSampleFormat(QAudioFormat::Int16);
        const QAudioDevice dev = QMediaDevices::defaultAudioInput();
        if (dev.isNull()) {
            emit errorOccurred(QStringLiteral("no audio input device"));
            return;
        }
        m_cloneSource = new QAudioSource(dev, fmt, this);
        m_clonePcm.clear();
        m_cloneIo = m_cloneSource->start();
        if (!m_cloneIo) {
            emit errorOccurred(QStringLiteral("failed to start audio capture"));
            m_cloneSource->deleteLater();
            m_cloneSource = nullptr;
            return;
        }
        connect(m_cloneIo, &QIODevice::readyRead, this, [this]() {
            if (m_cloneIo)
                m_clonePcm.append(m_cloneIo->readAll());
        });
        m_cloneAutoStop = true;
        setVoiceCloneState(QStringLiteral("recording"));
        // Same stale-timer guard as voiceDictate().
        QTimer::singleShot(secs * 1000, this, [this, gen = ++m_cloneGen]() {
            if (m_cloneSource && m_cloneAutoStop && gen == m_cloneGen)
                stopVoiceCloneRecording();
        });
        return;
    }

    QString base = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    if (base.isEmpty())
        base = QDir::tempPath();
    m_cloneRecPath = base + QStringLiteral("/jarvis_voice_clip.wav");
    QFile::remove(m_cloneRecPath);

    m_cloneRecProc = new QProcess(this);
    m_cloneAutoStop = true;
    QStringList args;
    // Mono 24k is a clean reference for cloning (the server re-cleans on save).
    args << QStringLiteral("--rate") << QStringLiteral("24000")
         << QStringLiteral("--channels") << QStringLiteral("1") << m_cloneRecPath;
    connect(m_cloneRecProc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int, QProcess::ExitStatus) { finishCloneRecording(); });
    setVoiceCloneState(QStringLiteral("recording"));
    m_cloneRecProc->start(QStringLiteral("pw-record"), args);
    if (!m_cloneRecProc->waitForStarted(1500)) {
        emit errorOccurred(QStringLiteral("failed to start pw-record"));
        m_cloneRecProc->deleteLater();
        m_cloneRecProc = nullptr;
        setVoiceCloneState(QStringLiteral("idle"));
        return;
    }
    QTimer::singleShot(secs * 1000, this, [this]() {
        if (m_cloneRecProc && m_cloneRecProc->state() != QProcess::NotRunning && m_cloneAutoStop)
            m_cloneRecProc->terminate();
    });
}

void Bridge::stopVoiceCloneRecording()
{
    if (m_cloneSource) {
        // Qt Multimedia path: drain, wrap the PCM as WAV, keep as the clip.
        m_cloneAutoStop = false;
        if (m_cloneIo)
            m_clonePcm.append(m_cloneIo->readAll());
        m_cloneSource->stop();
        m_cloneSource->deleteLater();
        m_cloneSource = nullptr;
        m_cloneIo = nullptr;
        const QByteArray pcm = m_clonePcm;
        m_clonePcm.clear();
        finishCloneWav(pcmToWav(pcm, 24000, 1));
        return;
    }
    if (m_cloneRecProc && m_cloneRecProc->state() != QProcess::NotRunning) {
        m_cloneAutoStop = false;
        m_cloneRecProc->terminate(); // finished() -> finishCloneRecording()
    }
}

void Bridge::finishCloneRecording()
{
    if (m_cloneRecProc) {
        m_cloneRecProc->deleteLater();
        m_cloneRecProc = nullptr;
    }
    QFile f(m_cloneRecPath);
    if (!f.open(QIODevice::ReadOnly)) {
        setVoiceCloneState(QStringLiteral("idle"));
        emit errorOccurred(QStringLiteral("no audio captured"));
        return;
    }
    const QByteArray wav = f.readAll();
    f.close();
    finishCloneWav(wav);
}

void Bridge::finishCloneWav(const QByteArray &wav)
{
    m_voiceClipBytes = wav;
    m_voiceClipFormat = QStringLiteral("wav");
    m_voiceClipSource = QStringLiteral("record");
    setVoiceCloneState(QStringLiteral("idle"));
    if (m_voiceClipBytes.size() < 256) { // empty/aborted capture
        m_voiceClipBytes.clear();
        emit errorOccurred(QStringLiteral("recording too short"));
        return;
    }
    emit voiceClipCaptured(int(m_voiceClipBytes.size()), m_voiceClipFormat);
}

void Bridge::loadVoiceClipFromFile(const QString &fileUrl)
{
    QString path = fileUrl;
    if (path.startsWith(QStringLiteral("file://")))
        path = QUrl(fileUrl).toLocalFile();
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        emit errorOccurred(QStringLiteral("can't read that audio file"));
        return;
    }
    m_voiceClipBytes = f.readAll();
    f.close();
    const QString ext = QFileInfo(path).suffix().toLower();
    m_voiceClipFormat = ext.isEmpty() ? QStringLiteral("wav") : ext;
    m_voiceClipSource = QStringLiteral("upload");
    if (m_voiceClipBytes.isEmpty()) {
        emit errorOccurred(QStringLiteral("that audio file is empty"));
        return;
    }
    emit voiceClipCaptured(int(m_voiceClipBytes.size()), m_voiceClipFormat);
}

void Bridge::saveVoiceClone(const QString &name, bool clean)
{
    if (name.trimmed().isEmpty()) {
        emit voiceCloneResult(false, QStringLiteral("Give the voice a name first."));
        return;
    }
    if (m_voiceClipBytes.isEmpty()) {
        emit voiceCloneResult(false, QStringLiteral("Record or upload a clip first."));
        return;
    }
    setVoiceCloneState(QStringLiteral("saving"));
    QVariantMap params;
    params.insert(QStringLiteral("name"), name.trimmed());
    params.insert(QStringLiteral("audio_b64"), QString::fromLatin1(m_voiceClipBytes.toBase64()));
    params.insert(QStringLiteral("format"),
                  m_voiceClipFormat.isEmpty() ? QStringLiteral("wav") : m_voiceClipFormat);
    params.insert(QStringLiteral("clean"), clean);
    params.insert(QStringLiteral("source"), m_voiceClipSource);
    request(QStringLiteral("voice.create_clone"), params);
}

void Bridge::setDefaultVoice(const QString &voiceId)
{
    if (voiceId.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("voice"), voiceId);
    request(QStringLiteral("voice.set_default"), params);
}

void Bridge::deleteVoiceClone(const QString &id)
{
    if (id.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    request(QStringLiteral("voice.delete_clone"), params);
}

void Bridge::renameVoiceClone(const QString &id, const QString &name)
{
    if (id.isEmpty() || name.trimmed().isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("id"), id);
    params.insert(QStringLiteral("name"), name.trimmed());
    request(QStringLiteral("voice.rename_clone"), params);
}

void Bridge::previewVoice(const QString &voiceId)
{
    QVariantMap params;
    params.insert(QStringLiteral("voice"), voiceId);
    request(QStringLiteral("voice.preview_clone"), params);
}

void Bridge::voiceSpeak(const QString &text)
{
    // Chat "Speak replies" path: enqueue and let pumpTtsRequests serialize so
    // replies never overlap or jump order (one request in flight at a time).
    if (text.trimmed().isEmpty())
        return;
    m_ttsReqQueue.append(TtsReq{text.trimmed(), /*voiceMode=*/false});
    pumpTtsRequests();
}

// ---- Voice MODE (QtMultimedia capture + playback, orb state) ----------------

void Bridge::setVoiceState(const QString &s)
{
    if (m_voiceState == s)
        return;
    m_voiceState = s;
    emit voiceStateChanged();
}

void Bridge::ensureVoiceSession()
{
    // A dedicated coworker session so the model can use the computer-use tools
    // (e.g. real_screen screenshot for "what's on my screen"). If we already have
    // a current session, adopt it as the voice session; otherwise create one.
    if (!m_voiceSessionId.isEmpty())
        return;
    if (!m_sessionId.isEmpty()) {
        m_voiceSessionId = m_sessionId;
        syncSubscriptions();   // keep the voice session subscribed if chat moves on
        return;
    }
    // No session yet: spin one up with the voice-mode brain/model selection
    // (empty = daemon defaults). createSession() stashes the id on the
    // session.create reply (m_sessionId); we adopt it lazily when it arrives.
    createSession(QStringLiteral("coworker"), m_voiceBrain, m_voiceModel);
}

void Bridge::resetVoiceSession()
{
    // Drop the current voice session so the NEXT startConversation creates a fresh
    // one with the currently-selected brain/model.
    m_voiceSessionId.clear();
    newSession();
}

QByteArray Bridge::pcmToWav(const QByteArray &pcm, int sampleRate, int channels) const
{
    // Prepend a 44-byte canonical PCM WAV header (RIFF/WAVE, 16-bit, little-endian)
    // to the raw int16 sample data so the daemon's voice.stt sees a valid WAV.
    const int bitsPerSample = 16;
    const int byteRate = sampleRate * channels * (bitsPerSample / 8);
    const int blockAlign = channels * (bitsPerSample / 8);
    const quint32 dataSize = static_cast<quint32>(pcm.size());
    const quint32 chunkSize = 36 + dataSize;

    QByteArray hdr;
    QBuffer buf(&hdr);
    buf.open(QIODevice::WriteOnly);
    QDataStream ds(&buf);
    ds.setByteOrder(QDataStream::LittleEndian);

    auto wr4 = [&](const char *tag) { buf.write(tag, 4); };
    wr4("RIFF");
    ds << chunkSize;
    wr4("WAVE");
    wr4("fmt ");
    ds << quint32(16);                       // PCM fmt chunk size
    ds << quint16(1);                        // audio format = PCM
    ds << quint16(channels);
    ds << quint32(sampleRate);
    ds << quint32(byteRate);
    ds << quint16(blockAlign);
    ds << quint16(bitsPerSample);
    wr4("data");
    ds << dataSize;
    buf.close();

    QByteArray out = hdr;
    out.append(pcm);
    return out;
}

void Bridge::startListening()
{
    if (m_listening)
        return;
    // Make sure a session exists so the transcribed turn has somewhere to land.
    ensureVoiceSession();

    QAudioFormat fmt;
    fmt.setSampleRate(16000);
    fmt.setChannelCount(1);
    fmt.setSampleFormat(QAudioFormat::Int16);

    const QAudioDevice dev = QMediaDevices::defaultAudioInput();
    if (dev.isNull()) {
        emit errorOccurred(QStringLiteral("no audio input device for voice mode"));
        return;
    }
    if (m_audioSource) {
        m_audioSource->deleteLater();
        m_audioSource = nullptr;
        m_voiceIo = nullptr;
    }
    m_audioSource = new QAudioSource(dev, fmt, this);
    m_voicePcm.clear();
    // Pull mode: read available bytes on readyRead into the accumulator buffer.
    m_voiceIo = m_audioSource->start();
    if (!m_voiceIo) {
        emit errorOccurred(QStringLiteral("failed to start audio capture"));
        m_audioSource->deleteLater();
        m_audioSource = nullptr;
        return;
    }
    connect(m_voiceIo, &QIODevice::readyRead, this, [this]() {
        if (m_voiceIo)
            m_voicePcm.append(m_voiceIo->readAll());
    });
    m_listening = true;
    setVoiceState(QStringLiteral("listening"));
}

void Bridge::stopListening()
{
    if (!m_listening)
        return;
    m_listening = false;
    if (m_audioSource) {
        // Drain any final buffered samples before stopping.
        if (m_voiceIo)
            m_voicePcm.append(m_voiceIo->readAll());
        m_audioSource->stop();
        m_audioSource->deleteLater();
        m_audioSource = nullptr;
        m_voiceIo = nullptr;
    }
    if (m_voicePcm.size() < 1024) {   // too short — likely a stray tap
        setVoiceState(QStringLiteral("idle"));
        m_voicePcm.clear();
        return;
    }
    const QByteArray wav = pcmToWav(m_voicePcm, 16000, 1);
    m_voicePcm.clear();

    setVoiceState(QStringLiteral("thinking"));
    m_voiceModeStt = true;
    QVariantMap params;
    params.insert(QStringLiteral("audio_b64"), QString::fromLatin1(wav.toBase64()));
    params.insert(QStringLiteral("mime"), QStringLiteral("audio/wav"));
    if (!m_sttProvider.isEmpty())
        params.insert(QStringLiteral("provider"), m_sttProvider);
    request(QStringLiteral("voice.stt"), params, QStringLiteral("__voicemode__"));
}

// ---- Hands-free conversation (continuous listen, energy VAD) ----------------

void Bridge::startConversation()
{
    if (m_handsFree)
        return;
    ensureVoiceSession();

    // Capture via pw-record streaming raw s16 mono 16k to stdout — the proven
    // PipeWire path the chat mic uses (Qt's QAudioSource does not capture on this
    // PipeWire setup, which is why voice mode "heard nothing" while chat dictation
    // worked). We strip the leading 44-byte WAV header, then feed PCM to the VAD.
    // Where pw-record doesn't exist (Windows/WASAPI, non-PipeWire boxes) we
    // capture the same s16 mono 16k stream with Qt Multimedia instead — raw PCM,
    // no header to skip — and feed it to the SAME VAD.
    if (!voiceAvailable()) {
        emit errorOccurred(QStringLiteral("no microphone found; voice mode unavailable"));
        return;
    }
    if (m_voiceProc) {
        m_voiceProc->kill();
        m_voiceProc->deleteLater();
        m_voiceProc = nullptr;
    }
    m_voicePcm.clear();
    if (!hasExecutable(QStringLiteral("pw-record"))) {
        QAudioFormat fmt;
        fmt.setSampleRate(16000);
        fmt.setChannelCount(1);
        fmt.setSampleFormat(QAudioFormat::Int16);
        const QAudioDevice dev = QMediaDevices::defaultAudioInput();
        if (dev.isNull()) {
            emit errorOccurred(QStringLiteral("no audio input device for voice mode"));
            return;
        }
        if (m_audioSource) {
            m_audioSource->deleteLater();
            m_audioSource = nullptr;
            m_voiceIo = nullptr;
        }
        m_audioSource = new QAudioSource(dev, fmt, this);
        m_voiceIo = m_audioSource->start();
        if (!m_voiceIo) {
            emit errorOccurred(QStringLiteral("failed to start audio capture for voice mode"));
            m_audioSource->deleteLater();
            m_audioSource = nullptr;
            return;
        }
        connect(m_voiceIo, &QIODevice::readyRead, this, [this]() {
            if (!m_voiceIo)
                return;
            const QByteArray chunk = m_voiceIo->readAll();
            if (!chunk.isEmpty())
                handsFreeFeed(chunk);
        });
    } else {
        m_pwHeaderSkip = 44;
        m_voiceProc = new QProcess(this);
        connect(m_voiceProc, &QProcess::readyReadStandardOutput, this, [this]() {
            if (!m_voiceProc)
                return;
            QByteArray chunk = m_voiceProc->readAllStandardOutput();
            if (m_pwHeaderSkip > 0) {
                const int drop = qMin(m_pwHeaderSkip, int(chunk.size()));
                chunk.remove(0, drop);
                m_pwHeaderSkip -= drop;
            }
            if (!chunk.isEmpty())
                handsFreeFeed(chunk);
        });
        QStringList args;
        args << QStringLiteral("--rate") << QStringLiteral("16000")
             << QStringLiteral("--channels") << QStringLiteral("1")
             << QStringLiteral("--format") << QStringLiteral("s16")
             << QStringLiteral("-");  // stream to stdout
        m_voiceProc->start(QStringLiteral("pw-record"), args);
        if (!m_voiceProc->waitForStarted(1500)) {
            emit errorOccurred(QStringLiteral("failed to start pw-record for voice mode"));
            m_voiceProc->deleteLater();
            m_voiceProc = nullptr;
            return;
        }
    }
    m_handsFree = true;
    m_vadSpeech = false;
    m_vadPaused = false;
    m_vadSilenceBytes = 0;
    m_vadSpeechBytes = 0;
    if (!m_vadWatchdog) {
        m_vadWatchdog = new QTimer(this);
        m_vadWatchdog->setSingleShot(true);
        connect(m_vadWatchdog, &QTimer::timeout, this, [this]() {
            // No TTS within the window (silent / tool-only turn) — listen again.
            if (m_handsFree && m_vadPaused)
                resumeListening();
        });
    }
    emit handsFreeChanged();
    setVoiceState(QStringLiteral("listening"));
}

void Bridge::stopConversation()
{
    if (!m_handsFree)
        return;
    m_handsFree = false;
    m_vadSpeech = false;
    m_vadPaused = false;
    if (m_vadWatchdog)
        m_vadWatchdog->stop();
    if (m_voiceProc) {
        m_voiceProc->kill();
        m_voiceProc->deleteLater();
        m_voiceProc = nullptr;
    }
    if (m_audioSource) {  // Qt Multimedia capture (the no-pw-record path)
        m_audioSource->stop();
        m_audioSource->deleteLater();
        m_audioSource = nullptr;
        m_voiceIo = nullptr;
    }
    // Ending the conversation (Space / leaving the page) is a barge-in: drop any
    // queued utterances AND pending requests, and silence the player so Jarvis
    // doesn't keep talking.
    m_ttsQueue.clear();
    m_ttsReqQueue.clear();
    m_ttsReqInFlight = false;
    m_ttsPlaying = false;
    if (m_ttsPlayer)
        m_ttsPlayer->stop();
    m_voicePcm.clear();
    if (m_voiceLevel != 0.0) {
        m_voiceLevel = 0.0;
        emit voiceLevelChanged();
    }
    emit handsFreeChanged();
    setVoiceState(QStringLiteral("idle"));
}

void Bridge::resumeListening()
{
    if (!m_handsFree)
        return;
    if (m_vadWatchdog)
        m_vadWatchdog->stop();
    m_voicePcm.clear();
    m_vadSpeech = false;
    m_vadPaused = false;
    m_vadSilenceBytes = 0;
    m_vadSpeechBytes = 0;
    setVoiceState(QStringLiteral("listening"));
}

void Bridge::handsFreeFeed(const QByteArray &chunk)
{
    // Drop audio while parked (model thinking/speaking) so we never capture Jarvis's
    // own TTS — the chunk was already drained from the device by the caller.
    if (!m_handsFree || m_vadPaused || chunk.isEmpty())
        return;

    // RMS energy over the int16 mono samples — stable (a single transient spikes
    // PEAK and broke silence detection). Calibrated to the DMIC noise floor (~450
    // rms at the gain we set): speech sits well above it, so the END of a sentence
    // is detected in ~0.5s instead of waiting out the max-utterance cap (that was
    // the 30s+ "it took forever to hear me" delay).
    const qint16 *samples = reinterpret_cast<const qint16 *>(chunk.constData());
    const int n = chunk.size() / 2;
    double sumSq = 0.0;
    for (int i = 0; i < n; ++i) {
        const double a = samples[i];
        sumSq += a * a;
    }
    const int rms = n > 0 ? int(qSqrt(sumSq / n)) : 0;

    // Publish the live input level (0..1) so the orb reacts to the user's voice.
    const qreal lvl = qMin(1.0, double(rms) / 7000.0);
    if (qAbs(lvl - m_voiceLevel) > 0.04) {
        m_voiceLevel = lvl;
        emit voiceLevelChanged();
    }

    static const int kSpeechRms = 1400;             // onset (noise floor ~450)
    static const int kSilenceRms = 800;             // below this => silence
    static const qint64 kSilenceBytes = 16000;      // ~0.5s trailing silence => end
    static const qint64 kMinSpeechBytes = 6400;     // ~0.2s voiced => real utterance
    static const qint64 kPrerollBytes = 6400;       // keep ~0.2s before speech starts
    static const qint64 kMaxUtterBytes = 16000 * 2 * 15; // 15s hard cap

    m_voicePcm.append(chunk);

    if (rms >= kSpeechRms) {
        m_vadSpeech = true;
        m_vadSilenceBytes = 0;
        m_vadSpeechBytes += chunk.size();
        if (m_voiceState != QStringLiteral("listening"))
            setVoiceState(QStringLiteral("listening"));
    } else if (m_vadSpeech) {
        if (rms < kSilenceRms)
            m_vadSilenceBytes += chunk.size();   // genuine silence — counts toward end
        else
            m_vadSilenceBytes = 0;               // mid level — still talking
    } else if (m_voicePcm.size() > kPrerollBytes) {
        // Pre-speech: keep only a short pre-roll so silence doesn't bloat the buffer.
        m_voicePcm = m_voicePcm.right(kPrerollBytes);
    }

    const bool endOfUtterance = m_vadSpeech &&
        m_vadSpeechBytes >= kMinSpeechBytes && m_vadSilenceBytes >= kSilenceBytes;
    const bool tooLong = m_vadSpeech && m_voicePcm.size() >= kMaxUtterBytes;
    if (!endOfUtterance && !tooLong)
        return;

    const QByteArray wav = pcmToWav(m_voicePcm, 16000, 1);
    m_voicePcm.clear();
    m_vadSpeech = false;
    m_vadSilenceBytes = 0;
    m_vadSpeechBytes = 0;
    m_vadPaused = true;                  // park capture until the reply is spoken
    setVoiceState(QStringLiteral("thinking"));
    m_voiceModeStt = true;
    QVariantMap params;
    params.insert(QStringLiteral("audio_b64"), QString::fromLatin1(wav.toBase64()));
    params.insert(QStringLiteral("mime"), QStringLiteral("audio/wav"));
    if (!m_sttProvider.isEmpty())
        params.insert(QStringLiteral("provider"), m_sttProvider);
    request(QStringLiteral("voice.stt"), params, QStringLiteral("__voicemode__"));
    if (m_vadWatchdog)
        m_vadWatchdog->start(20000);     // resume if no TTS arrives within 20s
}

void Bridge::speak(const QString &text)
{
    // Voice-mode path: enqueue and serialize. One assistant turn arrives as
    // several `message` events; queuing the REQUESTS (one in flight at a time)
    // guarantees their audio is appended — and so played — in strict order, and
    // the single shared player guarantees no two clips ever overlap.
    if (text.trimmed().isEmpty())
        return;
    m_ttsReqQueue.append(TtsReq{text.trimmed(), /*voiceMode=*/true});
    pumpTtsRequests();
}

void Bridge::pumpTtsRequests()
{
    // Send the next queued TTS request only when none is in flight, so responses
    // (and thus the appended audio clips) arrive in strict request order.
    if (m_ttsReqInFlight || m_ttsReqQueue.isEmpty())
        return;
    const TtsReq req = m_ttsReqQueue.takeFirst();
    m_ttsReqInFlight = true;
    m_ttsRequested = true;
    QVariantMap params;
    params.insert(QStringLiteral("text"), req.text);
    if (req.voiceMode && !m_ttsVoice.isEmpty())
        params.insert(QStringLiteral("voice"), m_ttsVoice);
    if (!m_ttsProvider.isEmpty())
        params.insert(QStringLiteral("provider"), m_ttsProvider);
    params.insert(QStringLiteral("format"), QStringLiteral("mp3"));
    // Voice mode tags __voicemode__ so the reply drives the orb + hands-free
    // resume; the chat "Speak replies" path uses no ctx.
    request(QStringLiteral("voice.tts"), params,
            req.voiceMode ? QStringLiteral("__voicemode__") : QString());
}

// Resolve a stored output-sink id to a QAudioDevice (empty/unknown => default).
static QAudioDevice resolveTtsOutput(const QByteArray &id)
{
    if (id.isEmpty())
        return QMediaDevices::defaultAudioOutput();
    const auto devs = QMediaDevices::audioOutputs();
    for (const QAudioDevice &d : devs)
        if (d.id() == id)
            return d;
    return QMediaDevices::defaultAudioOutput();
}

QVariantList Bridge::audioOutputs() const
{
    QVariantList out;
    const QByteArray defId = QMediaDevices::defaultAudioOutput().id();
    const auto devs = QMediaDevices::audioOutputs();
    for (int i = 0; i < devs.size(); ++i) {
        QVariantMap m;
        m.insert(QStringLiteral("index"), i);
        m.insert(QStringLiteral("name"), devs[i].description());
        m.insert(QStringLiteral("isDefault"), devs[i].id() == defId);
        out.append(m);
    }
    return out;
}

void Bridge::setTtsOutput(int index)
{
    const auto devs = QMediaDevices::audioOutputs();
    m_ttsDeviceId = (index >= 0 && index < devs.size()) ? devs[index].id() : QByteArray();
    // Apply live if a player already exists; otherwise it's used on next creation.
    if (m_ttsOutput)
        m_ttsOutput->setDevice(resolveTtsOutput(m_ttsDeviceId));
}

void Bridge::ensureTtsPlayer()
{
    if (m_ttsPlayer)
        return;
    m_ttsPlayer = new QMediaPlayer(this);
    m_ttsOutput = new QAudioOutput(resolveTtsOutput(m_ttsDeviceId), this);
    m_ttsOutput->setVolume(1.0);
    m_ttsPlayer->setAudioOutput(m_ttsOutput);
    // Surface playback failures (missing codec/route) instead of silent no-sound.
    // A clip that fails to decode would never reach EndOfMedia, so the queue would
    // stall — drop the whole pending reply and recover (resume listening / idle).
    connect(m_ttsPlayer, &QMediaPlayer::errorOccurred, this,
            [this](QMediaPlayer::Error err, const QString &errStr) {
        if (err == QMediaPlayer::NoError)
            return;
        qWarning("Bridge: TTS playback error %d: %s", int(err), qPrintable(errStr));
        m_ttsQueue.clear();
        m_ttsPlaying = false;
        emit voiceSpeaking(false);
        if (m_handsFree)
            resumeListening();
        else if (m_voiceState == QStringLiteral("speaking"))
            setVoiceState(QStringLiteral("idle"));
    });
    // Advance the queue when a clip plays to its natural END. We key off
    // EndOfMedia (not StoppedState) so that swapping in the next clip's source —
    // which transiently passes through Stopped — never looks like "done speaking".
    connect(m_ttsPlayer, &QMediaPlayer::mediaStatusChanged, this,
            [this](QMediaPlayer::MediaStatus st) {
        if (st == QMediaPlayer::EndOfMedia)
            playNextTtsClip();
    });
}

void Bridge::playTtsAudio(const QByteArray &audio, const QString &mime)
{
    if (audio.isEmpty())
        return;
    // Queue, don't interrupt. One assistant turn can produce several `message`
    // events (each its own voice.tts reply), and their audio can arrive while a
    // previous clip is still playing. Append and let playNextTtsClip drain the
    // queue one utterance at a time so sentences never cut each other off / overlap.
    m_ttsQueue.append(TtsClip{audio, mime});
    if (!m_ttsPlaying)
        playNextTtsClip();
}

void Bridge::playNextTtsClip()
{
    if (m_ttsQueue.isEmpty()) {
        // Whole reply spoken. Transition out of "speaking" exactly ONCE here, after
        // the last clip — not after every clip — so hands-free doesn't resume
        // listening mid-reply (which would also let us capture our own TTS tail).
        m_ttsPlaying = false;
        emit voiceSpeaking(false);
        if (m_handsFree)
            resumeListening();
        else if (m_voiceState == QStringLiteral("speaking"))
            setVoiceState(QStringLiteral("idle"));
        return;
    }
    const TtsClip clip = m_ttsQueue.takeFirst();

    QString base = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    if (base.isEmpty())
        base = QDir::tempPath();
    const QString ext = (clip.mime.contains(QStringLiteral("mpeg"))
                         || clip.mime.contains(QStringLiteral("mp3")))
                            ? QStringLiteral(".mp3") : QStringLiteral(".wav");
    // Ping-pong two temp paths so we never rewrite the file the player may still be
    // releasing from the clip that just ended.
    m_ttsTmpSeq ^= 1;
    m_ttsTmpPath = base + QStringLiteral("/jarvis_voicemode_tts")
                   + QString::number(m_ttsTmpSeq) + ext;
    QFile out(m_ttsTmpPath);
    if (!out.open(QIODevice::WriteOnly)) {
        // Couldn't stage this clip — skip it rather than stall the rest of the reply.
        playNextTtsClip();
        return;
    }
    out.write(clip.audio);
    out.close();

    ensureTtsPlayer();
    m_ttsPlaying = true;
    m_ttsOutput->setVolume(1.0);
    setVoiceState(QStringLiteral("speaking"));
    emit voiceSpeaking(true);
    m_ttsPlayer->setSource(QUrl::fromLocalFile(m_ttsTmpPath));
    m_ttsPlayer->play();
}

// ---- In-app browser (per-session engine bridge) ----------------------------

QString Bridge::engineBase() const
{
    QString base = m_videoBase;
    if (base.isEmpty())
        base = QStringLiteral("http://127.0.0.1:8810");
    if (base.endsWith(QLatin1Char('/')))
        base.chop(1);
    return base;
}

void Bridge::engineBrowserCall(const QString &tag, const QVariantMap &body)
{
    // The desktop never embeds QtWebEngine — it asks the per-session computer-use
    // engine to drive its controlled Chrome tab and renders the returned image.
    // The engine exposes /browser/<op>; tag routes the async reply.
    QString op = tag;
    QUrl url(engineBase() + QStringLiteral("/browser/") + op);
    QNetworkRequest req(url);
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!m_videoBearer.isEmpty())
        req.setRawHeader("Authorization", QByteArray("Bearer ") + m_videoBearer.toUtf8());
    req.setTransferTimeout(5000);
    const QByteArray payload = QJsonDocument(QJsonObject::fromVariantMap(body)).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = m_net->post(req, payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply, tag]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            // Engine may not implement the browser bridge yet; stay quiet so the
            // page shows an empty preview rather than a transport error toast.
            return;
        }
        const QByteArray b = reply->readAll();
        const QJsonDocument d = QJsonDocument::fromJson(b);
        const QJsonObject o = d.object();
        if (tag == QStringLiteral("screenshot")) {
            const QString shot = o.value(QStringLiteral("image_b64")).toString(
                o.value(QStringLiteral("screenshot")).toString());
            if (!shot.isEmpty())
                emit browserShot(shot);
        } else if (tag == QStringLiteral("snapshot")) {
            emit browserSnapshotReady(o.value(QStringLiteral("nodes")).toArray().toVariantList());
        } else {
            // navigate/back/forward/reload/click + status all report status fields.
            emit browserStatusReady(o.value(QStringLiteral("url")).toString(),
                                    o.value(QStringLiteral("title")).toString(),
                                    o.value(QStringLiteral("can_back")).toBool(),
                                    o.value(QStringLiteral("can_forward")).toBool());
            // A navigation usually changes the page; pull a fresh screenshot.
            if (tag != QStringLiteral("status"))
                browserScreenshot();
        }
    });
}

void Bridge::browserStatus()
{
    engineBrowserCall(QStringLiteral("status"), {});
}

void Bridge::browserNavigate(const QString &url)
{
    QVariantMap b;
    b.insert(QStringLiteral("url"), url.trimmed());
    engineBrowserCall(QStringLiteral("navigate"), b);
}

void Bridge::browserBack()    { engineBrowserCall(QStringLiteral("back"), {}); }
void Bridge::browserForward() { engineBrowserCall(QStringLiteral("forward"), {}); }
void Bridge::browserReload()  { engineBrowserCall(QStringLiteral("reload"), {}); }
void Bridge::browserScreenshot() { engineBrowserCall(QStringLiteral("screenshot"), {}); }
void Bridge::browserSnapshot()   { engineBrowserCall(QStringLiteral("snapshot"), {}); }

void Bridge::browserClick(const QString &ref)
{
    if (ref.isEmpty())
        return;
    QVariantMap b;
    b.insert(QStringLiteral("ref"), ref);
    engineBrowserCall(QStringLiteral("click"), b);
}

// ---- Sub-agent tree --------------------------------------------------------

void Bridge::loadSubAgentTree()
{
    // Reuse session.list; the response handler builds the tree and emits it.
    request(QStringLiteral("session.list"), {}, QStringLiteral("__subtree__"));
}

QVariantList Bridge::buildSubAgentTree(const QVariantList &sessions) const
{
    // Index sessions by id and collect children by parent_session_id.
    QHash<QString, QVariantMap> byId;
    QHash<QString, QStringList> children;
    QStringList roots;
    QStringList order;   // preserve daemon order for stable rendering

    for (const QVariant &v : sessions) {
        const QVariantMap s = v.toMap();
        const QString id = s.value(QStringLiteral("id")).toString();
        if (id.isEmpty())
            continue;
        byId.insert(id, s);
        order << id;
        const QString parent = s.value(QStringLiteral("parent_session_id")).toString();
        if (parent.isEmpty())
            roots << id;
        else
            children[parent] << id;
    }
    // A child whose parent isn't in the list is treated as a root too.
    for (const QString &id : order) {
        const QString parent = byId.value(id).value(QStringLiteral("parent_session_id")).toString();
        if (!parent.isEmpty() && !byId.contains(parent) && !roots.contains(id))
            roots << id;
    }

    QVariantList rows;
    // Depth-first walk preserving order.
    QList<QPair<QString, int>> stack;
    // Push roots in reverse so the first root is processed first.
    for (int i = roots.size() - 1; i >= 0; --i)
        stack.append(qMakePair(roots[i], 0));
    QSet<QString> seen;
    while (!stack.isEmpty()) {
        const QPair<QString, int> top = stack.takeLast();
        const QString id = top.first;
        const int depth = top.second;
        if (seen.contains(id))
            continue;
        seen.insert(id);
        const QVariantMap s = byId.value(id);
        QVariantMap row;
        row.insert(QStringLiteral("id"), id);
        row.insert(QStringLiteral("title"), s.value(QStringLiteral("title")));
        row.insert(QStringLiteral("brain"), s.value(QStringLiteral("brain")));
        row.insert(QStringLiteral("profile"), s.value(QStringLiteral("profile")));
        row.insert(QStringLiteral("agent"), s.value(QStringLiteral("agent")));
        // Session JSON carries "state" (starting/running/idle/done/error) — expose
        // it as "status" for the tree + the subagents pop-out.
        row.insert(QStringLiteral("status"), s.value(QStringLiteral("state")));
        row.insert(QStringLiteral("depth"), depth);
        row.insert(QStringLiteral("parent"), s.value(QStringLiteral("parent_session_id")));
        rows << row;
        const QStringList kids = children.value(id);
        for (int i = kids.size() - 1; i >= 0; --i)
            stack.append(qMakePair(kids[i], depth + 1));
    }
    return rows;
}

// ---- COMPUTER page ---------------------------------------------------------

void Bridge::setDriving(bool d)
{
    qInfo().noquote() << "[jarvis-bridge] setDriving(" << d << ") — overlay should"
                      << (d ? "SPAWN on every monitor" : "drop");
    if (m_driving == d)
        return;
    m_driving = d;
    emit drivingChanged();
    // Keep the pointer-bus tail running always (started in the ctor) so the overlay
    // can AUTO-ARM the moment the agent touches the real screen (which="real"),
    // not only during an explicit take-over. Manual setDriving(false) clears the
    // auto-arm flag so a later real-pointer event can re-arm cleanly.
    if (!d)
        m_drivingAutoArmed = false;
    startPointerTail();
}

void Bridge::setMirroring(bool m)
{
    if (m_mirroring == m)
        return;
    m_mirroring = m;
    emit mirroringChanged();
}

void Bridge::setHasAgentDesktop(bool v)
{
    if (m_hasAgentDesktop == v)
        return;
    m_hasAgentDesktop = v;
    emit hasAgentDesktopChanged();
}

void Bridge::refreshAgentDesktop()
{
    // No session, or not connected → nothing to mirror.
    if (m_sessionId.isEmpty() || m_socket->state() != QAbstractSocket::ConnectedState) {
        setHasAgentDesktop(false);
        return;
    }
    QVariantMap params;
    params.insert(QStringLiteral("session_id"), m_sessionId);
    // Tag the request with the session it's for, so a late/out-of-order reply
    // that lands AFTER the user switched sessions can be dropped instead of
    // repainting the peek/mirror with the WRONG session's nested desktop.
    request(QStringLiteral("agent_desktop.info"), params,
            QStringLiteral("__agentdesk__:") + m_sessionId);
}

void Bridge::setCoworkerSessionId(const QString &id)
{
    if (m_coworkerSessionId == id)
        return;
    m_coworkerSessionId = id;
    emit coworkerSessionIdChanged();
    syncSubscriptions();   // (un)subscribe the COMPUTER page's co-worker session
}

void Bridge::startCoworker(const QString &brain, const QString &model)
{
    QVariantMap params;
    params.insert(QStringLiteral("profile"), QStringLiteral("coworker"));
    // Omit brain when unspecified so the daemon applies its configured default_brain.
    if (!brain.isEmpty())
        params.insert(QStringLiteral("brain"), brain);
    params.insert(QStringLiteral("target"), QStringLiteral("agent"));
    if (!model.isEmpty())
        params.insert(QStringLiteral("model"), model);
    // Tag the request so the response handler knows to wire up the co-worker
    // session + auto-start the agent-desktop mirror.
    m_creatingSession = true;
    request(QStringLiteral("session.create"), params, QStringLiteral("coworker:agent"));
}

void Bridge::stopCoworker()
{
    mirrorStop();
    if (!m_coworkerSessionId.isEmpty()) {
        QVariantMap params;
        params.insert(QStringLiteral("session_id"), m_coworkerSessionId);
        request(QStringLiteral("session.cancel"), params);
    }
    setCoworkerSessionId(QString());
}

void Bridge::takeOver(const QString &brain, const QString &model)
{
    QVariantMap params;
    params.insert(QStringLiteral("profile"), QStringLiteral("coworker"));
    // Omit brain when unspecified so the daemon applies its configured default_brain.
    if (!brain.isEmpty())
        params.insert(QStringLiteral("brain"), brain);
    params.insert(QStringLiteral("target"), QStringLiteral("real"));
    if (!model.isEmpty())
        params.insert(QStringLiteral("model"), model);
    // target="real" is approval/biometric gated by the daemon; the driving flag
    // only flips once the daemon confirms via a driving.state event.
    m_creatingSession = true;
    request(QStringLiteral("session.create"), params, QStringLiteral("coworker:real"));
}

void Bridge::releaseScreen()
{
    // Tell the daemon to end the take-over; optimistically drop the overlay so the
    // user is never left with a stuck banner if the daemon is slow to confirm.
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    request(QStringLiteral("session.set_target"), params);   // best-effort; daemon may ignore
    setDriving(false);
}

void Bridge::takeOverCancel()
{
    // Esc-to-cancel path (docs/TAKEOVER_UX.md). If this is the screenshot/demo
    // overlay, just stop the demo. Otherwise send control-WS `take_over.cancel`
    // best-effort and flip `driving` false locally so the overlay drops at once.
    if (m_demo) {
        stopDrivingDemo();
        return;
    }
    QVariantMap params;
    if (!m_sessionId.isEmpty())
        params.insert(QStringLiteral("session_id"), m_sessionId);
    // Daemon may not implement this until Wave 5; the unknown_method response is
    // swallowed in handleResponse() so cancelling never toasts an error.
    request(QStringLiteral("take_over.cancel"), params);
    // Esc must TRULY STOP the model acting, not just hide the banner. take_over.cancel
    // only ends the take-over routing; cancel the running turn too so the model stops
    // issuing actions (same path as the chat Stop button).
    cancelSession();
    setDriving(false);
}

// ---- Driving DEMO (screenshot / visual verification) -----------------------

void Bridge::startDrivingDemo()
{
    m_demo = true;
    if (!m_demoTimer) {
        m_demoTimer = new QTimer(this);
        m_demoTimer->setInterval(33);   // ~30 fps fake-pointer animation
        connect(m_demoTimer, &QTimer::timeout, this, &Bridge::tickDrivingDemo);
    }
    m_demoPhase = 0.0;
    m_demoStep = 0;
    m_demoTimer->start();
    // Force the overlay visible without a live take-over. setDriving() would also
    // start the file tail; for the demo we drive the pointer ourselves, so set the
    // flag directly here (the demo timer is the pointer source).
    if (!m_driving) {
        m_driving = true;
        emit drivingChanged();
    }
    tickDrivingDemo();   // emit an initial position immediately
}

void Bridge::stopDrivingDemo()
{
    if (m_demoTimer)
        m_demoTimer->stop();
    if (m_demo) {
        m_demo = false;
        if (m_driving) {
            m_driving = false;
            emit drivingChanged();
        }
    }
}

void Bridge::tickDrivingDemo()
{
    // A smooth Lissajous-style sweep across the screen so the glowing cursor
    // visibly glides and the halo pulse is easy to read in a screenshot.
    m_demoPhase += 0.045;
    const double nx = 0.5 + 0.34 * std::sin(m_demoPhase);
    const double ny = 0.5 + 0.26 * std::sin(m_demoPhase * 1.7 + 0.6);

    // Fire a "click" roughly twice per loop so the click ripple is exercised.
    QString action = QStringLiteral("move");
    if (m_demoStep > 0 && (m_demoStep % 60) == 0)
        action = QStringLiteral("click");
    ++m_demoStep;

    emit agentPointer(nx, ny, action, QStringLiteral("left"));
    // Also drive the multi-monitor overlay path: sweep the glow across the FULL
    // virtual desktop (all monitors) in global pixels so the demo exercises the
    // same per-output mapping/culling the live take-over uses.
    if (QScreen *primary = QGuiApplication::primaryScreen()) {
        const QRect vd = primary->virtualGeometry();
        const double gx = vd.x() + nx * vd.width();
        const double gy = vd.y() + ny * vd.height();
        emit agentPointerGlobal(gx, gy, action, QStringLiteral("left"));
    }
}

void Bridge::setVideoEndpoint(const QString &baseUrl)
{
    m_videoBase = baseUrl;
}

QString Bridge::videoFrameUrl() const
{
    QString base = m_videoBase;
    if (base.isEmpty())
        base = QStringLiteral("http://127.0.0.1:8810");   // per-session engine default
    if (base.endsWith(QLatin1Char('/')))
        base.chop(1);
    return base + QStringLiteral("/video/frame?which=agent");
}

void Bridge::mirrorStart()
{
    if (m_mirroring)
        return;
    setMirroring(true);
    // Ask the daemon to begin mirroring on the device channel too (biometric
    // gated there); locally we just poll the engine for the preview.
    if (!m_coworkerSessionId.isEmpty()) {
        QVariantMap params;
        params.insert(QStringLiteral("session_id"), m_coworkerSessionId);
        request(QStringLiteral("mirror.start"), params);
    }
    m_frameTimer->start();
    pollFrame();
}

void Bridge::mirrorStop()
{
    if (!m_mirroring && !m_frameTimer->isActive())
        return;
    m_frameTimer->stop();
    if (m_frameReply) {
        m_frameReply->abort();
        m_frameReply = nullptr;
    }
    if (!m_coworkerSessionId.isEmpty()) {
        QVariantMap params;
        params.insert(QStringLiteral("session_id"), m_coworkerSessionId);
        request(QStringLiteral("mirror.stop"), params);
    }
    if (m_frameProvider)
        m_frameProvider->clear();
    setMirroring(false);
}

void Bridge::pollFrame()
{
    // Skip if a request is already in flight (avoid pile-up on a slow engine).
    if (m_frameReply)
        return;
    QNetworkRequest req{ QUrl(videoFrameUrl()) };
    if (!m_videoBearer.isEmpty())
        req.setRawHeader("Authorization",
                         QByteArray("Bearer ") + m_videoBearer.toUtf8());
    req.setTransferTimeout(2000);
    m_frameReply = m_net->get(req);
    connect(m_frameReply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *r = m_frameReply;
        m_frameReply = nullptr;
        onFrameReplyFinished(r);
    });
}

void Bridge::onFrameReplyFinished(QNetworkReply *reply)
{
    if (!reply)
        return;
    reply->deleteLater();
    if (reply->error() != QNetworkReply::NoError)
        return;   // transient; the timer will retry. No error toast for video.
    const QByteArray body = reply->readAll();
    if (body.isEmpty() || !m_frameProvider)
        return;
    if (m_frameProvider->setFrame(body)) {
        ++m_frameSeq;
        emit frameReady(m_frameSeq);
    }
}

// agent_pointer.jsonl fallback tail ------------------------------------------

void Bridge::startPointerTail()
{
    if (m_pointerWatcher)
        return;
    const QString path = jarvis::dataDir() + QStringLiteral("/agent_pointer.jsonl");
    // Start reading from the end so we only see new pointer events.
    QFileInfo fi(path);
    m_pointerOffset = fi.exists() ? fi.size() : 0;
    m_pointerWatcher = new QFileSystemWatcher(this);
    if (fi.exists())
        m_pointerWatcher->addPath(path);
    // Also watch the directory so we pick the file up when it is first created.
    const QString dir = fi.absolutePath();
    if (QFileInfo::exists(dir))
        m_pointerWatcher->addPath(dir);
    connect(m_pointerWatcher, &QFileSystemWatcher::fileChanged,
            this, &Bridge::readPointerTail);
    connect(m_pointerWatcher, &QFileSystemWatcher::directoryChanged, this,
            [this, path]() {
        if (QFileInfo::exists(path)
            && !m_pointerWatcher->files().contains(path)) {
            m_pointerWatcher->addPath(path);
            readPointerTail();
        }
    });
}

void Bridge::stopPointerTail()
{
    if (!m_pointerWatcher)
        return;
    m_pointerWatcher->deleteLater();
    m_pointerWatcher = nullptr;
    m_pointerOffset = 0;
}

QString Bridge::questionsDir() const
{
    // Must match the engine's ask_bus.py EXACTLY on every OS — see DataPaths.h.
    return jarvis::dataDir() + QStringLiteral("/questions");
}

void Bridge::startQuestionWatch()
{
    const QString dir = questionsDir();
    QDir().mkpath(dir);
    if (!m_questionWatcher) {
        m_questionWatcher = new QFileSystemWatcher(this);
        connect(m_questionWatcher, &QFileSystemWatcher::directoryChanged,
                this, &Bridge::scanQuestions);
    }
    if (!m_questionWatcher->directories().contains(dir))
        m_questionWatcher->addPath(dir);
    scanQuestions();
}

void Bridge::scanQuestions()
{
    const QString dir = questionsDir();
    QDir d(dir);
    const QStringList files = d.entryList({ QStringLiteral("*.json") }, QDir::Files);
    QSet<QString> present;
    for (const QString &fn : files) {
        const QString id = fn.left(fn.size() - 5); // strip ".json"
        present.insert(id);
        if (m_seenQuestions.contains(id))
            continue;
        QFile f(d.filePath(fn));
        if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
            continue;
        const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
        f.close();
        if (!doc.isObject())
            continue;
        const QJsonObject o = doc.object();
        const QString qid = o.value(QStringLiteral("id")).toString(id);
        const QString question = o.value(QStringLiteral("question")).toString();
        QStringList options;
        for (const QJsonValue &v : o.value(QStringLiteral("options")).toArray())
            options << v.toString();
        m_seenQuestions.insert(id);
        emit agentQuestion(qid, question, options);
    }
    // Forget ids whose files are gone (answered/cleaned) so a recycled id re-fires.
    for (auto it = m_seenQuestions.begin(); it != m_seenQuestions.end();) {
        if (!present.contains(*it))
            it = m_seenQuestions.erase(it);
        else
            ++it;
    }
}

void Bridge::answerQuestion(const QString &id, const QString &answer)
{
    if (id.isEmpty())
        return;
    QDir d(questionsDir());
    QFile f(d.filePath(id + QStringLiteral(".answer")));
    if (f.open(QIODevice::WriteOnly | QIODevice::Text)) {
        QJsonObject o;
        o.insert(QStringLiteral("answer"), answer);
        f.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
        f.close();
    }
    // Do NOT forget the id here. The question's <id>.json is still on disk until
    // the engine polls, reads the .answer, and unlinks it — and writing .answer
    // fires the directory watcher. If we dropped the id now, that scan would see
    // the still-present .json and re-emit the SAME question as a duplicate card.
    // The scanQuestions() cleanup forgets the id once the engine removes the file.
}

// render_widget file bus (widgets.jsonl) ------------------------------------
//
// The engine appends one compact JSON line per widget; we POLL (a watcher on an
// appended file can miss the change events) every 500ms, tracking the last byte
// offset so we only emit lines that are new since the app started.

QString Bridge::widgetsPath() const
{
    // Must match the engine's widgets_bus.py EXACTLY on every OS — see DataPaths.h.
    return jarvis::dataDir() + QStringLiteral("/widgets.jsonl");
}

void Bridge::startWidgetWatch()
{
    if (m_widgetTimer)
        return;
    // Start from the END so old widgets from a previous run don't replay; only
    // widgets the model renders while this app is open appear on the CANVAS page.
    QFileInfo fi(widgetsPath());
    m_widgetOffset = fi.exists() ? fi.size() : 0;
    m_widgetTimer = new QTimer(this);
    m_widgetTimer->setInterval(500);
    connect(m_widgetTimer, &QTimer::timeout, this, &Bridge::readWidgetTail);
    m_widgetTimer->start();

    // Re-assert active live-widget viewer leases every ~15s so the daemon's TTL
    // (45s) never expires one while a page/popout is still on screen.
    m_viewerHeartbeat = new QTimer(this);
    m_viewerHeartbeat->setInterval(15000);
    connect(m_viewerHeartbeat, &QTimer::timeout, this, [this]() {
        for (auto it = m_widgetViewers.cbegin(); it != m_widgetViewers.cend(); ++it)
            sendWidgetViewing(it.key(), true, it.value());
    });
    m_viewerHeartbeat->start();
}

void Bridge::sendWidgetViewing(const QString &scope, bool active, const QString &kind)
{
    if (scope.isEmpty())
        return;
    QVariantMap params;
    params.insert(QStringLiteral("scope"), scope);
    params.insert(QStringLiteral("kind"), kind);
    params.insert(QStringLiteral("active"), active);
    request(QStringLiteral("widget.viewing"), params);
}

void Bridge::setPageViewing(const QString &scope, const QString &kind)
{
    // The single "currently visible page" lease. Swapping pages drops the old one
    // and asserts the new one (empty scope == no page lease, e.g. Settings).
    if (scope == m_pageScope) {
        if (!scope.isEmpty())
            sendWidgetViewing(scope, true, kind); // refresh
        return;
    }
    if (!m_pageScope.isEmpty()) {
        sendWidgetViewing(m_pageScope, false, m_widgetViewers.value(m_pageScope));
        m_widgetViewers.remove(m_pageScope);
    }
    m_pageScope = scope;
    if (!scope.isEmpty()) {
        m_widgetViewers.insert(scope, kind);
        sendWidgetViewing(scope, true, kind);
    }
}

void Bridge::addWidgetViewer(const QString &scope, const QString &kind)
{
    if (scope.isEmpty())
        return;
    m_widgetViewers.insert(scope, kind);
    sendWidgetViewing(scope, true, kind);
}

void Bridge::removeWidgetViewer(const QString &scope)
{
    if (scope.isEmpty() || !m_widgetViewers.contains(scope))
        return;
    const QString kind = m_widgetViewers.take(scope);
    sendWidgetViewing(scope, false, kind);
}

void Bridge::replayAllWidgets()
{
    // The Canvas/Widgets tab tails widgets.jsonl from EOF, so a widget rendered
    // before the page opened wouldn't show. Replay the CURRENT canvas set (apply
    // remove/clear, keep the last spec per id) so the page comes back populated.
    QFile f(widgetsPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    QStringList order;
    QHash<QString, QVariantMap> byId;
    while (!f.atEnd()) {
        const QByteArray line = f.readLine().trimmed();
        if (line.isEmpty())
            continue;
        const QJsonDocument d = QJsonDocument::fromJson(line);
        if (!d.isObject())
            continue;
        const QJsonObject o = d.object();
        const QString op = o.value(QStringLiteral("op")).toString();
        QString id = o.value(QStringLiteral("id")).toString();
        if (op == QStringLiteral("clear")) { order.clear(); byId.clear(); continue; }
        if (op == QStringLiteral("remove")) { order.removeAll(id); byId.remove(id); continue; }
        if (!o.contains(QStringLiteral("spec")))
            continue;
        if (id.isEmpty())
            id = o.value(QStringLiteral("ts")).toVariant().toString();
        QString target = o.value(QStringLiteral("target")).toString();
        if (target.isEmpty())
            target = QStringLiteral("canvas");
        QVariantMap widget;
        widget.insert(QStringLiteral("ts"), o.value(QStringLiteral("ts")).toVariant());
        widget.insert(QStringLiteral("title"), o.value(QStringLiteral("title")).toString());
        widget.insert(QStringLiteral("id"), id);
        widget.insert(QStringLiteral("target"), target);
        widget.insert(QStringLiteral("session_id"),
                      o.value(QStringLiteral("session_id")).toString());
        widget.insert(QStringLiteral("spec"), o.value(QStringLiteral("spec")).toVariant());
        if (!byId.contains(id))
            order.append(id);
        byId.insert(id, widget);
    }
    for (const QString &id : order)
        emit widgetRendered(byId.value(id));
}

void Bridge::readWidgetTail()
{
    const QString path = widgetsPath();
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    // Truncation/rotation guard: if the file shrank, restart from the top.
    if (f.size() < m_widgetOffset)
        m_widgetOffset = 0;
    if (!f.seek(m_widgetOffset))
        return;
    const QByteArray chunk = f.readAll();
    m_widgetOffset = f.pos();

    for (const QByteArray &lineRaw : chunk.split('\n')) {
        const QByteArray line = lineRaw.trimmed();
        if (line.isEmpty())
            continue;
        QJsonParseError perr;
        const QJsonDocument d = QJsonDocument::fromJson(line, &perr);
        if (perr.error != QJsonParseError::NoError || !d.isObject())
            continue;
        const QJsonObject o = d.object();
        // Control records: {op:"remove",id} drops one canvas, {op:"clear"} drops
        // all. The bus is append-only, so deletes/clears are markers the desktop
        // replays — keeping the offset-tail poller untouched.
        const QString op = o.value(QStringLiteral("op")).toString();
        if (op == QStringLiteral("remove")) {
            emit widgetRemoved(o.value(QStringLiteral("id")).toString());
            continue;
        }
        if (op == QStringLiteral("clear")) {
            emit widgetsCleared();
            continue;
        }
        if (!o.contains(QStringLiteral("spec")))
            continue;
        // {ts, title, id, spec, target} — spec is a nested object/array; toVariant()
        // converts the whole tree to nested QVariantMap/QVariantList for the QML
        // renderer. `id` lets the CANVAS page replace a card in place on update;
        // older records without an id fall back to "<ts>" (matching the engine's
        // "w<ts>" fallback shape closely enough for dedupe). `target` gates whether
        // it also surfaces in chat/voice (default "canvas" = Canvas tab only).
        const QVariant ts = o.value(QStringLiteral("ts")).toVariant();
        QString id = o.value(QStringLiteral("id")).toString();
        if (id.isEmpty())
            id = ts.toString();
        QString target = o.value(QStringLiteral("target")).toString();
        if (target.isEmpty())
            target = QStringLiteral("canvas");
        QVariantMap widget;
        widget.insert(QStringLiteral("ts"), ts);
        widget.insert(QStringLiteral("title"),
                      o.value(QStringLiteral("title")).toString());
        widget.insert(QStringLiteral("id"), id);
        widget.insert(QStringLiteral("target"), target);
        widget.insert(QStringLiteral("session_id"),
                      o.value(QStringLiteral("session_id")).toString());
        widget.insert(QStringLiteral("spec"),
                      o.value(QStringLiteral("spec")).toVariant());
        emit widgetRendered(widget);
    }
}

void Bridge::replaySessionWidgets(const QString &sessionId)
{
    // Reopening a stored session: re-emit the widgets that session rendered so its
    // chat (and the Canvas) come back instead of staying empty. Scan the whole bus
    // (capped at a few MB), apply remove/clear, keep the LAST spec per id whose
    // session_id matches, then emit them in render order.
    if (sessionId.isEmpty())
        return;
    QFile f(widgetsPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    QStringList order;
    QHash<QString, QVariantMap> byId;
    while (!f.atEnd()) {
        const QByteArray line = f.readLine().trimmed();
        if (line.isEmpty())
            continue;
        const QJsonDocument d = QJsonDocument::fromJson(line);
        if (!d.isObject())
            continue;
        const QJsonObject o = d.object();
        const QString op = o.value(QStringLiteral("op")).toString();
        QString id = o.value(QStringLiteral("id")).toString();
        if (op == QStringLiteral("clear")) { order.clear(); byId.clear(); continue; }
        if (op == QStringLiteral("remove")) { order.removeAll(id); byId.remove(id); continue; }
        if (!o.contains(QStringLiteral("spec")))
            continue;
        if (o.value(QStringLiteral("session_id")).toString() != sessionId)
            continue;
        if (id.isEmpty())
            id = o.value(QStringLiteral("ts")).toVariant().toString();
        QString target = o.value(QStringLiteral("target")).toString();
        if (target.isEmpty())
            target = QStringLiteral("canvas");
        QVariantMap widget;
        widget.insert(QStringLiteral("ts"), o.value(QStringLiteral("ts")).toVariant());
        widget.insert(QStringLiteral("title"), o.value(QStringLiteral("title")).toString());
        widget.insert(QStringLiteral("id"), id);
        widget.insert(QStringLiteral("target"), target);
        widget.insert(QStringLiteral("session_id"), sessionId);
        widget.insert(QStringLiteral("spec"), o.value(QStringLiteral("spec")).toVariant());
        if (!byId.contains(id))
            order.append(id);
        byId.insert(id, widget);
    }
    for (const QString &id : order)
        emit widgetRendered(byId.value(id));
}

void Bridge::popOutWidget(const QString &id, const QString &title, const QVariant &spec)
{
    // Package {id,title,spec} and let QML own the standalone Window's lifetime
    // (Main.qml's Instantiator over a ListModel, mirroring the driving-overlay
    // Instantiator-of-Window precedent). The spec is passed straight through as
    // a nested QVariant tree — still DATA, rendered by the safe WidgetRenderer.
    QVariantMap widget;
    widget.insert(QStringLiteral("id"), id);
    widget.insert(QStringLiteral("title"), title);
    widget.insert(QStringLiteral("spec"), spec);
    emit spawnStandaloneWidget(widget);
}

// ---- Canvas + saved-widget management (file-backed, shared with the engine) --

static QString jarvisDataDir()
{
    // Shared file bus with the engine — resolve identically on every OS (DataPaths.h).
    return jarvis::dataDir();
}

static QString savedWidgetsFile() { return jarvisDataDir() + QStringLiteral("/saved_widgets.json"); }

// Lowercase kebab slug (no QRegularExpression dependency).
static QString slugify(const QString &name)
{
    QString s;
    bool dash = false;
    for (const QChar c : name.toLower()) {
        if (c.isLetterOrNumber()) { s.append(c); dash = false; }
        else if (!dash && !s.isEmpty()) { s.append(QLatin1Char('-')); dash = true; }
    }
    while (s.endsWith(QLatin1Char('-'))) s.chop(1);
    return s.isEmpty() ? (QStringLiteral("w") + QString::number(QDateTime::currentMSecsSinceEpoch())) : s;
}

static QJsonArray readSavedWidgetsArr()
{
    QFile f(savedWidgetsFile());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return {};
    const QJsonDocument d = QJsonDocument::fromJson(f.readAll());
    if (d.isObject())
        return d.object().value(QStringLiteral("widgets")).toArray();
    if (d.isArray())
        return d.array();
    return {};
}

static void writeSavedWidgetsArr(const QJsonArray &arr)
{
    QDir().mkpath(jarvisDataDir());
    QJsonObject root;
    root.insert(QStringLiteral("widgets"), arr);
    QFile f(savedWidgetsFile());
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
        f.close();
    }
}

void Bridge::appendWidgetBusRecord(const QJsonObject &record)
{
    const QString path = widgetsPath();
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile f(path);
    if (f.open(QIODevice::Append | QIODevice::Text)) {
        f.write(QJsonDocument(record).toJson(QJsonDocument::Compact));
        f.write("\n");
        f.close();
    }
}

void Bridge::canvasDelete(const QString &id)
{
    QJsonObject o;
    o.insert(QStringLiteral("ts"), QDateTime::currentMSecsSinceEpoch());
    o.insert(QStringLiteral("op"), QStringLiteral("remove"));
    o.insert(QStringLiteral("id"), id);
    appendWidgetBusRecord(o);
    emit widgetRemoved(id);   // immediate local effect; poller re-emit is idempotent
}

// ---- Home dashboard widget order (user drag/move + model home_move) ---------
QString Bridge::homeOrderPath() const
{
    return jarvis::dataDir() + QStringLiteral("/home_order.json");
}

void Bridge::saveHomeOrder(const QStringList &ids)
{
    const QString path = homeOrderPath();
    QDir().mkpath(QFileInfo(path).absolutePath());
    QJsonArray arr;
    for (const QString &id : ids)
        arr.append(id);
    QFile f(path);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(QJsonDocument(arr).toJson(QJsonDocument::Compact));
        f.close();
    }
}

QStringList Bridge::homeOrder() const
{
    QStringList out;
    QFile f(homeOrderPath());
    if (f.open(QIODevice::ReadOnly)) {
        const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
        f.close();
        for (const QJsonValue &v : doc.array())
            out << v.toString();
    }
    return out;
}

void Bridge::canvasClear()
{
    QJsonObject o;
    o.insert(QStringLiteral("ts"), QDateTime::currentMSecsSinceEpoch());
    o.insert(QStringLiteral("op"), QStringLiteral("clear"));
    appendWidgetBusRecord(o);
    emit widgetsCleared();
}

void Bridge::refreshSavedWidgets()
{
    const QJsonArray arr = readSavedWidgetsArr();
    QVariantList out;
    for (const QJsonValue &v : arr)
        out.append(v.toObject().toVariantMap());
    emit savedWidgetsListed(out);
}

void Bridge::saveWidget(const QString &name, const QVariant &spec)
{
    QJsonArray arr = readSavedWidgetsArr();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const QJsonValue specV = QJsonValue::fromVariant(spec);
    // Update an existing entry with the same name, else append a new one.
    bool updated = false;
    for (int i = 0; i < arr.size(); ++i) {
        QJsonObject w = arr[i].toObject();
        if (w.value(QStringLiteral("name")).toString() == name) {
            w.insert(QStringLiteral("spec"), specV);
            w.insert(QStringLiteral("updated"), now);
            arr[i] = w;
            updated = true;
            break;
        }
    }
    if (!updated) {
        QJsonObject w;
        w.insert(QStringLiteral("id"), slugify(name));
        w.insert(QStringLiteral("name"), name);
        w.insert(QStringLiteral("spec"), specV);
        w.insert(QStringLiteral("created"), now);
        w.insert(QStringLiteral("updated"), now);
        arr.append(w);
    }
    writeSavedWidgetsArr(arr);
    refreshSavedWidgets();
}

void Bridge::deleteSavedWidget(const QString &id)
{
    const QJsonArray arr = readSavedWidgetsArr();
    QJsonArray kept;
    for (const QJsonValue &v : arr) {
        const QJsonObject w = v.toObject();
        if (w.value(QStringLiteral("id")).toString() != id
            && w.value(QStringLiteral("name")).toString() != id)
            kept.append(w);
    }
    writeSavedWidgetsArr(kept);
    refreshSavedWidgets();
}

void Bridge::renderSavedWidget(const QString &id, const QString &target)
{
    const QJsonArray arr = readSavedWidgetsArr();
    for (const QJsonValue &v : arr) {
        const QJsonObject w = v.toObject();
        if (w.value(QStringLiteral("id")).toString() == id
            || w.value(QStringLiteral("name")).toString() == id) {
            const QString tgt = target.isEmpty() ? QStringLiteral("canvas") : target;
            QJsonObject rec;
            rec.insert(QStringLiteral("ts"), QDateTime::currentMSecsSinceEpoch());
            rec.insert(QStringLiteral("title"), w.value(QStringLiteral("name")).toString());
            // "home" pins use a STABLE id ("home:<saved id>") so re-pinning replaces
            // in place and home_unpin / the ✕ button can remove exactly this card.
            // Other targets get a fresh canvas id each render.
            rec.insert(QStringLiteral("id"),
                       tgt == QStringLiteral("home")
                           ? (QStringLiteral("home:") + w.value(QStringLiteral("id")).toString())
                           : QString());
            rec.insert(QStringLiteral("target"), tgt);
            rec.insert(QStringLiteral("spec"), w.value(QStringLiteral("spec")));
            appendWidgetBusRecord(rec);
            return;
        }
    }
}

void Bridge::readPointerTail()
{
    const QString path = jarvis::dataDir() + QStringLiteral("/agent_pointer.jsonl");
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    // Truncation/rotation guard: if the file shrank, restart from the top.
    if (f.size() < m_pointerOffset)
        m_pointerOffset = 0;
    if (!f.seek(m_pointerOffset))
        return;
    const QByteArray chunk = f.readAll();
    m_pointerOffset = f.pos();
    // Some watchers drop the path after a change event; re-add to keep watching.
    if (m_pointerWatcher && !m_pointerWatcher->files().contains(path))
        m_pointerWatcher->addPath(path);

    for (const QByteArray &lineRaw : chunk.split('\n')) {
        const QByteArray line = lineRaw.trimmed();
        if (line.isEmpty())
            continue;
        QJsonParseError perr;
        const QJsonDocument d = QJsonDocument::fromJson(line, &perr);
        if (perr.error != QJsonParseError::NoError || !d.isObject())
            continue;
        const QJsonObject o = d.object();
        // The engine writes GLOBAL desktop pixels x,y (map_to_desktop). Keep a
        // normalized nx/ny for legacy single-surface consumers (the in-app agent
        // preview), but ALSO emit the raw global pixels so the multi-monitor
        // take-over overlay can map each event to the correct output + cull it
        // when the cursor is on a different monitor.
        const double x = o.value(QStringLiteral("x")).toDouble();
        const double y = o.value(QStringLiteral("y")).toDouble();
        double nx = o.value(QStringLiteral("nx")).toDouble(-1.0);
        double ny = o.value(QStringLiteral("ny")).toDouble(-1.0);
        if (nx < 0.0 || ny < 0.0) {
            const double w = o.value(QStringLiteral("w")).toDouble(0.0);
            const double h = o.value(QStringLiteral("h")).toDouble(0.0);
            nx = (w > 0.0) ? x / w : x;
            ny = (h > 0.0) ? y / h : y;
        }
        const QString action = o.value(QStringLiteral("kind")).toString(
            o.value(QStringLiteral("action")).toString(QStringLiteral("move")));
        const QString button = o.value(QStringLiteral("button")).toString();
        emit agentPointer(nx, ny, action, button);
        emit agentPointerGlobal(x, y, action, button);

        // AUTO-ARM the "Jarvis is using this computer" overlay when the agent acts
        // on the REAL screen (engine publishes session="real"), so the user sees
        // the banner + glow during which="real" co-work, not just explicit
        // take-overs. Disarms ~6s after the last real event (unless an explicit
        // take-over set driving, which is not auto-armed so this won't drop it).
        if (o.value(QStringLiteral("session")).toString() == QStringLiteral("real")) {
            if (!m_driving) {
                m_drivingAutoArmed = true;
                setDriving(true);
            }
            if (m_drivingAutoArmed) {
                if (!m_realIdleTimer) {
                    m_realIdleTimer = new QTimer(this);
                    m_realIdleTimer->setSingleShot(true);
                    connect(m_realIdleTimer, &QTimer::timeout, this, [this]() {
                        if (m_drivingAutoArmed)
                            setDriving(false);
                    });
                }
                // Stay armed across the WHOLE turn (the model thinks between tool
                // calls). Primary disarm is the session "final" event; this is just
                // a long safety backstop if that event is missed.
                m_realIdleTimer->start(180000);
            }
        }
    }
}

bool Bridge::handleComputerEvent(const QString &sessionId, const QVariantMap &ev)
{
    const QString kind = ev.value(QStringLiteral("kind")).toString();
    if (kind == QStringLiteral("agent_pointer")) {
        // Daemon-forwarded agent pointer (preferred over the file tail). The
        // values arrive as a QVariantMap, so coerce with QVariant::toDouble()
        // (which has no default-value overload) and substitute defaults manually.
        double nx = ev.contains(QStringLiteral("nx")) ? ev.value(QStringLiteral("nx")).toDouble() : -1.0;
        double ny = ev.contains(QStringLiteral("ny")) ? ev.value(QStringLiteral("ny")).toDouble() : -1.0;
        if (nx < 0.0 || ny < 0.0) {
            const double x = ev.value(QStringLiteral("x")).toDouble();
            const double y = ev.value(QStringLiteral("y")).toDouble();
            const double w = ev.value(QStringLiteral("w")).toDouble();
            const double h = ev.value(QStringLiteral("h")).toDouble();
            nx = (w > 0.0) ? x / w : x;
            ny = (h > 0.0) ? y / h : y;
        }
        QString action = ev.value(QStringLiteral("action")).toString();
        if (action.isEmpty())
            action = QStringLiteral("move");
        const QString button = ev.value(QStringLiteral("button")).toString();
        emit agentPointer(nx, ny, action, button);
        return true;
    }
    if (kind == QStringLiteral("driving.state") || kind == QStringLiteral("driving")) {
        // Only arm/disarm the real-screen take-over overlay for OUR OWN driving
        // session (set by our own session.create) — otherwise a co-worker
        // take-over on a foreign, merely-subscribed session would spawn the
        // banner/cursor overlay on this desktop for someone else's session.
        if (sessionId == m_sessionId)
            setDriving(ev.value(QStringLiteral("active")).toBool());
        return true;
    }
    if (kind == QStringLiteral("mirror.state")) {
        // Scope the whole mirror.state handling (engine_url + start/stop) to the
        // co-worker session it belongs to, matching the mirrorStart() gate below.
        if (sessionId == m_coworkerSessionId) {
            const QString engineUrl = ev.value(QStringLiteral("engine_url")).toString();
            if (!engineUrl.isEmpty())
                setVideoEndpoint(engineUrl);
            if (ev.value(QStringLiteral("active")).toBool()) {
                if (!m_mirroring)
                    mirrorStart();
            } else {
                mirrorStop();
            }
        }
        return true;
    }
    return false;
}

void Bridge::onTextMessageReceived(const QString &message)
{
    QJsonParseError perr;
    const QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8(), &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject()) {
        emit errorOccurred(QStringLiteral("malformed frame: ") + perr.errorString());
        return;
    }
    const QJsonObject obj = doc.object();

    // Unsolicited 2FA unlock event: the daemon fanned out a challenge state change
    // (a paired phone approved/denied). The LockGate listens on authStateChanged
    // to unlock instantly without waiting for the next auth.status poll.
    if (obj.value(QStringLiteral("event")).toString() == QStringLiteral("auth.event")) {
        const QJsonObject data = obj.value(QStringLiteral("data")).toObject();
        emit authStateChanged(data.value(QStringLiteral("challenge_id")).toString(),
                              data.value(QStringLiteral("state")).toString());
        return;
    }

    // Real-time phone event (jarvis#76 item 3): incoming_call / call_state /
    // call_message / screening_* forwarded from the phone server. QML overlays
    // subscribe via onPhoneEvent instead of interval-polling list_active_calls.
    if (obj.value(QStringLiteral("event")).toString() == QStringLiteral("phone.event")) {
        emit phoneEvent(obj.value(QStringLiteral("data")).toObject().toVariantMap());
        return;
    }

    // Unsolicited "a session was opened" event: the daemon fanned out a session.create
    // from SOME surface (this desktop, the phone, Chrome co-work, MCP, scheduler).
    //
    // CRITICAL — do NOT adopt it into the active chat. The daemon broadcasts this
    // event BEFORE our own session.create reply lands, so a naive "adopt when we have
    // no session" hijacks the chat: voice-mode's own new session bounced us to Chat,
    // a new chat thrashed, and a Chrome co-work session stole the app's input (saying
    // "hello" went to the Chrome agent). Sessions are SEPARATE and live in the
    // Sessions list; the user switches between them there. Here we only RAISE the
    // window so "a new session opened" still surfaces Jarvis. Our own create's echo
    // is ignored entirely via m_creatingSession.
    if (obj.value(QStringLiteral("event")).toString() == QStringLiteral("session.opened")) {
        const QJsonObject data = obj.value(QStringLiteral("data")).toObject();
        const QString sid = data.value(QStringLiteral("session_id")).toString();
        qInfo("Bridge[session]: session.opened sid=%s (current=%s creating=%d) -> %s",
              qPrintable(sid), qPrintable(m_sessionId), int(m_creatingSession),
              (!sid.isEmpty() && sid != m_sessionId && !m_creatingSession) ? "focus-only" : "ignored");
        if (!sid.isEmpty() && sid != m_sessionId && !m_creatingSession)
            emit sessionFocusRequested();  // raise the window ONLY; never switch/clear
        return;
    }

    // Unsolicited event frame.
    if (obj.value(QStringLiteral("event")).toString() == QStringLiteral("session.event")) {
        const QJsonObject data = obj.value(QStringLiteral("data")).toObject();
        const QString sid = data.value(QStringLiteral("session_id")).toString();
        const QJsonObject ev = data.value(QStringLiteral("ev")).toObject();

        QVariantMap evMap = ev.toVariantMap();
        // COMPUTER-page events (agent_pointer / driving.state / mirror.state) are
        // consumed by the overlay + video poller and are NOT chat transcript rows.
        if (handleComputerEvent(sid, evMap))
            return;
        // Attention notifications (approval needed / task done). Reuse notify-send
        // via the local NotifyService path; the daemon may also push these, so the
        // toggle gates duplicates on the user's side.
        const QString kind = evMap.value(QStringLiteral("kind")).toString();
        if (kind == QStringLiteral("approval")) {
            notify(QStringLiteral("Approval needed"),
                   evMap.value(QStringLiteral("summary")).toString());
        } else if (kind == QStringLiteral("final")) {
            notify(QStringLiteral("Task complete"),
                   QStringLiteral("Jarvis finished a turn."));
            // The model's turn ended — drop the auto-armed take-over overlay now
            // (it stays up for the WHOLE turn while the model drives the real
            // screen, then clears here). Explicit take-overs aren't auto-armed, so
            // this leaves them under the daemon's control.
            if (m_drivingAutoArmed)
                setDriving(false);
        }
        // Fold the session id in so the UI can route by session.
        evMap.insert(QStringLiteral("session_id"), sid);
        // ONLY route to the chat transcript if it belongs to THIS desktop's active
        // session (or its voice session). With the session manager the daemon already
        // scopes delivery to our subscribed ids (session.subscribe), so foreign events
        // normally never arrive; this stays as a belt-and-suspenders guard (and the
        // fallback path against an older daemon that ignores session.subscribe) so a
        // Chrome co-work / phone session can never pollute the desktop chat.
        if (sid == m_sessionId || (!m_voiceSessionId.isEmpty() && sid == m_voiceSessionId)) {
            emit sessionEvent(evMap);
        } else {
            qInfo("Bridge[session]: DROP foreign session.event sid=%s kind=%s (current=%s)",
                  qPrintable(sid), qPrintable(kind), qPrintable(m_sessionId));
        }
        return;
    }

    // Response frame (has an id).
    if (obj.contains(QStringLiteral("id")) && !obj.value(QStringLiteral("id")).isNull()) {
        const int id = obj.value(QStringLiteral("id")).toInt();
        const bool ok = obj.value(QStringLiteral("ok")).toBool();
        const QVariantMap result = obj.value(QStringLiteral("result")).toObject().toVariantMap();
        const QVariantMap error = obj.value(QStringLiteral("error")).toObject().toVariantMap();
        handleResponse(id, ok, result, error);
        return;
    }
}

void Bridge::handleResponse(int id, bool ok, const QVariantMap &result, const QVariantMap &error)
{
    const QString method = m_pending.take(id);
    const QString ctx = m_pendingCtx.take(id);

    if (!ok) {
        const QString msg = error.value(QStringLiteral("message")).toString();
        const QString code = error.value(QStringLiteral("code")).toString();
        if (method == QStringLiteral("session.history"))
            m_openingSession = false;
        // session.subscribe against an OLDER daemon that predates the session manager:
        // swallow unknown_method. We keep the existing client-side session filter, so
        // delivery is just unscoped (the pre-fix behavior) rather than an error toast.
        if (method == QStringLiteral("session.subscribe"))
            return;
        // agent_desktop.info "no_agent_desktop" just means this session isn't
        // driving a nested desktop — clear the flag quietly (no error toast) and
        // revert the video bearer to the global engine's.
        if (method == QStringLiteral("agent_desktop.info")) {
            // Same stale-reply guard as the success branch: ignore a
            // no_agent_desktop that arrives for a session we already left.
            if (ctx.startsWith(QStringLiteral("__agentdesk__:"))
                && ctx.mid(QStringLiteral("__agentdesk__:").size()) != m_sessionId)
                return;
            m_videoBearer = computeUseBearer();
            setHasAgentDesktop(false);
            return;
        }
        // Wrong PIN → tell the LockGate to shake/clear the field (no error toast).
        if (method == QStringLiteral("auth.verify_pin")) {
            emit pinRejected();
            return;
        }
        // mcp.test failures surface through mcpTested, not a generic error toast.
        if (method == QStringLiteral("mcp.test")) {
            emit mcpTested(ctx, false, 0, msg.isEmpty() ? code : msg);
            return;
        }
        // 2FA unlock against an OLDER daemon that lacks auth.*: FAIL-OPEN so the
        // user is never locked out — treat unknown_method as "approved".
        if (code == QStringLiteral("unknown_method")
            && (method == QStringLiteral("auth.request")
                || method == QStringLiteral("auth.status"))) {
            if (method == QStringLiteral("auth.request"))
                emit authChallengeStarted(QString(), QStringLiteral("approved"), false);
            else
                emit authStateChanged(QString(), QStringLiteral("approved"));
            return;
        }
        if (code == QStringLiteral("unknown_method")
            && method == QStringLiteral("auth.deny"))
            return;
        // Forward-compatible COMPUTER-page control methods: the daemon may not
        // implement these yet (Wave 5 lands them). Swallow "unknown_method" so the
        // desktop preview/overlay degrade gracefully instead of toasting an error.
        if (code == QStringLiteral("unknown_method")
            && (method == QStringLiteral("mirror.start")
                || method == QStringLiteral("mirror.stop")
                || method == QStringLiteral("session.set_target")
                || method == QStringLiteral("take_over.cancel"))) {
            return;
        }
        // session.delete may not exist on an older daemon. Degrade quietly: still
        // emit sessionDeleted so the Sessions page drops the row optimistically
        // (a refresh will restore it if the daemon truly couldn't delete it).
        if (code == QStringLiteral("unknown_method")
            && method == QStringLiteral("session.delete")) {
            emit sessionDeleted(ctx);
            return;
        }
        // CLI MCP server toggles land on newer daemons only; on an older one degrade
        // to a clean empty CLI section instead of an error toast.
        if (code == QStringLiteral("unknown_method")
            && (method == QStringLiteral("mcp.cli_list")
                || method == QStringLiteral("mcp.cli_set_enabled"))) {
            if (method == QStringLiteral("mcp.cli_list"))
                emit mcpCliListed(QVariantList());
            return;
        }
        // Memory + skills (Contract A v3) land daemon-side in Wave 6. Until then
        // the daemon answers unknown_method; degrade the pages to a clean empty
        // state instead of a generic error toast.
        if (code == QStringLiteral("unknown_method")
            && (method.startsWith(QStringLiteral("memory."))
                || method.startsWith(QStringLiteral("skills.")))) {
            if (method == QStringLiteral("memory.list"))
                emit memoriesListed(QVariantList(), false);
            else if (method == QStringLiteral("memory.search"))
                emit memoriesListed(QVariantList(), true);
            else if (method == QStringLiteral("memory.graph"))
                emit memoryGraphLoaded(QVariantMap());
            else if (method == QStringLiteral("memory.entities.list"))
                emit memoryEntitiesListed(QVariantList());
            else if (method == QStringLiteral("skills.list"))
                emit skillsListed(QVariantList());
            else if (method == QStringLiteral("skills.today"))
                emit todayDigest(QString());
            return;
        }
        // Schedules / audit / diff-review land daemon-side later (these are
        // owned by other agents). Until then degrade to clean empty states /
        // best-effort results instead of an error toast.
        if (code == QStringLiteral("unknown_method")) {
            if (method == QStringLiteral("schedule.list")) {
                emit schedulesListed(QVariantList());
                return;
            }
            if (method.startsWith(QStringLiteral("schedule.")))
                return;
            if (method == QStringLiteral("audit.list")) {
                emit auditListed(QVariantList());
                return;
            }
            if (method.startsWith(QStringLiteral("diff."))) {
                emit diffActionResult(method.mid(5), ctx, false,
                                      QStringLiteral("not available yet"));
                return;
            }
        }
        // phone.mcp errors: surface through phoneResult (never a generic toast).
        if (method == QStringLiteral("phone.mcp")) {
            QVariantMap r;
            r.insert(QStringLiteral("error"), error);
            emit phoneResult(ctx, r);
            return;
        }
        // phone.http errors: surface through phoneHttpResult (never a generic toast).
        if (method == QStringLiteral("phone.http")) {
            QVariantMap r;
            r.insert(QStringLiteral("error"), error);
            emit phoneHttpResult(ctx, r);
            return;
        }
        // phone.config errors: surface through the config signals so the panel
        // shows the reason inline (a failed test -> reachable:false; a set
        // write_error -> its note; a get -> an empty config = "not set up"). Also
        // degrades an older daemon that predates phone.config (unknown_method).
        if (method == QStringLiteral("phone.config")) {
            if (ctx == QStringLiteral("set"))
                emit phoneConfigSaved(false, false, msg.isEmpty() ? code : msg);
            else if (ctx == QStringLiteral("test"))
                emit phoneConfigTested(false, false);
            else
                emit phoneConfigLoaded(QVariantMap());
            return;
        }
        // Outpost exec/screenshot can fail with the daemon's pairing / gating
        // tier errors; route those to the console/card rather than a toast so
        // the user sees the reason.
        if (method == QStringLiteral("outpost.exec")) {
            emit outpostExecResult(ctx, false, msg.isEmpty() ? code : (code + QStringLiteral(": ") + msg));
            return;
        }
        if (method == QStringLiteral("outpost.screenshot")) {
            emit outpostScreenshotResult(ctx, false, QString(),
                                         msg.isEmpty() ? code : (code + QStringLiteral(": ") + msg));
            return;
        }
        // Proxmox Workload Manager install/status/report/restart/blocklist errors
        // (not_a_proxmox_host, no_mistral_key, outpost_unreachable, ...) route to
        // their own result signals so the page can show the human message inline
        // instead of a generic toast.
        if (method == QStringLiteral("outpost.install_workload")) {
            emit outpostWorkloadInstalled(ctx, false, msg, code, QString(), QString());
            return;
        }
        if (method == QStringLiteral("proxmox.status")) {
            emit proxmoxStatusResult(ctx, false, QVariantList(), msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.report")) {
            emit proxmoxReportResult(ctx, false, QVariantList(), msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.restart_vm")) {
            QString rest;
            const QString machine = splitMachineCtx(ctx, &rest);
            emit proxmoxVmRestarted(machine, rest.toInt(), false, msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.set_blocklist")) {
            emit proxmoxBlocklistSet(ctx, false, QVariantList(), msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.scout")) {
            emit proxmoxScoutStarted(ctx, false, msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.scout_status")) {
            emit proxmoxScoutStatusResult(ctx, false, QVariantMap(), msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.vm_profile")) {
            QString rest;
            const QString machine = splitMachineCtx(ctx, &rest);
            emit proxmoxVmProfileResult(machine, rest.toInt(), false, QString(),
                                        msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.questions")) {
            emit proxmoxQuestionsResult(ctx, false, QVariantList(), msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.answer")) {
            QString qid;
            const QString machine = splitMachineCtx(ctx, &qid);
            emit proxmoxAnswerResult(machine, qid, false, msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.pinged_list")) {
            emit proxmoxPingedListResult(ctx, false, QVariantList(), QVariantList(),
                                         msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.pinged_add")) {
            emit proxmoxPingedAddResult(ctx, false, msg.isEmpty() ? code : msg);
            return;
        }
        if (method == QStringLiteral("proxmox.pinged_remove")) {
            emit proxmoxPingedRemoveResult(ctx, false, msg.isEmpty() ? code : msg);
            return;
        }
        // Voice STT failed (no key / network): clear the indicator quietly-ish.
        if (method == QStringLiteral("voice.stt")) {
            setRecordingState(QStringLiteral("idle"));
            if (ctx == QStringLiteral("__voicemode__")) {
                m_voiceModeStt = false;
                setVoiceState(QStringLiteral("idle"));
            }
        }
        if (method == QStringLiteral("voice.tts")) {
            m_ttsRequested = false;
            // A failed request still frees the in-flight slot; send the next so one
            // bad segment doesn't stall the rest of the queued replies.
            m_ttsReqInFlight = false;
            pumpTtsRequests();
            // Don't drop the orb to idle if an earlier clip is still speaking or
            // queued, or more requests are pending — one failed segment shouldn't
            // interrupt the rest of the reply.
            if (ctx == QStringLiteral("__voicemode__") && !m_ttsPlaying &&
                m_ttsQueue.isEmpty() && m_ttsReqQueue.isEmpty() && !m_ttsReqInFlight)
                setVoiceState(QStringLiteral("idle"));
        }
        // Named voice library actions: surface the reason in the card, no toast.
        if (method == QStringLiteral("voice.create_clone") ||
            method == QStringLiteral("voice.delete_clone") ||
            method == QStringLiteral("voice.set_default") ||
            method == QStringLiteral("voice.rename_clone") ||
            method == QStringLiteral("voice.preview_clone")) {
            if (method == QStringLiteral("voice.create_clone"))
                setVoiceCloneState(QStringLiteral("idle"));
            emit voiceCloneResult(false, msg.isEmpty() ? code : msg);
            return;
        }
        // If creating the session failed, drop any queued first message so it can't
        // later land in an unrelated session.
        if (method == QStringLiteral("session.create")) {
            m_pendingText.clear();
            m_pendingImages.clear();
            m_creatingSession = false;
        }
        emit errorOccurred(QStringLiteral("%1 failed: [%2] %3")
                               .arg(method.isEmpty() ? QStringLiteral("request") : method, code, msg));
        return;
    }

    // agent_desktop.info: the current session HAS a nested agent desktop — point
    // the live preview at its per-session engine and flag it so the in-chat peek
    // (and Home/Computer) can mirror it even for a plain chat (not just explicit
    // co-work). This is what makes "watch it live" work for ordinary sessions.
    if (method == QStringLiteral("agent_desktop.info")) {
        // Drop a stale/out-of-order reply: if the user switched sessions while
        // this query was in flight, applying it would point the peek/mirror at
        // the OLD session's nested desktop. The ctx was tagged with the session
        // the query was issued for (refreshAgentDesktop).
        if (ctx.startsWith(QStringLiteral("__agentdesk__:"))
            && ctx.mid(QStringLiteral("__agentdesk__:").size()) != m_sessionId)
            return;
        const int port = result.value(QStringLiteral("port")).toInt();
        if (port > 0)
            setVideoEndpoint(QStringLiteral("http://127.0.0.1:") + QString::number(port));
        // The per-session engine uses its OWN bearer; the global one gets 401 on
        // /video/frame. Use the session bearer for the preview poll while this
        // session is active.
        const QString bearer = result.value(QStringLiteral("bearer")).toString();
        if (!bearer.isEmpty())
            m_videoBearer = bearer;
        setHasAgentDesktop(true);
        return;
    }

    if (method == QStringLiteral("session.create")) {
        m_creatingSession = false;
        const QString sid = result.value(QStringLiteral("session_id")).toString();
        if (!sid.isEmpty()) {
            m_sessionId = sid;
            emit sessionIdChanged();
            syncSubscriptions();   // subscribe to the session we just created
            setStatus(QStringLiteral("session ready"));

            // Flush a message the user typed BEFORE any session existed (the
            // no-buttons auto-create flow queued it in sendMessage()). This makes
            // "type and hit send on a fresh chat" just work.
            if (!m_pendingText.isEmpty() || !m_pendingImages.isEmpty()) {
                const QString pending = m_pendingText;
                const QVariantList pendingImgs = m_pendingImages;
                m_pendingText.clear();
                m_pendingImages.clear();
                sendMessageWithImages(pending, pendingImgs);
            }

            // The engine url for this session's per-session computer-use engine,
            // if the daemon reports it (else the per-session-port default is used).
            const QString engineUrl = result.value(QStringLiteral("engine_url")).toString();
            if (!engineUrl.isEmpty())
                setVideoEndpoint(engineUrl);

            if (ctx == QStringLiteral("coworker:agent")) {
                // Co-worker on the NESTED agent desktop: wire it up + start the
                // local mirror preview immediately (the user keeps their screen).
                setCoworkerSessionId(sid);
                emit coworkerStarted(sid);
                mirrorStart();
            } else if (ctx == QStringLiteral("coworker:real")) {
                // REAL-screen take-over: the daemon now runs its approval flow;
                // `driving` stays false until it confirms via a driving.state
                // event. Surface the pending request so the UI can show it.
                emit takeOverRequested(sid);
                // If the daemon reports the take-over is already active (auto-
                // approved tier), honor it.
                if (result.value(QStringLiteral("driving")).toBool())
                    setDriving(true);
            }
        }
    } else if (method == QStringLiteral("model.list")) {
        QStringList models;
        const QVariant raw = result.value(QStringLiteral("models"));
        for (const QVariant &v : raw.toList())
            models << v.toString();
        const QString brain = result.value(QStringLiteral("brain")).toString();
        emit modelsListed(brain, models);
    } else if (method == QStringLiteral("voice.list_voices")) {
        emit voicesListed(result.value(QStringLiteral("voices")).toList());
        // Forward the per-provider extras so the picker has both provider lists
        // and a {provider: [voices]} map without a second round-trip.
        emit voiceProvidersListed(
            result.value(QStringLiteral("stt_providers")).toList(),
            result.value(QStringLiteral("tts_providers")).toList(),
            result.value(QStringLiteral("voices_by_provider")).toMap());
    } else if (method == QStringLiteral("settings.get")) {
        // Cache the preferred TTS voice slug so Voice Mode's speak() can pass it.
        m_ttsVoice = result.value(QStringLiteral("tts_voice")).toString();
        // Cache the STT/TTS provider so runtime voice calls pass it explicitly
        // (defense in depth — the daemon already defaults from settings).
        m_sttProvider = result.contains(QStringLiteral("stt_provider"))
                            ? result.value(QStringLiteral("stt_provider")).toString()
                            : QStringLiteral("voxtral");
        m_ttsProvider = result.contains(QStringLiteral("tts_provider"))
                            ? result.value(QStringLiteral("tts_provider")).toString()
                            : QStringLiteral("voxtral");
        // Cache the agent mode (plan|build|coworker) for the live HUD chip.
        {
            const QString am = result.contains(QStringLiteral("agent_mode"))
                                   ? result.value(QStringLiteral("agent_mode")).toString()
                                   : QStringLiteral("coworker");
            if (am != m_agentMode) {
                m_agentMode = am;
                emit agentModeChanged();
            }
        }
        // Sync the desktop notifications toggle from persisted settings.
        const QVariantMap n = result.value(QStringLiteral("notifications")).toMap();
        if (n.contains(QStringLiteral("enabled"))) {
            const bool en = n.value(QStringLiteral("enabled")).toBool();
            if (en != m_notify) {
                m_notify = en;
                emit notificationsChanged();
            }
        }
        emit settingsLoaded(result);
    } else if (method == QStringLiteral("settings.set")) {
        emit settingsSaved();
    } else if (method == QStringLiteral("update.check")) {
        emit updateChecked(result.value(QStringLiteral("current")).toString(),
                           result.value(QStringLiteral("latest")).toString(),
                           result.value(QStringLiteral("behind")).toBool(),
                           result.value(QStringLiteral("version")).toString(),
                           result.value(QStringLiteral("reason")).toString());
    } else if (method == QStringLiteral("update.apply")) {
        emit updateApplied(result.value(QStringLiteral("updated")).toBool(),
                           result.value(QStringLiteral("to")).toString(),
                           result.value(QStringLiteral("reason")).toString());
    } else if (method == QStringLiteral("auth.request")) {
        // FAIL-OPEN is folded into the result: paired=false + state="approved"
        // means no phone is paired, so the LockGate unlocks immediately.
        emit authChallengeStarted(result.value(QStringLiteral("challenge_id")).toString(),
                                  result.value(QStringLiteral("state")).toString(),
                                  result.value(QStringLiteral("paired")).toBool());
    } else if (method == QStringLiteral("auth.status")) {
        emit authStateChanged(result.value(QStringLiteral("challenge_id")).toString(),
                              result.value(QStringLiteral("state")).toString());
    } else if (method == QStringLiteral("auth.verify_pin")) {
        // Correct PIN: the daemon already broadcast the unlock, but emit locally
        // too so the LockGate clears instantly.
        emit authStateChanged(result.value(QStringLiteral("challenge_id")).toString(),
                              QStringLiteral("approved"));
    } else if (method == QStringLiteral("policy.list")) {
        emit policyListed(result);
    } else if (method == QStringLiteral("policy.add")
               || method == QStringLiteral("policy.update")
               || method == QStringLiteral("policy.remove")
               || method == QStringLiteral("policy.set_default")) {
        emit policyChanged();
        policyList(); // refresh the Settings card after a mutation
    } else if (method == QStringLiteral("policy.test")) {
        emit policyTested(result.value(QStringLiteral("action")).toString(),
                          result.value(QStringLiteral("rule_id")).toString(),
                          result.value(QStringLiteral("note")).toString());
    } else if (method == QStringLiteral("mcp.list")) {
        emit mcpListed(result.value(QStringLiteral("servers")).toList());
    } else if (method == QStringLiteral("mcp.add")
               || method == QStringLiteral("mcp.remove")
               || method == QStringLiteral("mcp.set_enabled")) {
        emit mcpChanged();
        listMcp(); // refresh the list after a mutation
    } else if (method == QStringLiteral("mcp.test")) {
        emit mcpTested(ctx,
                       result.value(QStringLiteral("ok")).toBool(),
                       result.value(QStringLiteral("tools_count")).toInt(),
                       result.value(QStringLiteral("error")).toString());
    } else if (method == QStringLiteral("mcp.cli_list")) {
        emit mcpCliListed(result.value(QStringLiteral("servers")).toList());
    } else if (method == QStringLiteral("mcp.cli_set_enabled")) {
        // Importing/removing a CLI server changed the registry; the page re-queries
        // the CLI list (and may also refresh the Jarvis list) on mcpCliChanged.
        emit mcpCliChanged();
    } else if (method == QStringLiteral("connectors.list")) {
        emit connectorsListed(result.value(QStringLiteral("connectors")).toList());
    } else if (method == QStringLiteral("connectors.add")) {
        emit connectorsChanged();
        connectorsList(); // refresh the list after a mutation
    } else if (method == QStringLiteral("plugins.catalog")) {
        emit pluginsListed(result.value(QStringLiteral("plugins")).toList());
    } else if (method == QStringLiteral("plugins.install")
               || method == QStringLiteral("plugins.set_enabled")
               || method == QStringLiteral("plugins.remove")) {
        emit pluginsChanged();
        loadPlugins(); // refresh the catalog after a mutation
    } else if (method == QStringLiteral("session.list")) {
        const QVariantList sessions = result.value(QStringLiteral("sessions")).toList();
        if (ctx == QStringLiteral("__subtree__"))
            emit subAgentTree(buildSubAgentTree(sessions));
        else
            emit sessionsListed(sessions);
    } else if (method == QStringLiteral("session.delete")) {
        // ctx carries the deleted session id; the Sessions page refreshes on it.
        emit sessionDeleted(ctx);
    } else if (method == QStringLiteral("session.history")
               && ctx.startsWith(QStringLiteral("__replay__:"))) {
        // Mission Control Replay (jarvis#66): ungated (any session) + keeps ts.
        QVariantList events;
        for (const QVariant &v : result.value(QStringLiteral("events")).toList()) {
            const QVariantMap row = v.toMap();
            QVariantMap evm = row.value(QStringLiteral("ev")).toMap();
            evm.insert(QStringLiteral("seq"), row.value(QStringLiteral("seq")));
            evm.insert(QStringLiteral("ts"), row.value(QStringLiteral("ts")));
            events << evm;
        }
        emit replayLoaded(result.value(QStringLiteral("session")).toMap(), events);
    } else if (method == QStringLiteral("session.history")) {
        // events: [{seq,ts,ev:{kind,...}}] — fold the inner ev out for QML.
        QVariantList events;
        for (const QVariant &v : result.value(QStringLiteral("events")).toList()) {
            const QVariantMap row = v.toMap();
            QVariantMap evm = row.value(QStringLiteral("ev")).toMap();
            evm.insert(QStringLiteral("seq"), row.value(QStringLiteral("seq")));
            events << evm;
        }
        const QString sid = ctx.isEmpty()
                                ? result.value(QStringLiteral("session")).toMap()
                                      .value(QStringLiteral("id")).toString()
                                : ctx;
        m_openingSession = false;
        // Drop a stale history reply: if the user already moved on (+ New cleared
        // m_sessionId, or opened a different session) while this async fetch was in
        // flight, replaying it would paint the old session's content into a chat
        // that no longer belongs to it. Only replay history for the CURRENT session.
        if (sid != m_sessionId) {
            qInfo("Bridge[session]: DROP stale session.history for %s (current=%s)",
                  qPrintable(sid), qPrintable(m_sessionId));
            return;
        }
        emit sessionHistory(sid, events);
    } else if (method == QStringLiteral("memory.list")) {
        emit memoriesListed(result.value(QStringLiteral("memories")).toList(), false);
    } else if (method == QStringLiteral("memory.search")) {
        emit memoriesListed(result.value(QStringLiteral("memories")).toList(), true);
    } else if (method == QStringLiteral("memory.add")
               || method == QStringLiteral("memory.remove")) {
        emit memoryChanged();
        memoryList(); // refresh the list after a mutation
    } else if (method == QStringLiteral("memory.graph")) {
        emit memoryGraphLoaded(result);
    } else if (method == QStringLiteral("memory.entities.list")) {
        emit memoryEntitiesListed(result.value(QStringLiteral("entities")).toList());
    } else if (method == QStringLiteral("memory.entity.get")) {
        emit memoryEntityLoaded(result);
    } else if (method == QStringLiteral("memory.link")) {
        emit memoryChanged();
        memoryGraph(); // refresh the graph after a manual edge edit
    } else if (method == QStringLiteral("skills.list")) {
        emit skillsListed(result.value(QStringLiteral("skills")).toList());
    } else if (method == QStringLiteral("skills.get")) {
        emit skillLoaded(ctx,
                         result.value(QStringLiteral("frontmatter")).toMap(),
                         result.value(QStringLiteral("body")).toString(),
                         result.value(QStringLiteral("path")).toString());
    } else if (method == QStringLiteral("skills.create")
               || method == QStringLiteral("skills.remove")) {
        emit skillsChanged();
        skillsList(); // re-index after a self-authoring write / removal
    } else if (method == QStringLiteral("skills.list_archived")) {
        emit skillsArchivedListed(result.value(QStringLiteral("skills")).toList());
    } else if (method == QStringLiteral("skills.pin")) {
        skillsList(); // refresh the pinned badges
    } else if (method == QStringLiteral("skills.unarchive")) {
        emit skillsChanged();
        skillsList();         // restored skill joins the live list...
        skillsListArchived(); // ...and leaves the archive section
    } else if (method == QStringLiteral("skills.invoke")) {
        emit skillInvoked(ctx, result.value(QStringLiteral("message")).toString());
    } else if (method == QStringLiteral("skills.today")) {
        emit todayDigest(result.value(QStringLiteral("digest")).toString());
    } else if (method == QStringLiteral("agents.list")) {
        emit agentsListed(result.value(QStringLiteral("agents")).toList());
    } else if (method == QStringLiteral("agents.get")) {
        emit agentLoaded(ctx,
                         result.value(QStringLiteral("frontmatter")).toMap(),
                         result.value(QStringLiteral("system_prompt")).toString(),
                         result.value(QStringLiteral("path")).toString());
    } else if (method == QStringLiteral("agents.create")
               || method == QStringLiteral("agents.remove")) {
        emit agentsChanged();
        agentsList(); // re-index after a write / removal
    } else if (method == QStringLiteral("agents.dispatch")) {
        emit agentDispatched(result.value(QStringLiteral("session_id")).toString(),
                             result.value(QStringLiteral("agent")).toString());
    } else if (method == QStringLiteral("schedule.list")) {
        emit schedulesListed(result.value(QStringLiteral("schedules")).toList());
    } else if (method == QStringLiteral("schedule.create")
               || method == QStringLiteral("schedule.remove")
               || method == QStringLiteral("schedule.set_enabled")
               || method == QStringLiteral("schedule.run_now")) {
        emit schedulesChanged();
        scheduleList();   // refresh after a mutation
    } else if (method == QStringLiteral("outpost.list")) {
        emit outpostMachinesListed(result.value(QStringLiteral("machines")).toList());
    } else if (method == QStringLiteral("outpost.pair_start")) {
        emit outpostPairStarted(result);
    } else if (method == QStringLiteral("outpost.pair_status")) {
        emit outpostPairStatusResult(result);
    } else if (method == QStringLiteral("outpost.exec")) {
        const bool ook = result.contains(QStringLiteral("ok"))
                             ? result.value(QStringLiteral("ok")).toBool() : true;
        QString outText = result.value(QStringLiteral("output")).toString();
        if (!ook && outText.isEmpty()) {
            outText = result.value(QStringLiteral("error")).toString();
        }
        emit outpostExecResult(ctx, ook, outText);
    } else if (method == QStringLiteral("outpost.screenshot")) {
        const bool ook = result.contains(QStringLiteral("ok"))
                             ? result.value(QStringLiteral("ok")).toBool() : true;
        emit outpostScreenshotResult(ctx, ook,
                                     result.value(QStringLiteral("image_base64")).toString(),
                                     result.value(QStringLiteral("error")).toString());
    } else if (method == QStringLiteral("outpost.revoke")) {
        const bool ook = result.contains(QStringLiteral("ok"))
                             ? result.value(QStringLiteral("ok")).toBool() : true;
        emit outpostRevoked(ctx, ook);
        if (ook)
            outpostList();   // refresh the list after a successful revoke
    } else if (method == QStringLiteral("outpost.install_workload")) {
        emit outpostWorkloadInstalled(ctx, true, result.value(QStringLiteral("note")).toString(),
                                      QString(), result.value(QStringLiteral("session_id")).toString(),
                                      result.value(QStringLiteral("session_title")).toString());
    } else if (method == QStringLiteral("proxmox.status")) {
        emit proxmoxStatusResult(ctx, true, result.value(QStringLiteral("vms")).toList(), QString());
    } else if (method == QStringLiteral("proxmox.report")) {
        emit proxmoxReportResult(ctx, true, result.value(QStringLiteral("memories")).toList(),
                                 QString());
    } else if (method == QStringLiteral("proxmox.restart_vm")) {
        QString rest;
        const QString machine = splitMachineCtx(ctx, &rest);
        const int vmid = rest.isEmpty() ? result.value(QStringLiteral("vmid")).toInt()
                                        : rest.toInt();
        emit proxmoxVmRestarted(machine, vmid, true, QString());
    } else if (method == QStringLiteral("proxmox.set_blocklist")) {
        emit proxmoxBlocklistSet(ctx, true, result.value(QStringLiteral("vmids")).toList(), QString());
    } else if (method == QStringLiteral("proxmox.scout")) {
        emit proxmoxScoutStarted(ctx, true, QString());
    } else if (method == QStringLiteral("proxmox.scout_status")) {
        emit proxmoxScoutStatusResult(ctx, true,
                                      result.value(QStringLiteral("scout")).toMap(), QString());
    } else if (method == QStringLiteral("proxmox.vm_profile")) {
        QString rest;
        const QString machine = splitMachineCtx(ctx, &rest);
        const int vmid = rest.isEmpty() ? result.value(QStringLiteral("vmid")).toInt()
                                        : rest.toInt();
        emit proxmoxVmProfileResult(machine, vmid, true,
                                    result.value(QStringLiteral("profile")).toString(),
                                    QString());
    } else if (method == QStringLiteral("proxmox.questions")) {
        emit proxmoxQuestionsResult(ctx, true,
                                    result.value(QStringLiteral("questions")).toList(), QString());
    } else if (method == QStringLiteral("proxmox.answer")) {
        QString rest;
        const QString machine = splitMachineCtx(ctx, &rest);
        const QString qid = rest.isEmpty() ? result.value(QStringLiteral("qid")).toString() : rest;
        emit proxmoxAnswerResult(machine, qid, true, QString());
    } else if (method == QStringLiteral("proxmox.pinged_list")) {
        emit proxmoxPingedListResult(ctx, true,
                                     result.value(QStringLiteral("rules")).toList(),
                                     result.value(QStringLiteral("events")).toList(), QString());
    } else if (method == QStringLiteral("proxmox.pinged_add")) {
        emit proxmoxPingedAddResult(ctx, true, QString());
    } else if (method == QStringLiteral("proxmox.pinged_remove")) {
        emit proxmoxPingedRemoveResult(ctx, true, QString());
    } else if (method == QStringLiteral("audit.list")) {
        emit auditListed(result.value(QStringLiteral("entries")).toList());
    } else if (method == QStringLiteral("diff.stage")
               || method == QStringLiteral("diff.revert")
               || method == QStringLiteral("diff.commit")
               || method == QStringLiteral("diff.open_pr")) {
        const QString action = method.mid(5);   // strip "diff."
        const bool dok = result.contains(QStringLiteral("ok"))
                             ? result.value(QStringLiteral("ok")).toBool() : true;
        QString detail = result.value(QStringLiteral("message")).toString();
        if (detail.isEmpty())
            detail = result.value(QStringLiteral("url")).toString();
        emit diffActionResult(action, ctx, dok, detail);
        if (m_notify && action == QStringLiteral("open_pr")) {
            const QString url = result.value(QStringLiteral("url")).toString();
            if (!url.isEmpty())
                notify(QStringLiteral("Pull request opened"), url);
        }
    } else if (method == QStringLiteral("voice.stt")) {
        const QString text = result.value(QStringLiteral("text")).toString();
        if (ctx == QStringLiteral("__voicemode__")) {
            // Voice MODE round-trip: surface the transcript on the orb AND auto-send
            // it to the voice session so the model answers. Stay in "thinking" until
            // the assistant replies (the page speaks the reply -> "speaking").
            m_voiceModeStt = false;
            emit sttText(text);
            if (!text.trimmed().isEmpty()) {
                if (m_voiceSessionId.isEmpty())
                    m_voiceSessionId = m_sessionId;
                sendMessage(text.trimmed());
            } else if (m_handsFree) {
                resumeListening();
            } else {
                setVoiceState(QStringLiteral("idle"));
            }
            return;
        }
        setRecordingState(QStringLiteral("idle"));
        emit voiceTranscribed(text);
    } else if (method == QStringLiteral("voice.tts")) {
        m_ttsRequested = false;
        // This request is done — free the slot and send the next queued TTS so the
        // audio keeps arriving in strict request order.
        m_ttsReqInFlight = false;
        const QByteArray audio = QByteArray::fromBase64(
            result.value(QStringLiteral("audio_b64")).toString().toLatin1());
        if (!audio.isEmpty()) {
            // BOTH voice mode AND the chat "Speak replies" toggle now play through
            // the SAME single shared QMediaPlayer + FIFO queue (playTtsAudio). This
            // is the fix for clips talking over each other ACROSS messages: the old
            // chat path wrote one fixed temp file and spawned a NEW external player
            // per reply with no queue, so a second reply overwrote the file mid-read
            // and a second player ran at once. Now every clip — every segment AND
            // every separate message — is appended to one queue and drained one at a
            // time, so message 1 finishes completely before message 2 begins.
            playTtsAudio(audio, result.value(QStringLiteral("mime")).toString());
        }
        pumpTtsRequests();   // kick off the next queued request, if any
        if (audio.isEmpty()) {
            // Empty audio for one segment must NOT cut the conversation back to
            // listening while an earlier clip is still speaking or queued, or while
            // more requests are pending — only the queue draining ends the turn.
            if (ctx == QStringLiteral("__voicemode__") && !m_ttsPlaying &&
                m_ttsQueue.isEmpty() && m_ttsReqQueue.isEmpty() && !m_ttsReqInFlight) {
                if (m_handsFree)
                    resumeListening();
                else
                    setVoiceState(QStringLiteral("idle"));
            }
        }
        return;
    } else if (method == QStringLiteral("voice.preview_clone")) {
        // Synthesized sample for the picker's "▶ Preview" — play it like any TTS.
        const QByteArray audio = QByteArray::fromBase64(
            result.value(QStringLiteral("audio_b64")).toString().toLatin1());
        if (!audio.isEmpty())
            playTtsAudio(audio, result.value(QStringLiteral("mime")).toString());
        return;
    } else if (method == QStringLiteral("voice.create_clone") ||
               method == QStringLiteral("voice.delete_clone") ||
               method == QStringLiteral("voice.set_default") ||
               method == QStringLiteral("voice.rename_clone")) {
        if (method == QStringLiteral("voice.create_clone")) {
            setVoiceCloneState(QStringLiteral("idle"));
            m_voiceClipBytes.clear(); // consumed
        }
        // Keep the cached default in sync so Voice Mode's speak() uses the new one.
        if (result.contains(QStringLiteral("default")))
            m_ttsVoice = result.value(QStringLiteral("default")).toString();
        emit voiceLibraryChanged(result.value(QStringLiteral("voices")).toList(),
                                 result.value(QStringLiteral("default")).toString());
        emit voiceCloneResult(true, QString());
        return;
    } else if (method == QStringLiteral("devices.pair_start")) {
        // { code, payload, qr_svg, expires_at }
        const QString qrSvg = result.value(QStringLiteral("qr_svg")).toString();
        const QString code = result.value(QStringLiteral("code")).toString();
        const QString payload = result.value(QStringLiteral("payload")).toString();
        // expires_at may arrive as epoch seconds (number) or an ISO string; the UI
        // only needs a numeric epoch for the countdown, so coerce defensively.
        const QVariant exp = result.value(QStringLiteral("expires_at"));
        emit pairingStarted(qrSvg, code, payload, exp.toDouble());
    } else if (method == QStringLiteral("extension.pair_start")) {
        // { code, expires_at, control_port } — one-paste extension pairing code.
        emit extensionPairingStarted(
            result.value(QStringLiteral("code")).toString(),
            result.value(QStringLiteral("expires_at")).toDouble());
    } else if (method == QStringLiteral("devices.list")) {
        emit devicesListed(result.value(QStringLiteral("devices")).toList());
    } else if (method == QStringLiteral("devices.revoke")) {
        emit devicesChanged();
        devicesList(); // refresh the paired-device list after a revoke
    } else if (method == QStringLiteral("phone.mcp")) {
        // Echo the result back to QML tagged with the caller's callId (ctx).
        // result is already the parsed { tool, data, text, error? } payload.
        emit phoneResult(ctx, result);
    } else if (method == QStringLiteral("phone.http")) {
        // Echo the result back to QML tagged with the caller's callId (ctx).
        // result shape: {status:int, data:<obj|array>, text?}.
        emit phoneHttpResult(ctx, result);
    } else if (method == QStringLiteral("phone.config")) {
        // ctx is the action ("get"|"set"|"test") we tagged the request with.
        if (ctx == QStringLiteral("set")) {
            emit phoneConfigSaved(result.value(QStringLiteral("ok")).toBool(),
                                  result.value(QStringLiteral("restarted")).toBool(),
                                  result.value(QStringLiteral("note")).toString());
        } else if (ctx == QStringLiteral("test")) {
            emit phoneConfigTested(result.value(QStringLiteral("reachable")).toBool(),
                                   result.value(QStringLiteral("twilio_configured")).toBool());
        } else {
            emit phoneConfigLoaded(result);
        }
    }
    // ping / session.send / session.cancel / approval.respond: ack only.
}
