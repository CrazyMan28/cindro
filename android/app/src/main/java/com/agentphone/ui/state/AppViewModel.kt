package com.agentphone.ui.state

import android.app.Application
import android.content.Intent
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.agentphone.IncomingCallActivity
import com.agentphone.OutgoingCallActivity
import com.agentphone.audio.LocalTtsEngine
import com.agentphone.audio.PushToTalkAudio
import com.agentphone.net.AgentPhoneClient
import com.agentphone.net.ApiResult
import com.agentphone.net.PhoneEvent
import com.agentphone.service.AgentPhoneForegroundService
import com.agentphone.service.CallForegroundService
import com.cindro.app.JarvisApp
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.state.AgentPhoneSettings
import com.agentphone.state.CallStateReducer
import com.agentphone.state.ConnectionStatus
import com.agentphone.state.ConnectionTroubleshooter
import com.agentphone.state.DiagnosticsState
import com.agentphone.state.InAppMessageStore
import com.agentphone.state.OutgoingCallBridge
import com.agentphone.state.PhoneAction
import com.agentphone.state.PhoneUiState
import com.agentphone.state.UiMessage
import com.agentphone.state.UiThread
import com.agentphone.state.parseMessageList
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class AppViewModel(application: Application) : AndroidViewModel(application) {

    private val app: Application get() = getApplication()

    private val _settings = MutableStateFlow(AgentPhonePreferences.loadSettings(app))
    val settings: StateFlow<AgentPhoneSettings> = _settings.asStateFlow()

    private val _phone = MutableStateFlow(PhoneUiState())
    val phone: StateFlow<PhoneUiState> = _phone.asStateFlow()

    private val _diagnostics = MutableStateFlow(DiagnosticsState())
    val diagnostics: StateFlow<DiagnosticsState> = _diagnostics.asStateFlow()

    private val _statusLine = MutableStateFlow("disconnected")
    val statusLine: StateFlow<String> = _statusLine.asStateFlow()

    private val _threads = MutableStateFlow<List<UiThread>>(emptyList())
    val threads: StateFlow<List<UiThread>> = _threads.asStateFlow()

    val audio: PushToTalkAudio by lazy { PushToTalkAudio(app) }

    private var outgoingCallShown = false
    private var lastDialedExtension: String = ""

    private val unsubscribe: () -> Unit

    val client: AgentPhoneClient = AgentPhoneClient(
        onEvent = ::onEvent,
        onStatus = ::onStatus
    )

    init {
        refreshThreads()
        unsubscribe = InAppMessageStore.subscribe { refreshThreads() }
        // OutgoingCallActivity (a separate activity) routes its mic + hang-up
        // through these so audio goes over THIS live connection — the one that
        // placed the call and receives the agent's TTS — not a second socket.
        OutgoingCallBridge.onAudioStart = { startListening() }
        OutgoingCallBridge.onAudioStop = { stopListening() }
        OutgoingCallBridge.onMuteChanged = { muted -> audio.setMuted(muted) }
        OutgoingCallBridge.onEndCall = { endActiveCall() }
        if (AgentPhonePreferences.isAlwaysOnEnabled(app)) {
            AgentPhoneForegroundService.start(app, "app_launch")
        }
    }

    override fun onCleared() {
        unsubscribe()
        OutgoingCallBridge.onAudioStart = null
        OutgoingCallBridge.onAudioStop = null
        OutgoingCallBridge.onMuteChanged = null
        OutgoingCallBridge.onEndCall = null
        audio.release()
        client.disconnect()
        super.onCleared()
    }

    private fun refreshThreads() {
        _threads.value = InAppMessageStore.threadsForExtension(_settings.value.extension)
    }

    fun threadMessages(threadId: String): List<UiMessage> =
        InAppMessageStore.messagesForThread(threadId)

    fun updateSettings(serverUrl: String? = null, token: String? = null, extension: String? = null, audioFormat: String? = null, pushToTalk: Boolean? = null) {
        val current = _settings.value
        val next = current.copy(
            serverUrl = serverUrl?.trim() ?: current.serverUrl,
            token = token?.trim() ?: current.token,
            extension = (extension?.trim()?.ifBlank { "100" }) ?: current.extension,
            audioFormat = (audioFormat?.trim()?.ifBlank { "pcm_s16le" }) ?: current.audioFormat,
            pushToTalkEnabled = pushToTalk ?: current.pushToTalkEnabled
        )
        _settings.value = next
        AgentPhonePreferences.saveSettings(app, next)
        refreshThreads()
    }

    fun connect() = client.connect(_settings.value)
    fun reconnect() = client.manualReconnect(_settings.value)

    fun dial(toExtension: String): Boolean {
        if (_phone.value.connection != ConnectionStatus.ONLINE) return false
        val sent = client.dial(_settings.value.extension, toExtension)
        if (!sent) return false
        // Show the call screen immediately so the user always gets feedback,
        // even if the server later reports the agent offline/failed (the screen
        // then shows the reason instead of nothing happening). dial_result fills
        // in the real callId once the server assigns one.
        lastDialedExtension = toExtension
        OutgoingCallBridge.reset()
        OutgoingCallBridge.publishState(OutgoingCallBridge.State.Dialing(toExtension))
        outgoingCallShown = true
        app.startActivity(
            Intent(app, OutgoingCallActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(OutgoingCallActivity.EXTRA_CALL_ID, "")
                .putExtra(OutgoingCallActivity.EXTRA_TO_EXTENSION, toExtension)
        )
        return true
    }

    fun accept(callId: String) {
        client.accept(callId, _settings.value.extension)
        _phone.update { CallStateReducer.reduce(it, PhoneAction.CallAccepted(callId)) }
        startCallService("Agent call active", "Call $callId")
    }

    fun reject(callId: String) {
        client.reject(callId, _settings.value.extension)
        _phone.update { CallStateReducer.reduce(it, PhoneAction.CallEnded(callId)) }
        app.stopService(Intent(app, CallForegroundService::class.java))
    }

    fun endActiveCall() {
        val id = _phone.value.activeCallId ?: return
        client.end(id, _settings.value.extension)
        app.stopService(Intent(app, CallForegroundService::class.java))
    }

    fun sendText(text: String) {
        val id = _phone.value.activeCallId ?: return
        client.sendText(id, _settings.value.extension, text)
    }

    fun toggleMute(enabled: Boolean) {
        _phone.update { CallStateReducer.reduce(it, PhoneAction.ToggleMute(enabled)) }
    }

    fun toggleSpeaker(enabled: Boolean) {
        _phone.update { CallStateReducer.reduce(it, PhoneAction.ToggleSpeaker(enabled)) }
    }

    /**
     * Start continuous, hands-free listening for the active call. The on-device VAD inside
     * [audio] drives one audio_start/chunk/end cycle per spoken turn — no push-to-talk.
     */
    fun startListening(): Boolean {
        val callId = _phone.value.activeCallId ?: return false
        val ext = _settings.value.extension
        return audio.startContinuous(
            onUtteranceStart = { client.audioStart(callId, ext, "pcm_s16le", 16_000, 1) },
            onChunk = { chunk -> client.audioChunk(callId, ext, chunk) },
            onUtteranceEnd = { client.audioEnd(callId, ext) }
        )
    }

    fun stopListening() {
        audio.stop()
    }

    fun markMessageRead(message: UiMessage) {
        client.markMessageRead(message.id)
        client.postMessageRead(_settings.value, message.id) { /* ignore */ }
        InAppMessageStore.markStatus(message.id, "read")
    }

    fun replyMessage(message: UiMessage, text: String?, option: String?) {
        if (!text.isNullOrBlank()) {
            // Show the user's outgoing text instantly so it doesn't look like it vanished.
            InAppMessageStore.addOptimisticOutgoing(
                threadId = message.threadId,
                fromExtension = _settings.value.extension,
                toExtension = message.fromExtension,
                body = text
            )
            InAppMessageStore.markStatus(message.id, "replied")
        } else {
            InAppMessageStore.markStatus(message.id, "replied", null, option)
        }
        // Single delivery path — sending over BOTH WebSocket and HTTP created duplicate replies.
        client.postMessageReply(_settings.value, message.id, text, option) { /* ignore */ }
    }

    /** Send a message inside an existing chat thread (continue the conversation). */
    fun sendInThread(threadId: String, toExtension: String, text: String) {
        if (text.isBlank()) return
        InAppMessageStore.addOptimisticOutgoing(threadId, _settings.value.extension, toExtension, text)
        client.createMessage(_settings.value, toExtension, text, threadId) { result ->
            if (result.ok) try { InAppMessageStore.upsert(UiMessage.fromJson(JSONObject(result.body))) } catch (_: Throwable) {}
        }
    }

    /** Start a brand-new chat with an agent; calls back with the new thread id. */
    fun startChat(toExtension: String, text: String, onThread: (String) -> Unit) {
        if (text.isBlank()) return
        client.createMessage(_settings.value, toExtension, text, null) { result ->
            if (result.ok) try {
                val msg = UiMessage.fromJson(JSONObject(result.body))
                InAppMessageStore.upsert(msg)
                onThread(msg.threadId)
            } catch (_: Throwable) { /* ignore */ }
        }
    }

    /** Read an agent's current model + thinking level. Calls back (model, reasoning). */
    fun getModelConfig(extension: String, callback: (String?, String?) -> Unit) {
        client.getModelConfig(_settings.value, extension) { result ->
            var model: String? = null
            var reasoning: String? = null
            if (result.ok) try {
                val o = JSONObject(result.body)
                model = o.optString("model").ifBlank { null }
                reasoning = o.optString("reasoning").ifBlank { null }
            } catch (_: Throwable) {}
            callback(model, reasoning)
        }
    }

    /** Set an agent's model and/or thinking level (applies on its next message). */
    fun setModelConfig(extension: String, model: String?, reasoning: String?, onDone: () -> Unit = {}) {
        client.putModelConfig(_settings.value, extension, model, reasoning) { onDone() }
    }

    /**
     * Live model ids for `brain` ("claude"/"codex"), same daemon model.list RPC
     * the main Jarvis picker uses — via the shared JarvisRepository on the
     * Application singleton (this phone subsystem has its own AgentPhoneClient
     * for the vendored phone server's REST API, but talks to the SAME jarvisd
     * over the SAME connection for daemon-native RPCs like this one). Replaces
     * the phone-agent picker's old hardcoded model id list, which went stale
     * the same way the main picker's used to before it was wired to model.list.
     */
    fun listModelsForBrain(brain: String, callback: (List<String>) -> Unit) {
        viewModelScope.launch {
            val ids = runCatching { (app as JarvisApp).repository.listModels(brain) }
                .getOrDefault(emptyList())
                .map { it.id }
            callback(ids)
        }
    }

    /** Start a real group chat (one shared thread with several agents); calls back
     *  with the new thread id so the UI can open it. */
    fun startGroupChat(members: List<String>, text: String, onThread: (String) -> Unit) {
        if (text.isBlank() || members.isEmpty()) return
        client.createGroupChat(_settings.value, members, text) { result ->
            if (result.ok) {
                fetchPendingMessages()
                try {
                    val tid = JSONObject(result.body).optString("threadId")
                    if (tid.isNotBlank()) onThread(tid)
                } catch (_: Throwable) { /* ignore */ }
            }
        }
    }

    /**
     * Conference CALL with only the chosen agents. The server opens the call
     * already-active and sends us dial_result + call_accept, so the normal call
     * handlers light the screen up; we launch it optimistically (like dial())
     * for instant feedback while agents spawn.
     */
    fun startConferenceCall(members: List<String>): Boolean {
        if (members.isEmpty()) return false
        // Same guard as dial(): the call screen is lit by dial_result/call_accept
        // over the WebSocket — with no live socket the HTTP POST would succeed
        // server-side while the screen hangs on "Calling…" forever.
        if (_phone.value.connection != ConnectionStatus.ONLINE) return false
        val label = "Conference (${members.joinToString(", ")})"
        lastDialedExtension = label
        OutgoingCallBridge.reset()
        OutgoingCallBridge.publishState(OutgoingCallBridge.State.Dialing(label))
        outgoingCallShown = true
        app.startActivity(
            Intent(app, OutgoingCallActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(OutgoingCallActivity.EXTRA_CALL_ID, "")
                .putExtra(OutgoingCallActivity.EXTRA_TO_EXTENSION, label)
        )
        client.startConference(_settings.value, members) { result ->
            if (!result.ok) {
                OutgoingCallBridge.publishState(
                    OutgoingCallBridge.State.Failed(null, result.error ?: "conference failed")
                )
            }
        }
        return true
    }

    /** Voice catalog for the Settings voice picker: list of (id-or-null, name). */
    fun listVoices(callback: (List<Pair<String?, String>>) -> Unit) {
        client.getVoices(_settings.value) { result ->
            val voices = mutableListOf<Pair<String?, String>>()
            if (result.ok) try {
                val arr = JSONObject(result.body).optJSONArray("voices")
                if (arr != null) for (i in 0 until arr.length()) {
                    val v = arr.getJSONObject(i)
                    val id = if (v.isNull("id")) null else v.optString("id").ifBlank { null }
                    voices.add(id to v.optString("name", id ?: "Default"))
                }
            } catch (_: Throwable) {}
            if (voices.isEmpty()) voices.add(null to "Default")
            callback(voices)
        }
    }

    fun getVoiceConfig(extension: String, callback: (String?) -> Unit) {
        client.getVoiceProfile(_settings.value, extension) { result ->
            var voiceId: String? = null
            if (result.ok) try {
                voiceId = JSONObject(result.body).optString("voiceId").ifBlank { null }
            } catch (_: Throwable) {}
            callback(voiceId)
        }
    }

    /** Voice profile with speaking rate, for the per-agent config screen. */
    fun getVoiceProfileFull(extension: String, callback: (String?, Double) -> Unit) {
        client.getVoiceProfile(_settings.value, extension) { result ->
            var voiceId: String? = null
            var speed = 1.0
            if (result.ok) try {
                val o = JSONObject(result.body)
                voiceId = o.optString("voiceId").ifBlank { null }
                speed = o.optDouble("speed", 1.0)
            } catch (_: Throwable) {}
            callback(voiceId, if (speed.isNaN()) 1.0 else speed)
        }
    }

    fun setVoiceConfig(extension: String, voiceId: String?, voiceName: String?, onDone: (Boolean) -> Unit = {}) {
        client.putVoiceProfile(_settings.value, extension, voiceId, voiceName) { result ->
            // A silently-swallowed failure here once left the chip looking
            // selected while the server kept the old voice — surface it.
            if (!result.ok) _statusLine.value = "Voice save failed: ${result.error ?: "HTTP ${result.statusCode}"}"
            onDone(result.ok)
        }
    }

    fun setVoiceSpeed(extension: String, speed: Double, onDone: () -> Unit = {}) {
        client.putVoiceSpeed(_settings.value, extension, speed) { onDone() }
    }

    // --- voice preview (one-off playback, independent of call audio) ---
    private var previewPlayer: android.media.MediaPlayer? = null
    /** Monotonic token: only the LATEST previewVoice call may start a player.
     *  Without it, two quick triggers (chip tap + ▶, or tap-tap while the
     *  sample is still downloading) each fired their async play() — stopping
     *  the player can't cancel an in-flight download callback. */
    private var previewGeneration = 0
    private var previewActiveId: String? = null

    /** Download + play a voice's sample. Stops any previous preview first. */
    fun previewVoice(voiceId: String?, onResult: (Boolean) -> Unit = {}) {
        if (voiceId == null) { stopVoicePreview(); onResult(false); return }
        // Debounce: the same voice is already playing or being fetched — the
        // second trigger (set-chip then ▶) must not stack a second playback.
        if (previewActiveId == voiceId) { onResult(true); return }
        val gen = ++previewGeneration
        stopVoicePreview()
        previewActiveId = voiceId
        // ON-DEVICE voice (e.g. local:jarvis): preview plays the model's BUNDLED
        // sample clip from the server — it NEVER runs the native sherpa engine,
        // so previewing can't crash the app (the engine only runs during a real
        // call). Mistral voices fetch their /sample. Both just download+play mp3.
        val samplePath = if (voiceId.startsWith("local:"))
            "/api/local-voices/${voiceId.removePrefix("local:")}/sample.mp3"
        else "/api/voices/$voiceId/sample"
        val dest = java.io.File(app.cacheDir, "voice-preview-${voiceId.replace(":", "_")}.mp3")
        val play = play@{
            if (gen != previewGeneration) return@play // superseded by a newer preview
            try {
                val player = android.media.MediaPlayer()
                previewPlayer = player
                player.setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                player.setDataSource(dest.absolutePath)
                player.setOnCompletionListener { stopVoicePreview() }
                player.setOnErrorListener { _, _, _ -> stopVoicePreview(); true }
                player.prepare()
                player.start()
                onResult(true)
            } catch (_: Throwable) {
                stopVoicePreview()
                onResult(false)
            }
        }
        if (dest.exists() && dest.length() > 0) play()
        else client.downloadFile(_settings.value, samplePath, dest) { ok ->
            if (ok) play() else { if (gen == previewGeneration) previewActiveId = null; onResult(false) }
        }
    }

    fun stopVoicePreview() {
        previewPlayer?.let { p ->
            try { p.stop() } catch (_: Throwable) {}
            try { p.release() } catch (_: Throwable) {}
        }
        previewPlayer = null
        previewActiveId = null
    }

    /**
     * ON-DEVICE voice (e.g. Jarvis): the server sends TEXT (`tts_local`), the
     * PHONE synthesizes it. Claim the call first so only one of the two
     * sockets does the work, then synthesize off-main and join the normal
     * serial playback queue.
     */
    private fun handleLocalTts(event: com.agentphone.net.PhoneEvent) {
        val callId = event.callId ?: return
        val voiceId = event.raw.optString("voiceId").ifBlank { return }
        val text = event.text ?: event.raw.optString("text").ifBlank { return }
        val speed = event.raw.optDouble("speed", 1.0).toFloat()
        if (!audio.claimCallPlayback(callId)) return
        Thread {
            try {
                if (!LocalTtsEngine.isReady(app, voiceId)) {
                    _statusLine.value = "Downloading on-device voice…"
                    if (!LocalTtsEngine.ensureReady(app, client, _settings.value, voiceId, { s -> _statusLine.value = s })) {
                        _statusLine.value = "On-device voice download failed"
                        return@Thread
                    }
                }
                val wav = LocalTtsEngine.synthesizeToWav(app, voiceId, text, speed)
                if (wav != null) audio.enqueueLocalTts(callId, event.messageId, wav)
                else _statusLine.value = "On-device synthesis failed"
            } catch (error: Throwable) {
                _statusLine.value = "On-device voice error: ${error.message}"
            }
        }.start()
    }

    fun deleteThread(threadId: String) {
        InAppMessageStore.removeThread(threadId)
        // Track the delete until the SERVER confirms it. Fire-and-forget here
        // meant a flaky request silently failed and the "deleted" conversation
        // reappeared on the next sync.
        AgentPhonePreferences.addPendingThreadDelete(app, threadId)
        client.deleteThread(_settings.value, threadId) { result ->
            if (result.ok || result.statusCode == 404) {
                AgentPhonePreferences.removePendingThreadDelete(app, threadId)
            }
        }
    }

    /** Re-attempt server deletions that never got confirmed (called on connect/sync). */
    fun retryPendingThreadDeletes() {
        for (threadId in AgentPhonePreferences.pendingThreadDeletes(app)) {
            InAppMessageStore.removeThread(threadId) // keep it gone locally too
            client.deleteThread(_settings.value, threadId) { result ->
                if (result.ok || result.statusCode == 404) {
                    AgentPhonePreferences.removePendingThreadDelete(app, threadId)
                }
            }
        }
    }

    /** Full call-screening config: master switch, chosen agent, available agents, transport. */
    data class ScreeningConfig(
        val enabled: Boolean,
        val inboundExtension: String,
        val screeningExtension: String,
        val agents: List<Pair<String, String>>,
        val transport: String
    )

    fun getScreeningConfig(callback: (ScreeningConfig?) -> Unit) {
        client.getScreeningEnabled(_settings.value) { result ->
            val config = if (result.ok) try {
                val o = JSONObject(result.body)
                val agents = mutableListOf<Pair<String, String>>()
                val arr = o.optJSONArray("agents")
                if (arr != null) for (i in 0 until arr.length()) {
                    val a = arr.optJSONObject(i) ?: continue
                    val ext = a.optString("extension").ifBlank { continue }
                    agents.add(ext to a.optString("name", "Agent $ext"))
                }
                ScreeningConfig(
                    o.optBoolean("enabled"),
                    o.optString("inbound_extension"),
                    o.optString("screening_extension").ifBlank { o.optString("inbound_extension") },
                    agents,
                    o.optString("transport", "twilio")
                )
            } catch (_: Throwable) { null } else null
            callback(config)
        }
    }

    /** Read just the master switch. */
    fun getScreeningEnabled(callback: (Boolean?) -> Unit) {
        client.getScreeningEnabled(_settings.value) { result ->
            val enabled = if (result.ok) try { JSONObject(result.body).optBoolean("enabled") } catch (_: Throwable) { null } else null
            callback(enabled)
        }
    }

    /** Choose which agent SCREENS unknown callers. */
    fun setScreeningAgent(extension: String, callback: (Boolean) -> Unit) {
        client.setScreeningAgent(_settings.value, extension) { result -> callback(result.ok) }
    }

    /** Choose which agent answers when YOU dial the Twilio number. */
    fun setInboundAgent(extension: String, callback: (Boolean) -> Unit) {
        client.setInboundAgent(_settings.value, extension) { result -> callback(result.ok) }
    }

    /** Choose the screening transport: "twilio" (carrier-forwarded) or "relay" (Bluetooth puck). */
    fun setScreeningTransport(transport: String, callback: (Boolean) -> Unit) {
        client.setScreeningTransport(_settings.value, transport) { result -> callback(result.ok) }
    }

    /** Flip the server's call-screening master switch; reports the resulting state. */
    fun setScreeningEnabled(enabled: Boolean, callback: (Boolean?) -> Unit) {
        client.setScreeningEnabled(_settings.value, enabled) { result ->
            val now = if (result.ok) try { JSONObject(result.body).optBoolean("enabled") } catch (_: Throwable) { null } else null
            callback(now)
        }
    }

    // ---- "Text your agent" over SMS -----------------------------------------

    data class SmsAgentConfig(
        val enabled: Boolean,
        val extension: String,
        val agents: List<Pair<String, String>>
    )

    fun getSmsAgentConfig(callback: (SmsAgentConfig?) -> Unit) {
        client.getSmsAgent(_settings.value) { result ->
            val config = if (result.ok) try {
                val o = JSONObject(result.body)
                val agents = mutableListOf<Pair<String, String>>()
                val arr = o.optJSONArray("agents")
                if (arr != null) for (i in 0 until arr.length()) {
                    val a = arr.optJSONObject(i) ?: continue
                    val ext = a.optString("extension").ifBlank { continue }
                    agents.add(ext to a.optString("name", "Agent $ext"))
                }
                SmsAgentConfig(o.optBoolean("enabled"), o.optString("extension"), agents)
            } catch (_: Throwable) { null } else null
            callback(config)
        }
    }

    /** Flip "text your agent" on/off; reports the resulting state. */
    fun setSmsAgentEnabled(enabled: Boolean, callback: (Boolean?) -> Unit) {
        client.setSmsAgentEnabled(_settings.value, enabled) { result ->
            val now = if (result.ok) try { JSONObject(result.body).optBoolean("enabled") } catch (_: Throwable) { null } else null
            callback(now)
        }
    }

    /** Choose which agent answers inbound SMS. */
    fun setSmsAgent(extension: String, callback: (Boolean) -> Unit) {
        client.setSmsAgent(_settings.value, extension) { result -> callback(result.ok) }
    }

    fun listAgents(callback: (List<Pair<String, String>>) -> Unit) {
        client.getAgents(_settings.value) { result ->
            val out = mutableListOf<Pair<String, String>>()
            if (result.ok) try {
                val arr = JSONArray(result.body)
                for (i in 0 until arr.length()) {
                    val a = arr.optJSONObject(i) ?: continue
                    val ext = a.optString("extension").ifBlank { continue }
                    out.add(ext to a.optString("name", "Agent $ext"))
                }
            } catch (_: Throwable) { /* ignore */ }
            callback(out)
        }
    }

    suspend fun enrollAgent(
        name: String,
        agentIdOverride: String? = null,
        extensionOverride: String? = null,
        command: String? = null,
        adapterType: String = "remote-stdio"
    ): EnrollmentPackage = kotlinx.coroutines.suspendCancellableCoroutine { cont ->
        val body = JSONObject().apply {
            put("name", name)
            if (!agentIdOverride.isNullOrBlank()) put("agentId", agentIdOverride)
            if (!extensionOverride.isNullOrBlank()) put("extension", extensionOverride)
            put("adapterType", adapterType)
            if (!command.isNullOrBlank()) {
                val parts = command.trim().split(Regex("\\s+"))
                put("command", parts.first())
                if (parts.size > 1) {
                    val args = JSONArray()
                    parts.drop(1).forEach { args.put(it) }
                    put("args", args)
                }
                put("mode", "stdio")
            }
        }
        client.enrollAgent(_settings.value, body) { result ->
            if (!result.ok) {
                cont.resumeWith(Result.failure(RuntimeException(result.error ?: "enroll failed: HTTP ${result.statusCode ?: '?'}")))
                return@enrollAgent
            }
            try {
                val pkg = EnrollmentPackage.fromJson(JSONObject(result.body))
                cont.resumeWith(Result.success(pkg))
            } catch (e: Throwable) {
                cont.resumeWith(Result.failure(e))
            }
        }
    }

    fun fetchPendingMessages() {
        // First finish any deletions the server never confirmed — otherwise the
        // sync below re-imports the very conversation the user deleted.
        retryPendingThreadDeletes()
        client.getPendingMessages(_settings.value) { result ->
            if (!result.ok) return@getPendingMessages
            try {
                val items = parseMessageList(result.body)
                val zombies = AgentPhonePreferences.pendingThreadDeletes(app)
                InAppMessageStore.upsertAll(items.filter { it.threadId !in zombies })
            } catch (_: Throwable) { /* swallow */ }
        }
    }

    fun enableAlwaysOn() {
        AgentPhonePreferences.setAlwaysOnEnabled(app, true)
        AgentPhoneForegroundService.start(app, "enabled_from_setup")
    }

    fun loadDiagnostics(callback: (com.agentphone.state.AlwaysOnDiagnostics) -> Unit) {
        callback(AgentPhonePreferences.loadDiagnostics(app))
    }

    fun runDiagnostics(done: (() -> Unit)? = null) {
        val warning = ConnectionTroubleshooter.warningForUrl(_settings.value.serverUrl)
        _diagnostics.value = DiagnosticsState(lastError = warning, suggestedFix = warning)
        var remaining = 5
        fun finishOne() {
            remaining -= 1
            if (remaining <= 0) done?.invoke()
        }
        client.getHealth(_settings.value.serverUrl) { res ->
            _diagnostics.update { it.copy(
                healthOk = res.ok,
                lastError = if (res.ok) it.lastError else res.error,
                suggestedFix = if (res.ok) it.suggestedFix else res.error
            ) }
            finishOne()
        }
        client.getSetupStatus(_settings.value) { res ->
            _diagnostics.update {
                val authResolved = when {
                    res.statusCode == 401 || res.statusCode == 403 -> false
                    res.ok -> true
                    else -> it.authOk
                }
                it.copy(
                    setupStatusOk = res.ok,
                    authOk = authResolved,
                    lastError = if (res.ok) it.lastError else res.error,
                    suggestedFix = if (res.ok) it.suggestedFix else res.error
                )
            }
            if (res.ok) applySetupStatus(res.body)
            finishOne()
        }
        client.getExtensions(_settings.value) { res ->
            if (res.ok) {
                val arr = try { JSONArray(res.body) } catch (_: Throwable) { JSONArray() }
                var has = false
                for (i in 0 until arr.length()) if (arr.optJSONObject(i)?.optString("extension") == "100") has = true
                _diagnostics.update { it.copy(
                    authOk = true,
                    extensionExists = has,
                    extensionCount = arr.length(),
                    lastError = if (has) it.lastError else ConnectionTroubleshooter.EXTENSION_100_MESSAGE,
                    suggestedFix = if (has) it.suggestedFix else ConnectionTroubleshooter.EXTENSION_100_MESSAGE
                ) }
            } else {
                _diagnostics.update { it.copy(
                    authOk = if (res.statusCode == 401 || res.statusCode == 403) false else it.authOk,
                    lastError = res.error,
                    suggestedFix = res.error
                ) }
            }
            finishOne()
        }
        client.getAgents(_settings.value) { res ->
            _diagnostics.update {
                val count = if (res.ok) try { JSONArray(res.body).length() } catch (_: Throwable) { it.agentCount } else it.agentCount
                it.copy(
                    agentsOk = res.ok,
                    agentCount = count,
                    authOk = if (res.statusCode == 401 || res.statusCode == 403) false else it.authOk,
                    lastError = if (res.ok) it.lastError else res.error,
                    suggestedFix = if (res.ok) it.suggestedFix else res.error
                )
            }
            finishOne()
        }
        client.probeWebSocket(_settings.value) { res ->
            _diagnostics.update { it.copy(
                websocketOk = res.ok,
                lastError = if (res.ok) it.lastError else res.error,
                suggestedFix = if (res.ok) it.suggestedFix else res.error
            ) }
            finishOne()
        }
    }

    fun getExtensions(callback: (ApiResult) -> Unit) = client.getExtensions(_settings.value, callback)
    fun getAgents(callback: (ApiResult) -> Unit) = client.getAgents(_settings.value, callback)
    fun getCalls(callback: (ApiResult) -> Unit) = client.getCalls(_settings.value, callback)
    fun getMissedCalls(callback: (ApiResult) -> Unit) = client.getMissedCalls(_settings.value, callback)

    private fun applySetupStatus(body: String) {
        val json = try { JSONObject(body) } catch (_: Throwable) { return }
        val server = json.optJSONObject("server")
        val extensions = json.optJSONObject("extensions")
        val agents = json.optJSONObject("agents")
        val mistral = json.optJSONObject("mistral")
        val androidUrl = server?.optString("androidUrl")?.takeIf { it.isNotBlank() }
        _diagnostics.update { it.copy(
            suggestedAndroidUrl = androidUrl,
            extensionCount = extensions?.optInt("count"),
            extensionExists = extensions?.optBoolean("hasUser100"),
            agentCount = agents?.optInt("count"),
            agentsOk = agents != null,
            mistralConfigured = mistral?.optBoolean("apiKeyConfigured"),
            tailscaleReachable = it.tailscaleReachable ?: androidUrl?.let { url -> ConnectionTroubleshooter.isTailscaleUrl(url) }
        ) }
    }

    private fun startCallService(title: String, body: String) {
        val intent = Intent(app, CallForegroundService::class.java)
            .putExtra("title", title)
            .putExtra("body", body)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(intent) else app.startService(intent)
    }

    private fun onStatus(value: String) {
        _statusLine.value = value
        _phone.update { state ->
            when {
                value == "ONLINE" || value == "connected" -> CallStateReducer.reduce(state, PhoneAction.Connected)
                value == "CONNECTING" || value == "connecting" || value == "opened" -> state.copy(connection = ConnectionStatus.CONNECTING)
                value == "AUTHENTICATING" -> state.copy(connection = ConnectionStatus.AUTHENTICATING)
                value == "RECONNECTING" || value.startsWith("reconnecting") -> state.copy(connection = ConnectionStatus.RECONNECTING)
                value.startsWith("ERROR") -> state.copy(connection = ConnectionStatus.ERROR)
                value == "DISCONNECTED" || value.startsWith("disconnected") -> CallStateReducer.reduce(state, PhoneAction.Disconnected)
                else -> state
            }
        }
        _diagnostics.update { it.copy(
            lastWebSocketState = value,
            lastWebSocketError = if (value.startsWith("ERROR") || value == "DISCONNECTED" || value.startsWith("disconnected")) value else it.lastWebSocketError
        ) }
    }

    private fun onEvent(event: PhoneEvent) {
        _diagnostics.update { it.copy(lastWebSocketEvent = event.type) }
        when (event.type) {
            // Call screening: the foreground service shows the notification; here we
            // just keep the shared store in sync (seq dedup absorbs the double feed)
            // so the screening window works whichever socket delivered the event.
            "screening_started" -> {
                val callId = event.callId ?: return
                com.agentphone.state.ScreeningStore.start(
                    callId,
                    event.raw.optString("callerNumber").ifBlank { "unknown number" },
                    event.raw.optString("forwardedFrom").ifBlank { null }
                )
            }
            "screening_update" -> com.agentphone.state.ScreeningStore.append(
                event.callId,
                event.raw.optInt("seq", -1),
                event.raw.optString("speaker"),
                event.text ?: event.raw.optString("text")
            )
            "screening_ended" -> com.agentphone.state.ScreeningStore.end(event.callId, event.raw.optString("outcome", "ended"))
            "incoming_call" -> {
                val id = event.callId ?: return
                _phone.update { CallStateReducer.reduce(it, PhoneAction.IncomingCall(id, event.fromExtension)) }
                val launch = Intent(app, IncomingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra("callId", id)
                    putExtra("fromExtension", event.fromExtension)
                }
                app.startActivity(launch)
            }
            "dial_result" -> {
                val callId = event.callId ?: return
                val rawTo = event.toExtension ?: ""
                // 902 is the server's internal conference group extension — show
                // the roster label the user actually picked, not a magic number.
                val toExt = if (rawTo == CONFERENCE_GROUP_EXTENSION) lastDialedExtension.ifBlank { "Conference" } else rawTo
                _phone.update { it.copy(activeCallId = callId, peerExtension = toExt) }
                OutgoingCallBridge.publishState(OutgoingCallBridge.State.Ringing(callId, toExt))
                if (!outgoingCallShown) {
                    outgoingCallShown = true
                    app.startActivity(
                        Intent(app, OutgoingCallActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            .putExtra(OutgoingCallActivity.EXTRA_CALL_ID, callId)
                            .putExtra(OutgoingCallActivity.EXTRA_TO_EXTENSION, toExt)
                    )
                }
            }
            "call_accept" -> {
                val callId = event.callId ?: return
                _phone.update { CallStateReducer.reduce(it, PhoneAction.CallAccepted(callId)) }
                startCallService("Agent call active", "Call $callId")
                OutgoingCallBridge.publishState(OutgoingCallBridge.State.Active(callId))
            }
            "call_end", "call_reject" -> {
                _phone.update { CallStateReducer.reduce(it, PhoneAction.CallEnded(event.callId)) }
                event.callId?.let { audio.clearTtsForCall(it) }
                app.stopService(Intent(app, CallForegroundService::class.java))
                OutgoingCallBridge.publishState(OutgoingCallBridge.State.Ended(event.callId, event.type))
                outgoingCallShown = false
            }
            "call_failed" -> {
                _phone.update { CallStateReducer.reduce(it, PhoneAction.CallEnded(event.callId)) }
                event.callId?.let { audio.clearTtsForCall(it) }
                val message = event.message ?: event.raw.optString("message", "call failed")
                _diagnostics.update { it.copy(lastWebSocketError = message, lastError = message, suggestedFix = message) }
                _statusLine.value = "Call failed: $message"
                app.stopService(Intent(app, CallForegroundService::class.java))
                OutgoingCallBridge.publishState(OutgoingCallBridge.State.Failed(event.callId, message))
                outgoingCallShown = false
            }
            "call_state", "call_timeout" -> {
                val callState = event.state ?: event.type.removePrefix("call_")
                _phone.update { CallStateReducer.reduce(it, PhoneAction.CallState(event.callId, callState)) }
                if (callState == "timeout" || callState == "ended" || callState == "rejected" || callState == "failed") {
                    OutgoingCallBridge.publishState(OutgoingCallBridge.State.Ended(event.callId, callState))
                    outgoingCallShown = false
                }
            }
            "call_message" -> {
                val line = "${event.fromExtension ?: "peer"}: ${event.content ?: ""}"
                _phone.update { CallStateReducer.reduce(it, PhoneAction.Transcript(line)) }
                OutgoingCallBridge.publishTranscript(line)
            }
            "transcript_partial" -> {
                val line = "partial: ${event.text ?: ""}"
                _phone.update { CallStateReducer.reduce(it, PhoneAction.Transcript(line)) }
                OutgoingCallBridge.publishTranscript(line)
            }
            "transcript_final" -> {
                val line = "final: ${event.text ?: ""}"
                _phone.update { CallStateReducer.reduce(it, PhoneAction.Transcript(line)) }
                OutgoingCallBridge.publishTranscript(line)
            }
            "tts_start" -> event.callId?.let { id ->
                audio.beginTts(id, event.messageId, event.audioFormat ?: "mp3", event.mimeType ?: "audio/mpeg")
            }
            "tts_chunk" -> event.callId?.let { id ->
                event.audioBase64?.let { audio.appendTtsChunk(id, event.messageId, it) }
            }
            "tts_end" -> event.callId?.let { id -> audio.endTts(id, event.messageId) }
            "tts_local" -> handleLocalTts(event)
            "audio_error" -> {
                val message = event.message ?: "audio error"
                _diagnostics.update { it.copy(lastWebSocketError = message, lastError = message, suggestedFix = message) }
                _statusLine.value = message
                // Utterance-scoped when the server names the failed message —
                // clearing the whole call would cut off OTHER agents' speech.
                event.callId?.let { id ->
                    val mid = event.messageId
                    if (mid != null) audio.clearTtsUtterance(id, mid) else audio.clearTtsForCall(id)
                }
            }
            "missed_call" -> {
                event.callId?.let { id ->
                    _phone.update { CallStateReducer.reduce(it, PhoneAction.MissedCall(id, event.fromExtension)) }
                }
                val who = event.toExtension ?: lastDialedExtension.ifBlank { "the agent" }
                OutgoingCallBridge.publishState(
                    OutgoingCallBridge.State.Failed(event.callId, "No answer — $who is offline")
                )
                outgoingCallShown = false
            }
            "presence_update" -> {
                if (event.raw.optString("extension") == _settings.value.extension && event.raw.optBoolean("online", false)) {
                    _phone.update { CallStateReducer.reduce(it, PhoneAction.Connected) }
                    _diagnostics.update { it.copy(websocketOk = true, lastWebSocketState = "connected") }
                    _statusLine.value = "connected as ${_settings.value.extension}"
                }
            }
            "hello" -> {
                if (event.raw.optString("extension") == _settings.value.extension) {
                    _phone.update { CallStateReducer.reduce(it, PhoneAction.Connected) }
                    _diagnostics.update { it.copy(websocketOk = true, lastWebSocketState = "connected") }
                    _statusLine.value = "connected as ${_settings.value.extension}"
                } else {
                    _statusLine.value = "websocket opened; auth pending"
                }
            }
            "error" -> {
                val message = event.raw.optString("message", "websocket error")
                _diagnostics.update { it.copy(
                    lastWebSocketError = message,
                    lastError = message,
                    suggestedFix = ConnectionTroubleshooter.messageForFailure(message)
                ) }
                _statusLine.value = message
            }
        }
    }

    companion object {
        /** Server-side group extension that conference calls dial through (warRoom.ts). */
        private const val CONFERENCE_GROUP_EXTENSION = "902"

        val Factory: ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: androidx.lifecycle.viewmodel.CreationExtras): T {
                val app = extras[androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as Application
                return AppViewModel(app) as T
            }
        }
    }
}
