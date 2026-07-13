#include "ControlServer.h"

#include "jarvis/ApiBrain.h"
#include "jarvis/Brain.h"
#include "jarvis/DataPaths.h"
#include "jarvis/ClaudeBrain.h"
#include "jarvis/CliResolve.h"
#include "jarvis/CodexBrain.h"
#include "jarvis/Connectors.h"
#include "jarvis/GitOps.h"
#include "jarvis/InjectionGuard.h"
#include "jarvis/ModelCatalog.h"
#include "jarvis/UiManifest.h"
#include "jarvis/OsvAdvisory.h"
#include "jarvis/PluginSigner.h"
#include "jarvis/Updater.h"

#include <algorithm>

#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QHostAddress>
#include <QCryptographicHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkInterface>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QSharedPointer>
#include <QSet>
#include <QTcpServer>
#include <QTcpSocket>
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

// Read a flat `key: value` line out of a small YAML-ish config file (mirrors
// McpRegistry::computerUseBearer's approach for a DIFFERENT file/key —
// project-tracker's config.yaml rather than computer-use's — but anchors the
// match on "key:" rather than a bare startsWith(key), so a later key sharing
// the same prefix (e.g. "bearer_token_expiry") can't be misread as this one,
// and only strips a genuinely matched leading+trailing quote pair rather than
// every quote character anywhere in the value.
QString readYamlFlatKey(const QString &path, const QString &key)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QString();
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    const QString prefix = key + QLatin1Char(':');
    for (const QString &raw : text.split(QLatin1Char('\n'))) {
        const QString line = raw.trimmed();
        if (!line.startsWith(prefix))
            continue;
        QString v = line.mid(prefix.size()).trimmed();
        if (v.size() >= 2 &&
            ((v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"')) ||
             (v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\''))))
            v = v.mid(1, v.size() - 2);
        return v;
    }
    return QString();
}

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
    const QString dir = Config::configDir() + QStringLiteral("/voices/");
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
    seedPhoneSkill();
    // MIRROR HEAL: skills only mirror into ~/.claude/skills / ~/.codex/skills at
    // creation time, and the mirror silently skips a CLI that isn't installed
    // yet. Re-mirror everything each start so "installed claude/codex AFTER
    // Jarvis" machines pick up /internal_docs & co on the next daemon restart.
    if (const int healed = m_skills.syncMirrorsToCli(); healed > 0)
        qInfo("jarvisd: mirrored %d skill(s) into installed CLI skill dirs", healed);

    // Wave 8 co-worker ops backend. All share jarvis.db via distinct connection
    // names; each failure is non-fatal (that feature degrades, daemon survives).
    if (!m_audit.open())
        qWarning("jarvisd: audit log unavailable: %s", qPrintable(m_audit.lastError()));

    // Durable kanban work queue (jarvis#76 item 7): reclaim any items whose
    // worker died with the previous daemon, then start the dispatcher loop.
    if (!m_kanban.open()) {
        qWarning("jarvisd: work queue unavailable: %s", qPrintable(m_kanban.lastError()));
    } else {
        // Brains never survive a restart: every 'running' row at boot is an
        // orphan by definition — reclaim NOW (staleMs=0), not after the tick
        // loop's 3-minute silence threshold.
        if (const int n = m_kanban.reclaimStale(0); n > 0)
            qInfo("jarvisd: reclaimed %d orphaned work item(s) back to pending", n);
        m_queueTimer = new QTimer(this);
        m_queueTimer->setInterval(5000);
        connect(m_queueTimer, &QTimer::timeout, this, &ControlServer::tickWorkQueue);
        m_queueTimer->start();
    }
    // Proxmox agent -> user notifications (questions / fired pinged rules):
    // cheap no-op while proxmox_machines.json is empty.
    m_proxmoxMailboxTimer = new QTimer(this);
    m_proxmoxMailboxTimer->setInterval(5 * 60 * 1000);
    connect(m_proxmoxMailboxTimer, &QTimer::timeout,
            this, &ControlServer::pollProxmoxMailboxes);
    m_proxmoxMailboxTimer->start();
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
    // Named cloned-voice library (~/.config/jarvis/voices/voices.json). Seeds a
    // "Jarvis" entry from the existing jarvice_ref.* clip on first run, so today's
    // single cloned voice keeps working as the default with nothing lost.
    m_voiceLib.load();
    // Claude-Code-style lifecycle hooks (~/.config/jarvis/hooks.json). run() is a
    // no-op fast-path when an event has no hooks, so fire points cost ~nothing by
    // default.
    m_hooks.load();
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

    // AUTO-UPDATER: periodic background check of `main` on the auto_update interval
    // (default 6h, default ON). On "behind" we NOTIFY + audit only — never apply
    // automatically (the user confirms via Settings → "Check for updates").
    connect(&m_updater, &Updater::updateAvailable, this,
            [this](const UpdateStatus &st) {
                m_notify.notify(QStringLiteral("Cindro update available"),
                                QStringLiteral("A newer version is on main (%1). "
                                               "Open Settings → Updates to update.")
                                    .arg(st.latest.left(12)),
                                NotifyService::Urgency::Normal,
                                QStringLiteral("jarvis.update"));
                m_audit.record(QStringLiteral("update.available"), true,
                               QStringLiteral("low"),
                               QStringLiteral("update available: %1 -> %2")
                                   .arg(st.current.left(12), st.latest.left(12)));
            });
    // AUTO-INSTALL (auto_update_apply=on): the periodic check just applied an
    // update in place — tell the user what happened. On Windows the installer
    // restarts the apps itself; an AppImage swap lands on the next launch.
    connect(&m_updater, &Updater::autoApplied, this, [this](const QJsonObject &r) {
        const bool updated = r.value(QStringLiteral("updated")).toBool();
        const QString to = r.value(QStringLiteral("to")).toString();
        if (updated) {
            const bool needsRestart =
                r.value(QStringLiteral("restart_required")).toBool();
            m_notify.notify(QStringLiteral("Cindro updated"),
                            needsRestart
                                ? QStringLiteral("Updated to %1 — restart Cindro to "
                                                 "finish.").arg(to)
                                : QStringLiteral("Updated to %1.").arg(to),
                            NotifyService::Urgency::Normal,
                            QStringLiteral("jarvis.update"));
        }
        m_audit.record(QStringLiteral("update.auto_apply"), updated,
                       QStringLiteral("high"),
                       updated ? QStringLiteral("auto-updated to ") + to
                               : QStringLiteral("auto-update failed: ")
                                     + r.value(QStringLiteral("reason")).toString());
    });
    m_updater.configureAuto(m_settings.autoUpdate(),
                            m_settings.autoUpdateIntervalHours(),
                            m_settings.autoUpdateApply());

    m_mcp = std::make_unique<McpRegistry>(m_store);
    // Native phone subsystem: expose its MCP tools to the brain if configured.
    seedPhoneMcp();
    // Real-time phone events (jarvis#76 item 3): subscribe to the phone
    // server's own WS as the user extension so incoming_call / call_message /
    // screening events PUSH to every Jarvis surface instead of being polled.
    connectPhoneWs();
    m_plugins = std::make_unique<PluginRegistry>(m_store);
    m_plugins->ensureSeeded(); // seed sample manifests if the catalog is empty

    // Contract C: load paired devices + ensure the daemon ed25519 identity, and
    // pick the best available FCM push backend (real if a "the FCM project" service
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

    // Skill lifecycle curation (jarvis#76 item 2): hourly, archive (never
    // delete) agent-created unpinned skills idle past skill_archive_days.
    m_skillSweepTimer = new QTimer(this);
    m_skillSweepTimer->setInterval(3600000); // hourly
    connect(m_skillSweepTimer, &QTimer::timeout, this, &ControlServer::sweepStaleSkills);
    m_skillSweepTimer->start();

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

        const QUrl url = client->requestUrl();
        const QUrlQuery query(url);

        // Extension pairing (loopback already enforced above). The desktop app
        // mints a single-use code via extension.pair_start; the Chrome/Edge
        // extension connects here as ?code=<6 digits> to CLAIM the bearer + control
        // tokens in one paste — no hand-copying two secrets. Same-user localhost, so
        // it exposes nothing a local process couldn't already read from the 0600
        // token files. Single-use + 5-min TTL (the device PairingManager pool).
        if (url.path() == QStringLiteral("/control/pair")) {
            const QString code = query.queryItemValue(QStringLiteral("code"));
            QJsonObject rsp;
            if (!code.isEmpty() && m_pairing.consume(code)) {
                rsp.insert(QStringLiteral("ok"), true);
                rsp.insert(QStringLiteral("bearer"), McpRegistry::computerUseBearer());
                rsp.insert(QStringLiteral("bearer_port"),
                           QUrl(McpRegistry::builtinEndpoint()).port(8794));
                rsp.insert(QStringLiteral("control_token"), m_controlToken);
                rsp.insert(QStringLiteral("control_port"), m_config.controlPort);
            } else {
                rsp.insert(QStringLiteral("ok"), false);
                rsp.insert(QStringLiteral("error"),
                           QStringLiteral("invalid or expired pairing code"));
            }
            client->sendTextMessage(QString::fromUtf8(
                QJsonDocument(rsp).toJson(QJsonDocument::Compact)));
            client->flush();
            client->close(QWebSocketProtocol::CloseCodeNormal,
                          QStringLiteral("pairing complete"));
            client->deleteLater();
            continue;
        }

        // Verify request path and ?token=.
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
    m_phoneEventClients.remove(client);
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
    else if (m == QStringLiteral("status.get"))
        resp = handleStatusGet(req);
    else if (m == QStringLiteral("ui.manifest.get"))
        resp = handleUiManifestGet(req);
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
    else if (m == QStringLiteral("session.search"))
        resp = handleSessionSearch(req);
    else if (m == QStringLiteral("session.set_goals"))
        resp = handleSessionSetGoals(req);
    else if (m == QStringLiteral("hooks.list"))
        resp = handleHooksList(req);
    else if (m == QStringLiteral("hooks.add"))
        resp = handleHooksAdd(req);
    else if (m == QStringLiteral("hooks.remove"))
        resp = handleHooksRemove(req);
    else if (m == QStringLiteral("hooks.test"))
        resp = handleHooksTest(req);
    else if (m == QStringLiteral("policy.list"))
        resp = handlePolicyList(req);
    else if (m == QStringLiteral("policy.add"))
        resp = handlePolicyAdd(req);
    else if (m == QStringLiteral("policy.update"))
        resp = handlePolicyUpdate(req);
    else if (m == QStringLiteral("policy.remove"))
        resp = handlePolicyRemove(req);
    else if (m == QStringLiteral("policy.set_default"))
        resp = handlePolicySetDefault(req);
    else if (m == QStringLiteral("policy.test"))
        resp = handlePolicyTest(req);
    else if (m == QStringLiteral("phone.mcp"))
        resp = handlePhoneMcp(req);
    else if (m == QStringLiteral("phone.http"))
        resp = handlePhoneHttp(req);
    else if (m == QStringLiteral("phone.config"))
        resp = handlePhoneConfig(req);
    else if (m == QStringLiteral("phone.policy.list"))
        resp = handlePhonePolicyList(req);
    else if (m == QStringLiteral("phone.policy.set"))
        resp = handlePhonePolicySet(req);
    else if (m == QStringLiteral("phone.policy.reset"))
        resp = handlePhonePolicyReset(req);
    else if (m == QStringLiteral("phone.policy.test"))
        resp = handlePhonePolicyTest(req);
    else if (m == QStringLiteral("phone.twilio_verify_start"))
        resp = handleTwilioVerifyStart(req);
    else if (m == QStringLiteral("phone.twilio_verify_status"))
        resp = handleTwilioVerifyStatus(req);
    else if (m == QStringLiteral("phone.twilio_caller_ids_list"))
        resp = handleTwilioCallerIdsList(req);
    else if (m == QStringLiteral("session.subscribe"))
        resp = handleSessionSubscribe(client, req);
    else if (m == QStringLiteral("widget.viewing"))
        resp = handleWidgetViewing(client, req);
    else if (m == QStringLiteral("widget.subscribe"))
        resp = handleWidgetSubscribe(client, req);
    else if (m == QStringLiteral("phone.event.subscribe"))
        resp = handlePhoneEventSubscribe(client, req);
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
    else if (m == QStringLiteral("connectors.set_client"))
        resp = handleConnectorsSetClient(req);
    else if (m == QStringLiteral("connectors.oauth_start"))
        resp = handleConnectorsOAuthStart(req);
    else if (m == QStringLiteral("connectors.oauth_status"))
        resp = handleConnectorsOAuthStatus(req);
    else if (m == QStringLiteral("connectors.remove"))
        resp = handleConnectorsRemove(req);
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
    else if (m == QStringLiteral("extension.pair_start"))
        resp = handleExtensionPairStart(req);
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
    else if (m == QStringLiteral("voice.create_clone"))
        resp = handleVoiceCreateClone(req);
    else if (m == QStringLiteral("voice.delete_clone"))
        resp = handleVoiceDeleteClone(req);
    else if (m == QStringLiteral("voice.set_default"))
        resp = handleVoiceSetDefault(req);
    else if (m == QStringLiteral("voice.rename_clone"))
        resp = handleVoiceRenameClone(req);
    else if (m == QStringLiteral("voice.preview_clone"))
        resp = handleVoicePreviewClone(req);
    else if (m == QStringLiteral("file.push"))
        resp = handleFilePush(req);
    else if (m == QStringLiteral("file.get"))
        resp = handleFileGet(req);
    else if (m == QStringLiteral("update.check"))
        resp = handleUpdateCheck(req);
    else if (m == QStringLiteral("update.apply"))
        resp = handleUpdateApply(req);
    else if (isMemoryOrSkillMethod(m))
        resp = dispatchMemoryOrSkill(req);
    else if (isOpsMethod(m))
        resp = dispatchOpsMethod(req, /*remote=*/false);
    else if (isQueueMethod(m))
        resp = dispatchQueueMethod(req);
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

Response ControlServer::handleStatusGet(const Request &req)
{
    // Live HUD telemetry for both frontends' status strips (the GUI's
    // HudStatusStrip previously hardcoded mcpCount=1; the TUI topbar had no
    // MCP/agent stats at all). Cheap counters only — no per-server liveness
    // probes here (that's mcp.test's job).
    QJsonObject r;
    r.insert(QStringLiteral("version"), Updater::runningVersion());
    r.insert(QStringLiteral("git_sha"), Updater::runningSha());
    r.insert(QStringLiteral("default_brain"), m_settings.defaultBrain());

    int mcpTotal = 0, mcpEnabled = 0;
    if (m_mcp) {
        for (const McpServerRow &row : m_mcp->list()) {
            ++mcpTotal;
            if (row.enabled)
                ++mcpEnabled;
        }
    }
    QJsonObject mcp;
    mcp.insert(QStringLiteral("total"), mcpTotal);
    mcp.insert(QStringLiteral("enabled"), mcpEnabled);
    r.insert(QStringLiteral("mcp"), mcp);

    int agentsRunning = 0;
    for (const SessionRow &s : m_store.list()) {
        if (s.agent.isEmpty())
            continue;
        if (m_brains.contains(s.id) && (s.state == QStringLiteral("running") ||
                                        s.state == QStringLiteral("starting")))
            ++agentsRunning;
    }
    r.insert(QStringLiteral("agents_running"), agentsRunning);
    r.insert(QStringLiteral("sessions_live"), int(m_brains.size()));
    return Response::success(req.id, r);
}

// Static FLOOR model list per brain — the always-available baseline used when
// there's no live catalog cached yet (or the live fetch failed) and as the
// stable "known-good" set firstModelForBrain() defaults from. codex/claude
// additionally get a LIVE catalog merged in by mergedModelsForBrain()
// (fetchCodexModelCatalog/fetchClaudeModelCatalog below) so a CLI upgrade or a
// new model release shows up without a Jarvis rebuild — see AGENTS.md's
// "Dynamic model discovery" entry. Codex also merges anything in
// ~/.codex/config.toml (handleModelList, unrelated to the live catalog).
static QJsonArray modelsForBrain(const QString &brain)
{
    QJsonArray models;
    if (brain == QStringLiteral("codex")) {
        models << QStringLiteral("gpt-5.5") << QStringLiteral("gpt-5-codex")
               << QStringLiteral("gpt-5.5-codex") << QStringLiteral("o4-mini");
    } else if (brain == QStringLiteral("claude")) {
        // Full model names (floor — the live /v1/models catalog supersedes
        // these once fetched) + the claude CLI's real `--model` ALIASES
        // (opus/sonnet/haiku), which resolve to whatever the signed-in
        // account's latest is and so never go stale on their own.
        models << QStringLiteral("claude-opus-4-8")
               << QStringLiteral("claude-sonnet-4-6")
               << QStringLiteral("claude-haiku-4-5")
               << QStringLiteral("opus") << QStringLiteral("sonnet")
               << QStringLiteral("haiku");
    } else { // api — Mistral first: the recommended default for a CLI-less user.
        models << QStringLiteral("mistral-large-latest")
               << QStringLiteral("mistral-small-latest")
               << QStringLiteral("gpt-5.5") << QStringLiteral("o4-mini")
               << QStringLiteral("claude-opus-4-8")
               // jarvis#76 item 11: providers auto-routed by model-id prefix
               // (gemini-* / grok-* / deepseek-*), OpenAI-compatible dialect.
               << QStringLiteral("gemini-2.5-flash")
               << QStringLiteral("grok-4")
               << QStringLiteral("deepseek-chat")
               << QStringLiteral("qwen2.5:3b");
    }
    return models;
}

// Which brains are actually usable here: codex/claude need their CLI on PATH;
// the `api` brain is always present (it's a direct HTTP loop). Drives both the
// no-CLI fallback and the picker's availability badges.
static bool cliOnPath(const QString &exe)
{
    return !QStandardPaths::findExecutable(exe).isEmpty();
}
static QJsonObject brainAvailability()
{
    QJsonObject a;
    a.insert(QStringLiteral("codex"), cliOnPath(QStringLiteral("codex")));
    a.insert(QStringLiteral("claude"), cliOnPath(QStringLiteral("claude")));
    a.insert(QStringLiteral("api"), true);
    return a;
}

// The default model for a brain when the caller gives none: the FIRST entry of
// modelsForBrain (claude -> a claude model, api -> a configured-provider model)
// — NOT the global default (gpt-5.5, which is only correct for codex).
// Deliberately reads the STATIC list, not mergedModelsForBrain()'s live-
// augmented one: live catalog entries are appended (never prepended), so a
// brand-new or possibly-preview model becoming selectable never silently
// changes what a fresh session defaults to.
static QString firstModelForBrain(const QString &brain)
{
    const QJsonArray models = modelsForBrain(brain);
    return models.isEmpty() ? QString() : models.first().toString();
}

// The codex default model configured directly in ~/.codex/config.toml (the
// `model = "..."` line, ignoring `model_*` keys), or empty when unset/unreadable.
// Shared by handleModelList (to surface it in the picker) and coerceModelForBrain
// (to accept it as a valid codex model instead of reverting to the static default).
static QString codexConfiguredModel()
{
    QFile f(QDir::homePath() + QStringLiteral("/.codex/config.toml"));
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QString();
    QTextStream in(&f);
    while (!in.atEnd()) {
        const QString line = in.readLine().trimmed();
        if (line.startsWith(QStringLiteral("model")) && line.contains(QLatin1Char('='))
            && !line.startsWith(QStringLiteral("model_"))) {
            QString v = line.section(QLatin1Char('='), 1).trimmed();
            if (v.size() >= 2 && v.startsWith(QLatin1Char('"')))
                v = v.mid(1, v.size() - 2);
            return v;
        }
    }
    return QString();
}

// Guard a brain/model MISMATCH. Brain and model are picked independently, so
// switching the brain (e.g. claude -> codex) without touching the model leaves a
// stale foreign model selected. Sending it to the CLI is fatal: codex on a ChatGPT
// account rejects a claude model with `invalid_request_error: "claude-haiku-4-5" is
// not supported when using Codex with a ChatGPT account` and `codex exited with
// code 1`. If the stored model isn't valid for this brain, fall back to the brain's
// own default. Empty stays empty (the brain resolves its own default). Only used for
// the CLI brains (codex/claude) — the `api` brain accepts arbitrary provider/ollama
// model ids not in the static list. A member function (not the free
// modelsForBrain()) so it can check the live catalog cache too — reads only,
// never triggers a fetch itself: this runs on session creation AND lazy resume
// on first message after a restart, both hot paths where spawn/network latency
// would be a regression.
QString ControlServer::coerceModelForBrain(const QString &brain, const QString &model)
{
    if (model.isEmpty())
        return model;
    if (mergedModelsForBrain(brain).contains(QJsonValue(model)))
        return model;
    // codex: a model set directly in ~/.codex/config.toml is legitimate even
    // when it's not in the static/live catalog — accept the user's own pick
    // instead of silently reverting it to the brain default.
    if (brain == QStringLiteral("codex") && !model.isEmpty()
        && model == codexConfiguredModel())
        return model;
    return firstModelForBrain(brain);
}

QJsonArray ControlServer::mergedModelsForBrain(const QString &brain) const
{
    const QJsonArray baseline = modelsForBrain(brain);
    const auto it = m_liveModelCache.constFind(brain);
    if (it == m_liveModelCache.constEnd())
        return baseline;
    return jarvis::mergeModelCatalogs(baseline, it->models);
}

void ControlServer::refreshLiveModelCatalog(const QString &brain)
{
    if (brain != QStringLiteral("codex") && brain != QStringLiteral("claude"))
        return; // api brain accepts arbitrary provider/ollama ids; no catalog here
    const ModelCatalogEntry &entry = m_liveModelCache[brain]; // default-constructs if absent
    if (entry.fetchInFlight)
        return;
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const qint64 ttlMs = entry.lastFetchFailed ? 30'000 : 300'000;
    if (entry.fetchedAtMs != 0 && (now - entry.fetchedAtMs) < ttlMs)
        return; // still fresh
    if (brain == QStringLiteral("codex"))
        fetchCodexModelCatalog();
    else
        fetchClaudeModelCatalog();
}

void ControlServer::storeLiveModelCatalog(const QString &brain, const QJsonArray &models, bool ok)
{
    ModelCatalogEntry &entry = m_liveModelCache[brain];
    entry.fetchInFlight = false;
    entry.fetchedAtMs = QDateTime::currentMSecsSinceEpoch();
    entry.lastFetchFailed = !ok;
    if (ok)
        entry.models = models; // a failed refresh keeps the last known-good list
}

// `codex debug models --bundled` dumps the CLI's real bundled model catalog as
// JSON (slug/display_name/description/visibility/...) — an explicitly
// unofficial/undocumented debugging subcommand, not part of codex's stable
// --help surface, so this is designed to fail open on ANY shape mismatch or
// the subcommand vanishing outright, never to throw or block model.list.
// Fully async (QProcess signals, no waitForFinished) — this file's single
// event loop also pumps every connected brain's process I/O, so blocking here
// would stall live chat streaming for every connected surface.
void ControlServer::fetchCodexModelCatalog()
{
    const QString brain = QStringLiteral("codex");
    m_liveModelCache[brain].fetchInFlight = true;

    QString program = QStringLiteral("codex");
    QStringList args{QStringLiteral("debug"), QStringLiteral("models"), QStringLiteral("--bundled")};
    jarvis::resolveCliLaunch(program, args);

    auto *proc = new QProcess(this);
    proc->setProgram(program);
    proc->setArguments(args);
    proc->setProcessChannelMode(QProcess::SeparateChannels);
    // Drain stderr as it arrives (discarded) — `codex debug` is an unofficial
    // subcommand that could log more than the OS pipe buffer's worth of
    // diagnostics to stderr; with SeparateChannels and nothing reading that
    // pipe, the child blocks on the write and never exits on its own (the
    // 4s timeout below would still catch it, but every codex model.list call
    // would eat the full timeout instead of getting a live catalog).
    connect(proc, &QProcess::readyReadStandardError, proc, [proc]() {
        proc->readAllStandardError();
    });

    auto *timeout = new QTimer(proc);
    timeout->setSingleShot(true);
    connect(timeout, &QTimer::timeout, proc, [proc]() {
        if (proc->state() != QProcess::NotRunning)
            proc->kill();
    });
    timeout->start(4000);

    connect(proc, &QProcess::finished, this,
            [this, proc, brain](int exitCode, QProcess::ExitStatus status) {
        jarvis::ModelCatalogResult parsed;
        if (status == QProcess::NormalExit && exitCode == 0)
            parsed = jarvis::parseCodexModelCatalog(proc->readAllStandardOutput());
        if (!parsed.ok) {
            qInfo().noquote() << "[model-catalog] codex live fetch failed (exit"
                               << exitCode << "status" << status
                               << ") — falling back to the static model list";
        }
        proc->deleteLater();
        storeLiveModelCatalog(brain, parsed.models, parsed.ok);
    });
    // FailedToStart is the one ProcessError that's guaranteed NOT to also fire
    // `finished` (Qt docs) — anything else (Crashed, our own kill()-induced
    // exit, ...) is already covered by the `finished` handler above, so acting
    // on it here too would double-store the same outcome.
    connect(proc, &QProcess::errorOccurred, this, [this, proc, brain](QProcess::ProcessError err) {
        if (err != QProcess::FailedToStart)
            return;
        qInfo().noquote() << "[model-catalog] codex not runnable (not on PATH?)"
                              " — falling back to the static model list";
        proc->deleteLater();
        storeLiveModelCatalog(brain, {}, false);
    });
    proc->start();
}

// Reads the Claude Code OAuth access token the same field/technique the CLI's
// own third-party tooling already uses in production (verified against
// CrazyMan28/claude_knows' bin/ck-usage, which calls the sibling
// /api/oauth/usage endpoint the same way for Claude Code's own `/usage`
// command) — but from ONE dir: m_settings.claudeConfigDir(), the SAME
// pro/max-account resolver ClaudeBrain itself is spawned with
// (ControlServer.cpp's makeBrain, opts.configDir = m_settings.claudeConfigDir()).
// An earlier version of this tried CLAUDE_CONFIG_DIR / ~/.claude /
// ~/.claude-secondary in a fixed fallback order — that can silently pick a
// DIFFERENT account's token than the one the daemon actually drives the CLI
// with (e.g. stale-but-valid Pro credentials on disk while the account setting
// is "max"), reintroducing exactly the ambient-CLAUDE_CONFIG_DIR bug
// ClaudeBrain::ClaudeBrain's own configDir default was written to prevent.
QString ControlServer::claudeOauthAccessToken() const
{
    QFile f(m_settings.claudeConfigDir() + QStringLiteral("/.credentials.json"));
    if (!f.open(QIODevice::ReadOnly))
        return QString();
    const QJsonObject root = QJsonDocument::fromJson(f.readAll()).object();
    return root.value(QStringLiteral("claudeAiOauth")).toObject()
               .value(QStringLiteral("accessToken")).toString();
}

// GET the same PUBLIC, documented Anthropic Models API (/v1/models) the codex
// side has no equivalent of — authenticated with the CLI's own subscription
// OAuth token instead of a separate API key. Confirmed live (2026-07-11): the
// endpoint accepts the OAuth bearer + the same `anthropic-beta:
// oauth-2025-04-20` header ck-usage already sends, plus the standard
// `anthropic-version` header every /v1 call requires. Fully async
// (QNetworkAccessManager + finished signal), same fail-open discipline as the
// codex fetch above.
void ControlServer::fetchClaudeModelCatalog()
{
    const QString brain = QStringLiteral("claude");
    const QString token = claudeOauthAccessToken();
    if (token.isEmpty()) {
        storeLiveModelCatalog(brain, {}, false);
        return;
    }
    m_liveModelCache[brain].fetchInFlight = true;
    if (!m_modelCatalogNam)
        m_modelCatalogNam = new QNetworkAccessManager(this);

    // limit=1000 is a one-shot "give me everything" fetch, not true pagination
    // (parseClaudeModelCatalog only reads the "data" array, not has_more/
    // last_id) — the live catalog is ~10 entries today, so this has huge
    // headroom; revisit with real pagination if Anthropic's catalog ever
    // approaches four figures.
    QNetworkRequest rq(QUrl(QStringLiteral("https://api.anthropic.com/v1/models?limit=1000")));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());
    rq.setRawHeader("anthropic-beta", "oauth-2025-04-20");
    rq.setRawHeader("anthropic-version", "2023-06-01");
    QNetworkReply *reply = m_modelCatalogNam->get(rq);

    auto *timeout = new QTimer(reply);
    timeout->setSingleShot(true);
    connect(timeout, &QTimer::timeout, reply, &QNetworkReply::abort);
    timeout->start(6000);

    connect(reply, &QNetworkReply::finished, this, [this, reply, brain]() {
        const QNetworkReply::NetworkError netErr = reply->error();
        jarvis::ModelCatalogResult parsed;
        if (netErr == QNetworkReply::NoError)
            parsed = jarvis::parseClaudeModelCatalog(reply->readAll());
        reply->deleteLater();
        if (!parsed.ok) {
            qInfo().noquote() << "[model-catalog] claude live fetch failed (network error"
                               << netErr << ") — falling back to the static model list";
        }
        storeLiveModelCatalog(brain, parsed.models, parsed.ok);
    });
}

