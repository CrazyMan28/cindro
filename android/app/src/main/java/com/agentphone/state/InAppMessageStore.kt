package com.agentphone.state

import org.json.JSONArray
import org.json.JSONObject

data class UiMessage(
    val id: String,
    val threadId: String,
    val callId: String?,
    val sessionId: String?,
    val fromExtension: String,
    val toExtension: String,
    val fromType: String,
    val toType: String,
    val title: String,
    val body: String,
    val priority: String,
    var status: String,
    val requiresResponse: Boolean,
    val responseOptions: List<String>,
    var responseText: String?,
    var selectedOption: String?,
    val createdAt: String,
    var deliveredAt: String?,
    var readAt: String?,
    var repliedAt: String?,
    val kind: String?,
    val metadata: JSONObject
) {
    companion object {
        fun fromJson(json: JSONObject): UiMessage {
            // The server stores (and sends) response_options/metadata as JSON
            // STRINGS, not structures — optJSONObject/optJSONArray return null
            // for a String, which silently dropped every approve/deny option
            // button. Parse the string form when the structured form is absent.
            val metadata = json.optJSONObject("metadata")
                ?: json.optString("metadata").takeIf { it.isNotBlank() }?.let {
                    runCatching { JSONObject(it) }.getOrNull()
                } ?: JSONObject()
            val options = mutableListOf<String>()
            val raw = json.optJSONArray("response_options")
                ?: json.optString("response_options").takeIf { it.isNotBlank() }?.let {
                    runCatching { org.json.JSONArray(it) }.getOrNull()
                }
            if (raw != null) for (i in 0 until raw.length()) options.add(raw.optString(i))
            return UiMessage(
                id = json.optString("id"),
                threadId = json.optString("thread_id"),
                callId = json.optStringOrNull("call_id"),
                sessionId = json.optStringOrNull("session_id"),
                fromExtension = json.optString("from_extension"),
                toExtension = json.optString("to_extension"),
                fromType = json.optString("from_type", "agent"),
                toType = json.optString("to_type", "device"),
                title = json.optString("title"),
                body = json.optString("body"),
                priority = json.optString("priority", "normal"),
                status = json.optString("status", "queued"),
                requiresResponse = json.optInt("requires_response", 0) == 1,
                responseOptions = options,
                responseText = json.optStringOrNull("response_text"),
                selectedOption = json.optStringOrNull("selected_option"),
                createdAt = json.optString("created_at"),
                deliveredAt = json.optStringOrNull("delivered_at"),
                readAt = json.optStringOrNull("read_at"),
                repliedAt = json.optStringOrNull("replied_at"),
                kind = metadata.optStringOrNull("kind"),
                metadata = metadata
            )
        }
    }
}

data class UiThread(
    val id: String,
    val subject: String,
    val relatedExtension: String?,
    val latestMessageAt: String,
    val status: String,
    val latestPreview: String,
    val unreadCount: Int,
    val highestPriority: String
)

object InAppMessageStore {
    private val messages = mutableListOf<UiMessage>()
    private val listeners = mutableSetOf<() -> Unit>()

    @Synchronized
    fun snapshot(): List<UiMessage> = messages.toList()

    @Synchronized
    fun threadsForExtension(extension: String): List<UiThread> {
        val byThread = messages.filter { it.fromExtension == extension || it.toExtension == extension }
            .groupBy { it.threadId }
        return byThread.entries.map { (threadId, msgs) ->
            val sorted = msgs.sortedBy { it.createdAt }
            val latest = sorted.last()
            val unread = msgs.count { it.toExtension == extension && it.status !in setOf("read", "replied", "expired") }
            val highest = msgs.map { it.priority }
                .maxByOrNull { priorityWeight(it) } ?: "normal"
            UiThread(
                id = threadId,
                subject = latest.title,
                relatedExtension = extension,
                latestMessageAt = latest.createdAt,
                status = if (unread > 0) "unread" else "open",
                latestPreview = latest.body.take(140),
                unreadCount = unread,
                highestPriority = highest
            )
        }.sortedByDescending { it.latestMessageAt }
    }

