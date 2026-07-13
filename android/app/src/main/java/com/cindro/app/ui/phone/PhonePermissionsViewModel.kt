package com.cindro.app.ui.phone

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One phone capability from phone.policy.list. `enforcement` drives the UI's
 * honest ENFORCED (hard/config) vs GUIDANCE (soft — the vendored inbound agent
 * has no daemon choke point) badge. */
data class PhoneCapability(
    val id: String,
    val label: String,
    val value: String,
    val enforcement: String,
    val note: String,
    val choices: List<String>,
    val choiceLabels: Map<String, String>,
) {
    val enforced: Boolean get() = enforcement == "hard" || enforcement == "config"
    fun labelFor(v: String): String = choiceLabels[v] ?: v
}

data class PhonePermissionsUiState(
    val capabilities: List<PhoneCapability> = emptyList(),
    val loading: Boolean = false,
    val status: String? = null,
    val error: String? = null,
)

/** Cindro-native "Phone → Permissions" for Android, over the device-exposed
 * Contract A phone.policy.* methods. The vendored agent-phone app is a separate
 * activity; this screen manages what Cindro is allowed to do over the phone.
 * (Twilio verified-caller-id + call-voice clones stay on desktop/web/CLI — the
 * verify RPC is control/loopback-only, off the phone channel, for secret safety.) */
class PhonePermissionsViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(PhonePermissionsUiState())
    val uiState: StateFlow<PhonePermissionsUiState> = _uiState.asStateFlow()

    init { refresh() }

    private fun parse(obj: JsonObject): List<PhoneCapability> {
        val out = mutableListOf<PhoneCapability>()
        val arr = obj.getAsJsonArray("capabilities") ?: return out
        for (el in arr) {
            val o = el.asJsonObject
            val choices = o.getAsJsonArray("choices")?.map { it.asString } ?: emptyList()
            val labels = mutableMapOf<String, String>()
            o.getAsJsonArray("choiceLabels")?.forEach {
                val lo = it.asJsonObject
                val v = lo.get("value")?.asString
                val l = lo.get("label")?.asString
                if (v != null && l != null) labels[v] = l
            }
            out.add(
                PhoneCapability(
                    id = o.get("id")?.asString ?: "",
                    label = o.get("label")?.asString ?: "",
                    value = o.get("value")?.asString ?: "",
                    enforcement = o.get("enforcement")?.asString ?: "soft",
                    note = o.get("note")?.asString ?: "",
                    choices = choices,
                    choiceLabels = labels,
                ),
            )
        }
        return out
    }

    // parse() runs INSIDE runCatching so a JSON-shape surprise (JsonNull, a
    // non-array "capabilities", a missing field) surfaces as a graceful error
    // state instead of an uncaught throw in viewModelScope that crashes the app
    // and leaves loading=true stuck.
    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { parse(withContext(Dispatchers.IO) { repo.phonePolicyList() }) }
                .onSuccess { caps -> _uiState.update { it.copy(capabilities = caps, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message, loading = false) } }
        }
    }

    fun setValue(id: String, value: String) {
        _uiState.update { it.copy(status = "Saving…", error = null) }
        viewModelScope.launch {
            runCatching { parse(withContext(Dispatchers.IO) { repo.phonePolicySet(id, value) }) }
                .onSuccess { caps -> _uiState.update { it.copy(capabilities = caps, status = null) } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message, status = null) } }
        }
    }

    fun resetAll() {
        _uiState.update { it.copy(status = "Resetting…", error = null) }
        viewModelScope.launch {
            runCatching { parse(withContext(Dispatchers.IO) { repo.phonePolicyReset() }) }
                .onSuccess { caps -> _uiState.update { it.copy(capabilities = caps, status = null) } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message, status = null) } }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PhonePermissionsViewModel(app.repository) as T
            }
    }
}