Response ControlServer::handleSettingsGet(const Request &req)
{
    QJsonObject s;
    s.insert(QStringLiteral("default_brain"), m_settings.defaultBrain());
    s.insert(QStringLiteral("default_model"), m_settings.defaultModel());
    s.insert(QStringLiteral("claude_account"), m_settings.claudeAccount());

    // Real Claude account list for the account picker (SettingsPage.qml).
    // Include an entry only when the account's config directory exists on disk.
    // Best-effort read the email from <dir>/.claude.json oauthAccount.emailAddress;
    // fall back to ~/.claude.json for the Pro slot (the default location).
    {
        const struct { const char *id; const char *label; } kSlots[] = {
            { "pro", "Claude Pro" },
            { "max", "Claude Max" },
        };
        QJsonArray claudeAccounts;
        for (const auto &slot : kSlots) {
            const QString dir =
                SettingsStore::claudeConfigDirFor(QString::fromLatin1(slot.id));
            if (!QDir(dir).exists())
                continue;
            QString email;
            // Try the account-specific config first, then the default ~/.claude.json.
            const QStringList candidates = {
                dir + QStringLiteral("/.claude.json"),
                QDir::homePath() + QStringLiteral("/.claude.json"),
            };
            for (const QString &path : candidates) {
                QFile f(path);
                if (!f.open(QIODevice::ReadOnly))
                    continue;
                email = QJsonDocument::fromJson(f.readAll())
                            .object()
                            .value(QStringLiteral("oauthAccount"))
                            .toObject()
                            .value(QStringLiteral("emailAddress"))
                            .toString();
                f.close();
                if (!email.isEmpty())
                    break;
            }
            QJsonObject acct;
            acct.insert(QStringLiteral("id"), QString::fromLatin1(slot.id));
            acct.insert(QStringLiteral("label"), QString::fromLatin1(slot.label));
            acct.insert(QStringLiteral("email"), email);
            claudeAccounts.append(acct);
        }
        s.insert(QStringLiteral("claude_accounts"), claudeAccounts);
    }

    s.insert(QStringLiteral("tts_voice"), m_settings.ttsVoice());

    // First-launch SETUP WIZARD state + the chosen assistant name. The desktop
    // shows SetupWizard.qml on load when setup_complete is false.
    s.insert(QStringLiteral("setup_complete"), m_settings.setupComplete());
    s.insert(QStringLiteral("assistant_name"), m_settings.assistantName());
    s.insert(QStringLiteral("user_name"), m_settings.userName());

    // AUTO-UPDATER: the toggle (default ON) + the check cadence, plus the running
    // build identity (stamped at compile time) so the UI can show the version.
    s.insert(QStringLiteral("auto_update"), m_settings.autoUpdate());
    s.insert(QStringLiteral("auto_update_apply"), m_settings.autoUpdateApply());
    s.insert(QStringLiteral("auto_update_interval_hours"),
             m_settings.autoUpdateIntervalHours());
    s.insert(QStringLiteral("version"), Updater::runningVersion());
    s.insert(QStringLiteral("git_sha"), Updater::runningSha());

    // Pluggable STT/TTS providers (default "voxtral"). Ship the availability
    // lists too so the picker can show-but-disable local providers when their
    // binary is absent.
    s.insert(QStringLiteral("stt_provider"), m_settings.sttProvider());
    s.insert(QStringLiteral("tts_provider"), m_settings.ttsProvider());
    s.insert(QStringLiteral("stt_providers"), VoiceProvider::sttProviders());
    s.insert(QStringLiteral("tts_providers"), VoiceProvider::ttsProviders());

    // Video understanding prefs (flat video_* keys; the yt-dlp/ffmpeg/whisper
    // pipeline runs in the Python engine — the daemon only stores preferences).
    // video_backends carries availability so the Settings picker can grey out
    // cloud backends until their API key is set; a LIVE dependency check
    // (ffmpeg present? model downloaded?) is the engine's job — ask Jarvis to
    // run video_setup in chat.
    {
        const QJsonObject video = m_settings.videoSettings();
        for (auto it = video.begin(); it != video.end(); ++it)
            s.insert(it.key(), it.value());
        QJsonArray videoBackends;
        const auto addBackend = [&](const char *id, const char *label, bool available) {
            QJsonObject o;
            o.insert(QStringLiteral("id"), QLatin1String(id));
            o.insert(QStringLiteral("label"), QLatin1String(label));
            o.insert(QStringLiteral("available"), available);
            videoBackends.append(o);
        };
        addBackend("local", "Local whisper (offline)", true);
        addBackend("gemini-api", "Gemini API (cloud)",
                   m_settings.hasApiKey(QStringLiteral("gemini")));
        addBackend("openai-api", "OpenAI Whisper API (cloud)",
                   m_settings.hasApiKey(QStringLiteral("openai")));
        s.insert(QStringLiteral("video_backends"), videoBackends);
    }

    QJsonArray brains;
    brains << QStringLiteral("codex") << QStringLiteral("claude") << QStringLiteral("api");
    s.insert(QStringLiteral("brains"), brains);

    // Which brains are actually usable on this machine (codex/claude need their
    // CLI on PATH; api is always available). The picker shows availability
    // badges and a CLI-less user is steered to the api/Mistral brain.
    s.insert(QStringLiteral("available_brains"), brainAvailability());

    // Per-brain "can drive the computer-use nested desktop headless" capability,
    // so the picker can HONESTLY mark which brains drive (no silent swapping).
    //   claude -> yes (bypassPermissions for coworker+agent)
    //   codex  -> yes (danger-full-access on the isolated nested desktop)
    //   api    -> only when an OpenAI/Mistral key is set: the function-calling
    //            (computer-use tool) loop covers the OpenAI-compatible providers
    //            (openai/mistral). Anthropic stays chat-only (no tool loop).
    QJsonObject canDrive;
    canDrive.insert(QStringLiteral("claude"), true);
    canDrive.insert(QStringLiteral("codex"), true);
    canDrive.insert(QStringLiteral("api"),
                    m_settings.hasApiKey(QStringLiteral("openai")) ||
                        m_settings.hasApiKey(QStringLiteral("mistral")));
    s.insert(QStringLiteral("can_drive"), canDrive);

    // mergedModelsForBrain (not the static-only modelsForBrain) so the
    // Settings "default model" dropdown offers the same live-fetched models
    // the chat picker's model.list already does — kick a refresh too, in case
    // Settings loads before any model.list call has warmed the cache.
    refreshLiveModelCatalog(QStringLiteral("codex"));
    refreshLiveModelCatalog(QStringLiteral("claude"));
    QJsonObject byBrain;
    byBrain.insert(QStringLiteral("codex"), mergedModelsForBrain(QStringLiteral("codex")));
    byBrain.insert(QStringLiteral("claude"), mergedModelsForBrain(QStringLiteral("claude")));
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

    // jarvis#76: skill curation cadence, post-turn self-review, goal
    // auto-continuation, and the api-brain context-compression threshold.
    s.insert(QStringLiteral("skill_archive_days"), m_settings.skillArchiveDays());
    s.insert(QStringLiteral("self_improve"), m_settings.selfImprove());
    s.insert(QStringLiteral("auto_continue"), m_settings.autoContinue());
    s.insert(QStringLiteral("api_context_max_tokens"), m_settings.apiContextMaxTokens());

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
    if (patch.contains(QStringLiteral("skill_archive_days"))) {
        m_settings.setSkillArchiveDays(
            patch.value(QStringLiteral("skill_archive_days")).toInt());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("self_improve"))) {
        m_settings.setSelfImprove(patch.value(QStringLiteral("self_improve")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("auto_continue"))) {
        m_settings.setAutoContinue(patch.value(QStringLiteral("auto_continue")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("api_context_max_tokens"))) {
        m_settings.setApiContextMaxTokens(
            patch.value(QStringLiteral("api_context_max_tokens")).toInt());
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
    if (patch.contains(QStringLiteral("setup_complete"))) {
        m_settings.setSetupComplete(patch.value(QStringLiteral("setup_complete")).toBool());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("assistant_name"))) {
        m_settings.setAssistantName(patch.value(QStringLiteral("assistant_name")).toString());
        prefsTouched = true;
    }
    if (patch.contains(QStringLiteral("user_name"))) {
        const QString un = patch.value(QStringLiteral("user_name")).toString().trimmed();
        m_settings.setUserName(un);
        prefsTouched = true;
        // Mirror the human's name into long-term memory so every brain can address
        // them by name. Fixed id => upsert (no duplicates when the name is re-saved
        // from Settings or a later wizard run).
        if (!un.isEmpty() && m_memory.isOpen()) {
            m_memory.add(QStringLiteral("The user's name is %1.").arg(un),
                         {QStringLiteral("user"), QStringLiteral("profile")},
                         QStringLiteral("user-name"));
        }
    }
    bool autoUpdateChanged = false;
    if (patch.contains(QStringLiteral("auto_update"))) {
        m_settings.setAutoUpdate(patch.value(QStringLiteral("auto_update")).toBool());
        prefsTouched = true;
        autoUpdateChanged = true;
    }
    if (patch.contains(QStringLiteral("auto_update_apply"))) {
        m_settings.setAutoUpdateApply(
            patch.value(QStringLiteral("auto_update_apply")).toBool());
        prefsTouched = true;
        autoUpdateChanged = true;
    }
    if (patch.contains(QStringLiteral("auto_update_interval_hours"))) {
        m_settings.setAutoUpdateIntervalHours(
            patch.value(QStringLiteral("auto_update_interval_hours")).toInt());
        prefsTouched = true;
        autoUpdateChanged = true;
    }
    // Video understanding: one generic pass for every known video_* key —
    // SettingsStore validates and normalizes; unknown video_ keys are ignored.
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        if (!it.key().startsWith(QStringLiteral("video_")))
            continue;
        if (m_settings.setVideoSetting(it.key(), it.value()))
            prefsTouched = true;
    }
    if (prefsTouched)
        m_settings.saveConfig();
    // Re-arm the auto-update timer when its settings changed (toggle / interval).
    if (autoUpdateChanged)
        m_updater.configureAuto(m_settings.autoUpdate(),
                                m_settings.autoUpdateIntervalHours(),
                                m_settings.autoUpdateApply());

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

// update.check — run the platform self-update script in check-mode and report
// {current, latest, behind, version}. Blocks on a git fetch (bounded timeout).
Response ControlServer::handleUpdateCheck(const Request &req)
{
    const UpdateStatus st = m_updater.checkNow();
    QJsonObject r;
    r.insert(QStringLiteral("current"), st.current);
    r.insert(QStringLiteral("latest"), st.latest);
    r.insert(QStringLiteral("behind"), st.behind);
    r.insert(QStringLiteral("version"), st.version);
    r.insert(QStringLiteral("ok"), st.ok);
    if (!st.reason.isEmpty())
        r.insert(QStringLiteral("reason"), st.reason);
    return Response::success(req.id, r);
}

// update.apply — user-confirmed: run the script in apply-mode (pull+rebuild on
// Linux, installer on Windows) and return its {updated, to, ...}. Audited HIGH.
Response ControlServer::handleUpdateApply(const Request &req)
{
    const QJsonObject r = m_updater.applyNow();
    const bool updated = r.value(QStringLiteral("updated")).toBool();
    m_audit.record(QStringLiteral("update.apply"), updated, QStringLiteral("high"),
                   updated ? QStringLiteral("updated to %1")
                                 .arg(r.value(QStringLiteral("to")).toString())
                           : QStringLiteral("no update applied (%1)")
                                 .arg(r.value(QStringLiteral("reason")).toString()));
    return Response::success(req.id, r);
}

Response ControlServer::handleHooksList(const Request &req)
{
    QJsonObject result = m_hooks.toJson(); // { "hooks": {...} }
    result.insert(QStringLiteral("events"),
                  QJsonArray::fromStringList(HookStore::events()));
    return Response::success(req.id, result);
}

Response ControlServer::handleHooksAdd(const Request &req)
{
    const QString event = req.params.value(QStringLiteral("event")).toString();
    const QString matcher = req.params.value(QStringLiteral("matcher")).toString();
    const QString command = req.params.value(QStringLiteral("command")).toString();
    const int timeout = req.params.value(QStringLiteral("timeout")).toInt(60);
    if (!m_hooks.addHook(event, matcher, command, timeout))
        return Response::failure(req.id, QStringLiteral("bad_request"), m_hooks.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleHooksRemove(const Request &req)
{
    const QString event = req.params.value(QStringLiteral("event")).toString();
    const int index = req.params.value(QStringLiteral("index")).toInt(-1);
    if (!m_hooks.removeHook(event, index))
        return Response::failure(req.id, QStringLiteral("bad_request"), m_hooks.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleHooksTest(const Request &req)
{
    const QString event = req.params.value(QStringLiteral("event")).toString();
    const QString matchKey = req.params.value(QStringLiteral("match_key")).toString();
    const QJsonObject input = req.params.value(QStringLiteral("input")).toObject();
    const HookOutcome o = m_hooks.run(event, input, matchKey);
    QJsonObject result;
    result.insert(QStringLiteral("ran_any"), o.ranAny);
    result.insert(QStringLiteral("blocked"), o.blocked);
    result.insert(QStringLiteral("block_reason"), o.blockReason);
    result.insert(QStringLiteral("injected_context"), o.injectedContext);
    result.insert(QStringLiteral("notes"), QJsonArray::fromStringList(o.notes));
    return Response::success(req.id, result);
}

// --- Trust policies (jarvis#71) ---------------------------------------------
// The daemon owns trust_policies.json; the computer-use engine's policy gate
// enforces it on every tool call. Mutations reload-then-save so concurrent
// editors (desktop + phone) can't clobber each other's rules.

Response ControlServer::handlePolicyList(const Request &req)
{
    m_trustPolicies.load();
    return Response::success(req.id, m_trustPolicies.toJson());
}

Response ControlServer::handlePolicyAdd(const Request &req)
{
    m_trustPolicies.load();
    const QString id = m_trustPolicies.addRule(
        req.params.value(QStringLiteral("tool")).toString(),
        req.params.value(QStringLiteral("app")).toString(),
        req.params.value(QStringLiteral("action")).toString(),
        req.params.value(QStringLiteral("note")).toString(),
        req.params.value(QStringLiteral("id")).toString());
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 m_trustPolicies.lastError());
    QJsonObject result;
    result.insert(QStringLiteral("id"), id);
    return Response::success(req.id, result);
}

Response ControlServer::handlePolicyUpdate(const Request &req)
{
    m_trustPolicies.load();
    const QString id = req.params.value(QStringLiteral("id")).toString();
    QJsonObject fields = req.params;
    fields.remove(QStringLiteral("id"));
    if (!m_trustPolicies.updateRule(id, fields))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 m_trustPolicies.lastError());
    return Response::success(req.id, {});
}

Response ControlServer::handlePolicyRemove(const Request &req)
{
    m_trustPolicies.load();
    if (!m_trustPolicies.removeRule(req.params.value(QStringLiteral("id")).toString()))
        return Response::failure(req.id, QStringLiteral("not_found"),
                                 QStringLiteral("no such rule"));
    return Response::success(req.id, {});
}

Response ControlServer::handlePolicySetDefault(const Request &req)
{
    m_trustPolicies.load();
    if (!m_trustPolicies.setDefaultAction(
            req.params.value(QStringLiteral("action")).toString()))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 m_trustPolicies.lastError());
    return Response::success(req.id, {});
}

Response ControlServer::handlePolicyTest(const Request &req)
{
    m_trustPolicies.load();
    const TrustDecision d = m_trustPolicies.evaluate(
        req.params.value(QStringLiteral("tool")).toString(),
        req.params.value(QStringLiteral("app")).toString());
    QJsonObject result;
    result.insert(QStringLiteral("action"), d.action);
    result.insert(QStringLiteral("rule_id"), d.ruleId);
    result.insert(QStringLiteral("note"), d.note);
    return Response::success(req.id, result);
}

namespace {
// The phone subsystem's Jarvis-managed env (~/.config/jarvis/phone.env). Read
// fresh at each use — the setup wizard can (re)write it after daemon start.
// ONE parser for the three consumers (phone.mcp / phone.http / the event
// bridge) so the file format never drifts between them.
struct PhoneEnv {
    QString adminToken;
    QString deviceToken;
    QString agentToken;
    QString port = QStringLiteral("8801");
    // Non-secret Twilio / server config surfaced by phone.config (secrets are
    // reported only as has_* booleans, never echoed).
    QString twilioAccountSid;
    QString twilioAuthToken;
    QString twilioFromNumber;
    QString twilioPublicBaseUrl;
    QString twilioInboundExtension;
    QString twilioScreeningExtension;
    QString publicBaseUrl;
};

PhoneEnv readPhoneEnv()
{
    PhoneEnv env;
    QFile f(Config::configDir() + QStringLiteral("/phone.env"));
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return env;
    const QList<QByteArray> lines = f.readAll().split('\n');
    f.close();
    const auto val = [](const QString &line, const char *key) {
        return line.mid(int(qstrlen(key))).trimmed();
    };
    for (const QByteArray &raw : lines) {
        const QString line = QString::fromUtf8(raw).trimmed();
        if (line.startsWith(QStringLiteral("ADMIN_TOKEN=")))
            env.adminToken = val(line, "ADMIN_TOKEN=");
        else if (line.startsWith(QStringLiteral("DEVICE_TOKEN=")))
            env.deviceToken = val(line, "DEVICE_TOKEN=");
        else if (line.startsWith(QStringLiteral("AGENT_TOKEN=")))
            env.agentToken = val(line, "AGENT_TOKEN=");
        else if (line.startsWith(QStringLiteral("SERVER_PORT=")))
            env.port = val(line, "SERVER_PORT=");
        else if (line.startsWith(QStringLiteral("TWILIO_ACCOUNT_SID=")))
            env.twilioAccountSid = val(line, "TWILIO_ACCOUNT_SID=");
        else if (line.startsWith(QStringLiteral("TWILIO_AUTH_TOKEN=")))
            env.twilioAuthToken = val(line, "TWILIO_AUTH_TOKEN=");
        else if (line.startsWith(QStringLiteral("TWILIO_FROM_NUMBER=")))
            env.twilioFromNumber = val(line, "TWILIO_FROM_NUMBER=");
        else if (line.startsWith(QStringLiteral("TWILIO_PUBLIC_BASE_URL=")))
            env.twilioPublicBaseUrl = val(line, "TWILIO_PUBLIC_BASE_URL=");
        else if (line.startsWith(QStringLiteral("TWILIO_INBOUND_EXTENSION=")))
            env.twilioInboundExtension = val(line, "TWILIO_INBOUND_EXTENSION=");
        else if (line.startsWith(QStringLiteral("TWILIO_SCREENING_EXTENSION=")))
            env.twilioScreeningExtension = val(line, "TWILIO_SCREENING_EXTENSION=");
        else if (line.startsWith(QStringLiteral("PUBLIC_BASE_URL=")))
            env.publicBaseUrl = val(line, "PUBLIC_BASE_URL=");
    }
    return env;
}

// Rewrite ~/.config/jarvis/phone.env, setting each provided key (preserving all
// other lines), 0600. Empty value clears the key. Creates the file if absent.
// Returns false only on a real write failure. Shared by propagateDefaultVoice
// and phone.config so the file format never drifts.
bool writePhoneEnvKeys(const QMap<QString, QString> &kv, QString *err = nullptr)
{
    const QString envPath = Config::configDir() + QStringLiteral("/phone.env");
    QDir().mkpath(QFileInfo(envPath).absolutePath());
    QStringList out;
    QSet<QString> written;
    QFile f(envPath);
    if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        const QList<QByteArray> lines = f.readAll().split('\n');
        f.close();
        for (const QByteArray &raw : lines) {
            const QString line = QString::fromUtf8(raw);
            const QString trimmed = line.trimmed();
            bool handled = false;
            for (auto it = kv.constBegin(); it != kv.constEnd(); ++it) {
                if (trimmed.startsWith(it.key() + QLatin1Char('='))) {
                    handled = true;
                    if (!it.value().isEmpty()) {
                        out << it.key() + QLatin1Char('=') + it.value();
                        written.insert(it.key());
                    } // else drop (clear)
                    break;
                }
            }
            if (!handled)
                out << line;
        }
    }
    for (auto it = kv.constBegin(); it != kv.constEnd(); ++it) {
        if (!it.value().isEmpty() && !written.contains(it.key()))
            out << it.key() + QLatin1Char('=') + it.value();
    }
    QString body = out.join(QLatin1Char('\n'));
    while (body.endsWith(QStringLiteral("\n\n")))
        body.chop(1);
    if (!body.endsWith(QLatin1Char('\n')))
        body += QLatin1Char('\n');
    QSaveFile sf(envPath);
    if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        if (err) *err = sf.errorString();
        return false;
    }
    // Lock the file to 0600 BEFORE the secret bytes are written (phone.env holds
    // Twilio creds + admin/device/agent bearer tokens), so it never exists
    // group/world-readable even briefly — the temp file's mode is preserved
    // across commit()'s atomic rename.
    sf.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    sf.write(body.toUtf8());
    if (!sf.commit()) {
        if (err) *err = sf.errorString();
        return false;
    }
    // Belt-and-suspenders: re-assert 0600 on the committed file and WARN (don't
    // silently return ok) if the lock-down fails, matching SettingsStore.
    if (!QFile::setPermissions(envPath, QFileDevice::ReadOwner | QFileDevice::WriteOwner))
        qWarning("jarvisd: could not chmod 0600 phone.env (secrets may be readable)");
    return true;
}

// Best-effort restart of the phone subsystem so it re-reads phone.env. Returns
// true if the restart was LAUNCHED (non-blocking — never wait on the daemon's
// single event loop, which would freeze every client + live chat). On
// non-systemd platforms (Windows) the change applies on the phone server's next
// start (caller surfaces that).
bool restartPhoneService()
{
#if defined(Q_OS_LINUX)
    return QProcess::startDetached(
        QStringLiteral("systemctl"),
        {QStringLiteral("--user"), QStringLiteral("restart"),
         QStringLiteral("jarvis-phone.service")});
#else
    return false;
#endif
}
} // namespace

Response ControlServer::handlePhoneMcp(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    if (name.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("name (a phone MCP tool) is required"));
    const QJsonObject args = req.params.value(QStringLiteral("arguments")).toObject();

    // Phone Permissions (PhonePolicyStore) HARD deny-gate. This is the single
    // choke point EVERY surface (desktop/web/CLI/Android) AND the brain's
    // computer-use tools_phone.py funnel through, so a 'deny' here is a real
    // cross-surface kill-switch on high-risk phone actions (send SMS, place
    // calls, spend money, touch memory). 'ask' passes here and is finished
    // interactively brain-side in the computer-use policy gate (which owns the
    // ask-bus); we only load per-call so a policy change takes effect at once.
    // (Internal callers like phoneNotifyUser / the answer_calls screening push
    // use ungated tools — notify_user / twilio_screening_* — so they're never
    // blocked by this.)
    m_phonePolicies.load();
    if (m_phonePolicies.decisionForTool(name) == QStringLiteral("deny")) {
        m_audit.record(QStringLiteral("phone.mcp.blocked"), false, QStringLiteral("high"),
                       name + QStringLiteral(" denied by phone permissions"), QString());
        return Response::failure(
            req.id, QStringLiteral("blocked_by_phone_policy"),
            QStringLiteral("Blocked by Phone Permissions: '") + name
                + QStringLiteral("' is set to Deny. Change it in Phone → Permissions."));
    }

    // The bearer never leaves the daemon — clients call phone.mcp and we forward.
    const PhoneEnv penv = readPhoneEnv();
    const QString token = penv.agentToken;
    const QString port = penv.port;
    if (token.isEmpty())
        return Response::failure(req.id, QStringLiteral("phone_not_configured"),
                                 QStringLiteral("phone subsystem is not set up (no phone.env)"));

    QJsonObject params;
    params.insert(QStringLiteral("name"), name);
    params.insert(QStringLiteral("arguments"), args);
    QJsonObject rpc;
    rpc.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    rpc.insert(QStringLiteral("id"), 1);
    rpc.insert(QStringLiteral("method"), QStringLiteral("tools/call"));
    rpc.insert(QStringLiteral("params"), params);

    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(QStringLiteral("http://127.0.0.1:%1/mcp").arg(port)));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());
    QNetworkReply *reply = nam.post(rq, QJsonDocument(rpc).toJson(QJsonDocument::Compact));
    QEventLoop loop;
    // The *_and_wait phone tools (call_user_and_wait, twilio_call_and_wait,
    // notify_user_and_wait, wait_for_message_reply, …) BLOCK until the user answers
    // — that can take minutes. A 35s cap timed those out ("phone server: timeout");
    // give the proxy 5 minutes so a real call/wait can complete.
    QTimer::singleShot(300000, &loop, &QEventLoop::quit);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    if (!reply->isFinished() || reply->error() != QNetworkReply::NoError) {
        const QString e = reply->isFinished() ? reply->errorString()
                                              : QStringLiteral("timeout");
        reply->deleteLater();
        return Response::failure(req.id, QStringLiteral("phone_unreachable"),
                                 QStringLiteral("phone server: ") + e);
    }
    const QByteArray body = reply->readAll();
    reply->deleteLater();
    const QJsonObject obj = QJsonDocument::fromJson(body).object();
    const QJsonObject mcpResult = obj.value(QStringLiteral("result")).toObject();

    // Unwrap the MCP text content and, when it parses as JSON, hand back structured
    // data so QML / Compose / JS can bind to it directly.
    QString text;
    const QJsonArray content = mcpResult.value(QStringLiteral("content")).toArray();
    if (!content.isEmpty())
        text = content.first().toObject().value(QStringLiteral("text")).toString();
    QJsonObject out;
    out.insert(QStringLiteral("tool"), name);
    if (!text.isEmpty()) {
        const QJsonDocument td = QJsonDocument::fromJson(text.toUtf8());
        if (td.isObject())
            out.insert(QStringLiteral("data"), td.object());
        else if (td.isArray())
            out.insert(QStringLiteral("data"), td.array());
        else
            out.insert(QStringLiteral("text"), text);
    }
    if (obj.contains(QStringLiteral("error")))
        out.insert(QStringLiteral("error"), obj.value(QStringLiteral("error")));
    return Response::success(req.id, out);
}

// --- real-time phone events (jarvis#76 item 3) ------------------------------
//
// The phone server's own WebSocket (/ws on :8801) already PUSHES incoming_call
// / call_state / call_message / screening_* to connected extensions — Jarvis's
// surfaces just never listened and polled the REST API instead. The daemon now
// keeps ONE persistent client socket authed as the user extension (100, the
// DEVICE role allows multiple sockets so the real phone app is never evicted)
// and fans the events out: control clients that sent phone.event.subscribe get
// {"event":"phone.event","data":<raw phone frame>}; paired phones get the same
// via the device channel signal.

void ControlServer::connectPhoneWs()
{
    // Read fresh each (re)connect — phone.env can be (re)written after daemon
    // start by the setup wizard.
    const PhoneEnv penv = readPhoneEnv();
    const QString deviceTok = penv.deviceToken;
    const QString port = penv.port;
    if (deviceTok.isEmpty()) {
        // Phone subsystem not set up (or env not written yet) — retry later so
        // finishing the setup wizard doesn't require a daemon restart.
        schedulePhoneWsReconnect(60000);
        return;
    }

    if (m_phoneWs) {
        m_phoneWs->deleteLater();
        m_phoneWs = nullptr;
    }
    m_phoneWs = new QWebSocket(QString(), QWebSocketProtocol::VersionLatest, this);
    connect(m_phoneWs, &QWebSocket::connected, this, [this, deviceTok]() {
        // First frame MUST be the auth message (AuthEventSchema): the user
        // extension in the device role.
        QJsonObject auth;
        auth.insert(QStringLiteral("type"), QStringLiteral("auth"));
        auth.insert(QStringLiteral("token"), deviceTok);
        auth.insert(QStringLiteral("extension"), QStringLiteral("100"));
        auth.insert(QStringLiteral("clientType"), QStringLiteral("device"));
        auth.insert(QStringLiteral("name"), QStringLiteral("jarvisd event bridge"));
        m_phoneWs->sendTextMessage(QString::fromUtf8(
            QJsonDocument(auth).toJson(QJsonDocument::Compact)));
        qInfo("jarvisd: phone event bridge connected (ext 100)");
    });
    connect(m_phoneWs, &QWebSocket::textMessageReceived,
            this, &ControlServer::onPhoneWsMessage);
    connect(m_phoneWs, &QWebSocket::disconnected, this, [this]() {
        schedulePhoneWsReconnect(5000);
    });
    // disconnected() only fires when LEAVING ConnectedState — a refused/failed
    // CONNECT emits errorOccurred instead. Without this, a daemon that boots
    // before the phone server never retries and the event bridge stays dead.
    connect(m_phoneWs, &QWebSocket::errorOccurred, this,
            [this](QAbstractSocket::SocketError) {
                schedulePhoneWsReconnect(5000);
            });
    m_phoneWs->open(QUrl(QStringLiteral("ws://127.0.0.1:%1/ws").arg(port)));
}

void ControlServer::schedulePhoneWsReconnect(int delayMs)
{
    if (m_phoneWsReconnectPending)
        return;
    m_phoneWsReconnectPending = true;
    QTimer::singleShot(delayMs, this, [this]() {
        m_phoneWsReconnectPending = false;
        connectPhoneWs();
    });
}

// phone.config{action:"get"|"set"|"test"} — read/write the Jarvis-managed phone
// server config (~/.config/jarvis/phone.env: Twilio credentials, server tokens,
// port). Control (loopback) channel ONLY — it is deliberately absent from
// isConfigMethod() so it never reaches the phone/device channel, since it writes
// live secrets. Secrets are never echoed back on "get" (only has_* booleans).
Response ControlServer::handlePhoneConfig(const Request &req)
{
    const QString action = req.params.value(QStringLiteral("action")).toString(QStringLiteral("get"));
    const PhoneEnv penv = readPhoneEnv();

    if (action == QStringLiteral("get")) {
        QJsonObject tw;
        tw.insert(QStringLiteral("has_account_sid"), !penv.twilioAccountSid.isEmpty());
        tw.insert(QStringLiteral("has_auth_token"), !penv.twilioAuthToken.isEmpty());
        tw.insert(QStringLiteral("from_number"), penv.twilioFromNumber);
        tw.insert(QStringLiteral("public_base_url"), penv.twilioPublicBaseUrl);
        tw.insert(QStringLiteral("inbound_extension"),
                  penv.twilioInboundExtension.isEmpty() ? QStringLiteral("101")
                                                        : penv.twilioInboundExtension);
        tw.insert(QStringLiteral("screening_extension"), penv.twilioScreeningExtension);
        // Matches the phone server's own twilio.enabled gate (config.ts), which
        // requires all FOUR — incl. the public base URL — so the UI's green
        // "configured" can't disagree with what actually enables calls.
        tw.insert(QStringLiteral("configured"),
                  !penv.twilioAccountSid.isEmpty() && !penv.twilioAuthToken.isEmpty()
                      && !penv.twilioFromNumber.isEmpty()
                      && !penv.twilioPublicBaseUrl.isEmpty());
        QJsonObject r;
        r.insert(QStringLiteral("configured"),
                 !penv.adminToken.isEmpty() || !penv.agentToken.isEmpty());
        r.insert(QStringLiteral("server_port"), penv.port);
        r.insert(QStringLiteral("server_url"),
                 penv.publicBaseUrl.isEmpty()
                     ? (QStringLiteral("http://127.0.0.1:") + penv.port)
                     : penv.publicBaseUrl);
        r.insert(QStringLiteral("has_admin_token"), !penv.adminToken.isEmpty());
        r.insert(QStringLiteral("has_device_token"), !penv.deviceToken.isEmpty());
        r.insert(QStringLiteral("has_agent_token"), !penv.agentToken.isEmpty());
        r.insert(QStringLiteral("twilio"), tw);
        return Response::success(req.id, r);
    }

    if (action == QStringLiteral("set")) {
        const QJsonObject patch = req.params.value(QStringLiteral("patch")).toObject();
        // Friendly patch key -> phone.env key. Only keys present in the patch are
        // touched; an empty value clears that key. A get->set round-trip that keeps
        // a masked secret unchanged simply omits it, so secrets aren't wiped.
        static const QVector<QPair<QString, QString>> keymap = {
            {QStringLiteral("server_port"), QStringLiteral("SERVER_PORT")},
            {QStringLiteral("admin_token"), QStringLiteral("ADMIN_TOKEN")},
            {QStringLiteral("device_token"), QStringLiteral("DEVICE_TOKEN")},
            {QStringLiteral("agent_token"), QStringLiteral("AGENT_TOKEN")},
            {QStringLiteral("twilio_account_sid"), QStringLiteral("TWILIO_ACCOUNT_SID")},
            {QStringLiteral("twilio_auth_token"), QStringLiteral("TWILIO_AUTH_TOKEN")},
            {QStringLiteral("twilio_from_number"), QStringLiteral("TWILIO_FROM_NUMBER")},
            {QStringLiteral("twilio_public_base_url"), QStringLiteral("TWILIO_PUBLIC_BASE_URL")},
            {QStringLiteral("twilio_inbound_extension"), QStringLiteral("TWILIO_INBOUND_EXTENSION")},
            {QStringLiteral("twilio_screening_extension"), QStringLiteral("TWILIO_SCREENING_EXTENSION")},
            {QStringLiteral("public_base_url"), QStringLiteral("PUBLIC_BASE_URL")},
        };
        QMap<QString, QString> kv;
        for (const auto &m : keymap) {
            if (!patch.contains(m.first))
                continue;
            const QJsonValue v = patch.value(m.first);
            // Only a string value may reach the writer. toString() coerces a
            // null/number/bool to "" which writePhoneEnvKeys treats as "clear the
            // key" — so a mistyped non-string could silently wipe a saved secret.
            if (!v.isString())
                return Response::failure(req.id, QStringLiteral("bad_request"),
                                         QStringLiteral("value for ") + m.first
                                             + QStringLiteral(" must be a string"));
            kv.insert(m.second, v.toString().trimmed());
        }
        if (kv.isEmpty())
            return Response::failure(req.id, QStringLiteral("bad_request"),
                                     QStringLiteral("patch has no recognized phone config keys"));
        QString err;
        if (!writePhoneEnvKeys(kv, &err))
            return Response::failure(req.id, QStringLiteral("write_error"),
                                     QStringLiteral("cannot write phone.env: ") + err);
        m_audit.record(QStringLiteral("phone.config"), true, QStringLiteral("high"),
                       QStringLiteral("updated %1 phone config key(s)").arg(kv.size()),
                       QString());
        const bool restarted = restartPhoneService();
        QJsonObject r;
        r.insert(QStringLiteral("ok"), true);
        r.insert(QStringLiteral("restarted"), restarted);
        r.insert(QStringLiteral("note"),
                 restarted ? QStringLiteral("phone.env updated; phone server restart requested")
                           : QStringLiteral("phone.env updated; restart the phone server to apply"));
        return Response::success(req.id, r);
    }

    if (action == QStringLiteral("test")) {
        if (penv.adminToken.isEmpty() && penv.deviceToken.isEmpty()
            && penv.agentToken.isEmpty())
            return Response::failure(req.id, QStringLiteral("phone_not_configured"),
                                     QStringLiteral("no phone.env tokens set yet"));
        // Real connectivity check: read the voice catalog (a lightweight GET any
        // valid token can reach). Reuse handlePhoneHttp so the bearer stays here.
        Request probe;
        probe.id = req.id;
        probe.method = QStringLiteral("phone.http");
        QJsonObject pp;
        pp.insert(QStringLiteral("method"), QStringLiteral("GET"));
        pp.insert(QStringLiteral("path"), QStringLiteral("/api/voices"));
        probe.params = pp;
        const Response hr = handlePhoneHttp(probe);
        // handlePhoneHttp reports ok even for a non-2xx HTTP status (it returns
        // the body + status), so a 401/403 from a wrong/stale bearer would read
        // as "reachable". Gate on the real HTTP status: only 2xx/3xx is healthy;
        // surface auth_failed distinctly so the UI can say "token rejected".
        const int status = hr.result.value(QStringLiteral("status")).toInt();
        {
            QJsonObject r;
            r.insert(QStringLiteral("reachable"), hr.ok && status >= 200 && status < 400);
            r.insert(QStringLiteral("http_status"), status);
            r.insert(QStringLiteral("auth_failed"), status == 401 || status == 403);
            r.insert(QStringLiteral("twilio_configured"),
                     !penv.twilioAccountSid.isEmpty() && !penv.twilioAuthToken.isEmpty()
                         && !penv.twilioFromNumber.isEmpty()
                         && !penv.twilioPublicBaseUrl.isEmpty());
            return Response::success(req.id, r);
        }
    }

    return Response::failure(req.id, QStringLiteral("bad_request"),
                             QStringLiteral("action must be get|set|test"));
}

// --- Phone Permissions (PhonePolicyStore) -----------------------------------

Response ControlServer::handlePhonePolicyList(const Request &req)
{
    m_phonePolicies.load();
    return Response::success(req.id, m_phonePolicies.toJson());
}

Response ControlServer::handlePhonePolicySet(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const QString value = req.params.value(QStringLiteral("value")).toString();
    m_phonePolicies.load();
    if (!m_phonePolicies.setValue(id, value))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 m_phonePolicies.lastError());
    m_audit.record(QStringLiteral("phone.policy.set"), true, QStringLiteral("high"),
                   QStringLiteral("set %1=%2").arg(id, value), QString());
    // answer_calls is HARD-enforced by driving the phone server's OWN screening
    // config (the daemon can't edit the vendored server, but it CAN flip its
    // runtime settings via the proxy): 'screen_unknown' => screening ON (unknown
    // callers screened, allow-listed answered directly); 'allowed_only' =>
    // screening OFF (unknown callers rejected; only the allowlist connects).
    // Best-effort through phone.mcp (twilio_screening_* is ungated, never denied).
    if (id == QStringLiteral("answer_calls")) {
        const QString tool = (value == QStringLiteral("screen_unknown"))
            ? QStringLiteral("twilio_screening_enable")
            : QStringLiteral("twilio_screening_disable");
        Request p;
        p.id = 0;
        p.method = QStringLiteral("phone.mcp");
        QJsonObject pp;
        pp.insert(QStringLiteral("name"), tool);
        pp.insert(QStringLiteral("arguments"), QJsonObject());
        p.params = pp;
        if (!handlePhoneMcp(p).ok)
            qWarning("jarvisd: phone.policy answer_calls could not update screening (%s)",
                     qUtf8Printable(tool));
    }
    return Response::success(req.id, m_phonePolicies.toJson());
}

