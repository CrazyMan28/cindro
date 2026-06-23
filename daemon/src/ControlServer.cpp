#include "ControlServer.h"

#include "jarvis/Brain.h"
#include "jarvis/CodexBrain.h"

#include <QDateTime>
#include <QDir>
#include <QEventLoop>
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
#include <QTextStream>
#include <QTimer>
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
    // Kill every nested agent desktop + its bound engine.
    m_agentDesktops.teardownAll();
}

bool ControlServer::start()
{
    if (!m_store.open()) {
        m_lastError = QStringLiteral("failed to open session store: ") + m_store.lastError();
        return false;
    }

    // Contract A v2 stores/registries. SettingsStore loads config.toml prefs +
    // secrets.json; the registries wrap the (now-open) SessionStore tables.
    m_settings.load();
    // Keep the in-memory config in sync with persisted prefs.
    m_config.defaultBrain = m_settings.defaultBrain();
    m_config.defaultModel = m_settings.defaultModel();
    m_mcp = std::make_unique<McpRegistry>(m_store);
    m_plugins = std::make_unique<PluginRegistry>(m_store);
    m_plugins->ensureSeeded(); // seed sample manifests if the catalog is empty

    // Contract C: load paired devices + ensure the daemon ed25519 identity, and
    // pick the best available FCM push backend (real if a "baratone" service
    // account is reachable, else a logging stub).
    m_deviceReg.load();
    m_fcm = FcmSender::makeDefault();

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
    else if (m == QStringLiteral("mcp.list"))
        resp = handleMcpList(req);
    else if (m == QStringLiteral("mcp.add"))
        resp = handleMcpAdd(req);
    else if (m == QStringLiteral("mcp.remove"))
        resp = handleMcpRemove(req);
    else if (m == QStringLiteral("mcp.set_enabled"))
        resp = handleMcpSetEnabled(req);
    else if (m == QStringLiteral("mcp.test"))
        resp = handleMcpTest(req);
    else if (m == QStringLiteral("plugins.catalog"))
        resp = handlePluginsCatalog(req);
    else if (m == QStringLiteral("plugins.install"))
        resp = handlePluginsInstall(req);
    else if (m == QStringLiteral("plugins.set_enabled"))
        resp = handlePluginsSetEnabled(req);
    else if (m == QStringLiteral("plugins.remove"))
        resp = handlePluginsRemove(req);
    else if (m == QStringLiteral("devices.pair_start"))
        resp = handleDevicesPairStart(req);
    else if (m == QStringLiteral("devices.list"))
        resp = handleDevicesList(req);
    else if (m == QStringLiteral("devices.revoke"))
        resp = handleDevicesRevoke(req);
    else if (m == QStringLiteral("agent_desktop.info"))
        resp = handleAgentDesktopInfo(req);
    else if (m == QStringLiteral("take_over.request"))
        resp = handleTakeOverRequest(req);
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

// Static model lists per brain. Codex also merges anything in ~/.codex/config.toml.
static QJsonArray modelsForBrain(const QString &brain)
{
    QJsonArray models;
    if (brain == QStringLiteral("codex")) {
        models << QStringLiteral("gpt-5.5") << QStringLiteral("gpt-5-codex")
               << QStringLiteral("gpt-5.5-codex") << QStringLiteral("o4-mini");
    } else if (brain == QStringLiteral("claude")) {
        models << QStringLiteral("claude-opus-4-8") << QStringLiteral("claude-opus-4-5")
               << QStringLiteral("claude-sonnet-4-5") << QStringLiteral("claude-haiku-4-5");
    } else { // api
        models << QStringLiteral("gpt-5.5") << QStringLiteral("o4-mini")
               << QStringLiteral("claude-opus-4-8") << QStringLiteral("qwen2.5:3b");
    }
    return models;
}

Response ControlServer::handleSettingsGet(const Request &req)
{
    QJsonObject s;
    s.insert(QStringLiteral("default_brain"), m_settings.defaultBrain());
    s.insert(QStringLiteral("default_model"), m_settings.defaultModel());

    QJsonArray brains;
    brains << QStringLiteral("codex") << QStringLiteral("claude") << QStringLiteral("api");
    s.insert(QStringLiteral("brains"), brains);

    QJsonObject byBrain;
    byBrain.insert(QStringLiteral("codex"), modelsForBrain(QStringLiteral("codex")));
    byBrain.insert(QStringLiteral("claude"), modelsForBrain(QStringLiteral("claude")));
    byBrain.insert(QStringLiteral("api"), modelsForBrain(QStringLiteral("api")));
    s.insert(QStringLiteral("models_by_brain"), byBrain);

    // Booleans only — raw secret values are NEVER returned.
    s.insert(QStringLiteral("api_keys_set"), m_settings.apiKeysSet());

    // Theme prefs (persisted in config.toml as theme_json). Fall back to a
    // sane default HUD theme when none has been set yet.
    QJsonObject theme = m_settings.theme();
    if (theme.isEmpty()) {
        theme.insert(QStringLiteral("accent"), QStringLiteral("#19E3FF"));
        theme.insert(QStringLiteral("glow"), true);
        theme.insert(QStringLiteral("compact"), false);
    }
    s.insert(QStringLiteral("theme"), theme);

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

    bool prefsTouched = false;
    if (patch.contains(QStringLiteral("default_brain"))) {
        const QString v = patch.value(QStringLiteral("default_brain")).toString();
        m_settings.setDefaultBrain(v);
        m_config.defaultBrain = v;
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("default_model"))) {
        const QString v = patch.value(QStringLiteral("default_model")).toString();
        m_settings.setDefaultModel(v);
        m_config.defaultModel = v;
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("default_cwd")))
        m_config.defaultCwd = patch.value(QStringLiteral("default_cwd")).toString();
    if (patch.contains(QStringLiteral("theme"))) {
        m_settings.setTheme(patch.value(QStringLiteral("theme")).toObject());
        prefsTouched = true;
    }
    if (prefsTouched)
        m_settings.saveConfig();

    // API keys are WRITE-ONLY: persist to secrets.json (0600), never echoed.
    if (patch.contains(QStringLiteral("api_keys"))) {
        const QJsonObject keys = patch.value(QStringLiteral("api_keys")).toObject();
        for (auto it = keys.begin(); it != keys.end(); ++it)
            m_settings.setApiKey(it.key(), it.value().toString()); // empty clears
        m_settings.saveSecrets();
    }

    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleModelList(const Request &req)
{
    const QString brain = req.params.value(QStringLiteral("brain")).toString(m_config.defaultBrain);
    QJsonArray models = modelsForBrain(brain);

    // codex: merge the configured default model from ~/.codex/config.toml.
    if (brain == QStringLiteral("codex")) {
        QFile f(QDir::homePath() + QStringLiteral("/.codex/config.toml"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            QTextStream in(&f);
            while (!in.atEnd()) {
                const QString line = in.readLine().trimmed();
                if (line.startsWith(QStringLiteral("model")) && line.contains(QLatin1Char('='))
                    && !line.startsWith(QStringLiteral("model_"))) {
                    QString v = line.section(QLatin1Char('='), 1).trimmed();
                    if (v.size() >= 2 && v.startsWith(QLatin1Char('"')))
                        v = v.mid(1, v.size() - 2);
                    if (!v.isEmpty() && !models.contains(v))
                        models.prepend(v);
                    break;
                }
            }
        }
    }

    // ollama (api brain): best-effort live tag list.
    if (brain == QStringLiteral("api")) {
        QNetworkAccessManager nam;
        QNetworkRequest rq(QUrl(QStringLiteral("http://127.0.0.1:11434/api/tags")));
        QNetworkReply *reply = nam.get(rq);
        QEventLoop loop;
        QTimer::singleShot(800, &loop, &QEventLoop::quit);
        connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        loop.exec();
        if (reply->isFinished() && reply->error() == QNetworkReply::NoError) {
            const QJsonObject o = QJsonDocument::fromJson(reply->readAll()).object();
            for (const QJsonValue &m : o.value(QStringLiteral("models")).toArray()) {
                const QString name = m.toObject().value(QStringLiteral("name")).toString();
                if (!name.isEmpty() && !models.contains(name))
                    models.append(name);
            }
        }
        reply->deleteLater();
    }

    QJsonObject result;
    result.insert(QStringLiteral("brain"), brain);
    result.insert(QStringLiteral("models"), models);
    return Response::success(req.id, result);
}

Brain *ControlServer::makeBrain(const SessionRow &row, const QString &cwdOverride,
                                const QStringList &agentMcpOverrides)
{
    if (row.brain == QStringLiteral("codex")) {
        CodexBrain::Options opts;
        opts.cwd = cwdOverride.isEmpty() ? m_config.effectiveCwd() : cwdOverride;
        opts.model = row.model;
        opts.profile = row.profile;
        opts.sandboxMode = CodexBrain::sandboxForProfile(row.profile);
        // coworker sessions get every enabled MCP server (incl the built-in
        // computer-use, bearer from ~/.computer-use/config.yaml) injected as
        // `-c mcp_servers.<name>...` codex config overrides so the brain can
        // call them. For a coworker+agent (nested-desktop) session the daemon
        // supplies a per-session override that points computer-use at the
        // NESTED engine instead of the global :8794, so the brain drives the
        // agent's own desktop — never the user's real screen.
        if (!agentMcpOverrides.isEmpty())
            opts.configOverrides = agentMcpOverrides;
        else if (row.profile == QStringLiteral("coworker") && m_mcp)
            opts.configOverrides = m_mcp->codexOverrides();
        auto *brain = new CodexBrain(opts, this);
        brain->setSessionId(row.id);
        return brain;
    }
    // claude / api brains arrive in a later wave.
    return nullptr;
}

// Build the codex `-c mcp_servers.computer_use...` overrides that point the
// built-in computer-use server at the per-session nested-desktop engine
// (url+bearer), plus any OTHER enabled (non-built-in) MCP servers unchanged.
QStringList ControlServer::agentMcpOverridesFor(const AgentDesktopInfo &desk) const
{
    QStringList ov;
    // Point computer-use at the nested engine.
    const QString key = QStringLiteral("computer_use");
    ov << QStringLiteral("mcp_servers.%1.url=%2").arg(key, desk.mcpUrl);
    if (!desk.bearer.isEmpty())
        ov << QStringLiteral("mcp_servers.%1.bearer_token=%2").arg(key, desk.bearer);
    // Keep any other enabled servers (skip the built-in computer-use; we just
    // overrode it above).
    if (m_mcp) {
        for (const McpServerRow &srv : m_mcp->list()) {
            if (!srv.enabled || srv.id == McpRegistry::builtinId())
                continue;
            const QString k = McpRegistry::codexKey(srv);
            if (srv.transport == QStringLiteral("stdio")) {
                const QStringList parts =
                    srv.endpoint.split(QLatin1Char(' '), Qt::SkipEmptyParts);
                if (parts.isEmpty())
                    continue;
                ov << QStringLiteral("mcp_servers.%1.command=%2").arg(k, parts.first());
                if (parts.size() > 1) {
                    QStringList quoted;
                    for (const QString &a : parts.mid(1))
                        quoted << QStringLiteral("\"%1\"").arg(a);
                    ov << QStringLiteral("mcp_servers.%1.args=[%2]")
                              .arg(k, quoted.join(QLatin1Char(',')));
                }
            } else {
                ov << QStringLiteral("mcp_servers.%1.url=%2").arg(k, srv.endpoint);
                if (!srv.token.isEmpty())
                    ov << QStringLiteral("mcp_servers.%1.bearer_token=%2").arg(k, srv.token);
            }
        }
    }
    return ov;
}

QString ControlServer::createSession(const QString &profile, const QString &brainName,
                                     const QString &model, const QString &cwd,
                                     const QString &title, QString *err,
                                     const QString &target)
{
    SessionRow row;
    row.id = genSessionId();
    row.profile = profile.isEmpty() ? QStringLiteral("coder") : profile;
    row.brain = brainName.isEmpty() ? m_config.defaultBrain : brainName;
    row.model = model.isEmpty() ? m_config.defaultModel : model;
    row.title = title.isEmpty() ? QStringLiteral("Untitled session") : title;
    row.state = QStringLiteral("idle");
    row.created = QDateTime::currentMSecsSinceEpoch();
    row.updated = row.created;

    if (!m_store.create(row)) {
        if (err)
            *err = m_store.lastError();
        return QString();
    }

    // For a coworker session whose target is "agent" (the DEFAULT for coworker
    // mode), bring up an isolated nested desktop + a per-session computer-use
    // engine bound to it; the brain's computer-use MCP is pointed at that engine
    // so it drives the agent's OWN screen, never the user's. target="real" (or
    // a coder session) uses the global computer-use as before.
    const bool isCoworker = (row.profile == QStringLiteral("coworker"));
    const QString effTarget = target.isEmpty()
                                  ? (isCoworker ? QStringLiteral("agent")
                                                : QStringLiteral("real"))
                                  : target;

    QStringList agentOverrides;
    if (isCoworker && effTarget == QStringLiteral("agent")) {
        QString deskErr;
        const AgentDesktopInfo desk = m_agentDesktops.ensure(row.id, &deskErr);
        if (!desk.up) {
            m_store.updateState(row.id, QStringLiteral("error"));
            if (err)
                *err = QStringLiteral("agent desktop failed: ") + deskErr;
            return QString();
        }
        agentOverrides = agentMcpOverridesFor(desk);
    }

    Brain *brain = makeBrain(row, cwd, agentOverrides);
    if (!brain) {
        // Tear down any nested desktop we just spun up for this session.
        if (m_agentDesktops.has(row.id))
            m_agentDesktops.teardown(row.id);
        m_store.updateState(row.id, QStringLiteral("error"));
        if (err)
            *err = QStringLiteral("brain not available: ") + row.brain;
        return QString();
    }

    connect(brain, &Brain::event, this, &ControlServer::onBrainEvent);
    m_brains.insert(row.id, brain);
    return row.id;
}

bool ControlServer::sendToSession(const QString &sessionId, const QString &text,
                                  const QStringList &images, QString *err)
{
    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        if (err)
            *err = QStringLiteral("unknown or inactive session: ") + sessionId;
        return false;
    }
    m_store.updateState(sessionId, QStringLiteral("running"));
    brain->send(text, images);
    return true;
}

