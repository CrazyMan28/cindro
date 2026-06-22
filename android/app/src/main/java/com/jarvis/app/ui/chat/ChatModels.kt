package com.jarvis.app.ui.chat

/** A renderable chat item folded from the NormalizedBrainEvent stream (Contract B). */
sealed interface ChatItem {
    val id: String

    /** A user or assistant text bubble. */
    data class Message(
        override val id: String,
        val role: String, // "user" | "assistant"
        val text: String,
    ) : ChatItem

    /** Streaming reasoning ("thinking") — shown dimmed, collapsible. */
    data class Thinking(override val id: String, val text: String) : ChatItem

    /** A tool invocation; [output] / [ok] fill in when the matching tool_result arrives. */
    data class ToolCall(
        override val id: String,
        val name: String,
        val argsJson: String?,
        val output: String? = null,
        val ok: Boolean? = null,
    ) : ChatItem

    /** A code diff the brain produced. */
    data class Diff(override val id: String, val path: String, val patch: String) : ChatItem

    /** An approval the daemon is waiting on — gated behind biometrics to respond. */
    data class Approval(
        override val id: String,
        val approvalId: String,
        val summary: String,
        val risk: String,
        val resolved: String? = null, // null | "allow" | "deny" | "always"
    ) : ChatItem

    /** A turn-level error. */
    data class Error(override val id: String, val message: String) : ChatItem
}

/** Locally-attached photo pending send (mime + base64 + a thumbnail uri string). */
data class PendingImage(val mime: String, val b64: String, val previewUri: String)
