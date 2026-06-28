#include "ControlServer.h"

#include "jarvis/ApiBrain.h"
#include "jarvis/Brain.h"
#include "jarvis/ClaudeBrain.h"
#include "jarvis/CodexBrain.h"
#include "jarvis/Connectors.h"
#include "jarvis/InjectionGuard.h"
#include "jarvis/PluginSigner.h"

#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
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

// A long-term memory is a concise FACT/preference, never a document. Writes above
// this many chars are rejected so a co-work session can't dump a webpage or chat
// transcript into memory (which would then be injected into every future session).
constexpr int kMaxMemoryChars = 2000;
// The auto-saved "remember that …" note is capped much tighter: it must read as a
// short, deliberate fact, not the tail of a long paste that happened to contain a cue.
constexpr int kMaxAutoMemoryChars = 280;
constexpr int kMaxAutoMemorySource = 600;   // skip auto-save for messages longer than this

QString genSessionId()
{
    // 16 random bytes hex => collision-safe session id.
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(16, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("sess_") + QString::fromLatin1(bytes.toHex());
}

// The signature cloned voice. Selecting this slug makes voice.tts synth via a
// stored reference clip (Mistral ref_audio zero-shot cloning) instead of a named
// preset. It is also the product DEFAULT voice (used when no tts_voice is set).
const QString kCloneVoiceDefault = QStringLiteral("jarvice");

// Map a cloned-voice slug to a base64 reference clip for ref_audio TTS.
//   "jarvice"     -> ~/.config/jarvis/voices/jarvice_ref.{mp3,wav,opus,flac,ogg}
//   "clone:NAME"  -> ~/.config/jarvis/voices/NAME_ref.*
// Returns an empty string when the slug is not a clone OR no reference clip is on
// disk (the caller then falls back to a normal named voice, so TTS never breaks).
QString cloneRefAudioB64(const QString &voiceSlug)
{
    QString name;
    if (voiceSlug == kCloneVoiceDefault)
        name = kCloneVoiceDefault;
    else if (voiceSlug.startsWith(QStringLiteral("clone:")))
        name = voiceSlug.mid(6);
    if (name.isEmpty())
        return QString();
    const QString dir = QDir::homePath() + QStringLiteral("/.config/jarvis/voices/");
    static const QStringList exts = { QStringLiteral("mp3"), QStringLiteral("wav"),
                                      QStringLiteral("opus"), QStringLiteral("flac"),
                                      QStringLiteral("ogg") };
    for (const QString &ext : exts) {
        QFile f(dir + name + QStringLiteral("_ref.") + ext);
        if (f.exists() && f.open(QIODevice::ReadOnly))
            return QString::fromLatin1(f.readAll().toBase64());
    }
    return QString();
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

    // Live-widget viewer leases are EPHEMERAL — rebuilt from live connections +
    // ~15s heartbeats. Wipe any left by a previous (possibly crashed) run so a
    // stale "all" lease can't keep every live widget running with no one watching.
    m_widgetLeases.wipeAll();

    // Wave 5: Jarvis long-term memory (SQLite+FTS5, same jarvis.db, distinct
    // connection). Non-fatal if it fails (memory simply stays empty) — but log.
    if (!m_memory.open())
        qWarning("jarvisd: memory store unavailable: %s",
                 qPrintable(m_memory.lastError()));

    // Seed the built-in "internal_docs" skill (a capability/feature catalog the
    // model loads when asked what it can do). Idempotent — only writes if missing.
    seedInternalDocsSkill();

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

    // TEARDOWN-LEAK GUARD: reap any nested agent compositors (+ per-session
    // engines + on-disk artifacts) orphaned by a previous daemon (crash / abrupt
    // restart). Matches ONLY our own ~/.local/share/jarvis/agent/sway-*.conf
    // marker, so it can never touch the user's real sway/KDE.
    {
        const int reaped = m_agentDesktops.sweepOrphans();
        if (reaped > 0)
            qInfo("jarvisd: swept %d orphaned nested agent compositor(s) at start",
                  reaped);
    }

    // BATTERY: periodically tear down AUTO agent desktops for sessions you're not
    // viewing and that haven't run a turn for a while (the reservation is kept so
    // the next turn revives them identically).
    m_deskIdleTimer = new QTimer(this);
    m_deskIdleTimer->setInterval(120000);   // sweep every 2 min
    connect(m_deskIdleTimer, &QTimer::timeout, this, &ControlServer::sweepIdleDesktops);
    m_deskIdleTimer->start();

    // Widget bus tail -> control-WS broadcast for opted-in clients (the Chrome
    // extension). The desktop tails the file itself, so it never subscribes here.
    startWidgetWatch();

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
    m_scopedClients.remove(client);
    m_subscriptions.remove(client);
    m_widgetClients.remove(client);
    // Drop this desktop client's live-widget viewer leases so unwatched widgets idle.
    m_widgetLeases.clearSource(
        QStringLiteral("desktop:") + QString::number(reinterpret_cast<quintptr>(client), 16));
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
    else if (m == QStringLiteral("session.wake"))
        resp = handleSessionWake(req);
    else if (m == QStringLiteral("session.cancel"))
        resp = handleSessionCancel(req);
    else if (m == QStringLiteral("session.delete"))
        resp = handleSessionDelete(req);
    else if (m == QStringLiteral("session.list"))
        resp = handleSessionList(req);
    else if (m == QStringLiteral("session.history"))
        resp = handleSessionHistory(req);
    else if (m == QStringLiteral("session.subscribe"))
        resp = handleSessionSubscribe(client, req);
    else if (m == QStringLiteral("widget.viewing"))
        resp = handleWidgetViewing(client, req);
    else if (m == QStringLiteral("widget.subscribe"))
        resp = handleWidgetSubscribe(client, req);
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
    else if (m == QStringLiteral("mcp.cli_list"))
        resp = handleMcpCliList(req);
    else if (m == QStringLiteral("mcp.cli_set_enabled"))
        resp = handleMcpCliSetEnabled(req);
    else if (m == QStringLiteral("connectors.list"))
        resp = handleConnectorsList(req);
    else if (m == QStringLiteral("connectors.add"))
        resp = handleConnectorsAdd(req);
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
    else if (m == QStringLiteral("take_over.cancel"))
        resp = handleTakeOverCancel(req);
    else if (m == QStringLiteral("auth.request"))
        resp = handleAuthRequest(req);
    else if (m == QStringLiteral("auth.status"))
        resp = handleAuthStatus(req);
    else if (m == QStringLiteral("auth.deny"))
        resp = handleAuthDeny(req);
    else if (m == QStringLiteral("auth.verify_pin"))
        resp = handleAuthVerifyPin(req);
    else if (m == QStringLiteral("voice.stt"))
        resp = handleVoiceStt(req);
    else if (m == QStringLiteral("voice.tts"))
        resp = handleVoiceTts(req);
    else if (m == QStringLiteral("voice.list_voices"))
        resp = handleVoiceListVoices(req);
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
    s.insert(QStringLiteral("claude_account"), m_settings.claudeAccount());
    s.insert(QStringLiteral("tts_voice"), m_settings.ttsVoice());

    // Pluggable STT/TTS providers (default "voxtral"). Ship the availability
    // lists too so the picker can show-but-disable local providers when their
    // binary is absent.
    s.insert(QStringLiteral("stt_provider"), m_settings.sttProvider());
    s.insert(QStringLiteral("tts_provider"), m_settings.ttsProvider());
    s.insert(QStringLiteral("stt_providers"), VoiceProvider::sttProviders());
    s.insert(QStringLiteral("tts_providers"), VoiceProvider::ttsProviders());

    QJsonArray brains;
    brains << QStringLiteral("codex") << QStringLiteral("claude") << QStringLiteral("api");
    s.insert(QStringLiteral("brains"), brains);

    // Per-brain "can drive the computer-use nested desktop headless" capability,
    // so the picker can HONESTLY mark which brains drive (no silent swapping).
    //   claude -> yes (bypassPermissions for coworker+agent)
    //   codex  -> yes (danger-full-access on the isolated nested desktop)
    //   api    -> only when an OpenAI/Anthropic key is set (tool-calling brain)
    QJsonObject canDrive;
    canDrive.insert(QStringLiteral("claude"), true);
    canDrive.insert(QStringLiteral("codex"), true);
    canDrive.insert(QStringLiteral("api"),
                    m_settings.hasApiKey(QStringLiteral("openai")) ||
                        m_settings.hasApiKey(QStringLiteral("anthropic")));
    s.insert(QStringLiteral("can_drive"), canDrive);

    QJsonObject byBrain;
    byBrain.insert(QStringLiteral("codex"), modelsForBrain(QStringLiteral("codex")));
    byBrain.insert(QStringLiteral("claude"), modelsForBrain(QStringLiteral("claude")));
    byBrain.insert(QStringLiteral("api"), modelsForBrain(QStringLiteral("api")));
    s.insert(QStringLiteral("models_by_brain"), byBrain);

    // Booleans only — raw secret values are NEVER returned.
    s.insert(QStringLiteral("api_keys_set"), m_settings.apiKeysSet());

    // "Let Jarvis use a computer/browser" (default ON): when on, every session
    // gets the computer-use MCP injected against a lazily-spun nested desktop so
    // a plain chat can drive the computer/Chrome on demand.
    s.insert(QStringLiteral("let_jarvis_use_computer"),
             m_settings.letJarvisUseComputer());

    // "Require phone+fingerprint to open Jarvis" (2FA + fingerprint cross-device
    // unlock; default ON — no-brick). When on, the desktop shows a LockGate on
    // launch; handleAuthRequest fail-opens when no approver is reachable.
    s.insert(QStringLiteral("auth_lock_enabled"), m_settings.authLockEnabled());

    // Permission level ("high"|"medium"|"low"): the ask-before-risky policy
    // surfaced to the model via the co-work preamble. Soft policy only — the
    // capability sandbox is unchanged.
    s.insert(QStringLiteral("permission_level"), m_settings.permissionLevel());

    // Agent mode (plan|build|coworker): soft behavioral profile surfaced as a HUD
    // chip and selectable in Settings. wake_notify (silent|ping|always): what a
    // background-job / sleep-wake does to the user's phone.
    s.insert(QStringLiteral("agent_mode"), m_settings.agentMode());
    s.insert(QStringLiteral("wake_notify"), m_settings.wakeNotify());

    // Whether a desktop unlock PIN is set (boolean only — never the PIN/hash).
    s.insert(QStringLiteral("has_desktop_pin"), m_settings.hasDesktopPin());

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
    if (patch.contains(QStringLiteral("claude_account"))) {
        const QString v = patch.value(QStringLiteral("claude_account")).toString();
        m_settings.setClaudeAccount(v); // normalizes to pro|max
        m_config.claudeAccount = m_settings.claudeAccount();
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("default_cwd")))
        m_config.defaultCwd = patch.value(QStringLiteral("default_cwd")).toString();
    if (patch.contains(QStringLiteral("theme"))) {
        m_settings.setTheme(patch.value(QStringLiteral("theme")).toObject());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("let_jarvis_use_computer"))) {
        m_settings.setLetJarvisUseComputer(
            patch.value(QStringLiteral("let_jarvis_use_computer")).toBool());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("auth_lock_enabled"))) {
        m_settings.setAuthLockEnabled(
            patch.value(QStringLiteral("auth_lock_enabled")).toBool());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("permission_level"))) {
        m_settings.setPermissionLevel(
            patch.value(QStringLiteral("permission_level")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("agent_mode"))) {
        m_settings.setAgentMode(patch.value(QStringLiteral("agent_mode")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("wake_notify"))) {
        m_settings.setWakeNotify(patch.value(QStringLiteral("wake_notify")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("desktop_pin"))) {
        // Write-only: set or clear the desktop unlock PIN (hashed in SettingsStore).
        m_settings.setDesktopPin(patch.value(QStringLiteral("desktop_pin")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("tts_voice"))) {
        m_settings.setTtsVoice(patch.value(QStringLiteral("tts_voice")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("stt_provider"))) {
        m_settings.setSttProvider(patch.value(QStringLiteral("stt_provider")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("tts_provider"))) {
        m_settings.setTtsProvider(patch.value(QStringLiteral("tts_provider")).toString());
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
                                const CodexMcpOverrides &agentMcpOverrides)
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
        if (!agentMcpOverrides.args.isEmpty()) {
            // coworker+agent (or auto-spawned chat): drive the NESTED per-session
            // computer-use engine.
            opts.configOverrides = agentMcpOverrides.args;
            opts.extraEnv = agentMcpOverrides.env;
        } else if (row.profile == QStringLiteral("coworker") && m_mcp) {
            const CodexMcpOverrides cu = m_mcp->codexOverrides(
                [this](const QString &ref) { return resolveConnectorEnv(ref); });
            opts.configOverrides = cu.args;
            opts.extraEnv = cu.env;
        }
        // ANY codex session that has a computer-use MCP injected MUST drive it
        // headless: codex auto-CANCELS every MCP tool call ("desktop tool not
        // allowed") under any sandbox other than danger-full-access with no
        // approval. So whenever we injected a computer-use server, force the
        // drive contract + an ISOLATED CODEX_HOME (only the injected server is
        // visible — never the user's global ~/.codex servers / real desktop).
        // This closes the path where a session had the tool but kept cancelling.
        // ALWAYS run in an ISOLATED CODEX_HOME (its config.toml is copied with
        // every [mcp_servers.*] stripped; auth.json symlinked) so a Jarvis session
        // NEVER inherits the user's ~/.codex servers (hand-desktop/desktop-use/
        // vm-*), even a plain chat with no injected computer-use. driveMcp (the
        // danger sandbox that stops codex auto-cancelling MCP calls) is only forced
        // when a computer-use server was actually injected.
        opts.codexHome = QDir::homePath()
            + QStringLiteral("/.local/share/jarvis/agent/") + row.id
            + QStringLiteral("/codex-home");
        if (!opts.configOverrides.isEmpty())
            opts.driveMcp = true;
        auto *brain = new CodexBrain(opts, this);
        brain->setSessionId(row.id);
        return brain;
    }

    if (row.brain == QStringLiteral("claude")) {
        ClaudeBrain::Options opts;
        opts.cwd = cwdOverride.isEmpty() ? m_config.effectiveCwd() : cwdOverride;
        opts.model = row.model;
        opts.profile = row.profile;
        // Pin the claude OAuth account: pro -> ~/.claude (default), max ->
        // ~/.claude-secondary. The brain ctor also defaults to Pro if empty, so
        // the brain can never accidentally inherit the Max account.
        opts.configDir = m_settings.claudeConfigDir();
        // Coworker sessions expose the computer-use (+ other enabled) MCP servers
        // to claude via a --mcp-config JSON file. For a coworker+agent session
        // the override points computer-use at the NESTED engine (agent's own
        // screen, never the user's real one).
        QString mcpJson;
        if (!agentMcpOverrides.args.isEmpty()) {
            // coworker+agent: point computer-use at the nested per-session engine.
            mcpJson = claudeMcpConfigForAgent(m_agentDesktops.info(row.id));
            // Headless `claude -p` would otherwise PROMPT for permission before
            // each MCP tool call and, with no interactive responder, the turn
            // stalls and the computer-use tools never run (acceptEdits only
            // auto-accepts file edits, not MCP tools). The agent drives its OWN
            // nested desktop (never the user's real screen), so bypass prompts
            // for this session so the brain can actually call the tools.
            opts.permissionMode = QStringLiteral("bypassPermissions");
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
CodexMcpOverrides ControlServer::agentMcpOverridesFor(const AgentDesktopInfo &desk) const
{
    CodexMcpOverrides out;
    // Point computer-use at the nested engine. codex 0.135 rejects an inline
    // `bearer_token=` for a streamable_http MCP server, so reference an env var
    // (set on the codex child) instead.
    const QString key = QStringLiteral("computer_use");
    out.args << QStringLiteral("mcp_servers.%1.url=%2").arg(key, desk.mcpUrl);
    // A long per-tool timeout so a BLOCKING tool (e.g. agent_wait, which can wait
    // for a slow subagent) is never killed by codex's default MCP tool timeout —
    // the user saw agent_wait "time out" because codex cut the call short. 2h.
    out.args << QStringLiteral("mcp_servers.%1.tool_timeout_sec=7200").arg(key);
    if (!desk.bearer.isEmpty()) {
        const QString envName = QStringLiteral("JARVIS_AGENT_CU_BEARER");
        out.args << QStringLiteral("mcp_servers.%1.bearer_token_env_var=%2").arg(key, envName);
        out.env.insert(envName, desk.bearer);
    }
    // ALSO expose the GLOBAL :8794 engine as a SECOND server "real_screen" so the
    // model can drive the USER'S REAL KDE screen when asked. The nested
    // "computer_use" server only reaches the agent's own desktop and REFUSES host
    // actions ("skipped: engine bound to nested agent desktop"); real_screen is
    // bound to the active session and uses which="active". The model chooses per
    // the co-work preamble (agent desktop by default; real screen only on request).
    {
        const QString realUrl = McpRegistry::builtinEndpoint();
        out.args << QStringLiteral("mcp_servers.real_screen.url=%1").arg(realUrl);
        out.args << QStringLiteral("mcp_servers.real_screen.tool_timeout_sec=7200");
        const QString realBearer = McpRegistry::computerUseBearer();
        if (!realBearer.isEmpty()) {
            const QString envName = QStringLiteral("JARVIS_REAL_CU_BEARER");
            out.args << QStringLiteral("mcp_servers.real_screen.bearer_token_env_var=%1").arg(envName);
            out.env.insert(envName, realBearer);
        }
    }
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
                out.args << QStringLiteral("mcp_servers.%1.command=%2").arg(k, parts.first());
                if (parts.size() > 1) {
                    QStringList quoted;
                    for (const QString &a : parts.mid(1))
                        quoted << QStringLiteral("\"%1\"").arg(a);
                    out.args << QStringLiteral("mcp_servers.%1.args=[%2]")
                                    .arg(k, quoted.join(QLatin1Char(',')));
                }
                // Connector env (Google OAuth creds), resolved through SettingsStore.
                for (auto it = srv.env.constBegin(); it != srv.env.constEnd(); ++it) {
                    const QString value = resolveConnectorEnv(it.value().toString());
                    if (value.isEmpty())
                        continue;
                    out.args << QStringLiteral("mcp_servers.%1.env.%2=%3")
                                    .arg(k, it.key(), value);
                }
            } else {
                out.args << QStringLiteral("mcp_servers.%1.url=%2").arg(k, srv.endpoint);
                if (!srv.token.isEmpty()) {
                    const QString envName = McpRegistry::bearerEnvName(k);
                    out.args << QStringLiteral("mcp_servers.%1.bearer_token_env_var=%2")
                                    .arg(k, envName);
                    out.env.insert(envName, srv.token);
                }
            }
        }
    }
    return out;
}

QString ControlServer::resolveConnectorEnv(const QString &valueOrRef) const
{
    // "secret:<key>" -> SettingsStore.apiKey(<key>); anything else is a literal.
    const QString prefix = QStringLiteral("secret:");
    if (valueOrRef.startsWith(prefix))
        return m_settings.apiKey(valueOrRef.mid(prefix.size()));
    return valueOrRef;
}

// --- Claude --mcp-config JSON ----------------------------------------------

// Build a {"mcpServers":{<key>:{...}}} object for every enabled MCP server.
// `computerUseEndpoint`/`computerUseBearer` override the built-in computer-use
// entry (used to point it at a nested per-session engine for coworker+agent).
// `resolveEnv` resolves a stdio connector row's env values ("secret:<key>" refs
// or literals) so an enabled Google connector's OAuth creds reach the brain.
static QJsonObject claudeMcpServersObject(McpRegistry *mcp,
                                          const QString &cuEndpoint = QString(),
                                          const QString &cuBearer = QString(),
                                          const McpRegistry::EnvResolver &resolveEnv = {})
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
            // Connector env (Google OAuth creds), resolved through SettingsStore.
            if (!srv.env.isEmpty()) {
                QJsonObject resolved;
                for (auto it = srv.env.constBegin(); it != srv.env.constEnd(); ++it) {
                    const QString value = resolveEnv ? resolveEnv(it.value().toString())
                                                     : it.value().toString();
                    if (!value.isEmpty())
                        resolved.insert(it.key(), value);
                }
                if (!resolved.isEmpty())
                    entry.insert(QStringLiteral("env"), resolved);
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
    root.insert(QStringLiteral("mcpServers"),
                claudeMcpServersObject(m_mcp.get(), QString(), QString(),
                                       [this](const QString &ref) { return resolveConnectorEnv(ref); }));
    return QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact));
}

QString ControlServer::claudeMcpConfigForAgent(const AgentDesktopInfo &desk) const
{
    QJsonObject servers = claudeMcpServersObject(
        m_mcp.get(), desk.mcpUrl, desk.bearer,
        [this](const QString &ref) { return resolveConnectorEnv(ref); });
    // ALSO expose the GLOBAL :8794 engine as "real_screen" so claude can drive the
    // USER'S real KDE screen (the "computer_use" entry above is the nested agent
    // desktop, which can't reach the host). Same rationale as the codex path.
    {
        QJsonObject real;
        real.insert(QStringLiteral("type"), QStringLiteral("http"));
        real.insert(QStringLiteral("url"), McpRegistry::builtinEndpoint());
        const QString bearer = McpRegistry::computerUseBearer();
        if (!bearer.isEmpty()) {
            QJsonObject headers;
            headers.insert(QStringLiteral("Authorization"),
                           QStringLiteral("Bearer ") + bearer);
            real.insert(QStringLiteral("headers"), headers);
        }
        servers.insert(QStringLiteral("real_screen"), real);
    }
    QJsonObject root;
    root.insert(QStringLiteral("mcpServers"), servers);
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

void ControlServer::sweepIdleDesktops()
{
    // Idle threshold: 8 minutes of no turn AND not currently viewed. Conservative
    // so we never tear a desktop out from under an active/watched session; if we
    // get it wrong the next turn revives it transparently (reserved port+bearer).
    constexpr qint64 kIdleMs = 8 * 60 * 1000;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    // Scopes a viewer (chat open, peek/Computer mirroring) is holding right now.
    const QStringList viewed = m_widgetLeases.activeScopes();
    const bool anyAllViewer = viewed.contains(QStringLiteral("all"));

    const QList<QString> autos = m_autoComputerSessions.values();
    for (const QString &sid : autos) {
        if (!m_agentDesktops.has(sid))
            continue;                         // already down
        if (Brain *b = m_brains.value(sid, nullptr); b && b->isBusy())
            continue;                         // mid-turn — never tear down
        if (viewed.contains(sid) || anyAllViewer)
            continue;                         // being watched (chat/peek/canvas)
        const qint64 last = m_deskLastActive.value(sid, 0);
        if (last > 0 && now - last < kIdleMs)
            continue;                         // ran a turn recently
        // Idle + unviewed + not busy → free the compositor + engine (keep the
        // reservation so the next turn re-provisions an identical desktop).
        m_agentDesktops.teardown(sid);
        qInfo("jarvisd: idle-teardown agent desktop for unviewed session %s (battery)",
              qPrintable(sid));
    }
}

QString ControlServer::permissionPolicyClause() const
{
    // Auto-ranked tool risk tiers (by capability, not by individual tool name):
    //   HIGH   — irreversible / outward-facing / touches the user's real world:
    //            deleting or overwriting files, destructive shell (rm, mv -f,
    //            git reset --hard, kill), running the USER'S REAL screen
    //            (real_screen_* tools), ssh exec on a remote host, sending a
    //            file/message outward, installing/uninstalling, schedule_task
    //            that performs an action, anything spending money or posting.
    //   MEDIUM — meaningful but reversible / scoped to the agent: writing/editing
    //            files, non-destructive shell, driving the agent's own desktop in
    //            ways that change state, editing memory/skills, canvas/widget
    //            deletes, browser form submits.
    //   LOW    — read-only / cosmetic: reading files, listing, search, recall,
    //            rendering a widget/canvas, screenshots, status checks.
    const QString level = m_settings.permissionLevel();

    QString head = QStringLiteral(
        "[PERMISSION POLICY] Before you ACT, silently rank the action's risk:\n"
        "  HIGH = irreversible or touches the user's real world — deleting/"
        "overwriting files, destructive shell (rm, mv -f, git reset --hard, kill), "
        "operating the USER'S REAL screen, ssh exec on a remote host, "
        "installing/uninstalling, sending files/messages outward, spending money, "
        "or posting anything public.\n"
        "  MEDIUM = meaningful but reversible/scoped to you — writing or editing "
        "files, non-destructive shell, changing state on your own agent desktop, "
        "editing memory/skills, deleting a canvas/widget, submitting a web form.\n"
        "  LOW = read-only or cosmetic — reading, listing, searching, recall, "
        "rendering a widget, screenshots, status checks. NEVER ask for LOW.\n");

    QString rule;
    if (level == QStringLiteral("high")) {
        rule = QStringLiteral(
            "Your permission level is HIGH (cautious). You MUST call ask_user "
            "(with a one-line plain-language summary and Yes/No-style choices) and "
            "wait for approval BEFORE any HIGH or MEDIUM risk action. Only LOW "
            "read-only actions proceed without asking. When several similar actions "
            "are part of one approved task, you may ask once for the batch.");
    } else if (level == QStringLiteral("low")) {
        rule = QStringLiteral(
            "Your permission level is LOW (autonomous). Act on your own for LOW and "
            "MEDIUM actions. You must STILL call ask_user before the most dangerous "
            "HIGH actions — anything irreversible and destructive (deleting/"
            "overwriting the user's files, destructive shell, operating their REAL "
            "screen, ssh exec, installs, spending money, posting publicly).");
    } else { // medium (default)
        rule = QStringLiteral(
            "Your permission level is MEDIUM (balanced). Call ask_user and wait for "
            "approval BEFORE any HIGH risk action. MEDIUM and LOW actions proceed "
            "without asking, but narrate what you're about to do so the user can "
            "stop you.");
    }

    return QStringLiteral("\n") + head + rule +
           QStringLiteral(" The user can change this level in Settings → "
                          "Permissions. Respect it for the whole session.");
}

QString ControlServer::modePolicyClause() const
{
    const QString mode = m_settings.agentMode();
    if (mode == QStringLiteral("plan")) {
        return QStringLiteral(
            "\n[MODE: PLAN] You are in PLAN mode. RESEARCH the task and produce a "
            "clear, step-by-step PLAN using todo_write (one item per step). Do NOT "
            "make changes yet — no file edits, no installs, nothing destructive or "
            "outward-facing; read-only investigation only. When the plan is ready, "
            "present it and ask the user to approve (and switch to BUILD mode) "
            "before you execute. The user picks the mode in Settings.");
    }
    if (mode == QStringLiteral("build")) {
        return QStringLiteral(
            "\n[MODE: BUILD] You are in BUILD mode. Execute the agreed plan "
            "autonomously and efficiently. Keep your todo list current (mark items "
            "in_progress / done as you go). Ask only when an action is genuinely "
            "risky per the permission policy above; otherwise keep moving and "
            "narrate what you're doing. The user picks the mode in Settings.");
    }
    // "coworker" (default): no extra clause — the balanced behavior already lives
    // in the co-work guide + the permission policy.
    return QString();
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
    // A pasted document/transcript is NOT a memory. A deliberate "remember that …"
    // note is short; bail on anything long so a big paste that merely CONTAINS a cue
    // word can't dump its tail into memory (the original junk-memory bug).
    if (t.size() > kMaxAutoMemorySource)
        return;
    static const QStringList cues = {
        QStringLiteral("remember that "), QStringLiteral("remember to "),
        QStringLiteral("note that "),     QStringLiteral("keep in mind that "),
        QStringLiteral("don't forget that "), QStringLiteral("for future reference, "),
    };
    const QString lower = t.toLower();
    for (const QString &cue : cues) {
        // Require the cue to START the message (a deliberate instruction), not just
        // appear somewhere inside it.
        if (!lower.startsWith(cue))
            continue;
        QString fact = t.mid(cue.size()).trimmed();
        // One concise fact: first line only, hard-capped.
        const int nl = fact.indexOf(QLatin1Char('\n'));
        if (nl >= 0)
            fact = fact.left(nl).trimmed();
        if (fact.size() > kMaxAutoMemoryChars)
            fact = fact.left(kMaxAutoMemoryChars).trimmed();
        if (fact.size() >= 4)
            m_memory.add(fact, {QStringLiteral("auto"), QStringLiteral("user")});
        return;
    }
}

QString ControlServer::createSession(const QString &profile, const QString &brainName,
                                     const QString &model, const QString &cwd,
                                     const QString &title, QString *err,
                                     const QString &target, const QString &parentSessionId,
                                     const QString &agent, const QString &agentPromptOverride)
{
    // Custom-agent (subagent) resolution: when this session runs AS an agent,
    // a DEFINED agent supplies its brain/model/profile + system prompt; but an
    // AD-HOC subagent (an unknown name + an inline system prompt) is fine too —
    // the model can spin one up on the fly. An unknown name is NOT an error; it's
    // just a label. Explicit brain/model args always win over a def's.
    QString effProfile = profile, effBrain = brainName, effModel = model;
    QString agentName, agentPrompt;
    if (!agent.trimmed().isEmpty()) {
        agentName = agent.trimmed();   // label even when there's no stored def
        if (auto adef = m_agents.get(agent.trimmed())) {
            agentName = adef->fm.name;
            agentPrompt = adef->systemPrompt;
            if (effBrain.isEmpty() && !adef->fm.brain.isEmpty())
                effBrain = adef->fm.brain;
            if (effModel.isEmpty() && !adef->fm.model.isEmpty())
                effModel = adef->fm.model;
            if (effProfile.isEmpty() && !adef->fm.profile.isEmpty())
                effProfile = adef->fm.profile;
        }
    }
    // An inline system prompt (ad-hoc subagent, or an override) wins.
    if (!agentPromptOverride.trimmed().isEmpty())
        agentPrompt = agentPromptOverride;

    SessionRow row;
    row.id = genSessionId();
    row.parentSessionId = parentSessionId;
    row.agent = agentName;
    row.profile = effProfile.isEmpty() ? QStringLiteral("coder") : effProfile;
    row.brain = effBrain.isEmpty() ? m_config.defaultBrain : effBrain;
    // BRAIN DEFAULT FIX: when the caller gives no model, pick the per-brain
    // default (the FIRST entry of modelsForBrain) — a claude brain gets a claude
    // model, an api brain a configured-provider model — NOT the global default
    // (gpt-5.5), which is only the right default for codex. Only fall back to the
    // global default_model when it actually belongs to this brain (i.e. codex).
    if (!effModel.isEmpty()) {
        row.model = effModel;
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

    // Stash the agent's system prompt so sendToSession injects it on turn 1.
    if (!agentPrompt.trimmed().isEmpty())
        m_sessionAgentPrompt.insert(row.id, agentPrompt.trimmed());

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

    // AUTO-SPAWN (headline): when "Let Jarvis use a computer/browser" is ON, ANY
    // session — a plain chat included — gets a per-session nested agent desktop +
    // computer-use MCP injected so the brain CAN drive the computer/Chrome on
    // demand with no manual "Computer" tab / co-work step. We only need a desktop
    // for a brain that can actually call MCP tools headless (codex/claude always;
    // api only with a key); for one that can't we just skip the desktop (the chat
    // still works, it just can't use the computer). A coworker+agent session
    // always provisions (its whole point); target="real" take-over uses the
    // global engine, not a nested desktop, so it is never auto-provisioned here.
    const bool apiCanDrive = m_settings.hasApiKey(QStringLiteral("openai")) ||
                             m_settings.hasApiKey(QStringLiteral("anthropic"));
    const bool brainCanDrive =
        row.brain == QStringLiteral("codex") || row.brain == QStringLiteral("claude") ||
        (row.brain == QStringLiteral("api") && apiCanDrive);
    const bool explicitAgent = isCoworker && effTarget == QStringLiteral("agent");
    // A take-over is ONLY an explicit target="real" request (the caller asked to
    // drive the user's real screen via the global engine). A plain chat passes NO
    // target — its effTarget defaults to "real" but it is NOT a take-over, so it
    // should still auto-provision a nested desktop. Distinguish by the RAW target.
    const bool explicitTakeOver = (target == QStringLiteral("real"));
    const bool autoComputer = m_settings.letJarvisUseComputer() &&
                              !explicitTakeOver && !explicitAgent && brainCanDrive;

    CodexMcpOverrides agentOverrides;
    if (explicitAgent || autoComputer) {
        // For an EXPLICIT coworker+agent session a brain that can't drive is a
        // hard error (the user asked for a co-work). For the AUTO path it isn't —
        // we already gated on brainCanDrive above, so this only fires for the
        // explicit case with the api brain + no key.
        if (explicitAgent && row.brain == QStringLiteral("api") && !apiCanDrive) {
            m_store.updateState(row.id, QStringLiteral("error"));
            if (err)
                *err = QStringLiteral(
                    "the 'api' brain can't drive the computer-use desktop without "
                    "an OpenAI or Anthropic API key — pick the codex or claude "
                    "brain, or set an API key in Settings");
            return QString();
        }
        QString deskErr;
        const AgentDesktopInfo desk = m_agentDesktops.ensure(row.id, &deskErr);
        if (!desk.up) {
            if (explicitAgent) {
                // Explicit co-work: failing to spin the desktop is fatal.
                m_store.updateState(row.id, QStringLiteral("error"));
                if (err)
                    *err = QStringLiteral("agent desktop failed: ") + deskErr;
                return QString();
            }
            // AUTO path: degrade gracefully — the chat session still runs without
            // computer-use rather than failing the whole session.
            qWarning("jarvisd: auto computer-use desktop unavailable for %s (%s); "
                     "session continues without computer-use",
                     qPrintable(row.id), qPrintable(deskErr));
        } else {
            agentOverrides = agentMcpOverridesFor(desk);
            // Track AUTO-spawned desktops (for diagnostics / future idle policy).
            // They live for the session's lifetime — like an explicit co-work
            // desktop — so a multi-turn chat keeps the SAME engine/port/bearer
            // baked into the brain and can use the computer again next turn. Both
            // AUTO and explicit desktops are torn down on session cancel/delete
            // (the session's release signal) and any crash leftovers are reaped
            // by sweepOrphans() at daemon start.
            if (!explicitAgent)
                m_autoComputerSessions.insert(row.id);
        }
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
    // When a turn truly finishes (process exited, brain free), flush any turn the
    // user queued while it was still busy. The `final` event fires earlier (on the
    // usage line) while the CLI process is still shutting down its MCP client, so
    // a fast follow-up would hit "brain is busy" — queue + flush on turnFinished.
    connect(brain, &Brain::turnFinished, this, &ControlServer::onTurnFinished);
    m_brains.insert(row.id, brain);

    // Session is now fully live (persisted + brain wired). Surface it everywhere:
    // signal the apps to OPEN/FOCUS this session's chat. This fires on the SINGLE
    // shared success exit so it covers BOTH the control-WS caller path and the
    // scheduler path; all early-error returns are above this point.
    broadcastSessionOpened(row.id, row.title);  // control-WS fan-out (desktop)
    emit sessionOpened(row.id, row.title);      // device-WS + FCM fan-out (phone)
    return row.id;
}

QString ControlServer::subagentSummary(const QString &sessionId)
{
    // The child's LAST assistant message — which (per the dispatch instruction) is a
    // concise summary of what it did + the result.
    QString last;
    for (const StoredEvent &e : m_store.listEvents(sessionId)) {
        const QJsonObject o = e.ev.toJson();
        if (o.value(QStringLiteral("kind")).toString() == QStringLiteral("message") &&
            o.value(QStringLiteral("role")).toString() == QStringLiteral("assistant")) {
            const QString t = o.value(QStringLiteral("text")).toString();
            if (!t.trimmed().isEmpty())
                last = t;
        }
    }
    return last;
}

void ControlServer::wakeParentForSubagent(const QString &childSid)
{
    // One-shot: only the FIRST trigger (final OR turnFinished) wakes the parent.
    if (!m_subagentPendingWake.contains(childSid))
        return;
    const QString parentSid = m_subagentPendingWake.take(childSid);
    const bool parentOk = m_store.get(parentSid).has_value();
    qInfo("jarvisd: subagent %s done -> waking parent %s (parentOk=%d)",
          qPrintable(childSid), qPrintable(parentSid), int(parentOk));
    if (!parentOk)
        return;
    const auto row = m_store.get(childSid);
    const QString label = (row && !row->agent.isEmpty()) ? row->agent
                                                          : QStringLiteral("subagent");
    const QString state = row ? row->state : QStringLiteral("done");
    QString summary = subagentSummary(childSid);
    if (summary.trimmed().isEmpty())
        summary = QStringLiteral("(the subagent returned no text — check its session)");
    const QString wake = QStringLiteral(
        "[SUBAGENT DONE] Your subagent \"%1\" (session %2) finished — status: %3.\n"
        "Its summary / result:\n%4\n\nReview this result and continue the task "
        "(you can call agent_result(\"%2\") for the full details).")
        .arg(label, childSid, state, summary);
    QString werr;
    // sendToSession queues if the parent is still busy (flushed on its turn end),
    // so the main agent is pinged whether it waited or kept working.
    if (!sendToSession(parentSid, wake, {}, &werr))
        qWarning("jarvisd: subagent wake send failed: %s", qPrintable(werr));
}

void ControlServer::onTurnFinished(const QString &sessionId)
{
    // Backup wake trigger (the primary is the `final` event in onBrainEvent).
    wakeParentForSubagent(sessionId);

    if (!m_pendingTurns.contains(sessionId))
        return;
    const HeldTurn pending = m_pendingTurns.take(sessionId);
    QString err;
    // Re-enter the normal send path (injection gate + memory prefetch re-applied).
    sendToSession(sessionId, pending.text, pending.images, &err);
}

void ControlServer::generateSessionTitle(const QString &sessionId, const QString &seed)
{
    // Cheap, async, model-generated title from the first user message — reuses the
    // Mistral key (already configured for voice). Replaces the truncated placeholder.
    const QString key = m_settings.apiKey(QStringLiteral("mistral"));
    if (key.isEmpty() || seed.trimmed().isEmpty() || m_titleGenStarted.contains(sessionId))
        return;
    m_titleGenStarted.insert(sessionId);
    if (!m_titleNam)
        m_titleNam = new QNetworkAccessManager(this);

    QJsonArray msgs;
    QJsonObject sys;
    sys.insert(QStringLiteral("role"), QStringLiteral("system"));
    sys.insert(QStringLiteral("content"),
               QStringLiteral("Generate a concise 3-5 word Title Case title for a chat that "
                              "begins with the user's message. Reply with ONLY the title — no "
                              "quotes, no trailing punctuation."));
    msgs.append(sys);
    QJsonObject usr;
    usr.insert(QStringLiteral("role"), QStringLiteral("user"));
    usr.insert(QStringLiteral("content"), seed.left(400));
    msgs.append(usr);

    QJsonObject body;
    body.insert(QStringLiteral("model"), QStringLiteral("mistral-small-latest"));
    body.insert(QStringLiteral("max_tokens"), 16);
    body.insert(QStringLiteral("temperature"), 0.3);
    body.insert(QStringLiteral("messages"), msgs);

    QNetworkRequest rq(QUrl(QStringLiteral("https://api.mistral.ai/v1/chat/completions")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + key.toUtf8());
    QNetworkReply *reply =
        m_titleNam->post(rq, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, sessionId]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError)
            return;
        const QJsonObject o = QJsonDocument::fromJson(reply->readAll()).object();
        const QJsonArray choices = o.value(QStringLiteral("choices")).toArray();
        if (choices.isEmpty())
            return;
        QString title = choices.first().toObject()
                            .value(QStringLiteral("message")).toObject()
                            .value(QStringLiteral("content")).toString();
        title = title.remove(QLatin1Char('"')).remove(QLatin1Char('\n')).trimmed();
        while (!title.isEmpty() && (title.endsWith(QLatin1Char('.'))
               || title.endsWith(QLatin1Char('!')) || title.endsWith(QLatin1Char('?'))))
            title.chop(1);
        if (title.length() > 60)
            title = title.left(57).trimmed() + QStringLiteral("…");
        if (!title.isEmpty() && m_store.get(sessionId))
            m_store.updateTitle(sessionId, title);  // shows on the Sessions list
    });
}

bool ControlServer::sendToSession(const QString &sessionId, const QString &text,
                                  const QStringList &images, QString *err)
{
    Brain *brain = m_brains.value(sessionId, nullptr);
    if (!brain) {
        // No LIVE brain (the daemon restarted, or this is an OLD session the user
        // just opened from the Sessions list). RESUME it: re-spawn a brain so the
        // user can keep talking instead of hitting "inactive session". The on-disk
        // transcript is shown by the app; the fresh brain continues the thread.
        if (auto row = m_store.get(sessionId)) {
            brain = makeBrain(*row, QString(), CodexMcpOverrides{});
            if (brain) {
                connect(brain, &Brain::event, this, &ControlServer::onBrainEvent);
                connect(brain, &Brain::turnFinished, this, &ControlServer::onTurnFinished);
                m_brains.insert(sessionId, brain);
                m_store.updateState(sessionId, QStringLiteral("idle"));
            }
        }
    }
    if (!brain) {
        if (err)
            *err = QStringLiteral("unknown or inactive session: ") + sessionId;
        return false;
    }

    // BATTERY (re-provision): if this session's auto agent-desktop was idle-torn-
    // down while you weren't watching, bring it back NOW — at its RESERVED port +
    // bearer, so the brain's baked MCP config still resolves and computer-use just
    // works again. ensure() is a no-op if the desktop is already up.
    if (m_autoComputerSessions.contains(sessionId) && !m_agentDesktops.has(sessionId)) {
        QString deskErr;
        m_agentDesktops.ensure(sessionId, &deskErr);
    }
    m_deskLastActive.insert(sessionId, QDateTime::currentMSecsSinceEpoch());

    // If the brain is mid-turn (or winding down after the `final` event), QUEUE
    // this turn and flush it on turnFinished — never reject the user's message.
    // Only the newest queued turn is kept (a rapid double-send coalesces).
    if (brain->isBusy()) {
        m_pendingTurns.insert(sessionId, HeldTurn{text, images});
        return true;
    }

    // PROMPT-INJECTION GATING (BUILD_SPEC): scan the user turn (+ any page/
    // screenshot text the daemon can see) before it reaches the brain. For an
    // ApiBrain session a risky turn BLOCKS here — we emit an approval event and
    // do not send until approval.respond arrives. For CLI brains this only
    // audits (they run their own tool loop and can't be intercepted mid-loop).
    QString brainName;
    bool isSubagent = false;
    if (auto row = m_store.get(sessionId)) {
        brainName = row->brain;
        // A SUBAGENT (a child session) is ISOLATED: it gets ONLY its own system
        // prompt + the task its parent gave it — no shared Jarvis memory, no co-work
        // preamble, and it doesn't write back into the shared memory.
        isSubagent = !row->parentSessionId.isEmpty();
    }
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

    // Auto-title an untitled session from its FIRST user message so the Sessions
    // list isn't a wall of "Untitled session". Only sets it while still untitled.
    if (auto row = m_store.get(sessionId);
        row && (row->title.isEmpty() || row->title == QStringLiteral("Untitled session"))) {
        QString t = text.trimmed();
        t.replace(QLatin1Char('\n'), QLatin1Char(' '));
        if (t.length() > 48)
            t = t.left(47).trimmed() + QStringLiteral("…");
        if (!t.isEmpty())
            m_store.updateTitle(sessionId, t);   // immediate placeholder
        // ...and kick off a model-generated title to replace it (async, cheap).
        generateSessionTitle(sessionId, text);
    }

    // Persist the USER's turn to history so it replays on reload. Brain events are
    // persisted via onBrainEvent; WITHOUT this the user's own message is never
    // stored, so a reopened session shows only the assistant's side.
    m_store.appendEvent(sessionId,
                        NormalizedBrainEvent::message(QStringLiteral("user"), text));

    // Memory PREFETCH (HERMES_FEATURES §1): prepend a relevant-memory block so the
    // model has context. SKIPPED for a subagent — it must NOT inherit the main
    // agent's memory; it only gets its own prompt + task.
    QString effectiveText = text;
    if (!isSubagent) {
        const QString memBlock = prefetchMemoryBlock(text);
        if (!memBlock.isEmpty())
            effectiveText = memBlock + QStringLiteral("\n---\n") + text;
    }

    // ONE-TIME co-work guidance: the first turn a session has computer-use, teach
    // the model the screen-targeting contract + the ASK-WHEN-AMBIGUOUS rule the
    // user asked for. Every computer-use tool takes a `which` arg: "agent" = the
    // model's own private nested desktop (default, watched on the Computer page);
    // "real" = the user's REAL screen (glowing banner shows). If the user doesn't
    // say whose screen, the model MUST ask_user first.
    if (!isSubagent && m_agentDesktops.has(sessionId) && !m_coworkGuided.contains(sessionId)) {
        m_coworkGuided.insert(sessionId);
        const QString guide = QStringLiteral(
            "[Jarvis co-work — READ FIRST] You have TWO separate computer-use tool "
            "sets, plus ask_user, schedule_task, remember/recall/forget, create_skill.\n"
            "  * The \"real_screen\" tools operate the USER'S REAL screen + windows "
            "(what they physically see). A glowing \"Jarvis is using this computer\" "
            "banner appears while you act there.\n"
            "  * The \"computer_use\" tools operate YOUR OWN private agent desktop (a "
            "separate screen the user watches on the Computer page). This is the DEFAULT.\n"
            "Pick the tool set by which SCREEN to use — do NOT pass a `which` "
            "argument (each set already targets the right screen; valid `which` "
            "values are only active/kde/agent, never \"real\").\n"
            "RULES:\n"
            "1) User explicitly says THEIR screen/computer/monitor -> use the "
            "real_screen tools.\n"
            "2) User says YOUR OWN / a new / the agent desktop -> use the "
            "computer_use tools.\n"
            "RESET: if your own agent desktop gets cluttered or an app is stuck, call "
            "desktop_reset to close every window on it and start fresh (it never touches "
            "the user's real screen).\n"
            "3) If they ask you to operate a computer or app but do NOT say whose "
            "screen (e.g. just \"open spotify\"), you MUST call ask_user(\"Use your "
            "real screen, or my own agent desktop?\", [\"My real screen\", \"Your own "
            "agent desktop\"]) FIRST, then use the matching tool set. Never guess.\n"
            "VISUALS: whenever the user asks you to SHOW / DRAW / DISPLAY / VISUALIZE "
            "something (a chart, a list, a diagram, a card, \"show me a duck\"), you "
            "MUST CALL the render_widget tool with a JSON spec — it pops the widget on "
            "their Canvas/chat. Do NOT just describe it in words; actually render it.\n"
            "SENDING FILES/PHOTOS: the user is on a PHONE and CANNOT open local desktop "
            "paths. Whenever they ask you to SEND / SHARE / \"give me\" / download a file, "
            "image, photo, slide, screenshot, PDF, log, etc., you MUST CALL the send_file "
            "tool with that file's full path (it also accepts base64) — it delivers the "
            "file INTO their chat, where images render inline and any other type gets a "
            "Download button. NEVER upload to Google Drive, never paste a local file path, "
            "and never return a markdown image link like ![x](/home/...): none of those "
            "work on their phone. Always use send_file.\n"
            "SHOWING YOUR WORK (agent desktop): when the user asks to SEE / SHOW / "
            "\"send me a screenshot of\" / \"what does it look like\" what you're doing on "
            "your own agent desktop, CALL desktop_screenshot to capture your agent screen, "
            "then send_file with that screenshot path so it lands in their chat (visible on "
            "BOTH desktop and phone). They can also watch you LIVE — the in-chat agent peek "
            "panel and the Computer page mirror your desktop in real time — so feel free to "
            "say \"watch live on the right\" too. Take + send a fresh screenshot whenever it "
            "helps them follow along.\n"
            "MEMORY: when the user states a durable fact or preference (their name, how "
            "they like things done, project details, decisions), CALL remember to save "
            "it — and edit_memory / forget to keep it current. Use recall / list_memories "
            "to check what you already know before asking again.\n"
            "SKILLS: when you work out a repeatable procedure the user may want again, "
            "save it as a Jarvis skill — but you MUST use the create_skill MCP TOOL "
            "(NOT your own CLI's skill files / not by writing to ~/.codex/skills or "
            "~/.claude/skills yourself). Only create_skill registers it in Jarvis so it "
            "shows in the Skills tab and is invokable everywhere; a file you write "
            "directly will NOT appear. Use create_skill(name, description, body), "
            "edit_skill to refine, list_skills / get_skill to inspect, remove_skill to "
            "delete, skill_load(name, args) to load + run one. Build skills proactively when it "
            "helps — don't wait to be told.\n"
            "SKILLS-ON-MENTION: when the user sends a message that is a skill invocation "
            "(it looks like \"/skill-name\" or names a skill), your FIRST action MUST be to "
            "CALL the skill_load tool with that name (skill_load(name, args)) — that returns "
            "the skill's full instructions. Then read them completely and ACTUALLY DO what "
            "they say. Do NOT answer from memory and do NOT just acknowledge it — load it "
            "with the tool, then apply it. (get_skill reads one without running it.)\n"
            "AGENTS (subagents): when the user asks you to 'spin up / use a subagent', or "
            "a sub-task is worth offloading, ACTUALLY dispatch one — call "
            "agent_start(name, task, brain?, model?, system_prompt?). You do NOT need a "
            "predefined agent: `name` can be any label and you spawn an AD-HOC subagent "
            "(optionally picking its brain/model and giving a one-off system_prompt). It "
            "runs as its own child session and reports back. Do NOT just SAY you delegated "
            "and then do the work yourself — call agent_start(name, task) (returns a "
            "session_id). THEN CHOOSE, by the user's intent:\n"
            "  • Need the result before continuing? → call agent_wait(session_id): it BLOCKS "
            "until the subagent finishes and returns its summary. (Don't poll agent_status "
            "in a loop — use agent_wait.)\n"
            "  • Have other work to do meanwhile? → just keep working; you'll be AUTO-PINGED "
            "with a [SUBAGENT DONE] message (its summary + status) the moment it finishes, "
            "then read that and continue.\n"
            "Either way you always get the summary. agent_result(session_id) re-fetches it; "
            "agent_status lists running ones; agent_stop cancels; agent_create saves a "
            "reusable agent for recurring work.\n"
            "CAPABILITIES: if the user asks what you can do / your features / how to do "
            "something with you, OR you're unsure what you're capable of, CALL "
            "skill_load(\"internal_docs\") — it returns the full list of your features + docs. "
            "Use it before saying you can't do something.\n"
            "PLAN / TODO: for any task with 3+ steps (or when the user asks your plan), "
            "CALL todo_write with your step list up front — [{\"text\":\"…\",\"status\":"
            "\"pending|in_progress|done\"}] — then keep it current as you go (keep exactly "
            "ONE step in_progress). It shows the user a live checklist card. For single-step "
            "edits without resending the whole list use todo_add(text), todo_done(id), "
            "todo_edit(id,text,status), todo_del(id) — `id` can be the step's id (from "
            "todo_read), its 1-based number, or matching text. todo_clear when the job is "
            "done. Skip it for trivial one-shot requests.\n"
            "CANVAS vs WIDGETS: a render_widget draw is a CANVAS (an ad-hoc, drawn-once "
            "thing). A WIDGET is a CANVAS the user SAVED into the reusable Widgets tab. "
            "render_widget puts a canvas on the Canvas tab by default (target:\"canvas\"); "
            "set target:\"chat\" to ALSO drop it inline in the conversation (do that when "
            "the user asks to see it here — e.g. \"show me a duck\"). Saved-widget tools: "
            "widget_save/widget_list/widget_get/widget_edit/widget_del, and widget_render "
            "to re-show a saved widget. Manage canvases with canvas_list/canvas_edit/"
            "canvas_del/canvas_clear (canvas_edit or render_widget with the SAME id updates "
            "in place).\n"
            "HOME SCREEN (desktop app): the desktop app has a HOME dashboard the user can "
            "curate. When the user says \"add that to my home screen\", \"pin this widget to "
            "home\", \"I want this on my home page\", CALL home_pin — either home_pin(id=\"<an "
            "existing canvas/saved-widget id>\") or home_pin(spec={…}, title=\"…\") to pin a "
            "fresh widget directly. You have FULL CRUD over the desktop Home: home_list "
            "(what's pinned), home_pin (add), home_unpin(id) (remove one), home_move(id, "
            "position) (reorder, 0 = top), home_clear (remove all). If they ask you to "
            "CHANGE a pinned widget, re-pin it with the same id (home_pin copies the "
            "current spec) or edit the source then re-pin.\n"
            "LIVE / AUTO-UPDATING: to make a canvas keep refreshing on its own — for "
            "ANYTHING, not just system stats — call widget_live(id, command, spec, "
            "interval_sec, target): a background loop runs `command`, substitutes its "
            "output wherever \"{{value}}\" appears in `spec`, and re-renders that id every "
            "interval. e.g. live CPU: command \"top -bn1 | awk '/Cpu/{print 100-$8}'\", "
            "spec a progress with value \"{{value}}\". widget_live_stop(id) stops it; "
            "widget_live_list() shows running jobs. Use the cadence the user wants (or a "
            "one-shot render_widget if they don't want it updating).\n"
            "The spec is a tree of typed nodes; build whatever layout you want:\n"
            "  • Containers: {\"type\":\"column\"|\"row\"|\"grid\",\"children\":[…]} — style "
            "them with gap, pad, bg (background color), radius, border (+borderW), and size "
            "them with w/h or fill:true (take full width). grid also takes cols.\n"
            "  • Per-child layout: any child may set grow:true (expand to fill), "
            "align:\"left\"|\"center\"|\"right\", and w/h to size itself.\n"
            "  • Leaves: text (color,size,bold,weight 100-900,italic,spacing,line,align,"
            "mono/display,maxLines), badge, rect (w,h,radius,color), divider, spacer "
            "(size or grow:true), progress (value 0..1 or 0..100), list (rows of "
            "{text,sub,badge,color}), link (http/https), image (url + w/h), and button "
            "({\"type\":\"button\",\"text\":\"…\",\"action\":{\"send\":\"…\"} or "
            "{\"skill\":\"…\",\"args\":\"…\"}} — buttons route back into THIS chat).\n"
            "  • MULTI-PAGE: {\"type\":\"pager\",\"pages\":[<node>,…]} shows one page at a "
            "time with an animated transition + page dots. Buttons drive it WITHOUT a model "
            "turn: action {\"next\":true}/{\"prev\":true}/{\"goto\":N} moves pages, and "
            "{\"correct\":true|false} flashes a quiz answer green/red. A quiz = one page per "
            "question; each answer button {\"correct\":true,\"next\":true} (right → ✓ → next) "
            "or {\"correct\":false} (wrong → ✗). Use this for quizzes/wizards/slideshows.\n"
            "  • For real ART or charts (a duck, a graph, a diagram, an icon): use a "
            "{\"type\":\"svg\",\"svg\":\"<svg …>…</svg>\",\"w\":…,\"h\":…} node with actual "
            "SVG markup, or {\"type\":\"canvas\",\"w\":…,\"h\":…,\"ops\":[…]} draw ops "
            "(circle/ellipse/rect/path/line). NEVER a one-word label like \"Duck\".\n"
            "Give the top node a sensible w/h or fill:true so it isn't cramped. Always "
            "actually CALL render_widget — don't describe the widget in words.");
        effectiveText = guide + permissionPolicyClause() + modePolicyClause() +
                        QStringLiteral("\n---\n") + effectiveText;
    }

    // ONE-TIME agent role injection: if this session runs AS a custom agent, put
    // its system prompt at the very FRONT of the first turn so it dominates.
    if (m_sessionAgentPrompt.contains(sessionId) && !m_agentGuided.contains(sessionId)) {
        m_agentGuided.insert(sessionId);
        const QString ap = m_sessionAgentPrompt.value(sessionId);
        if (!ap.trimmed().isEmpty())
            effectiveText = QStringLiteral("[You are acting as a specialized agent. "
                                           "Follow this role:]\n") +
                            ap + QStringLiteral("\n---\n") + effectiveText;
    }

    brain->send(effectiveText, images);

    // Memory SYNC (post-turn write of salient user facts). SKIPPED for a subagent —
    // its isolated task must not pollute the main agent's long-term memory.
    if (!isSubagent)
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
    m_agentDesktops.releaseSession(sessionId);   // drop the desktop + its reservation
    m_autoComputerSessions.remove(sessionId);
    m_deskLastActive.remove(sessionId);
    return true;
}

bool ControlServer::deleteSession(const QString &sessionId, QString *err)
{
    // 1) Tear down any live brain for this session (cancel its turn first so a
    //    running tool loop is asked to stop, then delete + drop the map entry).
    if (Brain *brain = m_brains.take(sessionId)) {
        brain->cancel();
        brain->deleteLater();
    }
    // 2) End any take-over and drop a held (gated) turn.
    if (m_takeOverActive.contains(sessionId))
        setTakeOverActive(sessionId, false);
    m_injectionHeld.remove(sessionId);
    // 3) Tear down the nested agent desktop (compositor + per-session engine) and
    //    drop its port/bearer reservation — the session is gone for good.
    m_agentDesktops.releaseSession(sessionId);
    m_autoComputerSessions.remove(sessionId);
    m_deskLastActive.remove(sessionId);
    m_coworkGuided.remove(sessionId);
    m_sessionAgentPrompt.remove(sessionId);
    m_agentGuided.remove(sessionId);
    m_subagentPendingWake.remove(sessionId);   // as a child awaiting parent-wake
    // 4) Drop the row + its event stream from the store.
    if (!m_store.deleteSession(sessionId)) {
        if (err)
            *err = m_store.lastError();
        return false;
    }
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
        p.value(QStringLiteral("target")).toString(),
        p.value(QStringLiteral("parent_session_id")).toString(),
        p.value(QStringLiteral("agent")).toString());
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

// Decode the session.send `images` param into local file PATHS the brains can
// attach. The phone sends [{mime, b64}]; a desktop client may send a "data:" URI
// or an already-on-disk path string. Objects / data-URIs are written under
// ~/.local/share/jarvis/attachments/<session>/ and their paths returned; bare
// path strings pass through unchanged. (Previously this did v.toString() on each
// element, which yields "" for a JSON object — so phone images were silently
// dropped and never reached the model.)
static QStringList decodeSendImages(const QJsonArray &arr, const QString &sessionId)
{
    QStringList paths;
    if (arr.isEmpty())
        return paths;
    const QString dir = QDir::homePath()
        + QStringLiteral("/.local/share/jarvis/attachments/") + sessionId;
    QDir().mkpath(dir);
    int n = 0;
    for (const QJsonValue &v : arr) {
        QByteArray bytes;
        QString mime;
        if (v.isObject()) {
            const QJsonObject o = v.toObject();
            mime = o.value(QStringLiteral("mime")).toString();
            bytes = QByteArray::fromBase64(
                o.value(QStringLiteral("b64")).toString().toUtf8());
        } else if (v.isString()) {
            const QString s = v.toString();
            if (s.startsWith(QStringLiteral("data:"))) {
                const int semi = s.indexOf(QLatin1Char(';'));
                const int comma = s.indexOf(QLatin1Char(','));
                if (comma > 0) {
                    mime = s.mid(5, (semi > 5 ? semi : comma) - 5);
                    bytes = QByteArray::fromBase64(s.mid(comma + 1).toUtf8());
                }
            } else if (!s.isEmpty()) {
                paths << s; // already a path on disk
                continue;
            }
        }
        if (bytes.isEmpty())
            continue;
        QString ext = QStringLiteral("png");
        if (mime.contains(QStringLiteral("jpeg")) || mime.contains(QStringLiteral("jpg")))
            ext = QStringLiteral("jpg");
        else if (mime.contains(QStringLiteral("webp")))
            ext = QStringLiteral("webp");
        else if (mime.contains(QStringLiteral("gif")))
            ext = QStringLiteral("gif");
        const QString path = dir + QStringLiteral("/img_%1_%2.%3")
            .arg(QDateTime::currentMSecsSinceEpoch()).arg(n++).arg(ext);
        QFile f(path);
        if (f.open(QIODevice::WriteOnly)) {
            f.write(bytes);
            f.close();
            paths << path;
        }
    }
    return paths;
}

Response ControlServer::handleSessionSend(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();

    const QStringList images = decodeSendImages(
        req.params.value(QStringLiteral("images")).toArray(), sessionId);

    QString err;
    if (!sendToSession(sessionId, text, images, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);

    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionWake(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString message = req.params.value(QStringLiteral("message")).toString();
    if (sessionId.isEmpty() || message.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id and message are required"));
    // Inject the wake as a turn into the session — QUEUED if the session is
    // mid-turn — exactly like the subagent-done wake, so the brain picks the work
    // back up on its own. (wake_notify -> phone ping is layered on in the phone
    // subsystem; the boolean `critical` flag is forwarded for that.)
    QString err;
    if (!sendToSession(sessionId, message, {}, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    qInfo("jarvisd: session.wake -> %s (%lld chars, notify=%s)",
          qPrintable(sessionId), static_cast<long long>(message.size()),
          qPrintable(m_settings.wakeNotify()));
    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    result.insert(QStringLiteral("wake_notify"), m_settings.wakeNotify());
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

Response ControlServer::handleSessionDelete(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id required"));
    QString err;
    if (!deleteSession(sessionId, &err))
        return Response::failure(req.id, QStringLiteral("session_delete_failed"), err);
    QJsonObject result;
    result.insert(QStringLiteral("deleted"), true);
    result.insert(QStringLiteral("session_id"), sessionId);
    return Response::success(req.id, result);
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

Response ControlServer::handleSessionSubscribe(QWebSocket *client, const Request &req)
{
    // Replace this client's subscription set with the requested session ids and mark
    // it scoped. From now on broadcastSessionEvent() only sends it events for these
    // ids — so events for every OTHER session (e.g. a Chrome co-work chat) are never
    // delivered here. An empty list is valid and means "send me nothing" (a desktop
    // sitting on a fresh, sessionless chat). The list is authoritative each call, so
    // the client just re-sends its full current view whenever it changes.
    QSet<QString> ids;
    const QJsonArray arr = req.params.value(QStringLiteral("session_ids")).toArray();
    for (const QJsonValue &v : arr) {
        const QString s = v.toString();
        if (!s.isEmpty())
            ids.insert(s);
    }
    m_scopedClients.insert(client);
    m_subscriptions.insert(client, ids);
    QJsonObject result;
    result.insert(QStringLiteral("subscribed"),
                  QJsonArray::fromStringList(QStringList(ids.cbegin(), ids.cend())));
    return Response::success(req.id, result);
}

Response ControlServer::handleWidgetViewing(QWebSocket *client, const Request &req)
{
    // The desktop holds a viewer lease for each live-widget scope it is showing
    // (a chat session id, "all" for the Canvas/Widgets tab, or "widget:<id>" for a
    // popped-out window). active=true touches/refreshes it (~15s heartbeat);
    // active=false drops it. Keyed by the socket so all of a desktop's leases are
    // released when it disconnects. The engine's live-widget supervisor reads these
    // and idles any widget no one is watching.
    const QString scope = req.params.value(QStringLiteral("scope")).toString();
    if (scope.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("widget.viewing needs a scope"));
    const QString kind = req.params.value(QStringLiteral("kind")).toString(QStringLiteral("chat"));
    const bool active = req.params.value(QStringLiteral("active")).toBool(true);
    const QString source =
        QStringLiteral("desktop:") + QString::number(reinterpret_cast<quintptr>(client), 16);
    if (active)
        m_widgetLeases.touch(scope, kind, source);
    else
        m_widgetLeases.clear(scope, source);
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
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

// Enumerate the MCP servers configured in the BRAINS' OWN CLI configs
// (~/.claude.json mcpServers for claude, ~/.codex/config.toml [mcp_servers.*] for
// codex). Each entry: {brain, name, transport, endpoint, token}. These are NORMALLY
// isolated away (the brains run with --strict-mcp-config / --ignore-user-config); the
// user re-enables specific ones via mcp.cli_set_enabled, which imports them into the
// Jarvis registry (named "cli:<brain>:<name>") so the normal isolated injection picks
// them up.
static QList<QJsonObject> enumerateCliMcp()
{
    QList<QJsonObject> out;
    // claude — JSON
    {
        QFile f(QDir::homePath() + QStringLiteral("/.claude.json"));
        if (f.open(QIODevice::ReadOnly)) {
            const QJsonObject servers =
                QJsonDocument::fromJson(f.readAll()).object()
                    .value(QStringLiteral("mcpServers")).toObject();
            f.close();
            for (auto it = servers.constBegin(); it != servers.constEnd(); ++it) {
                const QJsonObject s = it.value().toObject();
                QString transport, endpoint, token;
                if (s.contains(QStringLiteral("url"))) {
                    transport = QStringLiteral("http");
                    endpoint = s.value(QStringLiteral("url")).toString();
                    QString auth = s.value(QStringLiteral("headers")).toObject()
                                       .value(QStringLiteral("Authorization")).toString();
                    if (auth.startsWith(QStringLiteral("Bearer ")))
                        token = auth.mid(7);
                    else
                        token = s.value(QStringLiteral("token")).toString();
                } else if (s.contains(QStringLiteral("command"))) {
                    transport = QStringLiteral("stdio");
                    QStringList parts{ s.value(QStringLiteral("command")).toString() };
                    for (const QJsonValue &a : s.value(QStringLiteral("args")).toArray())
                        parts << a.toString();
                    endpoint = parts.join(QLatin1Char(' '));
                }
                if (endpoint.isEmpty())
                    continue;
                out.append(QJsonObject{{QStringLiteral("brain"), QStringLiteral("claude")},
                                       {QStringLiteral("name"), it.key()},
                                       {QStringLiteral("transport"), transport},
                                       {QStringLiteral("endpoint"), endpoint},
                                       {QStringLiteral("token"), token}});
            }
        }
    }
    // codex — TOML (line-based: [mcp_servers.NAME] tables; capture url/command/args)
    {
        QFile f(QDir::homePath() + QStringLiteral("/.codex/config.toml"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QList<QByteArray> lines = f.readAll().split('\n');
            f.close();
            QString cur, url, command, endpoint;
            QStringList args;
            auto flush = [&]() {
                if (!cur.isEmpty()) {
                    QString tr, ep;
                    if (!url.isEmpty()) { tr = QStringLiteral("http"); ep = url; }
                    else if (!command.isEmpty()) {
                        tr = QStringLiteral("stdio");
                        ep = command;
                        for (const QString &a : std::as_const(args)) ep += QLatin1Char(' ') + a;
                    }
                    if (!ep.isEmpty())
                        out.append(QJsonObject{{QStringLiteral("brain"), QStringLiteral("codex")},
                                               {QStringLiteral("name"), cur},
                                               {QStringLiteral("transport"), tr},
                                               {QStringLiteral("endpoint"), ep},
                                               {QStringLiteral("token"), QString()}});
                }
                cur.clear(); url.clear(); command.clear(); args.clear();
            };
            for (const QByteArray &raw : lines) {
                const QString line = QString::fromUtf8(raw).trimmed();
                if (line.startsWith(QLatin1Char('['))) {
                    const int close = line.indexOf(QLatin1Char(']'));
                    const QString hdr = close > 1 ? line.mid(1, close - 1) : QString();
                    if (hdr.startsWith(QStringLiteral("mcp_servers."))) {
                        const QString top =
                            hdr.mid(12).section(QLatin1Char('.'), 0, 0);
                        if (top != cur) { flush(); cur = top; }
                    } else {
                        flush();
                    }
                    continue;
                }
                if (cur.isEmpty())
                    continue;
                const int eq = line.indexOf(QLatin1Char('='));
                if (eq < 0)
                    continue;
                const QString key = line.left(eq).trimmed();
                QString val = line.mid(eq + 1).trimmed();
                auto unquote = [](QString v) {
                    if (v.size() >= 2 && (v.front() == QLatin1Char('"') || v.front() == QLatin1Char('\'')))
                        v = v.mid(1, v.size() - 2);
                    return v;
                };
                if (key == QStringLiteral("url")) url = unquote(val);
                else if (key == QStringLiteral("command")) command = unquote(val);
                else if (key == QStringLiteral("args") && val.startsWith(QLatin1Char('['))) {
                    val = val.mid(1, val.lastIndexOf(QLatin1Char(']')) - 1);
                    for (const QString &p : val.split(QLatin1Char(',')))
                        if (!p.trimmed().isEmpty()) args << unquote(p.trimmed());
                }
            }
            flush();
        }
    }
    return out;
}

// --- Contract A v2: MCP registry (delegates to McpRegistry) ----------------

// mcp.cli_list -> the brains' own CLI MCP servers + whether each is currently
// imported (re-enabled) into the Jarvis registry.
Response ControlServer::handleMcpCliList(const Request &req)
{
    QStringList importedNames;
    if (m_mcp)
        for (const McpServerRow &r : m_mcp->list())
            importedNames << r.name;
    QJsonArray arr;
    for (const QJsonObject &s : enumerateCliMcp()) {
        const QString synthetic = QStringLiteral("cli:%1:%2")
            .arg(s.value(QStringLiteral("brain")).toString(),
                 s.value(QStringLiteral("name")).toString());
        QJsonObject o{{QStringLiteral("brain"), s.value(QStringLiteral("brain"))},
                      {QStringLiteral("name"), s.value(QStringLiteral("name"))},
                      {QStringLiteral("transport"), s.value(QStringLiteral("transport"))},
                      {QStringLiteral("endpoint"), s.value(QStringLiteral("endpoint"))},
                      {QStringLiteral("enabled"), importedNames.contains(synthetic)}};
        arr.append(o);
    }
    QJsonObject result;
    result.insert(QStringLiteral("servers"), arr);
    return Response::success(req.id, result);
}

// mcp.cli_set_enabled {brain,name,enabled} -> import (enabled) the CLI server into
// the Jarvis registry as "cli:<brain>:<name>", or remove it (disabled). The registry
// is already injected into both brains under the isolated path, so a re-enabled CLI
// server's tools become available again.
Response ControlServer::handleMcpCliSetEnabled(const Request &req)
{
    const QString brain = req.params.value(QStringLiteral("brain")).toString();
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const bool enabled = req.params.value(QStringLiteral("enabled")).toBool();
    if (brain.isEmpty() || name.isEmpty() || !m_mcp)
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("brain and name required"));
    const QString synthetic = QStringLiteral("cli:%1:%2").arg(brain, name);
    // Remove any existing import first (idempotent).
    for (const McpServerRow &r : m_mcp->list())
        if (r.name == synthetic)
            m_mcp->remove(r.id);
    if (enabled) {
        QJsonObject match;
        for (const QJsonObject &s : enumerateCliMcp())
            if (s.value(QStringLiteral("brain")).toString() == brain
                && s.value(QStringLiteral("name")).toString() == name) {
                match = s;
                break;
            }
        if (match.isEmpty())
            return Response::failure(req.id, QStringLiteral("not_found"),
                                     QStringLiteral("CLI server not found"));
        m_mcp->add(synthetic, match.value(QStringLiteral("transport")).toString(),
                   match.value(QStringLiteral("endpoint")).toString(),
                   match.value(QStringLiteral("token")).toString(), true,
                   QStringLiteral("medium"));
    }
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("enabled"), enabled);
    return Response::success(req.id, result);
}

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

// --- Google connectors framework (Calendar/Docs/Drive/Gmail) ---------------

Response ControlServer::handleConnectorsList(const Request &req)
{
    // List the connector MCP servers (rows named "google-<service>"). Secrets
    // are NEVER echoed; only has_* booleans (from SettingsStore) are surfaced.
    QJsonArray connectors;
    for (const McpServerRow &row : m_mcp->list()) {
        const QString service = Connectors::serviceFromServerName(row.name);
        if (service.isEmpty())
            continue; // not a google connector
        QJsonObject c;
        c.insert(QStringLiteral("id"), row.id);
        c.insert(QStringLiteral("name"), row.name);
        c.insert(QStringLiteral("service"), service);
        c.insert(QStringLiteral("enabled"), row.enabled);
        c.insert(QStringLiteral("risk"), row.risk);
        c.insert(QStringLiteral("has_client_id"),
                 m_settings.hasApiKey(Connectors::secretKey(row.id, QStringLiteral("client_id"))));
        c.insert(QStringLiteral("has_client_secret"),
                 m_settings.hasApiKey(Connectors::secretKey(row.id, QStringLiteral("client_secret"))));
        c.insert(QStringLiteral("has_refresh_token"),
                 m_settings.hasApiKey(Connectors::secretKey(row.id, QStringLiteral("refresh_token"))));
        connectors.append(c);
    }
    QJsonObject result;
    result.insert(QStringLiteral("connectors"), connectors);
    return Response::success(req.id, result);
}

Response ControlServer::handleConnectorsAdd(const Request &req)
{
    const QJsonObject p = req.params;
    const QString service = p.value(QStringLiteral("service")).toString();
    if (!Connectors::isKnownService(service))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("unknown Google connector service: ") + service);

    const QString clientId = p.value(QStringLiteral("client_id")).toString();
    const QString clientSecret = p.value(QStringLiteral("client_secret")).toString();
    const QString refreshToken = p.value(QStringLiteral("refresh_token")).toString();

    // Real creds (all three present) ENABLE the connector so the brain actually gets
    // the Google MCP server (env injected with the secret refs). Empty/placeholder
    // creds add it DISABLED (framework/mock) — injection never runs without creds.
    const bool hasRealCreds =
        !clientId.isEmpty() && !clientSecret.isEmpty() && !refreshToken.isEmpty();

    const QString name = Connectors::serverName(service);
    const QString endpoint = Connectors::defaultCommandFor(service);
    const QString risk = Connectors::riskFor(service);

    // First materialize the row so we have its id for the secret-ref env map; then
    // PATCH the env in place with secret refs keyed by that id.
    const QString id = m_mcp->add(name, QStringLiteral("stdio"), endpoint,
                                  QString() /*no http token*/, /*enabled=*/hasRealCreds, risk);
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("store_error"), m_store.lastError());

    QJsonObject env;
    env.insert(QStringLiteral("GOOGLE_OAUTH_CLIENT_ID"),
               Connectors::secretRef(id, QStringLiteral("client_id")));
    env.insert(QStringLiteral("GOOGLE_OAUTH_CLIENT_SECRET"),
               Connectors::secretRef(id, QStringLiteral("client_secret")));
    env.insert(QStringLiteral("GOOGLE_OAUTH_REFRESH_TOKEN"),
               Connectors::secretRef(id, QStringLiteral("refresh_token")));
    if (auto row = m_store.getMcpServer(id)) {
        row->env = env;
        m_store.addMcpServer(*row); // INSERT OR REPLACE keeps the same id
    }

    // Persist the three creds as write-only namespaced secrets (never echoed).
    m_settings.setApiKey(Connectors::secretKey(id, QStringLiteral("client_id")), clientId);
    m_settings.setApiKey(Connectors::secretKey(id, QStringLiteral("client_secret")), clientSecret);
    m_settings.setApiKey(Connectors::secretKey(id, QStringLiteral("refresh_token")), refreshToken);
    m_settings.saveSecrets();

    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    result.insert(QStringLiteral("name"), name);
    result.insert(QStringLiteral("enabled"), hasRealCreds);
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
    // The client may pre-approve an unverified / permission-escalating plugin
    // (biometric tier on the device): plugins.install{id,approve:true}.
    const bool approve = req.params.value(QStringLiteral("approve")).toBool();

    auto man = m_plugins->get(id);
    if (!man)
        return Response::failure(req.id, QStringLiteral("unknown_plugin"),
                                 QStringLiteral("unknown plugin: ") + id);

    // VERIFY FIRST. The verdict + the declared permissions decide whether this
    // can install silently or needs explicit (biometric) approval.
    const PluginRegistry::VerifyVerdict v = m_plugins->verify(id);
    const bool requestsComputerUse =
        man->permissions.contains(QStringLiteral("computer-use"));

    if (!v.verified && !approve) {
        // UNVERIFIED -> require approval. Surface the reason + the exact
        // permission set the user would be granting so the UI can prompt.
        m_audit.record(QStringLiteral("plugins.install"), false,
                       QStringLiteral("high"),
                       QStringLiteral("blocked unverified plugin ") + id +
                           QStringLiteral(": ") + v.error);
        QJsonObject result;
        result.insert(QStringLiteral("ok"), false);
        result.insert(QStringLiteral("needs_approval"), true);
        result.insert(QStringLiteral("approval_tier"), QStringLiteral("biometric"));
        result.insert(QStringLiteral("verified"), false);
        result.insert(QStringLiteral("reason"),
                      v.error.isEmpty() ? QStringLiteral("plugin is not signed by a "
                                                         "trusted publisher")
                                        : v.error);
        QJsonArray perms;
        for (const QString &p : man->permissions)
            perms.append(p);
        result.insert(QStringLiteral("permissions"), perms);
        return Response::success(req.id, result);
    }

    // A verified plugin that nonetheless asks for computer-use (the highest
    // privilege) still requires explicit approval the first time.
    if (v.verified && requestsComputerUse && !approve) {
        QJsonObject result;
        result.insert(QStringLiteral("ok"), false);
        result.insert(QStringLiteral("needs_approval"), true);
        result.insert(QStringLiteral("approval_tier"), QStringLiteral("biometric"));
        result.insert(QStringLiteral("verified"), true);
        result.insert(QStringLiteral("reason"),
                      QStringLiteral("plugin requests the computer-use permission"));
        QJsonArray perms;
        for (const QString &p : man->permissions)
            perms.append(p);
        result.insert(QStringLiteral("permissions"), perms);
        return Response::success(req.id, result);
    }

    // Record verified + the granted permission set (the manifest's declared
    // permissions, which the user has now approved if unverified).
    if (!m_plugins->install(id, v.verified, man->permissions))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());

    m_audit.record(QStringLiteral("plugins.install"), true,
                   v.verified ? QStringLiteral("low") : QStringLiteral("medium"),
                   QStringLiteral("installed ") + id +
                       (v.verified ? QStringLiteral(" (verified)")
                                   : QStringLiteral(" (UNVERIFIED, user-approved)")));

    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    ok.insert(QStringLiteral("verified"), v.verified);
    QJsonArray perms;
    for (const QString &p : man->permissions)
        perms.append(p);
    ok.insert(QStringLiteral("permissions"), perms);
    return Response::success(req.id, ok);
}

Response ControlServer::handlePluginsSetEnabled(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const bool enabled = req.params.value(QStringLiteral("enabled")).toBool();

    auto man = m_plugins->get(id);
    if (!man)
        return Response::failure(req.id, QStringLiteral("unknown_plugin"),
                                 QStringLiteral("unknown plugin: ") + id);

    if (enabled) {
        // Enabling activates the capability under the granted permissions: a
        // sandboxed stdio MCP, an http MCP url, and/or a dropped SKILL.md.
        QString err;
        if (!applyPluginEnable(*man, &err)) {
            m_audit.record(QStringLiteral("plugins.set_enabled"), false,
                           QStringLiteral("high"),
                           QStringLiteral("enable failed for ") + id +
                               QStringLiteral(": ") + err);
            return Response::failure(req.id, QStringLiteral("enable_failed"), err);
        }
    } else {
        applyPluginDisable(*man);
    }

    if (!m_plugins->setEnabled(id, enabled))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());

    m_audit.record(QStringLiteral("plugins.set_enabled"), true,
                   QStringLiteral("medium"),
                   (enabled ? QStringLiteral("enabled ") : QStringLiteral("disabled ")) + id);

    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handlePluginsRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    // Tear down any live capability before forgetting the plugin's state.
    if (auto man = m_plugins->get(id))
        applyPluginDisable(*man);
    if (!m_plugins->remove(id))
        return Response::failure(req.id, QStringLiteral("store_error"), m_plugins->lastError());
    m_audit.record(QStringLiteral("plugins.remove"), true, QStringLiteral("low"),
                   QStringLiteral("removed plugin ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

// --- Wave 7: sandboxed activation + http-mcp/skill wiring -------------------

QString ControlServer::pluginMcpServerId(const QString &pluginId)
{
    // Stable, recognizable id so disable can find + remove exactly this row.
    return QStringLiteral("plugin:") + pluginId;
}

bool ControlServer::applyPluginEnable(const PluginManifest &m, QString *err)
{
    // The permission set the user approved at install time (falls back to the
    // manifest's declared permissions for a pre-seeded/built-in plugin).
    QStringList granted = m.grantedPermissions;
    if (granted.isEmpty())
        granted = m.permissions;

    const QString kind = m.kind;
    const bool isMcp = (kind == QStringLiteral("mcp") || kind == QStringLiteral("both"));
    const bool isSkill = (kind == QStringLiteral("skill") || kind == QStringLiteral("both"));

    if (isMcp) {
        const QString transport = m.effectiveTransport();
        const QString endpoint = m.effectiveEndpoint();
        if (transport == QStringLiteral("http")) {
            // HTTP-MCP plugins are just URLs the brains can reach; add (or keep)
            // a registry row with the declared bearer env var resolved if set.
            const QString sid = pluginMcpServerId(m.id);
            if (!m_store.getMcpServer(sid)) {
                McpServerRow row;
                row.id = sid;
                row.name = m.name.isEmpty() ? m.id : m.name;
                row.transport = QStringLiteral("http");
                row.endpoint = endpoint;
                // Bearer from the first declared env_key, if present in the env.
                if (!m.mcpEnvKeys.isEmpty())
                    row.token = qEnvironmentVariable(m.mcpEnvKeys.first().toUtf8().constData());
                row.enabled = true;
                row.builtin = false;
                row.risk = QStringLiteral("medium");
                if (!m_store.addMcpServer(row)) {
                    if (err) *err = m_store.lastError();
                    return false;
                }
            } else {
                m_store.setMcpEnabled(sid, true);
            }
        } else if (transport == QStringLiteral("stdio")) {
            // Launch the plugin's MCP server SANDBOXED, confined by `granted`.
            if (!m_sandbox.start(m, granted)) {
                if (err) *err = m_sandbox.lastError();
                return false;
            }
        }
    }

    if (isSkill) {
        // Drop the plugin's SKILL.md into the skills dir under a "plugin" group
        // so the brains can discover it. Source: the manifest's skill.path
        // resolved relative to the catalog dir; if absent, synthesize a stub.
        const QString group = QStringLiteral("plugin");
        const QString dir = m_skills.root() + QStringLiteral("/") + group +
                            QStringLiteral("/") + m.id;
        QDir().mkpath(dir);
        const QString dest = dir + QStringLiteral("/SKILL.md");

        QByteArray content;
        if (!m.skillPath.isEmpty()) {
            // The published payload lives under <catalog>/<id>/<skillPath>.
            const QString src = PluginRegistry::defaultCatalogDir() +
                                QStringLiteral("/") + m.id +
                                QStringLiteral("/") + m.skillPath;
            QFile sf(src);
            if (sf.open(QIODevice::ReadOnly)) {
                content = sf.readAll();
                sf.close();
            }
        }
        if (content.isEmpty()) {
            content = (QStringLiteral("---\n") +
                       QStringLiteral("name: ") + m.id + QStringLiteral("\n") +
                       QStringLiteral("description: ") + m.description + QStringLiteral("\n") +
                       QStringLiteral("---\n\n# ") + m.name + QStringLiteral("\n\n") +
                       m.description + QStringLiteral("\n")).toUtf8();
        }
        QFile df(dest);
        if (!df.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            if (err) *err = QStringLiteral("cannot write skill: ") + dest;
            return false;
        }
        df.write(content);
        df.close();
    }

    return true;
}

void ControlServer::applyPluginDisable(const PluginManifest &m)
{
    // Tear down the sandboxed PID (scoped — never pkill-by-name).
    m_sandbox.stop(m.id);

    // Disable (don't delete) the http MCP row so re-enabling is cheap.
    const QString sid = pluginMcpServerId(m.id);
    if (m_store.getMcpServer(sid))
        m_store.setMcpEnabled(sid, false);

    // Remove the dropped skill so the brains stop discovering it.
    const QString dir = m_skills.root() + QStringLiteral("/plugin/") + m.id;
    if (QDir(dir).exists())
        QDir(dir).removeRecursively();
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
    // "Computer" preview. The per-session engine authenticates with its OWN
    // bearer (NOT the global :8794 one), so include it — without it the live
    // preview poll gets 401 and the peek hangs on "waiting for the agent". The
    // engine binds 127.0.0.1 only and this rides the already-authenticated
    // control/device channel, so the token is useless off-box.
    const QString base = m_agentDesktops.engineBase(sessionId);
    result.insert(QStringLiteral("video_frame"), base + QStringLiteral("/video/frame"));
    result.insert(QStringLiteral("video_mjpeg"), base + QStringLiteral("/video/mjpeg"));
    result.insert(QStringLiteral("bearer"), desk.bearer);
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
    if (was != active) {
        emit agentDrivingChanged(sessionId, active);
        // Push the take-over state to every connected surface so the distinct-
        // cursor overlay maps/unmaps. The desktop Bridge consumes this in
        // handleComputerEvent (kind=="driving.state" -> setDriving(active)),
        // which spawns one layer-shell OVERLAY per monitor. broadcastSessionEvent
        // reaches the desktop control clients; emit sessionEvent so the phone
        // (DeviceServer forwards it over the device WS) shows the same state.
        const NormalizedBrainEvent ev = NormalizedBrainEvent::drivingState(active);
        broadcastSessionEvent(sessionId, ev);
        emit sessionEvent(sessionId, ev);
    }
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

Response ControlServer::handleTakeOverCancel(const Request &req)
{
    // Esc / "stop" on the take-over overlay. The overlay can't know WHICH session is
    // driving (it may be a Chrome side-panel session, a phone session, etc.), so stop
    // EVERY session currently driving the real screen: cancel its running turn AND
    // clear its take-over state (which unmaps the overlay). Always succeeds.
    QSet<QString> targets = m_takeOverActive;
    const QString named = req.params.value(QStringLiteral("session_id")).toString();
    if (!named.isEmpty())
        targets.insert(named);
    // The Chrome side-panel / auto path drives the real screen by calling the engine
    // DIRECTLY (no explicit take_over.request), so it may not be flagged in
    // m_takeOverActive. The overlay is only up because SOMETHING is actively acting —
    // so also stop every session with a turn in flight. Esc means STOP.
    for (auto it = m_brains.constBegin(); it != m_brains.constEnd(); ++it)
        if (it.value() && it.value()->isBusy())
            targets.insert(it.key());
    for (const QString &sid : std::as_const(targets)) {
        QString err;
        cancelSession(sid, &err);            // stop the model mid-turn
        if (m_takeOverActive.contains(sid))
            setTakeOverActive(sid, false);   // drop the overlay everywhere
    }
    QJsonObject result;
    result.insert(QStringLiteral("cancelled"), int(targets.size()));
    return Response::success(req.id, result);
}

// --- 2FA + fingerprint cross-device unlock ----------------------------------

Response ControlServer::handleAuthRequest(const Request &req)
{
    // FAIL-OPEN (no-brick): the user must NEVER be permanently locked out. There
    // is NO reachable approver when EITHER:
    //   (a) no phone is paired (the device registry is empty), OR
    //   (b) a phone is paired but we have no way to actually reach it — the only
    //       way the phone learns of a challenge is an FCM push, so if FCM is the
    //       logging stub (no real backend) OR there are no stored push tokens, the
    //       challenge would never be delivered and the gate would hang.
    // In both cases return an immediate "approved" with paired:false so the desktop
    // LockGate unlocks now. NOTE: the lock stays STRONG whenever a phone IS
    // reachable (real FCM backend + at least one push token).
    // Grace: the user just acted in the authed phone app, so they're demonstrably
    // present at an unlocked phone -> auto-approve this desktop unlock (no prompt).
    // Mere connection does NOT grant this; only a deliberate device-initiated action.
    if (m_deviceAuthGraceUntil > 0 &&
        QDateTime::currentMSecsSinceEpoch() < m_deviceAuthGraceUntil) {
        QJsonObject r;
        r.insert(QStringLiteral("challenge_id"), QString());
        r.insert(QStringLiteral("state"), QStringLiteral("approved"));
        r.insert(QStringLiteral("paired"), true);
        return Response::success(req.id, r);
    }

    // A reachable approver = a phone CONNECTED + authed over the device WS (its app
    // is open, so we can push the challenge over the socket) OR a real FCM backend
    // with a stored push token. Mere pairing isn't enough — the challenge must
    // actually be deliverable, else the gate would hang.
    const bool noDevice = m_deviceReg.list().isEmpty();
    const bool deviceConnected = m_authedDeviceProbe && m_authedDeviceProbe();
    const bool canPush =
        m_fcm && m_fcm->isReal() && !m_store.listPushTokens().isEmpty();
    if (noDevice || (!canPush && !deviceConnected)) {
        QJsonObject r;
        r.insert(QStringLiteral("challenge_id"), QString());
        r.insert(QStringLiteral("state"), QStringLiteral("approved"));
        r.insert(QStringLiteral("paired"), false);
        return Response::success(req.id, r);
    }

    const QString origin =
        req.params.value(QStringLiteral("origin")).toString(QStringLiteral("desktop"));
    const AuthChallenge ch = m_authChallenges.create(AuthChallengeStore::kDefaultTtlMs,
                                                      origin);

    // No-Firebase path: deliver the challenge over the device WS to any connected
    // authed phone (DeviceServer fans this out as an 'auth.challenge' event -> the
    // app's background service posts an "Unlock Jarvis" notification -> Approve).
    emit authChallengePush(ch.id, ch.origin, ch.expiresAt);

    // FCM-push EVERY paired phone (reuse the DeviceServer::onSessionEvent loop):
    // {kind:"auth", challenge_id, origin}. The phone opens an Approve screen,
    // runs BiometricPrompt, and calls auth.approve over its authed device WS.
    if (m_fcm) {
        PushMessage msg;
        msg.title = QStringLiteral("Unlock Jarvis");
        msg.body = QStringLiteral("Approve sign-in on your phone");
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("auth"));
        msg.data.insert(QStringLiteral("challenge_id"), ch.id);
        msg.data.insert(QStringLiteral("origin"), ch.origin);
        for (const PushTokenRow &t : m_store.listPushTokens())
            m_fcm->send(t.fcmToken, msg);
    }

    QJsonObject r;
    r.insert(QStringLiteral("challenge_id"), ch.id);
    r.insert(QStringLiteral("state"), ch.state);
    r.insert(QStringLiteral("expires_at"), ch.expiresAt);
    r.insert(QStringLiteral("paired"), true);
    return Response::success(req.id, r);
}

void ControlServer::grantDeviceAuthGrace(int ms)
{
    m_deviceAuthGraceUntil = QDateTime::currentMSecsSinceEpoch() + ms;
    // Instantly unlock a desktop lock-gate that's currently waiting — the phone
    // user just acted, so the desktop should "start unlocked" without a prompt.
    broadcastAuthEvent(QString(), QStringLiteral("approved"));
}

Response ControlServer::handleAuthStatus(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("challenge_id")).toString();
    return Response::success(req.id, m_authChallenges.statusJson(id));
}

Response ControlServer::handleAuthDeny(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("challenge_id")).toString();
    QString err;
    denyAuthChallenge(id, &err);
    // Always succeed: a deny on an unknown/expired challenge is harmless.
    QJsonObject r;
    r.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, r);
}

Response ControlServer::handleAuthVerifyPin(const Request &req)
{
    // Local PIN unlock: the reliable fallback when the phone can't approve. The
    // PIN is verified against the salted hash in SettingsStore; on success we
    // approve the pending challenge (if any) and broadcast the unlock so the
    // LockGate clears exactly like a phone approval.
    const QString pin = req.params.value(QStringLiteral("pin")).toString();
    if (!m_settings.hasDesktopPin())
        return Response::failure(req.id, QStringLiteral("no_pin"),
                                 QStringLiteral("no desktop PIN is set"));
    if (!m_settings.verifyDesktopPin(pin)) {
        m_audit.record(QStringLiteral("auth.verify_pin"), false, QStringLiteral("high"),
                       QStringLiteral("wrong desktop PIN"), QString(), false);
        return Response::failure(req.id, QStringLiteral("bad_pin"),
                                 QStringLiteral("incorrect PIN"));
    }
    const QString challengeId = req.params.value(QStringLiteral("challenge_id")).toString();
    if (!challengeId.isEmpty())
        m_authChallenges.approve(challengeId, QStringLiteral("pin"));
    m_audit.record(QStringLiteral("auth.verify_pin"), true, QStringLiteral("high"),
                   QStringLiteral("desktop unlocked with PIN"), QString(), false);
    emit authEvent(challengeId, QStringLiteral("approved"));
    broadcastAuthEvent(challengeId, QStringLiteral("approved"));
    QJsonObject r;
    r.insert(QStringLiteral("ok"), true);
    r.insert(QStringLiteral("state"), QStringLiteral("approved"));
    return Response::success(req.id, r);
}

bool ControlServer::approveAuthChallenge(const QString &challengeId,
                                         const QString &deviceId, QString *err)
{
    if (!m_authChallenges.approve(challengeId, deviceId)) {
        if (err)
            *err = QStringLiteral("challenge_not_found or expired/already-decided");
        return false;
    }
    m_audit.record(QStringLiteral("auth.approve"), true, QStringLiteral("high"),
                   QStringLiteral("phone approved a sign-in (possession+biometric)"),
                   QString(), /*remote=*/true);
    emit authEvent(challengeId, QStringLiteral("approved"));
    broadcastAuthEvent(challengeId, QStringLiteral("approved"));
    return true;
}

bool ControlServer::denyAuthChallenge(const QString &challengeId, QString *err)
{
    if (!m_authChallenges.deny(challengeId)) {
        if (err)
            *err = QStringLiteral("challenge_not_found or expired/already-decided");
        return false;
    }
    emit authEvent(challengeId, QStringLiteral("denied"));
    broadcastAuthEvent(challengeId, QStringLiteral("denied"));
    return true;
}

void ControlServer::broadcastAuthEvent(const QString &challengeId, const QString &state)
{
    // Clone of broadcastSessionEvent: deliver the unlock to the desktop instantly
    // (the LockGate poll on auth.status is the fallback).
    QJsonObject data;
    data.insert(QStringLiteral("challenge_id"), challengeId);
    data.insert(QStringLiteral("state"), state);
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("auth.event"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
}

void ControlServer::broadcastSessionOpened(const QString &sessionId, const QString &title)
{
    // Clone of broadcastAuthEvent: tell every subscribed desktop control client to
    // raise/focus + navigate to the new session's chat (no-op when no sidebar is up).
    QJsonObject data;
    data.insert(QStringLiteral("session_id"), sessionId);
    data.insert(QStringLiteral("title"), title);
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("session.opened"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
}

// --- widget bus -> control-WS broadcast (Chrome extension) ------------------

QString ControlServer::widgetsBusPath() const
{
    const QString base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
    return (base.isEmpty() ? QDir::homePath() + QStringLiteral("/.local/share") : base)
           + QStringLiteral("/jarvis/widgets.jsonl");
}

void ControlServer::startWidgetWatch()
{
    if (m_widgetTimer)
        return;
    // Start from EOF so old widgets from a previous run don't replay.
    const QFileInfo fi(widgetsBusPath());
    m_widgetOffset = fi.exists() ? fi.size() : 0;
    m_widgetTimer = new QTimer(this);
    m_widgetTimer->setInterval(500);
    connect(m_widgetTimer, &QTimer::timeout, this, &ControlServer::readWidgetTail);
    m_widgetTimer->start();
}

void ControlServer::readWidgetTail()
{
    if (m_widgetClients.isEmpty())   // nobody listening on the control WS -> skip
        return;
    QFile f(widgetsBusPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    if (f.size() < m_widgetOffset)   // truncated/rotated -> restart
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
        const QString op = o.value(QStringLiteral("op")).toString();
        QJsonObject data;
        QString eventName;
        if (op == QStringLiteral("remove")) {
            eventName = QStringLiteral("widget.remove");
            data.insert(QStringLiteral("id"), o.value(QStringLiteral("id")).toString());
        } else if (op == QStringLiteral("clear")) {
            eventName = QStringLiteral("widget.clear");
        } else {
            if (!o.contains(QStringLiteral("spec")))
                continue;
            eventName = QStringLiteral("widget.render");
            data.insert(QStringLiteral("id"), o.value(QStringLiteral("id")).toString());
            data.insert(QStringLiteral("title"), o.value(QStringLiteral("title")).toString());
            data.insert(QStringLiteral("spec"), o.value(QStringLiteral("spec")));
            data.insert(QStringLiteral("target"), o.value(QStringLiteral("target")).toString());
            data.insert(QStringLiteral("session_id"), o.value(QStringLiteral("session_id")).toString());
        }
        QJsonObject frame;
        frame.insert(QStringLiteral("v"), 1);
        frame.insert(QStringLiteral("event"), eventName);
        frame.insert(QStringLiteral("data"), data);
        const QString payload =
            QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
        for (QWebSocket *client : std::as_const(m_widgetClients))
            client->sendTextMessage(payload);
    }
}

Response ControlServer::handleWidgetSubscribe(QWebSocket *client, const Request &req)
{
    const bool on = req.params.value(QStringLiteral("on")).toBool(true);
    if (on)
        m_widgetClients.insert(client);
    else
        m_widgetClients.remove(client);
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("subscribed"), on);
    return Response::success(req.id, result);
}

// --- Contract A v3: memory + self-authored skills ---------------------------

bool ControlServer::isMemoryOrSkillMethod(const QString &method)
{
    return method.startsWith(QStringLiteral("memory.")) ||
           method.startsWith(QStringLiteral("skills.")) ||
           method.startsWith(QStringLiteral("agents."));
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
    if (m == QStringLiteral("memory.edit"))
        return handleMemoryEdit(req);
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
    if (m == QStringLiteral("agents.list"))
        return handleAgentsList(req);
    if (m == QStringLiteral("agents.get"))
        return handleAgentsGet(req);
    if (m == QStringLiteral("agents.create"))
        return handleAgentsCreate(req);
    if (m == QStringLiteral("agents.remove"))
        return handleAgentsRemove(req);
    if (m == QStringLiteral("agents.dispatch"))
        return handleAgentsDispatch(req, /*remote=*/false);
    if (m == QStringLiteral("agents.running"))
        return handleAgentsRunning(req);
    if (m == QStringLiteral("agents.result"))
        return handleAgentsResult(req);
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
    // A memory is a concise FACT, not a document. Reject oversized writes so a
    // co-work session can't dump a whole webpage / chat transcript into long-term
    // memory — those then pollute EVERY future session via memory injection
    // (prefetchMemoryBlock). The model should store a short fact and the user can
    // paste docs into a chat instead.
    if (text.size() > kMaxMemoryChars)
        return Response::failure(
            req.id, QStringLiteral("memory_too_large"),
            QStringLiteral("memory text too long (%1 chars, max %2) — store a concise "
                           "fact, not a document").arg(text.size()).arg(kMaxMemoryChars));
    const QString id = m_memory.add(text, tags);
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("store_error"), m_memory.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemoryEdit(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("id is required"));
    if (text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("text is required"));
    if (text.size() > kMaxMemoryChars)
        return Response::failure(
            req.id, QStringLiteral("memory_too_large"),
            QStringLiteral("memory text too long (%1 chars, max %2) — store a concise "
                           "fact, not a document").arg(text.size()).arg(kMaxMemoryChars));
    QStringList tags;
    for (const QJsonValue &t : req.params.value(QStringLiteral("tags")).toArray())
        tags << t.toString();
    if (!m_memory.replace(id, text, tags))
        return Response::failure(req.id, QStringLiteral("not_found"),
                                 QStringLiteral("memory not found: ") + id);
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    ok.insert(QStringLiteral("id"), id);
    return Response::success(req.id, ok);
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

void ControlServer::seedInternalDocsSkill()
{
    // Only seed once — don't clobber a user's edits.
    if (m_skills.get(QStringLiteral("internal_docs")).has_value())
        return;
    const QString body = QStringLiteral(
        "When the user asks what you can do, your features, how to do something with "
        "you, or you're unsure you're capable of something, use THIS as the source of "
        "truth for Jarvis's capabilities. Tell them what fits + offer to do it.\n\n"
        "# Jarvis — what you can do\n\n"
        "**Computer use** — drive mouse/keyboard/screen on KDE & Sway. You work on your "
        "OWN nested agent desktop by default (the user watches it live in chat / on the "
        "Computer page), or take over the user's REAL screen on request (consent-gated, "
        "glowing cursor + banner). Tools: app_launch, desktop_screenshot, mouse/keyboard, "
        "window ops, desktop_reset. (docs/COMPUTER_USE.md)\n"
        "**Chrome** — drive the user's browser tabs in-page via the extension (navigate, "
        "click, type, read, screenshot).\n"
        "**Voice** — hands-free voice mode (Mistral Voxtral STT/TTS), an animated orb. "
        "(docs/VOICE.md)\n"
        "**Generative widgets** — render_widget draws custom UI from a JSON DSL "
        "(containers, text, charts, SVG/canvas art, buttons, multi-page pagers/quizzes); "
        "live auto-updating canvases (widget_live); pin to the desktop Home or a real "
        "Android home-screen widget. Renders on desktop AND phone. (docs/WIDGETS_CANVAS.md)\n"
        "**Plan / TODO** — todo_write keeps a live checklist the user watches (done items "
        "strike through).\n"
        "**Skills** — reusable playbooks. create_skill to author one, skill_load to run "
        "one, list_skills/get_skill/edit_skill/remove_skill. The user invokes them with "
        "/skill-name. (docs/AGENTS_AND_COMMANDS.md)\n"
        "**Agents / subagents** — define specialists (agent_create) and delegate sub-tasks "
        "(agent_start) that run as their own child sessions; agent_wait blocks for the "
        "result, agent_result/agent_status check them. (docs/AGENTS_AND_COMMANDS.md)\n"
        "**Memory** — long-term memory: remember/recall/list_memories/edit_memory/forget.\n"
        "**Schedules** — run tasks later or on a cadence: schedule_task / list_schedules / "
        "cancel_schedule (cron or natural language). (docs/SCHEDULES.md)\n"
        "**Files** — send any file to the user's phone/desktop with send_file.\n"
        "**MCP & plugins** — extra MCP tool servers + a plugin marketplace, managed in the "
        "app.\n"
        "**Cross-surface** — one daemon behind a desktop sidebar, an Android app, and a "
        "Chrome extension; cross-device biometric unlock. (README.md, docs/ARCHITECTURE.md)\n");
    m_skills.create(QStringLiteral("internal_docs"),
                    QStringLiteral("Jarvis's own feature/capability catalog — load this "
                                   "when asked what you can do or when unsure."),
                    body, QStringLiteral("builtin"));
}

Response ControlServer::handleSkillsList(const Request &req)
{
    QJsonArray arr;
    // listAll() also surfaces skills the model created via its CLI dirs, so a
    // skill always shows up even if it wasn't made through create_skill.
    for (const SkillRow &s : m_skills.listAll())
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

// --- custom agents (subagents) ---------------------------------------------

Response ControlServer::handleAgentsList(const Request &req)
{
    QJsonArray arr;
    for (const AgentRow &a : m_agents.list())
        arr.append(a.toListJson());
    QJsonObject result;
    result.insert(QStringLiteral("agents"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleAgentsGet(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    AgentFrontmatter fm;
    QString body, path;
    if (!m_agents.read(name, &fm, &body, &path))
        return Response::failure(req.id, QStringLiteral("no_agent"), m_agents.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("frontmatter"), fm.toJson());
    result.insert(QStringLiteral("system_prompt"), body);
    result.insert(QStringLiteral("path"), path);
    return Response::success(req.id, result);
}

Response ControlServer::handleAgentsCreate(const Request &req)
{
    const QJsonObject p = req.params;
    const QString name = p.value(QStringLiteral("name")).toString();
    if (name.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("name is required"));
    // tools may be a JSON array or a comma-separated string.
    QStringList tools;
    for (const QJsonValue &t : p.value(QStringLiteral("tools")).toArray())
        tools << t.toString();
    if (tools.isEmpty() && p.value(QStringLiteral("tools")).isString()) {
        for (const QString &t : p.value(QStringLiteral("tools")).toString()
                                    .split(QLatin1Char(','), Qt::SkipEmptyParts))
            tools << t.trimmed();
    }
    // The system prompt is `system_prompt` (preferred) or `body` (alias).
    const QString systemPrompt = p.contains(QStringLiteral("system_prompt"))
                                     ? p.value(QStringLiteral("system_prompt")).toString()
                                     : p.value(QStringLiteral("body")).toString();
    const QString path = m_agents.create(
        name,
        p.value(QStringLiteral("description")).toString(),
        p.value(QStringLiteral("when_to_use")).toString(),
        systemPrompt,
        p.value(QStringLiteral("brain")).toString(),
        p.value(QStringLiteral("model")).toString(),
        p.value(QStringLiteral("profile")).toString(),
        tools,
        p.value(QStringLiteral("color")).toString());
    if (path.isEmpty())
        return Response::failure(req.id, QStringLiteral("write_error"), m_agents.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("path"), path);
    return Response::success(req.id, result);
}

Response ControlServer::handleAgentsRemove(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    if (!m_agents.remove(name))
        return Response::failure(req.id, QStringLiteral("no_agent"), m_agents.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleAgentsDispatch(const Request &req, bool remote)
{
    const QJsonObject p = req.params;
    const QString agent = p.value(QStringLiteral("agent")).toString().trimmed();
    const QString task = p.value(QStringLiteral("task")).toString();
    QString parent = p.value(QStringLiteral("parent_session_id")).toString();
    // The caller's engine supplies its own session id via JARVIS_AGENT_SESSION,
    // but the SHARED real-screen engine (the global :8794 server, reused by every
    // session) has no per-session id — so when the model invokes agent_start
    // through it, parent arrives empty and the subagent would be ORPHANED (no
    // tree link, no done-wake). Fall back to the session that is mid-turn right
    // now: the caller is necessarily in state "running" while it calls this tool,
    // and a top-level chat has no parent of its own. This keeps the parent link
    // — and therefore the subagent pop-out + the done-wake — working no matter
    // which computer-use server the call came through.
    if (parent.isEmpty()) {
        for (const SessionRow &s : m_store.list()) {
            if (s.state == QStringLiteral("running") && s.parentSessionId.isEmpty()) {
                parent = s.id;
                break;
            }
        }
    }
    // Inline (ad-hoc subagent) overrides: the model can pick brain/model and give
    // a one-off system prompt without a stored agent definition.
    const QString brain = p.value(QStringLiteral("brain")).toString();
    const QString model = p.value(QStringLiteral("model")).toString();
    const QString sysPrompt = p.value(QStringLiteral("system_prompt")).toString();
    if (task.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("task is required"));
    // An agent NAME is optional — with none we spawn a generic ad-hoc subagent.
    const QString label = agent.isEmpty() ? QStringLiteral("subagent") : agent;
    // Spawn a CHILD session that runs AS the agent. A stored def supplies brain/
    // model/profile + system prompt; an unknown name + inline brain/model/
    // system_prompt makes an ad-hoc subagent. parent_session_id links it for the tree.
    QString err;
    const QString sid = createSession(
        /*profile=*/QString(), /*brain=*/brain, /*model=*/model,
        /*cwd=*/p.value(QStringLiteral("cwd")).toString(),
        /*title=*/label, &err, /*target=*/QString(),
        /*parentSessionId=*/parent, /*agent=*/label,
        /*agentPromptOverride=*/sysPrompt);
    if (sid.isEmpty())
        return Response::failure(req.id, QStringLiteral("dispatch_failed"), err);
    // Every subagent MUST end with a summary so the parent can act on its result.
    const QString taskWithSummary = task +
        QStringLiteral("\n\n[IMPORTANT] When you finish, end your final reply with a "
                       "clear SUMMARY: what you did and the exact result/output "
                       "(paths, values, findings). Keep it concise but complete — your "
                       "parent agent only sees this summary.");
    // Remember to wake the parent when this child's turn finishes.
    if (!parent.isEmpty())
        m_subagentPendingWake.insert(sid, parent);
    if (!sendToSession(sid, taskWithSummary, {}, &err)) {
        m_subagentPendingWake.remove(sid);
        return Response::failure(req.id, QStringLiteral("dispatch_send_failed"), err);
    }
    m_audit.record(QStringLiteral("agents.dispatch"), true, QStringLiteral("medium"),
                   QStringLiteral("dispatched agent '%1'%2").arg(
                       label, remote ? QStringLiteral(" (remote)") : QString()));
    QJsonObject result;
    result.insert(QStringLiteral("session_id"), sid);
    result.insert(QStringLiteral("agent"), label);
    if (!parent.isEmpty())
        result.insert(QStringLiteral("parent_session_id"), parent);
    return Response::success(req.id, result);
}

Response ControlServer::handleAgentsResult(const Request &req)
{
    const QString sid = req.params.value(QStringLiteral("session_id")).toString();
    if (sid.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id is required"));
    const auto row = m_store.get(sid);
    if (!row)
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("no such session: ") + sid);
    // "running" must reflect whether the TURN is still going — by STATE, not by
    // m_brains (a brain persists across turns, so it'd say "running" forever and
    // agent_wait would never return until timeout). state=idle/done/error = not running.
    const QString st = row->state;
    const bool running = (st == QStringLiteral("running") || st == QStringLiteral("starting"));
    QJsonObject result;
    result.insert(QStringLiteral("session_id"), sid);
    result.insert(QStringLiteral("agent"), row->agent);
    result.insert(QStringLiteral("status"), st);
    result.insert(QStringLiteral("running"), running);
    result.insert(QStringLiteral("live"), m_brains.contains(sid));
    result.insert(QStringLiteral("summary"), subagentSummary(sid));
    return Response::success(req.id, result);
}

Response ControlServer::handleAgentsRunning(const Request &req)
{
    QJsonArray arr;
    for (const SessionRow &s : m_store.list()) {
        if (s.agent.isEmpty())
            continue;
        const bool live = m_brains.contains(s.id);
        QJsonObject o = s.toJson();
        o.insert(QStringLiteral("live"), live);
        o.insert(QStringLiteral("running"),
                 live && (s.state == QStringLiteral("running") ||
                          s.state == QStringLiteral("starting")));
        arr.append(o);
    }
    QJsonObject result;
    result.insert(QStringLiteral("agents"), arr);
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
            for (const MemoryRow &m : recent) {
                // A digest is a SUMMARY: show only a one-line preview of each
                // memory. A memory can hold a large pasted blob (e.g. a whole
                // article a co-work session ingested); dumping it verbatim here
                // blew the digest up to thousands of lines and overflowed the
                // desktop's TODAY//BRIEFING panel (it looked like a stuck chat).
                QString preview = m.text.simplified();   // collapse newlines/runs
                if (preview.size() > 120)
                    preview = preview.left(120) + QStringLiteral("…");
                out += QStringLiteral("- %1\n").arg(preview);
            }
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

    // Google Calendar connector hook: when the "google-calendar" connector
    // exists AND is enabled, fold in a calendar section. Live Google calls are
    // out of scope for the framework, so we emit a best-effort placeholder line
    // here (a future live-fetch slots in at this same spot). When the connector
    // is absent or DISABLED, NOTHING is appended (so the mock/disabled row does
    // not pollute the digest).
    if (m_mcp) {
        for (const McpServerRow &row : m_mcp->list()) {
            if (row.name != QStringLiteral("google-calendar") || !row.enabled)
                continue;
            out += QStringLiteral("\n## Calendar\n");
            out += QStringLiteral("- (calendar connector enabled — events fold in "
                                  "when authorized)\n");
            break;
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
    // The effective provider: explicit param, else the persisted setting.
    QString provider = req.params.value(QStringLiteral("provider")).toString();
    if (provider.isEmpty())
        provider = m_settings.sttProvider();
    // Only hard-fail on a missing Mistral key when the effective provider would
    // need it (i.e. it isn't a usable local provider — local whisper needs no key).
    if (key.isEmpty() && !VoiceProvider::sttLocalUsable(provider))
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

    const VoiceService::Result r =
        VoiceProvider::sttWithProvider(provider, key, audio, mime, lang, model, 30000);
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
    // The effective provider: explicit param, else the persisted setting.
    QString provider = req.params.value(QStringLiteral("provider")).toString();
    if (provider.isEmpty())
        provider = m_settings.ttsProvider();
    // Only hard-fail on a missing Mistral key when the effective provider would
    // need it (i.e. it isn't a usable local provider — local piper needs no key).
    if (key.isEmpty() && !VoiceProvider::ttsLocalUsable(provider))
        return Response::failure(req.id, QStringLiteral("no_voice_key"),
                                 QStringLiteral("Mistral API key not configured"));

    const QString text = req.params.value(QStringLiteral("text")).toString();
    if (text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("text is required"));
    // Effective voice: explicit param, else the persisted tts_voice setting, else
    // the product default (the cloned "jarvice" voice).
    QString vc = req.params.value(QStringLiteral("voice")).toString();
    if (vc.isEmpty())
        vc = m_settings.ttsVoice();
    if (vc.isEmpty())
        vc = kCloneVoiceDefault;
    const QString format = req.params.value(QStringLiteral("format")).toString();
    const QString model = req.params.value(QStringLiteral("model")).toString();

    // A cloned voice synths from a reference clip (ref_audio) and clears the named
    // voice. If the clip is missing on disk, fall back to a stock voice so the
    // assistant still speaks rather than erroring on an unknown slug.
    QString refB64 = cloneRefAudioB64(vc);
    if (refB64.isEmpty() && (vc == kCloneVoiceDefault || vc.startsWith(QStringLiteral("clone:")))) {
        qWarning("voice.tts: clone voice '%s' has no reference clip "
                 "(~/.config/jarvis/voices/) — using stock voice", qPrintable(vc));
        vc = VoiceService::defaultVoice();
    }
    const QString effVoice = refB64.isEmpty() ? vc : QString();

    const VoiceService::Result r =
        VoiceProvider::ttsWithProvider(provider, key, text, effVoice, format, model, 30000, refB64);
    if (!r.ok)
        return Response::failure(req.id, QStringLiteral("voice_tts_failed"), r.error);

    QJsonObject result;
    result.insert(QStringLiteral("audio_b64"), QString::fromLatin1(r.audio.toBase64()));
    result.insert(QStringLiteral("mime"), r.mime);
    return Response::success(req.id, result);
}

Response ControlServer::handleVoiceListVoices(const Request &req)
{
    // A small CURATED list of Mistral Voxtral voice slugs for the TTS picker.
    // en_paul_neutral is the VoiceService default and the one we are confident
    // about; the others are the standard Voxtral preset speakers. If any prove
    // invalid server-side, voice.tts simply falls back to the default voice, so
    // listing them here is safe.
    struct V { const char *id; const char *label; };
    static const V voices[] = {
        // The signature cloned voice (Mistral ref_audio) + the product default.
        { "jarvice",           "Jarvice — cloned voice (default)" },
        { "en_paul_neutral",   "Paul — neutral (EN)" },
        { "en_emma_neutral",   "Emma — neutral (EN)" },
        { "en_oliver_warm",    "Oliver — warm (EN)" },
        { "en_sophia_bright",  "Sophia — bright (EN)" },
        { "fr_louis_neutral",  "Louis — neutral (FR)" },
        { "es_diego_neutral",  "Diego — neutral (ES)" },
    };

    QJsonArray voxtralVoices;
    for (const V &v : voices) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QString::fromLatin1(v.id));
        o.insert(QStringLiteral("label"), QString::fromLatin1(v.label));
        voxtralVoices.append(o);
    }

    // Provider-aware: the active TTS provider decides which voice list is
    // primary. Explicit param wins, else the persisted setting.
    QString provider = req.params.value(QStringLiteral("tts_provider")).toString();
    if (provider.isEmpty())
        provider = m_settings.ttsProvider();
    const QJsonArray piperVoices = VoiceProvider::piperVoices();

    QJsonObject result;
    result.insert(QStringLiteral("voices"),
                  provider == QStringLiteral("piper") ? piperVoices : voxtralVoices);
    // The current default: the user's tts_voice setting if set, else the
    // VoiceService default slug.
    const QString cur = m_settings.ttsVoice();
    result.insert(QStringLiteral("default"),
                  cur.isEmpty() ? kCloneVoiceDefault : cur);
    // Provider lists so a single call gives the picker both, plus a per-provider
    // voice map so the desktop can switch provider client-side without a round-trip.
    result.insert(QStringLiteral("stt_providers"), VoiceProvider::sttProviders());
    result.insert(QStringLiteral("tts_providers"), VoiceProvider::ttsProviders());
    QJsonObject byProvider;
    byProvider.insert(QStringLiteral("voxtral"), voxtralVoices);
    byProvider.insert(QStringLiteral("piper"), piperVoices);
    result.insert(QStringLiteral("voices_by_provider"), byProvider);
    result.insert(QStringLiteral("note"),
                  QStringLiteral("Voxtral preset speakers; if a slug is rejected, "
                                 "voice.tts falls back to en_paul_neutral."));
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
        QStringLiteral("voice.list_voices"),
        QStringLiteral("take_over.request"), QStringLiteral("file.push"),
        QStringLiteral("file.get"),
        QStringLiteral("devices.pair_start"), QStringLiteral("devices.list"),
        QStringLiteral("devices.revoke"),
        QStringLiteral("agent_desktop.info"),
        // 2FA unlock gate (read/action tier; harmless over the device channel).
        QStringLiteral("auth.request"),      QStringLiteral("auth.status"),
        QStringLiteral("auth.deny"),
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
    if (m == QStringLiteral("voice.list_voices")) return handleVoiceListVoices(req);
    if (m == QStringLiteral("take_over.request")) return handleTakeOverRequest(req);
    if (m == QStringLiteral("file.push"))       return handleFilePush(req);
    if (m == QStringLiteral("file.get"))        return handleFileGet(req);
    if (m == QStringLiteral("devices.pair_start")) return handleDevicesPairStart(req);
    if (m == QStringLiteral("devices.list"))    return handleDevicesList(req);
    if (m == QStringLiteral("devices.revoke"))  return handleDevicesRevoke(req);
    if (m == QStringLiteral("agent_desktop.info")) return handleAgentDesktopInfo(req);
    if (m == QStringLiteral("auth.request"))    return handleAuthRequest(req);
    if (m == QStringLiteral("auth.status"))     return handleAuthStatus(req);
    if (m == QStringLiteral("auth.deny"))       return handleAuthDeny(req);
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
    // Push a notification to paired phones (incl. backgrounded ones) that a
    // scheduled task started — distinct from a manual session.opened. Tapping it
    // deep-links to the new session's chat (data.session_id).
    if (m_fcm) {
        PushMessage msg;
        msg.title = QStringLiteral("Scheduled task started");
        msg.body = row.name.isEmpty() ? QStringLiteral("A scheduled Jarvis task is running")
                                       : row.name;
        msg.data.insert(QStringLiteral("kind"), QStringLiteral("schedule_fired"));
        msg.data.insert(QStringLiteral("session_id"), sid);
        for (const PushTokenRow &t : m_store.listPushTokens())
            m_fcm->send(t.fcmToken, msg);
    }
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
        // PRIMARY subagent-done trigger: a subagent's turn just completed (its
        // summary is already persisted above), so wake its parent now. This is far
        // more reliable than turnFinished (which can lag/never fire for a child).
        wakeParentForSubagent(sessionId);
    } else if (ev.kind == NormalizedBrainEvent::Kind::Error) {
        m_store.updateState(sessionId, QStringLiteral("error"));
        // A failed subagent should still un-block the parent.
        wakeParentForSubagent(sessionId);
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
    for (QWebSocket *client : std::as_const(m_clients)) {
        // Scoped clients (those that sent session.subscribe) only receive events for
        // the session ids they are viewing; everything else is filtered out HERE, at
        // the source, so a foreign session can never reach them. Clients that never
        // subscribed keep the legacy broadcast.
        if (m_scopedClients.contains(client)
            && !m_subscriptions.value(client).contains(sessionId))
            continue;
        client->sendTextMessage(payload);
    }
}

} // namespace jarvis
