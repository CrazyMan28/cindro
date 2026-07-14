#include "jarvis/ApiBrain.h"

#include <QEventLoop>
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
#include <QTimer>
#include <QUrl>

namespace jarvis {

namespace {

QString genThreadId()
{
    auto *rng = QRandomGenerator::system();
    quint64 a = (quint64(rng->generate()) << 32) | rng->generate();
    return QStringLiteral("api_%1").arg(a, 0, 16);
}

// --- MCP JSON-RPC request builders (mirror McpRegistry.cpp) -----------------

QByteArray mcpInitializeRequest(int id)
{
    QJsonObject params;
    params.insert(QStringLiteral("protocolVersion"), QStringLiteral("2025-06-18"));
    params.insert(QStringLiteral("capabilities"), QJsonObject{});
    QJsonObject clientInfo;
    clientInfo.insert(QStringLiteral("name"), QStringLiteral("jarvis-api-brain"));
    clientInfo.insert(QStringLiteral("version"), QStringLiteral("1.0"));
    params.insert(QStringLiteral("clientInfo"), clientInfo);
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), QStringLiteral("initialize"));
    req.insert(QStringLiteral("params"), params);
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

QByteArray mcpInitializedNotification()
{
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("method"), QStringLiteral("notifications/initialized"));
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

QByteArray mcpToolsListRequest(int id)
{
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), QStringLiteral("tools/list"));
    req.insert(QStringLiteral("params"), QJsonObject{});
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

QByteArray mcpToolsCallRequest(int id, const QString &name, const QJsonObject &args)
{
    QJsonObject params;
    params.insert(QStringLiteral("name"), name);
    params.insert(QStringLiteral("arguments"), args);
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), QStringLiteral("tools/call"));
    req.insert(QStringLiteral("params"), params);
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

// Pull a JSON-RPC result object out of a body that may be raw JSON or SSE
// ("data: {json}"). Matches `wantId` (or any result if wantId<0). Mirrors
// McpRegistry's extractRpcResult.
std::optional<QJsonObject> mcpExtractRpcResult(const QByteArray &body, int wantId)
{
    auto tryParse = [&](const QByteArray &chunk) -> std::optional<QJsonObject> {
        QJsonParseError perr{};
        const QJsonDocument d = QJsonDocument::fromJson(chunk, &perr);
        if (perr.error != QJsonParseError::NoError || !d.isObject())
            return std::nullopt;
        const QJsonObject o = d.object();
        if (!o.contains(QStringLiteral("result")) && !o.contains(QStringLiteral("error")))
            return std::nullopt;
        if (wantId >= 0 && o.value(QStringLiteral("id")).toInt(-9999) != wantId)
            return std::nullopt;
        return o;
    };
    if (auto r = tryParse(body.trimmed()))
        return r;
    for (const QByteArray &raw : body.split('\n')) {
        QByteArray line = raw.trimmed();
        if (!line.startsWith("data:"))
            continue;
        if (auto r = tryParse(line.mid(5).trimmed()))
            return r;
    }
    return std::nullopt;
}

// Per-tool MCP call budget. Generous: a blocking computer-use tool (agent_wait)
// can take a while, and codex gives these a 7200s timeout (see McpRegistry).
constexpr int kMcpTimeoutMs = 7200 * 1000;
// Max tool-loop iterations per turn before we stop and tell the user.
constexpr int kMaxToolIterations = 12;

} // namespace

ApiBrain::ApiBrain(Options opts, QObject *parent)
    : Brain(parent), m_opts(std::move(opts))
{
    m_nam = new QNetworkAccessManager(this);
    m_provider = resolveProvider(m_opts);
    // The function-calling loop covers the OpenAI-compatible providers
    // (openai/mistral/ollama). Anthropic uses a different tool format and stays
    // chat-only; ollama with no key still works (the loop is endpoint-gated).
    m_toolsEnabled = !m_opts.mcpEndpoint.isEmpty() &&
                     m_provider != QStringLiteral("anthropic");
}

