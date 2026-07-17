package com.cindro.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.data.AppPrefs
import com.cindro.app.data.VoiceSettings
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.BrainEvent
import com.cindro.app.ui.util.Haptics
import com.cindro.app.voice.VoiceController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
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
    /** Multi-select mode in the message list (long-press a bubble to enter). */
    val selecting: Boolean = false,
    val selected: Set<String> = emptySet(),
    /** "/" command palette catalog (loaded lazily when the user types "/"). */
    val slashAgents: List<com.cindro.app.protocol.Agent> = emptyList(),
    val slashSkills: List<com.cindro.app.protocol.Skill> = emptyList(),
    /** This session's brain/model, for the chat top-bar chip (read-only display —
     *  there is no daemon RPC to switch brain/model on a live session; picking a
     *  different one starts a New chat instead). Loaded once, best-effort. */
    val brain: String? = null,
    val model: String? = null,
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
    private val appPrefs: AppPrefs,
    private val haptics: Haptics,
    sessionId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ChatUiState(sessionId = sessionId))
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    /** Push-to-talk / TTS phase, surfaced to the mic button. */
    val voicePhase = voice.phase

    /** Whether subtle chat haptics are on (Settings toggle; default ON). */
    val hapticsEnabled: Boolean get() = appPrefs.hapticsEnabled

    /** Soft micro-vibration fired by the bubble as it reveals streamed characters. */
    fun onStreamReveal() = haptics.streamTick(appPrefs.hapticsEnabled)

    private val seq = AtomicLong(0)
    private fun nextId() = "item-${seq.incrementAndGet()}"

    /** Buffers the latest assistant message of the in-flight turn for spoken read-back. */
    private var lastAssistantText: String? = null

    /** id of the ChatItem.Thinking currently accumulating this turn's reasoning
     *  chunks, or null when no thinking block is open. Set on the first "thinking"
     *  event of a turn; cleared (via freezeThinking) on the first non-thinking
     *  event, so later "thinking" chunks append to the SAME item instead of each
     *  starting a new bubble. */
    private var currentThinkingId: String? = null

    /** Read-back only applies to live events, never to the history replay on open. */
    @Volatile private var historyReplayed = false

    /** Completes once [loadHistory] has folded the transcript. [subscribe] awaits this
     *  before folding any LIVE event, so a live event that races in during the history
     *  fetch can't be applied out of order and scramble the transcript. */
    private val historyReady = kotlinx.coroutines.CompletableDeferred<Unit>()

    /** This session's brain/model (for the vision gate below); loaded once, best-effort. */
    @Volatile private var sessionBrain: String? = null
    @Volatile private var sessionModel: String? = null

    init {
        loadHistory()
        loadSessionInfo()
        subscribe()
        holdWidgetViewingLease()
        // NewChatScreen's blank composer created this session and stashed the first
        // message the user already typed — send it now via the normal send() path
        // (optimistic bubble, haptics, slash-command handling all apply as usual).
        PendingFirstMessage.consume(sessionId)?.let { (text, images) ->
            _uiState.update { it.copy(pending = images) }
            send(text)
        }
    }

    private fun loadSessionInfo() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSessions() } }
                .onSuccess { sessions ->
                    sessions.firstOrNull { it.id == _uiState.value.sessionId }?.let {
                        sessionBrain = it.brain
                        sessionModel = it.model
                        _uiState.update { st -> st.copy(brain = it.brain, model = it.model) }
                    }
                }
        }
    }

    /**
     * While this chat is open, hold a live-widget viewer lease for its session so
     * the session's live widgets keep updating (battery: when you leave the chat the
     * ViewModel is cleared, the heartbeat stops, and the lease TTLs out in ~45s so
     * those widgets idle). ~20s cadence stays inside the daemon's 45s lease TTL.
     */
    private fun holdWidgetViewingLease() {
        val sid = _uiState.value.sessionId
        if (sid.isBlank()) return
        viewModelScope.launch {
            while (true) {
                repo.widgetViewing(sid, active = true, kind = "chat")
                delay(20_000)
            }
        }
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
            // Signal in BOTH outcomes so a failed history load can't wedge the live
            // stream forever.
            historyReady.complete(Unit)
        }
    }

    private fun subscribe() {
        viewModelScope.launch {
            // Subscribe immediately (so no live event is missed), but hold folding until
            // history is applied — the collector suspends on await() while the flow
            // buffers, then folds buffered events in order after the transcript loads.
            repo.eventsFor(_uiState.value.sessionId).collect { ev ->
                if (!historyReady.isCompleted) historyReady.await()
                fold(ev)
            }
        }
        // Files Cindro sends (jarvis_send_file -> file.offer) land in THIS chat when
        // they target this session (or carry no session id). Shown only when the model
        // actually sends one.
        viewModelScope.launch {
            repo.fileOffers
                .filter { it.sessionId == null || it.sessionId == _uiState.value.sessionId }
                .collect { fo ->
                    appendItem(
                        ChatItem.FileOffer(
                            id = fo.id.ifBlank { nextId() },
                            name = fo.name,
                            mime = fo.mime,
                            size = fo.size,
                            b64 = fo.b64,
                        ),
                    )
                }
        }
        // Canvases/widgets the model renders (widget.render). Same id replaces in
        // place (live updates); remove/clear drop one/all. Scoped to this session.
        viewModelScope.launch {
            repo.widgetEvents.collect { w ->
                when (w.op) {
                    "render" -> {
                        if (w.sessionId != null && w.sessionId != _uiState.value.sessionId) return@collect
                        if (w.spec == null) return@collect
                        upsertWidget(
                            ChatItem.Widget(
                                id = w.id.ifBlank { nextId() },
                                title = w.title,
                                specJson = w.spec.toString(),
                            ),
                        )
                    }
                    "remove" -> _uiState.update { st ->
                        st.copy(items = st.items.filterNot { it is ChatItem.Widget && it.id == w.id })
                    }
                    "clear" -> _uiState.update { st ->
                        st.copy(items = st.items.filterNot { it is ChatItem.Widget })
                    }
                }
            }
        }
    }

    /** Append a widget, or replace an existing one with the same id in place. */
    private fun upsertWidget(item: ChatItem.Widget) = _uiState.update { st ->
        val idx = st.items.indexOfFirst { it is ChatItem.Widget && it.id == item.id }
        if (idx >= 0) st.copy(items = st.items.toMutableList().also { it[idx] = item })
        else st.copy(items = st.items + item)
    }

    /** Vision-gated with a friendly inline notice — never a silent drop (see VisionSupport). */
    fun attach(image: PendingImage) {
        if (!VisionSupport.supportsVision(sessionBrain, sessionModel)) {
            _uiState.update {
                it.copy(error = "This session's brain/model can't see images — switch to codex or claude (or a vision-capable model) to attach photos.")
            }
            return
        }
        _uiState.update { it.copy(pending = it.pending + image) }
    }

    fun removeAttachment(previewUri: String) =
        _uiState.update { it.copy(pending = it.pending.filterNot { p -> p.previewUri == previewUri }) }

    /** Lazily load the "/" palette catalog (agents + skills) the first time the
     *  user opens it, so the dropdown has live data to filter. */
    fun loadSlashCatalog() {
        if (_uiState.value.slashAgents.isNotEmpty() || _uiState.value.slashSkills.isNotEmpty()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listAgents() } }
                .onSuccess { a -> _uiState.update { it.copy(slashAgents = a) } }
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSkills() } }
                .onSuccess { s -> _uiState.update { it.copy(slashSkills = s) } }
        }
    }

    /** Handle a "/"-prefixed message. Returns true if it was a slash command (so
     *  send() shouldn't also forward it as plain chat text). "/dispatch <agent>
     *  <task>" spawns a subagent; "/<skill> <args>" invokes a skill and sends its
     *  rendered text; "/clear" just drops the draft. */
    private fun handleSlash(t: String): Boolean {
        val parts = t.split(Regex("\\s+"))
        val cmd = parts.firstOrNull().orEmpty()
        val rest = t.removePrefix(cmd).trim()
        when (cmd) {
            "/clear" -> return true
            "/dispatch" -> {
                val agent = parts.getOrNull(1).orEmpty()
                val task = rest.removePrefix(agent).trim()
                if (agent.isNotBlank() && task.isNotBlank()) {
                    viewModelScope.launch {
                        runCatching { withContext(Dispatchers.IO) { repo.dispatchAgent(agent, task, _uiState.value.sessionId) } }
                            .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
                    }
                }
                return true
            }
            else -> {
                // A skill invocation ("/name args"): let it through as a NORMAL user
                // message — the model loads it via the skill_load tool (per the system
                // prompt). So just "/name" shows; we don't dump the skill body.
                return false
            }
        }
    }

    fun send(text: String) {
        val trimmed = text.trim()
        val images = _uiState.value.pending
        if (trimmed.isEmpty() && images.isEmpty()) return

        // Slash command? Consume it (dispatch a subagent / invoke a skill / clear).
        if (trimmed.startsWith("/") && handleSlash(trimmed)) {
            _uiState.update { it.copy(pending = emptyList()) }
            return
        }

        // Light tick on send (ChatGPT-style).
        haptics.send(appPrefs.hapticsEnabled)

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

    /** A button/link inside a rendered widget fired its action. Fixed allow-set:
     *  send -> send that text as a message; skill -> invoke it. (open is handled by
     *  the screen, which has a Context.) Nothing is ever evaluated. */
    fun onWidgetAction(action: com.google.gson.JsonObject) {
        action.get("send")?.asString?.takeIf { it.isNotBlank() }?.let { send(it); return }
        action.get("skill")?.asString?.takeIf { it.isNotBlank() }?.let { name ->
            val args = action.get("args")?.asString.orEmpty()
            send("/" + name + if (args.isNotBlank()) " $args" else "")
        }
    }

    // --- event folding -----------------------------------------------------

    private fun fold(ev: BrainEvent) {
        when (ev.kind) {
            "turn_started" -> {
                // A new turn shouldn't carry over a stale accumulation ref — but if
                // one is somehow still open, leave that item's endedAtMs untouched
                // (don't fabricate a freeze time for it here).
                currentThinkingId = null
                _uiState.update { it.copy(busy = true) }
            }
            "thinking" -> ev.text?.let { chunk -> appendOrAppendThinking(chunk) }
            "message" -> {
                freezeThinking()
                val role = ev.role ?: "assistant"
                if (role != "user") lastAssistantText = ev.text
                // Live assistant replies stream in with a typewriter reveal; the
                // history replay (and user echoes) render fully at once.
                val streaming = historyReplayed && role != "user"
                appendItem(
                    ChatItem.Message(
                        id = nextId(),
                        role = role,
                        text = ev.text.orEmpty(),
                        streaming = streaming,
                    ),
                )
            }
            "tool_call" -> {
                freezeThinking()
                appendItem(
                    ChatItem.ToolCall(
                        id = ev.callId ?: nextId(),
                        name = ev.name ?: "tool",
                        argsJson = ev.argsJson,
                        server = ev.server,
                    ),
                )
            }
            "tool_result" -> mergeToolResult(ev)
            "diff" -> {
                freezeThinking()
                appendItem(
                    ChatItem.Diff(nextId(), path = ev.path ?: "(file)", patch = ev.patch.orEmpty()),
                )
            }
            "approval" -> {
                freezeThinking()
                appendItem(
                    ChatItem.Approval(
                        id = nextId(),
                        approvalId = ev.approvalId ?: nextId(),
                        summary = ev.summary ?: "Cindro needs approval",
                        risk = ev.risk ?: "medium",
                    ),
                )
            }
            "error" -> {
                freezeThinking()
                appendItem(ChatItem.Error(nextId(), ev.message ?: "error"))
                finishStreaming(hapticComplete = false)
                _uiState.update { it.copy(busy = false) }
            }
            "final" -> {
                freezeThinking()
                finishStreaming(hapticComplete = historyReplayed)
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

    /** Append a "thinking" chunk: if a thinking item is already accumulating this
     *  turn, append the chunk to its existing text in place; otherwise start a new
     *  one and remember its id so subsequent chunks fold into it too. */
    private fun appendOrAppendThinking(chunk: String) {
        val id = currentThinkingId
        if (id != null) {
            _uiState.update { st ->
                st.copy(items = st.items.map {
                    if (it is ChatItem.Thinking && it.id == id) it.copy(text = it.text + chunk) else it
                })
            }
        } else {
            val newId = nextId()
            currentThinkingId = newId
            appendItem(ChatItem.Thinking(newId, chunk, startedAtMs = System.currentTimeMillis()))
        }
    }

    /** Stamp endedAtMs on the currently-accumulating thinking item (if any) and
     *  clear the ref, so the NEXT "thinking" event (if any) starts a fresh block
     *  instead of appending to this now-closed one. Called at the top of every
     *  non-thinking branch, before that branch's own logic runs. */
    private fun freezeThinking() {
        val id = currentThinkingId ?: return
        currentThinkingId = null
        val now = System.currentTimeMillis()
        _uiState.update { st ->
            st.copy(items = st.items.map {
                if (it is ChatItem.Thinking && it.id == id) it.copy(endedAtMs = now) else it
            })
        }
    }

    private fun mergeToolResult(ev: BrainEvent) {
        val callId = ev.callId ?: return
        val images = extractImages(ev.output)
        _uiState.update { st ->
            val existing = st.items.indexOfFirst { it is ChatItem.ToolCall && it.id == callId }
            if (existing >= 0) {
                val tc = st.items[existing] as ChatItem.ToolCall
                val updated = tc.copy(output = ev.output, ok = ev.bool("ok") ?: true, images = images)
                st.copy(items = st.items.toMutableList().apply { set(existing, updated) })
            } else {
                // Orphan result (no preceding call) — codex reports a completed call
                // as one item, so the result carries the name/args/server too: show
                // them as a full card (input + output), not just output.
                st.copy(
                    items = st.items + ChatItem.ToolCall(
                        id = ev.callId ?: nextId(),
                        name = ev.name ?: "result",
                        argsJson = ev.argsJson,
                        output = ev.output,
                        ok = ev.bool("ok") ?: true,
                        images = images,
                        server = ev.server,
                    ),
                )
            }
        }
    }

    /**
     * Pull base64 image blobs out of a tool result so the chat can render them as
     * pictures instead of a wall of base64 (e.g. the screenshot / computer-use tools
     * return MCP image content). Finds a known image magic (PNG/JPEG/GIF/WebP) and
     * walks the base64 run with a plain loop — NO regex, because a greedy
     * `{64,}` over a 600KB+ screenshot can StackOverflow Android's java.util.regex.
     * Works regardless of how the MCP envelope is quoted/nested.
     */
    private fun extractImages(output: String?): List<String> {
        if (output.isNullOrBlank()) return emptyList()
        return runCatching {
            val magics = listOf("iVBORw0KGg", "/9j/", "R0lGOD", "UklGR")
            val out = ArrayList<String>()
            var i = 0
            while (i < output.length && out.size < 6) {
                var start = -1
                for (m in magics) {
                    val idx = output.indexOf(m, i)
                    if (idx >= 0 && (start < 0 || idx < start)) start = idx
                }
                if (start < 0) break
                var j = start
                while (j < output.length) {
                    val c = output[j]
                    if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' ||
                        c == '+' || c == '/' || c == '='
                    ) j++ else break
                }
                if (j - start >= 128) out.add(output.substring(start, j))
                i = j + 1
            }
            out.distinct()
        }.getOrDefault(emptyList())
    }

    private fun appendItem(item: ChatItem) =
        _uiState.update { it.copy(items = it.items + item) }

    /**
     * Turn ended: clear the streaming flag on any in-flight assistant bubble (so it
     * renders fully) and, for a live turn, fire the completion tick.
     */
    private fun finishStreaming(hapticComplete: Boolean) {
        var hadStreaming = false
        _uiState.update { st ->
            st.copy(items = st.items.map {
                if (it is ChatItem.Message && it.streaming) {
                    hadStreaming = true
                    it.copy(streaming = false)
                } else it
            })
        }
        if (hapticComplete && hadStreaming) haptics.complete(appPrefs.hapticsEnabled)
    }

    // --- selection + delete / copy ----------------------------------------

    /** Enter multi-select with [id] selected (from a long-press). */
    fun startSelection(id: String) =
        _uiState.update { it.copy(selecting = true, selected = setOf(id)) }

    fun toggleSelection(id: String) = _uiState.update { st ->
        val next = if (id in st.selected) st.selected - id else st.selected + id
        st.copy(selecting = next.isNotEmpty(), selected = next)
    }

    fun clearSelection() = _uiState.update { it.copy(selecting = false, selected = emptySet()) }

    /** Delete one item locally (and best-effort from session.history on the daemon). */
    fun deleteItems(ids: Set<String>) {
        if (ids.isEmpty()) return
        _uiState.update { st ->
            st.copy(
                items = st.items.filterNot { it.id in ids },
                selecting = false,
                selected = emptySet(),
            )
        }
    }

    companion object {
        fun factory(app: JarvisApp, sessionId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ChatViewModel(
                        repo = app.repository,
                        voice = VoiceController(app.repository, app.ttsPlayer),
                        voiceSettings = app.voiceSettings,
                        appPrefs = app.appPrefs,
                        haptics = Haptics(app),
                        sessionId = sessionId,
                    ) as T
            }
    }
}