bool ControlServer::cancelSession(const QString &sessionId, QString *err)
{
    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        if (err)
            *err = QStringLiteral("unknown or inactive session: ") + sessionId;
        return false;
    }
    brain->cancel();
    m_store.updateState(sessionId, QStringLiteral("idle"));
    // Canceling a turn ends any real-session take-over (overlay hides).
    if (m_takeOverActive.contains(sessionId))
        setTakeOverActive(sessionId, false);
    // For a coworker+agent session, cancel is the session's "release" signal
    // (Contract A has no separate session.close): tear down the nested desktop +
    // its bound engine so we don't leak a compositor/engine per session. A fresh
    // desktop is spun up if the session is recreated.
    if (m_agentDesktops.has(sessionId))
        m_agentDesktops.teardown(sessionId);
    return true;
}

bool ControlServer::respondApprovalFor(const QString &sessionId, const QString &approvalId,
                                       const QString &decision, QString *err)
{
    // A take-over approval is daemon-side (no brain involvement): allow/always
    // flips the real-session take-over ON (overlay shown), deny clears it.
    if (approvalId.startsWith(QStringLiteral("takeover-"))) {
        const bool allow = (decision == QStringLiteral("allow") ||
                            decision == QStringLiteral("always"));
        setTakeOverActive(sessionId, allow);
        return true;
    }

    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        if (err)
            *err = QStringLiteral("unknown or inactive session: ") + sessionId;
        return false;
    }
    brain->respondApproval(approvalId, decision);
    return true;
}