ApiBrain::~ApiBrain()
{
    if (m_reply) {
        m_reply->disconnect(this);
        m_reply->abort();
        m_reply->deleteLater();
    }
    if (m_backoffTimer) {
        m_backoffTimer->stop();
        m_backoffTimer->deleteLater();
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
    // New provider families (jarvis#76 item 11) — all expose an OpenAI-
    // compatible /chat/completions, so only the base URL + key differ. These
    // MUST come before the ollama colon heuristic (gemini ids are colon-free
    // but keyless setups would otherwise misroute grok/deepseek ids too).
    if (m.startsWith(QStringLiteral("gemini")))
        return QStringLiteral("gemini");
    if (m.startsWith(QStringLiteral("grok")))
        return QStringLiteral("xai");
    if (m.startsWith(QStringLiteral("deepseek")))
        return QStringLiteral("deepseek");
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
    // OpenAI-compatible endpoints for the jarvis#76 item 11 providers.
    if (provider == QStringLiteral("gemini"))
        return QStringLiteral("https://generativelanguage.googleapis.com/v1beta/openai");
    if (provider == QStringLiteral("xai"))
        return QStringLiteral("https://api.x.ai/v1");
    if (provider == QStringLiteral("deepseek"))
        return QStringLiteral("https://api.deepseek.com/v1");
    return QStringLiteral("https://api.openai.com/v1");
}

QString ApiBrain::activeApiKey() const
{
    if (m_opts.apiKeyPool.isEmpty())
        return m_opts.apiKey;
    return m_opts.apiKeyPool.at(m_keyIndex % m_opts.apiKeyPool.size());
}

// --- pure tool-loop helpers (unit-tested) -----------------------------------

QJsonArray ApiBrain::mcpToolsToOpenAiTools(const QJsonArray &mcpTools)
{
    QJsonArray out;
    for (const QJsonValue &tv : mcpTools) {
        const QJsonObject t = tv.toObject();
        const QString name = t.value(QStringLiteral("name")).toString();
        if (name.isEmpty())
            continue;
        QJsonObject fn;
        fn.insert(QStringLiteral("name"), name);
        const QString desc = t.value(QStringLiteral("description")).toString();
        if (!desc.isEmpty())
            fn.insert(QStringLiteral("description"), desc);
        // OpenAI `parameters` IS the MCP `inputSchema` (both JSON Schema objects).
        const QJsonValue schema = t.value(QStringLiteral("inputSchema"));
        if (schema.isObject()) {
            fn.insert(QStringLiteral("parameters"), schema.toObject());
        } else {
            QJsonObject empty;
            empty.insert(QStringLiteral("type"), QStringLiteral("object"));
            empty.insert(QStringLiteral("properties"), QJsonObject{});
            fn.insert(QStringLiteral("parameters"), empty);
        }
        QJsonObject tool;
        tool.insert(QStringLiteral("type"), QStringLiteral("function"));
        tool.insert(QStringLiteral("function"), fn);
        out.append(tool);
    }
    return out;
}

void ApiBrain::accumulateToolCallDeltas(QMap<int, StreamedToolCall> &acc,
                                        const QJsonArray &deltaToolCalls)
{
    for (const QJsonValue &dv : deltaToolCalls) {
        const QJsonObject d = dv.toObject();
        // OpenAI + Mistral stream tool_calls with a stable per-call `index`.
        const int index = d.value(QStringLiteral("index")).toInt(0);
        StreamedToolCall &slot = acc[index];
        const QString id = d.value(QStringLiteral("id")).toString();
        if (!id.isEmpty())
            slot.id = id;
        const QString type = d.value(QStringLiteral("type")).toString();
        if (!type.isEmpty())
            slot.type = type;
        const QJsonObject fn = d.value(QStringLiteral("function")).toObject();
        const QString name = fn.value(QStringLiteral("name")).toString();
        if (!name.isEmpty())
            slot.name = name;
        if (fn.contains(QStringLiteral("arguments")))
            slot.arguments += fn.value(QStringLiteral("arguments")).toString();
    }
}

QJsonArray ApiBrain::finalizeToolCalls(const QMap<int, StreamedToolCall> &acc)
{
    QJsonArray out;
    // QMap iterates in ascending key (index) order — preserve the model's order.
    for (auto it = acc.constBegin(); it != acc.constEnd(); ++it) {
        const StreamedToolCall &tc = it.value();
        if (tc.id.isEmpty() && tc.name.isEmpty())
            continue;
        QJsonObject fn;
        fn.insert(QStringLiteral("name"), tc.name);
        fn.insert(QStringLiteral("arguments"),
                  tc.arguments.isEmpty() ? QStringLiteral("{}") : tc.arguments);
        QJsonObject o;
        o.insert(QStringLiteral("id"), tc.id);
        o.insert(QStringLiteral("type"),
                 tc.type.isEmpty() ? QStringLiteral("function") : tc.type);
        o.insert(QStringLiteral("function"), fn);
        out.append(o);
    }
    return out;
}

QString ApiBrain::finishReasonFromChunk(const QJsonObject &chunk)
{
    const QJsonArray choices = chunk.value(QStringLiteral("choices")).toArray();
    for (const QJsonValue &cv : choices) {
        const QString fr = cv.toObject().value(QStringLiteral("finish_reason")).toString();
        if (!fr.isEmpty())
            return fr;
    }
    return QString();
}

qint64 ApiBrain::backoffDelayMs(int attempt, int baseMs, int maxMs)
{
    if (baseMs < 1)
        baseMs = 1;
    if (maxMs < baseMs)
        maxMs = baseMs;
    const int safeAttempt = qMax(0, attempt);
    // base * 2^attempt, capped BEFORE jitter (loop instead of pow() to dodge
    // overflow on a runaway attempt count — a few iterations past the cap and
    // it stops mattering since we clamp each step).
    double exp = double(baseMs);
    for (int i = 0; i < safeAttempt && exp < double(maxMs); ++i)
        exp *= 2.0;
    exp = qMin(exp, double(maxMs));
    // Full jitter in [0.5, 1.0] so several rotating/backing-off agents don't
    // all retry in lockstep.
    const double jitter = 0.5 + QRandomGenerator::global()->generateDouble() * 0.5;
    return qint64(exp * jitter);
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
    m_cancelled = false;
    m_buf.clear();
    m_pendingText.clear();
    m_lastUsage = QJsonObject();
    // Reset per-turn tool-loop state (the tools/list catalog + MCP session are
    // cached across turns; the streamed-call accumulator + counters are not).
    m_toolAccum.clear();
    m_finishReason.clear();
    m_toolIterations = 0;
    // A fresh turn gets the full credential pool again (the cursor itself is
    // sticky — a key that just 429'd stays skipped until the pool wraps).
    m_keyRotations = 0;
    m_backoffRetries = 0;
    if (m_backoffTimer)
        m_backoffTimer->stop();

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

    // Context compression (jarvis#76 item 6): keep the prompt under budget
    // before it ever reaches the wire.
    compressIfNeeded();

    if (m_provider == QStringLiteral("anthropic"))
        startAnthropic(text);
    else
        startOpenAi(text);
}

// --- context compression (jarvis#76 item 6) ---------------------------------

int ApiBrain::estimateHistoryTokens(const QJsonArray &history)
{
    qint64 bytes = 0;
    for (const QJsonValue &v : history)
        bytes += QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact).size();
    return int(bytes / 4);
}

