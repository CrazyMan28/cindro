#include "jarvis/ModelCatalog.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QSet>
#include <QString>

namespace jarvis {

ModelCatalogResult parseCodexModelCatalog(const QByteArray &processStdout)
{
    ModelCatalogResult result;
    const QJsonDocument doc = QJsonDocument::fromJson(processStdout);
    if (!doc.isObject() || !doc.object().contains(QStringLiteral("models")))
        return result; // ok stays false: unexpected shape, don't trust it
    for (const QJsonValue &v : doc.object().value(QStringLiteral("models")).toArray()) {
        const QJsonObject o = v.toObject();
        if (o.value(QStringLiteral("visibility")).toString() == QStringLiteral("hide"))
            continue;
        const QString slug = o.value(QStringLiteral("slug")).toString();
        if (!slug.isEmpty())
            result.models.append(slug);
    }
    result.ok = true;
    return result;
}

ModelCatalogResult parseClaudeModelCatalog(const QByteArray &body)
{
    ModelCatalogResult result;
    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (!doc.isObject() || !doc.object().contains(QStringLiteral("data")))
        return result;
    for (const QJsonValue &v : doc.object().value(QStringLiteral("data")).toArray()) {
        const QString id = v.toObject().value(QStringLiteral("id")).toString();
        if (!id.isEmpty())
            result.models.append(id);
    }
    result.ok = true;
    return result;
}

QJsonArray mergeModelCatalogs(const QJsonArray &baseline, const QJsonArray &live)
{
    QJsonArray result = baseline;
    QSet<QString> seen;
    for (const QJsonValue &v : result)
        seen.insert(v.toString().trimmed().toLower());
    for (const QJsonValue &v : live) {
        const QString s = v.toString().trimmed();
        const QString key = s.toLower();
        if (s.isEmpty() || seen.contains(key))
            continue;
        seen.insert(key);
        result.append(s);
    }
    return result;
}

} // namespace jarvis
