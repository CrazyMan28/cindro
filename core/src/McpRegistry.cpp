#include "jarvis/McpRegistry.h"

#include <QByteArray>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QTimer>
#include <QUrl>

namespace jarvis {

namespace {

QString genId()
{
    auto *rng = QRandomGenerator::system();
    QByteArray bytes(8, Qt::Uninitialized);
    for (int i = 0; i < bytes.size(); ++i)
        bytes[i] = char(rng->bounded(256));
    return QStringLiteral("mcp_") + QString::fromLatin1(bytes.toHex());
}

QByteArray initializeRequest(int id)
{
    QJsonObject params;
    params.insert(QStringLiteral("protocolVersion"), QStringLiteral("2025-06-18"));
    params.insert(QStringLiteral("capabilities"), QJsonObject{});
    QJsonObject clientInfo;
    clientInfo.insert(QStringLiteral("name"), QStringLiteral("jarvis-core"));
    clientInfo.insert(QStringLiteral("version"), QStringLiteral("1.0"));
    params.insert(QStringLiteral("clientInfo"), clientInfo);

    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), QStringLiteral("initialize"));
    req.insert(QStringLiteral("params"), params);
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

QByteArray toolsListRequest(int id)
{
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("id"), id);
    req.insert(QStringLiteral("method"), QStringLiteral("tools/list"));
    req.insert(QStringLiteral("params"), QJsonObject{});
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

QByteArray initializedNotification()
{
    QJsonObject req;
    req.insert(QStringLiteral("jsonrpc"), QStringLiteral("2.0"));
    req.insert(QStringLiteral("method"), QStringLiteral("notifications/initialized"));
    return QJsonDocument(req).toJson(QJsonDocument::Compact);
}

// Pull a JSON-RPC result object out of a body that may be raw JSON or SSE
// ("data: {json}"). Matches `wantId` (or any result if wantId<0).
std::optional<QJsonObject> extractRpcResult(const QByteArray &body, int wantId)
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

int countTools(const QJsonObject &toolsResult)
{
    return toolsResult.value(QStringLiteral("result")).toObject()
        .value(QStringLiteral("tools")).toArray().size();
}

McpTestResult testHttp(const McpServerRow &server, const QString &bearer, int timeoutMs)
{
    McpTestResult res;
    QNetworkAccessManager nam;
    QString sessionId;
    QElapsedTimer clock;
    clock.start();

    auto post = [&](const QByteArray &body, int wantId,
                    std::optional<QJsonObject> *out) -> bool {
        QNetworkRequest req{QUrl(server.endpoint)};
        req.setHeader(QNetworkRequest::ContentTypeHeader, QByteArray("application/json"));
        req.setRawHeader("Accept", "application/json, text/event-stream");
        if (!bearer.isEmpty())
            req.setRawHeader("Authorization", QByteArray("Bearer ") + bearer.toUtf8());
        if (!sessionId.isEmpty())
            req.setRawHeader("Mcp-Session-Id", sessionId.toUtf8());

        QEventLoop loop;
        QTimer timer;
        timer.setSingleShot(true);
        const int remaining = qMax(1, timeoutMs - int(clock.elapsed()));
        QNetworkReply *reply = nam.post(req, body);
        QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
            reply->abort();
            loop.quit();
        });
        timer.start(remaining);
        loop.exec();
        timer.stop();

        if (reply->error() != QNetworkReply::NoError &&
            reply->error() != QNetworkReply::OperationCanceledError) {
            res.error = reply->errorString();
            reply->deleteLater();
            return false;
        }
        const QByteArray sid = reply->rawHeader("Mcp-Session-Id");
        if (!sid.isEmpty())
            sessionId = QString::fromUtf8(sid);
        const QByteArray payload = reply->readAll();
        reply->deleteLater();
        if (out)
            *out = extractRpcResult(payload, wantId);
        return true;
    };

    std::optional<QJsonObject> initResult;
    if (!post(initializeRequest(1), 1, &initResult)) {
        if (res.error.isEmpty())
            res.error = QStringLiteral("initialize request failed");
        return res;
    }
    if (!initResult) {
        res.error = QStringLiteral("no JSON-RPC result for initialize");
        return res;
    }
    if (initResult->contains(QStringLiteral("error"))) {
        res.error = initResult->value(QStringLiteral("error")).toObject()
                        .value(QStringLiteral("message")).toString(QStringLiteral("initialize error"));
        return res;
    }

    {
        std::optional<QJsonObject> ignore;
        post(initializedNotification(), -1, &ignore);
    }

    std::optional<QJsonObject> toolsResult;
    if (!post(toolsListRequest(2), 2, &toolsResult)) {
        if (res.error.isEmpty())
            res.error = QStringLiteral("tools/list request failed");
        return res;
    }
    if (!toolsResult) {
        res.error = QStringLiteral("no JSON-RPC result for tools/list");
        return res;
    }
    if (toolsResult->contains(QStringLiteral("error"))) {
        res.error = toolsResult->value(QStringLiteral("error")).toObject()
                        .value(QStringLiteral("message")).toString(QStringLiteral("tools/list error"));
        return res;
    }
    res.ok = true;
    res.toolsCount = countTools(*toolsResult);
    return res;
}

