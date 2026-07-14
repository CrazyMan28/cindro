import Foundation

/// Loosely-typed JSON object, the way Android uses Gson's `JsonObject` on the wire.
public typealias JSONObject = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String? { self[k] as? String }
    // JSONSerialization boxes BOTH JSON numbers and JSON bools as NSNumber, so a naive
    // `as? Int` / `as? Bool` silently cross-coerces (a bool reads as 0/1, an int 0/1 reads
    // as a bool). Distinguish them via CFBooleanGetTypeID so parsing matches Gson: numeric
    // accessors reject bools, and bool() rejects numbers.
    private func number(_ k: String, wantBool: Bool) -> NSNumber? {
        guard let n = self[k] as? NSNumber else { return nil }
        let isBool = CFGetTypeID(n) == CFBooleanGetTypeID()
        return isBool == wantBool ? n : nil
    }
    func int(_ k: String) -> Int? {
        if let n = self[k] as? Int { return n }
        return number(k, wantBool: false)?.intValue
    }
    func dbl(_ k: String) -> Double? {
        if let d = self[k] as? Double { return d }
        return number(k, wantBool: false)?.doubleValue
    }
    func bool(_ k: String) -> Bool? {
        if let b = number(k, wantBool: true)?.boolValue { return b }
        return self[k] as? Bool
    }
    func obj(_ k: String) -> JSONObject? { self[k] as? JSONObject }
    func arr(_ k: String) -> [Any]? { self[k] as? [Any] }
    func objArr(_ k: String) -> [JSONObject]? { self[k] as? [JSONObject] }
}

/// Contract A / Contract C wire envelope. The device WebSocket (Contract C) reuses the
/// Contract A envelope verbatim once the handshake completes:
///
///   Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
///   Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
///             {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
///   Event:    {"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}
///
/// Handshake frames (before the envelope phase) are plain JSON objects.
enum WireProtocol {
    static let version = 1

    static func request(id: Int, method: String, params: JSONObject = [:]) -> String {
        let obj: JSONObject = ["v": version, "id": id, "method": method, "params": params]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    static func parse(_ text: String) -> JSONObject? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? JSONObject
        else { return nil }
        return obj
    }

    /// Serialize any JSON object; used for handshake frames (`hello`, `sig`).
    static func encode(_ obj: JSONObject) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

/// A decoded Contract A response frame.
struct WsResponse {
    let id: Int
    let ok: Bool
    let result: JSONObject?
    let errorCode: String?
    let errorMessage: String?

    /// Returns nil if `obj` is not a response (no `id`, or it's an event).
    static func from(_ obj: JSONObject) -> WsResponse? {
        guard obj["event"] == nil, let id = obj.int("id"), let ok = obj.bool("ok") else { return nil }
        let err = obj.obj("error")
        return WsResponse(
            id: id,
            ok: ok,
            result: obj.obj("result"),
            errorCode: err?.str("code"),
            errorMessage: err?.str("message")
        )
    }
}

/// Contract B NormalizedBrainEvent: {"kind":"<k>", ...fields}. The raw `fields` object is
/// kept so every brain's payload survives intact, plus typed accessors for the kinds the
/// chat UI renders.
struct BrainEvent {
    let kind: String
    let fields: JSONObject

    func str(_ k: String) -> String? { fields.str(k) }
    func bool(_ k: String) -> Bool? { fields.bool(k) }
    func obj(_ k: String) -> JSONObject? { fields.obj(k) }

    var threadId: String? { str("thread_id") }
    var text: String? { str("text") }
    var role: String? { str("role") }
    var callId: String? { str("call_id") }
    var name: String? { str("name") }
    var server: String? { str("server") }
    var output: String? { str("output") }
    var approvalId: String? { str("approval_id") }
    var summary: String? { str("summary") }
    var risk: String? { str("risk") }
    var path: String? { str("path") }
    var patch: String? { str("patch") }
    var message: String? { str("message") }

    /// Parse the inner `ev` object of a session.event frame.
    static func from(_ ev: JSONObject) -> BrainEvent {
        let kind = ev.str("kind") ?? "unknown"
        var fields = ev
        fields.removeValue(forKey: "kind")
        return BrainEvent(kind: kind, fields: fields)
    }
}

/// A decoded session.event frame: {session_id, ev}.
struct SessionEvent {
    let sessionId: String
    let event: BrainEvent

    static func from(_ obj: JSONObject) -> SessionEvent? {
        guard obj.str("event") == "session.event",
              let data = obj.obj("data"),
              let sid = data.str("session_id"),
              let ev = data.obj("ev") else { return nil }
        return SessionEvent(sessionId: sid, event: BrainEvent.from(ev))
    }
}

/// A `session.opened` event: a new session was created from ANY surface.
struct SessionOpened {
    let sessionId: String
    let title: String

