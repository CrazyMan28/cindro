package com.agentphone.net

import org.json.JSONObject

data class PhoneEvent(
    val type: String,
    val callId: String? = null,
    val fromExtension: String? = null,
    val toExtension: String? = null,
    val messageId: String? = null,
    val content: String? = null,
    val text: String? = null,
    val state: String? = null,
    val audioBase64: String? = null,
    val audioFormat: String? = null,
    val mimeType: String? = null,
    val sampleRate: Int? = null,
    val channels: Int? = null,
    val bytes: Int? = null,
    val code: String? = null,
    val message: String? = null,
    val reason: String? = null,
    val urgency: String? = null,
    val agentName: String? = null,
    val raw: JSONObject = JSONObject()
)

object PhoneEventParser {
    fun parse(json: String): PhoneEvent {
        // A malformed frame must NOT throw out of the WebSocket onMessage callback and
        // crash the always-on foreground service — treat unparseable JSON as an empty
        // (untyped) event so the `when (event.type)` dispatch simply falls through.
        val raw = runCatching { JSONObject(json) }.getOrNull() ?: return PhoneEvent(type = "")
        val call = raw.optJSONObject("call")
        return PhoneEvent(
            type = raw.optString("type"),
            callId = raw.optStringOrNull("callId") ?: call?.optStringOrNull("id"),
            fromExtension = raw.optStringOrNull("fromExtension") ?: call?.optStringOrNull("from_extension"),
            toExtension = raw.optStringOrNull("toExtension") ?: call?.optStringOrNull("to_extension"),
            messageId = raw.optStringOrNull("messageId"),
            content = raw.optStringOrNull("content"),
            text = raw.optStringOrNull("text"),
            state = raw.optStringOrNull("state") ?: call?.optStringOrNull("state"),
            audioBase64 = raw.optStringOrNull("audioBase64"),
            audioFormat = raw.optStringOrNull("audioFormat") ?: raw.optStringOrNull("format"),
            mimeType = raw.optStringOrNull("mimeType"),
            sampleRate = raw.optIntOrNull("sampleRate"),
            channels = raw.optIntOrNull("channels"),
            bytes = raw.optIntOrNull("bytes"),
            code = raw.optStringOrNull("code"),
            message = raw.optStringOrNull("message"),
            reason = raw.optStringOrNull("reason") ?: call?.optStringOrNull("reason"),
            urgency = raw.optStringOrNull("urgency") ?: call?.optStringOrNull("urgency"),
            agentName = raw.optStringOrNull("agentName")
                ?: raw.optStringOrNull("agent_name")
                ?: call?.optStringOrNull("agentName")
                ?: call?.optStringOrNull("agent_name")
                ?: call?.optStringOrNull("from_name"),
            raw = raw
        )
    }
}

fun JSONObject.optStringOrNull(name: String): String? {
    if (!has(name) || isNull(name)) return null
    val value = optString(name)
    return value.ifBlank { null }
}

fun JSONObject.optIntOrNull(name: String): Int? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is Number -> value.toInt()
        is String -> value.toIntOrNull()
        else -> null
    }
}