Response ControlServer::handlePhonePolicyReset(const Request &req)
{
    m_phonePolicies.load();
    if (!m_phonePolicies.reset())
        return Response::failure(req.id, QStringLiteral("write_error"),
                                 m_phonePolicies.lastError());
    m_audit.record(QStringLiteral("phone.policy.reset"), true, QStringLiteral("high"),
                   QStringLiteral("reset phone permissions to defaults"), QString());
    return Response::success(req.id, m_phonePolicies.toJson());
}

Response ControlServer::handlePhonePolicyTest(const Request &req)
{
    m_phonePolicies.load();
    const QString tool = req.params.value(QStringLiteral("tool")).toString();
    QJsonObject r;
    r.insert(QStringLiteral("tool"), tool);
    QJsonArray caps;
    for (const QString &c : PhonePolicyStore::capabilitiesForTool(tool))
        caps.append(c);
    r.insert(QStringLiteral("capabilities"), caps);
    r.insert(QStringLiteral("decision"), m_phonePolicies.decisionForTool(tool));
    return Response::success(req.id, r);
}

// --- Twilio Verified Caller ID automation -----------------------------------

namespace {
// One Twilio REST helper for the verify handlers. HTTP Basic-auths with the
// account SID + auth token (from phone.env) and returns the parsed JSON body.
// `form` empty => GET; non-empty + method POST => form-encoded body. Sets
// *httpStatus to the real HTTP code and *err to Twilio's {message} on failure.
// 30s cap so a hung endpoint can't pin the daemon's single event loop open.
QJsonObject twilioApiRequest(const QString &sid, const QString &authToken,
                             const QString &method, const QString &path,
                             const QUrlQuery &form, int *httpStatus, QString *err)
{
    QNetworkAccessManager nam;
    QUrl url(QStringLiteral("https://api.twilio.com") + path);
    if (method != QStringLiteral("POST") && !form.isEmpty())
        url.setQuery(form);
    QNetworkRequest rq(url);
    const QByteArray basic =
        QByteArray(sid.toUtf8() + ":" + authToken.toUtf8()).toBase64();
    rq.setRawHeader("Authorization", QByteArray("Basic ") + basic);
    QNetworkReply *reply = nullptr;
    if (method == QStringLiteral("POST")) {
        rq.setHeader(QNetworkRequest::ContentTypeHeader,
                     QStringLiteral("application/x-www-form-urlencoded"));
        reply = nam.post(rq, form.toString(QUrl::FullyEncoded).toUtf8());
    } else {
        reply = nam.get(rq);
    }
    QEventLoop loop;
    QTimer::singleShot(30000, &loop, &QEventLoop::quit);
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    QJsonObject out;
    if (!reply->isFinished()) {
        if (err) *err = QStringLiteral("timeout");
        if (httpStatus) *httpStatus = 0;
        reply->deleteLater();
        return out;
    }
    if (httpStatus)
        *httpStatus =
            reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray body = reply->readAll();
    const QNetworkReply::NetworkError netErr = reply->error();
    reply->deleteLater();
    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (doc.isObject())
        out = doc.object();
    if (netErr != QNetworkReply::NoError && err)
        *err = out.value(QStringLiteral("message"))
                   .toString(QStringLiteral("Twilio HTTP error"));
    return out;
}
} // namespace

Response ControlServer::handleTwilioVerifyStart(const Request &req)
{
    const QString number = req.params.value(QStringLiteral("phone_number")).toString().trimmed();
    const QString friendly = req.params.value(QStringLiteral("friendly_name")).toString().trimmed();
    if (number.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("phone_number is required"));
    const PhoneEnv penv = readPhoneEnv();
    if (penv.twilioAccountSid.isEmpty() || penv.twilioAuthToken.isEmpty())
        return Response::failure(req.id, QStringLiteral("twilio_not_configured"),
                                 QStringLiteral("Twilio Account SID + Auth Token must be set "
                                                "(Phone → Settings) before verifying a number."));
    QUrlQuery form;
    form.addQueryItem(QStringLiteral("PhoneNumber"), number);
    form.addQueryItem(QStringLiteral("FriendlyName"), friendly.isEmpty() ? number : friendly);
    int status = 0;
    QString err;
    const QJsonObject tw = twilioApiRequest(
        penv.twilioAccountSid, penv.twilioAuthToken, QStringLiteral("POST"),
        QStringLiteral("/2010-04-01/Accounts/") + penv.twilioAccountSid
            + QStringLiteral("/OutgoingCallerIds.json"),
        form, &status, &err);
    if (status < 200 || status >= 300) {
        m_audit.record(QStringLiteral("phone.twilio_verify_start"), false, QStringLiteral("high"),
                       QStringLiteral("verify %1 failed: %2").arg(number, err), QString());
        return Response::failure(req.id, QStringLiteral("twilio_error"),
                                 err.isEmpty() ? QStringLiteral("Twilio rejected the request") : err);
    }
    // Twilio is now calling `number`; the person answering reads back this code.
    const QString code = tw.value(QStringLiteral("validation_code")).toString();
    const QString callSid = tw.value(QStringLiteral("call_sid")).toString();
    // Also add it to the app allowlist so Cindro will call/text it once verified.
    {
        Request p;
        p.id = 0;
        p.method = QStringLiteral("phone.mcp");
        QJsonObject args;
        args.insert(QStringLiteral("phone_number"), number);
        if (!friendly.isEmpty())
            args.insert(QStringLiteral("label"), friendly);
        QJsonObject pp;
        pp.insert(QStringLiteral("name"), QStringLiteral("twilio_allowlist_add"));
        pp.insert(QStringLiteral("arguments"), args);
        p.params = pp;
        handlePhoneMcp(p); // best-effort; verification is the primary result
    }
    m_audit.record(QStringLiteral("phone.twilio_verify_start"), true, QStringLiteral("high"),
                   QStringLiteral("started verified-caller-id for ") + number, QString());
    QJsonObject r;
    r.insert(QStringLiteral("ok"), true);
    r.insert(QStringLiteral("phone_number"), number);
    r.insert(QStringLiteral("validation_code"), code);
    r.insert(QStringLiteral("call_sid"), callSid);
    r.insert(QStringLiteral("allowlisted"), true);
    r.insert(QStringLiteral("note"),
             QStringLiteral("Twilio is calling ") + number
                 + QStringLiteral("; enter this code when prompted: ") + code);
    return Response::success(req.id, r);
}

Response ControlServer::handleTwilioCallerIdsList(const Request &req)
{
    const PhoneEnv penv = readPhoneEnv();
    if (penv.twilioAccountSid.isEmpty() || penv.twilioAuthToken.isEmpty())
        return Response::failure(req.id, QStringLiteral("twilio_not_configured"),
                                 QStringLiteral("Twilio Account SID + Auth Token must be set "
                                                "(Phone → Settings)."));
    const QString filter = req.params.value(QStringLiteral("phone_number")).toString().trimmed();
    QUrlQuery q;
    if (!filter.isEmpty())
        q.addQueryItem(QStringLiteral("PhoneNumber"), filter);
    int status = 0;
    QString err;
    const QJsonObject tw = twilioApiRequest(
        penv.twilioAccountSid, penv.twilioAuthToken, QStringLiteral("GET"),
        QStringLiteral("/2010-04-01/Accounts/") + penv.twilioAccountSid
            + QStringLiteral("/OutgoingCallerIds.json"),
        q, &status, &err);
    if (status < 200 || status >= 300)
        return Response::failure(req.id, QStringLiteral("twilio_error"),
                                 err.isEmpty() ? QStringLiteral("Twilio request failed") : err);
    QJsonArray ids;
    for (const QJsonValue &v : tw.value(QStringLiteral("outgoing_caller_ids")).toArray()) {
        const QJsonObject o = v.toObject();
        QJsonObject e;
        e.insert(QStringLiteral("phone_number"), o.value(QStringLiteral("phone_number")).toString());
        e.insert(QStringLiteral("friendly_name"), o.value(QStringLiteral("friendly_name")).toString());
        e.insert(QStringLiteral("sid"), o.value(QStringLiteral("sid")).toString());
        ids.append(e);
    }
    QJsonObject r;
    r.insert(QStringLiteral("caller_ids"), ids);
    if (!filter.isEmpty())
        r.insert(QStringLiteral("verified"), !ids.isEmpty());
    return Response::success(req.id, r);
}

Response ControlServer::handleTwilioVerifyStatus(const Request &req)
{
    // A number is "verified" once it appears in the OutgoingCallerIds list.
    const QString number = req.params.value(QStringLiteral("phone_number")).toString().trimmed();
    if (number.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("phone_number is required"));
    Request q;
    q.id = req.id;
    q.method = QStringLiteral("phone.twilio_caller_ids_list");
    QJsonObject pp;
    pp.insert(QStringLiteral("phone_number"), number);
    q.params = pp;
    const Response lr = handleTwilioCallerIdsList(q);
    if (!lr.ok)
        return lr;
    QJsonObject r;
    r.insert(QStringLiteral("phone_number"), number);
    r.insert(QStringLiteral("verified"),
             !lr.result.value(QStringLiteral("caller_ids")).toArray().isEmpty());
    r.insert(QStringLiteral("caller_ids"), lr.result.value(QStringLiteral("caller_ids")));
    return Response::success(req.id, r);
}

void ControlServer::onPhoneWsMessage(const QString &raw)
{
    const QJsonDocument doc = QJsonDocument::fromJson(raw.toUtf8());
    if (!doc.isObject())
        return;
    const QJsonObject o = doc.object();
    const QString type = o.value(QStringLiteral("type")).toString();
    // Forward only the call/message/screening lifecycle — presence chatter and
    // our own hello/auth acks stay internal.
    static const QSet<QString> kForward = {
        QStringLiteral("incoming_call"),   QStringLiteral("call_state"),
        QStringLiteral("call_message"),    QStringLiteral("call_accept"),
        QStringLiteral("call_reject"),     QStringLiteral("call_end"),
        QStringLiteral("call_timeout"),    QStringLiteral("call_failed"),
        QStringLiteral("missed_call"),     QStringLiteral("dial_result"),
        QStringLiteral("screening_started"), QStringLiteral("screening_update"),
        QStringLiteral("screening_ended"),
    };
    if (!kForward.contains(type))
        return;
    broadcastPhoneEvent(o);
    emit phoneEvent(o); // device channel mirror (paired phones)
}

void ControlServer::broadcastPhoneEvent(const QJsonObject &data)
{
    if (m_phoneEventClients.isEmpty())
        return;
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("phone.event"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_phoneEventClients))
        client->sendTextMessage(payload);
}

Response ControlServer::handlePhoneEventSubscribe(QWebSocket *client, const Request &req)
{
    // Opt-in like widget.subscribe so clients that never asked (background
    // scripts, one-shot tools) aren't flooded with call frames.
    const bool on = req.params.value(QStringLiteral("on")).toBool(true);
    if (on)
        m_phoneEventClients.insert(client);
    else
        m_phoneEventClients.remove(client);
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("subscribed"), on);
    result.insert(QStringLiteral("bridge_connected"),
                  m_phoneWs && m_phoneWs->state() == QAbstractSocket::ConnectedState);
    return Response::success(req.id, result);
}

Response ControlServer::handlePhoneHttp(const Request &req)
{
    const QString method = req.params.value(QStringLiteral("method")).toString(QStringLiteral("GET")).toUpper();
    const QString path = req.params.value(QStringLiteral("path")).toString();
    if (path.isEmpty() || !path.startsWith(QLatin1Char('/')))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("path (e.g. /api/...) is required"));
    const QJsonObject body = req.params.value(QStringLiteral("body")).toObject();

    // Prefer admin > device > agent so the FULL REST surface is reachable —
    // the config setters (PUT /voice, /model; POST /screening, /sms-agent)
    // require device auth, and enroll requires admin; reads accept any.
    const PhoneEnv penv = readPhoneEnv();
    const QString port = penv.port;
    const QString token = !penv.adminToken.isEmpty()
        ? penv.adminToken
        : (!penv.deviceToken.isEmpty() ? penv.deviceToken : penv.agentToken);
    if (token.isEmpty())
        return Response::failure(req.id, QStringLiteral("phone_not_configured"),
                                 QStringLiteral("phone subsystem is not set up (no phone.env)"));

    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(QStringLiteral("http://127.0.0.1:%1%2").arg(port, path)));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());
    const QByteArray data = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = nullptr;
    if (method == QStringLiteral("GET"))
        reply = nam.get(rq);
    else if (method == QStringLiteral("DELETE"))
        reply = nam.deleteResource(rq);
    else if (method == QStringLiteral("PUT"))
        reply = nam.put(rq, data);
    else if (method == QStringLiteral("POST"))
        reply = nam.post(rq, data);
    else
        reply = nam.sendCustomRequest(rq, method.toUtf8(), data);

    QEventLoop loop;
    QTimer::singleShot(30000, &loop, &QEventLoop::quit);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    if (!reply->isFinished()) {
        reply->abort();
        reply->deleteLater();
        return Response::failure(req.id, QStringLiteral("phone_unreachable"),
                                 QStringLiteral("phone server: timeout"));
    }
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray respBody = reply->readAll();
    const QNetworkReply::NetworkError nerr = reply->error();
    reply->deleteLater();
    // A non-2xx HTTP status still returns the body (with status) so the UI can show it.
    if (status == 0 && nerr != QNetworkReply::NoError)
        return Response::failure(req.id, QStringLiteral("phone_unreachable"),
                                 QStringLiteral("phone server unreachable"));
    QJsonObject out;
    out.insert(QStringLiteral("status"), status);
    const QJsonDocument d = QJsonDocument::fromJson(respBody);
    if (d.isObject())
        out.insert(QStringLiteral("data"), d.object());
    else if (d.isArray())
        out.insert(QStringLiteral("data"), d.array());
    else if (!respBody.isEmpty())
        out.insert(QStringLiteral("text"), QString::fromUtf8(respBody));
    return Response::success(req.id, out);
}

