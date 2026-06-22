package com.jarvis.app.protocol

import android.net.Uri
import com.google.gson.JsonObject

/**
 * Capability tier a method requires (Contract C). The daemon tags each method; the
 * phone gates [BIOMETRIC]-tier actions behind a device BiometricPrompt.
 */
enum class Tier { READ, ACTION, BIOMETRIC }

/** A session row from session.list / session.create. */
data class Session(
    val id: String,
    val title: String?,
    val profile: String?,
    val brain: String?,
    val state: String?,
    val updatedAt: Long?,
) {
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: listOfNotNull(profile, brain).joinToString(" · ").ifBlank { id.take(8) }

    companion object {
        fun from(o: JsonObject): Session = Session(
            id = o.get("id")?.asString ?: o.get("session_id")?.asString.orEmpty(),
            title = o.get("title")?.takeIf { !it.isJsonNull }?.asString,
            profile = o.get("profile")?.takeIf { !it.isJsonNull }?.asString,
            brain = o.get("brain")?.takeIf { !it.isJsonNull }?.asString,
            state = o.get("state")?.takeIf { !it.isJsonNull }?.asString,
            updatedAt = o.get("updated_at")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("updatedAt")?.takeIf { !it.isJsonNull }?.asLong,
        )
    }
}

/** A queued task from task.list. */
data class QueuedTask(
    val id: String,
    val text: String,
    val state: String?,
    val whenAt: Long?,
) {
    companion object {
        fun from(o: JsonObject): QueuedTask = QueuedTask(
            id = o.get("id")?.asString.orEmpty(),
            text = o.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty(),
            state = o.get("state")?.takeIf { !it.isJsonNull }?.asString,
            whenAt = o.get("when")?.takeIf { !it.isJsonNull }?.asLong
                ?: o.get("when_at")?.takeIf { !it.isJsonNull }?.asLong,
        )
    }
}

/** A paired-device summary surfaced in Settings (from devices.list, if exposed). */
data class PairedDevice(
    val id: String,
    val name: String?,
    val pairedAt: Long?,
    val lastSeen: Long?,
)

/**
 * Decoded `jarvis://pair?host=<tailnet-ip>:8796&code=<code>&fp=<daemon-pubkey-fp>` payload
 * scanned from the desktop QR (or pasted manually).
 */
data class PairPayload(
    val hostPort: String,
    val code: String,
    val fingerprint: String?,
) {
    companion object {
        fun parse(raw: String): PairPayload? {
            val trimmed = raw.trim()
            if (!trimmed.startsWith("jarvis://pair", ignoreCase = true)) return null
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
            val host = uri.getQueryParameter("host")?.takeIf { it.isNotBlank() } ?: return null
            val code = uri.getQueryParameter("code")?.takeIf { it.isNotBlank() } ?: return null
            val fp = uri.getQueryParameter("fp")?.takeIf { it.isNotBlank() }
            return PairPayload(host, code, fp)
        }
    }
}