int ApiBrain::compressHistory(QJsonArray &history, int keepTail, const QString &digest)
{
    if (keepTail < 1)
        keepTail = 1;
    if (history.size() <= keepTail + 1)
        return 0; // nothing meaningful to collapse

    int cut = history.size() - keepTail;
    // Never start the kept tail on a {role:"tool"} row — an orphaned tool
    // result without its preceding assistant tool_calls message is a hard API
    // error on every OpenAI-compatible backend.
    while (cut < history.size() &&
           history.at(cut).toObject().value(QStringLiteral("role")).toString()
               == QStringLiteral("tool"))
        ++cut;
    // The digest itself is a user turn: if the kept tail ALSO starts with a
    // user message, anthropic's strict role alternation rejects the request
    // (400) — slide past it so the tail opens on the assistant reply.
    if (cut < history.size() &&
        history.at(cut).toObject().value(QStringLiteral("role")).toString()
            == QStringLiteral("user"))
        ++cut;
    while (cut < history.size() &&
           history.at(cut).toObject().value(QStringLiteral("role")).toString()
               == QStringLiteral("tool"))
        ++cut;
    if (cut <= 1 || cut > history.size())
        return 0;

    QString summary = digest.trimmed();
    if (summary.isEmpty()) {
        // Built-in heuristic digest: one clipped line per dropped entry. A
        // PreCompact hook can replace this with a real LLM summary.
        QStringList lines;
        for (int i = 0; i < cut; ++i) {
            const QJsonObject m = history.at(i).toObject();
            const QString role = m.value(QStringLiteral("role")).toString();
            QString text;
            const QJsonValue content = m.value(QStringLiteral("content"));
            if (content.isString())
                text = content.toString();
            else if (m.contains(QStringLiteral("tool_calls")))
                text = QStringLiteral("[requested tool calls]");
            else if (content.isArray())
                text = QStringLiteral("[attached image(s)]");
            text = text.simplified();
            if (text.size() > 200)
                text = text.left(200) + QStringLiteral("…");
            if (!text.isEmpty())
                lines << role + QStringLiteral(": ") + text;
        }
        summary = lines.join(QLatin1Char('\n'));
        if (summary.size() > 4000)
            summary = summary.left(4000) + QStringLiteral("…");
    }

    QJsonArray kept;
    QJsonObject digestMsg;
    digestMsg.insert(QStringLiteral("role"), QStringLiteral("user"));
    digestMsg.insert(QStringLiteral("content"),
                     QStringLiteral("[CONTEXT DIGEST — %1 earlier message(s) were "
                                    "compressed to stay within the context budget. "
                                    "Summary of what happened:]\n%2")
                         .arg(cut).arg(summary));
    kept.append(digestMsg);
    for (int i = cut; i < history.size(); ++i)
        kept.append(history.at(i));
    const int dropped = cut;
    history = kept;
    return dropped;
}

