#include "jarvis/Protocol.h"

namespace jarvis {

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

std::optional<Request> Request::fromJson(const QJsonObject &obj)
{
    if (obj.value(QStringLiteral("v")).toInt() != kProtocolVersion)
        return std::nullopt;
    const QJsonValue method = obj.value(QStringLiteral("method"));
    if (!method.isString() || method.toString().isEmpty())
        return std::nullopt;

    Request req;
    req.id = obj.value(QStringLiteral("id")).toInt();
    req.method = method.toString();
    req.params = obj.value(QStringLiteral("params")).toObject();
    return req;
}

QJsonObject Request::toJson() const
{
    QJsonObject obj;
    obj.insert(QStringLiteral("v"), kProtocolVersion);
    obj.insert(QStringLiteral("id"), id);
    obj.insert(QStringLiteral("method"), method);
    obj.insert(QStringLiteral("params"), params);
    return obj;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

Response Response::success(int id, const QJsonObject &result)
{
    Response r;
    r.id = id;
    r.ok = true;
    r.result = result;
    return r;
}

Response Response::failure(int id, const QString &code, const QString &message)
{
    Response r;
    r.id = id;
    r.ok = false;
    r.errorCode = code;
    r.errorMessage = message;
    return r;
}

std::optional<Response> Response::fromJson(const QJsonObject &obj)
{
    if (obj.value(QStringLiteral("v")).toInt() != kProtocolVersion)
        return std::nullopt;
    if (!obj.contains(QStringLiteral("ok")))
        return std::nullopt;

    Response r;
    r.id = obj.value(QStringLiteral("id")).toInt();
    r.ok = obj.value(QStringLiteral("ok")).toBool();
    if (r.ok) {
        r.result = obj.value(QStringLiteral("result")).toObject();
    } else {
        const QJsonObject err = obj.value(QStringLiteral("error")).toObject();
        r.errorCode = err.value(QStringLiteral("code")).toString();
        r.errorMessage = err.value(QStringLiteral("message")).toString();
    }
    return r;
}

QJsonObject Response::toJson() const
{
    QJsonObject obj;
    obj.insert(QStringLiteral("v"), kProtocolVersion);
    obj.insert(QStringLiteral("id"), id);
    obj.insert(QStringLiteral("ok"), ok);
    if (ok) {
        obj.insert(QStringLiteral("result"), result);
    } else {
        QJsonObject err;
        err.insert(QStringLiteral("code"), errorCode);
        err.insert(QStringLiteral("message"), errorMessage);
        obj.insert(QStringLiteral("error"), err);
    }
    return obj;
}

// ---------------------------------------------------------------------------
// NormalizedBrainEvent
// ---------------------------------------------------------------------------

QString NormalizedBrainEvent::kindToString(Kind k)
{
    switch (k) {
    case Kind::ThreadStarted: return QStringLiteral("thread_started");
    case Kind::TurnStarted:   return QStringLiteral("turn_started");
    case Kind::Thinking:      return QStringLiteral("thinking");
    case Kind::Message:       return QStringLiteral("message");
    case Kind::ToolCall:      return QStringLiteral("tool_call");
    case Kind::ToolResult:    return QStringLiteral("tool_result");
    case Kind::Approval:      return QStringLiteral("approval");
    case Kind::Diff:          return QStringLiteral("diff");
    case Kind::Usage:         return QStringLiteral("usage");
    case Kind::Final:         return QStringLiteral("final");
    case Kind::Error:         return QStringLiteral("error");
    case Kind::Unknown:       break;
    }
    return QStringLiteral("unknown");
}

NormalizedBrainEvent::Kind NormalizedBrainEvent::kindFromString(const QString &s)
{
    if (s == QStringLiteral("thread_started")) return Kind::ThreadStarted;
    if (s == QStringLiteral("turn_started"))   return Kind::TurnStarted;
    if (s == QStringLiteral("thinking"))        return Kind::Thinking;
    if (s == QStringLiteral("message"))         return Kind::Message;
    if (s == QStringLiteral("tool_call"))       return Kind::ToolCall;
    if (s == QStringLiteral("tool_result"))     return Kind::ToolResult;
    if (s == QStringLiteral("approval"))        return Kind::Approval;
    if (s == QStringLiteral("diff"))            return Kind::Diff;
    if (s == QStringLiteral("usage"))           return Kind::Usage;
    if (s == QStringLiteral("final"))           return Kind::Final;
    if (s == QStringLiteral("error"))           return Kind::Error;
    return Kind::Unknown;
}

QJsonObject NormalizedBrainEvent::toJson() const
{
    QJsonObject obj = fields;
    obj.insert(QStringLiteral("kind"), kindToString(kind));
    return obj;
}

std::optional<NormalizedBrainEvent> NormalizedBrainEvent::fromJson(const QJsonObject &obj)
{
    const QJsonValue kindVal = obj.value(QStringLiteral("kind"));
    if (!kindVal.isString())
        return std::nullopt;
    NormalizedBrainEvent ev;
    ev.kind = kindFromString(kindVal.toString());
    ev.fields = obj;
    ev.fields.remove(QStringLiteral("kind"));
    return ev;
}

NormalizedBrainEvent NormalizedBrainEvent::threadStarted(const QString &threadId)
{
    QJsonObject f;
    f.insert(QStringLiteral("thread_id"), threadId);
    return NormalizedBrainEvent(Kind::ThreadStarted, f);
}

NormalizedBrainEvent NormalizedBrainEvent::turnStarted()
{
    return NormalizedBrainEvent(Kind::TurnStarted, {});
}

NormalizedBrainEvent NormalizedBrainEvent::thinking(const QString &text)
{
    QJsonObject f;
    f.insert(QStringLiteral("text"), text);
    return NormalizedBrainEvent(Kind::Thinking, f);
}

NormalizedBrainEvent NormalizedBrainEvent::message(const QString &role, const QString &text)
{
    QJsonObject f;
    f.insert(QStringLiteral("role"), role);
    f.insert(QStringLiteral("text"), text);
    return NormalizedBrainEvent(Kind::Message, f);
}

NormalizedBrainEvent NormalizedBrainEvent::toolCall(const QString &callId, const QString &name, const QJsonObject &args)
{
    QJsonObject f;
    f.insert(QStringLiteral("call_id"), callId);
    f.insert(QStringLiteral("name"), name);
    f.insert(QStringLiteral("args"), args);
    return NormalizedBrainEvent(Kind::ToolCall, f);
}

NormalizedBrainEvent NormalizedBrainEvent::toolResult(const QString &callId, bool ok, const QString &output)
{
    QJsonObject f;
    f.insert(QStringLiteral("call_id"), callId);
    f.insert(QStringLiteral("ok"), ok);
    f.insert(QStringLiteral("output"), output);
    return NormalizedBrainEvent(Kind::ToolResult, f);
}

NormalizedBrainEvent NormalizedBrainEvent::approval(const QString &approvalId, const QString &summary, const QString &risk)
{
    QJsonObject f;
    f.insert(QStringLiteral("approval_id"), approvalId);
    f.insert(QStringLiteral("summary"), summary);
    f.insert(QStringLiteral("risk"), risk);
    return NormalizedBrainEvent(Kind::Approval, f);
}

NormalizedBrainEvent NormalizedBrainEvent::diff(const QString &path, const QString &patch)
{
    QJsonObject f;
    f.insert(QStringLiteral("path"), path);
    f.insert(QStringLiteral("patch"), patch);
    return NormalizedBrainEvent(Kind::Diff, f);
}

NormalizedBrainEvent NormalizedBrainEvent::usage(const QJsonObject &usageFields)
{
    return NormalizedBrainEvent(Kind::Usage, usageFields);
}

NormalizedBrainEvent NormalizedBrainEvent::final_()
{
    return NormalizedBrainEvent(Kind::Final, {});
}

NormalizedBrainEvent NormalizedBrainEvent::error(const QString &message)
{
    QJsonObject f;
    f.insert(QStringLiteral("message"), message);
    return NormalizedBrainEvent(Kind::Error, f);
}

// ---------------------------------------------------------------------------
// session.event frame
// ---------------------------------------------------------------------------

QJsonObject makeSessionEventFrame(const QString &sessionId, const NormalizedBrainEvent &ev)
{
    QJsonObject data;
    data.insert(QStringLiteral("session_id"), sessionId);
    data.insert(QStringLiteral("ev"), ev.toJson());

    QJsonObject frame;
    frame.insert(QStringLiteral("v"), kProtocolVersion);
    frame.insert(QStringLiteral("event"), QStringLiteral("session.event"));
    frame.insert(QStringLiteral("data"), data);
    return frame;
}

} // namespace jarvis
