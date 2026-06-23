#include "ControlServer.h"

#include "jarvis/ApiBrain.h"
#include "jarvis/Brain.h"
#include "jarvis/ClaudeBrain.h"
#include "jarvis/CodexBrain.h"
#include "jarvis/InjectionGuard.h"

#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
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

    // Wave 5: Jarvis long-term memory (SQLite+FTS5, same jarvis.db, distinct
    // connection). Non-fatal if it fails (memory simply stays empty) — but log.
    if (!m_memory.open())
        qWarning("jarvisd: memory store unavailable: %s",
                 qPrintable(m_memory.lastError()));

    // Wave 8 co-worker ops backend. All share jarvis.db via distinct connection
    // names; each failure is non-fatal (that feature degrades, daemon survives).
    if (!m_audit.open())
        qWarning("jarvisd: audit log unavailable: %s", qPrintable(m_audit.lastError()));
    if (!m_sshAllow.load())
        qWarning("jarvisd: ssh allow-list load: %s", qPrintable(m_sshAllow.lastError()));
    if (!m_scheduler.open()) {
        qWarning("jarvisd: scheduler unavailable: %s", qPrintable(m_scheduler.lastError()));
    } else {
        // The scheduler fires due jobs by creating a session + sending the prompt.
        m_scheduler.setFireCallback(
            [this](const ScheduleRow &row) { return fireScheduledJob(row); });
        // On a fired job: desktop notify + audit (HERMES_FEATURES §5).
        connect(&m_scheduler, &Scheduler::jobFired, this,
                [this](const ScheduleRow &row, const QString &sessionId) {
                    m_notify.scheduleDone(row.name);
                    m_audit.record(QStringLiteral("schedule.fire"), !sessionId.isEmpty(),
                                   QStringLiteral("low"),
                                   QStringLiteral("scheduled job '%1' -> %2")
                                       .arg(row.name, sessionId),
                                   sessionId);
                });
        m_scheduler.start(); // ~15s tick
    }

    // Contract A v2 stores/registries. SettingsStore loads config.toml prefs +
    // secrets.json; the registries wrap the (now-open) SessionStore tables.
    m_settings.load();
    // MISTRAL key bootstrap: if ~/.config/jarvis/mistral_api_key exists and the
    // SettingsStore doesn't already carry a "mistral" secret, load it in-memory
    // so settings.get reports api_keys_set.mistral=true and the api brain can use
    // Mistral chat + Voxtral voice. The key file stays the source of truth (we
    // do NOT copy it into secrets.json) so it never lands in two places.
    if (!m_settings.hasApiKey(QStringLiteral("mistral"))) {
        const QString keyPath =
            Config::configDir() + QStringLiteral("/mistral_api_key");
        QFile mf(keyPath);
        if (mf.exists() && mf.open(QIODevice::ReadOnly)) {
            const QString key = QString::fromUtf8(mf.readAll()).trimmed();
            mf.close();
            if (!key.isEmpty())
                m_settings.setApiKey(QStringLiteral("mistral"), key);
        }
    }
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
    else if (m == QStringLiteral("voice.stt"))
        resp = handleVoiceStt(req);
    else if (m == QStringLiteral("voice.tts"))
        resp = handleVoiceTts(req);
    else if (m == QStringLiteral("file.push"))
        resp = handleFilePush(req);
    else if (m == QStringLiteral("file.get"))
        resp = handleFileGet(req);
    else if (isMemoryOrSkillMethod(m))
        resp = dispatchMemoryOrSkill(req);
    else if (isOpsMethod(m))
        resp = dispatchOpsMethod(req, /*remote=*/false);
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
               << QStringLiteral("claude-opus-4-8")
               << QStringLiteral("mistral-large-latest")
               << QStringLiteral("mistral-small-latest")
               << QStringLiteral("qwen2.5:3b");
    }
    return models;
}