void ApiBrain::compressIfNeeded()
{
    if (m_opts.contextMaxTokens <= 0)
        return;
    // Cheap guard before the O(history) re-serialization: a short history
    // can't exceed any sane budget, and compressHistory would no-op anyway.
    if (m_history.size() <= 9)
        return;
    const int estimated = estimateHistoryTokens(m_history);
    if (estimated <= m_opts.contextMaxTokens)
        return;

    // PreCompact hook (previously registered but never fired): a configured
    // hook script may inject a proper summary via its injectedContext output.
    QString hookDigest;
    if (m_opts.hooks) {
        QJsonObject hin;
        hin.insert(QStringLiteral("session_id"), m_opts.sessionId);
        hin.insert(QStringLiteral("history_length"), m_history.size());
        hin.insert(QStringLiteral("estimated_tokens"), estimated);
        hin.insert(QStringLiteral("budget_tokens"), m_opts.contextMaxTokens);
        const HookOutcome ho = m_opts.hooks->run(QStringLiteral("PreCompact"), hin);
        hookDigest = ho.injectedContext;
    }

    const int dropped = compressHistory(m_history, 8, hookDigest);
    if (dropped > 0)
        qInfo("ApiBrain: compressed %d old message(s) (~%d tokens > %d budget)",
              dropped, estimated, m_opts.contextMaxTokens);
}

