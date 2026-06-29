package com.agentphone.service

import android.content.Intent
import com.agentphone.net.PhoneEvent

data class IncomingCallInfo(
    val callId: String,
    val fromExtension: String,
    val toExtension: String,
    val agentName: String,
    val reason: String,
    val message: String,
    val urgency: String
) {
    fun applyTo(intent: Intent): Intent {
        return intent
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_FROM_EXTENSION, fromExtension)
            .putExtra(EXTRA_TO_EXTENSION, toExtension)
            .putExtra(EXTRA_AGENT_NAME, agentName)
            .putExtra(EXTRA_REASON, reason)
            .putExtra(EXTRA_MESSAGE, message)
            .putExtra(EXTRA_URGENCY, urgency)
    }

    fun summary(): String = "call=$callId from=$fromExtension reason=${reason.ifBlank { "none" }}"

    companion object {
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_FROM_EXTENSION = "fromExtension"
        const val EXTRA_TO_EXTENSION = "toExtension"
        const val EXTRA_AGENT_NAME = "agentName"
        const val EXTRA_REASON = "reason"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_URGENCY = "urgency"

        fun fromEvent(event: PhoneEvent, fallbackExtension: String): IncomingCallInfo? {
            val callId = event.callId ?: return null
            val call = event.raw.optJSONObject("call")
            val from = event.fromExtension ?: call?.optString("from_extension")?.takeIf { it.isNotBlank() } ?: "unknown"
            val to = event.toExtension ?: call?.optString("to_extension")?.takeIf { it.isNotBlank() } ?: fallbackExtension
            val reason = event.reason
                ?: call?.optString("reason")?.takeIf { it.isNotBlank() }
                ?: event.raw.optString("reason").takeIf { it.isNotBlank() }
                ?: ""
            val message = event.content
                ?: event.text
                ?: call?.optString("message")?.takeIf { it.isNotBlank() }
                ?: event.raw.optString("message").takeIf { it.isNotBlank() && it != reason }
                ?: ""
            val agentName = event.agentName
                ?: call?.optString("agent_name")?.takeIf { it.isNotBlank() }
                ?: event.raw.optString("agentName").takeIf { it.isNotBlank() }
                ?: "Agent extension $from"
            val urgency = event.urgency
                ?: call?.optString("urgency")?.takeIf { it.isNotBlank() }
                ?: "normal"
            return IncomingCallInfo(callId, from, to, agentName, reason, message, urgency)
        }

        fun fromIntent(intent: Intent): IncomingCallInfo {
            val callId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty()
            val from = intent.getStringExtra(EXTRA_FROM_EXTENSION).orEmpty().ifBlank { "unknown" }
            return IncomingCallInfo(
                callId = callId,
                fromExtension = from,
                toExtension = intent.getStringExtra(EXTRA_TO_EXTENSION).orEmpty(),
                agentName = intent.getStringExtra(EXTRA_AGENT_NAME).orEmpty().ifBlank { "Agent extension $from" },
                reason = intent.getStringExtra(EXTRA_REASON).orEmpty(),
                message = intent.getStringExtra(EXTRA_MESSAGE).orEmpty(),
                urgency = intent.getStringExtra(EXTRA_URGENCY).orEmpty().ifBlank { "normal" }
            )
        }
    }
}
