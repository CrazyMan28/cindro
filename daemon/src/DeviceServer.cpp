#include "DeviceServer.h"

#include "ControlServer.h"

#include "jarvis/DeviceRegistry.h"
#include "jarvis/FcmSender.h"
#include "jarvis/PairingManager.h"
#include "jarvis/SessionStore.h"

#include <sodium.h>

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkInterface>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QUrl>
#include <QWebSocket>
#include <QWebSocketServer>

namespace jarvis {

namespace {

QString genTaskId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(8, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("task_") + QString::fromLatin1(bytes.toHex());
}

QByteArray makeNonce()
{
    unsigned char buf[32];
    randombytes_buf(buf, sizeof(buf));
    return QByteArray(reinterpret_cast<const char *>(buf), sizeof(buf));
}

} // namespace

DeviceServer::DeviceServer(Config config, ControlServer *control, QObject *parent)
    : QObject(parent), m_config(std::move(config)), m_control(control)
{
    m_nam = new QNetworkAccessManager(this);
}

DeviceServer::~DeviceServer()
{
    // Abort any in-flight mirror pumps before the NAM goes away.
    const QStringList pumps = m_pumps.keys();
    for (const QString &sid : pumps)
        stopPump(sid);
    if (m_local)
        m_local->close();
    if (m_tailnet)
        m_tailnet->close();
}

bool DeviceServer::start()
{
    const quint16 port = quint16(m_config.devicePort);

    m_local = new QWebSocketServer(QStringLiteral("jarvisd-device-local"),
                                   QWebSocketServer::NonSecureMode, this);
    connect(m_local, &QWebSocketServer::newConnection,
            this, &DeviceServer::onNewConnection);
    const bool localOk = m_local->listen(QHostAddress::LocalHost, port);
    if (!localOk) {
        m_lastError = QStringLiteral("device WS failed to bind 127.0.0.1:") +
                      QString::number(port) + QStringLiteral(": ") +
                      m_local->errorString();
    }

    // Best-effort bind on the tailnet IP so the phone can reach us off-host.
    const QString tailnet = ControlServer::tailnetHost();
    if (tailnet != QStringLiteral("127.0.0.1")) {
        m_tailnet = new QWebSocketServer(QStringLiteral("jarvisd-device-tailnet"),
                                         QWebSocketServer::NonSecureMode, this);
        connect(m_tailnet, &QWebSocketServer::newConnection,
                this, &DeviceServer::onNewConnection);
        if (!m_tailnet->listen(QHostAddress(tailnet), port)) {
            // Non-fatal: keep the loopback listener.
            m_tailnet->deleteLater();
            m_tailnet = nullptr;
        }
    }

    // Fan brain events out to subscribed device sockets + push.
    if (m_control) {
        connect(m_control, &ControlServer::sessionEvent,
                this, &DeviceServer::onSessionEvent);
        // device->phone file push -> 'file.offer' event to phones.
        connect(m_control, &ControlServer::filePushed,
                this, &DeviceServer::onFilePushed);
    }

    return localOk || m_tailnet != nullptr;
}

void DeviceServer::onNewConnection()
{
    auto *server = qobject_cast<QWebSocketServer *>(sender());
    if (!server)
        return;
    while (server->hasPendingConnections()) {
        QWebSocket *client = server->nextPendingConnection();
        if (client->requestUrl().path() != QStringLiteral("/device/ws")) {
            client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                          QStringLiteral("bad path"));
            client->deleteLater();
            continue;
        }
        connect(client, &QWebSocket::textMessageReceived,
                this, &DeviceServer::onTextMessage);
        connect(client, &QWebSocket::disconnected,
                this, &DeviceServer::onSocketDisconnected);
        m_conns.insert(client, Conn{});
    }
}

void DeviceServer::onSocketDisconnected()
{
    auto *client = qobject_cast<QWebSocket *>(sender());
    if (!client)
        return;
    // Drop this device's mirror subscriptions (decrement / close each pump).
    if (auto it = m_conns.find(client); it != m_conns.end()) {
        const QSet<QString> mirrored = it.value().mirroring;
        for (const QString &sid : mirrored)
            stopPump(sid);
    }
    m_conns.remove(client);
    client->deleteLater();
}