void ApiBrain::startOpenAi(const QString &text)
{
    Q_UNUSED(text);
    const QString base = m_opts.baseUrl.isEmpty() ? defaultBaseUrl(m_provider)
                                                   : m_opts.baseUrl;
    QNetworkRequest rq(QUrl(base + QStringLiteral("/chat/completions")));
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    const QString key = activeApiKey();
    if (!key.isEmpty())
        rq.setRawHeader("Authorization", QByteArray("Bearer ") + key.toUtf8());

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
    // Advertise the computer-use tool catalog so the model can call it. Fetched +
    // converted once (cached on the brain); only when the tool loop is enabled
    // (mcpEndpoint set, OpenAI-compatible provider). An empty/failed catalog just
    // omits `tools`, degrading to pure chat.
    if (m_toolsEnabled) {
        const QJsonArray tools = fetchMcpTools();
        if (!tools.isEmpty())
            body.insert(QStringLiteral("tools"), tools);
    }
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
    rq.setRawHeader("x-api-key", activeApiKey().toUtf8());
    rq.setRawHeader("anthropic-version", "2023-06-01");

    QJsonArray messages;
    for (const QJsonValue &m : m_history)
        messages.append(m);

    QJsonObject body;
    body.insert(QStringLiteral("model"), m_opts.model);
    // Give the model headroom for thinking + the actual answer inside one
    // max_tokens ceiling (not mutating m_opts.maxTokens itself — other code,
    // e.g. context-budget estimation, reads that field for a different purpose).
    static const int kThinkingHeadroomTokens = 32000;
    const int effectiveMaxTokens = qMax(m_opts.maxTokens, kThinkingHeadroomTokens);
    body.insert(QStringLiteral("max_tokens"), effectiveMaxTokens);
    // Extended thinking, adaptive mode. The modern request surface (Fable 5,
    // Opus 4.6-4.8, Sonnet 5, Sonnet 4.6) accepts ONLY {type:"adaptive"} —
    // the older {type:"enabled", budget_tokens:N} shape is REJECTED WITH A 400
    // on Sonnet 5 / Opus 4.7 / Opus 4.8 / Fable 5. These same models also
    // default thinking.display to "omitted" (the thinking block streams with
    // empty text) unless display:"summarized" is requested explicitly.
    // Skipped for Haiku: adaptive-thinking support isn't documented there and
    // a sibling parameter (effort) is documented to error on Haiku 4.5.
    if (!m_opts.model.contains(QStringLiteral("haiku"), Qt::CaseInsensitive)) {
        QJsonObject thinking;
        thinking.insert(QStringLiteral("type"), QStringLiteral("adaptive"));
        thinking.insert(QStringLiteral("display"), QStringLiteral("summarized"));
        body.insert(QStringLiteral("thinking"), thinking);
    }
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
                    // Buffer, don't emit: Kind::Message means one COMPLETE chat
                    // bubble, so per-delta emits fragment every reply downstream
                    // (UI bubbles, history rows, TTS). Flushed in finishTurn().
                    m_pendingText += t;
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
            // Keep the old streaming order: partial text renders BEFORE the error.
            flushPendingText();
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
        // Keep the old streaming order: partial text renders BEFORE the error.
        flushPendingText();
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
            // Buffer, don't emit (see the anthropic text_delta note above).
            m_pendingText += content;
        }
        // reasoning_content (some OpenAI-compatible reasoning models / Ollama).
        const QString reasoning = delta.value(QStringLiteral("reasoning_content")).toString();
        if (!reasoning.isEmpty())
            emitEvent(NormalizedBrainEvent::thinking(reasoning));
        // Streamed function calls: accumulate `delta.tool_calls` fragments per
        // index (the agentic loop runs in onFinished when finish_reason fires).
        if (m_toolsEnabled) {
            const QJsonArray tcs = delta.value(QStringLiteral("tool_calls")).toArray();
            if (!tcs.isEmpty())
                accumulateToolCallDeltas(m_toolAccum, tcs);
        }
    }
    if (m_toolsEnabled) {
        const QString fr = finishReasonFromChunk(obj);
        if (!fr.isEmpty())
            m_finishReason = fr;
    }
    const QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
    if (!usage.isEmpty())
        m_lastUsage = usage;
}

