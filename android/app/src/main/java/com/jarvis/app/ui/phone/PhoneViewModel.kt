package com.jarvis.app.ui.phone

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
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

// ─── UI models ──────────────────────────────────────────────────────────────

data class PhoneCall(
    val id: String,
    val state: String,
    val fromExtension: String?,
    val toExtension: String?,
    val reason: String?,
    val urgency: String?,
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

enum class PhoneTab { CALLS, INBOX, SETTINGS }

data class PhoneUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
    val tab: PhoneTab = PhoneTab.CALLS,
    val activeCalls: List<PhoneCall> = emptyList(),
    val inboxMessages: List<InboxMessage> = emptyList(),
    val twilioStatus: TwilioStatus? = null,
    val allowlist: List<AllowlistEntry> = emptyList(),
    val defaultUserNumber: String = "",
    val incomingCall: PhoneCall? = null,
    val callTranscript: String = "",
)

// ─── ViewModel ──────────────────────────────────────────────────────────────

class PhoneViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(PhoneUiState())
    val uiState: StateFlow<PhoneUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val calls = runCatching {
                withContext(Dispatchers.IO) { parseActiveCalls(repo.phoneMcp("list_active_calls")) }
            }.getOrElse { emptyList() }

            val inbox = runCatching {
                withContext(Dispatchers.IO) { parseInboxMessages(repo.phoneMcp("list_inbox")) }
            }.getOrElse { emptyList() }

            val twilioStatus = runCatching {
                withContext(Dispatchers.IO) { parseTwilioStatus(repo.phoneMcp("twilio_status")) }
            }.getOrNull()

            val (allowlist, defaultNumber) = runCatching {
                withContext(Dispatchers.IO) { parseAllowlist(repo.phoneMcp("twilio_allowlist_list")) }
            }.getOrElse { emptyList<AllowlistEntry>() to "" }

            val terminalStates = setOf("ended", "failed", "missed", "rejected", "timeout")
            val ringing = calls.firstOrNull { it.state == "ringing" }

            _uiState.update {
                it.copy(
                    loading = false,
                    activeCalls = calls.filter { c -> c.state !in terminalStates },
                    inboxMessages = inbox,
                    twilioStatus = twilioStatus,
                    allowlist = allowlist,
                    defaultUserNumber = defaultNumber,
                    incomingCall = ringing,
                )
            }
        }
    }

    // ─── Navigation ─────────────────────────────────────────────────────────

    fun setTab(tab: PhoneTab) = _uiState.update { it.copy(tab = tab) }
    fun clearToast() = _uiState.update { it.copy(toast = null) }
    fun clearError() = _uiState.update { it.copy(error = null) }
    fun dismissIncomingCall() = _uiState.update { it.copy(incomingCall = null) }

    // ─── Calls ──────────────────────────────────────────────────────────────

    /**
     * Place a call. If [extension] looks like a real phone number (+/10+ digits)
     * uses twilio_call_and_wait; otherwise uses call_user_and_wait to reach
     * an internal extension.
     */
    fun placeCall(extension: String, reason: String, say: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val isPstn = extension.startsWith("+") ||
                        (extension.all { it.isDigit() } && extension.length >= 10)
                    if (isPstn) {
                        repo.phoneMcp(
                            "twilio_call_and_wait",
                            Params.of("to_number" to extension, "reason" to reason, "say" to say),
                        )
                    } else {
                        repo.phoneMcp(
                            "call_user_and_wait",
                            Params.of(
                                "from_extension" to "100",
                                "to_extension" to extension,
                                "reason" to reason,
                                "say" to say,
                            ),
                        )
                    }
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Call placed") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
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
        // Acceptance routes through the WS call_accept event; we dismiss the
        // incoming-call UI and let the user's system handle audio.
        _uiState.update { it.copy(incomingCall = null) }
    }

    fun declineCall(callId: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("end_call", Params.of("call_id" to callId, "reason" to "rejected"))
                }
            }
                .onSuccess { _uiState.update { it.copy(incomingCall = null) }; refresh() }
                .onFailure { _uiState.update { it.copy(incomingCall = null) } }
        }
    }

    fun loadCallTranscript(callId: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    buildTranscriptText(repo.phoneMcp("get_call_transcript", Params.of("call_id" to callId)))
                }
            }
                .onSuccess { text -> _uiState.update { it.copy(callTranscript = text) } }
                .onFailure { /* non-fatal */ }
        }
    }

    // ─── Inbox ──────────────────────────────────────────────────────────────

    fun sendText(title: String, message: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp("notify_user", Params.of("title" to title, "message" to message))
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Message sent") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    // ─── Settings ───────────────────────────────────────────────────────────

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

    fun addToAllowlist(phoneNumber: String, label: String) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.phoneMcp(
                        "twilio_allowlist_add",
                        Params.of("phone_number" to phoneNumber, "label" to label.ifBlank { null }),
                    )
                }
            }
                .onSuccess { _uiState.update { it.copy(toast = "Added to allowlist") }; refresh() }
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

    // ─── JSON parsing ────────────────────────────────────────────────────────

    private fun parseActiveCalls(result: JsonObject): List<PhoneCall> {
        val dataEl = result.get("data") ?: return emptyList()
        if (dataEl.isJsonNull || !dataEl.isJsonArray) return emptyList()
        return dataEl.asJsonArray.mapNotNull { el ->
            if (!el.isJsonObject) return@mapNotNull null
            val o = el.asJsonObject
            PhoneCall(
                id = o.get("id")?.asString ?: return@mapNotNull null,
                state = o.get("state")?.asString ?: "unknown",
                fromExtension = o.get("from_extension")?.asString,
                toExtension = o.get("to_extension")?.asString,
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
            val opts = o.getAsJsonArray("response_options")
                ?.mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }
                ?: emptyList()
            InboxMessage(
                id = o.get("id")?.asString ?: return@mapNotNull null,
                threadId = o.get("thread_id")?.takeIf { !it.isJsonNull }?.asString,
                title = o.get("title")?.takeIf { !it.isJsonNull }?.asString ?: "",
                message = o.get("message")?.takeIf { !it.isJsonNull }?.asString ?: "",
                status = o.get("status")?.takeIf { !it.isJsonNull }?.asString ?: "delivered",
                priority = o.get("priority")?.takeIf { !it.isJsonNull }?.asString ?: "normal",
                fromExtension = o.get("from_extension")?.takeIf { !it.isJsonNull }?.asString,
                createdAt = o.get("created_at")?.takeIf { !it.isJsonNull }?.asString,
                responseOptions = opts,
            )
        }
    }

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

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PhoneViewModel(app.repository) as T
            }
    }
}