void DeviceServer::onTextMessage(const QString &message)
{
    auto *client = qobject_cast<QWebSocket *>(sender());
    if (!client || !m_conns.contains(client))
        return;
    Conn &c = m_conns[client];

    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8(), &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject()) {
        sendResponse(client, Response::failure(0, QStringLiteral("bad_request"),
                                               QStringLiteral("malformed JSON frame")));
        return;
    }
    const QJsonObject obj = doc.object();

    if (!c.authed) {
        // Handshake frames are not Contract A requests; route by shape.
        if (obj.contains(QStringLiteral("hello"))) {
            handleHello(client, c, obj);
        } else if (obj.contains(QStringLiteral("sig"))) {
            handleChallengeResponse(client, c, obj);
        } else {
            sendResponse(client, Response::failure(
                0, QStringLiteral("unauthorized"),
                QStringLiteral("handshake required before requests")));
        }
        return;
    }

    auto req = Request::fromJson(obj);
    if (!req) {
        sendResponse(client, Response::failure(0, QStringLiteral("bad_request"),
                                               QStringLiteral("not a valid v1 request")));
        return;
    }
    dispatchAuthed(client, c, *req);
}

void DeviceServer::handleHello(QWebSocket *client, Conn &c, const QJsonObject &obj)
{
    const QByteArray pubkey = QByteArray::fromBase64(
        obj.value(QStringLiteral("device_pubkey")).toString().toLatin1());
    c.name = obj.value(QStringLiteral("name")).toString(QStringLiteral("device"));

    if (pubkey.size() != int(crypto_sign_PUBLICKEYBYTES)) {
        sendResponse(client, Response::failure(
            0, QStringLiteral("bad_pubkey"),
            QStringLiteral("device_pubkey must be a 32-byte ed25519 key")));
        client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                      QStringLiteral("bad pubkey"));
        return;
    }
    c.pubkey = pubkey;

    const QString pairCode = obj.value(QStringLiteral("pair_code")).toString();
    if (!pairCode.isEmpty()) {
        // Pairing path: code must match an active devices.pair_start code.
        if (!m_control->pairing().consume(pairCode)) {
            sendResponse(client, Response::failure(
                0, QStringLiteral("bad_pair_code"),
                QStringLiteral("invalid or expired pairing code")));
            client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                          QStringLiteral("bad pair code"));
            return;
        }
        const DeviceRow row = m_control->devices().pair(pubkey, c.name);
        c.authed = true;
        c.deviceId = row.id;

        QJsonObject ack;
        ack.insert(QStringLiteral("ok"), true);
        ack.insert(QStringLiteral("paired"), true);
        ack.insert(QStringLiteral("device_id"), row.id);
        ack.insert(QStringLiteral("fp"), m_control->devices().identityFingerprint());
        ack.insert(QStringLiteral("capabilities"), capabilityMap());
        sendJson(client, ack);
        return;
    }

    // Already-paired path: the device must be known and prove ownership of its
    // stored key by signing a fresh challenge.
    const QString deviceId = DeviceRegistry::fingerprintFor(pubkey);
    auto known = m_control->devices().get(deviceId);
    if (!known) {
        sendResponse(client, Response::failure(
            0, QStringLiteral("not_paired"),
            QStringLiteral("device not paired; include pair_code")));
        client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                      QStringLiteral("not paired"));
        return;
    }
    c.deviceId = deviceId;
    c.challenge = makeNonce();

    QJsonObject ch;
    ch.insert(QStringLiteral("challenge"),
              QString::fromLatin1(c.challenge.toBase64()));
    sendJson(client, ch);
}

void DeviceServer::handleChallengeResponse(QWebSocket *client, Conn &c, const QJsonObject &obj)
{
    if (c.challenge.isEmpty() || c.deviceId.isEmpty()) {
        sendResponse(client, Response::failure(
            0, QStringLiteral("no_challenge"),
            QStringLiteral("send hello first")));
        return;
    }
    const QByteArray sig = QByteArray::fromBase64(
        obj.value(QStringLiteral("sig")).toString().toLatin1());

    if (!m_control->devices().verify(c.deviceId, c.challenge, sig)) {
        sendResponse(client, Response::failure(
            0, QStringLiteral("bad_signature"),
            QStringLiteral("challenge signature did not verify")));
        client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                      QStringLiteral("bad signature"));
        return;
    }

    c.authed = true;
    c.challenge.clear();
    m_control->devices().touch(c.deviceId);

    QJsonObject ack;
    ack.insert(QStringLiteral("ok"), true);
    ack.insert(QStringLiteral("authed"), true);
    ack.insert(QStringLiteral("device_id"), c.deviceId);
    ack.insert(QStringLiteral("capabilities"), capabilityMap());
    sendJson(client, ack);
}

