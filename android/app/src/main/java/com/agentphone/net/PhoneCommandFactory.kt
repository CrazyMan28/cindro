package com.agentphone.net

import com.agentphone.state.AgentPhoneSettings
import org.json.JSONObject

object PhoneCommandFactory {
    fun auth(settings: AgentPhoneSettings): JSONObject {
        return JSONObject()
            .put("type", "auth")
            .put("token", settings.token)
            .put("extension", settings.extension)
            .put("clientType", "device")
            .put("name", "Android/User device")
    }

    fun presence(settings: AgentPhoneSettings): JSONObject {
        return JSONObject()
            .put("type", "presence_update")
            .put("extension", settings.extension)
            .put("online", true)
    }

    fun dial(fromExtension: String, toExtension: String): JSONObject {
        return JSONObject()
            .put("type", "dial")
            .put("fromExtension", fromExtension)
            .put("toExtension", toExtension)
            .put("reason", "Android dialer")
    }

    fun accept(callId: String, extension: String): JSONObject {
        return JSONObject().put("type", "call_accept").put("callId", callId).put("extension", extension)
    }

    fun reject(callId: String, extension: String, reason: String = "rejected on Android"): JSONObject {
        return JSONObject()
            .put("type", "call_reject")
            .put("callId", callId)
            .put("extension", extension)
            .put("reason", reason)
    }

    fun end(callId: String, extension: String): JSONObject {
        return JSONObject().put("type", "call_end").put("callId", callId).put("extension", extension)
    }

    fun text(callId: String, fromExtension: String, text: String): JSONObject {
        return JSONObject()
            .put("type", "call_message")
            .put("callId", callId)
            .put("fromExtension", fromExtension)
            .put("content", text)
    }

    fun audioStart(callId: String, fromExtension: String, audioFormat: String, sampleRate: Int, channels: Int): JSONObject {
        return JSONObject()
            .put("type", "audio_start")
            .put("callId", callId)
            .put("fromExtension", fromExtension)
            .put("audioFormat", audioFormat)
            .put("sampleRate", sampleRate)
            .put("channels", channels)
    }

    fun audioChunk(callId: String, fromExtension: String, audioBase64: String): JSONObject {
        return JSONObject()
            .put("type", "audio_chunk")
            .put("callId", callId)
            .put("fromExtension", fromExtension)
            .put("audioBase64", audioBase64)
    }

    fun audioEnd(callId: String, fromExtension: String): JSONObject {
        return JSONObject().put("type", "audio_end").put("callId", callId).put("fromExtension", fromExtension)
    }

    fun screeningTakeOver(callId: String, extension: String): JSONObject {
        return JSONObject().put("type", "screening_take_over").put("callId", callId).put("extension", extension)
    }

    fun screeningEnd(callId: String, extension: String): JSONObject {
        return JSONObject().put("type", "screening_end").put("callId", callId).put("extension", extension)
    }

    fun messageAck(messageId: String): JSONObject {
        return JSONObject().put("type", "device_message_ack").put("messageId", messageId)
    }

    fun messageRead(messageId: String): JSONObject {
        return JSONObject().put("type", "device_message_read").put("messageId", messageId)
    }

    fun messageReply(messageId: String, responseText: String?, selectedOption: String?): JSONObject {
        val payload = JSONObject().put("type", "device_message_reply").put("messageId", messageId)
        if (!responseText.isNullOrBlank()) payload.put("responseText", responseText)
        if (!selectedOption.isNullOrBlank()) payload.put("selectedOption", selectedOption)
        return payload
    }
}