Response ControlServer::handleSessionCreate(const Request &req)
{
    const QJsonObject p = req.params;
    QString err;
    const QString sessionId = createSession(
        p.value(QStringLiteral("profile")).toString(),
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("cwd")).toString(),
        p.value(QStringLiteral("title")).toString(),
        &err,
        p.value(QStringLiteral("target")).toString());
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("session_create_failed"), err);

    QJsonObject result;
    result.insert(QStringLiteral("session_id"), sessionId);
    if (auto row = m_store.get(sessionId); row && !row->threadId.isEmpty())
        result.insert(QStringLiteral("thread_id"), row->threadId);
    // Surface the nested agent desktop so the desktop "Computer" page + the
    // device video pump can find it.
    if (const AgentDesktopInfo desk = agentDesktopFor(sessionId); desk.up)
        result.insert(QStringLiteral("agent_desktop"), desk.toJson());
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionSend(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();

    QStringList images;
    for (const QJsonValue &v : req.params.value(QStringLiteral("images")).toArray())
        images << v.toString();

    QString err;
    if (!sendToSession(sessionId, text, images, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);

    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionCancel(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    QString err;
    if (!cancelSession(sessionId, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
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

    QString err;
    if (!respondApprovalFor(sessionId, approvalId, decision, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    return Response::success(req.id);
}

// --- Contract A v2: MCP registry (delegates to McpRegistry) ----------------

Response ControlServer::handleMcpList(const Request &req)
{
    QJsonArray arr;
    for (const McpServerRow &row : m_mcp->list())
        arr.append(row.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("servers"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleMcpAdd(const Request &req)
{
    const QJsonObject p = req.params;
    const QString name = p.value(QStringLiteral("name")).toString(QStringLiteral("Unnamed"));
    const QString transport = p.value(QStringLiteral("transport")).toString(QStringLiteral("http"));
    const QString endpoint = p.value(QStringLiteral("endpoint")).toString();
    const QString token = p.value(QStringLiteral("token")).toString();
    const bool enabled = p.value(QStringLiteral("enabled")).toBool(true);
    const QString risk = p.value(QStringLiteral("risk")).toString(QStringLiteral("medium"));
    if (endpoint.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("endpoint is required"));
    const QString id = m_mcp->add(name, transport, endpoint, token, enabled, risk);
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("store_error"), m_store.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    return Response::success(req.id, result);
}

Response ControlServer::handleMcpRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_mcp->remove(id))
        return Response::failure(req.id, QStringLiteral("not_removed"),
                                 QStringLiteral("server not found or is built-in: ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleMcpSetEnabled(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const bool enabled = req.params.value(QStringLiteral("enabled")).toBool();
    if (!m_mcp->setEnabled(id, enabled))
        return Response::failure(req.id, QStringLiteral("store_error"), m_store.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleMcpTest(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    auto srv = m_mcp->get(id);
    if (!srv)
        return Response::failure(req.id, QStringLiteral("no_server"),
                                 QStringLiteral("unknown server: ") + id);

    // Real MCP initialize + tools/list over http or stdio with a 5s timeout.
    const McpTestResult tr = McpRegistry::test(*srv, /*timeoutMs=*/5000);

    QJsonObject result;
    result.insert(QStringLiteral("ok"), tr.ok);
    result.insert(QStringLiteral("tools_count"), tr.toolsCount);
    if (!tr.error.isEmpty())
        result.insert(QStringLiteral("error"), tr.error);
    return Response::success(req.id, result);
}

// --- Contract A v2: plugins marketplace (delegates to PluginRegistry) ------

Response ControlServer::handlePluginsCatalog(const Request &req)
{
    QJsonArray plugins;
    for (const PluginManifest &m : m_plugins->catalog())
        plugins.append(m.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("plugins"), plugins);
    return Response::success(req.id, result);
}

Response ControlServer::handlePluginsInstall(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_plugins->install(id))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handlePluginsSetEnabled(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const bool enabled = req.params.value(QStringLiteral("enabled")).toBool();
    if (!m_plugins->setEnabled(id, enabled))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handlePluginsRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_plugins->remove(id))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

// --- Contract A v2: device pairing/management ------------------------------

QString ControlServer::tailnetHost()
{
    // Prefer the tailscale0 interface; else the first 100.64/10 (CGNAT) IPv4.
    for (const QNetworkInterface &iface : QNetworkInterface::allInterfaces()) {
        const bool isTailscale = iface.name().startsWith(QStringLiteral("tailscale"));
        for (const QNetworkAddressEntry &entry : iface.addressEntries()) {
            const QHostAddress ip = entry.ip();
            if (ip.protocol() != QAbstractSocket::IPv4Protocol)
                continue;
            const QString s = ip.toString();
            if (isTailscale || s.startsWith(QStringLiteral("100."))) {
                if (s != QStringLiteral("127.0.0.1"))
                    return s;
            }
        }
    }
    return QStringLiteral("127.0.0.1");
}

Response ControlServer::handleDevicesPairStart(const Request &req)
{
    const QString host = tailnetHost() + QStringLiteral(":") +
                         QString::number(m_config.devicePort);
    const QString fp = m_deviceReg.identityFingerprint();
    const PairingCode pc = m_pairing.start(host, fp);
    return Response::success(req.id, pc.toJson());
}

Response ControlServer::handleDevicesList(const Request &req)
{
    QJsonArray arr;
    for (const DeviceRow &d : m_deviceReg.list())
        arr.append(d.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("devices"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleDevicesRevoke(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_deviceReg.revoke(id))
        return Response::failure(req.id, QStringLiteral("no_device"),
                                 QStringLiteral("unknown device: ") + id);
    // Drop any push token + pending tasks for the revoked device.
    m_store.removePushToken(id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

// --- Wave 5: nested agent desktop + real-session take-over ------------------

AgentDesktopInfo ControlServer::agentDesktopFor(const QString &sessionId) const
{
    return m_agentDesktops.info(sessionId);
}

Response ControlServer::handleAgentDesktopInfo(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const AgentDesktopInfo desk = m_agentDesktops.info(sessionId);
    if (!desk.up)
        return Response::failure(req.id, QStringLiteral("no_agent_desktop"),
                                 QStringLiteral("no nested agent desktop for session: ") +
                                     sessionId);
    QJsonObject result = desk.toJson();
    // Convenience: the local single-JPEG + MJPEG endpoints for the desktop
    // "Computer" preview (the bearer rides the same per-session token).
    const QString base = m_agentDesktops.engineBase(sessionId);
    result.insert(QStringLiteral("video_frame"), base + QStringLiteral("/video/frame"));
    result.insert(QStringLiteral("video_mjpeg"), base + QStringLiteral("/video/mjpeg"));
    return Response::success(req.id, result);
}

bool ControlServer::requestTakeOver(const QString &sessionId, QString *err)
{
    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        if (err)
            *err = QStringLiteral("unknown or inactive session: ") + sessionId;
        return false;
    }
    // The actual approval is biometric (Contract C tier / Contract A
    // approval.respond). We surface an approval event so the phone/desktop can
    // gate it; the take-over goes ACTIVE only once setTakeOverActive(true) is
    // called by the approval path.
    NormalizedBrainEvent ev = NormalizedBrainEvent::approval(
        QStringLiteral("takeover-") + sessionId,
        QStringLiteral("Allow Jarvis to drive your REAL screen?"),
        QStringLiteral("high"));
    onBrainEvent(sessionId, ev);
    return true;
}

bool ControlServer::setTakeOverActive(const QString &sessionId, bool active)
{
    const bool was = m_takeOverActive.contains(sessionId);
    if (active)
        m_takeOverActive.insert(sessionId);
    else
        m_takeOverActive.remove(sessionId);
    if (was != active)
        emit agentDrivingChanged(sessionId, active);
    return true;
}

Response ControlServer::handleTakeOverRequest(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    QString err;
    if (!requestTakeOver(sessionId, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    QJsonObject result;
    result.insert(QStringLiteral("pending_approval"), true);
    result.insert(QStringLiteral("approval_id"),
                  QStringLiteral("takeover-") + sessionId);
    return Response::success(req.id, result);
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

    // Fan the (already-persisted) event out to the device channel + push.
    emit sessionEvent(sessionId, ev);
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
