#include "jarvis/FcmSender.h"

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QTemporaryFile>
#include <QTimer>
#include <QUrl>

#include <cstdio>

namespace jarvis {

// --- LoggingFcmSender -------------------------------------------------------

bool LoggingFcmSender::send(const QString &fcmToken, const PushMessage &msg)
{
    const QString tokenTail = fcmToken.right(8);
    std::fprintf(stderr,
                 "jarvisd[push-stub]: -> token=…%s title=%s body=%s data=%s\n",
                 qPrintable(tokenTail), qPrintable(msg.title), qPrintable(msg.body),
                 QJsonDocument(msg.data).toJson(QJsonDocument::Compact).constData());
    return true;
}

// --- credential discovery ---------------------------------------------------

QString FcmSender::resolveServiceAccountPath()
{
    // 1) explicit override.
    const QByteArray env = qgetenv("JARVIS_FCM_SERVICE_ACCOUNT");
    if (!env.isEmpty() && QFile::exists(QString::fromLocal8Bit(env)))
        return QString::fromLocal8Bit(env);

    // 2) reuse the phone-installer "the FCM project" service account if present.
    const QString home = QDir::homePath();
    const QStringList candidates = {
        home + QStringLiteral("/.phone-installer/service-account.json"),
        home + QStringLiteral("/.phone-installer/baratone-service-account.json"),
        home + QStringLiteral("/.config/jarvis/fcm-service-account.json"),
    };
    for (const QString &c : candidates) {
        if (QFile::exists(c))
            return c;
    }
    return QString();
}

std::unique_ptr<FcmSender> FcmSender::makeDefault()
{
    const QString sa = resolveServiceAccountPath();
    if (!sa.isEmpty()) {
        auto real = std::make_unique<HttpV1FcmSender>(sa);
        if (real->ready()) {
            std::fprintf(stderr, "jarvisd[push]: FCM HTTP v1 enabled (sa=%s)\n",
                         qPrintable(sa));
            return real;
        }
        std::fprintf(stderr,
                     "jarvisd[push]: service account at %s unusable; "
                     "falling back to logging stub\n",
                     qPrintable(sa));
    } else {
        std::fprintf(stderr,
                     "jarvisd[push]: no FCM service account reachable; "
                     "using logging stub (set JARVIS_FCM_SERVICE_ACCOUNT to enable)\n");
    }
    return std::make_unique<LoggingFcmSender>();
}

// --- HttpV1FcmSender --------------------------------------------------------

namespace {

QByteArray b64url(const QByteArray &in)
{
    return in.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

// RS256-sign `signingInput` with the PEM private key by shelling out to
// `openssl dgst -sha256 -sign`. Returns the raw signature, or empty on error.
QByteArray rs256Sign(const QByteArray &signingInput, const QByteArray &privateKeyPem)
{
    QTemporaryFile keyFile;
    if (!keyFile.open())
        return {};
    keyFile.write(privateKeyPem);
    keyFile.flush();

    QProcess proc;
    proc.setProgram(QStringLiteral("openssl"));
    proc.setArguments({QStringLiteral("dgst"), QStringLiteral("-sha256"),
                       QStringLiteral("-sign"), keyFile.fileName()});
    proc.start();
    if (!proc.waitForStarted(3000))
        return {};
    proc.write(signingInput);
    proc.closeWriteChannel();
    if (!proc.waitForFinished(5000)) {
        proc.kill();
        return {};
    }
    if (proc.exitStatus() != QProcess::NormalExit || proc.exitCode() != 0)
        return {};
    return proc.readAllStandardOutput();
}

} // namespace

HttpV1FcmSender::HttpV1FcmSender(const QString &serviceAccountPath)
{
    QFile f(serviceAccountPath);
    if (!f.open(QIODevice::ReadOnly))
        return;
    const QJsonObject sa = QJsonDocument::fromJson(f.readAll()).object();
    f.close();

    m_projectId = sa.value(QStringLiteral("project_id")).toString();
    m_clientEmail = sa.value(QStringLiteral("client_email")).toString();
    m_tokenUri = sa.value(QStringLiteral("token_uri"))
                     .toString(QStringLiteral("https://oauth2.googleapis.com/token"));
    m_privateKeyPem = sa.value(QStringLiteral("private_key")).toString().toUtf8();

    m_ok = !m_projectId.isEmpty() && !m_clientEmail.isEmpty() &&
           !m_privateKeyPem.isEmpty();
}

QString HttpV1FcmSender::accessToken()
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (!m_cachedToken.isEmpty() && now < m_tokenExpiresAt - 30000)
        return m_cachedToken; // still valid (30s safety margin)

