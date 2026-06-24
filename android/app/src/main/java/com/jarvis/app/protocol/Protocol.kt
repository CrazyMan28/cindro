package com.jarvis.app.protocol

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Contract A / Contract C wire types. The device WebSocket (Contract C) reuses the
 * Contract A envelope verbatim once the handshake completes:
 *
 *   Request:  {"v":1,"id":<int>,"method":"<m>","params":{...}}
 *   Response: {"v":1,"id":<int>,"ok":true,"result":{...}}
 *             {"v":1,"id":<int>,"ok":false,"error":{"code","message"}}
 *   Event:    {"v":1,"event":"session.event","data":{"session_id":"<id>","ev":<NormalizedBrainEvent>}}
 *
 * Handshake frames (before the envelope phase) are plain JSON objects — see [Handshake].
 */
object Protocol {
    const val VERSION = 1

    fun request(id: Int, method: String, params: JsonObject = JsonObject()): String {
        val o = JsonObject()
        o.addProperty("v", VERSION)
        o.addProperty("id", id)
        o.addProperty("method", method)
        o.add("params", params)
        return o.toString()
    }

    fun parse(text: String): JsonObject? =
        runCatching { JsonParser.parseString(text).asJsonObject }.getOrNull()
}

/** A decoded Contract A response frame. */
data class WsResponse(
    val id: Int,
    val ok: Boolean,
    val result: JsonObject?,
    val errorCode: String?,
    val errorMessage: String?,
) {
    companion object {
        /** Returns null if [obj] is not a response (no `id`, or it's an event). */
        fun from(obj: JsonObject): WsResponse? {
            if (!obj.has("id") || obj.has("event")) return null
            if (!obj.has("ok")) return null
            val id = obj.get("id").asInt
            val ok = obj.get("ok").asBoolean
            val result = obj.getAsJsonObject("result")
            var code: String? = null
            var msg: String? = null
            obj.getAsJsonObject("error")?.let { err ->
                code = err.get("code")?.asString
                msg = err.get("message")?.asString
            }
            return WsResponse(id, ok, result, code, msg)
        }
    }
}

/**
 * Contract B NormalizedBrainEvent: {"kind":"<k>", ...fields}. We keep the raw
 * [fields] object so every brain's payload survives intact, plus typed accessors
 * for the kinds the chat UI renders.
 */
data class BrainEvent(val kind: String, val fields: JsonObject) {

    fun str(key: String): String? = fields.get(key)?.takeIf { !it.isJsonNull }?.asString
    fun bool(key: String): Boolean? = fields.get(key)?.takeIf { !it.isJsonNull }?.asBoolean
    fun obj(key: String): JsonObject? = fields.getAsJsonObject(key)

    val threadId: String? get() = str("thread_id")
    val text: String? get() = str("text")
    val role: String? get() = str("role")
    val callId: String? get() = str("call_id")
    val name: String? get() = str("name")
    val output: String? get() = str("output")
    val approvalId: String? get() = str("approval_id")
    val summary: String? get() = str("summary")
    val risk: String? get() = str("risk")
    val path: String? get() = str("path")
    val patch: String? get() = str("patch")
    val message: String? get() = str("message")
    val argsJson: String? get() = obj("args")?.toString()

    companion object {
        /** Parse the inner `ev` object of a session.event frame. */
        fun from(ev: JsonObject): BrainEvent {
            val kind = ev.get("kind")?.asString ?: "unknown"
            val fields = JsonObject()
            for ((k, v) in ev.entrySet()) if (k != "kind") fields.add(k, v)
            return BrainEvent(kind, fields)
        }
    }
}

/** A decoded session.event frame: {session_id, ev}. */
data class SessionEvent(val sessionId: String, val event: BrainEvent) {
    companion object {
        /** Returns null if [obj] is not a session.event frame. */
        fun from(obj: JsonObject): SessionEvent? {
            if (obj.get("event")?.asString != "session.event") return null
            val data = obj.getAsJsonObject("data") ?: return null
            val sid = data.get("session_id")?.asString ?: return null
            val ev = data.getAsJsonObject("ev") ?: return null
            return SessionEvent(sid, BrainEvent.from(ev))
        }
    }
}

/**
 * A `file.offer` Contract C event: the daemon pushes a file (device->phone). The
 * phone downloads it (inline b64 here, or via a follow-up transfer) and opens/shares it.
 * Frame: {"v":1,"event":"file.offer","data":{id,name,mime,size,session_id?,b64?}}.
 */
data class FileOfferEvent(val offer: FileOffer) {
    companion object {
        fun from(obj: JsonObject): FileOfferEvent? {
            if (obj.get("event")?.asString != "file.offer") return null
            val data = obj.getAsJsonObject("data") ?: return null
            return FileOfferEvent(FileOffer.from(data))
        }
    }
}

/**
 * A `session.opened` event: a new session was created from ANY surface (phone,
 * desktop, MCP/scheduler). The app raises/focuses + deep-links into that chat.
 * Frame: {"v":1,"event":"session.opened","data":{session_id,title}}.
 */
data class SessionOpenedEvent(val opened: SessionOpened) {
    companion object {
        fun from(obj: JsonObject): SessionOpenedEvent? {
            if (obj.get("event")?.asString != "session.opened") return null
            val data = obj.getAsJsonObject("data") ?: return null
            return SessionOpenedEvent(SessionOpened.from(data))
        }
    }
}

/** Helpers for building params payloads. */
object Params {
    fun of(vararg pairs: Pair<String, Any?>): JsonObject {
        val o = JsonObject()
        for ((k, v) in pairs) {
            when (v) {
                null -> {}
                is String -> o.addProperty(k, v)
                is Number -> o.addProperty(k, v)
                is Boolean -> o.addProperty(k, v)
                is JsonObject -> o.add(k, v)
                is JsonArray -> o.add(k, v)
                else -> o.addProperty(k, v.toString())
            }
        }
        return o
    }
}