// The default model for a brain when the caller gives none: the FIRST entry of
// modelsForBrain (claude -> a claude model, api -> a configured-provider model)
// — NOT the global default (gpt-5.5, which is only correct for codex).
static QString firstModelForBrain(const QString &brain)
{
    const QJsonArray models = modelsForBrain(brain);
    return models.isEmpty() ? QString() : models.first().toString();
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

    if (row.brain == QStringLiteral("claude")) {
        ClaudeBrain::Options opts;
        opts.cwd = cwdOverride.isEmpty() ? m_config.effectiveCwd() : cwdOverride;
        opts.model = row.model;
        opts.profile = row.profile;
        // Coworker sessions expose the computer-use (+ other enabled) MCP servers
        // to claude via a --mcp-config JSON file. For a coworker+agent session
        // the override points computer-use at the NESTED engine (agent's own
        // screen, never the user's real one).
        QString mcpJson;
        if (!agentMcpOverrides.isEmpty()) {
            // coworker+agent: point computer-use at the nested per-session engine.
            mcpJson = claudeMcpConfigForAgent(m_agentDesktops.info(row.id));
        } else if (row.profile == QStringLiteral("coworker")) {
            mcpJson = claudeMcpConfigFromRegistry();
        }
        opts.mcpConfigJson = mcpJson;
        auto *brain = new ClaudeBrain(opts, this);
        brain->setSessionId(row.id);
        return brain;
    }

    if (row.brain == QStringLiteral("api")) {
        ApiBrain::Options opts;
        opts.model = row.model;
        opts.systemPrompt = memorySystemBlock();
        // Resolve a key for the model's provider from secrets.json (write-only
        // store). Anthropic models use the anthropic key; everything else the
        // openai key. Ollama needs none.
        const QString provider = ApiBrain::resolveProvider(opts);
        if (provider == QStringLiteral("anthropic"))
            opts.apiKey = m_settings.apiKey(QStringLiteral("anthropic"));
        else if (provider == QStringLiteral("mistral"))
            opts.apiKey = m_settings.apiKey(QStringLiteral("mistral"));
        else if (provider == QStringLiteral("openai"))
            opts.apiKey = m_settings.apiKey(QStringLiteral("openai"));
        // ollama: no key.
        auto *brain = new ApiBrain(opts, this);
        brain->setSessionId(row.id);
        return brain;
    }

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

// --- Claude --mcp-config JSON ----------------------------------------------

// Build a {"mcpServers":{<key>:{...}}} object for every enabled MCP server.
// `computerUseEndpoint`/`computerUseBearer` override the built-in computer-use
// entry (used to point it at a nested per-session engine for coworker+agent).
static QJsonObject claudeMcpServersObject(McpRegistry *mcp,
                                          const QString &cuEndpoint = QString(),
                                          const QString &cuBearer = QString())
{
    QJsonObject servers;
    if (!mcp)
        return servers;
    for (const McpServerRow &srv : mcp->list()) {
        if (!srv.enabled)
            continue;
        const QString key = McpRegistry::codexKey(srv);
        QJsonObject entry;
        const bool isBuiltin = (srv.id == McpRegistry::builtinId());
        if (srv.transport == QStringLiteral("stdio")) {
            const QStringList parts =
                srv.endpoint.split(QLatin1Char(' '), Qt::SkipEmptyParts);
            if (parts.isEmpty())
                continue;
            entry.insert(QStringLiteral("command"), parts.first());
            if (parts.size() > 1) {
                QJsonArray args;
                for (const QString &a : parts.mid(1))
                    args.append(a);
                entry.insert(QStringLiteral("args"), args);
            }
        } else {
            QString url = srv.endpoint;
            QString token = srv.token;
            if (isBuiltin) {
                if (!cuEndpoint.isEmpty())
                    url = cuEndpoint;
                token = cuBearer.isEmpty() ? McpRegistry::computerUseBearer() : cuBearer;
            }
            entry.insert(QStringLiteral("type"), QStringLiteral("http"));
            entry.insert(QStringLiteral("url"), url);
            if (!token.isEmpty()) {
                QJsonObject headers;
                headers.insert(QStringLiteral("Authorization"),
                               QStringLiteral("Bearer ") + token);
                entry.insert(QStringLiteral("headers"), headers);
            }
        }
        servers.insert(key, entry);
    }
    return servers;
}

QString ControlServer::claudeMcpConfigFromRegistry() const
{
    QJsonObject root;
    root.insert(QStringLiteral("mcpServers"), claudeMcpServersObject(m_mcp.get()));
    return QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact));
}

QString ControlServer::claudeMcpConfigForAgent(const AgentDesktopInfo &desk) const
{
    QJsonObject root;
    root.insert(QStringLiteral("mcpServers"),
                claudeMcpServersObject(m_mcp.get(), desk.mcpUrl, desk.bearer));
    return QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact));
}

// --- memory injection (HERMES_FEATURES §1) ---------------------------------

QString ControlServer::prefetchMemoryBlock(const QString &query)
{
    if (!m_memory.isOpen())
        return QString();
    const QVector<MemoryRow> hits = m_memory.prefetch(query, 6);
    return MemoryStore::renderPromptBlock(hits);
}

QString ControlServer::memorySystemBlock()
{
    // ApiBrain has no CLI system prompt of its own; seed it with recent memory.
    if (!m_memory.isOpen())
        return QStringLiteral("You are Jarvis, a helpful AI co-worker.");
    QString block = QStringLiteral(
        "You are Jarvis, a helpful AI co-worker. You have persistent memory.\n");
    const QString mem = MemoryStore::renderPromptBlock(m_memory.prefetch(QString(), 8));
    if (!mem.isEmpty())
        block += QStringLiteral("\n") + mem;
    return block;
}