    // Build a signed JWT assertion for the OAuth2 token endpoint.
    QJsonObject header;
    header.insert(QStringLiteral("alg"), QStringLiteral("RS256"));
    header.insert(QStringLiteral("typ"), QStringLiteral("JWT"));

    const qint64 iat = now / 1000;
    const qint64 exp = iat + 3600;
    QJsonObject claims;
    claims.insert(QStringLiteral("iss"), m_clientEmail);
    claims.insert(QStringLiteral("scope"),
                  QStringLiteral("https://www.googleapis.com/auth/firebase.messaging"));
    claims.insert(QStringLiteral("aud"), m_tokenUri);
    claims.insert(QStringLiteral("iat"), iat);
    claims.insert(QStringLiteral("exp"), exp);

    const QByteArray signingInput =
        b64url(QJsonDocument(header).toJson(QJsonDocument::Compact)) + "." +
        b64url(QJsonDocument(claims).toJson(QJsonDocument::Compact));

    const QByteArray sig = rs256Sign(signingInput, m_privateKeyPem);
    if (sig.isEmpty())
        return {};
    const QByteArray jwt = signingInput + "." + b64url(sig);

    // Exchange the assertion for an access token.
    QNetworkAccessManager nam;
    QNetworkRequest req{QUrl(m_tokenUri)};
    req.setHeader(QNetworkRequest::ContentTypeHeader,
                  QByteArray("application/x-www-form-urlencoded"));
    const QByteArray form =
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
        jwt;

    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply = nam.post(req, form);
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(8000);
    loop.exec();

    QString token;
    if (reply->error() == QNetworkReply::NoError) {
        const QJsonObject o = QJsonDocument::fromJson(reply->readAll()).object();
        token = o.value(QStringLiteral("access_token")).toString();
        const int ttl = o.value(QStringLiteral("expires_in")).toInt(3600);
        if (!token.isEmpty()) {
            m_cachedToken = token;
            m_tokenExpiresAt = QDateTime::currentMSecsSinceEpoch() + qint64(ttl) * 1000;
        }
    }
    reply->deleteLater();
    return token;
}

bool HttpV1FcmSender::send(const QString &fcmToken, const PushMessage &msg)
{
    if (!m_ok)
        return false;
    const QString token = accessToken();
    if (token.isEmpty()) {
        std::fprintf(stderr, "jarvisd[push]: could not obtain FCM access token\n");
        return false;
    }

    QJsonObject notification;
    notification.insert(QStringLiteral("title"), msg.title);
    notification.insert(QStringLiteral("body"), msg.body);

    // FCM data values must be strings.
    QJsonObject data;
    for (auto it = msg.data.begin(); it != msg.data.end(); ++it) {
        if (it.value().isString())
            data.insert(it.key(), it.value().toString());
        else
            data.insert(it.key(), QString::fromUtf8(
                QJsonDocument::fromVariant(it.value().toVariant())
                    .toJson(QJsonDocument::Compact)).trimmed());
    }

    QJsonObject message;
    message.insert(QStringLiteral("token"), fcmToken);
    message.insert(QStringLiteral("notification"), notification);
    if (!data.isEmpty())
        message.insert(QStringLiteral("data"), data);
    QJsonObject body;
    body.insert(QStringLiteral("message"), message);

    QNetworkAccessManager nam;
    const QUrl url(QStringLiteral("https://fcm.googleapis.com/v1/projects/%1/messages:send")
                       .arg(m_projectId));
    QNetworkRequest req{url};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QByteArray("application/json"));
    req.setRawHeader("Authorization", QByteArray("Bearer ") + token.toUtf8());

    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply =
        nam.post(req, QJsonDocument(body).toJson(QJsonDocument::Compact));
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(8000);
    loop.exec();

    const bool ok = reply->error() == QNetworkReply::NoError;
    if (!ok)
        std::fprintf(stderr, "jarvisd[push]: FCM send failed: %s\n",
                     qPrintable(reply->errorString()));
    reply->deleteLater();
    return ok;
}

} // namespace jarvis