    @Synchronized
    fun messagesForThread(threadId: String): List<UiMessage> =
        messages.filter { it.threadId == threadId }.sortedBy { it.createdAt }

    @Synchronized
    fun upsert(message: UiMessage) {
        dropOptimisticMatch(message)
        val index = messages.indexOfFirst { it.id == message.id }
        if (index >= 0) messages[index] = message else messages.add(message)
        notifyListeners()
    }

    @Synchronized
    fun upsertAll(items: Collection<UiMessage>) {
        items.forEach { item ->
            dropOptimisticMatch(item)
            val index = messages.indexOfFirst { it.id == item.id }
            if (index >= 0) messages[index] = item else messages.add(item)
        }
        notifyListeners()
    }

    /**
     * Show the user's outgoing message immediately, before the server round-trips,
     * so it doesn't look like it vanished. Replaced by the server's copy once it
     * arrives (see [dropOptimisticMatch]). Returns the temporary id.
     */
    @Synchronized
    fun addOptimisticOutgoing(threadId: String, fromExtension: String, toExtension: String, body: String): String {
        val id = "local-${System.currentTimeMillis()}"
        messages.add(
            UiMessage(
                id = id,
                threadId = threadId,
                callId = null,
                sessionId = null,
                fromExtension = fromExtension,
                toExtension = toExtension,
                fromType = "device",
                toType = "agent",
                title = "",
                body = body,
                priority = "normal",
                status = "sending",
                requiresResponse = false,
                responseOptions = emptyList(),
                responseText = null,
                selectedOption = null,
                createdAt = java.time.Instant.now().toString(),
                deliveredAt = null,
                readAt = null,
                repliedAt = null,
                kind = null,
                metadata = JSONObject()
            )
        )
        notifyListeners()
        return id
    }

    @Synchronized
    fun removeThread(threadId: String) {
        messages.removeAll { it.threadId == threadId }
        notifyListeners()
    }

    // When the real server message lands, drop the optimistic placeholder it supersedes.
    private fun dropOptimisticMatch(item: UiMessage) {
        if (item.id.startsWith("local-")) return
        messages.removeAll {
            it.id.startsWith("local-") &&
                it.fromExtension == item.fromExtension &&
                it.toExtension == item.toExtension &&
                it.body == item.body
        }
    }

    @Synchronized
    fun markStatus(messageId: String, status: String, responseText: String? = null, selectedOption: String? = null) {
        val index = messages.indexOfFirst { it.id == messageId }
        if (index < 0) return
        val current = messages[index]
        messages[index] = current.copy().also {
            it.status = status
            if (responseText != null) it.responseText = responseText
            if (selectedOption != null) it.selectedOption = selectedOption
        }
        notifyListeners()
    }

    fun subscribe(listener: () -> Unit): () -> Unit {
        synchronized(this) { listeners.add(listener) }
        return {
            synchronized(this) { listeners.remove(listener) }
        }
    }

    private fun notifyListeners() {
        val snapshot = listeners.toList()
        snapshot.forEach { it.invoke() }
    }

    private fun priorityWeight(priority: String): Int = when (priority) {
        "critical" -> 4
        "urgent" -> 3
        "normal" -> 2
        "low" -> 1
        else -> 0
    }
}

fun JSONObject.optStringOrNull(name: String): String? {
    if (!has(name) || isNull(name)) return null
    val value = optString(name)
    return value.ifBlank { null }
}

fun parseMessageList(json: String): List<UiMessage> {
    val array = JSONArray(json)
    val out = mutableListOf<UiMessage>()
    for (i in 0 until array.length()) {
        val obj = array.optJSONObject(i) ?: continue
        out.add(UiMessage.fromJson(obj))
    }
    return out
}
