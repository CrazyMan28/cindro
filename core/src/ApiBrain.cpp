#include "jarvis/ApiBrain.h"

#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QUrl>

namespace jarvis {

namespace {

QString genThreadId()
{
    auto *rng = QRandomGenerator::system();
    quint64 a = (quint64(rng->generate()) << 32) | rng->generate();
    return QStringLiteral("api_%1").arg(a, 0, 16);
}

} // namespace

ApiBrain::ApiBrain(Options opts, QObject *parent)
    : Brain(parent), m_opts(std::move(opts))
{
    m_nam = new QNetworkAccessManager(this);
    m_provider = resolveProvider(m_opts);
}

ApiBrain::~ApiBrain()
{
    if (m_reply) {
        m_reply->disconnect(this);
        m_reply->abort();
        m_reply->deleteLater();
    }
}

bool ApiBrain::isBusy() const
{
    return m_busy;
}

QString ApiBrain::resolveProvider(const Options &opts)
{
    if (!opts.provider.isEmpty())
        return opts.provider;
    const QString m = opts.model.toLower();
    if (m.startsWith(QStringLiteral("claude")) || m.contains(QStringLiteral("anthropic")))
        return QStringLiteral("anthropic");
    // Mistral chat models (mistral-large-latest, mistral-small-*, ministral-*,
    // open-mistral-*, magistral-*, codestral-*, pixtral-*) speak the
    // OpenAI-compatible dialect at api.mistral.ai.
    if (m.startsWith(QStringLiteral("mistral")) ||
        m.startsWith(QStringLiteral("ministral")) ||
        m.startsWith(QStringLiteral("magistral")) ||
        m.startsWith(QStringLiteral("open-mistral")) ||
        m.startsWith(QStringLiteral("open-mixtral")) ||
        m.startsWith(QStringLiteral("codestral")) ||
        m.startsWith(QStringLiteral("pixtral")))
        return QStringLiteral("mistral");
    // Ollama tags look like "qwen2.5:3b", "llama3.2:latest" — a colon with a
    // non-numeric right side and no provider key is the ollama heuristic.
    if (m.contains(QLatin1Char(':')) && opts.apiKey.isEmpty())
        return QStringLiteral("ollama");
    return QStringLiteral("openai");
}

QString ApiBrain::defaultBaseUrl(const QString &provider)
{
    if (provider == QStringLiteral("anthropic"))
        return QStringLiteral("https://api.anthropic.com/v1");
    if (provider == QStringLiteral("ollama"))
        return QStringLiteral("http://127.0.0.1:11434/v1");
    // Mistral is OpenAI-compatible (/v1/chat/completions, SSE deltas).
    if (provider == QStringLiteral("mistral"))
        return QStringLiteral("https://api.mistral.ai/v1");
    return QStringLiteral("https://api.openai.com/v1");
}

QJsonValue ApiBrain::userContent(const QString &text, const QStringList &images) const
{
    // Keep readable image files only; the daemon already decoded the phone's
    // {mime,b64} attachments to on-disk paths.
    QStringList valid;
    for (const QString &p : images)
        if (!p.isEmpty() && QFile::exists(p))
            valid << p;
    if (valid.isEmpty())
        return QJsonValue(text);   // plain string (unchanged behavior)

    const bool anthropic = (m_provider == QStringLiteral("anthropic"));
    QJsonArray content;
    QJsonObject t;
    t.insert(QStringLiteral("type"), QStringLiteral("text"));
    t.insert(QStringLiteral("text"), text);
    content.append(t);
    for (const QString &path : std::as_const(valid)) {
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly))
            continue;
        const QString b64 = QString::fromLatin1(f.readAll().toBase64());
        f.close();
        const QString ext = QFileInfo(path).suffix().toLower();
        const QString mime = (ext == QStringLiteral("jpg") || ext == QStringLiteral("jpeg"))
                                 ? QStringLiteral("image/jpeg")
                             : (ext == QStringLiteral("webp")) ? QStringLiteral("image/webp")
                             : (ext == QStringLiteral("gif"))  ? QStringLiteral("image/gif")
                                                               : QStringLiteral("image/png");
        if (anthropic) {
            QJsonObject src;
            src.insert(QStringLiteral("type"), QStringLiteral("base64"));
            src.insert(QStringLiteral("media_type"), mime);
            src.insert(QStringLiteral("data"), b64);
            QJsonObject img;
            img.insert(QStringLiteral("type"), QStringLiteral("image"));
            img.insert(QStringLiteral("source"), src);
            content.append(img);
        } else {
            QJsonObject url;
            url.insert(QStringLiteral("url"),
                       QStringLiteral("data:") + mime + QStringLiteral(";base64,") + b64);
            QJsonObject img;
            img.insert(QStringLiteral("type"), QStringLiteral("image_url"));
            img.insert(QStringLiteral("image_url"), url);
            content.append(img);
        }
    }
    return content;
}