// --- capability tiers -------------------------------------------------------

QString DeviceServer::tierFor(const QString &method)
{
    if (method == QStringLiteral("session.list") ||
        method == QStringLiteral("session.history") ||
        method == QStringLiteral("task.list") ||
        method == QStringLiteral("memory.list") ||
        method == QStringLiteral("memory.search") ||
        method == QStringLiteral("skills.list") ||
        method == QStringLiteral("skills.get") ||
        method == QStringLiteral("skills.today") ||
        // Wave 8 ops reads.
        method == QStringLiteral("schedule.list") ||
        method == QStringLiteral("ssh.allow_list") ||
        method == QStringLiteral("audit.list") ||
        // Full config surface — reads are read tier.
        method == QStringLiteral("settings.get") ||
        method == QStringLiteral("model.list") ||
        method == QStringLiteral("mcp.list") ||
        method == QStringLiteral("plugins.catalog") ||
        method == QStringLiteral("devices.list") ||
        method == QStringLiteral("agent_desktop.info") ||
        method == QStringLiteral("file.get"))
        return QStringLiteral("read");
    if (method == QStringLiteral("session.create") ||
        method == QStringLiteral("session.send") ||
        method == QStringLiteral("session.cancel") ||
        method == QStringLiteral("session.delete") ||
        method == QStringLiteral("task.queue") ||
        method == QStringLiteral("push.register") ||
        method == QStringLiteral("memory.add") ||
        method == QStringLiteral("memory.remove") ||
        method == QStringLiteral("skills.create") ||
        method == QStringLiteral("skills.invoke") ||
        method == QStringLiteral("skills.remove") ||
        // Wave 8 ops actions that aren't security-sensitive (toggling/removing a
        // schedule, managing the ssh allow-list). schedule.create + ssh.exec are
        // biometric (below).
        method == QStringLiteral("schedule.set_enabled") ||
        method == QStringLiteral("schedule.remove") ||
        method == QStringLiteral("ssh.allow_add") ||
        method == QStringLiteral("ssh.allow_remove") ||
        // Config actions that aren't security-sensitive.
        method == QStringLiteral("mcp.remove") ||
        method == QStringLiteral("mcp.set_enabled") ||
        method == QStringLiteral("mcp.test") ||
        method == QStringLiteral("plugins.install") ||
        method == QStringLiteral("plugins.set_enabled") ||
        method == QStringLiteral("plugins.remove") ||
        method == QStringLiteral("devices.pair_start") ||
        method == QStringLiteral("voice.stt") ||
        method == QStringLiteral("voice.tts") ||
        method == QStringLiteral("file.push"))
        return QStringLiteral("action");
    if (method == QStringLiteral("approval.respond") ||
        method == QStringLiteral("mirror.start") ||
        method == QStringLiteral("mirror.stop") ||
        // Security-sensitive config: settings.set, mcp.add, devices.revoke,
        // and real-screen take-over require a biometric confirmation.
        method == QStringLiteral("settings.set") ||
        method == QStringLiteral("mcp.add") ||
        method == QStringLiteral("devices.revoke") ||
        method == QStringLiteral("take_over.request") ||
        // Wave 8: a scheduled job runs unattended, and ssh.exec runs a remote
        // command — both are biometric-tier on the phone.
        method == QStringLiteral("schedule.create") ||
        method == QStringLiteral("ssh.exec"))
        return QStringLiteral("biometric");
    return QStringLiteral("action");
}

