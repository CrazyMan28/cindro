#include "jarvis/CodexParser.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>

namespace jarvis {

namespace {

// Pull the first non-empty string field out of `obj` among `keys`.
QString firstString(const QJsonObject &obj, std::initializer_list<const char *> keys)
{
    for (const char *k : keys) {
        const QJsonValue v = obj.value(QLatin1String(k));
        if (v.isString() && !v.toString().isEmpty())
            return v.toString();
    }
    return QString();
}

// Stringify a JSON value into a flat output string (for tool_result.output).
QString flatten(const QJsonValue &v)
{
    if (v.isString())
        return v.toString();
    if (v.isObject() || v.isArray())
        return QString::fromUtf8(QJsonDocument::fromVariant(v.toVariant())
                                     .toJson(QJsonDocument::Compact));
    if (v.isBool())
        return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    if (v.isDouble())
        return QString::number(v.toDouble());
    return QString();
}

// Map a codex `item.*` payload to a normalized event. Codex item types
// (codex 0.135.0): agent_message, reasoning, command_execution,
// file_change / patch_apply, mcp_tool_call, web_search, error, todo_list.
std::optional<NormalizedBrainEvent> mapItem(const QJsonObject &item)
{
    const QString type = item.value(QStringLiteral("type")).toString();
    const QString itemId = firstString(item, {"id", "call_id", "item_id"});

    if (type == QStringLiteral("agent_message") ||
        type == QStringLiteral("assistant_message") ||
        type == QStringLiteral("message")) {
        const QString role =
            firstString(item, {"role"}).isEmpty() ? QStringLiteral("assistant")
                                                   : item.value(QStringLiteral("role")).toString();
        const QString text = firstString(item, {"text", "content", "message"});
        return NormalizedBrainEvent::message(role, text);
    }

    if (type == QStringLiteral("reasoning") ||
        type == QStringLiteral("agent_reasoning") ||
        type == QStringLiteral("thinking")) {
        const QString text = firstString(item, {"text", "summary", "content"});
        return NormalizedBrainEvent::thinking(text);
    }

    if (type == QStringLiteral("command_execution") ||
        type == QStringLiteral("local_shell_call") ||
        type == QStringLiteral("exec_command")) {
        const QString command = firstString(item, {"command", "cmd"});
        const QString status = item.value(QStringLiteral("status")).toString();
        QJsonObject args;
        args.insert(QStringLiteral("command"), command);
        // A completed command carries its output -> tool_result; otherwise it
        // is the invocation -> tool_call. Either way carry the command as the input
        // (name "shell") so the chat card shows what ran, not just the output.
        const bool finished = status == QStringLiteral("completed") ||
                              status == QStringLiteral("failed") ||
                              item.contains(QStringLiteral("exit_code")) ||
                              item.contains(QStringLiteral("aggregated_output")) ||
                              item.contains(QStringLiteral("output"));
        if (finished) {
            const int exitCode = item.value(QStringLiteral("exit_code")).toInt(0);
            const bool ok = status != QStringLiteral("failed") && exitCode == 0;
            const QString output = firstString(item, {"aggregated_output", "output", "stdout"});
            return NormalizedBrainEvent::toolResult(itemId, ok, output,
                                                    QStringLiteral("shell"), args);
        }
        return NormalizedBrainEvent::toolCall(itemId, QStringLiteral("shell"), args);
    }

    if (type == QStringLiteral("mcp_tool_call") ||
        type == QStringLiteral("tool_call") ||
        type == QStringLiteral("function_call")) {
        const QString server = item.value(QStringLiteral("server")).toString();
        QString name = firstString(item, {"name", "tool"});
        if (name.isEmpty())
            name = server;
        const QString status = item.value(QStringLiteral("status")).toString();
        const bool finished = status == QStringLiteral("completed") ||
                              status == QStringLiteral("failed") ||
                              item.contains(QStringLiteral("result")) ||
                              item.contains(QStringLiteral("output"));
        QJsonObject args = item.value(QStringLiteral("arguments")).toObject();
        if (args.isEmpty())
            args = item.value(QStringLiteral("args")).toObject();
        if (finished) {
            const bool ok = status != QStringLiteral("failed");
            const QString output =
                flatten(item.contains(QStringLiteral("result"))
                            ? item.value(QStringLiteral("result"))
                            : item.value(QStringLiteral("output")));
            // Carry name/args/server so the chat card shows the input + tool name,
            // not just the output (codex reports completed calls as one item).
            return NormalizedBrainEvent::toolResult(itemId, ok, output, name, args, server);
        }
        return NormalizedBrainEvent::toolCall(itemId, name, args, server);
    }

    if (type == QStringLiteral("file_change") ||
        type == QStringLiteral("patch_apply") ||
        type == QStringLiteral("apply_patch")) {
        const QString path = firstString(item, {"path", "file"});
        const QString patch = firstString(item, {"patch", "diff", "unified_diff"});
        return NormalizedBrainEvent::diff(path, patch);
    }

    if (type == QStringLiteral("web_search")) {
        const QString query = firstString(item, {"query", "text"});
        QJsonObject args;
        args.insert(QStringLiteral("query"), query);
        return NormalizedBrainEvent::toolCall(itemId, QStringLiteral("web_search"), args);
    }

    if (type == QStringLiteral("error")) {
        return NormalizedBrainEvent::error(firstString(item, {"message", "text"}));
    }

    // todo_list and other informational items: no normalized equivalent.
    return std::nullopt;
}

} // namespace

std::optional<NormalizedBrainEvent> parseCodexLine(const QByteArray &line)
{
    const QByteArray trimmed = line.trimmed();
    if (trimmed.isEmpty())
        return std::nullopt;

    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(trimmed, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return std::nullopt;

    const QJsonObject obj = doc.object();
    const QString type = obj.value(QStringLiteral("type")).toString();

    if (type == QStringLiteral("thread.started")) {
        return NormalizedBrainEvent::threadStarted(
            obj.value(QStringLiteral("thread_id")).toString());
    }

    if (type == QStringLiteral("turn.started")) {
        return NormalizedBrainEvent::turnStarted();
    }

    if (type == QStringLiteral("turn.completed")) {
        // Single-line caller gets the usage event; parseCodexStream/live brain
        // additionally synthesizes the trailing final event.
        return NormalizedBrainEvent::usage(obj.value(QStringLiteral("usage")).toObject());
    }

    if (type == QStringLiteral("turn.failed")) {
        const QJsonObject e = obj.value(QStringLiteral("error")).toObject();
        return NormalizedBrainEvent::error(e.value(QStringLiteral("message")).toString());
    }

    if (type == QStringLiteral("item.completed") ||
        type == QStringLiteral("item.started") ||
        type == QStringLiteral("item.updated")) {
        const QJsonObject item = obj.value(QStringLiteral("item")).toObject();
        if (item.isEmpty())
            return std::nullopt;
        // Only completed items become terminal events; started/updated for
        // streamable items are skipped to avoid duplicate normalized events.
        if (type != QStringLiteral("item.completed"))
            return std::nullopt;
        return mapItem(item);
    }

    if (type == QStringLiteral("error")) {
        return NormalizedBrainEvent::error(
            firstString(obj, {"message", "text"}));
    }

    return std::nullopt;
}

QList<NormalizedBrainEvent> parseCodexStream(const QList<QByteArray> &lines)
{
    QList<NormalizedBrainEvent> out;
    for (const QByteArray &line : lines) {
        const QByteArray trimmed = line.trimmed();
        if (trimmed.isEmpty())
            continue;

        auto ev = parseCodexLine(trimmed);
        if (!ev)
            continue;
        out.push_back(*ev);

        // turn.completed maps to usage; the stream additionally emits final.
        if (ev->kind == NormalizedBrainEvent::Kind::Usage) {
            QJsonParseError err{};
            const QJsonDocument doc = QJsonDocument::fromJson(trimmed, &err);
            if (err.error == QJsonParseError::NoError && doc.isObject() &&
                doc.object().value(QStringLiteral("type")).toString() ==
                    QStringLiteral("turn.completed")) {
                out.push_back(NormalizedBrainEvent::final_());
            }
        }
    }
    return out;
}

} // namespace jarvis