    static func from(_ data: JSONObject) -> SessionOpened {
        SessionOpened(sessionId: data.str("session_id") ?? "", title: data.str("title") ?? "")
    }

    static func event(_ obj: JSONObject) -> SessionOpened? {
        guard obj.str("event") == "session.opened", let data = obj.obj("data") else { return nil }
        return from(data)
    }
}

/// A `file.offer` event: the daemon pushed a file (device -> phone).
struct FileOffer {
    let id: String
    let name: String
    let mime: String
    let size: Int
    let sessionId: String?
    let b64: String?

    static func from(_ data: JSONObject) -> FileOffer {
        FileOffer(
            id: data.str("id") ?? "",
            name: data.str("name") ?? "file",
            mime: data.str("mime") ?? "application/octet-stream",
            size: data.int("size") ?? 0,
            sessionId: data.str("session_id"),
            b64: data.str("b64")
        )
    }

    static func event(_ obj: JSONObject) -> FileOffer? {
        guard obj.str("event") == "file.offer", let data = obj.obj("data") else { return nil }
        return from(data)
    }
}

/// A `widget.render` / `widget.remove` / `widget.clear` event.
struct WidgetEvent {
    let op: String          // "render" | "remove" | "clear"
    let id: String
    let title: String
    let target: String
    let sessionId: String?
    let spec: JSONObject?   // present for "render"

    static func from(_ obj: JSONObject) -> WidgetEvent? {
        let op: String
        switch obj.str("event") {
        case "widget.render": op = "render"
        case "widget.remove": op = "remove"
        case "widget.clear": op = "clear"
        default: return nil
        }
        let data = obj.obj("data") ?? [:]
        return WidgetEvent(
            op: op,
            id: data.str("id") ?? "",
            title: data.str("title") ?? "",
            target: data.str("target") ?? "canvas",
            sessionId: data.str("session_id").flatMap { $0.isEmpty ? nil : $0 },
            spec: data.obj("spec")
        )
    }
}

/// An `auth.challenge` event: a desktop/Chrome unlock request (the no-Firebase path).
/// The user clears it with Face ID → `auth.approve {challenge_id}` back over this authed
/// socket. Mirrors Android `protocol/Models.kt` `AuthChallenge` (`challengeId`, `origin`).
struct AuthChallenge: Identifiable {
    let challengeId: String     // echoed back on auth.approve / auth.deny
    let origin: String          // "desktop" | "extension"

    var id: String { challengeId }
    /// Human sentence for the notification / approve card.
    var summary: String {
        let where_ = origin == "extension" ? "a browser" : "your computer"
        return "Approve a sign-in on \(where_)?"
    }

    static func from(_ obj: JSONObject) -> AuthChallenge? {
        guard obj.str("event") == "auth.challenge", let data = obj.obj("data") else { return nil }
        let id = data.str("challenge_id") ?? data.str("request_id") ?? data.str("id") ?? ""
        guard !id.isEmpty else { return nil }
        return AuthChallenge(challengeId: id, origin: data.str("origin") ?? "desktop")
    }
}

/// A binary `mirror.frame` (Contract C video):
///   [4-byte BE header length][header JSON utf8][JPEG bytes]
///   header = {"t":"mirror.frame","session_id":..,"ts":..,"len":..}
struct MirrorFrame {
    let sessionId: String
    let ts: Double
    let jpeg: Data

    static func parse(_ bytes: Data) -> MirrorFrame? {
        let b = [UInt8](bytes)
        guard b.count >= 4 else { return nil }
        let headerLen = (Int(b[0]) << 24) | (Int(b[1]) << 16) | (Int(b[2]) << 8) | Int(b[3])
        guard headerLen > 0, b.count >= 4 + headerLen else { return nil }
        guard let header = try? JSONSerialization.jsonObject(with: Data(b[4..<(4 + headerLen)])) as? JSONObject
        else { return nil }
        let jpeg = Data(b[(4 + headerLen)...])
        return MirrorFrame(sessionId: header.str("session_id") ?? "", ts: header.dbl("ts") ?? 0, jpeg: jpeg)
    }
}

/// Helper for building `params` payloads, dropping nil values (mirrors Android `Params.of`).
enum Params {
    static func of(_ pairs: [String: Any?]) -> JSONObject {
        var o: JSONObject = [:]
        for (k, v) in pairs where v != nil { o[k] = v! }
        return o
    }
}
