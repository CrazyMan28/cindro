#include "jarvis/OsvAdvisory.h"

#include <QEventLoop>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QUrl>

namespace jarvis {

std::optional<OsvAdvisory::Package> OsvAdvisory::parseStdioEndpoint(const QString &endpoint)
{
    const QStringList parts = endpoint.split(QLatin1Char(' '), Qt::SkipEmptyParts);
    if (parts.size() < 2)
        return std::nullopt;
    const QString launcher = parts.first();
    const bool isNpx = launcher == QStringLiteral("npx") ||
                       launcher.endsWith(QStringLiteral("/npx"));
    const bool isUvx = launcher == QStringLiteral("uvx") ||
                       launcher.endsWith(QStringLiteral("/uvx"));
    if (!isNpx && !isUvx)
        return std::nullopt;

    // First non-flag token is the package — except `uvx --from <pkg> <tool>`
    // and `npx --package <pkg> <cli>`, where the flag's VALUE is the package.
    QString raw;
    for (int i = 1; i < parts.size(); ++i) {
        const QString &t = parts.at(i);
        // Value-flags naming the PACKAGE: npx -p/--package <pkg>, uvx --from <pkg>.
        if ((isUvx && t == QStringLiteral("--from")) ||
            (isNpx && (t == QStringLiteral("--package") || t == QStringLiteral("-p")))) {
            if (i + 1 < parts.size())
                raw = parts.at(i + 1);
            break;
        }
        // uvx -p/--python takes a PYTHON VERSION value — skip flag AND value
        // (treating "3.12" as the package would query OSV for the wrong name).
        if (isUvx && (t == QStringLiteral("-p") || t == QStringLiteral("--python"))) {
            ++i;
            continue;
        }
        if (t.startsWith(QLatin1Char('-')))
            continue; // -y, -q, --yes ... (flags without a package value)
        raw = t;
        break;
    }
    if (raw.isEmpty())
        return std::nullopt;

    Package pkg;
    pkg.ecosystem = isNpx ? QStringLiteral("npm") : QStringLiteral("PyPI");
    // Split a trailing @version — but a leading '@' is an npm scope, not a
    // version separator ("@scope/pkg@1.2.3").
    const int at = raw.lastIndexOf(QLatin1Char('@'));
    if (at > 0) {
        pkg.name = raw.left(at);
        pkg.version = raw.mid(at + 1);
    } else {
        pkg.name = raw;
    }
    if (pkg.name.isEmpty())
        return std::nullopt;
    return pkg;
}

OsvAdvisory::Result OsvAdvisory::check(const Package &pkg, int timeoutMs,
                                       const QString &apiBase)
{
    Result out;

    QJsonObject packageObj;
    packageObj.insert(QStringLiteral("name"), pkg.name);
    packageObj.insert(QStringLiteral("ecosystem"), pkg.ecosystem);
    QJsonObject body;
    body.insert(QStringLiteral("package"), packageObj);
    if (!pkg.version.isEmpty())
        body.insert(QStringLiteral("version"), pkg.version);

    const QString base =
        apiBase.isEmpty() ? QStringLiteral("https://api.osv.dev") : apiBase;
    QNetworkRequest rq{QUrl(base + QStringLiteral("/v1/query"))};
    rq.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));

    // Local NAM + nested loop + abort timer: the same bounded-blocking pattern
    // as FcmSender / McpRegistry::testHttp.
    QNetworkAccessManager nam;
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QNetworkReply *reply = nam.post(rq, QJsonDocument(body).toJson(QJsonDocument::Compact));
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&]() {
        reply->abort();
        loop.quit();
    });
    timer.start(qMax(200, timeoutMs));
    loop.exec();

    if (reply->error() != QNetworkReply::NoError) {
        reply->deleteLater();
        return out; // ok=false -> caller fails OPEN
    }
    const QJsonObject o = QJsonDocument::fromJson(reply->readAll()).object();
    reply->deleteLater();
    out.ok = true;
    for (const QJsonValue &v : o.value(QStringLiteral("vulns")).toArray()) {
        const QJsonObject vuln = v.toObject();
        const QString id = vuln.value(QStringLiteral("id")).toString();
        if (!id.startsWith(QStringLiteral("MAL-")))
            continue; // CVEs etc. are not install-blockers; malware is
        out.hasMalware = true;
        out.advisoryIds << id;
        if (out.summary.isEmpty())
            out.summary = vuln.value(QStringLiteral("summary")).toString();
    }
    return out;
}

} // namespace jarvis
