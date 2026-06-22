#pragma once

// FcmSender — push notifications to paired phones via Firebase Cloud Messaging
// (project "baratone"). The daemon pushes on "attention" events: an approval is
// needed, a queued task finished, or a file is ready.
//
// This is an interface with two impls:
//   - HttpV1FcmSender: real FCM HTTP v1 send using a Google service-account JSON
//     (OAuth2 access token minted from the SA private key). Activated only when
//     a reachable credentials path is found (e.g. ~/.phone-installer/
//     service-account.json or $JARVIS_FCM_SERVICE_ACCOUNT).
//   - LoggingFcmSender: a stub that logs the would-be push (used when no
//     credentials are present, so the daemon never hard-depends on FCM).
//
// makeDefault() picks the real sender if credentials are reachable, else the
// stub — so callers always get a valid, non-null sender.

#include <QJsonObject>
#include <QString>
#include <memory>

namespace jarvis {

// A single push: title/body shown to the user, plus an opaque data payload the
// phone app routes on (e.g. {"kind":"approval","session_id":..}).
struct PushMessage {
    QString title;
    QString body;
    QJsonObject data;
};

class FcmSender {
public:
    virtual ~FcmSender() = default;

    // Send `msg` to one registered device FCM token. Returns true if the push
    // was handed off (or logged, for the stub). Implementations must not block
    // the event loop for more than a few seconds.
    virtual bool send(const QString &fcmToken, const PushMessage &msg) = 0;

    // Human label for logs / settings ("fcm-http-v1" | "logging-stub").
    virtual QString backendName() const = 0;

    // True when a real push backend is wired (vs. the logging stub).
    virtual bool isReal() const = 0;

    // Pick the best available sender. Reuses the phone-installer "baratone"
    // service-account pattern when a credentials file is reachable; otherwise a
    // logging stub. Never returns null.
    static std::unique_ptr<FcmSender> makeDefault();

    // The credentials path probed by makeDefault() (env override first, then
    // the phone-installer default). Empty result => no real backend available.
    static QString resolveServiceAccountPath();
};

// Logs every push instead of delivering it. Always available.
class LoggingFcmSender final : public FcmSender {
public:
    bool send(const QString &fcmToken, const PushMessage &msg) override;
    QString backendName() const override { return QStringLiteral("logging-stub"); }
    bool isReal() const override { return false; }
};

// Real FCM HTTP v1 sender backed by a Google service-account JSON.
class HttpV1FcmSender final : public FcmSender {
public:
    explicit HttpV1FcmSender(const QString &serviceAccountPath);
    bool send(const QString &fcmToken, const PushMessage &msg) override;
    QString backendName() const override { return QStringLiteral("fcm-http-v1"); }
    bool isReal() const override { return m_ok; }

    // True if the service-account file parsed and a project id was found.
    bool ready() const { return m_ok; }

private:
    // Mint (and cache) an OAuth2 access token for the FCM scope from the SA key.
    QString accessToken();

    QString m_projectId;
    QString m_clientEmail;
    QString m_tokenUri;
    QByteArray m_privateKeyPem;
    bool m_ok = false;

    QString m_cachedToken;
    qint64 m_tokenExpiresAt = 0; // unix ms
};

} // namespace jarvis