QJsonObject DeviceServer::capabilityMap()
{
    const QStringList methods = {
        QStringLiteral("session.list"),    QStringLiteral("session.create"),
        QStringLiteral("session.send"),    QStringLiteral("session.cancel"),
        QStringLiteral("session.delete"),
        QStringLiteral("session.history"), QStringLiteral("task.queue"),
        QStringLiteral("task.list"),       QStringLiteral("push.register"),
        QStringLiteral("approval.respond"),
        QStringLiteral("mirror.start"),    QStringLiteral("mirror.stop"),
        // Contract A v3 mirrored to the phone: memory + self-authored skills.
        QStringLiteral("memory.list"),     QStringLiteral("memory.search"),
        QStringLiteral("memory.add"),      QStringLiteral("memory.remove"),
        QStringLiteral("skills.list"),     QStringLiteral("skills.get"),
        QStringLiteral("skills.create"),   QStringLiteral("skills.invoke"),
        QStringLiteral("skills.remove"),   QStringLiteral("skills.today"),
        // Wave 8 co-worker ops mirrored to the phone: scheduler, ssh allow-list
        // + gated exec, and the audit log. schedule.create + ssh.exec biometric.
        QStringLiteral("schedule.create"), QStringLiteral("schedule.list"),
        QStringLiteral("schedule.set_enabled"), QStringLiteral("schedule.remove"),
        QStringLiteral("ssh.allow_list"),  QStringLiteral("ssh.allow_add"),
        QStringLiteral("ssh.allow_remove"), QStringLiteral("ssh.exec"),
        QStringLiteral("audit.list"),
        // FULL Contract-C config surface: the phone can configure everything.
        QStringLiteral("settings.get"),    QStringLiteral("settings.set"),
        QStringLiteral("model.list"),
        QStringLiteral("mcp.list"),        QStringLiteral("mcp.add"),
        QStringLiteral("mcp.remove"),      QStringLiteral("mcp.set_enabled"),
        QStringLiteral("mcp.test"),
        QStringLiteral("plugins.catalog"), QStringLiteral("plugins.install"),
        QStringLiteral("plugins.set_enabled"), QStringLiteral("plugins.remove"),
        QStringLiteral("devices.pair_start"), QStringLiteral("devices.list"),
        QStringLiteral("devices.revoke"),  QStringLiteral("agent_desktop.info"),
        QStringLiteral("take_over.request"),
        // Voice (Mistral Voxtral, laptop-proxied) + device->phone file push.
        QStringLiteral("voice.stt"),       QStringLiteral("voice.tts"),
        QStringLiteral("file.push"),       QStringLiteral("file.get"),
    };
    QJsonObject map;
    for (const QString &m : methods)
        map.insert(m, tierFor(m));
    return map;
}

// --- authed dispatch --------------------------------------------------------

void DeviceServer::dispatchAuthed(QWebSocket *client, Conn &c, const Request &req)
{
    const QString &m = req.method;
    Response resp;

    if (m == QStringLiteral("ping")) {
        QJsonObject r;
        r.insert(QStringLiteral("pong"), true);
        resp = Response::success(req.id, r);
    } else if (m == QStringLiteral("session.list")) {
        resp = devSessionList(req);
    } else if (m == QStringLiteral("session.create")) {
        resp = devSessionCreate(c, req);
    } else if (m == QStringLiteral("session.send")) {
        resp = devSessionSend(c, req);
    } else if (m == QStringLiteral("session.cancel")) {
        resp = devSessionCancel(req);
    } else if (m == QStringLiteral("session.delete")) {
        resp = devSessionDelete(req);
    } else if (m == QStringLiteral("session.history")) {
        resp = devSessionHistory(req);
    } else if (m == QStringLiteral("task.queue")) {
        resp = devTaskQueue(c, req);
    } else if (m == QStringLiteral("task.list")) {
        resp = devTaskList(c, req);
    } else if (m == QStringLiteral("push.register")) {
        resp = devPushRegister(c, req);
    } else if (m == QStringLiteral("approval.respond")) {
        resp = devApprovalRespond(req);
    } else if (m == QStringLiteral("mirror.start")) {
        resp = devMirrorStart(c, client, req);
    } else if (m == QStringLiteral("mirror.stop")) {
        resp = devMirrorStop(c, client, req);
    } else if (ControlServer::isMemoryOrSkillMethod(m)) {
        // Contract A v3 mirror: memory + skills share the SAME store as the
        // desktop, so the phone curates one coherent memory/skill world.
        resp = m_control->dispatchMemoryOrSkill(req);
    } else if (ControlServer::isOpsMethod(m)) {
        // Wave 8 co-worker ops mirror: schedule.* / ssh.* / audit.list share the
        // same SQLite tables + allow-list as the desktop. `remote=true` so the
        // audit log records that the action originated from a paired device, and
        // ssh.exec/schedule.create were biometric-gated on the phone.
        resp = m_control->dispatchOpsMethod(req, /*remote=*/true);
    } else if (ControlServer::isConfigMethod(m)) {
        // FULL Contract-C exposure: settings/model/mcp/plugins/voice/devices/
        // take_over/file.* all mirror to the phone via the SAME ControlServer
        // machinery, so the phone configures one coherent world. Biometric-tier
        // methods are gated on the phone before they're sent.
        // A device that pushes a session-scoped file should also RECEIVE the
        // resulting file.offer event, so subscribe it to that session first.
        if (m == QStringLiteral("file.push")) {
            const QString sid = req.params.value(QStringLiteral("session_id")).toString();
            if (!sid.isEmpty())
                c.subscribedSessions.insert(sid);
        }
        resp = m_control->dispatchConfigMethod(req);
    } else {
        resp = Response::failure(req.id, QStringLiteral("unknown_method"),
                                 QStringLiteral("unknown method: ") + m);
    }
    sendResponse(client, resp);
}

