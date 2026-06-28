#include "jarvis/VoiceService.h"

#include <QEventLoop>
#include <QHttpMultiPart>
#include <QHttpPart>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrl>

namespace jarvis {

namespace {

// Run a reply to completion with a hard timeout. Returns true if it finished
// (success or HTTP error), false if it timed out (and aborts the reply).
bool waitFor(QNetworkReply *reply, int timeoutMs)
{
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    bool timedOut = false;
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        timedOut = true;
        loop.quit();
    });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    timer.start(timeoutMs);
    if (!reply->isFinished())
        loop.exec();
    return !timedOut;
}

// Extract a Mistral error message from a JSON error body, else a fallback.
QString errorFromBody(const QByteArray &body, const QString &fallback)
{
    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (doc.isObject()) {
        const QJsonObject o = doc.object();
        const QString msg = o.value(QStringLiteral("message")).toString();
        if (!msg.isEmpty())
            return msg;
        const QJsonObject e = o.value(QStringLiteral("error")).toObject();
        const QString em = e.value(QStringLiteral("message")).toString();
        if (!em.isEmpty())
            return em;
    }
    return fallback;
}

QString extForMime(const QString &mime)
{
    const QString m = mime.toLower();
    if (m.contains(QStringLiteral("wav")) || m.contains(QStringLiteral("x-wav")))
        return QStringLiteral("wav");
    if (m.contains(QStringLiteral("ogg")) || m.contains(QStringLiteral("opus")))
        return QStringLiteral("ogg");
    if (m.contains(QStringLiteral("flac")))
        return QStringLiteral("flac");
    if (m.contains(QStringLiteral("webm")))
        return QStringLiteral("webm");
    if (m.contains(QStringLiteral("m4a")) || m.contains(QStringLiteral("mp4")) ||
        m.contains(QStringLiteral("aac")))
        return QStringLiteral("m4a");
    return QStringLiteral("mp3"); // audio/mpeg and unknowns
}

} // namespace

VoiceService::VoiceService(QString apiKey) : m_apiKey(std::move(apiKey)) {}

QString VoiceService::mimeForFormat(const QString &format)
{
    const QString f = format.toLower();
    if (f == QStringLiteral("wav"))
        return QStringLiteral("audio/wav");
    if (f == QStringLiteral("flac"))
        return QStringLiteral("audio/flac");
    if (f == QStringLiteral("opus"))
        return QStringLiteral("audio/ogg");
    if (f == QStringLiteral("pcm"))
        return QStringLiteral("audio/pcm");
    return QStringLiteral("audio/mpeg"); // mp3 (default)
}

VoiceService::Result VoiceService::stt(const QByteArray &audio, const QString &mime,
                                       const QString &lang, const QString &model,
                                       int timeoutMs)
{
    Result r;
    if (m_apiKey.isEmpty()) {
        r.error = QStringLiteral("no Mistral API key configured");
        return r;
    }
    if (audio.isEmpty()) {
        r.error = QStringLiteral("empty audio");
        return r;
    }

    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(base() + QStringLiteral("/audio/transcriptions")));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + m_apiKey.toUtf8());

    auto *multi = new QHttpMultiPart(QHttpMultiPart::FormDataType);

    // file part
    QHttpPart filePart;
    const QString fmime = mime.isEmpty() ? QStringLiteral("audio/mpeg") : mime;
    filePart.setHeader(QNetworkRequest::ContentTypeHeader, fmime);
    filePart.setHeader(QNetworkRequest::ContentDispositionHeader,
                       QStringLiteral("form-data; name=\"file\"; filename=\"audio.%1\"")
                           .arg(extForMime(fmime)));
    filePart.setBody(audio);
    multi->append(filePart);

    // model part
    QHttpPart modelPart;
    modelPart.setHeader(QNetworkRequest::ContentDispositionHeader,
                        QStringLiteral("form-data; name=\"model\""));
    modelPart.setBody((model.isEmpty() ? defaultSttModel() : model).toUtf8());
    multi->append(modelPart);

    // optional language hint
    if (!lang.isEmpty()) {
        QHttpPart langPart;
        langPart.setHeader(QNetworkRequest::ContentDispositionHeader,
                           QStringLiteral("form-data; name=\"language\""));
        langPart.setBody(lang.toUtf8());
        multi->append(langPart);
    }

    QNetworkReply *reply = nam.post(rq, multi);
    multi->setParent(reply); // freed with the reply

    if (!waitFor(reply, timeoutMs)) {
        reply->abort();
        reply->deleteLater();
        r.error = QStringLiteral("transcription timed out");
        return r;
    }

    const QByteArray body = reply->readAll();
    const QNetworkReply::NetworkError nerr = reply->error();
    reply->deleteLater();

    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (nerr != QNetworkReply::NoError || !doc.isObject()) {
        r.error = errorFromBody(body, QStringLiteral("transcription request failed"));
        return r;
    }
    const QJsonObject o = doc.object();
    r.ok = true;
    r.text = o.value(QStringLiteral("text")).toString();
    r.language = o.value(QStringLiteral("language")).toString();
    if (o.contains(QStringLiteral("segments")))
        r.wordsJson = QJsonDocument(o.value(QStringLiteral("segments")).toArray())
                          .toJson(QJsonDocument::Compact);
    return r;
}

