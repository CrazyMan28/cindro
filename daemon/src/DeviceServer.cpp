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
#include <QNetworkInterface>
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
}

DeviceServer::~DeviceServer()
{
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
    if (m_control)
        connect(m_control, &ControlServer::sessionEvent,
                this, &DeviceServer::onSessionEvent);

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
        method == QStringLiteral("task.list"))
        return QStringLiteral("read");
    if (method == QStringLiteral("session.create") ||
        method == QStringLiteral("session.send") ||
        method == QStringLiteral("session.cancel") ||
        method == QStringLiteral("task.queue") ||
        method == QStringLiteral("push.register"))
        return QStringLiteral("action");
    if (method == QStringLiteral("approval.respond"))
        return QStringLiteral("biometric");
    return QStringLiteral("action");
}

QJsonObject DeviceServer::capabilityMap()
{
    const QStringList methods = {
        QStringLiteral("session.list"),    QStringLiteral("session.create"),
        QStringLiteral("session.send"),    QStringLiteral("session.cancel"),
        QStringLiteral("session.history"), QStringLiteral("task.queue"),
        QStringLiteral("task.list"),       QStringLiteral("push.register"),
        QStringLiteral("approval.respond"),
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

// --- helpers ----------------------------------------------------------------

void DeviceServer::sendJson(QWebSocket *client, const QJsonObject &obj)
{
    if (!client)
        return;
    client->sendTextMessage(
        QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void DeviceServer::sendResponse(QWebSocket *client, const Response &resp)
{
    sendJson(client, resp.toJson());
}

} // namespace jarvis