Response DeviceServer::devSessionList(const Request &req)
{
    QJsonArray arr;
    for (const SessionRow &row : m_control->store().list())
        arr.append(row.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("sessions"), arr);
    return Response::success(req.id, result);
}

Response DeviceServer::devSessionCreate(Conn &c, const Request &req)
{
    const QJsonObject p = req.params;
    QString err;
    const QString sessionId = m_control->createSession(
        p.value(QStringLiteral("profile")).toString(),
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("cwd")).toString(),
        p.value(QStringLiteral("title")).toString(),
        &err);
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("session_create_failed"), err);

    // Subscribe this device socket to the new session's event stream.
    c.subscribedSessions.insert(sessionId);

    QJsonObject result;
    result.insert(QStringLiteral("session_id"), sessionId);
    // Surface the nested agent desktop (coworker+agent) so the phone knows it
    // can mirror.start this session's live video.
    if (const AgentDesktopInfo desk = m_control->agentDesktopFor(sessionId); desk.up)
        result.insert(QStringLiteral("agent_desktop"), desk.toJson());
    return Response::success(req.id, result);
}

QStringList DeviceServer::storeImages(const QString &sessionId, const QJsonArray &images)
{
    QStringList paths;
    if (images.isEmpty())
        return paths;

    const QString dir = QDir::homePath() +
                        QStringLiteral("/.local/share/jarvis/inbox/") + sessionId;
    QDir().mkpath(dir);

    int idx = 0;
    for (const QJsonValue &v : images) {
        const QJsonObject img = v.toObject();
        const QString mime = img.value(QStringLiteral("mime")).toString(QStringLiteral("image/png"));
        const QByteArray bytes = QByteArray::fromBase64(
            img.value(QStringLiteral("b64")).toString().toLatin1());
        if (bytes.isEmpty())
            continue;
        QString ext = QStringLiteral("png");
        if (mime.contains(QStringLiteral("jpeg")) || mime.contains(QStringLiteral("jpg")))
            ext = QStringLiteral("jpg");
        else if (mime.contains(QStringLiteral("webp")))
            ext = QStringLiteral("webp");
        const QString path = QStringLiteral("%1/%2_%3.%4")
                                 .arg(dir)
                                 .arg(QDateTime::currentMSecsSinceEpoch())
                                 .arg(idx++)
                                 .arg(ext);
        QFile f(path);
        if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            f.write(bytes);
            f.close();
            paths << path;
        }
    }
    return paths;
}

