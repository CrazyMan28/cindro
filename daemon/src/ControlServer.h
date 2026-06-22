#pragma once

// Contract A control server: a loopback-only WebSocket endpoint that the
// desktop sidebar (and later other same-user clients) use to drive sessions.
//
//   ws://127.0.0.1:<port>/control/ws?token=<control_token>
//
// The server owns the SessionStore and the live Brain instances, dispatches
// the v1 request methods, and fans NormalizedBrainEvents out to subscribed
// sockets as session.event frames.

#include "jarvis/Config.h"
#include "jarvis/DeviceRegistry.h"
#include "jarvis/FcmSender.h"
#include "jarvis/McpRegistry.h"
#include "jarvis/PairingManager.h"
#include "jarvis/PluginRegistry.h"
#include "jarvis/Protocol.h"
#include "jarvis/SessionStore.h"
#include "jarvis/SettingsStore.h"

#include <QHash>
#include <QObject>
#include <QSet>
#include <QString>
#include <memory>

QT_BEGIN_NAMESPACE
class QWebSocketServer;
class QWebSocket;
QT_END_NAMESPACE

namespace jarvis {

class Brain;

class ControlServer : public QObject {
    Q_OBJECT
public:
    ControlServer(Config config, QString controlToken, QObject *parent = nullptr);
    ~ControlServer() override;

    // Open the SQLite store and start listening on 127.0.0.1:<control_port>.
    // Returns false on failure (see lastError()).
    bool start();
    QString lastError() const { return m_lastError; }

    // --- shared machinery exposed to the device channel (Contract C) -------
    // The DeviceServer reuses the SAME store/brains/registries so a phone and
    // the desktop drive one coherent session world.
    SessionStore &store() { return m_store; }
    DeviceRegistry &devices() { return m_deviceReg; }
    PairingManager &pairing() { return m_pairing; }
    FcmSender *fcm() { return m_fcm.get(); }

    // Create a session row + live brain (shared with handleSessionCreate). On
    // success returns the new session id; on failure returns empty and sets
    // *err. `cwd` empty => default.
    QString createSession(const QString &profile, const QString &brain,
                          const QString &model, const QString &cwd,
                          const QString &title, QString *err);
    // Send a user turn into an existing live session. False if unknown/inactive.
    bool sendToSession(const QString &sessionId, const QString &text,
                       const QStringList &images, QString *err);
    bool cancelSession(const QString &sessionId, QString *err);
    bool respondApprovalFor(const QString &sessionId, const QString &approvalId,
                            const QString &decision, QString *err);

    // The tailnet (tailscale0) IPv4 address, or 127.0.0.1 if none — the host the
    // phone dials in the pairing payload and the device WS binds.
    static QString tailnetHost();

signals:
    // Fired after every brain event is persisted (Contract C device fan-out).
    void sessionEvent(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);

private slots:
    void onNewConnection();
    void onTextMessage(const QString &message);
    void onSocketDisconnected();
    void onBrainEvent(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);

private:
    void handleRequest(QWebSocket *client, const Request &req);
    void sendResponse(QWebSocket *client, const Response &resp);
    void broadcastSessionEvent(const QString &sessionId, const NormalizedBrainEvent &ev);

    // Method handlers return a Response for the request id.
    Response handlePing(const Request &req);
    Response handleSettingsGet(const Request &req);
    Response handleSettingsSet(const Request &req);
    Response handleModelList(const Request &req);
    Response handleSessionCreate(const Request &req);
    Response handleSessionSend(const Request &req);
    Response handleSessionCancel(const Request &req);
    Response handleSessionList(const Request &req);
    Response handleSessionHistory(const Request &req);
    Response handleApprovalRespond(const Request &req);

    // Contract A v2 handlers.
    Response handleMcpList(const Request &req);
    Response handleMcpAdd(const Request &req);
    Response handleMcpRemove(const Request &req);
    Response handleMcpSetEnabled(const Request &req);
    Response handleMcpTest(const Request &req);
    Response handlePluginsCatalog(const Request &req);
    Response handlePluginsInstall(const Request &req);
    Response handlePluginsSetEnabled(const Request &req);
    Response handlePluginsRemove(const Request &req);

    // Contract A v2 device pairing/management (surfaced in desktop Settings).
    Response handleDevicesPairStart(const Request &req);
    Response handleDevicesList(const Request &req);
    Response handleDevicesRevoke(const Request &req);

    // Create + wire a brain for a session row. Returns nullptr on unknown brain.
    Brain *makeBrain(const SessionRow &row);

    Config m_config;
    QString m_controlToken;
    QString m_lastError;

    QWebSocketServer *m_wsServer = nullptr;
    SessionStore m_store;

    // Contract A v2 domain stores/registries. SettingsStore owns config.toml
    // prefs + secrets.json; the registries wrap the SessionStore SQLite tables
    // and own the non-storage behavior (real MCP test, codex injection, catalog
    // parsing). Created in start() once m_store is open.
    SettingsStore m_settings;
    std::unique_ptr<McpRegistry> m_mcp;
    std::unique_ptr<PluginRegistry> m_plugins;

    // Contract C shared machinery: paired-device store + daemon ed25519
    // identity, short-lived pairing codes, and the FCM push sender. Owned here
    // and reused by the DeviceServer.
    DeviceRegistry m_deviceReg;
    PairingManager m_pairing;
    std::unique_ptr<FcmSender> m_fcm;

    // Authenticated client sockets (all are subscribed to session events).
    QSet<QWebSocket *> m_clients;
    // sessionId -> live brain.
    QHash<QString, Brain *> m_brains;
};

} // namespace jarvis
