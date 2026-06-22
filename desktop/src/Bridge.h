#pragma once

#include <QObject>
#include <QHash>
#include <QString>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

class QWebSocket;

// Bridge: owns the Contract A control WebSocket to jarvisd.
//
//   ws://127.0.0.1:8795/control/ws?token=<~/.config/jarvis/control_token>
//
// Contract A messages are single JSON objects:
//   Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
//   Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
//             {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
//   Event:    {"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}
//
// Contract B NormalizedBrainEvent is delivered to QML via sessionEvent(QVariantMap)
// with the session_id folded in under "session_id".
class Bridge : public QObject
{
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(bool connected READ isConnected NOTIFY connectedChanged)
    Q_PROPERTY(QString sessionId READ sessionId NOTIFY sessionIdChanged)
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)

public:
    explicit Bridge(QObject *parent = nullptr);
    ~Bridge() override;

    bool isConnected() const { return m_connected; }
    QString sessionId() const { return m_sessionId; }
    QString status() const { return m_status; }

    // Establish (or re-establish) the control WebSocket connection.
    Q_INVOKABLE void connectToDaemon();

    // session.create -> stashes the returned session_id on success.
    Q_INVOKABLE void createSession(const QString &profile,
                                   const QString &brain,
                                   const QString &model);

    // session.send for the current session.
    Q_INVOKABLE void sendMessage(const QString &text);

    // session.cancel for the current session.
    Q_INVOKABLE void cancelSession();

    // approval.respond { decision: allow|deny|always }.
    Q_INVOKABLE void respondApproval(const QString &approvalId, const QString &decision);

    // model.list { brain } -> emits modelsListed on response.
    Q_INVOKABLE void listModels(const QString &brain);

signals:
    void connectedChanged();
    void sessionIdChanged();
    void statusChanged();

    // A NormalizedBrainEvent (Contract B) for a session, with session_id folded in.
    void sessionEvent(const QVariantMap &event);

    // Result of model.list.
    void modelsListed(const QString &brain, const QStringList &models);

    // Surfaced protocol/transport errors for the UI.
    void errorOccurred(const QString &message);

private slots:
    void onConnected();
    void onDisconnected();
    void onTextMessageReceived(const QString &message);
    void onSocketError();

private:
    int nextId();
    void send(const QString &method, const QVariantMap &params, int id);
    int request(const QString &method, const QVariantMap &params);
    void setStatus(const QString &s);
    void handleResponse(int id, bool ok, const QVariantMap &result, const QVariantMap &error);

    static QString readControlToken();
    static QString controlUrl();

    QWebSocket *m_socket = nullptr;
    bool m_connected = false;
    int m_idCounter = 0;
    QString m_sessionId;
    QString m_status = QStringLiteral("disconnected");

    // Maps request id -> the method that originated it, so responses can be routed.
    QHash<int, QString> m_pending;
};