Response DeviceServer::devSessionSend(Conn &c, const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();

    // images: [{mime,b64}] -> store + forward as on-disk paths.
    const QStringList images =
        storeImages(sessionId, req.params.value(QStringLiteral("images")).toArray());

    QString err;
    if (!m_control->sendToSession(sessionId, text, images, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);

    // Ensure this device gets the stream even if it didn't create the session.
    c.subscribedSessions.insert(sessionId);

    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    return Response::success(req.id, result);
}

Response DeviceServer::devSessionCancel(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    QString err;
    if (!m_control->cancelSession(sessionId, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    return Response::success(req.id);
}

Response DeviceServer::devSessionDelete(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id required"));
    QString err;
    if (!m_control->deleteSession(sessionId, &err))
        return Response::failure(req.id, QStringLiteral("session_delete_failed"), err);
    QJsonObject result;
    result.insert(QStringLiteral("deleted"), true);
    result.insert(QStringLiteral("session_id"), sessionId);
    return Response::success(req.id, result);
}

Response DeviceServer::devSessionHistory(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const int limit = req.params.value(QStringLiteral("limit")).toInt(0);

    auto sess = m_control->store().get(sessionId);
    if (!sess)
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown session: ") + sessionId);

    QJsonArray events;
    for (const StoredEvent &se : m_control->store().listEvents(sessionId, limit)) {
        QJsonObject e;
        e.insert(QStringLiteral("seq"), se.seq);
        e.insert(QStringLiteral("ts"), se.ts);
        e.insert(QStringLiteral("ev"), se.ev.toJson());
        events.append(e);
    }
    QJsonObject result;
    result.insert(QStringLiteral("session"), sess->toJson());
    result.insert(QStringLiteral("events"), events);
    return Response::success(req.id, result);
}

Response DeviceServer::devTaskQueue(Conn &c, const Request &req)
{
    const QString text = req.params.value(QStringLiteral("text")).toString();
    if (text.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("text is required"));

    TaskRow t;
    t.id = genTaskId();
    t.deviceId = c.deviceId;
    t.text = text;
    // `when` accepts a unix-ms timestamp; absent/<=0 => run asap.
    t.whenAt = qint64(req.params.value(QStringLiteral("when")).toDouble(0));
    t.state = QStringLiteral("queued");
    t.created = QDateTime::currentMSecsSinceEpoch();
    t.updated = t.created;

    if (!m_control->store().createTask(t))
        return Response::failure(req.id, QStringLiteral("store_error"),
                                 m_control->store().lastError());

    QJsonObject result;
    result.insert(QStringLiteral("task_id"), t.id);
    result.insert(QStringLiteral("state"), t.state);
    return Response::success(req.id, result);
}

Response DeviceServer::devTaskList(Conn &c, const Request &req)
{
    QJsonArray arr;
    for (const TaskRow &t : m_control->store().listTasks(c.deviceId))
        arr.append(t.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("tasks"), arr);
    return Response::success(req.id, result);
}

Response DeviceServer::devPushRegister(Conn &c, const Request &req)
{
    const QString token = req.params.value(QStringLiteral("fcm_token")).toString();
    if (token.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("fcm_token is required"));
    PushTokenRow row;
    row.deviceId = c.deviceId;
    row.fcmToken = token;
    row.updated = QDateTime::currentMSecsSinceEpoch();
    if (!m_control->store().upsertPushToken(row))
        return Response::failure(req.id, QStringLiteral("store_error"),
                                 m_control->store().lastError());

    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("backend"),
                  m_control->fcm() ? m_control->fcm()->backendName() : QString());
    return Response::success(req.id, result);
}

Response DeviceServer::devApprovalRespond(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString approvalId = req.params.value(QStringLiteral("approval_id")).toString();
    const QString decision = req.params.value(QStringLiteral("decision")).toString();
    QString err;
    if (!m_control->respondApprovalFor(sessionId, approvalId, decision, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    return Response::success(req.id);
}

// --- Contract C video mirror (biometric) ------------------------------------

Response DeviceServer::devMirrorStart(Conn &c, QWebSocket *client, const Request &req)
{
    Q_UNUSED(client);
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id is required"));

    // Only a coworker+agent session has a nested desktop to mirror.
    const AgentDesktopInfo desk = m_control->agentDesktopFor(sessionId);
    if (!desk.up)
        return Response::failure(req.id, QStringLiteral("no_agent_desktop"),
                                 QStringLiteral("session has no nested agent desktop: ") +
                                     sessionId);

    if (!c.mirroring.contains(sessionId)) {
        c.mirroring.insert(sessionId);
        startPump(sessionId); // ref-counted; opens the MJPEG read once
    }

    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("session_id"), sessionId);
    result.insert(QStringLiteral("width"), desk.width);
    result.insert(QStringLiteral("height"), desk.height);
    // Phones decode the binary 'mirror.frame' frames (length-prefixed JSON
    // header + JPEG); advertise the framing so the client knows what to expect.
    result.insert(QStringLiteral("frame_format"), QStringLiteral("jpeg"));
    result.insert(QStringLiteral("transport"), QStringLiteral("binary"));
    return Response::success(req.id, result);
}

Response DeviceServer::devMirrorStop(Conn &c, QWebSocket *client, const Request &req)
{
    Q_UNUSED(client);
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    if (c.mirroring.remove(sessionId))
        stopPump(sessionId); // ref-counted; closes when the last subscriber drops
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

void DeviceServer::startPump(const QString &sessionId)
{
    MirrorPump &pump = m_pumps[sessionId];
    ++pump.refcount;
    if (pump.reply)
        return; // already streaming

    const QString base = m_control->agentDesktops().engineBase(sessionId);
    const QString bearer = m_control->agentDesktops().bearer(sessionId);
    if (base.isEmpty()) {
        m_pumps.remove(sessionId);
        return;
    }
    const QUrl url(base + QStringLiteral("/video/mjpeg"));
    QNetworkRequest rq(url);
    if (!bearer.isEmpty())
        rq.setRawHeader("Authorization", QByteArray("Bearer ") + bearer.toUtf8());
    rq.setRawHeader("Accept", "multipart/x-mixed-replace");

    QNetworkReply *reply = m_nam->get(rq);
    pump.reply = reply;
    pump.buf.clear();
    pump.boundary.clear();
    m_pumpReply.insert(reply, sessionId);
    connect(reply, &QNetworkReply::readyRead, this, &DeviceServer::onPumpReadyRead);
    connect(reply, &QNetworkReply::finished, this, &DeviceServer::onPumpFinished);
}

void DeviceServer::stopPump(const QString &sessionId)
{
    auto it = m_pumps.find(sessionId);
    if (it == m_pumps.end())
        return;
    MirrorPump &pump = it.value();
    if (pump.refcount > 0)
        --pump.refcount;
    if (pump.refcount > 0)
        return; // other devices still mirroring
    if (pump.reply) {
        QNetworkReply *reply = pump.reply;
        m_pumpReply.remove(reply);
        reply->disconnect(this);
        reply->abort();
        reply->deleteLater();
    }
    m_pumps.erase(it);
}

void DeviceServer::onPumpReadyRead()
{
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply)
        return;
    const QString sessionId = m_pumpReply.value(reply);
    auto it = m_pumps.find(sessionId);
    if (it == m_pumps.end())
        return;
    MirrorPump &pump = it.value();
    pump.buf += reply->readAll();

    // Parse multipart/x-mixed-replace: each part is
    //   --<boundary>\r\n <headers> \r\n\r\n <jpeg bytes> \r\n
    // We extract JPEGs by the SOI/EOI markers (FFD8 .. FFD9) which is robust to
    // boundary/header variance from the engine's video_source generator.
    while (true) {
        const int soi = pump.buf.indexOf(QByteArray::fromHex("ffd8"));
        if (soi < 0) {
            // No start marker yet; cap buffer so it can't grow unbounded.
            if (pump.buf.size() > (1 << 20))
                pump.buf = pump.buf.right(1 << 16);
            break;
        }
        const int eoi = pump.buf.indexOf(QByteArray::fromHex("ffd9"), soi + 2);
        if (eoi < 0)
            break; // incomplete frame; wait for more bytes
        const QByteArray jpeg = pump.buf.mid(soi, eoi + 2 - soi);
        pump.buf.remove(0, eoi + 2);
        emitMirrorFrame(sessionId, jpeg);
    }
}

void DeviceServer::onPumpFinished()
{
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply)
        return;
    const QString sessionId = m_pumpReply.value(reply);
    m_pumpReply.remove(reply);
    auto it = m_pumps.find(sessionId);
    if (it != m_pumps.end() && it.value().reply == reply) {
        it.value().reply = nullptr;
        // If subscribers remain, transparently re-open the stream (the engine's
        // MJPEG endpoint can close between turns); otherwise drop the pump.
        if (it.value().refcount > 0) {
            const int refs = it.value().refcount;
            it.value().refcount = 0; // startPump re-increments per subscriber
            m_pumps.erase(it);
            for (int i = 0; i < refs; ++i)
                startPump(sessionId);
        } else {
            m_pumps.erase(it);
        }
    }
    reply->deleteLater();
}

void DeviceServer::emitMirrorFrame(const QString &sessionId, const QByteArray &jpeg)
{
    // Binary frame layout (Contract C video):
    //   [4-byte big-endian header length][header JSON utf8][JPEG bytes]
    // header = {"t":"mirror.frame","session_id":..,"ts":..,"len":..}
    QJsonObject header;
    header.insert(QStringLiteral("t"), QStringLiteral("mirror.frame"));
    header.insert(QStringLiteral("session_id"), sessionId);
    header.insert(QStringLiteral("ts"), QDateTime::currentMSecsSinceEpoch());
    header.insert(QStringLiteral("len"), jpeg.size());
    const QByteArray hdr =
        QJsonDocument(header).toJson(QJsonDocument::Compact);

    QByteArray frame;
    const quint32 hlen = quint32(hdr.size());
    frame.append(char((hlen >> 24) & 0xFF));
    frame.append(char((hlen >> 16) & 0xFF));
    frame.append(char((hlen >> 8) & 0xFF));
    frame.append(char(hlen & 0xFF));
    frame.append(hdr);
    frame.append(jpeg);

    for (auto cit = m_conns.begin(); cit != m_conns.end(); ++cit) {
        Conn &c = cit.value();
        if (c.authed && c.mirroring.contains(sessionId))
            sendBinary(cit.key(), frame);
    }
}

// --- event fan-out + push ---------------------------------------------------

void DeviceServer::onSessionEvent(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    // Stream to every authed device subscribed to this session.
    const QJsonObject frame = makeSessionEventFrame(sessionId, ev);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (auto it = m_conns.begin(); it != m_conns.end(); ++it) {
        Conn &c = it.value();
        if (c.authed && c.subscribedSessions.contains(sessionId))
            it.key()->sendTextMessage(payload);
    }

    // Push on attention-needing events: an approval is required, a turn
    // finished, or the brain produced a diff (file ready). FCM goes to every
    // registered token (the phone routes on data.kind).
    PushMessage msg;
    bool wantPush = false;
    if (ev.kind == NormalizedBrainEvent::Kind::Approval) {
        wantPush = true;
        msg.title = QStringLiteral("Approval needed");
        msg.body = ev.fields.value(QStringLiteral("summary")).toString(
            QStringLiteral("Jarvis needs your approval"));
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("approval"));
        msg.data.insert(QStringLiteral("approval_id"),
                        ev.fields.value(QStringLiteral("approval_id")));
    } else if (ev.kind == NormalizedBrainEvent::Kind::Final) {
        wantPush = true;
        msg.title = QStringLiteral("Task done");
        msg.body = QStringLiteral("A Jarvis session finished its turn.");
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("done"));
    } else if (ev.kind == NormalizedBrainEvent::Kind::Diff) {
        wantPush = true;
        msg.title = QStringLiteral("File ready");
        msg.body = ev.fields.value(QStringLiteral("path")).toString(
            QStringLiteral("A file was produced."));
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("file"));
        msg.data.insert(QStringLiteral("path"), ev.fields.value(QStringLiteral("path")));
    }

    if (wantPush && m_control && m_control->fcm()) {
        msg.data.insert(QStringLiteral("session_id"), sessionId);
        for (const PushTokenRow &t : m_control->store().listPushTokens())
            m_control->fcm()->send(t.fcmToken, msg);
    }
}