VoiceService::Result VoiceService::tts(const QString &text, const QString &voice,
                                       const QString &format, const QString &model,
                                       int timeoutMs, const QString &refAudioB64)
{
    Result r;
    if (m_apiKey.isEmpty()) {
        r.error = QStringLiteral("no Mistral API key configured");
        return r;
    }
    if (text.trimmed().isEmpty()) {
        r.error = QStringLiteral("empty text");
        return r;
    }

    const QString fmt = format.isEmpty() ? defaultFormat() : format;

    QNetworkAccessManager nam;
    QNetworkRequest rq(QUrl(base() + QStringLiteral("/audio/speech")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("Authorization", QByteArray("Bearer ") + m_apiKey.toUtf8());

    QJsonObject reqBody;
    reqBody.insert(QStringLiteral("model"), model.isEmpty() ? defaultTtsModel() : model);
    reqBody.insert(QStringLiteral("input"), text);
    // A voice OR ref_audio is REQUIRED by the API. A reference clip (zero-shot
    // cloning) takes precedence and replaces the named voice; otherwise fall back
    // to the requested slug / the stock default.
    if (!refAudioB64.isEmpty())
        reqBody.insert(QStringLiteral("ref_audio"), refAudioB64);
    else
        reqBody.insert(QStringLiteral("voice"), voice.isEmpty() ? defaultVoice() : voice);
    reqBody.insert(QStringLiteral("response_format"), fmt);

    QNetworkReply *reply =
        nam.post(rq, QJsonDocument(reqBody).toJson(QJsonDocument::Compact));

    if (!waitFor(reply, timeoutMs)) {
        reply->abort();
        reply->deleteLater();
        r.error = QStringLiteral("speech synthesis timed out");
        return r;
    }

    const QByteArray body = reply->readAll();
    const QNetworkReply::NetworkError nerr = reply->error();
    reply->deleteLater();

    if (nerr != QNetworkReply::NoError) {
        r.error = errorFromBody(body, QStringLiteral("speech synthesis request failed"));
        return r;
    }

    // Non-streaming response: {audio_data: <base64>}.
    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (!doc.isObject()) {
        r.error = QStringLiteral("unexpected speech response (not JSON)");
        return r;
    }
    const QJsonObject o = doc.object();
    const QString b64 = o.value(QStringLiteral("audio_data")).toString();
    if (b64.isEmpty()) {
        r.error = errorFromBody(body, QStringLiteral("speech response had no audio_data"));
        return r;
    }
    r.ok = true;
    r.audio = QByteArray::fromBase64(b64.toLatin1());
    r.mime = mimeForFormat(fmt);
    return r;
}

} // namespace jarvis
