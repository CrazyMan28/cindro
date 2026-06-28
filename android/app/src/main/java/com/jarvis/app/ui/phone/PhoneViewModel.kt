package com.jarvis.app.ui.phone

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.jarvis.app.JarvisApp
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.Params
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ── Data models ──────────────────────────────────────────────────────────────

data class PhoneCall(
    val id: String,
    val state: String,
    val fromExtension: String?,
    val toExtension: String?,
    val reason: String?,
    val urgency: String?,
)

data class PhoneAgent(
    val name: String,
    val extension: String,
    val status: String,
    val task: String,
)

data class InboxMessage(
    val id: String,
    val threadId: String?,
    val title: String,
    val message: String,
    val status: String,
    val priority: String,
    val fromExtension: String?,
    val createdAt: String?,
    val responseOptions: List<String>,
)

data class PhoneThread(
    val id: String,
    val subject: String,
    val relatedExtension: String?,
    val latestPreview: String,
    val latestMessageAt: String,
    val unreadCount: Int,
    val highestPriority: String,
)

data class ThreadMsg(
    val id: String,
    val fromExtension: String,
    val toExtension: String,
    val body: String,
    val title: String,
    val status: String,
    val priority: String,
    val createdAt: String,
    val responseOptions: List<String>,
    val responseText: String?,
    val selectedOption: String?,
    val requiresResponse: Boolean,
    val threadId: String,
)

data class VoiceOption(val id: String?, val name: String)

data class CallHistoryEntry(
    val from: String,
    val to: String,
    val state: String,
    val reason: String,
    val createdAt: String,
    val missed: Boolean,
)

data class PhoneDiagnostics(
    val healthOk: Boolean? = null,
    val authOk: Boolean? = null,
    val agentsOk: Boolean? = null,
    val agentCount: Int? = null,
    val lastError: String? = null,
    val lastWebSocketState: String = "idle",
    val suggestedFix: String? = null,
)

data class ScreeningConfig(
    val enabled: Boolean = false,
    val inboundExtension: String = "",
    val screeningExtension: String = "",
    val transport: String = "twilio",
    val agents: List<Pair<String, String>> = emptyList(),
)

data class SmsAgentConfig(
    val enabled: Boolean = false,
    val extension: String = "",
    val agents: List<Pair<String, String>> = emptyList(),
)

data class TwilioStatus(
    val configured: Boolean = false,
    val fromNumber: String? = null,
    val screeningEnabled: Boolean = false,
    val smsAgentEnabled: Boolean = false,
)

data class AllowlistEntry(
    val phoneNumber: String,
    val label: String?,
)

data class EnrollResult(
    val extension: String,
    val name: String,
    val agentId: String,
    val token: String,
    val bootstrapCmd: String,
    val mcpConfigJson: String,
    val fullJson: String,
)

enum class PhoneTab { CALLS, INBOX, AGENTS, HUD, SETTINGS }

data class PhoneUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
    val tab: PhoneTab = PhoneTab.CALLS,
    val statusLine: String = "disconnected",

    // Calls
    val activeCalls: List<PhoneCall> = emptyList(),
    val incomingCall: PhoneCall? = null,
    val callTranscripts: Map<String, String> = emptyMap(),

    // Inbox / Threads
    val threads: List<PhoneThread> = emptyList(),
    val inboxMessages: List<InboxMessage> = emptyList(),
    val currentThreadId: String? = null,
    val currentThreadMessages: List<ThreadMsg> = emptyList(),
    val threadLoading: Boolean = false,

    // Agents
    val phoneAgents: List<PhoneAgent> = emptyList(),
    val agentsLoading: Boolean = false,

    // Twilio / Settings
    val twilioStatus: TwilioStatus? = null,
    val allowlist: List<AllowlistEntry> = emptyList(),
    val defaultUserNumber: String = "",
    val screeningConfig: ScreeningConfig? = null,
    val smsAgentConfig: SmsAgentConfig? = null,

    // Voice / Model per-agent
    val voiceOptions: List<VoiceOption> = emptyList(),
    val agentVoiceConfigs: Map<String, Pair<String?, Double>> = emptyMap(),
    val agentModelConfigs: Map<String, Pair<String?, String?>> = emptyMap(),
    val voicePreviewStatus: String = "",

    // History
    val callHistory: List<CallHistoryEntry> = emptyList(),
    val historyLoading: Boolean = false,

    // Diagnostics
    val diagnostics: PhoneDiagnostics = PhoneDiagnostics(),

    // Enrollment
    val enrollResult: EnrollResult? = null,
    val enrollLoading: Boolean = false,
    val enrollError: String? = null,
)