void ControlServer::syncTurnMemory(const QString &sessionId, const QString &userText)
{
    // Best-effort post-turn write so memory grows even when the model doesn't
    // call memory.add itself. Heuristic: persist explicit "remember that ..." /
    // "note that ..." user statements (cheap, high-precision); the model can
    // curate the rest via the memory tools exposed to it.
    Q_UNUSED(sessionId);
    if (!m_memory.isOpen())
        return;
    const QString t = userText.trimmed();
    static const QStringList cues = {
        QStringLiteral("remember that "), QStringLiteral("remember to "),
        QStringLiteral("note that "),     QStringLiteral("keep in mind that "),
        QStringLiteral("don't forget that "), QStringLiteral("for future reference, "),
    };
    const QString lower = t.toLower();
    for (const QString &cue : cues) {
        const int idx = lower.indexOf(cue);
        if (idx >= 0) {
            QString fact = t.mid(idx + cue.size()).trimmed();
            if (fact.size() >= 4)
                m_memory.add(fact, {QStringLiteral("auto"), QStringLiteral("user")});
            return;
        }
    }
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
    // BRAIN DEFAULT FIX: when the caller gives no model, pick the per-brain
    // default (the FIRST entry of modelsForBrain) — a claude brain gets a claude
    // model, an api brain a configured-provider model — NOT the global default
    // (gpt-5.5), which is only the right default for codex. Only fall back to the
    // global default_model when it actually belongs to this brain (i.e. codex).
    if (!model.isEmpty()) {
        row.model = model;
    } else if (row.brain == QStringLiteral("codex") && !m_config.defaultModel.isEmpty()) {
        row.model = m_config.defaultModel;
    } else {
        row.model = firstModelForBrain(row.brain);
    }
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

    // PROMPT-INJECTION GATING (BUILD_SPEC): scan the user turn (+ any page/
    // screenshot text the daemon can see) before it reaches the brain. For an
    // ApiBrain session a risky turn BLOCKS here — we emit an approval event and
    // do not send until approval.respond arrives. For CLI brains this only
    // audits (they run their own tool loop and can't be intercepted mid-loop).
    QString brainName;
    if (auto row = m_store.get(sessionId))
        brainName = row->brain;
    if (gateForInjection(sessionId, brainName, text)) {
        // Blocked: hold the turn (text+images) until the approval flips it
        // through via approval.respond("inject-<id>").
        m_injectionHeld.insert(sessionId, HeldTurn{text, images});
        if (err)
            *err = QStringLiteral("blocked pending injection approval");
        // Not an error to the caller — the approval card carries the next step.
        return true;
    }

    m_store.updateState(sessionId, QStringLiteral("running"));

    // Memory PREFETCH (HERMES_FEATURES §1), applied for ALL brains: prepend a
    // relevant-memory block to the user's turn so the model has context. The
    // memory tools (memory.*) let the model curate; this is the injection half.
    QString effectiveText = text;
    const QString memBlock = prefetchMemoryBlock(text);
    if (!memBlock.isEmpty())
        effectiveText = memBlock + QStringLiteral("\n---\n") + text;

    brain->send(effectiveText, images);

    // Memory SYNC (post-turn write of salient user facts). Cheap + synchronous;
    // the model can also persist richer facts via the memory tools.
    syncTurnMemory(sessionId, text);
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

    // An injection-gate approval (BUILD_SPEC prompt-injection gating): the user
    // confirmed the held turn is safe. allow/always resumes the held turn
    // (bypassing the gate this time); deny drops it. Daemon-side, no brain call.
    if (approvalId.startsWith(QStringLiteral("inject-"))) {
        const HeldTurn held = m_injectionHeld.take(sessionId);
        const bool allow = (decision == QStringLiteral("allow") ||
                            decision == QStringLiteral("always"));
        m_audit.record(QStringLiteral("injection.gate"), allow,
                       allow ? QStringLiteral("high") : QStringLiteral("low"),
                       allow ? QStringLiteral("user approved a flagged turn")
                             : QStringLiteral("user denied a flagged turn"),
                       sessionId);
        if (allow && !held.text.isEmpty()) {
            Brain *brain = m_brains.value(sessionId, nullptr);
            if (brain) {
                m_store.updateState(sessionId, QStringLiteral("running"));
                QString eff = held.text;
                const QString memBlock = prefetchMemoryBlock(held.text);
                if (!memBlock.isEmpty())
                    eff = memBlock + QStringLiteral("\n---\n") + held.text;
                brain->send(eff, held.images);
                syncTurnMemory(sessionId, held.text);
            }
        } else {
            m_store.updateState(sessionId, QStringLiteral("idle"));
        }
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

// --- Contract A v3: memory + self-authored skills ---------------------------

bool ControlServer::isMemoryOrSkillMethod(const QString &method)
{
    return method.startsWith(QStringLiteral("memory.")) ||
           method.startsWith(QStringLiteral("skills."));
}

Response ControlServer::dispatchMemoryOrSkill(const Request &req)
{
    const QString &m = req.method;
    if (m == QStringLiteral("memory.list"))
        return handleMemoryList(req);
    if (m == QStringLiteral("memory.search"))
        return handleMemorySearch(req);
    if (m == QStringLiteral("memory.add"))
        return handleMemoryAdd(req);
    if (m == QStringLiteral("memory.remove"))
        return handleMemoryRemove(req);
    if (m == QStringLiteral("skills.list"))
        return handleSkillsList(req);
    if (m == QStringLiteral("skills.get"))
        return handleSkillsGet(req);
    if (m == QStringLiteral("skills.create"))
        return handleSkillsCreate(req);
    if (m == QStringLiteral("skills.invoke"))
        return handleSkillsInvoke(req);
    if (m == QStringLiteral("skills.remove"))
        return handleSkillsRemove(req);
    if (m == QStringLiteral("skills.today"))
        return handleSkillsToday(req);
    return Response::failure(req.id, QStringLiteral("unknown_method"),
                             QStringLiteral("unknown method: ") + m);
}

Response ControlServer::handleMemoryList(const Request &req)
{
    const int limit = req.params.value(QStringLiteral("limit")).toInt(0);
    QJsonArray arr;
    for (const MemoryRow &m : m_memory.list(limit))
        arr.append(m.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("memories"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemorySearch(const Request &req)
{
    const QString q = req.params.value(QStringLiteral("q")).toString();
    const int limit = req.params.value(QStringLiteral("limit")).toInt(20);
    QJsonArray arr;
    for (const MemoryRow &m : m_memory.search(q, limit))
        arr.append(m.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("memories"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemoryAdd(const Request &req)
{
    const QString text = req.params.value(QStringLiteral("text")).toString();
    QStringList tags;
    for (const QJsonValue &t : req.params.value(QStringLiteral("tags")).toArray())
        tags << t.toString();
    if (text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("text is required"));
    const QString id = m_memory.add(text, tags);
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("store_error"), m_memory.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemoryRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_memory.remove(id))
        return Response::failure(req.id, QStringLiteral("not_removed"),
                                 QStringLiteral("memory not found: ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleSkillsList(const Request &req)
{
    QJsonArray arr;
    for (const SkillRow &s : m_skills.list())
        arr.append(s.toListJson());
    QJsonObject result;
    result.insert(QStringLiteral("skills"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsGet(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    SkillFrontmatter fm;
    QString body, path;
    if (!m_skills.read(name, &fm, &body, &path))
        return Response::failure(req.id, QStringLiteral("no_skill"), m_skills.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("frontmatter"), fm.toJson());
    result.insert(QStringLiteral("body"), body);
    result.insert(QStringLiteral("path"), path);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsCreate(const Request &req)
{
    const QJsonObject p = req.params;
    const QString name = p.value(QStringLiteral("name")).toString();
    const QString description = p.value(QStringLiteral("description")).toString();
    const QString body = p.value(QStringLiteral("body")).toString();
    const QString group = p.value(QStringLiteral("group")).toString();
    QStringList tags;
    for (const QJsonValue &t : p.value(QStringLiteral("tags")).toArray())
        tags << t.toString();
    QVector<SkillScript> scripts;
    for (const QJsonValue &sv : p.value(QStringLiteral("scripts")).toArray()) {
        const QJsonObject so = sv.toObject();
        scripts.push_back(SkillScript{so.value(QStringLiteral("name")).toString(),
                                      so.value(QStringLiteral("content")).toString()});
    }
    if (name.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("name is required"));
    const QString path = m_skills.create(name, description, body, group, tags, scripts);
    if (path.isEmpty())
        return Response::failure(req.id, QStringLiteral("write_error"), m_skills.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("path"), path);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsInvoke(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const QJsonObject argsObj = req.params.value(QStringLiteral("args")).toObject();
    const QString argsStr = req.params.value(QStringLiteral("args")).isString()
                                ? req.params.value(QStringLiteral("args")).toString()
                                : QString();
    QString err;
    const QString message = m_skills.invoke(name, argsStr, argsObj, &err);
    if (message.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_skill"), err);
    QJsonObject result;
    result.insert(QStringLiteral("message"), message);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsRemove(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    if (!m_skills.remove(name))
        return Response::failure(req.id, QStringLiteral("no_skill"), m_skills.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleSkillsToday(const Request &req)
{
    QJsonObject result;
    result.insert(QStringLiteral("digest"), buildTodayDigest());
    return Response::success(req.id, result);
}

QString ControlServer::buildTodayDigest()
{
    // A short "what I'm working on today" summary from recent sessions +
    // memories. (Project-tracker MCP project_list/agent_checkin would enrich
    // this; the daemon surfaces what it can locally and notes the MCP source so
    // the desktop/phone can fold in the live project list.)
    QString out = QStringLiteral("# Today\n");

    const QVector<SessionRow> sessions = m_store.list();
    int shown = 0;
    if (!sessions.isEmpty()) {
        out += QStringLiteral("\n## Recent sessions\n");
        for (const SessionRow &s : sessions) {
            if (shown++ >= 5)
                break;
            out += QStringLiteral("- [%1/%2] %3 (%4)\n")
                       .arg(s.brain, s.profile,
                            s.title.isEmpty() ? s.id : s.title, s.state);
        }
    }

    if (m_memory.isOpen()) {
        const QVector<MemoryRow> recent = m_memory.list(5);
        if (!recent.isEmpty()) {
            out += QStringLiteral("\n## Recent memory\n");
            for (const MemoryRow &m : recent)
                out += QStringLiteral("- %1\n").arg(m.text);
        }
    }

    const QVector<SkillRow> skills = m_skills.list();
    if (!skills.isEmpty()) {
        out += QStringLiteral("\n## Skills available\n");
        int n = 0;
        for (const SkillRow &s : skills) {
            if (n++ >= 8)
                break;
            out += QStringLiteral("- /%1 — %2\n").arg(s.fm.name, s.fm.description);
        }
    }

    out += QStringLiteral("\n(Live project list via project-tracker MCP "
                          "project_list is folded in by the client.)\n");
    return out;
}

// --- Voice (Mistral Voxtral, laptop-proxied) --------------------------------

QString ControlServer::mistralKey() const
{
    return m_settings.apiKey(QStringLiteral("mistral"));
}

Response ControlServer::handleVoiceStt(const Request &req)
{
    const QString key = mistralKey();
    if (key.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_voice_key"),
                                 QStringLiteral("Mistral API key not configured"));

    const QByteArray audio = QByteArray::fromBase64(
        req.params.value(QStringLiteral("audio_b64")).toString().toLatin1());
    if (audio.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("audio_b64 is required"));
    const QString mime = req.params.value(QStringLiteral("mime")).toString();
    const QString lang = req.params.value(QStringLiteral("lang")).toString();
    const QString model = req.params.value(QStringLiteral("model")).toString();

    VoiceService voice(key);
    const VoiceService::Result r = voice.stt(audio, mime, lang, model);
    if (!r.ok)
        return Response::failure(req.id, QStringLiteral("voice_stt_failed"), r.error);

    QJsonObject result;
    result.insert(QStringLiteral("text"), r.text);
    if (!r.language.isEmpty())
        result.insert(QStringLiteral("language"), r.language);
    if (!r.wordsJson.isEmpty()) {
        const QJsonDocument wd = QJsonDocument::fromJson(r.wordsJson);
        if (wd.isArray())
            result.insert(QStringLiteral("words"), wd.array());
    }
    return Response::success(req.id, result);
}

Response ControlServer::handleVoiceTts(const Request &req)
{
    const QString key = mistralKey();
    if (key.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_voice_key"),
                                 QStringLiteral("Mistral API key not configured"));

    const QString text = req.params.value(QStringLiteral("text")).toString();
    if (text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("text is required"));
    const QString vc = req.params.value(QStringLiteral("voice")).toString();
    const QString format = req.params.value(QStringLiteral("format")).toString();
    const QString model = req.params.value(QStringLiteral("model")).toString();

    VoiceService voice(key);
    const VoiceService::Result r = voice.tts(text, vc, format, model);
    if (!r.ok)
        return Response::failure(req.id, QStringLiteral("voice_tts_failed"), r.error);

    QJsonObject result;
    result.insert(QStringLiteral("audio_b64"), QString::fromLatin1(r.audio.toBase64()));
    result.insert(QStringLiteral("mime"), r.mime);
    return Response::success(req.id, result);
}

// --- device->phone file push (Contract C) -----------------------------------

namespace {

QString fileInboxDir(const QString &sessionId)
{
    QString dir = QDir::homePath() + QStringLiteral("/.local/share/jarvis/files");
    if (!sessionId.isEmpty())
        dir += QLatin1Char('/') + sessionId;
    QDir().mkpath(dir);
    return dir;
}

QString genFileId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(8, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("file_") + QString::fromLatin1(bytes.toHex());
}

QString guessMime(const QString &name)
{
    const QString n = name.toLower();
    if (n.endsWith(QStringLiteral(".png"))) return QStringLiteral("image/png");
    if (n.endsWith(QStringLiteral(".jpg")) || n.endsWith(QStringLiteral(".jpeg")))
        return QStringLiteral("image/jpeg");
    if (n.endsWith(QStringLiteral(".pdf"))) return QStringLiteral("application/pdf");
    if (n.endsWith(QStringLiteral(".txt")) || n.endsWith(QStringLiteral(".md")))
        return QStringLiteral("text/plain");
    if (n.endsWith(QStringLiteral(".json"))) return QStringLiteral("application/json");
    if (n.endsWith(QStringLiteral(".zip"))) return QStringLiteral("application/zip");
    return QStringLiteral("application/octet-stream");
}

} // namespace

Response ControlServer::handleFilePush(const Request &req)
{
    const QJsonObject p = req.params;
    const QString sessionId = p.value(QStringLiteral("session_id")).toString();
    QString name = p.value(QStringLiteral("name")).toString();

    // Source: inline b64, OR an on-disk path the daemon reads.
    QByteArray bytes;
    if (p.contains(QStringLiteral("b64"))) {
        bytes = QByteArray::fromBase64(p.value(QStringLiteral("b64")).toString().toLatin1());
    } else if (p.contains(QStringLiteral("path"))) {
        const QString srcPath = p.value(QStringLiteral("path")).toString();
        QFile sf(srcPath);
        if (!sf.open(QIODevice::ReadOnly))
            return Response::failure(req.id, QStringLiteral("bad_path"),
                                     QStringLiteral("cannot read file: ") + srcPath);
        bytes = sf.readAll();
        sf.close();
        if (name.isEmpty())
            name = QFileInfo(srcPath).fileName();
    } else {
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("b64 or path is required"));
    }
    if (bytes.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("empty file content"));
    if (name.isEmpty())
        name = QStringLiteral("file.bin");
    // Strip any directory components from the supplied name (path-safety).
    name = QFileInfo(name).fileName();

    const QString fileId = genFileId();
    const QString dir = fileInboxDir(sessionId);
    const QString outPath = dir + QLatin1Char('/') + fileId + QLatin1Char('_') + name;
    QFile of(outPath);
    if (!of.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return Response::failure(req.id, QStringLiteral("write_error"),
                                 QStringLiteral("cannot store file: ") + of.errorString());
    of.write(bytes);
    of.close();

    const QString mime = p.value(QStringLiteral("mime")).toString(guessMime(name));

    QJsonObject descriptor;
    descriptor.insert(QStringLiteral("file_id"), fileId);
    descriptor.insert(QStringLiteral("name"), name);
    descriptor.insert(QStringLiteral("size"), bytes.size());
    descriptor.insert(QStringLiteral("mime"), mime);
    descriptor.insert(QStringLiteral("path"), outPath);
    if (!sessionId.isEmpty())
        descriptor.insert(QStringLiteral("session_id"), sessionId);

    // Announce to the device channel: phones get a 'file.offer' event and can
    // pull the bytes back with file.get{file_id, session_id?}.
    emit filePushed(descriptor);

    // Don't leak the local path back over the wire.
    QJsonObject result = descriptor;
    result.remove(QStringLiteral("path"));
    return Response::success(req.id, result);
}

Response ControlServer::handleFileGet(const Request &req)
{
    const QString fileId = req.params.value(QStringLiteral("file_id")).toString();
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    if (fileId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("file_id is required"));

    const QString dir = fileInboxDir(sessionId);
    // Stored as "<file_id>_<name>"; find the single match for this id.
    QDir d(dir);
    const QStringList matches =
        d.entryList(QStringList{fileId + QStringLiteral("_*")}, QDir::Files);
    if (matches.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_file"),
                                 QStringLiteral("unknown file: ") + fileId);
    const QString path = dir + QLatin1Char('/') + matches.first();
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return Response::failure(req.id, QStringLiteral("read_error"),
                                 QStringLiteral("cannot read file"));
    const QByteArray bytes = f.readAll();
    f.close();

    const QString name = matches.first().mid(fileId.size() + 1);
    QJsonObject result;
    result.insert(QStringLiteral("file_id"), fileId);
    result.insert(QStringLiteral("name"), name);
    result.insert(QStringLiteral("mime"), guessMime(name));
    result.insert(QStringLiteral("b64"), QString::fromLatin1(bytes.toBase64()));
    return Response::success(req.id, result);
}

// --- full Contract-C config-surface dispatch --------------------------------

bool ControlServer::isConfigMethod(const QString &method)
{
    static const QSet<QString> methods = {
        QStringLiteral("settings.get"),      QStringLiteral("settings.set"),
        QStringLiteral("model.list"),        QStringLiteral("mcp.list"),
        QStringLiteral("mcp.add"),           QStringLiteral("mcp.remove"),
        QStringLiteral("mcp.set_enabled"),   QStringLiteral("mcp.test"),
        QStringLiteral("plugins.catalog"),   QStringLiteral("plugins.install"),
        QStringLiteral("plugins.set_enabled"), QStringLiteral("plugins.remove"),
        QStringLiteral("voice.stt"),         QStringLiteral("voice.tts"),
        QStringLiteral("take_over.request"), QStringLiteral("file.push"),
        QStringLiteral("file.get"),
        QStringLiteral("devices.pair_start"), QStringLiteral("devices.list"),
        QStringLiteral("devices.revoke"),
        QStringLiteral("agent_desktop.info"),
    };
    return methods.contains(method);
}

Response ControlServer::dispatchConfigMethod(const Request &req)
{
    const QString &m = req.method;
    if (m == QStringLiteral("settings.get"))    return handleSettingsGet(req);
    if (m == QStringLiteral("settings.set"))    return handleSettingsSet(req);
    if (m == QStringLiteral("model.list"))      return handleModelList(req);
    if (m == QStringLiteral("mcp.list"))        return handleMcpList(req);
    if (m == QStringLiteral("mcp.add"))         return handleMcpAdd(req);
    if (m == QStringLiteral("mcp.remove"))      return handleMcpRemove(req);
    if (m == QStringLiteral("mcp.set_enabled")) return handleMcpSetEnabled(req);
    if (m == QStringLiteral("mcp.test"))        return handleMcpTest(req);
    if (m == QStringLiteral("plugins.catalog")) return handlePluginsCatalog(req);
    if (m == QStringLiteral("plugins.install")) return handlePluginsInstall(req);
    if (m == QStringLiteral("plugins.set_enabled")) return handlePluginsSetEnabled(req);
    if (m == QStringLiteral("plugins.remove"))  return handlePluginsRemove(req);
    if (m == QStringLiteral("voice.stt"))       return handleVoiceStt(req);
    if (m == QStringLiteral("voice.tts"))       return handleVoiceTts(req);
    if (m == QStringLiteral("take_over.request")) return handleTakeOverRequest(req);
    if (m == QStringLiteral("file.push"))       return handleFilePush(req);
    if (m == QStringLiteral("file.get"))        return handleFileGet(req);
    if (m == QStringLiteral("devices.pair_start")) return handleDevicesPairStart(req);
    if (m == QStringLiteral("devices.list"))    return handleDevicesList(req);
    if (m == QStringLiteral("devices.revoke"))  return handleDevicesRevoke(req);
    if (m == QStringLiteral("agent_desktop.info")) return handleAgentDesktopInfo(req);
    return Response::failure(req.id, QStringLiteral("unknown_method"),
                             QStringLiteral("unknown config method: ") + m);
}

// --- Wave 8: co-worker ops (scheduler / ssh allow-list / audit) -------------

bool ControlServer::isOpsMethod(const QString &method)
{
    return method.startsWith(QStringLiteral("schedule.")) ||
           method.startsWith(QStringLiteral("ssh.")) ||
           method == QStringLiteral("audit.list");
}

Response ControlServer::dispatchOpsMethod(const Request &req, bool remote)
{
    const QString &m = req.method;
    if (m == QStringLiteral("schedule.create"))      return handleScheduleCreate(req);
    if (m == QStringLiteral("schedule.list"))        return handleScheduleList(req);
    if (m == QStringLiteral("schedule.set_enabled")) return handleScheduleSetEnabled(req);
    if (m == QStringLiteral("schedule.remove"))      return handleScheduleRemove(req);
    if (m == QStringLiteral("ssh.allow_list"))       return handleSshAllowList(req);
    if (m == QStringLiteral("ssh.allow_add"))        return handleSshAllowAdd(req);
    if (m == QStringLiteral("ssh.allow_remove"))     return handleSshAllowRemove(req);
    if (m == QStringLiteral("ssh.exec"))             return handleSshExec(req, remote);
    if (m == QStringLiteral("audit.list"))           return handleAuditList(req);
    return Response::failure(req.id, QStringLiteral("unknown_method"),
                             QStringLiteral("unknown ops method: ") + m);
}

QString ControlServer::fireScheduledJob(const ScheduleRow &row)
{
    // Create a session for the scheduled prompt and send it. Uses the row's
    // brain/model/profile overrides (else daemon defaults). Returns the new
    // session id, or empty on failure (the Scheduler logs/notifies accordingly).
    QString err;
    const QString sid = createSession(row.profile, row.brain, row.model,
                                      /*cwd=*/QString(),
                                      row.name.isEmpty() ? QStringLiteral("Scheduled job")
                                                         : row.name,
                                      &err);
    if (sid.isEmpty()) {
        qWarning("jarvisd: scheduled job '%s' failed to create session: %s",
                 qPrintable(row.name), qPrintable(err));
        return QString();
    }
    if (!sendToSession(sid, row.prompt, {}, &err))
        qWarning("jarvisd: scheduled job '%s' send failed: %s",
                 qPrintable(row.name), qPrintable(err));
    return sid;
}

Response ControlServer::handleScheduleCreate(const Request &req)
{
    const QJsonObject p = req.params;
    // Accept either `cron` (5-field / "every Nm" / "at HH:MM") or `when` (alias).
    QString cronExpr = p.value(QStringLiteral("cron")).toString();
    if (cronExpr.isEmpty())
        cronExpr = p.value(QStringLiteral("when")).toString();
    const QString prompt = p.value(QStringLiteral("prompt")).toString();
    if (cronExpr.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("cron or when is required"));
    if (prompt.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("prompt is required"));

    const QString id = m_scheduler.create(
        p.value(QStringLiteral("name")).toString(), cronExpr, prompt,
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("profile")).toString(),
        p.value(QStringLiteral("enabled")).toBool(true));
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("schedule_error"),
                                 m_scheduler.lastError());

    m_audit.record(QStringLiteral("schedule.create"), true, QStringLiteral("low"),
                   QStringLiteral("scheduled '%1' (%2)").arg(cronExpr, prompt.left(60)));
    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    return Response::success(req.id, result);
}

Response ControlServer::handleScheduleList(const Request &req)
{
    QJsonArray arr;
    for (const ScheduleRow &r : m_scheduler.list())
        arr.append(r.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("schedules"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleScheduleSetEnabled(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const bool enabled = req.params.value(QStringLiteral("enabled")).toBool();
    if (!m_scheduler.setEnabled(id, enabled))
        return Response::failure(req.id, QStringLiteral("no_schedule"),
                                 QStringLiteral("unknown schedule: ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleScheduleRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (!m_scheduler.remove(id))
        return Response::failure(req.id, QStringLiteral("no_schedule"),
                                 QStringLiteral("unknown schedule: ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleSshAllowList(const Request &req)
{
    return Response::success(req.id, m_sshAllow.toJson());
}

Response ControlServer::handleSshAllowAdd(const Request &req)
{
    const QString host = req.params.value(QStringLiteral("host")).toString();
    if (host.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("host is required"));
    const bool changed = m_sshAllow.add(host);
    m_audit.record(QStringLiteral("ssh.allow_add"), true, QStringLiteral("medium"),
                   QStringLiteral("allow-listed ssh host ") + host);
    QJsonObject result = m_sshAllow.toJson();
    result.insert(QStringLiteral("added"), changed);
    return Response::success(req.id, result);
}

Response ControlServer::handleSshAllowRemove(const Request &req)
{
    const QString host = req.params.value(QStringLiteral("host")).toString();
    const bool changed = m_sshAllow.remove(host);
    if (changed)
        m_audit.record(QStringLiteral("ssh.allow_remove"), true, QStringLiteral("low"),
                       QStringLiteral("removed ssh host ") + host);
    QJsonObject result = m_sshAllow.toJson();
    result.insert(QStringLiteral("removed"), changed);
    return Response::success(req.id, result);
}

Response ControlServer::handleSshExec(const Request &req, bool remote)
{
    const QString host = req.params.value(QStringLiteral("host")).toString();
    const QString cmd = req.params.value(QStringLiteral("cmd")).toString();
    if (host.trimmed().isEmpty() || cmd.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("host and cmd are required"));

    // HARD GATE: ssh.exec only runs for allow-listed hosts; non-listed hosts
    // never spawn ssh (SshAllowList::exec enforces this). Audited either way.
    const SshAllowList::ExecResult r = m_sshAllow.exec(host, cmd);
    if (!r.allowed) {
        m_audit.record(QStringLiteral("ssh.exec"), false, QStringLiteral("high"),
                       QStringLiteral("REJECTED ssh.exec to non-allow-listed host ") + host,
                       QString(), remote);
        return Response::failure(req.id, QStringLiteral("host_not_allowed"),
                                 QStringLiteral("host is not in the ssh allow-list: ") + host);
    }
    m_audit.record(QStringLiteral("ssh.exec"), r.ok, QStringLiteral("high"),
                   QStringLiteral("ssh %1: %2").arg(host, cmd.left(80)),
                   QString(), remote);

    QJsonObject result;
    result.insert(QStringLiteral("ok"), r.ok);
    result.insert(QStringLiteral("exit_code"), r.exitCode);
    result.insert(QStringLiteral("output"), r.output);
    if (!r.error.isEmpty())
        result.insert(QStringLiteral("error"), r.error);
    return Response::success(req.id, result);
}

Response ControlServer::handleAuditList(const Request &req)
{
    const int limit = req.params.value(QStringLiteral("limit")).toInt(100);
    QJsonArray arr;
    for (const AuditRow &a : m_audit.list(limit))
        arr.append(a.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("entries"), arr);
    return Response::success(req.id, result);
}

// --- prompt-injection gating (BUILD_SPEC) -----------------------------------

bool ControlServer::gateForInjection(const QString &sessionId, const QString &brain,
                                     const QString &text)
{
    const InjectionGuard::Result scan = InjectionGuard::scanText(text, QStringLiteral("turn"));
    if (!scan.risky) {
        // Audit the (clean) turn at low risk so the log shows activity.
        m_audit.record(QStringLiteral("session.send"), true, QStringLiteral("low"),
                       text.left(80), sessionId);
        return false;
    }

    // Risky. Always audit. For the ApiBrain path we can intercept BEFORE the
    // turn reaches the model, so we BLOCK and emit an approval. CLI brains
    // (codex/claude) run their own in-process tool loop and rely on their own
    // approval modes (see docs/HERMES_FEATURES.md) — we audit + notify but do
    // not block (we can't intercept mid-loop).
    m_audit.record(QStringLiteral("injection.detect"), false, scan.risk,
                   scan.summary(), sessionId);
    m_notify.approvalNeeded(scan.summary(), sessionId);

    if (brain == QStringLiteral("api")) {
        NormalizedBrainEvent ev = NormalizedBrainEvent::approval(
            QStringLiteral("inject-") + sessionId, scan.summary(), scan.risk);
        onBrainEvent(sessionId, ev);
        return true; // caller holds the turn
    }
    return false; // CLI brain: audited + notified, but not blocked
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

    // Desktop notifications on attention events (BUILD_SPEC: approval needed /
    // task done). The device channel separately FCM-pushes the same events; this
    // is the LOCAL notify-send path via NotifyService.
    if (ev.kind == NormalizedBrainEvent::Kind::Approval) {
        m_notify.approvalNeeded(
            ev.fields.value(QStringLiteral("summary")).toString(
                QStringLiteral("Jarvis needs your approval")),
            sessionId);
        // Audit the brain-emitted approval (computer-use / take-over etc.).
        m_audit.record(QStringLiteral("approval"), true,
                       ev.fields.value(QStringLiteral("risk")).toString(QStringLiteral("high")),
                       ev.fields.value(QStringLiteral("summary")).toString(), sessionId);
    } else if (ev.kind == NormalizedBrainEvent::Kind::Final) {
        m_notify.taskDone(QStringLiteral("Session ") + sessionId + QStringLiteral(" finished a turn."));
    } else if (ev.kind == NormalizedBrainEvent::Kind::ToolCall) {
        // Audit every brain tool call with an injection-scanned risk tier.
        const QString name = ev.fields.value(QStringLiteral("name")).toString();
        const QJsonObject args = ev.fields.value(QStringLiteral("args")).toObject();
        const QString argsStr =
            QString::fromUtf8(QJsonDocument(args).toJson(QJsonDocument::Compact));
        const InjectionGuard::Result scan = InjectionGuard::scanToolCall(name, argsStr);
        m_audit.record(QStringLiteral("tool:") + name, true,
                       scan.risky ? scan.risk : QStringLiteral("low"),
                       scan.risky ? scan.summary() : name, sessionId);
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
