package com.jarvis.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.data.VoiceSettings
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.BrainEvent
import com.jarvis.app.voice.VoiceController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

data class ChatUiState(
    val sessionId: String,
    val items: List<ChatItem> = emptyList(),
    val pending: List<PendingImage> = emptyList(),
    val sending: Boolean = false,
    val busy: Boolean = false, // a turn is in flight (between turn_started and final)
    val error: String? = null,
)

/**
 * Owns one chat session. Loads history, subscribes to that session's live
 * NormalizedBrainEvent stream, and folds the events (Contract B kinds) into a flat
 * list of [ChatItem]s the UI renders. Outbound: send text + photos, cancel the turn,
 * respond to approvals (after the caller clears the BiometricPrompt).
 */
class ChatViewModel(
    private val repo: JarvisRepository,
    private val voice: VoiceController,
    private val voiceSettings: VoiceSettings,
    sessionId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ChatUiState(sessionId = sessionId))
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    /** Push-to-talk / TTS phase, surfaced to the mic button. */
    val voicePhase = voice.phase

    private val seq = AtomicLong(0)
    private fun nextId() = "item-${seq.incrementAndGet()}"

    /** Buffers the latest assistant message of the in-flight turn for spoken read-back. */
    private var lastAssistantText: String? = null

    /** Read-back only applies to live events, never to the history replay on open. */
    @Volatile private var historyReplayed = false

    init {
        loadHistory()
        subscribe()
    }

    // --- voice (push-to-talk) ---------------------------------------------

    fun startRecording(): Boolean = voice.startRecording()

    fun cancelRecording() = voice.cancelRecording()

    /** Stop recording, transcribe via voice.stt; [onText] receives the transcript draft. */
    fun stopAndTranscribe(onText: (String) -> Unit) {
        viewModelScope.launch {
            val text = voice.stopAndTranscribe()
            if (text != null) onText(text) else _uiState.update { it.copy(error = "No speech recognized") }
        }
    }

    fun stopSpeaking() = voice.stopSpeaking()

    private fun loadHistory() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.history(_uiState.value.sessionId) } }
                .onSuccess { events -> events.forEach(::fold) }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
            historyReplayed = true
        }
    }

    private fun subscribe() {
        viewModelScope.launch {
            repo.eventsFor(_uiState.value.sessionId).collect(::fold)
        }
    }

    fun attach(image: PendingImage) =
        _uiState.update { it.copy(pending = it.pending + image) }

    fun removeAttachment(previewUri: String) =
        _uiState.update { it.copy(pending = it.pending.filterNot { p -> p.previewUri == previewUri }) }

    fun send(text: String) {
        val trimmed = text.trim()
        val images = _uiState.value.pending
        if (trimmed.isEmpty() && images.isEmpty()) return

        // Optimistic user bubble.
        if (trimmed.isNotEmpty()) {
            appendItem(ChatItem.Message(nextId(), role = "user", text = trimmed))
        }
        _uiState.update { it.copy(sending = true, pending = emptyList(), error = null) }

        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.send(
                        sessionId = _uiState.value.sessionId,
                        text = trimmed,
                        images = images.map { it.mime to it.b64 },
                    )
                }
            }.onFailure { e -> _uiState.update { it.copy(error = e.message) } }
            _uiState.update { it.copy(sending = false) }
        }
    }

    fun cancel() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.cancel(_uiState.value.sessionId) } }
        }
    }

    /** Caller MUST have cleared the BiometricPrompt before invoking this. */
    fun respondApproval(approvalId: String, decision: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.respondApproval(_uiState.value.sessionId, approvalId, decision)
                }
            }.onSuccess {
                _uiState.update { st ->
                    st.copy(items = st.items.map {
                        if (it is ChatItem.Approval && it.approvalId == approvalId) {
                            it.copy(resolved = decision)
                        } else it
                    })
                }
            }.onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun clearError() = _uiState.update { it.copy(error = null) }

    // --- event folding -----------------------------------------------------

    private fun fold(ev: BrainEvent) {
        when (ev.kind) {
            "turn_started" -> _uiState.update { it.copy(busy = true) }
            "thinking" -> ev.text?.let { appendItem(ChatItem.Thinking(nextId(), it)) }
            "message" -> {
                val role = ev.role ?: "assistant"
                if (role != "user") lastAssistantText = ev.text
                appendItem(ChatItem.Message(nextId(), role = role, text = ev.text.orEmpty()))
            }
            "tool_call" -> appendItem(
                ChatItem.ToolCall(
                    id = ev.callId ?: nextId(),
                    name = ev.name ?: "tool",
                    argsJson = ev.argsJson,
                ),
            )
            "tool_result" -> mergeToolResult(ev)
            "diff" -> appendItem(
                ChatItem.Diff(nextId(), path = ev.path ?: "(file)", patch = ev.patch.orEmpty()),
            )
            "approval" -> appendItem(
                ChatItem.Approval(
                    id = nextId(),
                    approvalId = ev.approvalId ?: nextId(),
                    summary = ev.summary ?: "Jarvis needs approval",
                    risk = ev.risk ?: "medium",
                ),
            )
            "error" -> {
                appendItem(ChatItem.Error(nextId(), ev.message ?: "error"))
                _uiState.update { it.copy(busy = false) }
            }
            "final" -> {
                _uiState.update { it.copy(busy = false) }
                // Speak the turn's final assistant message if read-back is on.
                val reply = lastAssistantText
                lastAssistantText = null
                if (historyReplayed && voiceSettings.readBackEnabled && !reply.isNullOrBlank()) {
                    viewModelScope.launch { voice.speak(reply, voiceSettings.ttsVoice) }
                }
            }
            // thread_started / usage / unknown: nothing to render directly.
        }
    }

    private fun mergeToolResult(ev: BrainEvent) {
        val callId = ev.callId ?: return
        _uiState.update { st ->
            val existing = st.items.indexOfFirst { it is ChatItem.ToolCall && it.id == callId }
            if (existing >= 0) {
                val tc = st.items[existing] as ChatItem.ToolCall
                val updated = tc.copy(output = ev.output, ok = ev.bool("ok") ?: true)
                st.copy(items = st.items.toMutableList().apply { set(existing, updated) })
            } else {
                // Orphan result (no preceding call seen) — show it standalone.
                st.copy(
                    items = st.items + ChatItem.ToolCall(
                        id = nextId(),
                        name = "result",
                        argsJson = null,
                        output = ev.output,
                        ok = ev.bool("ok") ?: true,
                    ),
                )
            }
        }
    }

    private fun appendItem(item: ChatItem) =
        _uiState.update { it.copy(items = it.items + item) }

    companion object {
        fun factory(app: JarvisApp, sessionId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChatViewModel(
                        repo = app.repository,
                        voice = VoiceController(app.repository, app.ttsPlayer),
                        voiceSettings = app.voiceSettings,
                        sessionId = sessionId,
                    ) as T
            }
    }
}
