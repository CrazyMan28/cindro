#pragma once

// Contract C device channel: a WebSocket server the phone connects to.
//
//   ws://<host>:<device_port>/device/ws   (host = 127.0.0.1 AND the tailnet IP)
//
// Handshake:
//   device -> {hello, device_pubkey(ed25519 base64), name, pair_code?}
//   - pair_code present + matches an active devices.pair_start code:
//       daemon stores the pubkey (DeviceRegistry / devices.json 0600), acks
//       {ok, paired:true, device_id, fp}. Session is then AUTHED.
//   - no pair_code (already-paired device):
//       daemon -> {challenge:nonce(base64)}
//       device -> {sig: ed25519_sign(nonce) base64}
//       daemon verifies against the stored pubkey (libsodium); on success the
//       session is AUTHED, else the socket is closed.
//
// Authed methods share the Contract A request/response envelope:
//   session.list / session.create / session.send (text + images[{mime,b64}]) /
//   session.history / session.cancel, task.queue{text,when?} / task.list,
//   push.register{fcm_token}, approval.respond.
//
// Capability tiers tag each method: read | action | biometric. The phone gates
// 'biometric' behind a device BiometricPrompt; the daemon advertises each
// method's tier in the handshake ack so the phone knows what to gate.
//
// The server reuses the SAME ControlServer machinery (store/brains/registries/
// pairing/devices/push) so the phone and the desktop share one session world.

#include "jarvis/Config.h"
#include "jarvis/Protocol.h"

#include <QHash>
#include <QObject>
#include <QSet>
#include <QString>

QT_BEGIN_NAMESPACE
class QWebSocketServer;
class QWebSocket;
class QNetworkAccessManager;
class QNetworkReply;
QT_END_NAMESPACE

namespace jarvis {

class ControlServer;

class DeviceServer : public QObject {
    Q_OBJECT
public:
    // `control` owns the shared session/store/registry machinery; the device
    // server borrows it (does not take ownership).
    DeviceServer(Config config, ControlServer *control, QObject *parent = nullptr);
    ~DeviceServer() override;

    // Listen on 127.0.0.1:<device_port> AND (best-effort) the tailnet IP, path
    // /device/ws. Returns false only if it cannot bind any address.
    bool start();
    QString lastError() const { return m_lastError; }

private slots:
    void onNewConnection();
    void onTextMessage(const QString &message);
    void onSocketDisconnected();
    void onSessionEvent(const QString &sessionId, const jarvis::NormalizedBrainEvent &ev);
    // A daemon-side file.push -> emit a Contract C 'file.offer' event to phones
    // subscribed to the file's session (or to all authed phones if session-less).
    void onFilePushed(const QJsonObject &descriptor);

private:
    // Per-connection state.
    struct Conn {
        bool authed = false;
        QString deviceId;        // set once paired/verified
        QByteArray pubkey;       // raw ed25519 (during handshake)
        QString name;
        QByteArray challenge;    // nonce we asked the device to sign
        QSet<QString> subscribedSessions; // sessions this device created/opened
        QSet<QString> mirroring;          // sessions whose video this device gets
    };

    // One running MJPEG read of an agent desktop's engine /video/mjpeg, fanned
    // out to every device that called mirror.start for that session.
    struct MirrorPump {
        QNetworkReply *reply = nullptr; // streaming GET on /video/mjpeg
        QByteArray buf;                 // multipart re-assembly buffer
        QByteArray boundary;            // multipart boundary (e.g. --frame)
        int refcount = 0;               // number of subscribed device sockets
    };

    void handleHello(QWebSocket *client, Conn &c, const QJsonObject &obj);
    void handleChallengeResponse(QWebSocket *client, Conn &c, const QJsonObject &obj);
    void dispatchAuthed(QWebSocket *client, Conn &c, const Request &req);

    // Authed method handlers.
    Response devSessionList(const Request &req);
    Response devSessionCreate(Conn &c, const Request &req);
    Response devSessionSend(Conn &c, const Request &req);
    Response devSessionCancel(const Request &req);
    Response devSessionDelete(const Request &req);
    Response devSessionHistory(const Request &req);
    Response devTaskQueue(Conn &c, const Request &req);
    Response devTaskList(Conn &c, const Request &req);
    Response devPushRegister(Conn &c, const Request &req);
    Response devApprovalRespond(const Request &req);

    // Contract C video mirror (biometric tier). mirror.start subscribes the
    // device to a coworker+agent session's nested-desktop video; the daemon
    // reads the per-session engine's /video/mjpeg and re-publishes each JPEG as
    // a binary 'mirror.frame' to subscribed phones. mirror.stop unsubscribes.
    Response devMirrorStart(Conn &c, QWebSocket *client, const Request &req);
    Response devMirrorStop(Conn &c, QWebSocket *client, const Request &req);

    // Start/stop the shared MJPEG pump for a session (ref-counted across
    // devices). pumpFrame() parses a complete JPEG out of the multipart stream.
    void startPump(const QString &sessionId);
    void stopPump(const QString &sessionId);
    void onPumpReadyRead();
    void onPumpFinished();
    void emitMirrorFrame(const QString &sessionId, const QByteArray &jpeg);

    void sendJson(QWebSocket *client, const QJsonObject &obj);
    void sendBinary(QWebSocket *client, const QByteArray &bytes);
    void sendResponse(QWebSocket *client, const Response &resp);

    // The capability tier ("read" | "action" | "biometric") for a method, plus
    // the full method->tier map advertised in the paired ack.
    static QString tierFor(const QString &method);
    static QJsonObject capabilityMap();

    // Persist queued device images to ~/.local/share/jarvis/inbox/<session>/...
    // and return on-disk paths suitable for the CodexBrain image args.
    QStringList storeImages(const QString &sessionId, const QJsonArray &images);

    Config m_config;
    ControlServer *m_control = nullptr;
    QString m_lastError;

    QWebSocketServer *m_local = nullptr;   // 127.0.0.1
    QWebSocketServer *m_tailnet = nullptr; // tailnet IP (may be null)

    QHash<QWebSocket *, Conn> m_conns;

    // Video mirror pumps, keyed by session id (shared across subscribed phones).
    QNetworkAccessManager *m_nam = nullptr;
    QHash<QString, MirrorPump> m_pumps;
    // reverse map: streaming reply -> session id (to route ready-read signals).
    QHash<QNetworkReply *, QString> m_pumpReply;
};

} // namespace jarvis