McpTestResult testStdio(const McpServerRow &server, int timeoutMs)
{
    McpTestResult res;
    const QStringList parts = server.endpoint.split(QLatin1Char(' '), Qt::SkipEmptyParts);
    if (parts.isEmpty()) {
        res.error = QStringLiteral("empty stdio command");
        return res;
    }

    QProcess proc;
    proc.setProgram(parts.first());
    proc.setArguments(parts.mid(1));
    proc.setProcessChannelMode(QProcess::SeparateChannels);
    proc.start();
    if (!proc.waitForStarted(qMin(timeoutMs, 3000))) {
        res.error = QStringLiteral("failed to start stdio server: ") + proc.errorString();
        return res;
    }

    QElapsedTimer clock;
    clock.start();
    proc.write(initializeRequest(1) + "\n");
    proc.write(initializedNotification() + "\n");
    proc.write(toolsListRequest(2) + "\n");

    QByteArray buf;
    std::optional<QJsonObject> toolsResult;
    while (clock.elapsed() < timeoutMs) {
        if (!proc.waitForReadyRead(qMax(1, timeoutMs - int(clock.elapsed()))))
            break;
        buf += proc.readAllStandardOutput();
        int nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const QByteArray line = buf.left(nl);
            buf.remove(0, nl + 1);
            if (auto r = extractRpcResult(line, 2)) {
                toolsResult = r;
                break;
            }
        }
        if (toolsResult)
            break;
    }

    if (proc.state() != QProcess::NotRunning) {
        proc.terminate();
        if (!proc.waitForFinished(1000))
            proc.kill();
    }

    if (!toolsResult) {
        res.error = QStringLiteral("no tools/list result from stdio server");
        return res;
    }
    if (toolsResult->contains(QStringLiteral("error"))) {
        res.error = toolsResult->value(QStringLiteral("error")).toObject()
                        .value(QStringLiteral("message")).toString(QStringLiteral("tools/list error"));
        return res;
    }
    res.ok = true;
    res.toolsCount = countTools(*toolsResult);
    return res;
}

} // namespace

QString McpRegistry::computerUseBearer()
{
    // ~/.computer-use/config.yaml: flat `bearer_token: <value>` line.
    QFile f(QDir::homePath() + QStringLiteral("/.computer-use/config.yaml"));
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QString();
    const QString text = QString::fromUtf8(f.readAll());
    f.close();
    for (const QString &raw : text.split(QLatin1Char('\n'))) {
        const QString line = raw.trimmed();
        if (!line.startsWith(QStringLiteral("bearer_token")))
            continue;
        const int colon = line.indexOf(QLatin1Char(':'));
        if (colon < 0)
            continue;
        QString v = line.mid(colon + 1).trimmed();
        if (v.size() >= 2 &&
            ((v.front() == QLatin1Char('"') && v.back() == QLatin1Char('"')) ||
             (v.front() == QLatin1Char('\'') && v.back() == QLatin1Char('\''))))
            v = v.mid(1, v.size() - 2);
        return v;
    }
    return QString();
}

QString McpRegistry::add(const QString &name, const QString &transport,
                         const QString &endpoint, const QString &token, bool enabled,
                         const QString &risk)
{
    McpServerRow row;
    row.id = genId();
    row.name = name;
    row.transport = transport;
    row.endpoint = endpoint;
    row.token = token;
    row.enabled = enabled;
    row.builtin = false;
    row.risk = risk;
    if (!m_store.addMcpServer(row))
        return QString();
    return row.id;
}

McpTestResult McpRegistry::test(const McpServerRow &server, int timeoutMs)
{
    if (server.transport == QStringLiteral("stdio"))
        return testStdio(server, timeoutMs);
    // http: built-in computer-use falls back to its config.yaml bearer.
    QString bearer = server.token;
    if (bearer.isEmpty() && server.id == builtinId())
        bearer = computerUseBearer();
    return testHttp(server, bearer, timeoutMs);
}

QString McpRegistry::codexKey(const McpServerRow &row)
{
    QString key = row.name.toLower();
    key.replace(QRegularExpression(QStringLiteral("[^a-z0-9_]")), QStringLiteral("_"));
    if (key.isEmpty())
        key = row.id;
    return key;
}

QStringList McpRegistry::codexOverrides()
{
    QStringList ov;
    for (const McpServerRow &row : m_store.listMcpServers()) {
        if (!row.enabled)
            continue;
        const QString key = codexKey(row);
        if (row.transport == QStringLiteral("stdio")) {
            const QStringList parts = row.endpoint.split(QLatin1Char(' '), Qt::SkipEmptyParts);
            if (parts.isEmpty())
                continue;
            ov << QStringLiteral("mcp_servers.%1.command=%2").arg(key, parts.first());
            if (parts.size() > 1) {
                // codex expects a TOML array literal for args.
                QStringList quoted;
                for (const QString &a : parts.mid(1))
                    quoted << QStringLiteral("\"%1\"").arg(a);
                ov << QStringLiteral("mcp_servers.%1.args=[%2]").arg(key, quoted.join(QLatin1Char(',')));
            }
            continue;
        }
        // http(s)
        ov << QStringLiteral("mcp_servers.%1.url=%2").arg(key, row.endpoint);
        QString token = row.token;
        if (token.isEmpty() && row.id == builtinId())
            token = computerUseBearer();
        if (!token.isEmpty())
            ov << QStringLiteral("mcp_servers.%1.bearer_token=%2").arg(key, token);
    }
    return ov;
}

} // namespace jarvis
