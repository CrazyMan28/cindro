#include "jarvis/ClaudeParser.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>

namespace jarvis {

namespace {

// Flatten a tool_result `content` field (string OR array of {type:text,text})
// into a single output string.
QString flattenContent(const QJsonValue &v)
{
    if (v.isString())
        return v.toString();
    if (v.isArray()) {
        QString out;
        for (const QJsonValue &block : v.toArray()) {
            if (block.isString()) {
                out += block.toString();
            } else if (block.isObject()) {
                const QJsonObject o = block.toObject();
                const QString t = o.value(QStringLiteral("text")).toString();
                if (!t.isEmpty())
                    out += t;
                else
                    out += QString::fromUtf8(
                        QJsonDocument(o).toJson(QJsonDocument::Compact));
            }
        }
        return out;
    }
    if (v.isObject())
        return QString::fromUtf8(
            QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
    return QString();
}

// Map an assistant content block to a normalized event (or nullopt).
std::optional<NormalizedBrainEvent> mapAssistantBlock(const QJsonObject &block)
{
    const QString type = block.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("text")) {
        const QString text = block.value(QStringLiteral("text")).toString();
        if (text.isEmpty())
            return std::nullopt;
        return NormalizedBrainEvent::message(QStringLiteral("assistant"), text);
    }
    if (type == QStringLiteral("thinking")) {
        const QString text = block.value(QStringLiteral("thinking")).toString();
        if (text.isEmpty())
            return std::nullopt; // empty thinking stub (signature-only) — skip
        return NormalizedBrainEvent::thinking(text);
    }
    if (type == QStringLiteral("tool_use")) {
        const QString id = block.value(QStringLiteral("id")).toString();
        const QString name = block.value(QStringLiteral("name")).toString();
        const QJsonObject args = block.value(QStringLiteral("input")).toObject();
        return NormalizedBrainEvent::toolCall(id, name, args);
    }
    return std::nullopt;
}

// Map a user content block (tool_result) to a normalized event.
std::optional<NormalizedBrainEvent> mapUserBlock(const QJsonObject &block)
{
    const QString type = block.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("tool_result")) {
        const QString id = block.value(QStringLiteral("tool_use_id")).toString();
        const bool isError = block.value(QStringLiteral("is_error")).toBool(false);
        const QString output = flattenContent(block.value(QStringLiteral("content")));
        return NormalizedBrainEvent::toolResult(id, !isError, output);
    }
    return std::nullopt;
}

} // namespace

QList<NormalizedBrainEvent> parseClaudeLine(const QByteArray &line)
{
    QList<NormalizedBrainEvent> out;
    const QByteArray trimmed = line.trimmed();
    if (trimmed.isEmpty())
        return out;

    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(trimmed, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return out;

    const QJsonObject obj = doc.object();
    const QString type = obj.value(QStringLiteral("type")).toString();

    if (type == QStringLiteral("system")) {
        const QString sub = obj.value(QStringLiteral("subtype")).toString();
        if (sub == QStringLiteral("init")) {
            const QString sid = obj.value(QStringLiteral("session_id")).toString();
            if (!sid.isEmpty())
                out.push_back(NormalizedBrainEvent::threadStarted(sid));
        } else if (sub == QStringLiteral("error")) {
            out.push_back(NormalizedBrainEvent::error(
                obj.value(QStringLiteral("message")).toString(
                    QStringLiteral("claude system error"))));
        }
        // hook_started / hook_response / compaction etc.: nothing.
        return out;
    }

    if (type == QStringLiteral("assistant")) {
        const QJsonObject msg = obj.value(QStringLiteral("message")).toObject();
        for (const QJsonValue &b : msg.value(QStringLiteral("content")).toArray()) {
            if (!b.isObject())
                continue;
            if (auto ev = mapAssistantBlock(b.toObject()))
                out.push_back(*ev);
        }
        return out;
    }

    if (type == QStringLiteral("user")) {
        const QJsonObject msg = obj.value(QStringLiteral("message")).toObject();
        const QJsonValue content = msg.value(QStringLiteral("content"));
        // A user turn's content is the array of tool_result blocks claude feeds
        // back; plain string content (the original prompt) is not echoed here.
        if (content.isArray()) {
            for (const QJsonValue &b : content.toArray()) {
                if (!b.isObject())
                    continue;
                if (auto ev = mapUserBlock(b.toObject()))
                    out.push_back(*ev);
            }
        }
        return out;
    }

    if (type == QStringLiteral("result")) {
        const bool isError = obj.value(QStringLiteral("is_error")).toBool(false);
        if (isError) {
            QString msg = obj.value(QStringLiteral("result")).toString();
            if (msg.isEmpty())
                msg = obj.value(QStringLiteral("subtype")).toString(
                    QStringLiteral("claude turn failed"));
            out.push_back(NormalizedBrainEvent::error(msg));
            return out;
        }
        const QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
        if (!usage.isEmpty())
            out.push_back(NormalizedBrainEvent::usage(usage));
        out.push_back(NormalizedBrainEvent::final_());
        return out;
    }

    if (type == QStringLiteral("error")) {
        out.push_back(NormalizedBrainEvent::error(
            obj.value(QStringLiteral("message")).toString(
                obj.value(QStringLiteral("error")).toString(
                    QStringLiteral("claude error")))));
        return out;
    }

    // rate_limit_event, stream_event, control_response, etc.: nothing.
    return out;
}

QList<NormalizedBrainEvent> parseClaudeStream(const QList<QByteArray> &lines)
{
    QList<NormalizedBrainEvent> out;
    for (const QByteArray &line : lines)
        out.append(parseClaudeLine(line));
    return out;
}

} // namespace jarvis