void ApiBrain::onFinished()
{
    bool hadError = false;
    if (m_reply) {
        if (m_reply->error() != QNetworkReply::NoError && !m_anySent && !m_emittedFinal) {
            // Credential-pool rotation (jarvis#76 item 5): on HTTP 429 with
            // untried pool keys left, advance the cursor and re-issue the SAME
            // request instead of failing the turn. The raw Qt error enum never
            // says "429" — read the real HTTP status off the reply.
            const int httpStatus =
                m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            if (httpStatus == 429 && !m_cancelled &&
                m_opts.apiKeyPool.size() > 1 &&
                m_keyRotations < m_opts.apiKeyPool.size() - 1) {
                ++m_keyIndex;
                ++m_keyRotations;
                qWarning("ApiBrain: 429 rate-limited — rotating to credential %d/%d",
                         (m_keyIndex % m_opts.apiKeyPool.size()) + 1,
                         int(m_opts.apiKeyPool.size()));
                m_reply->deleteLater();
                m_reply = nullptr;
                m_buf.clear();
                m_toolAccum.clear();
                m_finishReason.clear();
                if (m_provider == QStringLiteral("anthropic"))
                    startAnthropic(QString());
                else
                    startOpenAi(QString());
                return;
            }
            // Backoff retry (jarvis-proxmox-agent): the credential pool is
            // exhausted (or has <=1 key) but the caller opted into resilience
            // via maxBackoffRetries — e.g. a scheduled headless agent that must
            // not just die on a transient rate limit. Wait with exponential
            // backoff + jitter, then give the whole pool another shot (a key
            // that just 429'd may well work again by the time we retry).
            if (httpStatus == 429 && !m_cancelled &&
                m_opts.maxBackoffRetries > 0 &&
                m_backoffRetries < m_opts.maxBackoffRetries) {
                ++m_backoffRetries;
                const qint64 delay = backoffDelayMs(m_backoffRetries - 1,
                                                     m_opts.backoffBaseMs,
                                                     m_opts.backoffMaxMs);
                qWarning("ApiBrain: 429 rate-limited — pool exhausted, backing off "
                         "%lld ms (retry %d/%d)",
                         static_cast<long long>(delay), m_backoffRetries,
                         m_opts.maxBackoffRetries);
                m_reply->deleteLater();
                m_reply = nullptr;
                m_buf.clear();
                m_toolAccum.clear();
                m_finishReason.clear();
                // Only reset the rotation counter, NOT m_keyIndex — the cursor
                // is deliberately sticky (see send()'s comment); the backoff
                // wait is the "give it time to recover" part, not a reason to
                // re-favor the key that just 429'd first on the retry.
                m_keyRotations = 0;
                if (!m_backoffTimer) {
                    // Connected exactly ONCE, here, for the timer's whole
                    // lifetime — connecting again on every retry (as an
                    // earlier version of this code did) would leave a stale,
                    // never-fired connection alive whenever a wait is cut
                    // short by cancel()/a fresh send(), so a LATER retry's
                    // fire would run two connections at once (double request).
                    m_backoffTimer = new QTimer(this);
                    m_backoffTimer->setSingleShot(true);
                    connect(m_backoffTimer, &QTimer::timeout, this, [this]() {
                        if (m_cancelled)
                            return;
                        if (m_provider == QStringLiteral("anthropic"))
                            startAnthropic(QString());
                        else
                            startOpenAi(QString());
                    });
                }
                m_backoffTimer->start(int(delay));
                return;
            }
            const QByteArray body = m_reply->readAll();
            QString msg = m_reply->errorString();
            // Surface an API error body if present (e.g. invalid key / model).
            const QJsonDocument doc = QJsonDocument::fromJson(body);
            if (doc.isObject()) {
                const QJsonObject e = doc.object().value(QStringLiteral("error")).toObject();
                if (!e.isEmpty())
                    msg = e.value(QStringLiteral("message")).toString(msg);
            }
            if (httpStatus == 429) {
                msg += QStringLiteral(" (rate-limited; all %1 configured key(s) exhausted")
                           .arg(qMax(1, int(m_opts.apiKeyPool.size())));
                if (m_opts.maxBackoffRetries > 0)
                    msg += QStringLiteral(", %1 backoff retries also exhausted")
                               .arg(m_backoffRetries);
                msg += QStringLiteral(")");
            }
            emitEvent(NormalizedBrainEvent::error(
                QStringLiteral("api request failed: ") + msg));
            hadError = true;
        } else {
            // Drain any trailing buffered SSE.
            m_buf += m_reply->readAll();
            drainSse();
        }
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    // Function-calling loop: the model asked to call tools. Execute them and
    // re-issue the chat request (handled entirely in runToolCallsAndContinue,
    // which either re-posts — no final yet — or finishTurn()s at the cap).
    if (!hadError && !m_cancelled && m_toolsEnabled &&
        m_finishReason == QStringLiteral("tool_calls") && !m_toolAccum.isEmpty()) {
        runToolCallsAndContinue();
        return;
    }
    finishTurn();
}

void ApiBrain::runToolCallsAndContinue()
{
    // Any text streamed before the tool_calls finish becomes its own bubble now,
    // and lands in m_history so the attach-to-last-assistant logic below sees it.
    flushPendingText();

    const QJsonArray toolCalls = finalizeToolCalls(m_toolAccum);
    if (toolCalls.isEmpty()) {
        finishTurn();
        return;
    }

    // Append the assistant turn carrying the tool_calls. If the model also
    // streamed text, emitEvent() already appended a {role:assistant,content:text}
    // entry — attach tool_calls to it; otherwise add a fresh assistant message
    // with content:null (OpenAI/Mistral require content or tool_calls).
    QJsonObject assistantMsg;
    bool replaceLast = false;
    if (!m_history.isEmpty()) {
        const QJsonObject last = m_history.last().toObject();
        if (last.value(QStringLiteral("role")).toString() == QStringLiteral("assistant") &&
            !last.contains(QStringLiteral("tool_calls"))) {
            assistantMsg = last;
            replaceLast = true;
        }
    }
    if (!replaceLast)
        assistantMsg.insert(QStringLiteral("role"), QStringLiteral("assistant"));
    if (assistantMsg.value(QStringLiteral("content")).toString().isEmpty())
        assistantMsg.insert(QStringLiteral("content"), QJsonValue(QJsonValue::Null));
    assistantMsg.insert(QStringLiteral("tool_calls"), toolCalls);
    if (replaceLast)
        m_history.replace(m_history.size() - 1, assistantMsg);
    else
        m_history.append(assistantMsg);

    // Execute each call against the computer-use MCP endpoint, threading results
    // back into history as {role:"tool",tool_call_id,content}.
    for (const QJsonValue &tcv : toolCalls) {
        if (m_cancelled)
            return;
        const QJsonObject tc = tcv.toObject();
        const QString id = tc.value(QStringLiteral("id")).toString();
        const QJsonObject fn = tc.value(QStringLiteral("function")).toObject();
        const QString name = fn.value(QStringLiteral("name")).toString();
        const QString argStr = fn.value(QStringLiteral("arguments")).toString();
        QJsonParseError perr{};
        const QJsonDocument argDoc = QJsonDocument::fromJson(argStr.toUtf8(), &perr);
        const QJsonObject args = argDoc.isObject() ? argDoc.object() : QJsonObject{};

        emitEvent(NormalizedBrainEvent::toolCall(id, name, args,
                                                 QStringLiteral("computer-use")));
        QString output;
        const bool ok = callMcpTool(name, args, &output);
        if (m_cancelled)
            return; // cancel() raced in during the (blocking) MCP call
        emitEvent(NormalizedBrainEvent::toolResult(id, ok, output, name, args,
                                                   QStringLiteral("computer-use")));

        QJsonObject toolMsg;
        toolMsg.insert(QStringLiteral("role"), QStringLiteral("tool"));
        toolMsg.insert(QStringLiteral("tool_call_id"), id);
        toolMsg.insert(QStringLiteral("content"), output);
        m_history.append(toolMsg);
    }

    // Iteration cap: stop runaway loops.
    if (++m_toolIterations >= kMaxToolIterations) {
        emitEvent(NormalizedBrainEvent::message(
            QStringLiteral("assistant"),
            QStringLiteral("\n[stopped: reached the %1-iteration tool-call limit for this turn]")
                .arg(kMaxToolIterations)));
        finishTurn();
        return;
    }

    // Re-issue the chat request with the updated history (new tool round). Reset
    // per-request stream state; the turn is NOT finished yet.
    m_finishReason.clear();
    m_toolAccum.clear();
    m_buf.clear();
    m_anySent = false;
    startOpenAi(QString());
}

void ApiBrain::flushPendingText()
{
    if (m_pendingText.isEmpty())
        return;
    const QString text = m_pendingText;
    m_pendingText.clear();
    // emitEvent() also folds the text into m_history's trailing assistant row,
    // which runToolCallsAndContinue() relies on when attaching tool_calls.
    emitEvent(NormalizedBrainEvent::message(QStringLiteral("assistant"), text));
}

void ApiBrain::finishTurn()
{
    if (m_emittedFinal)
        return;
    m_emittedFinal = true;

    flushPendingText();

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

// --- synchronous MCP HTTP client (mirrors McpRegistry::testHttp) -------------

bool ApiBrain::mcpPost(const QByteArray &body, int wantId, std::optional<QJsonObject> *out)
{
    QNetworkRequest req{QUrl(m_opts.mcpEndpoint)};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QByteArray("application/json"));
    req.setRawHeader("Accept", "application/json, text/event-stream");
    if (!m_opts.mcpBearer.isEmpty())
        req.setRawHeader("Authorization", QByteArray("Bearer ") + m_opts.mcpBearer.toUtf8());
    if (!m_mcpSessionId.isEmpty())
        req.setRawHeader("Mcp-Session-Id", m_mcpSessionId.toUtf8());

    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply = m_nam->post(req, body);
    m_mcpReply = reply;
    m_mcpLoop = &loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(kMcpTimeoutMs);
    loop.exec();
    timer.stop();
    m_mcpReply = nullptr;
    m_mcpLoop = nullptr;

    if (reply->error() != QNetworkReply::NoError &&
        reply->error() != QNetworkReply::OperationCanceledError) {
        reply->deleteLater();
        return false;
    }
    const QByteArray sid = reply->rawHeader("Mcp-Session-Id");
    if (!sid.isEmpty())
        m_mcpSessionId = QString::fromUtf8(sid);
    const QByteArray payload = reply->readAll();
    reply->deleteLater();
    if (out)
        *out = mcpExtractRpcResult(payload, wantId);
    return true;
}

bool ApiBrain::ensureMcpInitialized()
{
    if (m_mcpInitDone)
        return true;
    if (m_opts.mcpEndpoint.isEmpty())
        return false;
    std::optional<QJsonObject> initResult;
    const int id = ++m_mcpRpcId;
    if (!mcpPost(mcpInitializeRequest(id), id, &initResult))
        return false;
    if (!initResult || initResult->contains(QStringLiteral("error")))
        return false;
    std::optional<QJsonObject> ignore;
    mcpPost(mcpInitializedNotification(), -1, &ignore);
    m_mcpInitDone = true;
    return true;
}

QJsonArray ApiBrain::fetchMcpTools()
{
    if (m_toolsFetched)
        return m_toolsCatalog; // cached (attempted once, success or not)
    m_toolsFetched = true;
    if (!ensureMcpInitialized())
        return m_toolsCatalog; // empty
    std::optional<QJsonObject> toolsResult;
    const int id = ++m_mcpRpcId;
    if (!mcpPost(mcpToolsListRequest(id), id, &toolsResult))
        return m_toolsCatalog;
    if (!toolsResult || toolsResult->contains(QStringLiteral("error")))
        return m_toolsCatalog;
    const QJsonArray mcpTools = toolsResult->value(QStringLiteral("result"))
                                    .toObject()
                                    .value(QStringLiteral("tools"))
                                    .toArray();
    m_toolsCatalog = mcpToolsToOpenAiTools(mcpTools);
    return m_toolsCatalog;
}

bool ApiBrain::callMcpTool(const QString &name, const QJsonObject &args, QString *output)
{
    if (!ensureMcpInitialized()) {
        if (output)
            *output = QStringLiteral("computer-use MCP endpoint is not available");
        return false;
    }
    std::optional<QJsonObject> result;
    const int id = ++m_mcpRpcId;
    if (!mcpPost(mcpToolsCallRequest(id, name, args), id, &result)) {
        if (output)
            *output = QStringLiteral("tool call request failed");
        return false;
    }
    if (!result) {
        if (output)
            *output = QStringLiteral("no JSON-RPC result for tools/call");
        return false;
    }
    if (result->contains(QStringLiteral("error"))) {
        if (output)
            *output = result->value(QStringLiteral("error"))
                          .toObject()
                          .value(QStringLiteral("message"))
                          .toString(QStringLiteral("tool error"));
        return false;
    }
    const QJsonObject r = result->value(QStringLiteral("result")).toObject();
    // Concatenate the text parts of the MCP content[] block.
    QString text;
    for (const QJsonValue &cv : r.value(QStringLiteral("content")).toArray()) {
        const QJsonObject c = cv.toObject();
        if (c.value(QStringLiteral("type")).toString() == QStringLiteral("text"))
            text += c.value(QStringLiteral("text")).toString();
    }
    if (output)
        *output = text;
    // MCP marks a tool-level failure with isError:true (result still 200/no error).
    return !r.value(QStringLiteral("isError")).toBool(false);
}

void ApiBrain::cancel()
{
    m_cancelled = true;
    if (m_backoffTimer)
        m_backoffTimer->stop();
    if (m_reply) {
        m_reply->disconnect(this);
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
    // Unblock any in-flight synchronous MCP call so the tool loop can bail out.
    if (m_mcpReply)
        m_mcpReply->abort();
    if (m_mcpLoop)
        m_mcpLoop->quit();
    if (m_busy && !m_emittedFinal) {
        // Show whatever streamed before the Stop as a (partial) bubble.
        flushPendingText();
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
