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
#include "jarvis/Protocol.h"
#include "jarvis/SessionStore.h"

#include <QHash>
#include <QObject>
#include <QSet>
#include <QString>

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

    // Create + wire a brain for a session row. Returns nullptr on unknown brain.
    Brain *makeBrain(const SessionRow &row);

    Config m_config;
    QString m_controlToken;
    QString m_lastError;

    QWebSocketServer *m_wsServer = nullptr;
    SessionStore m_store;

    // Authenticated client sockets (all are subscribed to session events).
    QSet<QWebSocket *> m_clients;
    // sessionId -> live brain.
    QHash<QString, Brain *> m_brains;
};

} // namespace jarvis