void DeviceServer::onFilePushed(const QJsonObject &descriptor)
{
    // Emit a Contract C 'file.offer' event so phones know a file is downloadable
    // via file.get{file_id, session_id?}. The local path is NOT sent.
    QJsonObject data = descriptor;
    data.remove(QStringLiteral("path"));

    QJsonObject frame;
    frame.insert(QStringLiteral("v"), kProtocolVersion);
    frame.insert(QStringLiteral("event"), QStringLiteral("file.offer"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));

    const QString sessionId = descriptor.value(QStringLiteral("session_id")).toString();
    for (auto it = m_conns.begin(); it != m_conns.end(); ++it) {
        Conn &c = it.value();
        if (!c.authed)
            continue;
        // Deliver to phones subscribed to this session, or to all when the file
        // isn't tied to a session.
        if (sessionId.isEmpty() || c.subscribedSessions.contains(sessionId))
            it.key()->sendTextMessage(payload);
    }

    // Also push a notification so the phone surfaces the new file when backgrounded.
    if (m_control && m_control->fcm()) {
        PushMessage msg;
        msg.title = QStringLiteral("File ready");
        msg.body = descriptor.value(QStringLiteral("name"))
                       .toString(QStringLiteral("A file is ready to download."));
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("file_offer"));
        msg.data.insert(QStringLiteral("file_id"),
                        descriptor.value(QStringLiteral("file_id")));
        if (!sessionId.isEmpty())
            msg.data.insert(QStringLiteral("session_id"), sessionId);
        for (const PushTokenRow &t : m_control->store().listPushTokens())
            m_control->fcm()->send(t.fcmToken, msg);
    }
}

// --- helpers ----------------------------------------------------------------

void DeviceServer::sendJson(QWebSocket *client, const QJsonObject &obj)
{
    if (!client)
        return;
    client->sendTextMessage(
        QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void DeviceServer::sendBinary(QWebSocket *client, const QByteArray &bytes)
{
    if (!client)
        return;
    client->sendBinaryMessage(bytes);
}

void DeviceServer::sendResponse(QWebSocket *client, const Response &resp)
{
    sendJson(client, resp.toJson());
}

} // namespace jarvis