void ApiBrain::send(const QString &text, const QStringList &images)
{
    if (m_busy) {
        emitEvent(NormalizedBrainEvent::error(
            QStringLiteral("brain is busy; cancel the current turn first")));
        return;
    }
    m_busy = true;
    m_emittedFinal = false;
    m_anySent = false;
    m_buf.clear();
    m_lastUsage = QJsonObject();

    // Synthetic thread id on the first turn so the UI/history has a thread.
    if (m_history.isEmpty())
        emitEvent(NormalizedBrainEvent::threadStarted(genThreadId()));
    emitEvent(NormalizedBrainEvent::turnStarted());

    // Append the user turn to the running history. With images, `content` becomes
    // a vision array (text + base64 image parts) in the provider's format so the
    // model actually SEES the photo the phone/desktop attached.
    QJsonObject userMsg;
    userMsg.insert(QStringLiteral("role"), QStringLiteral("user"));
    userMsg.insert(QStringLiteral("content"), userContent(text, images));
    m_history.append(userMsg);

    if (m_provider == QStringLiteral("anthropic"))
        startAnthropic(text);
    else
        startOpenAi(text);
}

void ApiBrain::startOpenAi(const QString &text)
{
    Q_UNUSED(text);
    const QString base = m_opts.baseUrl.isEmpty() ? defaultBaseUrl(m_provider)
                                                   : m_opts.baseUrl;
    QNetworkRequest rq(QUrl(base + QStringLiteral("/chat/completions")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!m_opts.apiKey.isEmpty())
        rq.setRawHeader("Authorization", QByteArray("Bearer ") + m_opts.apiKey.toUtf8());

    QJsonArray messages;
    if (!m_opts.systemPrompt.isEmpty()) {
        QJsonObject sys;
        sys.insert(QStringLiteral("role"), QStringLiteral("system"));
        sys.insert(QStringLiteral("content"), m_opts.systemPrompt);
        messages.append(sys);
    }
    for (const QJsonValue &m : m_history)
        messages.append(m);

    QJsonObject body;
    body.insert(QStringLiteral("model"), m_opts.model);
    body.insert(QStringLiteral("messages"), messages);
    body.insert(QStringLiteral("stream"), true);
    // Ask for usage in the final SSE chunk (OpenAI streaming option). Mistral
    // (and other strict OpenAI-compatible backends) reject unknown fields, so
    // only attach it for the canonical openai provider.
    if (m_provider == QStringLiteral("openai")) {
        QJsonObject streamOpts;
        streamOpts.insert(QStringLiteral("include_usage"), true);
        body.insert(QStringLiteral("stream_options"), streamOpts);
    }

    m_reply = m_nam->post(rq, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(m_reply, &QNetworkReply::readyRead, this, &ApiBrain::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &ApiBrain::onFinished);
}

void ApiBrain::startAnthropic(const QString &text)
{
    Q_UNUSED(text);
    const QString base = m_opts.baseUrl.isEmpty() ? defaultBaseUrl(m_provider)
                                                   : m_opts.baseUrl;
    QNetworkRequest rq(QUrl(base + QStringLiteral("/messages")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    rq.setRawHeader("x-api-key", m_opts.apiKey.toUtf8());
    rq.setRawHeader("anthropic-version", "2023-06-01");

    QJsonArray messages;
    for (const QJsonValue &m : m_history)
        messages.append(m);

    QJsonObject body;
    body.insert(QStringLiteral("model"), m_opts.model);
    body.insert(QStringLiteral("max_tokens"), m_opts.maxTokens);
    body.insert(QStringLiteral("messages"), messages);
    body.insert(QStringLiteral("stream"), true);
    if (!m_opts.systemPrompt.isEmpty())
        body.insert(QStringLiteral("system"), m_opts.systemPrompt);

    m_reply = m_nam->post(rq, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(m_reply, &QNetworkReply::readyRead, this, &ApiBrain::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &ApiBrain::onFinished);
}

void ApiBrain::onReadyRead()
{
    if (!m_reply)
        return;
    m_buf += m_reply->readAll();
    drainSse();
}

void ApiBrain::drainSse()
{
    int nl;
    while ((nl = m_buf.indexOf('\n')) >= 0) {
        QByteArray line = m_buf.left(nl);
        m_buf.remove(0, nl + 1);
        line = line.trimmed();
        if (line.isEmpty())
            continue;
        if (!line.startsWith("data:"))
            continue; // skip SSE "event:" lines etc.
        QByteArray data = line.mid(5).trimmed();
        if (data == "[DONE]")
            continue;
        handleSseData(data);
    }
}

void ApiBrain::handleSseData(const QByteArray &data)
{
    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(data, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return;
    const QJsonObject obj = doc.object();

    if (m_provider == QStringLiteral("anthropic")) {
        const QString type = obj.value(QStringLiteral("type")).toString();
        if (type == QStringLiteral("content_block_delta")) {
            const QJsonObject delta = obj.value(QStringLiteral("delta")).toObject();
            const QString dtype = delta.value(QStringLiteral("type")).toString();
            if (dtype == QStringLiteral("text_delta")) {
                const QString t = delta.value(QStringLiteral("text")).toString();
                if (!t.isEmpty()) {
                    m_anySent = true;
                    emitEvent(NormalizedBrainEvent::message(QStringLiteral("assistant"), t));
                }
            } else if (dtype == QStringLiteral("thinking_delta")) {
                const QString t = delta.value(QStringLiteral("thinking")).toString();
                if (!t.isEmpty())
                    emitEvent(NormalizedBrainEvent::thinking(t));
            }
        } else if (type == QStringLiteral("message_delta")) {
            const QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
            if (!usage.isEmpty())
                m_lastUsage = usage;
        } else if (type == QStringLiteral("message_start")) {
            const QJsonObject msg = obj.value(QStringLiteral("message")).toObject();
            const QJsonObject usage = msg.value(QStringLiteral("usage")).toObject();
            if (!usage.isEmpty())
                m_lastUsage = usage;
        } else if (type == QStringLiteral("error")) {
            const QJsonObject e = obj.value(QStringLiteral("error")).toObject();
            emitEvent(NormalizedBrainEvent::error(
                e.value(QStringLiteral("message")).toString(QStringLiteral("api error"))));
        } else if (type == QStringLiteral("message_stop")) {
            finishTurn();
        }
        return;
    }

    // OpenAI-compatible (and Ollama /v1) streaming.
    if (obj.contains(QStringLiteral("error"))) {
        const QJsonObject e = obj.value(QStringLiteral("error")).toObject();
        emitEvent(NormalizedBrainEvent::error(
            e.value(QStringLiteral("message")).toString(QStringLiteral("api error"))));
        return;
    }
    const QJsonArray choices = obj.value(QStringLiteral("choices")).toArray();
    for (const QJsonValue &cv : choices) {
        const QJsonObject choice = cv.toObject();
        const QJsonObject delta = choice.value(QStringLiteral("delta")).toObject();
        const QString content = delta.value(QStringLiteral("content")).toString();
        if (!content.isEmpty()) {
            m_anySent = true;
            emitEvent(NormalizedBrainEvent::message(QStringLiteral("assistant"), content));
        }
        // reasoning_content (some OpenAI-compatible reasoning models / Ollama).
        const QString reasoning = delta.value(QStringLiteral("reasoning_content")).toString();
        if (!reasoning.isEmpty())
            emitEvent(NormalizedBrainEvent::thinking(reasoning));
    }
    const QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
    if (!usage.isEmpty())
        m_lastUsage = usage;
}

void ApiBrain::onFinished()
{
    if (m_reply) {
        if (m_reply->error() != QNetworkReply::NoError && !m_anySent && !m_emittedFinal) {
            const QByteArray body = m_reply->readAll();
            QString msg = m_reply->errorString();
            // Surface an API error body if present (e.g. invalid key / model).
            const QJsonDocument doc = QJsonDocument::fromJson(body);
            if (doc.isObject()) {
                const QJsonObject e = doc.object().value(QStringLiteral("error")).toObject();
                if (!e.isEmpty())
                    msg = e.value(QStringLiteral("message")).toString(msg);
            }
            emitEvent(NormalizedBrainEvent::error(
                QStringLiteral("api request failed: ") + msg));
        } else {
            // Drain any trailing buffered SSE.
            m_buf += m_reply->readAll();
            drainSse();
        }
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    finishTurn();
}

void ApiBrain::finishTurn()
{
    if (m_emittedFinal)
        return;
    m_emittedFinal = true;

    if (!m_lastUsage.isEmpty()) {
        // Normalize anthropic/openai usage shapes to {input_tokens,output_tokens}.
        QJsonObject u = m_lastUsage;
        if (!u.contains(QStringLiteral("input_tokens")) &&
            u.contains(QStringLiteral("prompt_tokens")))
            u.insert(QStringLiteral("input_tokens"),
                     u.value(QStringLiteral("prompt_tokens")));
        if (!u.contains(QStringLiteral("output_tokens")) &&
            u.contains(QStringLiteral("completion_tokens")))
            u.insert(QStringLiteral("output_tokens"),
                     u.value(QStringLiteral("completion_tokens")));
        emitEvent(NormalizedBrainEvent::usage(u));
    }
    emitEvent(NormalizedBrainEvent::final_());

    m_busy = false;
    emit turnFinished(m_sessionId);
}

void ApiBrain::cancel()
{
    if (m_reply) {
        m_reply->disconnect(this);
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    if (m_busy && !m_emittedFinal) {
        m_emittedFinal = true;
        m_busy = false;
        emit turnFinished(m_sessionId);
    }
}

void ApiBrain::emitEvent(const NormalizedBrainEvent &ev)
{
    // Accumulate assistant text into history so multi-turn context is preserved.
    if (ev.kind == NormalizedBrainEvent::Kind::Message) {
        const QString text = ev.fields.value(QStringLiteral("text")).toString();
        if (!m_history.isEmpty()) {
            QJsonObject last = m_history.last().toObject();
            if (last.value(QStringLiteral("role")).toString() == QStringLiteral("assistant")) {
                last.insert(QStringLiteral("content"),
                            last.value(QStringLiteral("content")).toString() + text);
                m_history.replace(m_history.size() - 1, last);
            } else {
                QJsonObject a;
                a.insert(QStringLiteral("role"), QStringLiteral("assistant"));
                a.insert(QStringLiteral("content"), text);
                m_history.append(a);
            }
        }
    }
    emit event(m_sessionId, ev);
}

} // namespace jarvis
