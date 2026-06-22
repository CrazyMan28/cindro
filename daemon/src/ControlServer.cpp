#include "ControlServer.h"

#include "jarvis/Brain.h"
#include "jarvis/CodexBrain.h"

#include <QDateTime>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRandomGenerator>
#include <QUrl>
#include <QUrlQuery>
#include <QWebSocket>
#include <QWebSocketServer>

namespace jarvis {

namespace {

QString genSessionId()
{
    // 16 random bytes hex => collision-safe session id.
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(16, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("sess_") + QString::fromLatin1(bytes.toHex());
}

} // namespace

ControlServer::ControlServer(Config config, QString controlToken, QObject *parent)
    : QObject(parent), m_config(std::move(config)), m_controlToken(std::move(controlToken))
{
}

ControlServer::~ControlServer()
{
    if (m_wsServer)
        m_wsServer->close();
    qDeleteAll(m_brains);
    m_brains.clear();
}

bool ControlServer::start()
{
    if (!m_store.open()) {
        m_lastError = QStringLiteral("failed to open session store: ") + m_store.lastError();
        return false;
    }

    m_wsServer = new QWebSocketServer(QStringLiteral("jarvisd-control"),
                                      QWebSocketServer::NonSecureMode, this);
    connect(m_wsServer, &QWebSocketServer::newConnection,
            this, &ControlServer::onNewConnection);

    if (!m_wsServer->listen(QHostAddress::LocalHost, quint16(m_config.controlPort))) {
        m_lastError = QStringLiteral("failed to listen on 127.0.0.1:") +
                      QString::number(m_config.controlPort) + QStringLiteral(": ") +
                      m_wsServer->errorString();
        return false;
    }
    return true;
}

void ControlServer::onNewConnection()
{
    while (m_wsServer->hasPendingConnections()) {
        QWebSocket *client = m_wsServer->nextPendingConnection();

        // Loopback-only: reject anything not from localhost.
        const QHostAddress peer = client->peerAddress();
        if (peer != QHostAddress(QHostAddress::LocalHost) &&
            peer != QHostAddress(QHostAddress::LocalHostIPv6)) {
            client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                          QStringLiteral("loopback only"));
            client->deleteLater();
            continue;
        }

        // Verify request path and ?token=.
        const QUrl url = client->requestUrl();
        const QUrlQuery query(url);
        const QString token = query.queryItemValue(QStringLiteral("token"));
        if (url.path() != QStringLiteral("/control/ws") || token != m_controlToken) {
            client->close(QWebSocketProtocol::CloseCodePolicyViolated,
                          QStringLiteral("unauthorized"));
            client->deleteLater();
            continue;
        }

        connect(client, &QWebSocket::textMessageReceived,
                this, &ControlServer::onTextMessage);
        connect(client, &QWebSocket::disconnected,
                this, &ControlServer::onSocketDisconnected);

        m_clients.insert(client);
    }
}

void ControlServer::onSocketDisconnected()
{
    auto *client = qobject_cast<QWebSocket *>(sender());
    if (!client)
        return;
    m_clients.remove(client);
    client->deleteLater();
}

void ControlServer::onTextMessage(const QString &message)
{
    auto *client = qobject_cast<QWebSocket *>(sender());
    if (!client)
        return;

    QJsonParseError perr{};
    const QJsonDocument doc = QJsonDocument::fromJson(message.toUtf8(), &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject()) {
        sendResponse(client, Response::failure(0, QStringLiteral("bad_request"),
                                               QStringLiteral("malformed JSON frame")));
        return;
    }

    auto req = Request::fromJson(doc.object());
    if (!req) {
        sendResponse(client, Response::failure(0, QStringLiteral("bad_request"),
                                               QStringLiteral("not a valid v1 request")));
        return;
    }
    handleRequest(client, *req);
}

void ControlServer::sendResponse(QWebSocket *client, const Response &resp)
{
    if (!client)
        return;
    client->sendTextMessage(
        QString::fromUtf8(QJsonDocument(resp.toJson()).toJson(QJsonDocument::Compact)));
}

void ControlServer::handleRequest(QWebSocket *client, const Request &req)
{
    Response resp;
    const QString &m = req.method;

    if (m == QStringLiteral("ping"))
        resp = handlePing(req);
    else if (m == QStringLiteral("settings.get"))
        resp = handleSettingsGet(req);
    else if (m == QStringLiteral("settings.set"))
        resp = handleSettingsSet(req);
    else if (m == QStringLiteral("model.list"))
        resp = handleModelList(req);
    else if (m == QStringLiteral("session.create"))
        resp = handleSessionCreate(req);
    else if (m == QStringLiteral("session.send"))
        resp = handleSessionSend(req);
    else if (m == QStringLiteral("session.cancel"))
        resp = handleSessionCancel(req);
    else if (m == QStringLiteral("session.list"))
        resp = handleSessionList(req);
    else if (m == QStringLiteral("session.history"))
        resp = handleSessionHistory(req);
    else if (m == QStringLiteral("approval.respond"))
        resp = handleApprovalRespond(req);
    else
        resp = Response::failure(req.id, QStringLiteral("unknown_method"),
                                 QStringLiteral("unknown method: ") + m);

    sendResponse(client, resp);
}

// --- method handlers -------------------------------------------------------

Response ControlServer::handlePing(const Request &req)
{
    QJsonObject result;
    result.insert(QStringLiteral("pong"), true);
    result.insert(QStringLiteral("ts"), QDateTime::currentMSecsSinceEpoch());
    return Response::success(req.id, result);
}

Response ControlServer::handleSettingsGet(const Request &req)
{
    QJsonObject s;
    s.insert(QStringLiteral("default_brain"), m_config.defaultBrain);
    s.insert(QStringLiteral("default_model"), m_config.defaultModel);
    QJsonObject ports;
    ports.insert(QStringLiteral("control"), m_config.controlPort);
    ports.insert(QStringLiteral("device"), m_config.devicePort);
    s.insert(QStringLiteral("ports"), ports);
    s.insert(QStringLiteral("default_cwd"), m_config.effectiveCwd());
    return Response::success(req.id, s);
}

Response ControlServer::handleSettingsSet(const Request &req)
{
    const QJsonObject patch = req.params.value(QStringLiteral("patch")).toObject();
    if (patch.contains(QStringLiteral("default_brain")))
        m_config.defaultBrain = patch.value(QStringLiteral("default_brain")).toString();
    if (patch.contains(QStringLiteral("default_model")))
        m_config.defaultModel = patch.value(QStringLiteral("default_model")).toString();
    if (patch.contains(QStringLiteral("default_cwd")))
        m_config.defaultCwd = patch.value(QStringLiteral("default_cwd")).toString();
    return handleSettingsGet(req);
}

Response ControlServer::handleModelList(const Request &req)
{
    const QString brain = req.params.value(QStringLiteral("brain")).toString(m_config.defaultBrain);
    QJsonArray models;
    if (brain == QStringLiteral("codex")) {
        models << QStringLiteral("gpt-5.5") << QStringLiteral("gpt-5.5-codex")
               << QStringLiteral("o4-mini");
    } else if (brain == QStringLiteral("claude")) {
        models << QStringLiteral("claude-opus-4-8") << QStringLiteral("claude-sonnet-4-5");
    } else {
        models << m_config.defaultModel;
    }
    QJsonObject result;
    result.insert(QStringLiteral("brain"), brain);
    result.insert(QStringLiteral("models"), models);
    return Response::success(req.id, result);
}

Brain *ControlServer::makeBrain(const SessionRow &row)
{
    if (row.brain == QStringLiteral("codex")) {
        CodexBrain::Options opts;
        opts.cwd = m_config.effectiveCwd();
        opts.model = row.model;
        opts.profile = row.profile;
        opts.sandboxMode = CodexBrain::sandboxForProfile(row.profile);
        auto *brain = new CodexBrain(opts, this);
        brain->setSessionId(row.id);
        return brain;
    }
    // claude / api brains arrive in Wave 5.
    return nullptr;
}

Response ControlServer::handleSessionCreate(const Request &req)
{
    const QJsonObject p = req.params;
    SessionRow row;
    row.id = genSessionId();
    row.profile = p.value(QStringLiteral("profile")).toString(QStringLiteral("coder"));
    row.brain = p.value(QStringLiteral("brain")).toString(m_config.defaultBrain);
    row.model = p.value(QStringLiteral("model")).toString(m_config.defaultModel);
    row.title = p.value(QStringLiteral("title")).toString(QStringLiteral("Untitled session"));
    row.state = QStringLiteral("idle");
    row.created = QDateTime::currentMSecsSinceEpoch();
    row.updated = row.created;

    // cwd override is honored for the brain spawn (kept in config snapshot).
    const QString cwd = p.value(QStringLiteral("cwd")).toString();

    if (!m_store.create(row)) {
        return Response::failure(req.id, QStringLiteral("store_error"),
                                 m_store.lastError());
    }

    Brain *brain = makeBrain(row);
    if (!brain) {
        m_store.updateState(row.id, QStringLiteral("error"));
        return Response::failure(req.id, QStringLiteral("unsupported_brain"),
                                 QStringLiteral("brain not available: ") + row.brain);
    }
    if (!cwd.isEmpty()) {
        if (auto *cb = qobject_cast<CodexBrain *>(brain)) {
            // Rebuild with cwd override; CodexBrain stores opts internally so
            // we recreate it to keep the override authoritative.
            CodexBrain::Options opts;
            opts.cwd = cwd;
            opts.model = row.model;
            opts.profile = row.profile;
            opts.sandboxMode = CodexBrain::sandboxForProfile(row.profile);
            cb->deleteLater();
            cb = new CodexBrain(opts, this);
            cb->setSessionId(row.id);
            brain = cb;
        }
    }
    connect(brain, &Brain::event, this, &ControlServer::onBrainEvent);
    m_brains.insert(row.id, brain);

    QJsonObject result;
    result.insert(QStringLiteral("session_id"), row.id);
    if (!row.threadId.isEmpty())
        result.insert(QStringLiteral("thread_id"), row.threadId);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionSend(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();

    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown or inactive session: ") + sessionId);
    }

    QStringList images;
    for (const QJsonValue &v : req.params.value(QStringLiteral("images")).toArray())
        images << v.toString();

    m_store.updateState(sessionId, QStringLiteral("running"));
    brain->send(text, images);

    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionCancel(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown or inactive session: ") + sessionId);
    }
    brain->cancel();
    m_store.updateState(sessionId, QStringLiteral("idle"));
    return Response::success(req.id);
}

Response ControlServer::handleSessionList(const Request &req)
{
    QJsonArray arr;
    for (const SessionRow &row : m_store.list())
        arr.append(row.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("sessions"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionHistory(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const int limit = req.params.value(QStringLiteral("limit")).toInt(0);

    auto sess = m_store.get(sessionId);
    if (!sess) {
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown session: ") + sessionId);
    }

    QJsonArray events;
    for (const StoredEvent &se : m_store.listEvents(sessionId, limit)) {
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

Response ControlServer::handleApprovalRespond(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString approvalId = req.params.value(QStringLiteral("approval_id")).toString();
    const QString decision = req.params.value(QStringLiteral("decision")).toString();

    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown or inactive session: ") + sessionId);
    }
    brain->respondApproval(approvalId, decision);
    return Response::success(req.id);
}

// --- event fan-out ---------------------------------------------------------

void ControlServer::onBrainEvent(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    // Persist first so history is durable even if no client is connected.
    m_store.appendEvent(sessionId, ev);

    // Mirror brain lifecycle into the session row state.
    if (ev.kind == NormalizedBrainEvent::Kind::ThreadStarted) {
        const QString threadId = ev.threadId();
        if (!threadId.isEmpty())
            m_store.updateThreadId(sessionId, threadId);
    } else if (ev.kind == NormalizedBrainEvent::Kind::Final) {
        m_store.updateState(sessionId, QStringLiteral("idle"));
    } else if (ev.kind == NormalizedBrainEvent::Kind::Error) {
        m_store.updateState(sessionId, QStringLiteral("error"));
    }

    broadcastSessionEvent(sessionId, ev);
}

void ControlServer::broadcastSessionEvent(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    const QJsonObject frame = makeSessionEventFrame(sessionId, ev);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
}

} // namespace jarvis
