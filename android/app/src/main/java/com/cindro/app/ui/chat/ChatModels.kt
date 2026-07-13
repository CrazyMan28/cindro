package com.cindro.app.ui.chat

import androidx.compose.runtime.Immutable

/** A renderable chat item folded from the NormalizedBrainEvent stream (Contract B).
 *
 *  Every variant is @Immutable: once folded, an item's fields never mutate (an
 *  update produces a NEW instance with the same id). That lets Compose skip
 *  recomposing unchanged rows in the LazyColumn — important once a chat has 95+
 *  items, where ToolCall's `List<String>` would otherwise mark the type unstable
 *  and re-run every bubble on each new event. */
sealed interface ChatItem {
    val id: String

    /** A user or assistant text bubble. */
    @Immutable
    data class Message(
        override val id: String,
        val role: String, // "user" | "assistant"
        val text: String,
        /** True while this assistant reply is still arriving — drives the typewriter reveal. */
        val streaming: Boolean = false,
    ) : ChatItem

    /** Streaming reasoning ("thinking") — shown dimmed, collapsible. */
    @Immutable
    data class Thinking(override val id: String, val text: String) : ChatItem

    /** A tool invocation; [output] / [ok] fill in when the matching tool_result arrives.
     *  [images] holds any base64 image blobs found in the result (e.g. a screenshot
     *  tool returning PNGs) so the chat can render them instead of a wall of base64. */
    @Immutable
    data class ToolCall(
        override val id: String,
        val name: String,
        val argsJson: String?,
        val output: String? = null,
        val ok: Boolean? = null,
        val images: List<String> = emptyList(),
        val server: String? = null,
    ) : ChatItem

    /** A code diff the brain produced. */
    @Immutable
    data class Diff(override val id: String, val path: String, val patch: String) : ChatItem

    /** An approval the daemon is waiting on — gated behind biometrics to respond. */
    @Immutable
    data class Approval(
        override val id: String,
        val approvalId: String,
        val summary: String,
        val risk: String,
        val resolved: String? = null, // null | "allow" | "deny" | "always"
    ) : ChatItem

    /** A turn-level error. */
    @Immutable
    data class Error(override val id: String, val message: String) : ChatItem

    /** A file Cindro sent to the phone (jarvis_send_file -> file.offer). Images render
     *  inline; any other type shows a saveable file card. */
    @Immutable
    data class FileOffer(
        override val id: String,
        val name: String,
        val mime: String?,
        val size: Long?,
        val b64: String?,
    ) : ChatItem

    /** A canvas/widget the model rendered (render_widget -> widget.render). [specJson]
     *  is the raw DSL tree the phone draws via WidgetRenderer; a later event with the
     *  same [id] replaces it in place (live updates). */
    @Immutable
    data class Widget(
        override val id: String,
        val title: String,
        val specJson: String,
    ) : ChatItem
}

/** Locally-attached photo pending send (mime + base64 + a thumbnail uri string). */
data class PendingImage(val mime: String, val b64: String, val previewUri: String)

/**
 * One-shot handoff from [com.cindro.app.ui.chat.NewChatScreen]'s blank composer to
 * the real [ChatViewModel] once its session exists: NewChatScreen has no session id
 * to send against until `session.create` returns, so it stashes the draft the user
 * already typed and [ChatViewModel.init] consumes it (a normal [ChatViewModel.send]
 * call — same optimistic bubble / haptics / slash-command handling as any other
 * message) the moment it mounts for that session id. Not for anything else.
 */
object PendingFirstMessage {
    private var sessionId: String? = null
    private var text: String = ""
    private var images: List<PendingImage> = emptyList()

    fun stash(sessionId: String, text: String, images: List<PendingImage>) {
        this.sessionId = sessionId
        this.text = text
        this.images = images
    }

    /** Returns and clears the stashed draft only if it matches [sessionId]. */
    fun consume(sessionId: String): Pair<String, List<PendingImage>>? {
        if (this.sessionId != sessionId) return null
        val result = text to images
        this.sessionId = null
        text = ""
        images = emptyList()
        return result
    }
}