// ── ViewModel ────────────────────────────────────────────────────────────────

class PhoneViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(PhoneUiState())
    val uiState: StateFlow<PhoneUiState> = _uiState.asStateFlow()

    init { refresh() }

    // ── Navigation ──────────────────────────────────────────────────────────

    fun setTab(tab: PhoneTab) = _uiState.update { it.copy(tab = tab) }
    fun clearToast() = _uiState.update { it.copy(toast = null) }
    fun clearError() = _uiState.update { it.copy(error = null) }
    fun dismissIncomingCall() = _uiState.update { it.copy(incomingCall = null) }
    fun clearEnrollResult() = _uiState.update { it.copy(enrollResult = null, enrollError = null) }

    // ── Core refresh ────────────────────────────────────────────────────────

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val calls = safePhoneMcp("list_active_calls") { parseActiveCalls(it) } ?: emptyList()
            val inbox = safePhoneMcp("list_inbox") { parseInboxMessages(it) } ?: emptyList()
            val threads = safePhoneMcp("list_inbox") { parseThreads(it) } ?: emptyList()
            val twilioStatus = safePhoneMcp("twilio_status") { parseTwilioStatus(it) }
            val (allowlist, defaultNumber) =
                safePhoneMcp("twilio_allowlist_list") { parseAllowlist(it) }
                    ?: (emptyList<AllowlistEntry>() to "")
            val terminalStates = setOf("ended", "failed", "missed", "rejected", "timeout")
            val ringing = calls.firstOrNull { it.state == "ringing" }
            _uiState.update {
                it.copy(
                    loading = false,
                    statusLine = "connected",
                    activeCalls = calls.filter { c -> c.state !in terminalStates },
                    inboxMessages = inbox,
                    threads = threads,
                    twilioStatus = twilioStatus,
                    allowlist = allowlist,
                    defaultUserNumber = defaultNumber,
                    incomingCall = ringing,
                )
            }
        }
    }

    // ── Calls ───────────────────────────────────────────────────────────────

    fun placeCall(target: String, reason: String = "Jarvis call", say: String = "") {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val isPstn = target.startsWith("+") ||
                            (target.all { it.isDigit() } && target.length >= 10)
                    if (isPstn) {
                        repo.phoneMcp(
                            "twilio_call_and_wait",
                            Params.of("to_number" to target, "reason" to reason,
                                "say" to say.ifBlank { "Hello" })
                        )
                    } else {
                        repo.phoneMcp(
                            "call_extension",
                            Params.of("from_extension" to "101", "to_extension" to target)
                        )
                    }
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Calling $target…") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message, loading = false) } }
        }
    }

    fun endCall(callId: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("end_call", Params.of("call_id" to callId))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Call ended") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun acceptCall(callId: String) {
        _uiState.update { it.copy(incomingCall = null) }
    }

    fun declineCall(callId: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("end_call",
                        Params.of("call_id" to callId, "reason" to "rejected"))
                }
            }
                .onSuccess { _uiState.update { it.copy(incomingCall = null) }; refresh() }
                .onFailure { _uiState.update { it.copy(incomingCall = null) } }
        }
    }

    fun loadCallTranscript(callId: String) {
        viewModelScope.launch {
            val text = safePhoneMcp(
                "get_call_transcript",
                Params.of("call_id" to callId)
            ) { buildTranscriptText(it) } ?: ""
            _uiState.update { it.copy(callTranscripts = it.callTranscripts + (callId to text)) }
        }
    }

    // ── Agents ──────────────────────────────────────────────────────────────

    fun refreshAgents() {
        _uiState.update { it.copy(agentsLoading = true) }
        viewModelScope.launch {
            val agents = safePhoneMcp("list_agents") { parseAgents(it) }
                ?: safePhoneMcp("list_extensions") { parseAgentsFromExtensions(it) }
                ?: emptyList()
            _uiState.update { it.copy(agentsLoading = false, phoneAgents = agents) }
        }
    }

    // ── Inbox / Threads ─────────────────────────────────────────────────────

    fun refreshThreads() {
        viewModelScope.launch {
            val threads = safePhoneMcp("list_inbox") { parseThreads(it) } ?: return@launch
            val inbox = safePhoneMcp("list_inbox") { parseInboxMessages(it) } ?: emptyList()
            _uiState.update { it.copy(threads = threads, inboxMessages = inbox) }
        }
    }

    fun loadThread(threadId: String) {
        _uiState.update { it.copy(currentThreadId = threadId, threadLoading = true, currentThreadMessages = emptyList()) }
        viewModelScope.launch {
            val msgs = safePhoneMcp(
                "get_thread_messages",
                Params.of("thread_id" to threadId)
            ) { parseThreadMessages(it) } ?: emptyList()
            _uiState.update { it.copy(threadLoading = false, currentThreadMessages = msgs) }
        }
    }

    fun sendInThread(threadId: String, toExtension: String, text: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp(
                        "notify_user_and_wait",
                        Params.of("thread_id" to threadId,
                            "to_extension" to toExtension,
                            "message" to text)
                    )
                }
            }
                .onSuccess { loadThread(threadId) }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun replyMessage(msgId: String, threadId: String, responseText: String?, option: String?) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val args = Params.of("message_id" to msgId)
                    if (!responseText.isNullOrBlank()) args.addProperty("response_text", responseText)
                    if (!option.isNullOrBlank()) args.addProperty("selected_option", option)
                    repo.phoneMcp("reply_message", args)
                }
            }
                .onSuccess { loadThread(threadId) }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun deleteThread(threadId: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("delete_thread", Params.of("thread_id" to threadId))
                }
            }
                .onSuccess { refreshThreads() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun startChat(toExtension: String, text: String, onThread: (String) -> Unit) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("notify_user_and_wait",
                        Params.of("to_extension" to toExtension, "message" to text))
                }
            }
                .onSuccess { result ->
                    val threadId = result.get("thread_id")?.takeIf { !it.isJsonNull }?.asString
                        ?: result.dataObj()?.get("thread_id")?.takeIf { !it.isJsonNull }?.asString ?: ""
                    refreshThreads()
                    if (threadId.isNotBlank()) onThread(threadId)
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun startGroupChat(members: List<String>, text: String, onThread: (String) -> Unit) {
        viewModelScope.launch {
            val args = Params.of("message" to text)
            val arr = JsonArray().apply { members.forEach { add(it) } }
            args.add("members", arr)
            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp("group_chat", args) } }
                .onSuccess { result ->
                    val threadId = result.get("thread_id")?.takeIf { !it.isJsonNull }?.asString ?: ""
                    refreshThreads()
                    if (threadId.isNotBlank()) onThread(threadId)
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun startConferenceCall(members: List<String>) {
        viewModelScope.launch {
            val args = Params.of("from_extension" to "101")
            val arr = JsonArray().apply { members.forEach { add(it) } }
            args.add("members", arr)
            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp("conference_call", args) } }
                .onSuccess { _uiState.update { it.copy(toast = "Conference call started") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    fun sendText(title: String, message: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("notify_user", Params.of("title" to title, "message" to message))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Sent") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun toggleScreening(enable: Boolean) {
        val tool = if (enable) "twilio_screening_enable" else "twilio_screening_disable"
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp(tool) } }
                .onSuccess {
                    _uiState.update { it.copy(toast = if (enable) "Screening on" else "Screening off") }
                    refresh()
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun loadScreeningConfig() {
        viewModelScope.launch {
            val agents = safePhoneMcp("list_agents") { parseAgentPairs(it) } ?: emptyList()
            val ts = safePhoneMcp("twilio_status") { parseTwilioStatus(it) }
            _uiState.update {
                it.copy(
                    screeningConfig = ScreeningConfig(
                        enabled = ts?.screeningEnabled ?: false,
                        agents = agents,
                        transport = "twilio",
                    ),
                    twilioStatus = ts,
                )
            }
        }
    }

    fun setInboundAgent(extension: String, callback: (Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_register_inbound_agent", Params.of("extension" to extension))
                }
            }
                .onSuccess { callback(true) }
                .onFailure { callback(false) }
        }
    }

    fun setScreeningAgent(extension: String, callback: (Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_register_inbound_agent",
                        Params.of("screening_extension" to extension))
                }
            }
                .onSuccess { callback(true) }
                .onFailure { callback(false) }
        }
    }

    fun setScreeningTransport(transport: String, callback: (Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("set_screening_transport", Params.of("transport" to transport))
                }
            }
                .onSuccess { callback(true) }
                .onFailure { callback(false) }
        }
    }

    fun setScreeningEnabled(enabled: Boolean, callback: (Boolean?) -> Unit) {
        val tool = if (enabled) "twilio_screening_enable" else "twilio_screening_disable"
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp(tool) } }
                .onSuccess { callback(enabled) }
                .onFailure { callback(null) }
        }
    }

    fun loadSmsConfig() {
        viewModelScope.launch {
            val agents = safePhoneMcp("list_agents") { parseAgentPairs(it) } ?: emptyList()
            val ts = safePhoneMcp("twilio_status") { parseTwilioStatus(it) }
            _uiState.update {
                it.copy(
                    smsAgentConfig = SmsAgentConfig(
                        enabled = ts?.smsAgentEnabled ?: false,
                        agents = agents,
                    ),
                )
            }
        }
    }

    fun setSmsEnabled(enabled: Boolean, callback: (Boolean?) -> Unit) {
        val tool = if (enabled) "twilio_sms_enable" else "twilio_sms_disable"
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp(tool) } }
                .onSuccess { callback(enabled) }
                .onFailure { callback(null) }
        }
    }

    fun setSmsAgent(extension: String, callback: (Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_register_sms_agent", Params.of("extension" to extension))
                }
            }
                .onSuccess { callback(true) }
                .onFailure { callback(false) }
        }
    }

    fun addToAllowlist(phoneNumber: String, label: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_allowlist_add",
                        Params.of("phone_number" to phoneNumber, "label" to label.ifBlank { null }))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Added to allowlist") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun removeFromAllowlist(phoneNumber: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_allowlist_remove", Params.of("phone_number" to phoneNumber))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Removed from allowlist") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun setUserNumber(phoneNumber: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("twilio_set_user_number", Params.of("phone_number" to phoneNumber))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Number updated") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun triggerRedAlert(message: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("red_alert", Params.of("message" to message))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "RED ALERT broadcast sent!") } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    // ── Voice / Model config ─────────────────────────────────────────────────

    fun listVoices() {
        viewModelScope.launch {
            val options = safePhoneMcp("list_voices") { parseVoices(it) }
                ?: listOf(VoiceOption(null, "Default"))
            _uiState.update { it.copy(voiceOptions = options) }
        }
    }

    fun getVoiceProfile(extension: String) {
        viewModelScope.launch {
            val pair = safePhoneMcp("get_voice_profile", Params.of("extension" to extension)) { r ->
                val data = r.dataObj()
                val vid = data?.get("voiceId")?.takeIf { !it.isJsonNull }?.asString
                    ?: data?.get("voice_id")?.takeIf { !it.isJsonNull }?.asString
                val spd = data?.get("speed")?.takeIf { !it.isJsonNull }?.asDouble ?: 1.0
                vid to (if (spd.isNaN()) 1.0 else spd)
            } ?: (null to 1.0)
            _uiState.update { it.copy(agentVoiceConfigs = it.agentVoiceConfigs + (extension to pair)) }
        }
    }

    fun setVoiceProfile(extension: String, voiceId: String?, voiceName: String?,
                        callback: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val args = Params.of("extension" to extension)
                    if (voiceId != null) args.addProperty("voice_id", voiceId)
                    else args.add("voice_id", JsonNull.INSTANCE)
                    if (voiceName != null) args.addProperty("name", voiceName)
                    repo.phoneMcp("set_voice_profile", args)
                }
            }
                .onSuccess { callback(true) }
                .onFailure { callback(false) }
        }
    }

    fun setVoiceSpeed(extension: String, speed: Double) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("set_voice_speed",
                        Params.of("extension" to extension, "speed" to speed))
                }
            }
                .onSuccess {
                    _uiState.update { s ->
                        val cur = s.agentVoiceConfigs[extension]
                        s.copy(agentVoiceConfigs = s.agentVoiceConfigs + (extension to ((cur?.first) to speed)))
                    }
                }
                .onFailure { /* non-fatal */ }
        }
    }

    fun previewVoice(voiceId: String?) {
        if (voiceId == null) return
        _uiState.update { it.copy(voicePreviewStatus = "Requesting preview…") }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("preview_voice", Params.of("voice_id" to voiceId))
                }
            }
                .onSuccess { _uiState.update { it.copy(voicePreviewStatus = "Preview playing on device") } }
                .onFailure { _uiState.update { it.copy(voicePreviewStatus = "Preview unavailable") } }
        }
    }

    fun getModelConfig(extension: String) {
        viewModelScope.launch {
            val pair = safePhoneMcp("get_agent_model", Params.of("extension" to extension)) { r ->
                val data = r.dataObj() ?: r
                val m = data.get("model")?.takeIf { !it.isJsonNull }?.asString
                val rs = data.get("reasoning")?.takeIf { !it.isJsonNull }?.asString
                m to rs
            } ?: (null to null)
            _uiState.update { it.copy(agentModelConfigs = it.agentModelConfigs + (extension to pair)) }
        }
    }

    fun setModelConfig(extension: String, model: String?, reasoning: String?) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val args = Params.of("extension" to extension)
                    if (model != null) args.addProperty("model", model)
                    if (reasoning != null) args.addProperty("reasoning", reasoning)
                    repo.phoneMcp("set_agent_model", args)
                }
            }
                .onSuccess { getModelConfig(extension) }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    // ── History ──────────────────────────────────────────────────────────────

    fun loadHistory() {
        _uiState.update { it.copy(historyLoading = true) }
        viewModelScope.launch {
            val recent = safePhoneMcp("get_session_calls") { parseCallHistory(it) } ?: emptyList()
            _uiState.update {
                it.copy(
                    historyLoading = false,
                    callHistory = recent.sortedByDescending { e -> e.createdAt }.take(50)
                )
            }
        }
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    fun runDiagnostics() {
        _uiState.update { it.copy(diagnostics = PhoneDiagnostics(lastWebSocketState = "running…")) }
        viewModelScope.launch {
            var healthOk: Boolean? = null
            var authOk: Boolean? = null
            var agentsOk: Boolean? = null
            var agentCount: Int? = null
            var lastError: String? = null

            runCatching {
                withContext(Dispatchers.IO) { repo.phoneMcp("list_active_calls") }
            }
                .onSuccess { healthOk = true; authOk = true }
                .onFailure { e -> healthOk = false; lastError = e.message }

            runCatching { withContext(Dispatchers.IO) { repo.phoneMcp("list_agents") } }
                .onSuccess { r ->
                    agentsOk = true
                    val data = r.get("data")
                    agentCount = if (data != null && data.isJsonArray) data.asJsonArray.size() else 0
                }
                .onFailure { agentsOk = false }

            _uiState.update {
                it.copy(
                    diagnostics = PhoneDiagnostics(
                        healthOk = healthOk,
                        authOk = authOk,
                        agentsOk = agentsOk,
                        agentCount = agentCount,
                        lastError = lastError,
                        lastWebSocketState = if (healthOk == true) "connected via phone.mcp" else "error",
                        suggestedFix = lastError?.let { "Check Jarvis daemon connection and phone server on :8801" },
                    )
                )
            }
        }
    }

    // ── Enroll Agent ─────────────────────────────────────────────────────────

    fun enrollAgent(name: String, agentId: String?, extension: String?, command: String?) {
        _uiState.update { it.copy(enrollLoading = true, enrollError = null) }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val args = Params.of("name" to name)
                    if (!agentId.isNullOrBlank()) args.addProperty("agent_id", agentId)
                    if (!extension.isNullOrBlank()) args.addProperty("extension", extension)
                    if (!command.isNullOrBlank()) args.addProperty("command", command)
                    repo.phoneMcp("enroll_agent", args)
                }
            }
                .onSuccess { result ->
                    val pkg = parseEnrollResult(result)
                    _uiState.update { it.copy(enrollLoading = false, enrollResult = pkg) }
                    refreshAgents()
                }
                .onFailure { e ->
                    _uiState.update { it.copy(enrollLoading = false, enrollError = e.message) }
                }
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private suspend fun <T> safePhoneMcp(
        tool: String,
        arguments: JsonObject = JsonObject(),
        parser: (JsonObject) -> T,
    ): T? = runCatching {
        withContext(Dispatchers.IO) { parser(repo.phoneMcp(tool, arguments)) }
    }.getOrNull()

    private fun JsonObject.dataObj(): JsonObject? {
        val d = get("data") ?: return null
        return if (d.isJsonObject) d.asJsonObject else null
    }

    private fun parseActiveCalls(result: JsonObject): List<PhoneCall> {
        val dataEl = result.get("data") ?: return emptyList()
        val arr = if (dataEl.isJsonArray) dataEl.asJsonArray else return emptyList()
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            PhoneCall(
                id = o.get("id")?.asString ?: return@mapNotNull null,
                state = o.get("state")?.asString ?: "unknown",
                fromExtension = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString,
                toExtension = o.get("to_extension")?.takeIf { !it.isJsonNull }?.asString,
                reason = o.get("reason")?.takeIf { !it.isJsonNull }?.asString,
                urgency = o.get("urgency")?.takeIf { !it.isJsonNull }?.asString,
            )
        }
    }

    private fun parseInboxMessages(result: JsonObject): List<InboxMessage> {
        val dataEl = result.get("data") ?: return emptyList()
        val data = if (dataEl.isJsonObject) dataEl.asJsonObject else return emptyList()
        val arr = data.getAsJsonArray("messages") ?: return emptyList()
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            InboxMessage(
                id = o.get("id")?.asString ?: return@mapNotNull null,
                threadId = o.get("thread_id")?.takeIf { !it.isJsonNull }?.asString,
                title = o.get("title")?.takeIf { !it.isJsonNull }?.asString ?: "",
                message = o.get("message")?.takeIf { !it.isJsonNull }?.asString
                    ?: o.get("body")?.takeIf { !it.isJsonNull }?.asString ?: "",
                status = o.get("status")?.takeIf { !it.isJsonNull }?.asString ?: "delivered",
                priority = o.get("priority")?.takeIf { !it.isJsonNull }?.asString ?: "normal",
                fromExtension = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString,
                createdAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString,
                responseOptions = o.getAsJsonArray("response_options")
                    ?.mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString } ?: emptyList(),
            )
        }
    }

    private fun parseThreads(result: JsonObject): List<PhoneThread> {
        val dataEl = result.get("data") ?: return emptyList()
        val data = if (dataEl.isJsonObject) dataEl.asJsonObject else return emptyList()
        val threadsArr = data.getAsJsonArray("threads")
        if (threadsArr != null) {
            return threadsArr.mapNotNull { el ->
                if (!el.isJsonObject) return@mapNotNull null
                val o = el.asJsonObject
                PhoneThread(
                    id = o.get("id")?.asString ?: o.get("thread_id")?.asString ?: return@mapNotNull null,
                    subject = o.get("subject")?.takeIf { !it.isJsonNull }?.asString ?: "Untitled",
                    relatedExtension = o.get("related_extension")?.takeIf { !it.isJsonNull }?.asString
                        ?: o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString,
                    latestPreview = o.get("latest_preview")?.takeIf { !it.isJsonNull }?.asString ?: "",
                    latestMessageAt = o.get("latest_message_at")?.takeIf { !it.isJsonNull }?.asString ?: "",
                    unreadCount = o.get("unread_count")?.takeIf { !it.isJsonNull }?.asInt ?: 0,
                    highestPriority = o.get("highest_priority")?.takeIf { !it.isJsonNull }?.asString ?: "normal",
                )
            }
        }
        // Fallback: group messages by thread_id
        val msgs = data.getAsJsonArray("messages") ?: return emptyList()
        return msgs.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            val tid = o.get("thread_id")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null
            PhoneThread(
                id = tid,
                subject = o.get("title")?.takeIf { !it.isJsonNull }?.asString ?: "Message",
                relatedExtension = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString,
                latestPreview = o.get("message")?.takeIf { !it.isJsonNull }?.asString ?: "",
                latestMessageAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString ?: "",
                unreadCount = if (o.get("status")?.asString == "delivered") 1 else 0,
                highestPriority = o.get("priority")?.takeIf { !it.isJsonNull }?.asString ?: "normal",
            )
        }.distinctBy { it.id }
    }

    private fun parseThreadMessages(result: JsonObject): List<ThreadMsg> {
        val dataEl = result.get("data") ?: return emptyList()
        val data = if (dataEl.isJsonObject) dataEl.asJsonObject else return emptyList()
        val arr = data.getAsJsonArray("messages") ?: return emptyList()
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            ThreadMsg(
                id = o.get("id")?.asString ?: return@mapNotNull null,
                fromExtension = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString ?: "?",
                toExtension = o.get("to_extension")?.takeIf { !it.isJsonNull }?.asString ?: "101",
                body = o.get("body")?.takeIf { !it.isJsonNull }?.asString
                    ?: o.get("message")?.takeIf { !it.isJsonNull }?.asString ?: "",
                title = o.get("title")?.takeIf { !it.isJsonNull }?.asString ?: "",
                status = o.get("status")?.takeIf { !it.isJsonNull }?.asString ?: "delivered",
                priority = o.get("priority")?.takeIf { !it.isJsonNull }?.asString ?: "normal",
                createdAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString ?: "",
                responseOptions = o.getAsJsonArray("response_options")
                    ?.mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString } ?: emptyList(),
                responseText = o.get("response_text")?.takeIf { !it.isJsonNull }?.asString,
                selectedOption = o.get("selected_option")?.takeIf { !it.isJsonNull }?.asString,
                requiresResponse = o.get("requires_response")?.takeIf { !it.isJsonNull }?.asBoolean == true,
                threadId = o.get("thread_id")?.takeIf { !it.isJsonNull }?.asString ?: "",
            )
        }
    }

    private fun parseAgents(result: JsonObject): List<PhoneAgent> {
        val dataEl = result.get("data") ?: return emptyList()
        val arr = if (dataEl.isJsonArray) dataEl.asJsonArray else return emptyList()
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            PhoneAgent(
                name = o.get("name")?.takeIf { !it.isJsonNull }?.asString ?: "Agent",
                extension = o.get("extension")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null,
                status = o.get("status")?.takeIf { !it.isJsonNull }?.asString ?: "offline",
                task = o.get("current_task")?.takeIf { !it.isJsonNull }?.asString ?: "",
            )
        }
    }

    private fun parseAgentsFromExtensions(result: JsonObject): List<PhoneAgent> {
        val dataEl = result.get("data") ?: return emptyList()
        val arr = if (dataEl.isJsonArray) dataEl.asJsonArray else return emptyList()
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            PhoneAgent(
                name = o.get("name")?.takeIf { !it.isJsonNull }?.asString ?: "Agent",
                extension = o.get("extension")?.takeIf { !it.isJsonNull }?.asString ?: return@mapNotNull null,
                status = "online",
                task = "",
            )
        }
    }

    private fun parseAgentPairs(result: JsonObject): List<Pair<String, String>> =
        parseAgents(result).map { it.extension to it.name }

    private fun parseTwilioStatus(result: JsonObject): TwilioStatus {
        val dataEl = result.get("data")
        val data = if (dataEl != null && dataEl.isJsonObject) dataEl.asJsonObject else result
        return TwilioStatus(
            configured = data.get("configured")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
            fromNumber = data.get("from_number")?.takeIf { !it.isJsonNull }?.asString,
            screeningEnabled = data.get("screening_enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
            smsAgentEnabled = data.get("sms_agent_enabled")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
        )
    }

    private fun parseAllowlist(result: JsonObject): Pair<List<AllowlistEntry>, String> {
        val dataEl = result.get("data")
        val data = if (dataEl != null && dataEl.isJsonObject) dataEl.asJsonObject else result
        val arr = data.getAsJsonArray("numbers") ?: return emptyList<AllowlistEntry>() to ""
        val defaultNumber = data.get("default_user_number")?.takeIf { !it.isJsonNull }?.asString ?: ""
        val entries = arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            AllowlistEntry(
                phoneNumber = o.get("phone_number")?.asString ?: return@mapNotNull null,
                label = o.get("label")?.takeIf { !it.isJsonNull }?.asString,
            )
        }
        return entries to defaultNumber
    }

    private fun parseVoices(result: JsonObject): List<VoiceOption> {
        val dataEl = result.get("data")
        val data = if (dataEl != null && dataEl.isJsonObject) dataEl.asJsonObject else result
        val arr = data.getAsJsonArray("voices") ?: return listOf(VoiceOption(null, "Default"))
        return buildList {
            add(VoiceOption(null, "Default"))
            arr.forEach { el ->
                if (el.isJsonObject) {
                    val o = el.asJsonObject
                    val id = o.get("id")?.takeIf { !it.isJsonNull }?.asString
                    val name = o.get("name")?.takeIf { !it.isJsonNull }?.asString ?: id ?: "Voice"
                    add(VoiceOption(id, name))
                }
            }
        }
    }

    private fun parseCallHistory(result: JsonObject): List<CallHistoryEntry> {
        val dataEl = result.get("data") ?: return emptyList()
        val arr = when {
            dataEl.isJsonArray -> dataEl.asJsonArray
            dataEl.isJsonObject -> dataEl.asJsonObject.getAsJsonArray("calls") ?: return emptyList()
            else -> return emptyList()
        }
        return arr.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            CallHistoryEntry(
                from = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString ?: "?",
                to = o.get("to_extension")?.takeIf { !it.isJsonNull }?.asString ?: "?",
                state = o.get("state")?.takeIf { !it.isJsonNull }?.asString ?: "ended",
                reason = o.get("reason")?.takeIf { !it.isJsonNull }?.asString ?: "",
                createdAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString ?: "",
                missed = o.get("state")?.asString == "missed",
            )
        }
    }

    private fun buildTranscriptText(result: JsonObject): String {
        val dataEl = result.get("data")
        val data = if (dataEl != null && dataEl.isJsonObject) dataEl.asJsonObject else result
        val sb = StringBuilder()
        data.getAsJsonArray("transcripts")?.forEach { el ->
            if (el.isJsonObject) {
                val o = el.asJsonObject
                val speaker = o.get("from_extension")?.asString ?: "?"
                val text = o.get("text")?.takeIf { !it.isJsonNull }?.asString ?: return@forEach
                sb.append("[$speaker]: $text\n")
            }
        }
        data.getAsJsonArray("messages")?.forEach { el ->
            if (el.isJsonObject) {
                val o = el.asJsonObject
                val from = o.get("from_extension")?.asString ?: "?"
                val content = o.get("content")?.takeIf { !it.isJsonNull }?.asString ?: return@forEach
                sb.append("[$from]: $content\n")
            }
        }
        return sb.toString().trimEnd()
    }

    private fun parseEnrollResult(result: JsonObject): EnrollResult {
        val dataEl = result.get("data")
        val data = if (dataEl != null && dataEl.isJsonObject) dataEl.asJsonObject else result
        return EnrollResult(
            extension = data.get("extension")?.takeIf { !it.isJsonNull }?.asString ?: "?",
            name = data.get("name")?.takeIf { !it.isJsonNull }?.asString ?: "New Agent",
            agentId = data.get("agent_id")?.takeIf { !it.isJsonNull }?.asString
                ?: data.get("agentId")?.takeIf { !it.isJsonNull }?.asString ?: "",
            token = data.get("token")?.takeIf { !it.isJsonNull }?.asString ?: "",
            bootstrapCmd = data.get("bootstrap_cmd")?.takeIf { !it.isJsonNull }?.asString
                ?: data.get("bootstrapCmd")?.takeIf { !it.isJsonNull }?.asString ?: "",
            mcpConfigJson = data.get("mcp_config_json")?.takeIf { !it.isJsonNull }?.asString
                ?: data.get("mcpConfigJson")?.takeIf { !it.isJsonNull }?.asString ?: "{}",
            fullJson = result.toString(),
        )
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PhoneViewModel(app.repository) as T
            }
    }
}