Response ControlServer::handleModelList(const Request &req)
{
    const QString brain = req.params.value(QStringLiteral("brain")).toString(m_config.defaultBrain);
    // `force`: drop the TTL guard so refreshLiveModelCatalog() treats the cache
    // as stale and kicks a fetch now (e.g. the user just upgraded their CLI and
    // doesn't want to wait out the TTL). Never blocks this response either way
    // — it just changes whether THIS call's refresh fires now or later.
    if (req.params.value(QStringLiteral("force")).toBool(false))
        m_liveModelCache[brain].fetchedAtMs = 0;
    refreshLiveModelCatalog(brain);
    QJsonArray models = mergedModelsForBrain(brain);

    // codex: merge the configured default model from ~/.codex/config.toml.
    if (brain == QStringLiteral("codex")) {
        const QString v = codexConfiguredModel();
        if (!v.isEmpty() && !models.contains(v))
            models.prepend(v);
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
    // V1 TAKE-OVER FALLBACK (Windows without the v2 opt-in): the platform can
    // never provision a nested desktop, so the auto-computer path degrades with
    // EMPTY overrides — which used to leave every plain chat with ZERO
    // computer-use tools (claude's always-on --strict-mcp-config then loads no
    // MCP servers at all). When "Let Jarvis use a computer" is on AND the user
    // hasn't disabled the built-in computer-use server, non-coworker sessions
    // fall back to the GLOBAL :8794 registry engine — the designed v1
    // real-screen contract. Computed once; used by all three brain arms below.
    const bool v1TakeoverFallback = [this]() {
        if (AgentDesktop::nestedDesktopSupported() || !m_settings.letJarvisUseComputer())
            return false;
        if (!m_mcp)
            return false;
        const QVector<McpServerRow> servers = m_mcp->list();
        for (const McpServerRow &s : servers)
            if (s.id == McpRegistry::builtinId())
                return s.enabled; // user disabled it => no injection at all
        return false;
    }();

    if (row.brain == QStringLiteral("codex")) {
        CodexBrain::Options opts;
        opts.cwd = cwdOverride.isEmpty() ? m_config.effectiveCwd() : cwdOverride;
        opts.model = coerceModelForBrain(row.brain, row.model);
        opts.profile = row.profile;
        opts.sandboxMode = CodexBrain::sandboxForProfile(row.profile);
        // RESUME prior context when re-spawning a brain for an EXISTING session
        // (daemon restart / crash / idle-teardown): seed the codex thread id from
        // the persisted row so the first send() resumes the real conversation
        // instead of starting a fresh, memory-less thread. Empty for a brand-new
        // session (no thread yet), so nothing changes there.
        opts.resumeThreadId = row.threadId;
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
        } else if ((row.profile == QStringLiteral("coworker") || v1TakeoverFallback) &&
                   m_mcp) {
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
        opts.codexHome = dataDir()
            + QStringLiteral("/agent/") + row.id
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
        opts.model = coerceModelForBrain(row.brain, row.model);
        opts.profile = row.profile;
        // RESUME prior context when re-spawning a brain for an EXISTING session
        // (daemon restart / crash / idle-teardown): seed the claude session id
        // from the persisted row so the first send() resumes the real
        // conversation. Empty for a brand-new session, so nothing changes there.
        opts.resumeSessionId = row.threadId;
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
        } else if (v1TakeoverFallback) {
            mcpJson = claudeMcpConfigFromRegistry();
            // Same rationale as the nested-agent path above: headless `claude -p`
            // stalls on MCP permission prompts, so the injected computer-use
            // tools must be pre-authorized to be callable at all. Jarvis's own
            // permission policy (ask_user + injection guard) still applies.
            opts.permissionMode = QStringLiteral("bypassPermissions");
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
        // Resolve a key (or pool of keys — jarvis#76 item 5) for the model's
        // provider from secrets.json. Ollama needs none; every other provider
        // family (incl. gemini/xai/deepseek — jarvis#76 item 11) reads its own
        // provider entry.
        const QString provider = ApiBrain::resolveProvider(opts);
        if (provider != QStringLiteral("ollama")) {
            opts.apiKey = m_settings.apiKey(provider);
            opts.apiKeyPool = m_settings.apiKeyPool(provider);
        }
        // Context compression budget + the PreCompact fire point (item 6).
        opts.contextMaxTokens = m_settings.apiContextMaxTokens();
        opts.hooks = &m_hooks;
        opts.sessionId = row.id;
        // FUNCTION-CALLING (computer-use) loop — the OpenAI-compatible providers
        // (openai/mistral/ollama) get the computer-use MCP tools wired the SAME
        // way codex/claude do: a coworker+agent or auto-spawned session drives its
        // OWN nested per-session engine (desk.mcpUrl/bearer, never the user's real
        // screen); a plain coworker session uses the global built-in :8794 engine.
        // Anthropic uses a different tool format and stays chat-only. We detect the
        // nested engine via the live AgentDesktopInfo so this also works on the
        // resume path (where agentMcpOverrides is empty but the desktop is up).
        // Proxmox workload manager: a session fired by the
        // "proxmox-<hostname>" schedule never touches the desktop/coworker
        // engine at all — it drives the co-located proxmox-mcp tool server
        // instead, and gets a generous 429 backoff since it's an unattended
        // agent that must not just die on a transient Mistral rate limit.
        if (row.targetRef.startsWith(QStringLiteral("proxmox-")) &&
            provider != QStringLiteral("anthropic")) {
            opts.mcpEndpoint = McpRegistry::proxmoxAgentEndpoint();
            opts.mcpBearer = McpRegistry::proxmoxAgentBearer();
            opts.maxBackoffRetries = 6;
            opts.backoffBaseMs = 3000;
            opts.backoffMaxMs = 120000;
        } else if (provider != QStringLiteral("anthropic")) {
            const AgentDesktopInfo desk = m_agentDesktops.info(row.id);
            if (desk.up) {
                opts.mcpEndpoint = desk.mcpUrl;
                opts.mcpBearer = desk.bearer;
            } else if (row.profile == QStringLiteral("coworker") ||
                       v1TakeoverFallback) {
                opts.mcpEndpoint = McpRegistry::builtinEndpoint();
                opts.mcpBearer = McpRegistry::computerUseBearer();
            }
        }
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

void ControlServer::sweepStaleSkills()
{
    const int days = m_settings.skillArchiveDays();
    if (days <= 0)
        return; // curation disabled
    const qint64 thresholdMs = qint64(days) * 24 * 60 * 60 * 1000;
    QStringList archived;
    const int n = m_skills.sweepStale(thresholdMs, &archived);
    if (n > 0) {
        qInfo("jarvisd: archived %d stale skill(s): %s (idle > %d days; restore via"
              " skills.unarchive)",
              n, qPrintable(archived.join(QStringLiteral(", "))), days);
        m_audit.record(QStringLiteral("skills.archive"), true, QStringLiteral("low"),
                       QStringLiteral("stale sweep archived: ") + archived.join(QStringLiteral(",")));
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
        return QStringLiteral("You are Cindro, a helpful AI co-worker.");
    QString block = QStringLiteral(
        "You are Cindro, a helpful AI co-worker. You have persistent memory.\n");
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
                                     const QString &agent, const QString &agentPromptOverride,
                                     const QString &scheduleTargetRef)
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
    // NO-CLI FALLBACK: if the brain came from the DEFAULT (the caller didn't ask
    // for a specific one) and it's a CLI brain that isn't installed, first try the
    // OTHER cli brain (so a user who has claude but not codex gets claude, not an
    // immediate api-fallback), THEN fall back to the direct API brain if neither
    // CLI is on PATH. Prefer Mistral when that key is present (CLI-less default).
    // An EXPLICIT brain request is always honored (it surfaces its own error).
    if (effBrain.isEmpty() &&
        (row.brain == QStringLiteral("codex") || row.brain == QStringLiteral("claude")) &&
        QStandardPaths::findExecutable(row.brain).isEmpty()) {
        // Prefer the OTHER installed CLI brain before giving up on a CLI brain.
        const QString altBrain = (row.brain == QStringLiteral("codex"))
                                     ? QStringLiteral("claude")
                                     : QStringLiteral("codex");
        if (!QStandardPaths::findExecutable(altBrain).isEmpty()) {
            qInfo().noquote() << "[brain] default" << row.brain
                              << "CLI not found on PATH; switching to installed" << altBrain;
            row.brain = altBrain;
        } else {
            const bool haveMistral = m_settings.hasApiKey(QStringLiteral("mistral"));
            if (haveMistral || m_settings.hasApiKey(QStringLiteral("openai")) ||
                m_settings.hasApiKey(QStringLiteral("anthropic"))) {
                qInfo().noquote() << "[brain] default" << row.brain
                                  << "CLI not found on PATH; falling back to the api brain";
                row.brain = QStringLiteral("api");
                if (haveMistral && effModel.isEmpty())
                    effModel = QStringLiteral("mistral-large-latest");
            }
            // No api key either: leave the brain as-is. The CLI spawn emits a clear
            // "<brain> failed to start" error, and the UI's available_brains +
            // api_keys_set drive the "add a Mistral key" onboarding prompt.
        }
    }
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
    row.targetRef = scheduleTargetRef;
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
    // The api brain drives via the OpenAI-compatible function-calling loop, which
    // covers the openai/mistral providers (anthropic stays chat-only).
    const bool apiCanDrive = m_settings.hasApiKey(QStringLiteral("openai")) ||
                             m_settings.hasApiKey(QStringLiteral("mistral"));
    const bool brainCanDrive =
        row.brain == QStringLiteral("codex") || row.brain == QStringLiteral("claude") ||
        (row.brain == QStringLiteral("api") && apiCanDrive);
    const bool explicitAgent = isCoworker && effTarget == QStringLiteral("agent");
    // A take-over is ONLY an explicit target="real" request (the caller asked to
    // drive the user's real screen via the global engine). A plain chat passes NO
    // target — its effTarget defaults to "real" but it is NOT a take-over, so it
    // should still auto-provision a nested desktop. Distinguish by the RAW target.
    const bool explicitTakeOver = (target == QStringLiteral("real"));
    // A scheduleTargetRef-routed session (the always-on Proxmox agent today;
    // any future headless/background job routed the same way) is
    // structurally never going to touch a screen — it's an MCP-endpoint
    // override for unattended tool-calling, not an interactive co-work
    // session — so it must never AUTO-provision the expensive nested
    // desktop (~45-60s blocking AgentDesktop::ensure()) just because the
    // user's global "let Jarvis use a computer" toggle happens to be on.
    const bool autoComputer = m_settings.letJarvisUseComputer() &&
                              !explicitTakeOver && !explicitAgent && brainCanDrive &&
                              scheduleTargetRef.isEmpty();

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
                    "an OpenAI or Mistral API key — pick the codex or claude "
                    "brain, or set an API key in Settings");
            return QString();
        }
        QString deskErr;
        const AgentDesktopInfo desk = m_agentDesktops.ensure(row.id, &deskErr);
        if (!desk.up) {
            // Explicit co-work is fatal ONLY when this platform/build can
            // actually provision an isolated desktop (AgentDesktop.h's
            // nestedDesktopSupported()) and ensure() still failed — a REAL
            // failure (crashed process, port conflict, ...). When isolation was
            // never available in the first place (stock Windows without the v2
            // sandbox opt-in — the shipped default), that's not a failure, it's
            // the documented v1 take-over contract: degrade like the AUTO path
            // below so makeBrain()'s existing `row.profile == "coworker"`
            // fallback can inject the GLOBAL :8794 engine instead. Without this
            // gate, EVERY phone-initiated session (the app's default profile is
            // "coworker" with no target override) hard-fails server-side on
            // stock Windows while working fine on Linux (jarvis#107).
            if (explicitAgent && AgentDesktop::nestedDesktopSupported()) {
                m_store.updateState(row.id, QStringLiteral("error"));
                if (err)
                    *err = QStringLiteral("agent desktop failed: ") + deskErr;
                return QString();
            }
            // AUTO path, or an explicit co-work request on a platform that
            // can't isolate at all: degrade gracefully — the chat session still
            // runs (via the global-engine fallback) rather than failing outright.
            qWarning("jarvisd: agent desktop unavailable for %s (%s); session "
                     "continues without an isolated desktop",
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

    // Remember the RESOLVED workdir for this session (diff.* runs git here).
    // Mirrors makeBrain's cwdOverride-else-config-default resolution.
    m_sessionCwd.insert(row.id, cwd.isEmpty() ? m_config.effectiveCwd() : cwd);

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
    // TOP-LEVEL sessions only: a subagent CHILD session is internal — it renders
    // inside its parent chat's sub-agent tree. Fanning children out here raised
    // windows and pushed a "New session" notification to every phone PER dispatched
    // subagent (part of the jarvis#72 "chats keep popping out as subagents" mess).
    if (row.parentSessionId.isEmpty()) {
        broadcastSessionOpened(row.id, row.title);  // control-WS fan-out (desktop)
        emit sessionOpened(row.id, row.title);      // device-WS + FCM fan-out (phone)
    }

    // SessionStart hook — top-level sessions only (a child session = a subagent).
    // Any additionalContext is stashed and prepended to the session's FIRST turn
    // (drained in sendToSession). No-op unless a SessionStart hook is configured.
    if (parentSessionId.isEmpty()) {
        QJsonObject hin;
        hin.insert(QStringLiteral("session_id"), row.id);
        hin.insert(QStringLiteral("source"), QStringLiteral("startup"));
        const HookOutcome ho = m_hooks.run(QStringLiteral("SessionStart"), hin,
                                           QStringLiteral("startup"));
        if (!ho.injectedContext.isEmpty())
            m_hookSessionContext.insert(row.id, ho.injectedContext);
    }
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

    // SubagentStop hook (observational): matchKey = the agent type. No-op unless
    // configured.
    {
        QJsonObject hin;
        hin.insert(QStringLiteral("session_id"), childSid);
        hin.insert(QStringLiteral("parent_session_id"), parentSid);
        hin.insert(QStringLiteral("agent_type"), label);
        hin.insert(QStringLiteral("stop_reason"), state);
        m_hooks.run(QStringLiteral("SubagentStop"), hin, label);
    }

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

    // Tool-loop guardrail state is per-turn: a fresh turn starts a fresh window
    // (cross-turn loops are still caught by the churn counter within each turn).
    m_toolLoop.remove(sessionId);
    m_lastToolCall.remove(sessionId);
    m_toolLoopWarned.remove(sessionId);
    m_toolLoopStopping.remove(sessionId); // the turn ended — disarm the deferred cancel

    // Post-turn self-improvement review (jarvis#76 item 8): a cheap async
    // auxiliary model call decides whether anything from the finished turn is
    // worth persisting to long-term memory. Top-level sessions only (subagent
    // turns are isolated task runs) and strictly opt-in.
    if (auto r = m_store.get(sessionId);
        r && r->parentSessionId.isEmpty()
        && m_settings.selfImprove() == QStringLiteral("on")) {
        firePostTurnReview(sessionId);
    }

    // Persistent-goal auto-continuation (jarvis#76 item 9): while a goal is set
    // and the continuation budget allows, re-wake the session so it keeps
    // working unattended. Deferred one tick so the brain fully settles first.
    if (auto r = m_store.get(sessionId);
        r && r->parentSessionId.isEmpty()
        && m_settings.autoContinue() != QStringLiteral("off")
        && !r->goals.trimmed().isEmpty()
        && r->state != QStringLiteral("error")
        && !m_pendingTurns.contains(sessionId)
        && !m_queueItemBySession.contains(sessionId)) {
        // "capped" bounds an unattended run to 3 continuations per real user
        // turn; "on" keeps a generous safety ceiling so a never-met goal can't
        // loop forever. The count resets on every real session.send.
        const int cap = m_settings.autoContinue() == QStringLiteral("capped") ? 3 : 25;
        if (r->continuationCount < cap) {
            m_store.setContinuationCount(sessionId, r->continuationCount + 1);
            const QString goal = r->goals.trimmed();
            const int n = r->continuationCount + 1;
            m_audit.record(QStringLiteral("session.auto_continue"), true,
                           QStringLiteral("low"),
                           QStringLiteral("continuation %1/%2").arg(n).arg(cap),
                           sessionId);
            QTimer::singleShot(0, this, [this, sessionId, goal, n, cap] {
                if (!m_store.get(sessionId))
                    return;
                QString err;
                sendToSession(sessionId, QStringLiteral(
                    "[AUTO-CONTINUE %1/%2] Your active goal is not marked complete "
                    "yet:\n%3\n\nContinue working toward it now. If the goal IS "
                    "complete, say so and call set_goal with an empty string to "
                    "clear it and stop these continuations.")
                    .arg(n).arg(cap).arg(goal), {}, &err);
            });
        } else {
            qInfo("jarvisd: auto-continue cap reached for session %s (%d)",
                  qPrintable(sessionId), r->continuationCount);
        }
    }

    // Work-queue worker finished its turn (jarvis#76 item 7): resolve the item.
    // A queued pending turn (e.g. a guardrail nudge) keeps the item running —
    // it only resolves when the session truly goes quiet.
    if (m_queueItemBySession.contains(sessionId) &&
        !m_pendingTurns.contains(sessionId)) {
        const QString itemId = m_queueItemBySession.take(sessionId);
        const auto row = m_store.get(sessionId);
        const bool failed = row && row->state == QStringLiteral("error");
        const QString summary = subagentSummary(sessionId);
        m_kanban.updateStatus(itemId,
                              failed ? QStringLiteral("error") : QStringLiteral("done"),
                              sessionId, summary);
        m_notify.taskDone(QStringLiteral("Work item done: ") +
                          (m_kanban.get(itemId) ? m_kanban.get(itemId)->title : itemId));
        qInfo("jarvisd: work item %s finished (%s)", qPrintable(itemId),
              failed ? "error" : "done");
    }

    // Stop hook (observational): the agent finished responding. Fire for the main
    // agent only (a child's completion is a SubagentStop). No-op unless configured.
    if (auto r = m_store.get(sessionId); r && r->parentSessionId.isEmpty()) {
        QJsonObject hin;
        hin.insert(QStringLiteral("session_id"), sessionId);
        m_hooks.run(QStringLiteral("Stop"), hin);
    }

    if (!m_pendingTurns.contains(sessionId))
        return;
    const HeldTurn pending = m_pendingTurns.take(sessionId);
    QString err;
    // Re-enter the normal send path (injection gate + memory prefetch re-applied).
    sendToSession(sessionId, pending.text, pending.images, &err);
}

// Post-turn self-improvement review (jarvis#76 item 8): after a top-level turn
// finishes, a CHEAP async model call (mistral-small, same key generateSessionTitle
// uses) reviews the exchange and — only when there is a genuinely reusable fact
// or lesson — writes ONE concise memory. Never injects into the session, never
// blocks, silently no-ops without a key (matching the title generator).
void ControlServer::firePostTurnReview(const QString &sessionId)
{
    const QString key = m_settings.apiKey(QStringLiteral("mistral"));
    if (key.isEmpty())
        return;

    // Last few turns, clipped: the review only needs the gist.
    QString transcript;
    const auto events = m_store.listEvents(sessionId, 10);
    for (const StoredEvent &se : events) {
        if (se.ev.kind != NormalizedBrainEvent::Kind::Message)
            continue;
        const QString role = se.ev.fields.value(QStringLiteral("role")).toString();
        QString t = se.ev.fields.value(QStringLiteral("text")).toString().simplified();
        // Daemon-injected turns ride the user role on the wire — never let the
        // reviewer mistake them for something the human actually said.
        if (t.startsWith(QStringLiteral("[TOOL LOOP")) ||
            t.startsWith(QStringLiteral("[AUTO-CONTINUE")) ||
            t.startsWith(QStringLiteral("[SUBAGENT DONE")) ||
            t.startsWith(QStringLiteral("[WORK QUEUE")))
            continue;
        if (t.size() > 400)
            t = t.left(400) + QStringLiteral("…");
        transcript += role + QStringLiteral(": ") + t + QLatin1Char('\n');
    }
    if (transcript.trimmed().isEmpty())
        return;

    if (!m_reviewNam)
        m_reviewNam = new QNetworkAccessManager(this);

    QJsonArray msgs;
    QJsonObject sys;
    sys.insert(QStringLiteral("role"), QStringLiteral("system"));
    sys.insert(QStringLiteral("content"), QStringLiteral(
        "You review a finished AI-assistant turn and decide if it produced ONE "
        "durable fact, user preference, or lesson worth saving to long-term "
        "memory (something useful in FUTURE conversations — not task chatter). "
        "Reply with ONLY that concise fact (max 200 chars, no preamble), or the "
        "single word NOTHING."));
    msgs.append(sys);
    QJsonObject usr;
    usr.insert(QStringLiteral("role"), QStringLiteral("user"));
    usr.insert(QStringLiteral("content"), transcript.left(2400));
    msgs.append(usr);

    QJsonObject body;
    body.insert(QStringLiteral("model"), QStringLiteral("mistral-small-latest"));
    body.insert(QStringLiteral("max_tokens"), 96);
    body.insert(QStringLiteral("temperature"), 0.2);
    body.insert(QStringLiteral("messages"), msgs);

    QNetworkRequest rq(QUrl(QStringLiteral("https://api.mistral.ai/v1/chat/completions")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + key.toUtf8());
    QNetworkReply *reply =
        m_reviewNam->post(rq, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, sessionId]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError)
            return;
        const QJsonObject o = QJsonDocument::fromJson(reply->readAll()).object();
        const QJsonArray choices = o.value(QStringLiteral("choices")).toArray();
        if (choices.isEmpty())
            return;
        QString fact = choices.first().toObject()
                           .value(QStringLiteral("message")).toObject()
                           .value(QStringLiteral("content")).toString().trimmed();
        if (fact.isEmpty() || fact.compare(QStringLiteral("NOTHING"), Qt::CaseInsensitive) == 0)
            return;
        if (fact.size() > 240)
            fact = fact.left(240);
        const QString id = m_memory.add(
            fact, {QStringLiteral("auto"), QStringLiteral("review")});
        if (!id.isEmpty()) {
            m_audit.record(QStringLiteral("memory.self_improve"), true,
                           QStringLiteral("low"), fact.left(120), sessionId);
            qInfo("jarvisd: self-improve review saved a memory (%s)", qPrintable(id));
        }
    });
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

    // Claude-Code-style UserPromptSubmit hook — can BLOCK the turn (exit 2 /
    // decision:block) or inject additionalContext. Skipped for subagents (their
    // isolated task is not a user prompt). Also drains any SessionStart context
    // captured at session creation, once, on this first turn.
    QString hookContext;
    if (!isSubagent) {
        QJsonObject hin;
        hin.insert(QStringLiteral("session_id"), sessionId);
        hin.insert(QStringLiteral("user_prompt"), text);
        const HookOutcome ho = m_hooks.run(QStringLiteral("UserPromptSubmit"), hin);
        if (ho.blocked) {
            m_store.updateState(sessionId, QStringLiteral("idle"));
            if (err)
                *err = ho.blockReason.isEmpty()
                           ? QStringLiteral("blocked by a UserPromptSubmit hook")
                           : ho.blockReason;
            return false;
        }
        hookContext = ho.injectedContext;
        if (m_hookSessionContext.contains(sessionId)) {
            const QString sc = m_hookSessionContext.take(sessionId);
            if (!sc.isEmpty())
                hookContext = sc + (hookContext.isEmpty() ? QString()
                                                          : QStringLiteral("\n")) + hookContext;
        }
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
        // Active-goal reminder (jarvis#76 item 9): a session with a persistent
        // goal always sees it, so multi-turn work stays on target. Auto-continue
        // wakes carry the goal themselves; this covers manual turns too.
        // NOTE: the real wake text is "[AUTO-CONTINUE n/cap] ..." — match the
        // OPEN prefix, not a closed "[AUTO-CONTINUE]" literal that never hits.
        if (auto gr = m_store.get(sessionId); gr && !gr->goals.trimmed().isEmpty()
            && !text.startsWith(QStringLiteral("[AUTO-CONTINUE"))) {
            effectiveText = QStringLiteral("[ACTIVE GOAL] ") + gr->goals.trimmed() +
                            QStringLiteral("\n---\n") + effectiveText;
        }
    }
    // Hook-injected context (UserPromptSubmit + SessionStart additionalContext)
    // rides at the very front so the model sees it as a system reminder.
    if (!hookContext.isEmpty())
        effectiveText = QStringLiteral("[HOOK CONTEXT]\n") + hookContext +
                        QStringLiteral("\n---\n") + effectiveText;

    // ONE-TIME policy preamble: the permission_level + agent_mode + trust-policy
    // clauses must reach the model on turn 1 of EVERY non-subagent session —
    // independent of whether an agent desktop is provisioned (the screen-targeting
    // co-work guide below stays gated on that). Fires once per session.
    QString policyPreamble;
    if (!isSubagent && !m_policyGuided.contains(sessionId)) {
        m_policyGuided.insert(sessionId);
        // Trust policies (jarvis#71): tell the model the enforced rules up
        // front so it plans around them instead of discovering them by being
        // blocked at the tool layer. Reload first — the file is edited live
        // from Settings on any surface.
        m_trustPolicies.load();
        policyPreamble = permissionPolicyClause() + modePolicyClause() +
                         m_trustPolicies.preambleClause();
    }

    // ONE-TIME co-work guidance: the first turn a session has computer-use, teach
    // the model the screen-targeting contract + the ASK-WHEN-AMBIGUOUS rule the
    // user asked for. Every computer-use tool takes a `which` arg: "agent" = the
    // model's own private nested desktop (default, watched on the Computer page);
    // "real" = the user's REAL screen (glowing banner shows). If the user doesn't
    // say whose screen, the model MUST ask_user first.
    QString guide;
    if (!isSubagent && m_agentDesktops.has(sessionId) && !m_coworkGuided.contains(sessionId)) {
        m_coworkGuided.insert(sessionId);
        // MSVC's classic preprocessor chokes on a bare #ifdef mid-argument-list
        // inside a macro call ("C2121: '#': invalid character") — hoist the
        // per-OS live-CPU example out to its own macro so QStringLiteral(...)
        // below only ever sees a plain token, never a directive.
#ifdef Q_OS_WIN
#define JARVIS_LIVE_CPU_CMD_EXAMPLE \
    "\"powershell -NoProfile -Command \\\"(Get-Counter " \
    "'\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue\\\"\", "
#else
#define JARVIS_LIVE_CPU_CMD_EXAMPLE \
    "\"top -bn1 | awk '/Cpu/{print 100-$8}'\", "
#endif
        guide = QStringLiteral(
            "[Cindro co-work — READ FIRST] You have TWO separate computer-use tool "
            "sets, plus ask_user, schedule_task, remember/recall/forget, create_skill.\n"
            "  * The \"real_screen\" tools operate the USER'S REAL screen + windows "
            "(what they physically see). A glowing \"Cindro is using this computer\" "
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
            "save it as a Cindro skill — but you MUST use the create_skill MCP TOOL "
            "(NOT your own CLI's skill files / not by writing to ~/.codex/skills or "
            "~/.claude/skills yourself). Only create_skill registers it in Cindro so it "
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
            "DON'T over-delegate: if the task is one direct tool call away — run a "
            "command on a paired machine, save/look up a memory fact, check a schedule — "
            "just call that tool yourself instead of spawning a subagent for it. Reserve "
            "agent_start for genuinely separable work: parallel, repeatable, or long "
            "enough to not want to block your own turn on it.\n"
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
            "interval. e.g. live CPU: command "
            JARVIS_LIVE_CPU_CMD_EXAMPLE
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
            "actually CALL render_widget — don't describe the widget in words.\n"
            "\n[YOUR NEWER POWERS]\n"
            "• PHONE — you can reach the user on their REAL phone: call_user / "
            "call_user_and_wait (in-app, can escalate to a real call), notify_user / "
            "notify_user_and_wait (text the user, optionally awaiting a reply), "
            "twilio_call_and_wait + twilio_sms + device_sms (real PSTN call / SMS), "
            "request_approval_by_phone, send_call_receipt, plus screening / war-room "
            "(red_alert) / voice-profile tools. Use a VOICE CALL only for: an approval "
            "of a risky action, a blocking incident, the user explicitly asked, or a "
            "text fallback already failed — otherwise default to notify_user for "
            "status. Check list_extensions presence before calling.\n"
            "• BACKGROUND JOBS — bg_start(command) runs long work DETACHED and WAKES "
            "you with the exit code + output when it finishes (use it for training, "
            "builds, deploys, downloads instead of blocking). monitor(command, "
            "until_regex/until_exit) polls a condition and wakes you when it trips. "
            "wake_me_in(seconds, note) sleeps then wakes you. bg_status / bg_logs / "
            "bg_stop / bg_list manage them. Don't sit idle on a slow command — "
            "background it and you'll be pinged.\n"
            "• HOOKS — hooks_list / hooks_add / hooks_remove / hooks_test configure "
            "shell hooks that fire on your lifecycle events (Claude-Code style).\n"
            "• MODES — the user selects plan / build / co-worker in Settings; follow "
            "the mode clause appended below.");
#undef JARVIS_LIVE_CPU_CMD_EXAMPLE
    }

    // Prepend whatever fired this turn. When BOTH fire (an agent-desktop session's
    // turn 1) the assembly is identical to before: guide + permission + mode +
    // trust-policy clauses + separator + the rest.
    if (!guide.isEmpty() || !policyPreamble.isEmpty())
        effectiveText = guide + policyPreamble +
                        QStringLiteral("\n---\n") + effectiveText;

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
    m_toolLoop.remove(sessionId);
    m_lastToolCall.remove(sessionId);
    m_toolLoopWarned.remove(sessionId);
    m_toolLoopStopping.remove(sessionId);
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
    // Drop any pending take-over/injection approvals for this (now-gone) session.
    for (auto it = m_pendingApprovals.begin(); it != m_pendingApprovals.end();) {
        if (it->sessionId == sessionId)
            it = m_pendingApprovals.erase(it);
        else
            ++it;
    }
    // 3) Tear down the nested agent desktop (compositor + per-session engine) and
    //    drop its port/bearer reservation — the session is gone for good.
    m_agentDesktops.releaseSession(sessionId);
    m_autoComputerSessions.remove(sessionId);
    m_deskLastActive.remove(sessionId);
    m_coworkGuided.remove(sessionId);
    m_policyGuided.remove(sessionId);
    m_sessionAgentPrompt.remove(sessionId);
    m_agentGuided.remove(sessionId);
    m_subagentPendingWake.remove(sessionId);   // as a child awaiting parent-wake
    m_sessionCwd.remove(sessionId);
    m_toolLoop.remove(sessionId);
    m_lastToolCall.remove(sessionId);
    m_toolLoopWarned.remove(sessionId);
    m_toolLoopStopping.remove(sessionId);
    m_pendingTurns.remove(sessionId);
    // 4) Drop the row + its event stream from the store.
    if (!m_store.deleteSession(sessionId)) {
        if (err)
            *err = m_store.lastError();
        return false;
    }
    return true;
}

// A random, unguessable approval id (kind prefix kept as a routing hint only —
// the pending-approval registry, not the prefix, is what authorizes the action).
static QString genApprovalId(const QString &kind)
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(16, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return kind + QLatin1Char('-') + QString::fromLatin1(bytes.toHex());
}

bool ControlServer::respondApprovalFor(const QString &sessionId, const QString &approvalId,
                                       const QString &decision, QString *err)
{
    // Daemon-side gated approvals (real-screen take-over + injection gate) are
    // authorized ONLY through the pending-approval registry: the approval id must
    // be actually pending for THIS exact session (defeats a forged / enumerated
    // "takeover-<sid>"/"inject-<sid>"). Brain-issued tool approvals use ids that
    // are never in the registry, so they fall through to the brain below.
    const bool daemonKind = approvalId.startsWith(QStringLiteral("takeover-")) ||
                            approvalId.startsWith(QStringLiteral("inject-"));
    if (daemonKind) {
        auto it = m_pendingApprovals.find(approvalId);
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        const bool expired = (it != m_pendingApprovals.end()) &&
                             it->expiresAt != 0 && now > it->expiresAt;
        if (it == m_pendingApprovals.end() || it->sessionId != sessionId || expired) {
            if (expired)
                m_pendingApprovals.erase(it); // reap the stale entry
            if (err)
                *err = QStringLiteral("no pending approval matches this id/session");
            return false;
        }
        const PendingApproval pa = it.value();
        m_pendingApprovals.erase(it); // single-use
        const bool allow = (decision == QStringLiteral("allow") ||
                            decision == QStringLiteral("always"));

        // A take-over approval is daemon-side (no brain involvement): allow/always
        // flips the real-session take-over ON (overlay shown), deny clears it.
        if (pa.kind == QStringLiteral("takeover")) {
            setTakeOverActive(sessionId, allow);
            return true;
        }

        // An injection-gate approval (BUILD_SPEC prompt-injection gating): the user
        // confirmed the held turn is safe. allow/always resumes the held turn
        // (bypassing the gate this time); deny drops it. Daemon-side, no brain call.
        const HeldTurn held = m_injectionHeld.take(sessionId);
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
    const QString dir = dataDir()
        + QStringLiteral("/attachments/") + sessionId;
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

    // A REAL user turn re-arms the auto-continuation budget (jarvis#76 item 9):
    // the cap bounds unattended runs, not conversations the user is driving.
    if (auto r = m_store.get(sessionId); r && r->continuationCount > 0)
        m_store.setContinuationCount(sessionId, 0);

    QString err;
    if (!sendToSession(sessionId, text, images, &err))
        return Response::failure(req.id, QStringLiteral("no_session"), err);

    QJsonObject result;
    result.insert(QStringLiteral("accepted"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleSessionSetGoals(const Request &req)
{
    const QString sessionId = req.params.value(QStringLiteral("session_id")).toString();
    const QString goals = req.params.value(QStringLiteral("goals")).toString();
    if (sessionId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("session_id is required"));
    if (!m_store.setGoals(sessionId, goals))
        return Response::failure(req.id, QStringLiteral("no_session"),
                                 QStringLiteral("unknown session: ") + sessionId);
    // A (re)set goal starts a fresh continuation budget.
    m_store.setContinuationCount(sessionId, 0);
    m_audit.record(QStringLiteral("session.set_goals"), true, QStringLiteral("low"),
                   goals.isEmpty() ? QStringLiteral("goal cleared")
                                   : QStringLiteral("goal: ") + goals.left(120),
                   sessionId);
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("goals"), goals);
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

// Cross-session full-text search (jarvis#76 item 1): ranked hits over every
// stored turn + tool output, each with a small context window. Also proxied to
// the model as the session_search MCP tool and to the phone (read tier) — the
// device channel serializes through THIS helper so the two wire shapes can
// never drift.
QJsonArray ControlServer::searchHitsToJson(const QVector<SessionSearchHit> &hits)
{
    QJsonArray arr;
    for (const SessionSearchHit &h : hits) {
        QJsonObject o;
        o.insert(QStringLiteral("session_id"), h.sessionId);
        o.insert(QStringLiteral("session_title"), h.sessionTitle);
        o.insert(QStringLiteral("seq"), h.seq);
        o.insert(QStringLiteral("ts"), h.ts);
        o.insert(QStringLiteral("score"), h.score);
        o.insert(QStringLiteral("ev"), h.ev.toJson());
        QJsonArray ctx;
        for (const StoredEvent &se : h.context) {
            QJsonObject c;
            c.insert(QStringLiteral("seq"), se.seq);
            c.insert(QStringLiteral("ts"), se.ts);
            c.insert(QStringLiteral("ev"), se.ev.toJson());
            ctx.append(c);
        }
        o.insert(QStringLiteral("context"), ctx);
        arr.append(o);
    }
    return arr;
}

Response ControlServer::handleSessionSearch(const Request &req)
{
    const QString q = req.params.value(QStringLiteral("q")).toString();
    if (q.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("q is required"));
    const int limit = req.params.value(QStringLiteral("limit")).toInt(20);
    const int ctxWin = req.params.value(QStringLiteral("context_window")).toInt(2);
    const QString sessionFilter =
        req.params.value(QStringLiteral("session_id")).toString();
    QJsonObject result;
    result.insert(QStringLiteral("hits"),
                  searchHitsToJson(m_store.searchEvents(q, limit, ctxWin, sessionFilter)));
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

    // Supply-chain gate (jarvis#76 item 12): an npx/uvx stdio server is a
    // package INSTALL the codex CLI will execute on the next brain launch —
    // this add is the only enforcement window. Query OSV for MAL-* advisories;
    // a hit returns needs_approval (plugins.install contract) unless the caller
    // explicitly re-sent with approve:true. Offline/timeout FAILS OPEN.
    if (transport == QStringLiteral("stdio")) {
        if (const auto pkg = OsvAdvisory::parseStdioEndpoint(endpoint)) {
            const OsvAdvisory::Result osv = OsvAdvisory::check(*pkg);
            if (osv.ok && osv.hasMalware) {
                if (!p.value(QStringLiteral("approve")).toBool()) {
                    m_audit.record(QStringLiteral("mcp.add"), false,
                                   QStringLiteral("high"),
                                   QStringLiteral("OSV malware advisory on %1: %2")
                                       .arg(pkg->name,
                                            osv.advisoryIds.join(QStringLiteral(","))));
                    QJsonObject r;
                    r.insert(QStringLiteral("ok"), false);
                    r.insert(QStringLiteral("needs_approval"), true);
                    r.insert(QStringLiteral("approval_tier"), QStringLiteral("biometric"));
                    r.insert(QStringLiteral("reason"),
                             QStringLiteral("OSV malware advisory: ")
                                 + osv.advisoryIds.join(QStringLiteral(", "))
                                 + (osv.summary.isEmpty()
                                        ? QString()
                                        : QStringLiteral(" — ") + osv.summary));
                    r.insert(QStringLiteral("advisory_ids"),
                             QJsonArray::fromStringList(osv.advisoryIds));
                    r.insert(QStringLiteral("package"), pkg->name);
                    return Response::success(req.id, r);
                }
                m_audit.record(QStringLiteral("mcp.add"), true, QStringLiteral("high"),
                               QStringLiteral("user approved DESPITE OSV advisory: ")
                                   + pkg->name);
            } else if (!osv.ok) {
                m_audit.record(QStringLiteral("mcp.add"), true, QStringLiteral("low"),
                               QStringLiteral("osv-check skipped (offline): ")
                                   + pkg->name);
            }
        }
    }

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

// --- "Connect Google" OAuth (loopback authorization-code flow + PKCE) -------
namespace {
QString b64url(const QByteArray &b)
{
    return QString::fromLatin1(
        b.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}
QString randToken(int nbytes)
{
    QByteArray b(nbytes, Qt::Uninitialized);
    for (int i = 0; i < nbytes; ++i)
        b[i] = char(QRandomGenerator::system()->bounded(256));
    return b64url(b);
}
const QLatin1String kGoogleClientIdKey("google_oauth:client_id");
const QLatin1String kGoogleClientSecretKey("google_oauth:client_secret");
} // namespace

Response ControlServer::handleConnectorsSetClient(const Request &req)
{
    const QString clientId = req.params.value(QStringLiteral("client_id")).toString().trimmed();
    const QString clientSecret =
        req.params.value(QStringLiteral("client_secret")).toString().trimmed();
    if (clientId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("client_id is required"));
    m_settings.setApiKey(QString(kGoogleClientIdKey), clientId);
    if (!clientSecret.isEmpty())
        m_settings.setApiKey(QString(kGoogleClientSecretKey), clientSecret);
    m_settings.saveSecrets();
    QJsonObject r;
    r.insert(QStringLiteral("ok"), true);
    r.insert(QStringLiteral("has_client_id"), true);
    r.insert(QStringLiteral("has_client_secret"),
             m_settings.hasApiKey(QString(kGoogleClientSecretKey)));
    return Response::success(req.id, r);
}

Response ControlServer::handleConnectorsOAuthStart(const Request &req)
{
    const QString service = req.params.value(QStringLiteral("service")).toString();
    if (!Connectors::isKnownService(service))
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("unknown Google connector service: ") + service);
    const QString clientId = m_settings.apiKey(QString(kGoogleClientIdKey));
    const QString clientSecret = m_settings.apiKey(QString(kGoogleClientSecretKey));
    if (clientId.isEmpty() || clientSecret.isEmpty())
        return Response::failure(
            req.id, QStringLiteral("no_client"),
            QStringLiteral("set your Google OAuth client first (connectors.set_client)"));

    // One flow at a time; tear down any stale listener first.
    if (m_oauth) {
        if (m_oauth->server) m_oauth->server->deleteLater();
        delete m_oauth;
        m_oauth = nullptr;
    }
    auto *server = new QTcpServer(this);
    if (!server->listen(QHostAddress::LocalHost, 0)) {
        server->deleteLater();
        return Response::failure(
            req.id, QStringLiteral("listen_failed"),
            QStringLiteral("could not open a loopback port for the OAuth redirect"));
    }
    const quint16 port = server->serverPort();
    m_oauth = new PendingOAuth{service, randToken(16), randToken(48),
                               QStringLiteral("http://127.0.0.1:") + QString::number(port),
                               clientId, clientSecret, server};
    m_oauth->id = ++m_oauthSeq;
    const quint64 flowId = m_oauth->id;
    connect(server, &QTcpServer::newConnection, this, &ControlServer::onOAuthRedirect);
    // 5-min wall so an abandoned consent never leaks the listener. Guard on the
    // flow GENERATION (not the server pointer, which can be reused at the same
    // address after a deleteLater) so a stale timer never aborts a newer flow.
    QTimer::singleShot(5 * 60 * 1000, this, [this, flowId]() {
        if (m_oauth && m_oauth->id == flowId)
            finishOAuth(false, QStringLiteral("timed out"), QString());
    });

    const QByteArray challenge =
        QCryptographicHash::hash(m_oauth->verifier.toLatin1(), QCryptographicHash::Sha256);
    QUrl url(QStringLiteral("https://accounts.google.com/o/oauth2/v2/auth"));
    QUrlQuery q;
    q.addQueryItem(QStringLiteral("client_id"), clientId);
    q.addQueryItem(QStringLiteral("redirect_uri"), m_oauth->redirectUri);
    q.addQueryItem(QStringLiteral("response_type"), QStringLiteral("code"));
    q.addQueryItem(QStringLiteral("scope"), Connectors::scopesFor(service));
    q.addQueryItem(QStringLiteral("access_type"), QStringLiteral("offline"));
    q.addQueryItem(QStringLiteral("prompt"), QStringLiteral("consent"));
    q.addQueryItem(QStringLiteral("state"), m_oauth->state);
    q.addQueryItem(QStringLiteral("code_challenge"), b64url(challenge));
    q.addQueryItem(QStringLiteral("code_challenge_method"), QStringLiteral("S256"));
    url.setQuery(q);

    m_oauthResult = QJsonObject{{QStringLiteral("pending"), true},
                                {QStringLiteral("service"), service}};
    QJsonObject r;
    r.insert(QStringLiteral("auth_url"), url.toString());
    r.insert(QStringLiteral("service"), service);
    return Response::success(req.id, r);
}

void ControlServer::onOAuthRedirect()
{
    if (!m_oauth || !m_oauth->server) return;
    QTcpSocket *sock = m_oauth->server->nextPendingConnection();
    if (!sock) return;
    auto buf = QSharedPointer<QByteArray>::create();
    connect(sock, &QTcpSocket::readyRead, this, [this, sock, buf]() {
        buf->append(sock->readAll());
        if (buf->size() > 8192) {   // a redirect GET line is tiny; cap the read
            sock->abort();
            return;
        }
        const int eol = buf->indexOf("\r\n");
        if (eol < 0)
            return;                 // wait until the full request line arrives
        // First request line: "GET /?code=...&state=... HTTP/1.1"
        const QString line = QString::fromLatin1(buf->left(eol));
        const int sp1 = line.indexOf(QLatin1Char(' '));
        const int sp2 = line.indexOf(QLatin1Char(' '), sp1 + 1);
        const QString target =
            (sp1 >= 0 && sp2 > sp1) ? line.mid(sp1 + 1, sp2 - sp1 - 1) : QString();
        const QUrlQuery q(QUrl(QStringLiteral("http://x") + target).query());
        const QString code = q.queryItemValue(QStringLiteral("code"));
        const QString state = q.queryItemValue(QStringLiteral("state"));
        const QString err = q.queryItemValue(QStringLiteral("error"));
        const bool stateOk = m_oauth && state == m_oauth->state;

        const QString bodyHtml =
            stateOk && err.isEmpty() && !code.isEmpty()
                ? QStringLiteral("<h2>Connected.</h2><p>You can close this tab and return to Cindro.</p>")
                : QStringLiteral("<h2>Sign-in failed.</h2><p>Return to Cindro and try again.</p>");
        const QByteArray html = bodyHtml.toUtf8();
        sock->write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    "Connection: close\r\nContent-Length: "
                    + QByteArray::number(html.size()) + "\r\n\r\n" + html);
        sock->flush();
        sock->disconnectFromHost();

        if (!stateOk)
            return; // stray/mismatched request — keep waiting for the real one
        if (!err.isEmpty() || code.isEmpty()) {
            finishOAuth(false, err.isEmpty() ? QStringLiteral("no authorization code") : err,
                        QString());
            return;
        }
        exchangeOAuthCode(code);
    });
}

void ControlServer::exchangeOAuthCode(const QString &code)
{
    if (!m_oauth) return;
    const quint64 flowId = m_oauth->id;
    QUrlQuery form;
    form.addQueryItem(QStringLiteral("code"), code);
    form.addQueryItem(QStringLiteral("client_id"), m_oauth->clientId);
    form.addQueryItem(QStringLiteral("client_secret"), m_oauth->clientSecret);
    form.addQueryItem(QStringLiteral("redirect_uri"), m_oauth->redirectUri);
    form.addQueryItem(QStringLiteral("grant_type"), QStringLiteral("authorization_code"));
    form.addQueryItem(QStringLiteral("code_verifier"), m_oauth->verifier);

    auto *nam = new QNetworkAccessManager(this);
    QNetworkRequest rq(QUrl(QStringLiteral("https://oauth2.googleapis.com/token")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader,
                 QStringLiteral("application/x-www-form-urlencoded"));
    QNetworkReply *reply = nam->post(rq, form.toString(QUrl::FullyEncoded).toUtf8());
    connect(reply, &QNetworkReply::finished, this, [this, reply, nam, flowId]() {
        const QByteArray body = reply->readAll();
        reply->deleteLater();
        nam->deleteLater();
        // A newer Connect flow may have superseded this exchange while Google was
        // replying — bail so we never store a token under the wrong service.
        if (!m_oauth || m_oauth->id != flowId)
            return;
        const QJsonObject o = QJsonDocument::fromJson(body).object();
        const QString refresh = o.value(QStringLiteral("refresh_token")).toString();
        if (refresh.isEmpty())
            finishOAuth(false,
                        o.value(QStringLiteral("error_description"))
                            .toString(o.value(QStringLiteral("error"))
                                          .toString(QStringLiteral("no refresh_token returned"))),
                        QString());
        else
            finishOAuth(true, QString(), refresh);
    });
}

void ControlServer::finishOAuth(bool ok, const QString &error, const QString &refreshToken)
{
    if (!m_oauth) return;
    const QString service = m_oauth->service;
    const QString clientId = m_oauth->clientId;
    const QString clientSecret = m_oauth->clientSecret;
    if (m_oauth->server) m_oauth->server->deleteLater();
    delete m_oauth;
    m_oauth = nullptr;

    if (!ok) {
        m_oauthResult = QJsonObject{{QStringLiteral("pending"), false},
                                    {QStringLiteral("connected"), false},
                                    {QStringLiteral("service"), service},
                                    {QStringLiteral("error"), error}};
        m_audit.record(QStringLiteral("connectors.oauth"), false, QStringLiteral("medium"),
                       QStringLiteral("google ") + service + QStringLiteral(": ") + error,
                       QString());
        return;
    }
    // Remove any prior row for this service (so re-connect doesn't duplicate),
    // then materialize + enable via the existing connectors.add wiring.
    Request rm;
    rm.id = 0;
    rm.method = QStringLiteral("connectors.remove");
    rm.params = QJsonObject{{QStringLiteral("service"), service}};
    handleConnectorsRemove(rm);
    Request add;
    add.id = 0;
    add.method = QStringLiteral("connectors.add");
    add.params = QJsonObject{{QStringLiteral("service"), service},
                             {QStringLiteral("client_id"), clientId},
                             {QStringLiteral("client_secret"), clientSecret},
                             {QStringLiteral("refresh_token"), refreshToken}};
    handleConnectorsAdd(add);
    m_oauthResult = QJsonObject{{QStringLiteral("pending"), false},
                                {QStringLiteral("connected"), true},
                                {QStringLiteral("service"), service}};
    m_audit.record(QStringLiteral("connectors.oauth"), true, QStringLiteral("medium"),
                   QStringLiteral("google ") + service + QStringLiteral(" connected"), QString());
}

Response ControlServer::handleConnectorsOAuthStatus(const Request &req)
{
    return Response::success(req.id, m_oauthResult);
}

Response ControlServer::handleConnectorsRemove(const Request &req)
{
    const QString service = req.params.value(QStringLiteral("service")).toString();
    const QString rid = req.params.value(QStringLiteral("id")).toString();
    if (service.isEmpty() && rid.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("service or id is required"));
    int removed = 0;
    const QVector<McpServerRow> rows = m_mcp->list();
    for (const McpServerRow &row : rows) {
        const QString svc = Connectors::serviceFromServerName(row.name);
        if (svc.isEmpty())
            continue;
        if ((!service.isEmpty() && svc == service) || (!rid.isEmpty() && row.id == rid)) {
            m_settings.setApiKey(Connectors::secretKey(row.id, QStringLiteral("client_id")), QString());
            m_settings.setApiKey(Connectors::secretKey(row.id, QStringLiteral("client_secret")), QString());
            m_settings.setApiKey(Connectors::secretKey(row.id, QStringLiteral("refresh_token")), QString());
            m_mcp->remove(row.id);
            ++removed;
        }
    }
    if (removed)
        m_settings.saveSecrets();
    QJsonObject r;
    r.insert(QStringLiteral("removed"), removed);
    return Response::success(req.id, r);
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
    // For an enabled stdio-MCP plugin, surface whether it actually got sandbox
    // confinement so the UI can badge an unconfined fallback launch.
    const bool isMcp = (man->kind == QStringLiteral("mcp") ||
                        man->kind == QStringLiteral("both"));
    if (enabled && isMcp && man->effectiveTransport() == QStringLiteral("stdio"))
        ok.insert(QStringLiteral("sandboxed"), m_sandbox.isSandboxed(id));
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
            // Visibility (do NOT gate the launch): on a host without systemd-run
            // the sandbox silently falls back to an UNCONFINED plain QProcess (the
            // documented fallback). Record a high-risk audit line so the operator
            // can see the granted permissions are not actually being enforced.
            if (!m_sandbox.isSandboxed(m.id))
                m_audit.record(QStringLiteral("plugins.set_enabled"), true,
                               QStringLiteral("high"),
                               QStringLiteral("plugin ") + m.id +
                                   QStringLiteral(" enabled WITHOUT sandbox confinement "
                                                  "— granted permissions not enforced"));
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

Response ControlServer::handleExtensionPairStart(const Request &req)
{
    // Mint a single-use code (reusing the device PairingManager pool: 6 digits,
    // 5-min TTL, consumed on use) that the Chrome/Edge extension redeems at
    // ws://127.0.0.1:<control>/control/pair?code=... to claim the bearer + control
    // tokens in one paste. The QR/payload are irrelevant here — only the code +
    // expiry matter. host/fp are passed so start()'s payload is well-formed.
    const QString host = tailnetHost() + QStringLiteral(":") +
                         QString::number(m_config.devicePort);
    const QString fp = m_deviceReg.identityFingerprint();
    const PairingCode pc = m_pairing.start(host, fp);
    QJsonObject out;
    out.insert(QStringLiteral("code"), pc.code);
    out.insert(QStringLiteral("expires_at"), pc.expiresAt);
    out.insert(QStringLiteral("control_port"), m_config.controlPort);
    return Response::success(req.id, out);
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

void ControlServer::reapPendingApprovals(const QString &sessionId, const QString &kind)
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    for (auto it = m_pendingApprovals.begin(); it != m_pendingApprovals.end();) {
        if (it->expiresAt <= now || (it->sessionId == sessionId && it->kind == kind))
            it = m_pendingApprovals.erase(it);
        else
            ++it;
    }
}

bool ControlServer::requestTakeOver(const QString &sessionId, QString *err,
                                    QString *approvalIdOut)
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
    // called by the approval path. The approval id is a fresh RANDOM token
    // registered in m_pendingApprovals, so respondApprovalFor() can reject a
    // forged/enumerated id instead of trusting a "takeover-<sessionId>" pattern.
    reapPendingApprovals(sessionId, QStringLiteral("takeover"));
    const QString approvalId = genApprovalId(QStringLiteral("takeover"));
    m_pendingApprovals.insert(
        approvalId, PendingApproval{sessionId, QStringLiteral("takeover"),
                                    QDateTime::currentMSecsSinceEpoch() + kApprovalTtlMs});
    if (approvalIdOut)
        *approvalIdOut = approvalId;
    NormalizedBrainEvent ev = NormalizedBrainEvent::approval(
        approvalId,
        QStringLiteral("Allow Cindro to drive your REAL screen?"),
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
    QString approvalId;
    if (!requestTakeOver(sessionId, &err, &approvalId))
        return Response::failure(req.id, QStringLiteral("no_session"), err);
    QJsonObject result;
    result.insert(QStringLiteral("pending_approval"), true);
    result.insert(QStringLiteral("approval_id"), approvalId);
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
        msg.title = QStringLiteral("Unlock Cindro");
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
    // Brute-force throttle: once past the threshold, refuse (WITHOUT even hashing
    // the PIN) until the escalating backoff window elapses. A correct PIN clears
    // this below, so a legitimate unlock is never slowed.
    const qint64 nowMs = QDateTime::currentMSecsSinceEpoch();
    if (m_pinLockedUntilMs > nowMs) {
        m_audit.record(QStringLiteral("auth.verify_pin"), false, QStringLiteral("high"),
                       QStringLiteral("desktop PIN locked out (too many attempts)"),
                       QString(), false);
        return Response::failure(req.id, QStringLiteral("locked_out"),
                                 QStringLiteral("too many attempts; try again shortly"));
    }
    if (!m_settings.verifyDesktopPin(pin)) {
        if (++m_pinFailCount >= kPinMaxAttempts) {
            // Escalating backoff past the threshold: 5s, 10s, 20s, ... capped.
            const int over = m_pinFailCount - kPinMaxAttempts;
            const qint64 backoff =
                qMin<qint64>(kPinMaxBackoffMs, 5000LL << qMin(over, 6));
            m_pinLockedUntilMs = nowMs + backoff;
        }
        m_audit.record(QStringLiteral("auth.verify_pin"), false, QStringLiteral("high"),
                       QStringLiteral("wrong desktop PIN"), QString(), false);
        return Response::failure(req.id, QStringLiteral("bad_pin"),
                                 QStringLiteral("incorrect PIN"));
    }
    // Correct PIN: clear the throttle so the next lock cycle starts fresh.
    m_pinFailCount = 0;
    m_pinLockedUntilMs = 0;
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
    // Shared file bus with the engine — resolve identically on every OS (DataPaths.h).
    return jarvis::dataDir() + QStringLiteral("/widgets.jsonl");
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
    if (m == QStringLiteral("memory.entities.list"))
        return handleMemoryEntitiesList(req);
    if (m == QStringLiteral("memory.entity.get"))
        return handleMemoryEntityGet(req);
    if (m == QStringLiteral("memory.link"))
        return handleMemoryLink(req);
    if (m == QStringLiteral("memory.graph"))
        return handleMemoryGraph(req);
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
    if (m == QStringLiteral("skills.pin"))
        return handleSkillsPin(req);
    if (m == QStringLiteral("skills.list_archived"))
        return handleSkillsListArchived(req);
    if (m == QStringLiteral("skills.unarchive"))
        return handleSkillsUnarchive(req);
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
    const QString agent = req.params.value(QStringLiteral("agent")).toString();
    // Opt-in for human-facing memory-browser UIs (web/desktop/TUI/phone
    // "search my memory" boxes) only — see MemoryStore::search()'s doc
    // comment. Defaults to false so the model's own recall()/prefetch path is
    // unaffected; only pass true from an explicit human browse/search action.
    const bool includeAgentScoped =
        req.params.value(QStringLiteral("include_agent_scoped")).toBool(false);
    QJsonArray arr;
    for (const MemoryRow &m : m_memory.search(q, limit, agent, includeAgentScoped))
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
    const QString agent = req.params.value(QStringLiteral("agent")).toString();
    const QString id = agent.isEmpty()
        ? m_memory.add(text, tags)
        : m_memory.add(text, tags, QString(), QStringLiteral("agent"), agent);
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

Response ControlServer::handleMemoryEntitiesList(const Request &req)
{
    const int limit = req.params.value(QStringLiteral("limit")).toInt(0);
    QJsonArray arr;
    for (const EntityRow &e : m_memory.listEntities(limit))
        arr.append(e.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("entities"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemoryEntityGet(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const auto entity = m_memory.getEntity(id);
    if (!entity)
        return Response::failure(req.id, QStringLiteral("not_found"),
                                 QStringLiteral("entity not found: ") + id);
    QJsonObject result = entity->toJson();
    QJsonArray related;
    for (const QString &nid : m_memory.neighborIds(id, 1)) {
        // Entities are always "ent_"-prefixed; a memory id is caller-supplied
        // and need not be (e.g. the daemon's "user-name" slot) — check the
        // entity prefix first, then fall back to a memory lookup.
        if (nid.startsWith(QStringLiteral("ent_"))) {
            if (auto e = m_memory.getEntity(nid))
                related.append(e->toJson());
        } else if (auto m = m_memory.get(nid)) {
            related.append(m->toJson());
        }
    }
    result.insert(QStringLiteral("related"), related);
    return Response::success(req.id, result);
}

Response ControlServer::handleMemoryLink(const Request &req)
{
    const QString fromId = req.params.value(QStringLiteral("from")).toString();
    const QString toId = req.params.value(QStringLiteral("to")).toString();
    const QString relation = req.params.value(QStringLiteral("relation")).toString();
    if (fromId.isEmpty() || toId.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("from and to are required"));
    // Node kind is inferred from the id prefix ("mem_"/"ent_") rather than a
    // caller-supplied param — both node stores share the same id namespace.
    const auto kindOf = [](const QString &id) {
        return id.startsWith(QStringLiteral("ent_")) ? QStringLiteral("entity")
                                                       : QStringLiteral("memory");
    };
    if (!m_memory.link(fromId, kindOf(fromId), toId, kindOf(toId),
                       relation.isEmpty() ? QStringLiteral("relates_to") : relation))
        return Response::failure(req.id, QStringLiteral("link_error"), m_memory.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
}

Response ControlServer::handleMemoryGraph(const Request &req)
{
    const QString root = req.params.value(QStringLiteral("root")).toString();
    const int depth = req.params.value(QStringLiteral("depth")).toInt(2);
    return Response::success(req.id, m_memory.graph(root, depth));
}

void ControlServer::seedPhoneMcp()
{
    // The native phone subsystem (vendored under phone/) runs its own MCP gateway.
    // Its agent bearer + port live in the Jarvis-managed env file. If that's
    // absent, the phone isn't set up — seed nothing (no phone tools for the brain).
    const QString envPath = Config::configDir() + QStringLiteral("/phone.env");
    QFile f(envPath);
    if (!f.exists() || !f.open(QIODevice::ReadOnly | QIODevice::Text))
        return;
    QString token;
    QString port = QStringLiteral("8801");
    const QList<QByteArray> lines = f.readAll().split('\n');
    f.close();
    for (const QByteArray &raw : lines) {
        const QString line = QString::fromUtf8(raw).trimmed();
        if (line.startsWith(QStringLiteral("AGENT_TOKEN=")))
            token = line.mid(QStringLiteral("AGENT_TOKEN=").size()).trimmed();
        else if (line.startsWith(QStringLiteral("SERVER_PORT=")))
            port = line.mid(QStringLiteral("SERVER_PORT=").size()).trimmed();
    }
    if (token.isEmpty())
        return;
    const QString endpoint = QStringLiteral("http://127.0.0.1:%1/mcp").arg(port);
    // Idempotent: drop any prior "phone" row (built-in or a legacy random-id one)
    // so the token/port stay in sync with the env on every restart. remove()
    // refuses builtin ids, so delete the stored row directly here.
    for (const McpServerRow &r : m_mcp->list())
        if (r.name == QStringLiteral("phone") || r.id == QStringLiteral("phone"))
            m_store.removeMcpServer(r.id);
    // Seed phone as a BUILT-IN server (stable id "phone", non-removable) — it's a
    // core Jarvis subsystem like computer-use, not a user add-on. risk=high: these
    // tools call/text the user, spend money, and reach the real world, so the
    // permission policy should pause before them.
    m_mcp->add(QStringLiteral("phone"), QStringLiteral("http"), endpoint, token,
               /*enabled=*/true, QStringLiteral("high"), /*env=*/{},
               /*builtin=*/true, /*fixedId=*/QStringLiteral("phone"));
    qInfo("jarvisd: seeded phone MCP server (built-in) -> %s", qPrintable(endpoint));
}

void ControlServer::seedInternalDocsSkill()
{
    // Re-seed our BUILTIN catalog when it changes (version marker), so existing
    // installs pick up new capabilities — but never clobber a user's own skills.
    // If internal_docs exists and already carries the current marker, skip;
    // otherwise (absent OR stale) refresh it.
    const QString kMarker = QStringLiteral("[catalog v5]");
    if (auto existing = m_skills.get(QStringLiteral("internal_docs"))) {
        QFile f(existing->path);
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QString cur = QString::fromUtf8(f.readAll());
            f.close();
            if (cur.contains(kMarker))
                return; // already current
        }
        m_skills.remove(QStringLiteral("internal_docs")); // stale builtin -> refresh
    }
    const QString body = QStringLiteral(
        "[catalog v5] When the user asks what you can do, your features, how to do "
        "something with you, or you're unsure you're capable of something, use THIS as "
        "the source of truth for Cindro's capabilities. Tell them what fits + offer to "
        "do it.\n\n"
        "# Cindro — what you can do\n\n"
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
        "**Memory** — long-term memory: remember/recall/list_memories/edit_memory/forget. "
        "Pass `agent` (a paired machine or agent name) to remember/recall to scope a fact "
        "to that agent — it stays isolated from unrelated chats, but auto-surfaces when a "
        "conversation mentions that agent by name.\n"
        "**Schedules** — run tasks later or on a cadence: schedule_task / list_schedules / "
        "cancel_schedule (cron or natural language). (docs/SCHEDULES.md)\n"
        "**Workflows** — named, manageable jobs combining a trigger (cron, polling, or "
        "webhook), a target agent/machine, a model, and an inbox report thread: "
        "workflow_create / workflow_list / workflow_delete. A webhook-triggered workflow "
        "gets its own callback URL + bearer token. (docs/WORKFLOWS.md)\n"
        "**Files** — send any file to the user's phone/desktop with send_file.\n"
        "**MCP & plugins** — extra MCP tool servers + a plugin marketplace, managed in the "
        "app.\n"
        "**Phone** — a native phone subsystem (vendored, in the one repo) lets you reach "
        "the user on their REAL phone AND lets them reach YOU. Call/text the user "
        "proactively: call_user / call_user_and_wait (in-app, can escalate to a real call), "
        "notify_user / notify_user_and_wait (text + optionally await a reply), "
        "twilio_call_and_wait (real PSTN call), device_sms (FREE SMS off the user's own "
        "phone SIM) / twilio_sms (PSTN SMS; needs toll-free verification), "
        "request_approval_by_phone, plus call screening, war room (red_alert), voice "
        "profiles, group calls, and the inbox — ~56 phone tools in all. INBOUND: when the "
        "user CALLS or TEXTS the Twilio number, you (Cindro, extension 101) wake up "
        "HEADLESSLY and answer — by voice on a call, by reply on a text — and can text or "
        "call them back with the same tools. (docs/PHONE.md, /phone skill)\n"
        "**Background jobs** — bg_start runs a long command DETACHED and WAKES you with "
        "its exit code + output when it finishes (training, builds, deploys); monitor "
        "watches a condition and wakes you when it trips; wake_me_in sleeps then wakes "
        "you; bg_status / bg_logs / bg_stop / bg_list. (docs/BACKGROUND_JOBS.md)\n"
        "**Hooks** — Claude-Code-style lifecycle hooks that fire shell commands on your "
        "events: hooks_list / hooks_add / hooks_remove / hooks_test. (docs/HOOKS.md)\n"
        "**Modes** — plan / build / co-worker, selectable in Settings (shown as the HUD "
        "chip). (docs/MODES.md)\n"
        "**Permissions** — an ask-before-risky policy (cautious / balanced / autonomous) "
        "the user sets in Settings → Permissions; you call ask_user before actions "
        "above the chosen risk line.\n"
        "**Outpost** — pair a remote Windows/Linux/macOS machine (one-line install) then run "
        "gated shell commands + screenshots on it by name.\n"
        "**Connectors** — a Google connectors framework (Gmail / Calendar / Drive etc.) "
        "the user can enable. (docs/JARVIS_GOOGLE_CONNECTORS.md)\n"
        "**Security / unlock** — optional 2FA: open Cindro by approving on the paired "
        "phone with a fingerprint, with a local PIN fallback (no-brick fail-open).\n"
        "**Brains** — you can run on Codex, Claude, or a direct API brain; the user picks "
        "the brain + model per session.\n"
        "**Cross-surface** — one daemon behind a desktop sidebar, an Android app, and a "
        "Chrome extension; cross-device biometric unlock. (README.md, docs/ARCHITECTURE.md)\n");
    m_skills.create(QStringLiteral("internal_docs"),
                    QStringLiteral("Cindro's own feature/capability catalog — load this "
                                   "when asked what you can do or when unsure."),
                    body, QStringLiteral("builtin"));
}

void ControlServer::seedPhoneSkill()
{
    // Builtin "phone" playbook. Versioned like internal_docs so an install picks up
    // updates, but never clobbers a user's own edits to a same-named skill.
    const QString kMarker = QStringLiteral("[phone skill v3]");
    if (auto existing = m_skills.get(QStringLiteral("phone"))) {
        QFile f(existing->path);
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QString cur = QString::fromUtf8(f.readAll());
            f.close();
            if (cur.contains(kMarker))
                return; // already current
            if (existing->fm.group != QStringLiteral("builtin"))
                return; // user-owned skill named "phone" — leave it alone
        }
        m_skills.remove(QStringLiteral("phone")); // stale builtin -> refresh
    }
    const QString body = QStringLiteral(
        "[phone skill v3] Use this when calling/texting the user, when they call or text "
        "you, or when working with the phone subsystem.\n\n"
        "# Phone — call & text the user, and answer when they reach you\n\n"
        "Cindro has a NATIVE phone subsystem (vendored in the repo; MCP gateway on :8801). "
        "You have ~56 phone tools (server `phone`). Use them to reach the user on their REAL "
        "phone, and you ANSWER when they call or text the Twilio number.\n\n"
        "## Reach the user (outbound)\n"
        "- `notify_user(message)` — send a text/notification; `notify_user_and_wait` awaits a reply.\n"
        "- `call_user(opening)` — in-app voice call; `call_user_and_wait` places it and waits.\n"
        "- `twilio_call_and_wait(text)` — a REAL PSTN phone call: speaks `text`, returns what they said.\n"
        "- `device_sms(number, message)` — FREE SMS from the user's OWN phone SIM (preferred for "
        "texting a real number; needs the Android app online).\n"
        "- `twilio_sms(message)` — PSTN SMS via Twilio (blocked until toll-free verification — "
        "prefer `device_sms`).\n"
        "- `request_approval` / `request_approval_by_phone` — have the user approve an action by phone.\n"
        "- `red_alert` — war room: ring everyone at once for something urgent.\n\n"
        "Pick the channel: a quick FYI -> `notify_user`; need an answer now -> `call_user_and_wait` "
        "or `twilio_call_and_wait`; texting a phone number -> `device_sms`.\n\n"
        "## When the user calls or texts YOU (inbound)\n"
        "You are Cindro on extension 101 — the registered inbound + SMS agent. When the user "
        "CALLS the Twilio number you wake HEADLESSLY and talk by VOICE (keep replies short and "
        "conversational, no markdown — they're spoken aloud). When they TEXT it you wake and reply "
        "as a text message. You can call/text them back mid-conversation with the tools above. "
        "Unknown callers are SCREENED first (read-only, talk-only) before reaching you.\n\n"
        "## Phone Permissions (respect the user's limits)\n"
        "The user can restrict what you may do over the phone in Phone → Permissions. These are "
        "ENFORCED, not suggestions: a capability set to Deny makes the matching tool FAIL with "
        "`blocked_by_phone_policy` (e.g. send_sms→`twilio_sms`/`device_sms`, outbound_calls→"
        "`twilio_call_and_wait`, spend_money→any billed PSTN call/SMS) — do NOT retry a blocked "
        "tool; instead tell the caller you're not allowed to do that right now. A capability set to "
        "Ask will pause for the user's approval before it runs. Answer-policy (who you pick up for) "
        "is handled upstream by call screening, so you may not even see screened/blocked callers.\n\n"
        "## Agents & extensions\n"
        "- `list_extensions` / `list_agents` — who's reachable (101 Cindro, 102 Codex, 103 Copilot, "
        "…, 107 screener).\n"
        "- `call_extension` — ring another agent; `start_group_chat` / `post_group_message` — multi-agent war room.\n"
        "- `twilio_register_inbound_agent(extension)` — set who answers the number; `twilio_screening_*` — screening.\n"
        "- `set_voice_profile` / `get_voice_profile` — the voice an extension speaks with.\n\n"
        "## Calls, inbox & memory\n"
        "- `list_active_calls` / `get_call_summary` / `get_call_transcript` / `summarize_call` / `end_call`.\n"
        "- `list_inbox` / `get_message` / `get_thread_messages` / `wait_for_message_reply`.\n"
        "- `store_memory` / `search_memory` — phone memory that persists across calls AND texts.\n"
        "- `twilio_allowlist_add/list/remove` — only allow-listed numbers connect; `twilio_set_user_number`.\n\n"
        "## Surfaces\n"
        "The same phone lives in the Cindro Android app (Phone tab = the full app: dialer, inbox, "
        "agents, HUD, settings, screening), the desktop sidebar (Phone hub: Dialer · Agents · Inbox "
        "· HUD · Settings · Screening), and the Chrome side panel. See docs/PHONE.md.\n");
    m_skills.create(QStringLiteral("phone"),
                    QStringLiteral("Call & text the user, and answer when they call/text in — "
                                   "the phone subsystem playbook (~56 tools)."),
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
    QString skillDir;
    const QString message = m_skills.invoke(name, argsStr, argsObj, &err, &skillDir);
    if (message.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_skill"), err);
    // Lifecycle curation (jarvis#76 item 2): every invoke path — skill_load
    // tool, extension /slash, phone, desktop — converges here, so this single
    // bump covers them all (using invoke()'s already-resolved dir: no rescan).
    m_skills.trackUsageAt(skillDir);
    QJsonObject result;
    result.insert(QStringLiteral("message"), message);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsPin(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const bool pinned = req.params.value(QStringLiteral("pinned")).toBool(true);
    if (!m_skills.setPinned(name, pinned))
        return Response::failure(req.id, QStringLiteral("no_skill"), m_skills.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    ok.insert(QStringLiteral("pinned"), pinned);
    return Response::success(req.id, ok);
}

Response ControlServer::handleSkillsListArchived(const Request &req)
{
    QJsonArray arr;
    for (const SkillRow &row : m_skills.listArchived())
        arr.append(row.toListJson());
    QJsonObject result;
    result.insert(QStringLiteral("skills"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleSkillsUnarchive(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    if (!m_skills.unarchive(name))
        return Response::failure(req.id, QStringLiteral("no_skill"), m_skills.lastError());
    QJsonObject ok;
    ok.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, ok);
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
    // tree link, no done-wake). Fall back CAREFULLY: pick the session mid-turn
    // right now (the caller is necessarily "running" while it calls this tool).
    // But if MORE THAN ONE top-level session is running concurrently we can't
    // tell which one called — guessing "the first" attached the subagent to the
    // WRONG chat. So: prefer the take-over session if it's the one running;
    // otherwise only auto-attach when EXACTLY ONE top-level session is running;
    // if it's ambiguous, leave parent empty (a correctly-orphaned subagent still
    // runs — better than surfacing under the wrong chat).
    if (parent.isEmpty()) {
        QStringList runningTop;
        for (const SessionRow &s : m_store.list())
            if (s.state == QStringLiteral("running") && s.parentSessionId.isEmpty())
                runningTop << s.id;
        if (runningTop.size() == 1) {
            parent = runningTop.first();
        } else if (runningTop.size() > 1) {
            for (const QString &sid : runningTop)
                if (m_takeOverActive.contains(sid)) { parent = sid; break; }
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
        // The user's NAMED cloned voices (incl. the seeded "Jarvis"/jarvice) are
        // merged in from the VoiceLibrary below, so they are NOT hardcoded here.
        { "en_paul_neutral",   "Paul — neutral (EN)" },
        { "en_emma_neutral",   "Emma — neutral (EN)" },
        { "en_oliver_warm",    "Oliver — warm (EN)" },
        { "en_sophia_bright",  "Sophia — bright (EN)" },
        { "fr_louis_neutral",  "Louis — neutral (FR)" },
        { "es_diego_neutral",  "Diego — neutral (ES)" },
    };

    QJsonArray stockVoices;
    for (const V &v : voices) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), QString::fromLatin1(v.id));
        o.insert(QStringLiteral("label"), QString::fromLatin1(v.label));
        o.insert(QStringLiteral("custom"), false);
        stockVoices.append(o);
    }

    // The user's NAMED cloned voices (record/upload, name) come from the library,
    // shown FIRST in every picker; the curated stock presets follow.
    m_voiceLib.load(); // pick up any out-of-band changes (e.g. jarvice_voice.py)
    QJsonArray voxtralVoices;
    for (const QJsonValue &c : m_voiceLib.toListJson())
        voxtralVoices.append(c);
    for (const QJsonValue &v : stockVoices)
        voxtralVoices.append(v);

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

// --- named cloned-voice library (record/upload, name, set-default) ----------

// The effective default voice slug: the tts_voice setting, else the seeded
// "jarvice" clone (matching handleVoiceTts's resolution).
static QString effectiveDefaultVoice(const SettingsStore &s)
{
    const QString v = s.ttsVoice();
    return v.isEmpty() ? kCloneVoiceDefault : v;
}

Response ControlServer::handleVoiceCreateClone(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString().trimmed();
    if (name.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("name is required"));
    const QByteArray audio = QByteArray::fromBase64(
        req.params.value(QStringLiteral("audio_b64")).toString().toLatin1());
    if (audio.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("audio_b64 is required"));
    const QString format = req.params.value(QStringLiteral("format")).toString();
    // clean defaults TRUE (best clone quality); pass clean=false for the raw toggle.
    const bool clean = req.params.contains(QStringLiteral("clean"))
                           ? req.params.value(QStringLiteral("clean")).toBool()
                           : true;
    QString source = req.params.value(QStringLiteral("source")).toString();
    if (source != QStringLiteral("record") && source != QStringLiteral("upload"))
        source = QStringLiteral("upload");

    m_voiceLib.load();
    const auto entry = m_voiceLib.createClone(name, audio, format, clean, source);
    if (!entry)
        return Response::failure(req.id, QStringLiteral("voice_create_failed"),
                                 m_voiceLib.lastError());

    QJsonObject result;
    result.insert(QStringLiteral("voice"),
                  entry->toJson(entry->voiceSlug() == m_voiceLib.defaultSlug()));
    result.insert(QStringLiteral("voices"), m_voiceLib.toListJson());
    result.insert(QStringLiteral("default"), effectiveDefaultVoice(m_settings));
    return Response::success(req.id, result);
}

Response ControlServer::handleVoiceDeleteClone(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    if (id.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("id is required"));
    m_voiceLib.load();
    const auto victim = m_voiceLib.find(id);
    const bool wasDefault = victim && victim->voiceSlug() == effectiveDefaultVoice(m_settings);
    if (!m_voiceLib.removeClone(id))
        return Response::failure(req.id, QStringLiteral("voice_delete_failed"),
                                 m_voiceLib.lastError());
    // If we just deleted the active default, adopt the library's repaired default
    // and propagate it everywhere (config.toml + phone calls).
    if (wasDefault) {
        m_settings.setTtsVoice(m_voiceLib.defaultSlug());
        m_settings.saveConfig();
        propagateDefaultVoiceToPhone();
    }
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("voices"), m_voiceLib.toListJson());
    result.insert(QStringLiteral("default"), effectiveDefaultVoice(m_settings));
    return Response::success(req.id, result);
}

Response ControlServer::handleVoiceSetDefault(const Request &req)
{
    QString voice = req.params.value(QStringLiteral("voice")).toString();
    if (voice.isEmpty())
        voice = req.params.value(QStringLiteral("id")).toString();
    if (voice.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("voice (or id) is required"));
    m_voiceLib.load();
    // An id that names a library voice resolves to its voice slug; otherwise it's
    // a stock voice slug (en_paul_neutral, ...) used directly.
    if (const auto e = m_voiceLib.find(voice))
        voice = e->voiceSlug();
    // tts_voice is the REAL default lever; mirror it into the library cache.
    m_settings.setTtsVoice(voice);
    if (!m_settings.saveConfig())
        return Response::failure(req.id, QStringLiteral("save_failed"),
                                 m_settings.lastError());
    m_voiceLib.setDefaultSlug(voice);
    propagateDefaultVoiceToPhone();

    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("default"), voice);
    result.insert(QStringLiteral("voices"), m_voiceLib.toListJson());
    return Response::success(req.id, result);
}

Response ControlServer::handleVoiceRenameClone(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const QString name = req.params.value(QStringLiteral("name")).toString().trimmed();
    if (id.isEmpty() || name.isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("id and name are required"));
    m_voiceLib.load();
    const auto before = m_voiceLib.find(id);
    const bool wasDefault = before && before->voiceSlug() == effectiveDefaultVoice(m_settings);
    if (!m_voiceLib.rename(id, name))
        return Response::failure(req.id, QStringLiteral("voice_rename_failed"),
                                 m_voiceLib.lastError());
    // A rename changes the slug -> the voice slug -> keep the default valid.
    if (wasDefault) {
        m_settings.setTtsVoice(m_voiceLib.defaultSlug());
        m_settings.saveConfig();
        propagateDefaultVoiceToPhone();
    }
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("voices"), m_voiceLib.toListJson());
    return Response::success(req.id, result);
}

Response ControlServer::handleVoicePreviewClone(const Request &req)
{
    QString voice = req.params.value(QStringLiteral("voice")).toString();
    if (voice.isEmpty())
        voice = req.params.value(QStringLiteral("id")).toString();
    m_voiceLib.load();
    if (const auto e = m_voiceLib.find(voice))
        voice = e->voiceSlug();
    QString text = req.params.value(QStringLiteral("text")).toString();
    if (text.trimmed().isEmpty())
        text = QStringLiteral("Hello — this is how I'll sound.");
    // Reuse the full voice.tts path (clone resolution + stock fallback).
    Request tts = req;
    tts.method = QStringLiteral("voice.tts");
    QJsonObject p = req.params;
    p.insert(QStringLiteral("voice"), voice);
    p.insert(QStringLiteral("text"), text);
    tts.params = p;
    return handleVoiceTts(tts);
}

void ControlServer::propagateDefaultVoiceToPhone()
{
    const QString envPath = Config::configDir() + QStringLiteral("/phone.env");
    if (!QFile::exists(envPath))
        return; // phone subsystem not set up -> desktop-only, nothing to do.

    // The default voice's reference clip ("" when the default is a stock voice).
    const QString clip = m_voiceLib.clipPath(effectiveDefaultVoice(m_settings));

    // Rewrite phone.env preserving every other line: set or remove the
    // MISTRAL_TTS_REF_AUDIO_FILE key. A clone clip REPLACES the named voice on
    // calls; clearing it lets calls use the phone server's stock voice id.
    QStringList out;
    bool wrote = false;
    {
        QFile f(envPath);
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            const QList<QByteArray> lines = f.readAll().split('\n');
            f.close();
            for (const QByteArray &raw : lines) {
                const QString line = QString::fromUtf8(raw);
                if (line.trimmed().startsWith(QStringLiteral("MISTRAL_TTS_REF_AUDIO_FILE="))) {
                    if (!clip.isEmpty() && !wrote) {
                        out << QStringLiteral("MISTRAL_TTS_REF_AUDIO_FILE=") + clip;
                        wrote = true;
                    }
                    continue; // else drop it (clearing for a stock voice)
                }
                out << line;
            }
        }
    }
    if (!clip.isEmpty() && !wrote)
        out << QStringLiteral("MISTRAL_TTS_REF_AUDIO_FILE=") + clip;
    QString body = out.join(QLatin1Char('\n'));
    while (body.endsWith(QStringLiteral("\n\n")))
        body.chop(1);
    if (!body.endsWith(QLatin1Char('\n')))
        body += QLatin1Char('\n');

    {
        QSaveFile sf(envPath);
        if (!sf.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
            qWarning("jarvisd: cannot open phone.env to set default voice");
            return;
        }
        sf.write(body.toUtf8());
        if (!sf.commit()) {
            qWarning("jarvisd: failed writing phone.env for default voice: %s",
                     qPrintable(sf.errorString()));
            return;
        }
        QFile::setPermissions(envPath, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    }

    // Restart the phone subsystem so it re-reads the ref clip. A default change is
    // a rare, user-driven Settings action; the ~1-2s blip won't drop a call the
    // user isn't on. Best-effort — a failure just logs (applies on next restart).
    QProcess restart;
    restart.start(QStringLiteral("systemctl"),
                  {QStringLiteral("--user"), QStringLiteral("restart"),
                   QStringLiteral("jarvis-phone.service")});
    if (!restart.waitForStarted(3000)) {
        qWarning("jarvisd: could not invoke systemctl to restart jarvis-phone.service");
        return;
    }
    restart.waitForFinished(15000);
    if (restart.exitStatus() != QProcess::NormalExit || restart.exitCode() != 0)
        qWarning("jarvisd: jarvis-phone.service restart exit=%d (default voice applies "
                 "on its next restart)", restart.exitCode());
    else
        qInfo("jarvisd: default voice -> phone calls (%s); jarvis-phone.service restarted",
              clip.isEmpty() ? "stock" : qPrintable(clip));
}

// --- device->phone file push (Contract C) -----------------------------------

namespace {

QString fileInboxDir(const QString &sessionId)
{
    QString dir = dataDir() + QStringLiteral("/files");
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
        QStringLiteral("status.get"),        QStringLiteral("ui.manifest.get"),
        QStringLiteral("model.list"),        QStringLiteral("mcp.list"),
        QStringLiteral("mcp.add"),           QStringLiteral("mcp.remove"),
        QStringLiteral("mcp.set_enabled"),   QStringLiteral("mcp.test"),
        QStringLiteral("plugins.catalog"),   QStringLiteral("plugins.install"),
        QStringLiteral("plugins.set_enabled"), QStringLiteral("plugins.remove"),
        QStringLiteral("voice.stt"),         QStringLiteral("voice.tts"),
        QStringLiteral("voice.list_voices"),
        // Named cloned-voice library (record/upload, name, set-default) — mirrored
        // to the phone so the Jarvis app's Settings can manage the default voice.
        QStringLiteral("voice.create_clone"), QStringLiteral("voice.delete_clone"),
        QStringLiteral("voice.set_default"),  QStringLiteral("voice.rename_clone"),
        QStringLiteral("voice.preview_clone"),
        // Trust policies (jarvis#71) — mirrored to the phone (Settings → Permissions).
        QStringLiteral("policy.list"),       QStringLiteral("policy.add"),
        QStringLiteral("policy.update"),     QStringLiteral("policy.remove"),
        QStringLiteral("policy.set_default"), QStringLiteral("policy.test"),
        QStringLiteral("take_over.request"), QStringLiteral("file.push"),
        QStringLiteral("file.get"),
        QStringLiteral("devices.pair_start"), QStringLiteral("devices.list"),
        QStringLiteral("devices.revoke"),
        QStringLiteral("agent_desktop.info"),
        // 2FA unlock gate (read/action tier; harmless over the device channel).
        QStringLiteral("auth.request"),      QStringLiteral("auth.status"),
        QStringLiteral("auth.deny"),
        // Native phone subsystem proxy + lifecycle hooks (the phone app drives
        // calls/inbox via phone.mcp; the daemon holds the phone bearer).
        QStringLiteral("phone.mcp"),         QStringLiteral("phone.http"),
        // Phone Permissions (Phone → Permissions on every surface, incl. the
        // phone). NOT phone.config / phone.twilio_verify_* — those touch Twilio
        // secrets and stay control/loopback-only, like phone.config.
        QStringLiteral("phone.policy.list"), QStringLiteral("phone.policy.set"),
        QStringLiteral("phone.policy.reset"), QStringLiteral("phone.policy.test"),
        QStringLiteral("hooks.list"),        QStringLiteral("hooks.add"),
        QStringLiteral("hooks.remove"),      QStringLiteral("hooks.test"),
    };
    return methods.contains(method);
}

Response ControlServer::dispatchConfigMethod(const Request &req, bool remote)
{
    const QString &m = req.method;
    if (m == QStringLiteral("settings.get"))    return handleSettingsGet(req);
    if (m == QStringLiteral("settings.set"))    return handleSettingsSet(req);
    if (m == QStringLiteral("status.get"))      return handleStatusGet(req);
    if (m == QStringLiteral("ui.manifest.get")) return handleUiManifestGet(req);
    if (m == QStringLiteral("phone.mcp"))       return handlePhoneMcp(req);
    if (m == QStringLiteral("phone.http"))      return handlePhoneHttp(req);
    if (m == QStringLiteral("phone.policy.list"))  return handlePhonePolicyList(req);
    if (m == QStringLiteral("phone.policy.set"))   return handlePhonePolicySet(req);
    if (m == QStringLiteral("phone.policy.reset")) return handlePhonePolicyReset(req);
    if (m == QStringLiteral("phone.policy.test"))  return handlePhonePolicyTest(req);
    if (m == QStringLiteral("hooks.list"))      return handleHooksList(req);
    if (m == QStringLiteral("hooks.add"))       return handleHooksAdd(req);
    if (m == QStringLiteral("hooks.remove"))    return handleHooksRemove(req);
    if (m == QStringLiteral("hooks.test"))      return handleHooksTest(req);
    if (m == QStringLiteral("policy.list"))     return handlePolicyList(req);
    if (m == QStringLiteral("policy.add"))      return handlePolicyAdd(req);
    if (m == QStringLiteral("policy.update"))   return handlePolicyUpdate(req);
    if (m == QStringLiteral("policy.remove"))   return handlePolicyRemove(req);
    if (m == QStringLiteral("policy.set_default")) return handlePolicySetDefault(req);
    if (m == QStringLiteral("policy.test"))     return handlePolicyTest(req);
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
    if (m == QStringLiteral("voice.create_clone")) return handleVoiceCreateClone(req);
    if (m == QStringLiteral("voice.delete_clone")) return handleVoiceDeleteClone(req);
    if (m == QStringLiteral("voice.set_default")) return handleVoiceSetDefault(req);
    if (m == QStringLiteral("voice.rename_clone")) return handleVoiceRenameClone(req);
    if (m == QStringLiteral("voice.preview_clone")) return handleVoicePreviewClone(req);
    if (m == QStringLiteral("take_over.request")) return handleTakeOverRequest(req);
    if (m == QStringLiteral("file.push")) {
        // Over the phone/device channel, refuse a {path} source: it would read an
        // arbitrary local file off the daemon host and hand it back via file.get.
        // Phones send bytes inline (b64); only loopback callers (jarvis_send_file)
        // may reference an on-disk path, and they call handleFilePush directly
        // (never through this remote dispatcher).
        if (remote && req.params.contains(QStringLiteral("path")))
            return Response::failure(req.id, QStringLiteral("bad_request"),
                                     QStringLiteral("send b64 over the device channel"));
        return handleFilePush(req);
    }
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

// --- Wave 8: co-worker ops (scheduler / outpost pairing+exec / audit) -------

bool ControlServer::isOpsMethod(const QString &method)
{
    return method.startsWith(QStringLiteral("schedule.")) ||
           method.startsWith(QStringLiteral("tui.layout.")) ||
           method.startsWith(QStringLiteral("command.")) ||
           method.startsWith(QStringLiteral("outpost.")) ||
           method.startsWith(QStringLiteral("proxmox.")) ||
           method.startsWith(QStringLiteral("diff.")) ||
           method == QStringLiteral("audit.list");
}

// --- durable kanban work queue (jarvis#76 item 7) ---------------------------

bool ControlServer::isQueueMethod(const QString &method)
{
    return method.startsWith(QStringLiteral("queue."));
}

Response ControlServer::dispatchQueueMethod(const Request &req)
{
    const QString &m = req.method;
    if (!m_kanban.isOpen())
        return Response::failure(req.id, QStringLiteral("unavailable"),
                                 QStringLiteral("work queue store unavailable"));
    if (m == QStringLiteral("queue.add")) {
        const QJsonObject p = req.params;
        const QString prompt = p.value(QStringLiteral("prompt")).toString();
        if (prompt.trimmed().isEmpty())
            return Response::failure(req.id, QStringLiteral("bad_request"),
                                     QStringLiteral("prompt is required"));
        const QString id = m_kanban.enqueue(
            p.value(QStringLiteral("title")).toString(), prompt,
            p.value(QStringLiteral("priority")).toInt(0),
            p.value(QStringLiteral("brain")).toString(),
            p.value(QStringLiteral("model")).toString(),
            p.value(QStringLiteral("profile")).toString(),
            p.value(QStringLiteral("tags")).toString(),
            p.value(QStringLiteral("parent_item_id")).toString());
        if (id.isEmpty())
            return Response::failure(req.id, QStringLiteral("error"),
                                     m_kanban.lastError());
        m_audit.record(QStringLiteral("queue.add"), true, QStringLiteral("low"),
                       QStringLiteral("enqueued: ")
                           + p.value(QStringLiteral("title")).toString(prompt.left(60)));
        QJsonObject r;
        r.insert(QStringLiteral("id"), id);
        return Response::success(req.id, r);
    }
    if (m == QStringLiteral("queue.list")) {
        QJsonArray arr;
        for (const WorkItem &w :
             m_kanban.list(req.params.value(QStringLiteral("status")).toString(),
                           req.params.value(QStringLiteral("limit")).toInt(200)))
            arr.append(w.toJson());
        QJsonObject r;
        r.insert(QStringLiteral("items"), arr);
        return Response::success(req.id, r);
    }
    if (m == QStringLiteral("queue.get")) {
        const auto w = m_kanban.get(req.params.value(QStringLiteral("id")).toString());
        if (!w)
            return Response::failure(req.id, QStringLiteral("not_found"),
                                     QStringLiteral("unknown work item"));
        QJsonObject r;
        r.insert(QStringLiteral("item"), w->toJson());
        return Response::success(req.id, r);
    }
    if (m == QStringLiteral("queue.cancel")) {
        const QString id = req.params.value(QStringLiteral("id")).toString();
        const auto w = m_kanban.get(id);
        if (!w)
            return Response::failure(req.id, QStringLiteral("not_found"),
                                     QStringLiteral("unknown work item"));
        // Stop a live worker session before flipping the row.
        if (w->status == QStringLiteral("running") && !w->sessionId.isEmpty()) {
            QString cerr;
            cancelSession(w->sessionId, &cerr);
            m_queueItemBySession.remove(w->sessionId);
        }
        if (!m_kanban.cancel(id))
            return Response::failure(req.id, QStringLiteral("error"),
                                     m_kanban.lastError());
        QJsonObject r;
        r.insert(QStringLiteral("ok"), true);
        return Response::success(req.id, r);
    }
    if (m == QStringLiteral("queue.remove")) {
        if (!m_kanban.remove(req.params.value(QStringLiteral("id")).toString()))
            return Response::failure(req.id, QStringLiteral("error"),
                                     m_kanban.lastError());
        QJsonObject r;
        r.insert(QStringLiteral("ok"), true);
        return Response::success(req.id, r);
    }
    if (m == QStringLiteral("queue.set_priority")) {
        if (!m_kanban.setPriority(req.params.value(QStringLiteral("id")).toString(),
                                  req.params.value(QStringLiteral("priority")).toInt(0)))
            return Response::failure(req.id, QStringLiteral("error"),
                                     m_kanban.lastError());
        QJsonObject r;
        r.insert(QStringLiteral("ok"), true);
        return Response::success(req.id, r);
    }
    return Response::failure(req.id, QStringLiteral("bad_request"),
                             QStringLiteral("unknown queue method: ") + m);
}

// Dispatcher loop: heartbeat live workers, reclaim orphans, and start pending
// items while worker slots are free. Worker sessions are ordinary top-level
// sessions (full memory context; visible in every surface's session list).
void ControlServer::tickWorkQueue()
{
    // 1) Liveness: heartbeat every tracked worker whose session still exists.
    for (auto it = m_queueItemBySession.begin(); it != m_queueItemBySession.end();) {
        if (m_store.get(it.key()).has_value()) {
            m_kanban.heartbeat(it.value());
            ++it;
        } else {
            // Session deleted out from under the item — reclaim it. releaseClaim
            // clears session_id/heartbeat back to a clean pending state (updateStatus
            // with an empty session_id deliberately leaves the column untouched, so
            // it can't be used here to null out the now-dead session pointer).
            m_kanban.releaseClaim(it.value());
            it = m_queueItemBySession.erase(it);
        }
    }

    // 2) Reclaim items whose worker (possibly a previous daemon) went silent.
    if (const int n = m_kanban.reclaimStale(kQueueStaleMs); n > 0)
        qInfo("jarvisd: reclaimed %d stale work item(s)", n);

    // 3) Fill free worker slots. claimNext() itself returns nullopt on an
    // empty backlog (guarded UPDATE), so no separate peek query is needed.
    while (m_queueItemBySession.size() < kMaxQueueWorkers) {
        auto item = m_kanban.claimNext();
        if (!item)
            return;
        QString err;
        const QString sid = createSession(
            item->profile.isEmpty() ? QStringLiteral("coworker") : item->profile,
            item->brain, item->model, /*cwd=*/QString(),
            QStringLiteral("Queue: ") + item->title, &err);
        if (sid.isEmpty()) {
            m_kanban.updateStatus(item->id, QStringLiteral("error"), QString(),
                                  QStringLiteral("failed to start worker: ") + err);
            qWarning("jarvisd: work item %s failed to start: %s",
                     qPrintable(item->id), qPrintable(err));
            continue;
        }
        m_kanban.updateStatus(item->id, QStringLiteral("running"), sid);
        m_queueItemBySession.insert(sid, item->id);
        const QString prompt = QStringLiteral(
            "[WORK QUEUE ITEM %1] %2\n\n%3\n\nWhen the task is complete, end with "
            "a short SUMMARY of what was done (it becomes the item's result).")
            .arg(item->id, item->title, item->prompt);
        QString serr;
        if (!sendToSession(sid, prompt, {}, &serr)) {
            m_kanban.updateStatus(item->id, QStringLiteral("error"), sid,
                                  QStringLiteral("failed to send task: ") + serr);
            m_queueItemBySession.remove(sid);
            continue;
        }
        m_audit.record(QStringLiteral("queue.start"), true, QStringLiteral("low"),
                       QStringLiteral("work item %1 -> session %2")
                           .arg(item->id, sid),
                       sid);
        qInfo("jarvisd: work item %s started in session %s", qPrintable(item->id),
              qPrintable(sid));
    }
}

Response ControlServer::dispatchOpsMethod(const Request &req, bool remote)
{
    const QString &m = req.method;
    if (m == QStringLiteral("schedule.create"))      return handleScheduleCreate(req);
    if (m == QStringLiteral("schedule.list"))        return handleScheduleList(req);
    if (m == QStringLiteral("schedule.set_enabled")) return handleScheduleSetEnabled(req);
    if (m == QStringLiteral("schedule.update"))      return handleScheduleUpdate(req);
    if (m == QStringLiteral("schedule.remove"))      return handleScheduleRemove(req);
    if (m == QStringLiteral("schedule.run_now"))     return handleScheduleRunNow(req);
    if (m == QStringLiteral("schedule.webhook_token")) return handleScheduleWebhookToken(req);
    if (m == QStringLiteral("tui.layout.list"))    return handleTuiLayoutList(req);
    if (m == QStringLiteral("tui.layout.add"))     return handleTuiLayoutAdd(req);
    if (m == QStringLiteral("tui.layout.edit"))    return handleTuiLayoutEdit(req);
    if (m == QStringLiteral("tui.layout.remove"))  return handleTuiLayoutRemove(req);
    if (m == QStringLiteral("tui.layout.reorder")) return handleTuiLayoutReorder(req);
    if (m == QStringLiteral("command.list"))       return handleCommandList(req);
    if (m == QStringLiteral("command.create"))     return handleCommandCreate(req);
    if (m == QStringLiteral("command.remove"))     return handleCommandRemove(req);
    if (m == QStringLiteral("command.invoke"))     return handleCommandInvoke(req);
    if (m == QStringLiteral("diff.stage"))           return handleDiffStage(req);
    if (m == QStringLiteral("diff.revert"))          return handleDiffRevert(req);
    if (m == QStringLiteral("diff.commit"))          return handleDiffCommit(req);
    if (m == QStringLiteral("diff.open_pr"))         return handleDiffOpenPr(req);
    if (m == QStringLiteral("outpost.list"))         return handleOutpostList(req);
    if (m == QStringLiteral("outpost.pair_start"))   return handleOutpostPairStart(req);
    if (m == QStringLiteral("outpost.pair_status"))  return handleOutpostPairStatus(req);
    if (m == QStringLiteral("outpost.exec"))         return handleOutpostExec(req, remote);
    if (m == QStringLiteral("outpost.screenshot"))   return handleOutpostScreenshot(req);
    if (m == QStringLiteral("outpost.revoke"))       return handleOutpostRevoke(req);
    if (m == QStringLiteral("outpost.install_workload")) return handleOutpostInstallWorkload(req);
    if (m == QStringLiteral("proxmox.status"))       return handleProxmoxStatus(req);
    if (m == QStringLiteral("proxmox.report"))       return handleProxmoxReport(req);
    if (m == QStringLiteral("proxmox.restart_vm"))   return handleProxmoxRestartVm(req);
    if (m == QStringLiteral("proxmox.set_blocklist")) return handleProxmoxSetBlocklist(req);
    if (m == QStringLiteral("proxmox.send_directive")) return handleProxmoxSendDirective(req);
    if (m == QStringLiteral("proxmox.scout"))        return handleProxmoxScout(req);
    if (m == QStringLiteral("proxmox.scout_status")) return handleProxmoxScoutStatus(req);
    if (m == QStringLiteral("proxmox.vm_profile"))   return handleProxmoxVmProfile(req);
    if (m == QStringLiteral("proxmox.questions"))    return handleProxmoxQuestions(req);
    if (m == QStringLiteral("proxmox.answer"))       return handleProxmoxAnswer(req);
    if (m == QStringLiteral("proxmox.ask_agent"))    return handleProxmoxAskAgent(req);
    if (m == QStringLiteral("proxmox.agent_reply"))  return handleProxmoxAgentReply(req);
    if (m == QStringLiteral("proxmox.pinged_list"))  return handleProxmoxPingedList(req);
    if (m == QStringLiteral("proxmox.pinged_add"))   return handleProxmoxPingedAdd(req);
    if (m == QStringLiteral("proxmox.pinged_remove")) return handleProxmoxPingedRemove(req);
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
                                      &err,
                                      /*target=*/QString(), /*parentSessionId=*/QString(),
                                      /*agent=*/QString(), /*agentPromptOverride=*/QString(),
                                      /*scheduleTargetRef=*/row.targetRef);
    if (sid.isEmpty()) {
        qWarning("jarvisd: scheduled job '%s' failed to create session: %s",
                 qPrintable(row.name), qPrintable(err));
        return QString();
    }
    QString prompt = row.prompt;
    if (!row.reportThread.isEmpty()) {
        prompt += QStringLiteral(
            "\n\n[Workflow report] When you finish this task, post a concise "
            "summary of the outcome to the user's Cindro inbox by calling the "
            "notify_user tool with title=\"%1\". Keep it to a few lines.")
            .arg(row.reportThread);
    }
    if (!sendToSession(sid, prompt, {}, &err))
        qWarning("jarvisd: scheduled job '%s' send failed: %s",
                 qPrintable(row.name), qPrintable(err));
    // Push a notification to paired phones (incl. backgrounded ones) that a
    // scheduled task started — distinct from a manual session.opened. Tapping it
    // deep-links to the new session's chat (data.session_id).
    if (m_fcm) {
        PushMessage msg;
        msg.title = QStringLiteral("Scheduled task started");
        msg.body = row.name.isEmpty() ? QStringLiteral("A scheduled Cindro task is running")
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
        p.value(QStringLiteral("enabled")).toBool(true),
        p.value(QStringLiteral("target")).toString(),
        p.value(QStringLiteral("report_thread")).toString(),
        p.value(QStringLiteral("token")).toString());
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

Response ControlServer::handleScheduleUpdate(const Request &req)
{
    // Partial update: a field is only changed when the caller's params object
    // actually contains that key (mirrors config.update's patch-style
    // convention above) — an omitted key leaves the stored value untouched.
    // `webhook_token` is never accepted here; it stays immutable once minted
    // (see handleScheduleWebhookToken).
    const QJsonObject p = req.params;
    const QString id = p.value(QStringLiteral("id")).toString();
    if (id.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("id is required"));

    auto opt = [&](const char *key) -> std::optional<QString> {
        const QLatin1String k(key);
        if (!p.contains(k))
            return std::nullopt;
        return p.value(k).toString();
    };

    // Accept either `cron` or `when` (alias) for the trigger, same as create —
    // and, to match handleScheduleCreate's EMPTINESS-based fallback exactly
    // (cronExpr.isEmpty() ? ... : ...) rather than opt()'s presence-based
    // check, so a caller that (like schedule.create callers already do)
    // sends both keys with `cron` blank and the real value in `when` doesn't
    // have the blank `cron` key block the `when` fallback and abort the
    // whole update on an unparseable empty trigger.
    QString cronCombined = p.value(QStringLiteral("cron")).toString();
    if (cronCombined.isEmpty())
        cronCombined = p.value(QStringLiteral("when")).toString();
    const std::optional<QString> cronExpr =
        cronCombined.isEmpty() ? std::nullopt : std::make_optional(cronCombined);

    if (!m_scheduler.update(id, opt("name"), cronExpr, opt("prompt"), opt("brain"),
                            opt("model"), opt("profile"), opt("target"),
                            opt("report_thread")))
        return Response::failure(req.id, QStringLiteral("schedule_error"),
                                 m_scheduler.lastError());

    m_audit.record(QStringLiteral("schedule.update"), true, QStringLiteral("low"),
                   QStringLiteral("updated schedule %1").arg(id));
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

Response ControlServer::handleScheduleRunNow(const Request &req)
{
    // Fires the job immediately (even if disabled — pressing Run IS the
    // approval), without touching next_run. Both the GUI's Run button and the
    // TUI's "g" key call this; it previously didn't exist and always failed
    // with unknown_method.
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const std::optional<QString> sid = m_scheduler.runNow(id);
    if (!sid)
        return Response::failure(req.id, QStringLiteral("no_schedule"),
                                 QStringLiteral("unknown schedule: ") + id);
    m_audit.record(QStringLiteral("schedule.run_now"), !sid->isEmpty(),
                   QStringLiteral("low"),
                   QStringLiteral("manually fired schedule %1").arg(id));
    QJsonObject result;
    result.insert(QStringLiteral("ok"), !sid->isEmpty());
    result.insert(QStringLiteral("session_id"), *sid);
    return Response::success(req.id, result);
}

Response ControlServer::handleScheduleWebhookToken(const Request &req)
{
    // Returns the stored per-workflow webhook bearer for `id` (empty for an
    // unknown id or a non-webhook workflow), plus its current `enabled` state.
    // Used ONLY by the webhook ingestion endpoint (fire_webhook() in
    // tools_workflows.py) to hmac-compare the presented bearer AND refuse to
    // fire a disabled webhook workflow even when the presented token is
    // otherwise valid — never surfaced in schedule.list / workflow_list
    // output. This method is also excluded from the phone/device channel (see
    // DeviceServer::dispatchAuthed) since the token itself is a durable,
    // portable credential that must never leave the daemon.
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const std::optional<ScheduleRow> row = m_scheduler.get(id);
    QJsonObject result;
    result.insert(QStringLiteral("token"), row ? row->webhookToken : QString());
    result.insert(QStringLiteral("enabled"), row ? row->enabled : false);
    return Response::success(req.id, result);
}

// --- diff review: diff.* -----------------------------------------------------
// Git actions behind the GUI DiffReviewPanel's PillButtons and the TUI's
// /stage /commit /revert /openpr slash commands. Both frontends already sent
// these verbs; until now the daemon answered unknown_method and each client
// quietly degraded. Git-level failures come back as success{ok:false,message}
// (not Response::failure) so the clients render git's own text inline instead
// of a generic error path. Blocking QProcess in the handler follows the
// same synchronous-subprocess precedent as the outpost.exec proxy.

namespace {
Response diffResult(const Request &req, const jarvis::GitResult &r,
                    bool urlOnSuccess = false)
{
    QJsonObject o;
    o.insert(QStringLiteral("ok"), r.ok);
    if (urlOnSuccess && r.ok)
        o.insert(QStringLiteral("url"), r.output);
    else if (!r.output.isEmpty())
        o.insert(QStringLiteral("message"), r.output);
    return Response::success(req.id, o);
}
} // namespace

QString ControlServer::diffWorkdirFor(const QString &sessionId) const
{
    const QString mapped = m_sessionCwd.value(sessionId);
    return mapped.isEmpty() ? m_config.effectiveCwd() : mapped;
}

Response ControlServer::handleDiffStage(const Request &req)
{
    const QString path = req.params.value(QStringLiteral("path")).toString();
    if (path.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("path is required"));
    const QString wd =
        diffWorkdirFor(req.params.value(QStringLiteral("session_id")).toString());
    if (!jarvis::GitOps::isRepo(wd))
        return diffResult(req, {false, -1,
                                QStringLiteral("not a git repository: ") + wd});
    const jarvis::GitResult r = jarvis::GitOps::stage(wd, path);
    m_audit.record(QStringLiteral("diff.stage"), r.ok, QStringLiteral("low"),
                   QStringLiteral("git add %1 (in %2)").arg(path, wd));
    return diffResult(req, r);
}

Response ControlServer::handleDiffRevert(const Request &req)
{
    const QString path = req.params.value(QStringLiteral("path")).toString();
    if (path.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("path is required"));
    const QString wd =
        diffWorkdirFor(req.params.value(QStringLiteral("session_id")).toString());
    if (!jarvis::GitOps::isRepo(wd))
        return diffResult(req, {false, -1,
                                QStringLiteral("not a git repository: ") + wd});
    // Destroys local edits to the file — the GUI gates this behind an inline
    // approval and the TUI requires the explicit /revert <path>; audit high.
    const jarvis::GitResult r = jarvis::GitOps::revertFile(wd, path);
    m_audit.record(QStringLiteral("diff.revert"), r.ok, QStringLiteral("high"),
                   QStringLiteral("git checkout HEAD -- %1 (in %2)").arg(path, wd));
    return diffResult(req, r);
}

Response ControlServer::handleDiffCommit(const Request &req)
{
    const QString message = req.params.value(QStringLiteral("message")).toString();
    const QString wd =
        diffWorkdirFor(req.params.value(QStringLiteral("session_id")).toString());
    if (!jarvis::GitOps::isRepo(wd))
        return diffResult(req, {false, -1,
                                QStringLiteral("not a git repository: ") + wd});
    const jarvis::GitResult r = jarvis::GitOps::commit(wd, message);
    m_audit.record(QStringLiteral("diff.commit"), r.ok, QStringLiteral("medium"),
                   QStringLiteral("git commit (in %1): %2")
                       .arg(wd, message.left(60)));
    return diffResult(req, r);
}

Response ControlServer::handleDiffOpenPr(const Request &req)
{
    const QString title = req.params.value(QStringLiteral("title")).toString();
    const QString wd =
        diffWorkdirFor(req.params.value(QStringLiteral("session_id")).toString());
    if (!jarvis::GitOps::isRepo(wd))
        return diffResult(req, {false, -1,
                                QStringLiteral("not a git repository: ") + wd});
    const jarvis::GitResult r = jarvis::GitOps::openPr(wd, title);
    m_audit.record(QStringLiteral("diff.open_pr"), r.ok, QStringLiteral("medium"),
                   QStringLiteral("push + gh pr create (in %1): %2")
                       .arg(wd, title.left(60)));
    return diffResult(req, r, /*urlOnSuccess=*/true);
}

// --- TUI self-edit layout: tui.layout.* -------------------------------------

static QJsonArray tuiPagesToJson(const QVector<jarvis::TuiPageSpec> &pages)
{
    QJsonArray arr;
    for (const auto &p : pages) {
        QJsonObject o;
        o.insert(QStringLiteral("id"), p.id);
        o.insert(QStringLiteral("title"), p.title);
        o.insert(QStringLiteral("kind"), p.kind);
        o.insert(QStringLiteral("config"), p.config);
        o.insert(QStringLiteral("order"), p.order);
        arr.append(o);
    }
    return arr;
}

Response ControlServer::handleTuiLayoutList(const Request &req)
{
    QJsonObject result;
    result.insert(QStringLiteral("pages"), tuiPagesToJson(m_tuiLayoutStore.list()));
    return Response::success(req.id, result);
}

Response ControlServer::handleTuiLayoutAdd(const Request &req)
{
    jarvis::TuiPageSpec spec;
    spec.id = req.params.value(QStringLiteral("id")).toString();
    spec.title = req.params.value(QStringLiteral("title")).toString();
    spec.kind = req.params.value(QStringLiteral("kind")).toString();
    spec.config = req.params.value(QStringLiteral("config")).toObject();
    QString err;
    if (!m_tuiLayoutStore.addPage(spec, &err))
        return Response::failure(req.id, QStringLiteral("invalid_page"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutEdit(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    const QJsonObject config = req.params.value(QStringLiteral("config")).toObject();
    QString err;
    if (!m_tuiLayoutStore.editPage(id, config, &err))
        return Response::failure(req.id, QStringLiteral("not_found"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutRemove(const Request &req)
{
    const QString id = req.params.value(QStringLiteral("id")).toString();
    QString err;
    if (!m_tuiLayoutStore.removePage(id, &err))
        return Response::failure(req.id, QStringLiteral("not_found"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleTuiLayoutReorder(const Request &req)
{
    QStringList order;
    for (const auto &v : req.params.value(QStringLiteral("order")).toArray())
        order << v.toString();
    QString err;
    if (!m_tuiLayoutStore.reorder(order, &err))
        return Response::failure(req.id, QStringLiteral("invalid_order"), err);
    broadcastTuiLayoutChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

void ControlServer::broadcastTuiLayoutChanged()
{
    // Same shape as broadcastSessionOpened (ControlServer.cpp:4285) — a
    // global, non-session-scoped event every connected client hears.
    QJsonObject data;
    data.insert(QStringLiteral("pages"), tuiPagesToJson(m_tuiLayoutStore.list()));
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("tui.layout.changed"));
    frame.insert(QStringLiteral("data"), data);
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
    // Custom pages are part of the merged surface manifest too.
    broadcastUiManifestChanged();
}

// --- shared surface manifest: ui.manifest.* ----------------------------------

Response ControlServer::handleUiManifestGet(const Request &req)
{
    return Response::success(
        req.id, jarvis::UiManifest::merged(m_tuiLayoutStore.list(),
                                           m_commandStore.list()));
}

void ControlServer::broadcastUiManifestChanged()
{
    // Payload-free nudge: clients refetch ui.manifest.get (keeps the frame
    // tiny and avoids double-encoding the whole manifest on every change).
    QJsonObject frame;
    frame.insert(QStringLiteral("v"), 1);
    frame.insert(QStringLiteral("event"), QStringLiteral("ui.manifest.changed"));
    frame.insert(QStringLiteral("data"), QJsonObject{});
    const QString payload =
        QString::fromUtf8(QJsonDocument(frame).toJson(QJsonDocument::Compact));
    for (QWebSocket *client : std::as_const(m_clients))
        client->sendTextMessage(payload);
}

// --- self-authored slash commands: command.* --------------------------------

static QJsonArray commandsToJson(const QVector<jarvis::CommandRow> &rows)
{
    QJsonArray arr;
    for (const auto &r : rows) {
        QJsonObject o;
        o.insert(QStringLiteral("name"), r.name);
        o.insert(QStringLiteral("description"), r.description);
        o.insert(QStringLiteral("action_kind"), r.actionKind);
        o.insert(QStringLiteral("action_target"), r.actionTarget);
        o.insert(QStringLiteral("self_authored"), r.selfAuthored);
        arr.append(o);
    }
    return arr;
}

Response ControlServer::handleCommandList(const Request &req)
{
    QJsonObject result;
    result.insert(QStringLiteral("commands"), commandsToJson(m_commandStore.list()));
    return Response::success(req.id, result);
}

Response ControlServer::handleCommandCreate(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const QString description = req.params.value(QStringLiteral("description")).toString();
    const QString actionKind = req.params.value(QStringLiteral("action_kind")).toString();
    const QString actionTarget = req.params.value(QStringLiteral("action_target")).toString();
    const QString body = req.params.value(QStringLiteral("body")).toString();
    // Authored through the create_slash_command MCP tool -> self_authored.
    if (!m_commandStore.create(name, description, actionKind, actionTarget, body,
                               /*selfAuthored=*/true))
        return Response::failure(req.id, QStringLiteral("invalid_command"),
                                 QStringLiteral("name collides with a built-in, already "
                                                "exists, or has an invalid action_kind"));
    broadcastUiManifestChanged(); // custom commands are part of the manifest
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleCommandRemove(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    if (!m_commandStore.remove(name))
        return Response::failure(req.id, QStringLiteral("not_found"),
                                 QStringLiteral("no such command"));
    broadcastUiManifestChanged();
    return Response::success(req.id, {{QStringLiteral("ok"), true}});
}

Response ControlServer::handleCommandInvoke(const Request &req)
{
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const auto row = m_commandStore.get(name);
    if (!row)
        return Response::failure(req.id, QStringLiteral("not_found"), QStringLiteral("no such command"));
    const QString argsText = req.params.value(QStringLiteral("args")).toString();
    QJsonObject result;
    if (row->actionKind == QStringLiteral("prompt")) {
        QString prompt = row->body;
        prompt.replace(QStringLiteral("{{ARGS}}"), argsText);
        result.insert(QStringLiteral("prompt"), prompt);
    } else if (row->actionKind == QStringLiteral("mcp_tool")) {
        // EXECUTE the tool (previously this only echoed the name back and
        // both frontends notified "dispatch is a fast-follow"). The target is
        // a bare tool name, so try every enabled server — built-in
        // computer-use first, where self-authored tools live — and keep the
        // last error when none succeeds. JSON-object args pass through
        // verbatim; free text rides as {"args": "<text>"}.
        QJsonObject toolArgs;
        const QJsonDocument doc = QJsonDocument::fromJson(argsText.toUtf8());
        if (doc.isObject())
            toolArgs = doc.object();
        else if (!argsText.trimmed().isEmpty())
            toolArgs.insert(QStringLiteral("args"), argsText);

        jarvis::McpCallResult call;
        call.error = QStringLiteral("no enabled MCP server");
        QVector<McpServerRow> servers = m_mcp->list();
        std::stable_sort(servers.begin(), servers.end(),
                         [](const McpServerRow &a, const McpServerRow &b) {
                             return (a.id == McpRegistry::builtinId()) >
                                    (b.id == McpRegistry::builtinId());
                         });
        for (const McpServerRow &srv : servers) {
            if (!srv.enabled)
                continue;
            call = McpRegistry::callTool(srv, row->actionTarget, toolArgs);
            if (call.ok)
                break;
        }
        m_audit.record(QStringLiteral("command.invoke"), call.ok,
                       QStringLiteral("medium"),
                       QStringLiteral("/%1 -> mcp_tool %2").arg(name, row->actionTarget));
        result.insert(QStringLiteral("mcp_tool"), row->actionTarget);
        result.insert(QStringLiteral("executed"), true);
        result.insert(QStringLiteral("ok"), call.ok);
        result.insert(QStringLiteral("output"), call.ok ? call.content : call.error);
    } else {
        // EXECUTE the script (same "was vapor" story as mcp_tool). Targets
        // resolve ONLY under <commands>/scripts/ with the diff.* containment
        // guard, and an explicit trust-policy deny blocks execution — the
        // user's explicit /invoke answers any "ask".
        result.insert(QStringLiteral("shell"), row->actionTarget);
        result.insert(QStringLiteral("executed"), true);
        const TrustDecision d =
            m_trustPolicies.evaluate(QStringLiteral("command.shell"), name);
        if (d.action == QStringLiteral("deny")) {
            m_audit.record(QStringLiteral("command.invoke"), false,
                           QStringLiteral("high"),
                           QStringLiteral("DENIED shell /%1 (policy %2)")
                               .arg(name, d.ruleId));
            result.insert(QStringLiteral("ok"), false);
            result.insert(QStringLiteral("output"),
                          QStringLiteral("blocked by trust policy (deny)"));
            return Response::success(req.id, result);
        }
        if (!jarvis::GitOps::pathInside(row->actionTarget)) {
            result.insert(QStringLiteral("ok"), false);
            result.insert(QStringLiteral("output"),
                          QStringLiteral("script path escapes the scripts dir: ")
                              + row->actionTarget);
            return Response::success(req.id, result);
        }
        const QString scriptPath = QDir(m_commandStore.dir())
                                       .filePath(QStringLiteral("scripts/") + row->actionTarget);
        const QFileInfo fi(scriptPath);
        if (!fi.exists()) {
            result.insert(QStringLiteral("ok"), false);
            result.insert(QStringLiteral("output"),
                          QStringLiteral("script not found: ") + scriptPath);
            return Response::success(req.id, result);
        }
        QString prog = scriptPath;
        QStringList shArgs;
        if (!fi.isExecutable()) {
#ifdef Q_OS_WIN
            prog = QStringLiteral("cmd");
            shArgs << QStringLiteral("/c") << scriptPath;
#else
            prog = QStringLiteral("/bin/sh");
            shArgs << scriptPath;
#endif
        }
        if (!argsText.trimmed().isEmpty())
            shArgs << argsText; // one argv entry — the script parses further
        const jarvis::GitResult r =
            jarvis::GitOps::run(m_config.effectiveCwd(), prog, shArgs, 30000);
        m_audit.record(QStringLiteral("command.invoke"), r.ok,
                       QStringLiteral("high"),
                       QStringLiteral("shell /%1 -> %2").arg(name, row->actionTarget));
        result.insert(QStringLiteral("ok"), r.ok);
        result.insert(QStringLiteral("exit_code"), r.exitCode);
        result.insert(QStringLiteral("output"), r.output);
    }
    return Response::success(req.id, result);
}

QString ControlServer::outpostPort()
{
    return qEnvironmentVariable("OUTPOST_MCP_PORT", QStringLiteral("8798"));
}

QJsonObject ControlServer::outpostHttp(const QString &httpMethod, const QString &path,
                                       const QJsonObject &body, bool *reachable,
                                       int localTimeoutMs)
{
    // outpost-mcp inbound bearer lives beside ours (~/.config/jarvis/outpost_mcp_token
    // by default). OUTPOST_CONFIG_DIR / OUTPOST_MCP_PORT mirror outpost_mcp/config.py's
    // own env overrides (used by its test suite) so a shared harness that sets them
    // before starting BOTH the daemon and outpost-mcp keeps this proxy in sync with
    // wherever outpost-mcp is actually listening / reading its token from.
    QString configDir = qEnvironmentVariable("OUTPOST_CONFIG_DIR");
    if (configDir.isEmpty())
        configDir = QDir::homePath() + QStringLiteral("/.config/jarvis");
    QString token;
    {
        QFile f(configDir + QStringLiteral("/outpost_mcp_token"));
        if (f.open(QIODevice::ReadOnly | QIODevice::Text)) {
            token = QString::fromUtf8(f.readAll()).trimmed();
            f.close();
        }
    }
    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(QStringLiteral("http://127.0.0.1:%1%2").arg(outpostPort(), path)));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!token.isEmpty())
        rq.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());
    const QByteArray data = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QNetworkReply *reply = (httpMethod == QStringLiteral("GET"))
        ? nam.get(rq) : nam.post(rq, data);

    QEventLoop loop;
    QTimer::singleShot(localTimeoutMs, &loop, &QEventLoop::quit);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    if (!reply->isFinished()) {
        reply->abort();
        reply->deleteLater();
        if (reachable) *reachable = false;
        return {};
    }
    const QNetworkReply::NetworkError nerr = reply->error();
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray resp = reply->readAll();
    reply->deleteLater();
    if (status == 0 && nerr != QNetworkReply::NoError) {
        if (reachable) *reachable = false;
        return {};
    }
    if (reachable) *reachable = true;
    const QJsonDocument d = QJsonDocument::fromJson(resp);
    return d.isObject() ? d.object() : QJsonObject();
}

Response ControlServer::handleOutpostList(const Request &req)
{
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("GET"),
                                      QStringLiteral("/api/machines"), {}, &ok);
    m_audit.record(QStringLiteral("outpost.list"), ok, QStringLiteral("low"),
                   QStringLiteral("listed outpost machines"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostPairStart(const Request &req)
{
    QJsonObject body;
    body.insert(QStringLiteral("name"), req.params.value(QStringLiteral("name")).toString());
    body.insert(QStringLiteral("os_hint"), req.params.value(QStringLiteral("os_hint")).toString());
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/pair/start"), body, &ok);
    m_audit.record(QStringLiteral("outpost.pair_start"), ok, QStringLiteral("medium"),
                   QStringLiteral("started outpost pairing"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostPairStatus(const Request &req)
{
    const QString bid = req.params.value(QStringLiteral("bootstrap_id")).toString();
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("GET"),
                                      QStringLiteral("/api/pair/status/%1").arg(bid), {}, &ok);
    m_audit.record(QStringLiteral("outpost.pair_status"), ok, QStringLiteral("low"),
                   QStringLiteral("polled outpost pairing"));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostExec(const Request &req, bool remote)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString cmd = req.params.value(QStringLiteral("cmd")).toString();
    if (machine.trimmed().isEmpty() || cmd.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and cmd are required"));
    const double timeoutSec = req.params.value(QStringLiteral("timeout")).toDouble(0);
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    body.insert(QStringLiteral("cmd"), cmd);
    if (req.params.contains(QStringLiteral("timeout")))
        body.insert(QStringLiteral("timeout"), timeoutSec);
    if (req.params.contains(QStringLiteral("shell")))
        body.insert(QStringLiteral("shell"), req.params.value(QStringLiteral("shell")).toString());
    bool ok = false;
    // Local wait must outlast the caller's remote timeout (+slack), with the 60s
    // floor for a bare exec — otherwise a long-running remote step is aborted
    // client-side while it's still running on the machine. Clamp to a 10-min
    // ceiling (covers the 180s/300s Proxmox install steps) so a caller-supplied
    // timeout can't pin outpostHttp's nested event loop open for days. Bound the
    // double BEFORE the int cast to avoid overflow on an absurd value.
    const int localMs = int(qBound(60000.0, (timeoutSec + 10) * 1000.0, 600000.0));
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/exec"), body, &ok, localMs);
    m_audit.record(QStringLiteral("outpost.exec"), ok && r.value(QStringLiteral("ok")).toBool(),
                   QStringLiteral("high"),
                   QStringLiteral("outpost %1: %2").arg(machine, cmd.left(80)),
                   QString(), remote);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostScreenshot(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/screenshot"), body, &ok);
    m_audit.record(QStringLiteral("outpost.screenshot"),
                   ok && r.value(QStringLiteral("ok")).toBool(), QStringLiteral("medium"),
                   QStringLiteral("outpost screenshot %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

Response ControlServer::handleOutpostRevoke(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    bool ok = false;
    const QJsonObject r = outpostHttp(QStringLiteral("POST"),
                                      QStringLiteral("/api/revoke"), body, &ok);
    m_audit.record(QStringLiteral("outpost.revoke"), ok, QStringLiteral("low"),
                   QStringLiteral("revoked outpost machine %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    return Response::success(req.id, r);
}

// --- Proxmox workload manager: install + status/report/restart/blocklist ---
// Everything here proxies to a paired machine through outpost.exec — the same
// primitive outpost.* itself uses (no new transport). handleProxmoxRestartVm
// is the ONLY code path in this whole feature that runs `qm reboot`; it is
// reachable only from a UI-triggered RPC call, never from the scheduled
// agent's own tool catalog (which never registers a restart tool at all —
// see proxmox-mcp/tools_proxmox.py).

QJsonObject ControlServer::execOnMachine(const QString &machine, const QString &cmd,
                                         double timeoutSec, bool *reachable)
{
    QJsonObject body;
    body.insert(QStringLiteral("machine"), machine);
    body.insert(QStringLiteral("cmd"), cmd);
    body.insert(QStringLiteral("timeout"), timeoutSec);
    // Local wait outlasts the remote timeout (+slack), 60s floor — so the long
    // Proxmox install steps (180s/300s) aren't cut off client-side mid-run.
    const int localMs = qMax(60000, int((timeoutSec + 10) * 1000));
    return outpostHttp(QStringLiteral("POST"), QStringLiteral("/api/exec"), body,
                       reachable, localMs);
}

QJsonObject ControlServer::writeRemoteFile(const QString &machine, const QString &path,
                                           const QByteArray &content, const QString &mode,
                                           bool *reachable)
{
    const QString dir = QFileInfo(path).path();
    const QString b64 = QString::fromLatin1(content.toBase64());
    const QString cmd = QStringLiteral(
        "install -d -m700 '%1' && printf '%2' | base64 -d > '%3' && chmod %4 '%3'")
        .arg(dir, b64, path, mode);
    return execOnMachine(machine, cmd, 20.0, reachable);
}

Response ControlServer::handleOutpostInstallWorkload(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));

    // Preflight: refuse to install onto anything that isn't actually a
    // Proxmox host, with a clear error instead of a half-deployed mess.
    bool ok = false;
    QJsonObject r = execOnMachine(machine, QStringLiteral("command -v qm && command -v pvesh"),
                                  15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("not_a_proxmox_host"),
                                 QStringLiteral("'%1' has no qm/pvesh on PATH — is this a "
                                               "Proxmox host?").arg(machine));

    // Seed config.toml, an empty blocklist (all VMs in scope by default —
    // the user explicitly chose include-all + a configurable blocklist over
    // an allowlist), and the two secrets this install flow is the first-ever
    // place in the codebase to push to a remote machine.
    const QString mistralKey = m_settings.apiKey(QStringLiteral("mistral"));
    const QString trackerToken = readYamlFlatKey(
        QDir::homePath() + QStringLiteral("/.project-tracker/config.yaml"),
        QStringLiteral("bearer_token"));
    if (mistralKey.isEmpty())
        return Response::failure(req.id, QStringLiteral("no_mistral_key"),
                                 QStringLiteral("no Mistral API key configured locally — the "
                                               "always-on agent needs one to keep running "
                                               "when your laptop is off"));

    QJsonObject jarvisSecrets;
    jarvisSecrets.insert(QStringLiteral("mistral"), mistralKey);
    QByteArray tokenBytes(32, '\0');
    for (char &b : tokenBytes)
        b = static_cast<char>(QRandomGenerator::system()->bounded(256));
    const QString mcpToken = QString::fromLatin1(tokenBytes.toHex());
    const QByteArray configToml = QStringLiteral(
        "node = \"pve\"\ncheck_interval_minutes = 5\ncooldown_minutes = 15\n"
        "reserve_cores = 2\nreserve_mem_mb = 4096\nbump_step_cores = 2\n"
        "bump_step_mem_mb = 2048\nmax_cores_per_vm = 16\nmax_mem_mb_per_vm = 32768\n"
        "cpu_congested_pct = 85.0\nmem_congested_pct = 90.0\n"
        "project_tracker_agent_name = \"proxmox-%1\"\n"
        "project_tracker_project_id = \"proj-jarvis\"\n"
        "project_tracker_url = \"http://100.114.201.41:8790/mcp\"\n").arg(machine).toUtf8();

    // Each write is checked for BOTH transport reachability AND exec-level
    // success (r["ok"]) — a base64-decode/chmod failure on the remote host
    // must not be reported as a successful install. Stops at the first
    // failure instead of firing all five writes regardless.
    struct RemoteFile { QString path, mode; QByteArray content; };
    std::vector<RemoteFile> files = {
        {QStringLiteral("/etc/jarvis-proxmox-agent/jarvisd/secrets.json"), QStringLiteral("600"),
         QJsonDocument(jarvisSecrets).toJson(QJsonDocument::Compact)},
        {QStringLiteral("/etc/jarvis-proxmox-agent/project_tracker_token"), QStringLiteral("600"),
         trackerToken.toUtf8()},
        // proxmox-mcp's own inbound bearer + config/blocklist (world-
        // unreadable dir, 0600/0644 files) — same writer, plain text here.
        {QStringLiteral("/etc/jarvis-proxmox-agent/mcp_token"), QStringLiteral("600"),
         mcpToken.toUtf8()},
        {QStringLiteral("/etc/jarvis-proxmox-agent/config.toml"), QStringLiteral("644"), configToml},
        {QStringLiteral("/etc/jarvis-proxmox-agent/blocklist.json"), QStringLiteral("644"),
         QByteArrayLiteral("{\"vmids\":[]}")},
    };
    // GitHub auth for the two pull-from-GitHub steps below — the repo is
    // PRIVATE, so anonymous clone/release-download fails. The token rides in
    // a 0600 file read by a GIT_ASKPASS helper (never in argv, so never
    // visible in `ps`). Without a locally-configured "github" API key the
    // steps still run anonymously (works only if the repo goes public).
    const QString ghToken = m_settings.apiKey(QStringLiteral("github"));
    if (!ghToken.isEmpty()) {
        files.push_back({QStringLiteral("/etc/jarvis-proxmox-agent/github_token"),
                         QStringLiteral("600"), ghToken.toUtf8()});
        files.push_back({QStringLiteral("/etc/jarvis-proxmox-agent/git-askpass.sh"),
                         QStringLiteral("755"),
                         QByteArrayLiteral("#!/bin/sh\ncat /etc/jarvis-proxmox-agent/github_token\n")});
    }
    for (const auto &f : files) {
        bool wok = false;
        const QJsonObject wr = writeRemoteFile(machine, f.path, f.content, f.mode, &wok);
        const bool wsuccess = wok && wr.value(QStringLiteral("ok")).toBool();
        if (!wsuccess) {
            m_audit.record(QStringLiteral("outpost.install_workload"), false, QStringLiteral("high"),
                           QStringLiteral("installing proxmox workload manager onto %1 failed "
                                         "writing %2").arg(machine, f.path));
            if (!wok)
                return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                         QStringLiteral("outpost-mcp (:%1) unreachable")
                                             .arg(outpostPort()));
            return Response::failure(req.id, QStringLiteral("install_failed"),
                                     QStringLiteral("failed writing %1 to %2: %3")
                                         .arg(f.path, machine,
                                              wr.value(QStringLiteral("error")).toString()));
        }
    }

    // From here on, every step is a plain outpost.exec shell command (small
    // text/commands — no size problem like a binary transfer would be). A
    // shared helper avoids repeating the ok/r["ok"] double-check + audit +
    // failure-Response boilerplate for each one.
    auto runStep = [&](const QString &label, const QString &cmd,
                       double timeoutSec) -> std::optional<Response> {
        bool sok = false;
        const QJsonObject sr = execOnMachine(machine, cmd, timeoutSec, &sok);
        const bool ssuccess = sok && sr.value(QStringLiteral("ok")).toBool();
        m_audit.record(QStringLiteral("outpost.install_workload"), ssuccess, QStringLiteral("high"),
                       QStringLiteral("installing proxmox workload manager onto %1: %2")
                           .arg(machine, label));
        if (!sok)
            return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                     QStringLiteral("outpost-mcp (:%1) unreachable")
                                         .arg(outpostPort()));
        if (!ssuccess) {
            // The agent's "error" field is often empty for a plain non-zero
            // exit — the actual reason (git/curl/pip stderr) is in "output".
            QString why = sr.value(QStringLiteral("error")).toString();
            const QString tail =
                sr.value(QStringLiteral("output")).toString().right(400).trimmed();
            if (!tail.isEmpty())
                why = why.isEmpty() ? tail : why + QStringLiteral(" — ") + tail;
            return Response::failure(req.id, QStringLiteral("install_failed"),
                                     QStringLiteral("%1 failed on %2: %3")
                                         .arg(label, machine, why));
        }
        return std::nullopt;
    };

    // 1. Deploy proxmox-mcp: a shallow, sparse clone (just this one directory,
    // not the whole monorepo) + its own venv. Idempotent — re-running the
    // install just re-syncs the checkout and re-installs into the same venv.
    if (auto fail = runStep(QStringLiteral("deploy proxmox-mcp"), QStringLiteral(
            "set -e; "
            "install -d -m755 /opt/jarvis-proxmox-agent; "
            "cd /opt/jarvis-proxmox-agent; "
            // Fail fast with git's real error instead of hanging on a
            // username prompt when the token is missing/wrong.
            "export GIT_TERMINAL_PROMPT=0; "
            "REPO_URL=https://github.com/CrazyMan28/jarvis.git; "
            "if [ -s /etc/jarvis-proxmox-agent/github_token ]; then "
            "  export GIT_ASKPASS=/etc/jarvis-proxmox-agent/git-askpass.sh; "
            "  REPO_URL=https://x-access-token@github.com/CrazyMan28/jarvis.git; "
            "fi; "
            "if [ ! -d src/.git ]; then "
            "  rm -rf src; "
            "  git clone --filter=blob:none --sparse --depth 1 --branch main "
            "    \"$REPO_URL\" src; "
            "  git -C src sparse-checkout set proxmox-mcp; "
            "else "
            "  git -C src remote set-url origin \"$REPO_URL\"; "
            "  git -C src fetch --depth 1 origin main && git -C src reset --hard origin/main; "
            "fi; "
            "python3 -m venv /opt/jarvis-proxmox-agent/proxmox-mcp/.venv; "
            "/opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/pip install -q "
            "  /opt/jarvis-proxmox-agent/src/proxmox-mcp"), 180.0))
        return *fail;

    // 2. Fetch the latest release AppImage (the CI-pinned build environment's
    // glibc baseline is what makes this portable to an arbitrary paired
    // machine — see docs/PROXMOX_WORKLOAD_MANAGER.md) and extract it. A bare
    // binary transfer through writeRemoteFile's base64-over-exec would blow
    // past reasonable single-command payload sizes for a ~300MB AppImage;
    // having the REMOTE host pull it directly sidesteps that entirely.
    if (auto fail = runStep(QStringLiteral("fetch+extract jarvisd release"), QStringLiteral(
            "set -e; "
            "install -d -m755 /opt/jarvis-proxmox-agent/appimage; "
            "cd /opt/jarvis-proxmox-agent/appimage; "
            "AUTH=; "
            "if [ -s /etc/jarvis-proxmox-agent/github_token ]; then "
            "  AUTH=\"Authorization: Bearer $(cat /etc/jarvis-proxmox-agent/github_token)\"; "
            "fi; "
            "curl -fsSL ${AUTH:+-H \"$AUTH\"} -o release.json "
            "  https://api.github.com/repos/CrazyMan28/jarvis/releases/latest; "
            // Private-repo assets must come from the assets API url with
            // Accept: octet-stream — browser_download_url 404s with a token.
            // .get(): a rate-limit body / draft release has no "assets" key —
            // fall through to the clean [ -n "$URL" ] guard, not a KeyError.
            "URL=$(python3 -c 'import json; "
            "a=[x for x in json.load(open(\"release.json\")).get(\"assets\", []) "
            "if x.get(\"name\", \"\").endswith(\".AppImage\")]; "
            "print(a[0].get(\"url\", \"\") if a else \"\")'); "
            "[ -n \"$URL\" ]; "
            "curl -fsSL ${AUTH:+-H \"$AUTH\"} -H 'Accept: application/octet-stream' -L "
            "  \"$URL\" -o Jarvis.AppImage; "
            "chmod +x Jarvis.AppImage; "
            "rm -rf squashfs-root; "
            "./Jarvis.AppImage --appimage-extract >/dev/null"), 300.0))
        return *fail;

    // 3. systemd units (embedded verbatim from proxmox-mcp/packaging/*.service
    // — keep these two in sync if you edit either file).
    const QByteArray proxmoxMcpUnit = QByteArrayLiteral(
        "[Unit]\n"
        "Description=Proxmox-MCP (tool server for the co-located Proxmox workload-manager agent)\n"
        "After=network.target\n\n"
        "[Service]\n"
        "User=root\n"
        "WorkingDirectory=/opt/jarvis-proxmox-agent/proxmox-mcp\n"
        "Environment=PYTHONPATH=\n"
        "ExecStart=/usr/bin/env -u PYTHONPATH /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/proxmox-mcp\n"
        "Restart=on-failure\n"
        "RestartSec=2\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n");
    const QByteArray jarvisdUnit = QByteArrayLiteral(
        "[Unit]\n"
        "Description=Cindro daemon \xE2\x80\x94 Proxmox workload-manager profile (headless, Mistral/ApiBrain)\n"
        "After=network.target proxmox-mcp.service\n"
        "Requires=proxmox-mcp.service\n\n"
        "[Service]\n"
        "User=root\n"
        "Environment=QT_QPA_PLATFORM=offscreen\n"
        "Environment=JARVIS_CONFIG_DIR=/etc/jarvis-proxmox-agent/jarvisd\n"
        "Environment=JARVIS_DATA_DIR=/var/lib/jarvis-proxmox-agent/jarvisd\n"
        "Environment=LD_LIBRARY_PATH=/opt/jarvis-proxmox-agent/appimage/squashfs-root/usr/lib\n"
        "Environment=PATH=/usr/local/bin:/usr/bin:/bin\n"
        "ExecStart=/opt/jarvis-proxmox-agent/appimage/squashfs-root/usr/bin/jarvisd\n"
        "Restart=on-failure\n"
        "RestartSec=2\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n");
    bool unit1ok = false, unit2ok = false;
    const QJsonObject u1 = writeRemoteFile(machine,
        QStringLiteral("/etc/systemd/system/proxmox-mcp.service"), proxmoxMcpUnit,
        QStringLiteral("644"), &unit1ok);
    const QJsonObject u2 = writeRemoteFile(machine,
        QStringLiteral("/etc/systemd/system/jarvisd-proxmox-agent.service"), jarvisdUnit,
        QStringLiteral("644"), &unit2ok);
    const bool unitsOk = unit1ok && u1.value(QStringLiteral("ok")).toBool() &&
                        unit2ok && u2.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("outpost.install_workload"), unitsOk, QStringLiteral("high"),
                   QStringLiteral("installing proxmox workload manager onto %1: systemd units")
                       .arg(machine));
    if (!unitsOk)
        return Response::failure(req.id, QStringLiteral("install_failed"),
                                 QStringLiteral("failed writing systemd units to %1").arg(machine));

    // 4. Enable + start both. jarvisd-proxmox-agent's own first boot still
    // needs one more manual step today: seeding the schedule.create row for
    // the periodic tick (loopback-only control API — see docs).
    if (auto fail = runStep(QStringLiteral("enable+start services"), QStringLiteral(
            "systemctl daemon-reload && "
            "systemctl enable --now proxmox-mcp.service jarvisd-proxmox-agent.service"), 30.0))
        return *fail;

    // 5. Guest-agent sweep + initial scout — strictly informational: a host
    // with zero agent-capable VMs is still a complete install, so unlike
    // every step above, failures here degrade to a note, never a failure.
    QString sweepNote;
    {
        bool sok = false;
        // Ping budget: 4s per VM behind a 35s overall deadline, all inside
        // one exec that stays well under the outpost 60s wall.
        const QJsonObject sr = execOnMachine(machine, QStringLiteral(
            "python3 -c '\n"
            "import json, subprocess, time\n"
            "vms = []\n"
            "try:\n"
            "    out = subprocess.check_output([\"qm\", \"list\"], text=True, timeout=15)\n"
            "    for line in out.splitlines()[1:]:\n"
            "        parts = line.split()\n"
            "        if len(parts) >= 3 and parts[2] == \"running\":\n"
            "            vms.append(int(parts[0]))\n"
            "except Exception:\n"
            "    pass\n"
            "with_agent = 0\n"
            "deadline = time.time() + 35\n"
            "for vmid in vms:\n"
            "    if time.time() > deadline:\n"
            "        break\n"
            "    try:\n"
            "        subprocess.check_output([\"qm\", \"agent\", str(vmid), \"ping\"],\n"
            "                                stderr=subprocess.DEVNULL, timeout=4)\n"
            "        with_agent += 1\n"
            "    except Exception:\n"
            "        pass\n"
            "print(json.dumps({\"running\": len(vms), \"with_agent\": with_agent}))\n"
            "'"), 50.0, &sok);
        if (sok && sr.value(QStringLiteral("ok")).toBool()) {
            const QJsonObject sweep = QJsonDocument::fromJson(
                sr.value(QStringLiteral("output")).toString().trimmed().toUtf8()).object();
            sweepNote = QStringLiteral("%1 of %2 running VMs answered a guest-agent ping. ")
                .arg(sweep.value(QStringLiteral("with_agent")).toInt())
                .arg(sweep.value(QStringLiteral("running")).toInt());
        }
        bool kok = false;
        execOnMachine(machine, QStringLiteral(
            "setsid /usr/bin/env -u PYTHONPATH "
            "/opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/proxmox-scout "
            "--trigger install >/dev/null 2>&1 </dev/null & echo started"), 15.0, &kok);
    }
    registerProxmoxMachine(machine);

    // 6. Seed (or, on a re-install, upsert) the periodic tick schedule —
    // used to be a documented manual step ("loopback-only control API, must
    // run ON the host"), but `outpost.exec` already runs arbitrary commands
    // ON the host, so there was never a real reason a human had to do this
    // by hand. Detached like the scout kick above (not awaited): the script
    // is idempotent (upsert), jarvisd-proxmox-agent may still be finishing
    // its own startup right after `systemctl enable --now`, and waiting up
    // to 25s here for a result nobody reads a definitive answer from just
    // holds the RPC (and the live chat below) open longer for no benefit —
    // the documented manual command remains a fallback either way.
    execOnMachine(machine, QStringLiteral(
        "setsid /usr/bin/env -u PYTHONPATH /opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin/python3 "
        "/opt/jarvis-proxmox-agent/src/proxmox-mcp/packaging/seed_schedule.py "
        ">/dev/null 2>&1 </dev/null & echo started"), 15.0, nullptr);
    const QString scheduleNote = QStringLiteral(
        "Periodic schedule seed kicked off (idempotent — safe to also run "
        "seed_schedule.py by hand per docs/PROXMOX_WORKLOAD_MANAGER.md if it "
        "doesn't stick). ");

    // 7. Open a LIVE, interactive chat session (not the headless recurring
    // tick — that's the schedule row above) that scouts the fleet and
    // interviews the user right here, so installing doesn't just start a
    // silent background job the user has to go check on later. Routed at
    // proxmox-mcp exactly like the scheduled tick (scheduleTargetRef
    // "proxmox-<machine>" -> makeBrain() picks the proxmox-mcp MCP endpoint,
    // ControlServer.cpp ~1723). Best-effort: a failure here still leaves a
    // fully working install (config/services/scout/schedule are all already
    // done above) — the recurring tick will pick up any interviewing this
    // session didn't get to.
    QString sessionId, sessionTitle;
    {
        QString err;
        sessionTitle = QStringLiteral("Proxmox Scout: ") + machine;
        const QString prompt = QStringLiteral(
            "You were just installed as the Proxmox workload manager on host '%1'. This is a "
            "ONE-TIME interactive introduction (the recurring 5-minute tick is separate and "
            "already scheduled) — the user is watching this chat live. In order: "
            "1) Introduce yourself in 1-2 sentences. "
            "2) Call proxmox_scout_status — a fleet scan was already kicked off during install, "
            "so it may already be running or done; if 'idle', call proxmox_scout(full=true) "
            "yourself. Poll proxmox_scout_status a handful of times (each call shows real "
            "progress) until state is 'done'/'error', or up to about 10 polls — if it's still "
            "running after that, tell the user it's taking a while and they can watch it finish "
            "on the Outpost page, then continue anyway with whatever profiles exist so far. "
            "3) Call proxmox_list_vm_profiles and briefly summarize what you found, VM by VM "
            "(what's running, from proxmox_get_vm_profile's Observed section). "
            "4) For any VM with has_purpose=false, ask the user DIRECTLY IN THIS CHAT what it's "
            "for — a normal question, wait for their real reply as a conversation turn (do NOT "
            "call proxmox_ask_user for this; that tool is for the headless tick asking "
            "asynchronously when nobody's watching, not for this live session). When they "
            "answer, call proxmox_update_vm_profile to save it as Purpose, and if they mention "
            "how they want that VM handled, save that as Preferences too. "
            "5) Once every unclear VM is covered, tell the user you're done — from now on the "
            "background agent checks in every 5 minutes on its own and will respect what they "
            "just told you. You have no tool that can restart, stop, or start a VM — never "
            "imply otherwise.").arg(machine);
        // profile is deliberately EMPTY (-> "coder" default), matching
        // fireScheduledJob's row.profile for the recurring tick — NOT
        // "coworker", which defaults target to "agent" and spins up a whole
        // nested Sway/Wayland compositor + computer-use engine (~45-60s
        // blocking AgentDesktop::ensure()) for a session that only ever
        // calls proxmox-mcp tools and never drives a screen.
        sessionId = createSession(QString(), QStringLiteral("api"),
                                  QStringLiteral("mistral-large-latest"), QString(),
                                  sessionTitle, &err, QString(), QString(), QString(),
                                  QString(), QStringLiteral("proxmox-") + machine);
        if (sessionId.isEmpty()) {
            qWarning("outpost.install_workload: failed to open scout chat on %s: %s",
                     qPrintable(machine), qPrintable(err));
        } else if (!sendToSession(sessionId, prompt, {}, &err)) {
            qWarning("outpost.install_workload: failed to start scout chat on %s: %s",
                     qPrintable(machine), qPrintable(err));
            sessionId.clear();  // don't hand the UI a session nobody ever sent a turn to
        }
    }
    // Surfaced in the note (not just qWarning) — this is a real, user-visible
    // downgrade of what the install just promised, not a silent internal detail.
    const QString chatNote = sessionId.isEmpty()
        ? QStringLiteral("Couldn't open the live scout chat automatically — the recurring "
                        "tick will still interview you over the next few minutes. ")
        : QString();

    m_audit.record(QStringLiteral("outpost.install_workload"), true, QStringLiteral("high"),
                   QStringLiteral("installed proxmox workload manager onto %1").arg(machine));
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("machine"), machine);
    result.insert(QStringLiteral("note"),
                 QStringLiteral("proxmox-mcp + jarvisd-proxmox-agent installed and running. %1%2%3"
                               "Initial VM scout started — watch the Outpost page.")
                     .arg(sweepNote, scheduleNote, chatNote));
    if (!sessionId.isEmpty()) {
        result.insert(QStringLiteral("session_id"), sessionId);
        result.insert(QStringLiteral("session_title"), sessionTitle);
    }
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxStatus(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    // A single python3 one-liner merges all three sources into ONE JSON
    // object, parsed with one QJsonDocument::fromJson below — no text-marker
    // splitting. An earlier version glued three outputs together with
    // "---STATE---"/"---BLOCKLIST---" sentinel lines and QString::split(),
    // which would misparse if a VM/node name ever contained one of those
    // literal substrings (attacker-influenced or just an odd admin naming
    // choice) — a single JSON blob has no such ambiguity.
    const QString cmd = QStringLiteral(
        "python3 -c '\n"
        "import json, shutil, subprocess\n"
        "def safe(fn, default):\n"
        "    try:\n"
        "        return fn()\n"
        "    except Exception:\n"
        "        return default\n"
        "resources = safe(lambda: json.loads(subprocess.check_output([\"pvesh\",\"get\","
        "\"/cluster/resources\",\"--output-format\",\"json\"])), [])\n"
        "state = safe(lambda: json.load(open(\"/var/lib/jarvis-proxmox-agent/state.json\")), {})\n"
        "blocklist = safe(lambda: json.load(open(\"/etc/jarvis-proxmox-agent/blocklist.json\")), {})\n"
        "has_proxmox = bool(shutil.which(\"qm\") and shutil.which(\"pvesh\"))\n"
        "print(json.dumps({\"resources\": resources, \"state\": state, \"blocklist\": blocklist,"
        "\"has_proxmox\": has_proxmox}))\n"
        "'");
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 20.0, &ok);
    m_audit.record(QStringLiteral("proxmox.status"), ok && r.value(QStringLiteral("ok")).toBool(),
                   QStringLiteral("low"), QStringLiteral("proxmox status %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());

    const QJsonObject combined =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    const QJsonArray resourcesArr = combined.value(QStringLiteral("resources")).toArray();
    const QJsonObject stateVms =
        combined.value(QStringLiteral("state")).toObject().value(QStringLiteral("vms")).toObject();
    const QJsonObject blocklistObj = combined.value(QStringLiteral("blocklist")).toObject();
    QSet<qint64> blocklist;
    for (const QJsonValue &v : blocklistObj.value(QStringLiteral("vmids")).toArray())
        blocklist.insert(v.toVariant().toLongLong());

    QJsonArray vms;
    for (const QJsonValue &rv : resourcesArr) {
        const QJsonObject o = rv.toObject();
        if (o.value(QStringLiteral("type")).toString() != QStringLiteral("qemu"))
            continue;
        const qint64 vmid = o.value(QStringLiteral("vmid")).toVariant().toLongLong();
        const QJsonObject stEntry = stateVms.value(QString::number(vmid)).toObject();
        const double maxmem = o.value(QStringLiteral("maxmem")).toDouble();
        const double mem = o.value(QStringLiteral("mem")).toDouble();
        QJsonObject vm;
        vm.insert(QStringLiteral("vmid"), vmid);
        vm.insert(QStringLiteral("name"), o.value(QStringLiteral("name")));
        vm.insert(QStringLiteral("status"), o.value(QStringLiteral("status")));
        vm.insert(QStringLiteral("cores"), o.value(QStringLiteral("maxcpu")));
        vm.insert(QStringLiteral("memory_mb"), maxmem > 0 ? qint64(maxmem / (1024.0 * 1024.0)) : 0);
        vm.insert(QStringLiteral("cpu_pct"), o.value(QStringLiteral("cpu")).toDouble() * 100.0);
        vm.insert(QStringLiteral("mem_pct"), maxmem > 0 ? (mem / maxmem * 100.0) : 0.0);
        vm.insert(QStringLiteral("blocklisted"), blocklist.contains(vmid));
        vm.insert(QStringLiteral("pending_restart"),
                 stEntry.value(QStringLiteral("pending_restart")).toBool());
        vm.insert(QStringLiteral("last_action"), stEntry.value(QStringLiteral("last_action")));
        vm.insert(QStringLiteral("last_action_at"), stEntry.value(QStringLiteral("last_action_at")));
        vms.append(vm);
    }
    QJsonObject result;
    result.insert(QStringLiteral("vms"), vms);
    // Only register for background polling when this host actually HAS
    // qm+pvesh — the exec above succeeds (exit 0, empty resources) on ANY
    // paired machine with python3, workload manager or not, so a bare
    // "the RPC didn't fail" is not proof of anything. This self-heals the
    // notification registry for pre-existing installs without silently
    // enrolling ordinary paired laptops for a 5-minute remote-exec poll
    // with no way to un-enroll them.
    if (combined.value(QStringLiteral("has_proxmox")).toBool())
        registerProxmoxMachine(machine);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxReport(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    const QString agentName = QStringLiteral("proxmox-") + machine;

    // Watermark: the newest `created` we already have locally for this agent
    // — only pull remote rows added since then. Self-describing (no separate
    // watermark file); correct as long as a remote decision is always synced
    // strictly after it was made (always true — we can't read it earlier).
    // NOTE: sinceMs is a LOCAL insert timestamp (MemoryStore::add always
    // stamps QDateTime::currentMSecsSinceEpoch(), never a caller-supplied
    // value), not the remote row's own `created` — so two remote decisions
    // landing in the very same millisecond on pve's clock do NOT collide
    // with this watermark's granularity the way comparing remote-to-remote
    // timestamps would; the boundary this compares against is always safely
    // between "already synced" and "not yet decided" by causality.
    qint64 sinceMs = 0;
    {
        const auto latest = m_memory.search(QString(), 1, agentName, true);
        if (!latest.isEmpty())
            sinceMs = latest.first().created;
    }

    const QString cmd = QStringLiteral(
        "sqlite3 -json /var/lib/jarvis-proxmox-agent/memory.db "
        "\"SELECT text,tags,created FROM memories WHERE created > %1 ORDER BY created ASC\"")
        .arg(sinceMs);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 20.0, &ok);
    m_audit.record(QStringLiteral("proxmox.report"), ok && r.value(QStringLiteral("ok")).toBool(),
                   QStringLiteral("low"), QStringLiteral("synced+read proxmox report %1").arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());

    const QByteArray out = r.value(QStringLiteral("output")).toString().trimmed().toUtf8();
    const QJsonDocument doc = QJsonDocument::fromJson(out.isEmpty() ? QByteArrayLiteral("[]") : out);
    for (const QJsonValue &rowVal : doc.array()) {
        const QJsonObject row = rowVal.toObject();
        const QString text = row.value(QStringLiteral("text")).toString();
        if (text.trimmed().isEmpty())
            continue;
        QStringList tags;
        const QString tagsRaw = row.value(QStringLiteral("tags")).toString();
        if (!tagsRaw.isEmpty())
            tags << tagsRaw;
        m_memory.add(text, tags, QString(), QStringLiteral("agent"), agentName);
    }

    QJsonArray arr;
    for (const MemoryRow &m : m_memory.search(QString(), 50, agentName, true))
        arr.append(m.toJson());
    QJsonObject result;
    result.insert(QStringLiteral("memories"), arr);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxRestartVm(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const qint64 vmid = req.params.value(QStringLiteral("vmid")).toVariant().toLongLong();
    if (machine.trimmed().isEmpty() || vmid <= 0)
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and a positive vmid are required"));
    const QString cmd = QStringLiteral("qm reboot %1").arg(vmid);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 60.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.restart_vm"), success, QStringLiteral("high"),
                   QStringLiteral("restarted VM %1 on %2").arg(vmid).arg(machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    // pending_restart in state.json self-clears on the agent's next tick
    // (proxmox_tune re-derives it fresh whenever it next touches this VM);
    // not worth a second remote round-trip just to flip it a few minutes early.
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("vmid"), vmid);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxSetBlocklist(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    const QJsonArray vmids = req.params.value(QStringLiteral("vmids")).toArray();
    QJsonObject payload;
    payload.insert(QStringLiteral("vmids"), vmids);
    const QByteArray json = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    bool ok = false;
    const QJsonObject r = writeRemoteFile(machine,
                                          QStringLiteral("/etc/jarvis-proxmox-agent/blocklist.json"),
                                          json, QStringLiteral("644"), &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.set_blocklist"), success, QStringLiteral("medium"),
                   QStringLiteral("set blocklist on %1: %2")
                       .arg(machine, QString::fromUtf8(json)));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("vmids"), vmids);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxSendDirective(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();
    if (machine.trimmed().isEmpty() || text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and text are required"));

    QJsonObject directive;
    directive.insert(QStringLiteral("text"), text);
    directive.insert(QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch());
    const QByteArray line = QJsonDocument(directive).toJson(QJsonDocument::Compact) + "\n";
    const QString b64 = QString::fromLatin1(line.toBase64());
    // Append (not writeRemoteFile — that overwrites), same base64-over-exec
    // approach to sidestep shell-quoting the free-text directive entirely.
    const QString cmd = QStringLiteral(
        "install -d -m700 /var/lib/jarvis-proxmox-agent && "
        "printf '%1' | base64 -d >> /var/lib/jarvis-proxmox-agent/directives.jsonl")
        .arg(b64);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.send_directive"), success, QStringLiteral("medium"),
                   QStringLiteral("queued directive on %1: %2").arg(machine, text.left(120)));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    return Response::success(req.id, result);
}

// --- VM scout / profiles / questions / tasks / pinged -----------------------

namespace {
// The workload manager's install prefix on the pve host (see
// handleOutpostInstallWorkload's systemd units — keep in sync).
const QString kProxmoxVenvBin =
    QStringLiteral("/opt/jarvis-proxmox-agent/proxmox-mcp/.venv/bin");
const QString kProxmoxStateDir = QStringLiteral("/var/lib/jarvis-proxmox-agent");

// Pending questions + recent pinged events in ONE JSON blob (same
// single-blob rationale as handleProxmoxStatus — no sentinel splitting).
// Double-quotes-only inside: the whole -c body rides in sh single quotes.
QString proxmoxMailboxCmd()
{
    return QStringLiteral(
        "python3 -c '\n"
        "import json\n"
        "base = \"/var/lib/jarvis-proxmox-agent\"\n"
        "def rows(path):\n"
        "    out = []\n"
        "    try:\n"
        "        lines = open(path).read().splitlines()\n"
        "    except OSError:\n"
        "        return out\n"
        "    for line in lines:\n"
        "        line = line.strip()\n"
        "        if not line:\n"
        "            continue\n"
        "        try:\n"
        "            row = json.loads(line)\n"
        "        except ValueError:\n"
        "            continue\n"
        "        if isinstance(row, dict):\n"
        "            out.append(row)\n"
        "    return out\n"
        "answered = {r.get(\"qid\") for r in rows(base + \"/answers.jsonl\") if r.get(\"qid\")}\n"
        "questions = [r for r in rows(base + \"/questions.jsonl\")\n"
        "             if r.get(\"qid\") and r.get(\"qid\") not in answered]\n"
        "events = rows(base + \"/pinged_events.jsonl\")[-50:]\n"
        "events.reverse()\n"
        "print(json.dumps({\"questions\": questions, \"events\": events}))\n"
        "'");
}
} // namespace

Response ControlServer::handleProxmoxScout(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    QStringList vmids;
    for (const QJsonValue &v : req.params.value(QStringLiteral("vmids")).toArray()) {
        const qint64 vmid = v.toVariant().toLongLong();
        if (vmid > 0)
            vmids << QString::number(vmid);  // ints only — nothing to quote
    }
    // Detached on purpose: a fleet scan runs for minutes, outpost exec has a
    // 60s wall. Progress lands in scout_status.json; UIs poll proxmox.scout_status.
    // `setsid cmd & echo started` exits 0 regardless of whether `cmd` itself
    // exists — a shell backgrounding a nonexistent binary still succeeds at
    // forking — so the binary's presence is checked FIRST and reported
    // honestly instead of claiming success for a scan that never ran (this
    // is the real situation on any host installed before scouting shipped).
    QString cmd = QStringLiteral(
        "if [ -x %1/proxmox-scout ]; then setsid /usr/bin/env -u PYTHONPATH "
        "%1/proxmox-scout --trigger chat").arg(kProxmoxVenvBin);
    if (!vmids.isEmpty())
        cmd += QStringLiteral(" --vmids ") + vmids.join(QLatin1Char(','));
    cmd += QStringLiteral(" >/dev/null 2>&1 </dev/null & echo started; "
                          "else echo missing:proxmox-scout; fi");
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    const QString output = r.value(QStringLiteral("output")).toString().trimmed();
    const bool success = ok && r.value(QStringLiteral("ok")).toBool()
                        && output == QStringLiteral("started");
    m_audit.record(QStringLiteral("proxmox.scout"), success, QStringLiteral("medium"),
                   QStringLiteral("started VM scout on %1 (%2)")
                       .arg(machine, vmids.isEmpty() ? QStringLiteral("fleet")
                                                     : vmids.join(QLatin1Char(','))));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (output.startsWith(QStringLiteral("missing:")))
        return Response::failure(req.id, QStringLiteral("scout_not_installed"),
                                 QStringLiteral("proxmox-scout isn't installed on %1 — redeploy "
                                               "proxmox-mcp on the host (re-run "
                                               "outpost.install_workload) to pick up VM scouting")
                                     .arg(machine));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("started"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxScoutStatus(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    const QString cmd = QStringLiteral(
        "python3 -c '\n"
        "import json\n"
        "try:\n"
        "    status = json.load(open(\"/var/lib/jarvis-proxmox-agent/scout_status.json\"))\n"
        "except Exception:\n"
        "    status = {\"state\": \"idle\"}\n"
        "if not isinstance(status, dict):\n"
        "    status = {\"state\": \"idle\"}\n"
        "print(json.dumps({\"scout\": status}))\n"
        "'");
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    QJsonObject result;
    result.insert(QStringLiteral("scout"), parsed.value(QStringLiteral("scout")).toObject());
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxVmProfile(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const qint64 vmid = req.params.value(QStringLiteral("vmid")).toVariant().toLongLong();
    if (machine.trimmed().isEmpty() || vmid <= 0)
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and a positive vmid are required"));
    // vmid is a validated integer — the only interpolated value. The profile
    // text comes back JSON-wrapped, so markdown content can't confuse parsing.
    const QString cmd = QStringLiteral(
        "python3 -c '\n"
        "import json\n"
        "vmid = %1\n"
        "try:\n"
        "    text = open(\"/var/lib/jarvis-proxmox-agent/vms/\" + str(vmid) + \".md\").read()\n"
        "except OSError:\n"
        "    text = \"\"\n"
        "print(json.dumps({\"vmid\": vmid, \"exists\": bool(text), \"profile\": text}))\n"
        "'").arg(vmid);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    return Response::success(req.id, parsed);
}

Response ControlServer::handleProxmoxQuestions(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, proxmoxMailboxCmd(), 15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    const QJsonArray questions = parsed.value(QStringLiteral("questions")).toArray();
    // Deliberately does NOT mark these seen: the design is "Outpost page +
    // inbox ping", not "page suppresses the ping" — a user who leaves a
    // dashboard open on this page must still get notified within the next
    // 5-minute mailbox poll, not silently never. Same reasoning as
    // handleProxmoxPingedList below. Also deliberately does NOT
    // registerProxmoxMachine: unlike proxmox.status (backed by a real
    // qm/pvesh check), this exec succeeds on any machine with python3, so
    // it proves nothing about whether the workload manager is installed.
    QJsonObject result;
    result.insert(QStringLiteral("questions"), questions);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxAnswer(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString qid = req.params.value(QStringLiteral("qid")).toString();
    const QString answer = req.params.value(QStringLiteral("answer")).toString();
    if (machine.trimmed().isEmpty() || qid.trimmed().isEmpty() || answer.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine, qid and answer are required"));
    QJsonObject row;
    row.insert(QStringLiteral("qid"), qid);
    row.insert(QStringLiteral("answer"), answer);
    row.insert(QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch());
    const QByteArray line = QJsonDocument(row).toJson(QJsonDocument::Compact) + "\n";
    const QString b64 = QString::fromLatin1(line.toBase64());
    // Same append-over-base64 as send_directive: qid/answer are free text and
    // must never ride inline in a shell command.
    const QString cmd = QStringLiteral(
        "install -d -m700 %1 && printf '%2' | base64 -d >> %1/answers.jsonl")
        .arg(kProxmoxStateDir, b64);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.answer"), success, QStringLiteral("medium"),
                   QStringLiteral("answered %1 on %2: %3").arg(qid, machine, answer.left(120)));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    markProxmoxSeen({machine + QLatin1Char(':') + qid});
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("qid"), qid);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxAskAgent(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString text = req.params.value(QStringLiteral("text")).toString();
    QString kind = req.params.value(QStringLiteral("kind")).toString();
    if (kind != QStringLiteral("task"))
        kind = QStringLiteral("ask");
    if (machine.trimmed().isEmpty() || text.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and text are required"));
    const QString rid = QStringLiteral("t-%1-%2")
        .arg(QDateTime::currentMSecsSinceEpoch())
        .arg(QRandomGenerator::system()->bounded(0x10000), 4, 16, QLatin1Char('0'));
    QJsonObject row;
    row.insert(QStringLiteral("rid"), rid);
    row.insert(QStringLiteral("kind"), kind);
    row.insert(QStringLiteral("text"), text);
    row.insert(QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch());
    const QByteArray line = QJsonDocument(row).toJson(QJsonDocument::Compact) + "\n";
    const QString b64 = QString::fromLatin1(line.toBase64());
    // Queue the task, then best-effort kick the agent's schedule to run NOW
    // (proxmox-agent-kick -> loopback schedule.run_now on the pve jarvisd).
    // The trailing `; echo queued` keeps exit 0 even when the kick binary is
    // missing (pre-upgrade install) — the tick picks the task up within 5min.
    const QString cmd = QStringLiteral(
        "install -d -m700 %1 && printf '%2' | base64 -d >> %1/agent_tasks.jsonl && "
        "{ setsid /usr/bin/env -u PYTHONPATH %3/proxmox-agent-kick "
        ">/dev/null 2>&1 </dev/null & } ; echo queued")
        .arg(kProxmoxStateDir, b64, kProxmoxVenvBin);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.ask_agent"), success, QStringLiteral("medium"),
                   QStringLiteral("asked agent on %1 (%2): %3")
                       .arg(machine, kind, text.left(120)));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    // Deliberately no registerProxmoxMachine here — appending a jsonl line
    // succeeds on any host with a writable filesystem, so it proves nothing
    // about whether the workload manager is installed (see handleProxmoxStatus).
    QJsonObject result;
    result.insert(QStringLiteral("ok"), true);
    result.insert(QStringLiteral("rid"), rid);
    result.insert(QStringLiteral("kick_started"), true);
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxAgentReply(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString rid = req.params.value(QStringLiteral("rid")).toString();
    if (machine.trimmed().isEmpty() || rid.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and rid are required"));
    // Fetch ALL replies and filter here — rid is caller-supplied free text
    // and must never be interpolated into the remote command.
    const QString cmd = QStringLiteral(
        "python3 -c '\n"
        "import json\n"
        "out = []\n"
        "try:\n"
        "    lines = open(\"/var/lib/jarvis-proxmox-agent/agent_replies.jsonl\").read().splitlines()\n"
        "except OSError:\n"
        "    lines = []\n"
        "for line in lines:\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    try:\n"
        "        row = json.loads(line)\n"
        "    except ValueError:\n"
        "        continue\n"
        "    if isinstance(row, dict):\n"
        "        out.append(row)\n"
        "print(json.dumps({\"replies\": out}))\n"
        "'");
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    QJsonObject result;
    result.insert(QStringLiteral("rid"), rid);
    result.insert(QStringLiteral("pending"), true);
    for (const QJsonValue &rv : parsed.value(QStringLiteral("replies")).toArray()) {
        const QJsonObject row = rv.toObject();
        if (row.value(QStringLiteral("rid")).toString() != rid)
            continue;
        result.insert(QStringLiteral("pending"), false);
        result.insert(QStringLiteral("reply"), row.value(QStringLiteral("reply")));
        result.insert(QStringLiteral("replied_at"), row.value(QStringLiteral("at")));
    }
    return Response::success(req.id, result);
}

Response ControlServer::handleProxmoxPingedList(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    if (machine.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine is required"));
    const QString cmd = QStringLiteral(
        "python3 -c '\n"
        "import json\n"
        "base = \"/var/lib/jarvis-proxmox-agent\"\n"
        "try:\n"
        "    rules = json.load(open(base + \"/pinged.json\")).get(\"rules\", [])\n"
        "except Exception:\n"
        "    rules = []\n"
        "events = []\n"
        "try:\n"
        "    lines = open(base + \"/pinged_events.jsonl\").read().splitlines()\n"
        "except OSError:\n"
        "    lines = []\n"
        "for line in lines[-50:]:\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    try:\n"
        "        row = json.loads(line)\n"
        "    except ValueError:\n"
        "        continue\n"
        "    if isinstance(row, dict):\n"
        "        events.append(row)\n"
        "events.reverse()\n"
        "print(json.dumps({\"rules\": rules, \"events\": events}))\n"
        "'");
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 15.0, &ok);
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!r.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    // Deliberately does NOT mark events seen here — same reasoning as
    // handleProxmoxQuestions: a dashboard left open on this page must not
    // silently suppress the promised inbox ping for a newly-fired rule.
    QJsonObject result;
    result.insert(QStringLiteral("rules"), parsed.value(QStringLiteral("rules")).toArray());
    result.insert(QStringLiteral("events"), parsed.value(QStringLiteral("events")).toArray());
    return Response::success(req.id, result);
}

// pinged_add / pinged_remove ship their payload as a base64 JSON file and run
// the HOST's own pinged_store through the workload venv — one validator (the
// same one the agent's tools use), not a C++ re-implementation that drifts.
Response ControlServer::handleProxmoxPingedAdd(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString name = req.params.value(QStringLiteral("name")).toString();
    const QString action = req.params.value(QStringLiteral("action")).toString();
    if (machine.trimmed().isEmpty() || name.trimmed().isEmpty() || action.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine, name and action are required"));
    QJsonObject payload;
    payload.insert(QStringLiteral("name"), name);
    payload.insert(QStringLiteral("action"), action);
    payload.insert(QStringLiteral("vmid"),
                  req.params.value(QStringLiteral("vmid")).toVariant().toLongLong());
    payload.insert(QStringLiteral("condition"),
                  req.params.value(QStringLiteral("condition")).toString());
    payload.insert(QStringLiteral("time"), req.params.value(QStringLiteral("time")).toString());
    const QString b64 = QString::fromLatin1(
        QJsonDocument(payload).toJson(QJsonDocument::Compact).toBase64());
    const QString cmd = QStringLiteral(
        "install -d -m700 %1 && T=$(mktemp %1/.pinged_add.XXXXXX) && "
        "printf '%2' | base64 -d > \"$T\" && "
        "JARVIS_PINGED_PAYLOAD=\"$T\" /usr/bin/env -u PYTHONPATH %3/python3 -c '\n"
        "import json, os, time\n"
        "path = os.environ[\"JARVIS_PINGED_PAYLOAD\"]\n"
        "req = json.load(open(path))\n"
        "os.unlink(path)\n"
        "from proxmox_mcp import config, pinged_store\n"
        "print(json.dumps(pinged_store.add_rule(config.PINGED_FILE,\n"
        "    name=str(req.get(\"name\", \"\")), action=str(req.get(\"action\", \"\")),\n"
        "    vmid=int(req.get(\"vmid\", 0) or 0),\n"
        "    condition=str(req.get(\"condition\", \"\")),\n"
        "    time_of_day=str(req.get(\"time\", \"\")),\n"
        "    now_ms=int(time.time() * 1000))))\n"
        "'").arg(kProxmoxStateDir, b64, kProxmoxVenvBin);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 20.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.pinged_add"), success, QStringLiteral("medium"),
                   QStringLiteral("added pinged rule '%1' on %2").arg(name, machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    if (!parsed.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 parsed.value(QStringLiteral("error")).toString());
    // Deliberately no registerProxmoxMachine here — see handleProxmoxStatus,
    // the sole source of truth for "this machine actually runs the workload
    // manager" (install_workload registers directly, already preflighted).
    return Response::success(req.id, parsed);
}

Response ControlServer::handleProxmoxPingedRemove(const Request &req)
{
    const QString machine = req.params.value(QStringLiteral("machine")).toString();
    const QString ruleId = req.params.value(QStringLiteral("rule_id")).toString();
    if (machine.trimmed().isEmpty() || ruleId.trimmed().isEmpty())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 QStringLiteral("machine and rule_id are required"));
    QJsonObject payload;
    payload.insert(QStringLiteral("id"), ruleId);
    const QString b64 = QString::fromLatin1(
        QJsonDocument(payload).toJson(QJsonDocument::Compact).toBase64());
    const QString cmd = QStringLiteral(
        "install -d -m700 %1 && T=$(mktemp %1/.pinged_rm.XXXXXX) && "
        "printf '%2' | base64 -d > \"$T\" && "
        "JARVIS_PINGED_PAYLOAD=\"$T\" /usr/bin/env -u PYTHONPATH %3/python3 -c '\n"
        "import json, os\n"
        "path = os.environ[\"JARVIS_PINGED_PAYLOAD\"]\n"
        "req = json.load(open(path))\n"
        "os.unlink(path)\n"
        "from proxmox_mcp import config, pinged_store\n"
        "print(json.dumps(pinged_store.remove_rule(config.PINGED_FILE, str(req.get(\"id\", \"\")))))\n"
        "'").arg(kProxmoxStateDir, b64, kProxmoxVenvBin);
    bool ok = false;
    const QJsonObject r = execOnMachine(machine, cmd, 20.0, &ok);
    const bool success = ok && r.value(QStringLiteral("ok")).toBool();
    m_audit.record(QStringLiteral("proxmox.pinged_remove"), success, QStringLiteral("medium"),
                   QStringLiteral("removed pinged rule %1 on %2").arg(ruleId, machine));
    if (!ok)
        return Response::failure(req.id, QStringLiteral("outpost_unreachable"),
                                 QStringLiteral("outpost-mcp (:%1) unreachable").arg(outpostPort()));
    if (!success)
        return Response::failure(req.id, QStringLiteral("exec_failed"),
                                 r.value(QStringLiteral("error")).toString());
    const QJsonObject parsed =
        QJsonDocument::fromJson(r.value(QStringLiteral("output")).toString().trimmed().toUtf8())
            .object();
    if (!parsed.value(QStringLiteral("ok")).toBool())
        return Response::failure(req.id, QStringLiteral("bad_request"),
                                 parsed.value(QStringLiteral("error")).toString());
    return Response::success(req.id, parsed);
}

// --- proxmox notification plumbing ------------------------------------------

void ControlServer::registerProxmoxMachine(const QString &machine)
{
    if (machine.trimmed().isEmpty())
        return;
    const QString path = jarvis::dataDir() + QStringLiteral("/proxmox_machines.json");
    QStringList machines;
    {
        QFile f(path);
        if (f.open(QIODevice::ReadOnly)) {
            for (const QJsonValue &v : QJsonDocument::fromJson(f.readAll())
                                           .object().value(QStringLiteral("machines")).toArray())
                machines << v.toString();
        }
    }
    if (machines.contains(machine))
        return;
    machines << machine;
    QJsonObject obj;
    obj.insert(QStringLiteral("machines"), QJsonArray::fromStringList(machines));
    QDir().mkpath(jarvis::dataDir());
    QFile f(path);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        f.write(QJsonDocument(obj).toJson(QJsonDocument::Compact));
}

void ControlServer::markProxmoxSeen(const QStringList &keys)
{
    if (keys.isEmpty())
        return;
    const QString path = jarvis::dataDir() + QStringLiteral("/proxmox_seen_notifications.json");
    QSet<QString> seen;
    {
        QFile f(path);
        if (f.open(QIODevice::ReadOnly)) {
            for (const QJsonValue &v : QJsonDocument::fromJson(f.readAll())
                                           .object().value(QStringLiteral("keys")).toArray())
                seen.insert(v.toString());
        }
    }
    const int before = seen.size();
    for (const QString &k : keys)
        if (!k.endsWith(QLatin1Char(':')))
            seen.insert(k);
    if (seen.size() == before)
        return;
    QJsonArray arr;
    for (const QString &k : std::as_const(seen))
        arr.append(k);
    QJsonObject obj;
    obj.insert(QStringLiteral("keys"), arr);
    QDir().mkpath(jarvis::dataDir());
    QFile f(path);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        f.write(QJsonDocument(obj).toJson(QJsonDocument::Compact));
}

bool ControlServer::phoneNotifyUser(const QString &title, const QString &message)
{
    // Route through the existing phone.mcp proxy (the bearer stays in the
    // daemon); notify_user lands in the Jarvis inbox on every surface.
    Request req;
    req.id = 0;
    req.method = QStringLiteral("phone.mcp");
    QJsonObject args;
    args.insert(QStringLiteral("title"), title);
    args.insert(QStringLiteral("message"), message);
    QJsonObject params;
    params.insert(QStringLiteral("name"), QStringLiteral("notify_user"));
    params.insert(QStringLiteral("arguments"), args);
    req.params = params;
    return handlePhoneMcp(req).ok;
}

void ControlServer::pollProxmoxMailboxes()
{
    QStringList machines;
    {
        QFile f(jarvis::dataDir() + QStringLiteral("/proxmox_machines.json"));
        if (f.open(QIODevice::ReadOnly)) {
            for (const QJsonValue &v : QJsonDocument::fromJson(f.readAll())
                                           .object().value(QStringLiteral("machines")).toArray()) {
                const QString m = v.toString();
                if (!m.trimmed().isEmpty())
                    machines << m;
            }
        }
    }
    if (machines.isEmpty())
        return;

    const QString seenPath = jarvis::dataDir() + QStringLiteral("/proxmox_seen_notifications.json");
    QSet<QString> seen;
    {
        QFile f(seenPath);
        if (f.open(QIODevice::ReadOnly)) {
            for (const QJsonValue &v : QJsonDocument::fromJson(f.readAll())
                                           .object().value(QStringLiteral("keys")).toArray())
                seen.insert(v.toString());
        }
    }

    QSet<QString> live;          // keys still visible on a machine we reached
    QSet<QString> polledPrefixes; // "machine:" prefixes we successfully polled
    bool changed = false;
    for (const QString &machine : std::as_const(machines)) {
        bool ok = false;
        const QJsonObject r = execOnMachine(machine, proxmoxMailboxCmd(), 15.0, &ok);
        if (!ok || !r.value(QStringLiteral("ok")).toBool())
            continue;  // unreachable now -> keep its seen keys, retry next poll
        const QJsonObject parsed = QJsonDocument::fromJson(
            r.value(QStringLiteral("output")).toString().trimmed().toUtf8()).object();
        polledPrefixes.insert(machine + QLatin1Char(':'));

        for (const QJsonValue &qv : parsed.value(QStringLiteral("questions")).toArray()) {
            const QJsonObject q = qv.toObject();
            const QString qid = q.value(QStringLiteral("qid")).toString();
            if (qid.isEmpty())
                continue;
            const QString key = machine + QLatin1Char(':') + qid;
            live.insert(key);
            if (seen.contains(key))
                continue;
            const qint64 vmid = q.value(QStringLiteral("vmid")).toVariant().toLongLong();
            const QString where = vmid > 0 ? QStringLiteral("VM %1: ").arg(vmid) : QString();
            phoneNotifyUser(QStringLiteral("Proxmox agent question (%1)").arg(machine),
                            where + q.value(QStringLiteral("question")).toString()
                                + QStringLiteral("\nAnswer it on the Outpost page."));
            seen.insert(key);
            changed = true;
        }
        for (const QJsonValue &ev : parsed.value(QStringLiteral("events")).toArray()) {
            const QJsonObject e = ev.toObject();
            const QString eid = e.value(QStringLiteral("eid")).toString();
            if (eid.isEmpty())
                continue;
            const QString key = machine + QLatin1Char(':') + eid;
            live.insert(key);
            if (seen.contains(key))
                continue;
            const qint64 vmid = e.value(QStringLiteral("vmid")).toVariant().toLongLong();
            const QString where = vmid > 0 ? QStringLiteral(" on VM %1").arg(vmid) : QString();
            phoneNotifyUser(QStringLiteral("Pinged fired (%1)").arg(machine),
                            QStringLiteral("'%1'%2: %3")
                                .arg(e.value(QStringLiteral("name")).toString(), where,
                                     e.value(QStringLiteral("result")).toString()));
            seen.insert(key);
            changed = true;
        }
    }

    // Prune seen keys that are gone from machines we actually reached —
    // answered questions and events that scrolled out of the last-50 window
    // can never ping again, so dropping them keeps the file bounded.
    QSet<QString> pruned;
    for (const QString &key : std::as_const(seen)) {
        bool belongsToPolled = false;
        for (const QString &prefix : std::as_const(polledPrefixes)) {
            if (key.startsWith(prefix)) {
                belongsToPolled = true;
                break;
            }
        }
        if (!belongsToPolled || live.contains(key))
            pruned.insert(key);
        else
            changed = true;
    }
    if (!changed)
        return;
    QJsonArray arr;
    for (const QString &k : std::as_const(pruned))
        arr.append(k);
    QJsonObject obj;
    obj.insert(QStringLiteral("keys"), arr);
    QDir().mkpath(jarvis::dataDir());
    QFile f(seenPath);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        f.write(QJsonDocument(obj).toJson(QJsonDocument::Compact));
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
        // Random, registry-tracked approval id (same anti-forgery rationale as
        // requestTakeOver) so only a genuinely-pending id can release the held turn.
        reapPendingApprovals(sessionId, QStringLiteral("inject"));
        const QString approvalId = genApprovalId(QStringLiteral("inject"));
        m_pendingApprovals.insert(
            approvalId, PendingApproval{sessionId, QStringLiteral("inject"),
                                        QDateTime::currentMSecsSinceEpoch() + kApprovalTtlMs});
        NormalizedBrainEvent ev = NormalizedBrainEvent::approval(
            approvalId, scan.summary(), scan.risk);
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
                QStringLiteral("Cindro needs your approval")),
            sessionId);
        // Audit the brain-emitted approval (computer-use / take-over etc.).
        m_audit.record(QStringLiteral("approval"), true,
                       ev.fields.value(QStringLiteral("risk")).toString(QStringLiteral("high")),
                       ev.fields.value(QStringLiteral("summary")).toString(), sessionId);
    } else if (ev.kind == NormalizedBrainEvent::Kind::Final) {
        // Only TOP-LEVEL sessions raise the OS "task done" toast. A subagent
        // finishing already wakes its parent with a [SUBAGENT DONE] summary
        // (wakeParentForSubagent); toasting each child too spammed the desktop
        // with raw session ids for internal agents the user never launched.
        if (auto r = m_store.get(sessionId); !r || r->parentSessionId.isEmpty())
            m_notify.taskDone(QStringLiteral("Session ") + sessionId
                              + QStringLiteral(" finished a turn."));
        // Notification hook (observational).
        QJsonObject nh;
        nh.insert(QStringLiteral("session_id"), sessionId);
        nh.insert(QStringLiteral("message"), QStringLiteral("turn finished"));
        m_hooks.run(QStringLiteral("Notification"), nh, QStringLiteral("turn_complete"));
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
        // PreToolUse hook (observational: the brain's CLI executes MCP tools
        // itself, so this is a side-effect callback, not an abort point). The
        // matcher routes on the tool name. No-op unless configured.
        QJsonObject ptu;
        ptu.insert(QStringLiteral("session_id"), sessionId);
        ptu.insert(QStringLiteral("tool_name"), name);
        ptu.insert(QStringLiteral("tool_input"), args);
        m_hooks.run(QStringLiteral("PreToolUse"), ptu, name);
        // Tool-loop guardrail: remember the call so its ToolResult can be
        // paired even when the parser omits name/args on the result event.
        m_lastToolCall.insert(sessionId, PendingToolCall{name, argsStr});
    } else if (ev.kind == NormalizedBrainEvent::Kind::ToolResult) {
        // PostToolUse hook (observational).
        QJsonObject po;
        po.insert(QStringLiteral("session_id"), sessionId);
        po.insert(QStringLiteral("tool_result"), ev.fields.value(QStringLiteral("output")));
        m_hooks.run(QStringLiteral("PostToolUse"), po);
        observeToolLoop(sessionId, ev);
    }

    broadcastSessionEvent(sessionId, ev);

    // Fan the (already-persisted) event out to the device channel + push.
    emit sessionEvent(sessionId, ev);
}

// Tool-loop guardrail (jarvis#76 item 4): pair a ToolResult with its ToolCall,
// feed the (tool, args, result) triple into the per-session repeat window, and
// act on the verdict. Soft warn -> queue a next-turn nudge (CLI brains cannot
// be interrupted mid-loop); hard stop -> surface an error card + cancel the
// turn, leaving a guardrail turn queued so the brain resumes with guidance.
void ControlServer::observeToolLoop(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    // Prefer the result's own name/args (codex emits completed calls as one
    // item); fall back to the cached preceding ToolCall.
    QString name = ev.fields.value(QStringLiteral("name")).toString();
    QString argsStr;
    if (ev.fields.contains(QStringLiteral("args"))) {
        argsStr = QString::fromUtf8(
            QJsonDocument(ev.fields.value(QStringLiteral("args")).toObject())
                .toJson(QJsonDocument::Compact));
    }
    if (name.isEmpty()) {
        const PendingToolCall tc = m_lastToolCall.value(sessionId);
        if (tc.name.isEmpty())
            return; // result without a known call (e.g. resume mid-turn) — skip
        name = tc.name;
        if (argsStr.isEmpty())
            argsStr = tc.argsJson;
    }

    const QString output = ev.fields.value(QStringLiteral("output")).toString();
    const ToolLoopGuard::Result verdict =
        ToolLoopGuard::observe(m_toolLoop[sessionId], name, argsStr, output);

    if (verdict.hardStop) {
        const QString warnText = QStringLiteral(
            "[TOOL LOOP GUARDRAIL] This turn was hard-stopped: '%1' was called %2 "
            "times with identical arguments and no new outcome. Do NOT retry the "
            "same call again — reassess, explain what is failing, and either try a "
            "genuinely different approach or ask the user how to proceed.")
            .arg(verdict.toolName).arg(verdict.repeatCount);
        // Queue the guardrail turn FIRST (overwriting any queued turn — safety
        // beats a lost follow-up here), then clear the window so the resumed
        // turn starts clean.
        m_pendingTurns.insert(sessionId, HeldTurn{warnText, {}});
        m_toolLoop.remove(sessionId);
        m_lastToolCall.remove(sessionId);
        m_toolLoopWarned.remove(sessionId);
        m_audit.record(QStringLiteral("tool.loop.stop"), false, QStringLiteral("high"),
                       QStringLiteral("hard-stop: ") + verdict.toolName
                           + QStringLiteral(" x") + QString::number(verdict.repeatCount),
                       sessionId);
        // Surface an error card immediately (persist + broadcast), then cancel
        // the brain one event-loop tick later to avoid re-entering the Qt
        // signal dispatch we are currently inside.
        onBrainEvent(sessionId,
                     NormalizedBrainEvent::error(QStringLiteral(
                         "Tool loop guard: %1 repeated %2 times — turn stopped")
                         .arg(verdict.toolName).arg(verdict.repeatCount)));
        m_toolLoopStopping.insert(sessionId);
        QTimer::singleShot(0, this, [this, sessionId] {
            // Only cancel if the looping turn is STILL the live one — a user
            // cancel racing in ahead of this tick already ended it (and may
            // have flushed the guardrail turn, which must not be killed).
            if (!m_toolLoopStopping.remove(sessionId))
                return;
            if (Brain *b = m_brains.value(sessionId, nullptr))
                b->cancel(); // fires turnFinished -> flushes the queued guardrail turn
        });
        qWarning("jarvisd: tool-loop hard-stop for session %s (%s x%d)",
                 qPrintable(sessionId), qPrintable(verdict.toolName),
                 verdict.repeatCount);
    } else if (verdict.softWarn && !m_toolLoopWarned.contains(sessionId)) {
        m_toolLoopWarned.insert(sessionId);
        m_audit.record(QStringLiteral("tool.loop.warn"), true, QStringLiteral("medium"),
                       QStringLiteral("soft-warn: ") + verdict.toolName
                           + QStringLiteral(" x") + QString::number(verdict.repeatCount),
                       sessionId);
        // Nudge the brain on its NEXT turn — but never clobber a turn the user
        // already queued (m_pendingTurns is a single slot per session).
        if (!m_pendingTurns.contains(sessionId)) {
            const QString warnText = QStringLiteral(
                "[TOOL LOOP WARNING] '%1' has now been called %2 times with the "
                "same arguments and result. If the next attempt does not produce "
                "a different outcome, stop retrying and change approach.")
                .arg(verdict.toolName).arg(verdict.repeatCount);
            QString wErr;
            sendToSession(sessionId, warnText, {}, &wErr);
        }
    }
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
