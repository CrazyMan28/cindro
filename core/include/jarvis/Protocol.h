#pragma once

// Contract A (control protocol) + Contract B (NormalizedBrainEvent) types.
// See docs/BUILD_SPEC.md. These types own their JSON (de)serialization so the
// daemon, brains and (later) tests share one canonical wire shape.

#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <optional>

namespace jarvis {

// Wire protocol version for every control + event frame.
inline constexpr int kProtocolVersion = 1;

// ---------------------------------------------------------------------------
// Contract A: control Request / Response
// ---------------------------------------------------------------------------

// {"v":1,"id":<int>,"method":"<m>","params":{...}}
struct Request {
    int id = 0;
    QString method;
    QJsonObject params;

    // Returns std::nullopt if the frame is not a well-formed v1 request.
    static std::optional<Request> fromJson(const QJsonObject &obj);
    QJsonObject toJson() const;
};

// {"v":1,"id":<int>,"ok":true,"result":{...}}  (success)
// {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}  (failure)
struct Response {
    int id = 0;
    bool ok = true;
    QJsonObject result;     // valid when ok == true
    QString errorCode;      // valid when ok == false
    QString errorMessage;   // valid when ok == false

    static Response success(int id, const QJsonObject &result = {});
    static Response failure(int id, const QString &code, const QString &message);

    static std::optional<Response> fromJson(const QJsonObject &obj);
    QJsonObject toJson() const;
};

// ---------------------------------------------------------------------------
// Contract B: NormalizedBrainEvent
// ---------------------------------------------------------------------------
//
// {"kind":"<k>", ...fields} where k is one of the enumerated kinds. The struct
// keeps a strongly typed kind plus an open `fields` object so every brain emits
// exactly the BUILD_SPEC shape while still being forward compatible.
struct NormalizedBrainEvent {
    enum class Kind {
        ThreadStarted, // {thread_id}
        TurnStarted,   // {}
        Thinking,      // {text}
        Message,       // {role,text}
        ToolCall,      // {call_id,name,args}
        ToolResult,    // {call_id,ok,output}
        Approval,      // {approval_id,summary,risk}
        Diff,          // {path,patch}
        Usage,         // {input_tokens,output_tokens,...}
        Final,         // {}
        Error,         // {message}
        Unknown
    };

    Kind kind = Kind::Unknown;
    // The event payload fields (without "kind"). toJson() merges {"kind":..} in.
    QJsonObject fields;

    NormalizedBrainEvent() = default;
    explicit NormalizedBrainEvent(Kind k, QJsonObject f = {}) : kind(k), fields(std::move(f)) {}

    // Canonical wire string for a kind, e.g. Kind::ThreadStarted -> "thread_started".
    static QString kindToString(Kind k);
    static Kind kindFromString(const QString &s);

    // {"kind":"<k>", ...fields}
    QJsonObject toJson() const;
    static std::optional<NormalizedBrainEvent> fromJson(const QJsonObject &obj);

    // Convenience constructors for the common kinds.
    static NormalizedBrainEvent threadStarted(const QString &threadId);
    static NormalizedBrainEvent turnStarted();
    static NormalizedBrainEvent thinking(const QString &text);
    static NormalizedBrainEvent message(const QString &role, const QString &text);
    static NormalizedBrainEvent toolCall(const QString &callId, const QString &name, const QJsonObject &args);
    static NormalizedBrainEvent toolResult(const QString &callId, bool ok, const QString &output);
    static NormalizedBrainEvent approval(const QString &approvalId, const QString &summary, const QString &risk);
    static NormalizedBrainEvent diff(const QString &path, const QString &patch);
    static NormalizedBrainEvent usage(const QJsonObject &usageFields);
    static NormalizedBrainEvent final_();
    static NormalizedBrainEvent error(const QString &message);

    // Helper for the field of a thread_started event.
    QString threadId() const { return fields.value(QStringLiteral("thread_id")).toString(); }
};

// ---------------------------------------------------------------------------
// Contract A: unsolicited session event frame
// ---------------------------------------------------------------------------
// {"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}
QJsonObject makeSessionEventFrame(const QString &sessionId, const NormalizedBrainEvent &ev);

} // namespace jarvis
