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
class QTimer;
class QJsonObject;
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
    // A new session was created anywhere -> emit a 'session.opened' event to ALL
    // authed phones (a fresh id can't be subscribed yet) + an FCM push so a
    // backgrounded phone can surface the new chat.
    void onSessionOpened(const QString &sessionId, const QString &title);
    // Real-time phone events (jarvis#76 item 3): mirror phone-server frames to
    // every authed device socket (Android already listens to the phone server
    // directly; this covers paired devices that only speak the Jarvis WS).
    void onPhoneEvent(const QJsonObject &data);
    // A new unlock challenge -> emit an 'auth.challenge' event to ALL authed phones
    // so the app surfaces the Approve screen WITHOUT Firebase/FCM.
    void onAuthChallengePush(const QString &challengeId, const QString &origin, qint64 expiresAt);

private:
    // True iff at least one phone is connected AND authed over the device WS (its
    // app is open) — a reachable approver for the desktop unlock flow.
    bool hasAuthedDevice() const;

    // Per-connection state.
    struct Conn {
        bool authed = false;
        QString deviceId;        // set once paired/verified
        QByteArray pubkey;       // raw ed25519 (during handshake)
        QString name;
        QByteArray challenge;    // nonce we asked the device to sign
        QSet<QString> subscribedSessions; // sessions this device created/opened
        QSet<QString> mirroring;          // sessions whose video this device gets
        QSet<QString> pinnedWidgets;      // live widget ids pinned to this phone's
                                          // home screen (relayed even with no
                                          // session subscription, throttled).
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
    Response devSessionSearch(const Request &req);
    Response devTaskQueue(Conn &c, const Request &req);
    Response devTaskList(Conn &c, const Request &req);
    Response devPushRegister(Conn &c, const Request &req);
    Response devApprovalRespond(const Request &req);
    // 2FA + fingerprint cross-device unlock: the phone has already cleared
    // BiometricPrompt (biometric tier) before sending auth.approve over its authed
    // device WS (ed25519 = possession). Flips the daemon's unlock challenge.
    Response devAuthApprove(Conn &c, const Request &req);
    Response devAuthDeny(const Request &req);

    // Contract C video mirror (biometric tier). mirror.start subscribes the
    // device to a coworker+agent session's nested-desktop video; the daemon
    // reads the per-session engine's /video/mjpeg and re-publishes each JPEG as
    // a binary 'mirror.frame' to subscribed phones. mirror.stop unsubscribes.
    Response devMirrorStart(Conn &c, QWebSocket *client, const Request &req);
    Response devMirrorStop(Conn &c, QWebSocket *client, const Request &req);

    // Live-widget viewer leases + home-screen pins (battery). widget.viewing holds
    // a lease while the phone shows a chat (so that session's live widgets keep
    // updating); widget.pin/unpin keep a pinned home-screen widget alive (60s
    // floor) and relay its renders to the phone even with no chat open.
    Response devWidgetViewing(Conn &c, const Request &req);
    Response devWidgetPin(Conn &c, const Request &req);
    Response devWidgetUnpin(Conn &c, const Request &req);

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

    // ---- Widget bus -> phone forwarding -----------------------------------
    // The model renders widgets to a local file bus (~/.local/share/jarvis/
    // widgets.jsonl) the desktop tails. So a paired PHONE can see them too, the
    // daemon tails the same file and forwards each record to phones subscribed to
    // that widget's session as a Contract C `widget.render` (or remove/clear) event.
    QString widgetsPath() const;
    void startWidgetWatch();
    void readWidgetTail();
    QTimer *m_widgetTimer = nullptr;
    qint64 m_widgetOffset = 0;
    // Per-(device|widget id) last push time (ms) for renders delivered ONLY because
    // the phone has the widget pinned to its home screen (not via a session sub).
    // Enforces a 60s floor so a 1s desktop-driven job can't blast a backgrounded
    // phone's home widget (aggressive battery policy).
    QHash<QString, qint64> m_pinPushMs;
};

} // namespace jarvis
