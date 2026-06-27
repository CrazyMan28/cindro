package com.jarvis.app.ui.settings

import com.google.gson.JsonObject
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.data.AppPrefs
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.VoiceSettings
import com.jarvis.app.net.DeviceClient
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.ModelInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SettingsUiState(
    val hostPort: String,
    val deviceName: String,
    val deviceFingerprint: String,
    val daemonFingerprint: String?,
    val notificationsEnabled: Boolean,
    val paired: Boolean,
    // Daemon parity (settings.get)
    val defaultBrain: String = "codex",
    val defaultModel: String? = null,
    val claudeAccount: String = "pro", // "pro" (default) | "max"
    val apiKeysSet: Map<String, Boolean> = emptyMap(),
    // brain -> can drive the computer-use desktop headless (no silent swap)
    val canDrive: Map<String, Boolean> = emptyMap(),
    val models: List<ModelInfo> = emptyList(),
    val modelsBrain: String = "codex",
    // "Let Jarvis use a computer/browser" (daemon pref; default ON). When on,
    // every chat can drive a computer/Chrome on demand with no manual co-work.
    val letJarvisUseComputer: Boolean = true,
    val permissionLevel: String = "medium", // ask-before-risky: high|medium|low
    val loadingDaemon: Boolean = false,
    val daemonError: String? = null,
    // Voice
    val wakeEnabled: Boolean = false,
    val readBackEnabled: Boolean = true,
    val ttsVoice: String = "",
    // Haptics
    val hapticsEnabled: Boolean = true,
    // 2FA + fingerprint cross-device unlock: gate the app itself on launch.
    val fingerprintGateEnabled: Boolean = true,
)

/** Full settings parity: connection, identity, API keys, default brain/model, voice. */
class SettingsViewModel(
    private val app: JarvisApp,
    private val repo: JarvisRepository,
    private val pairingStore: PairingStore,
    private val voiceSettings: VoiceSettings,
    private val appPrefs: AppPrefs,
) : ViewModel() {

    private val _uiState = MutableStateFlow(snapshot())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    val connection: StateFlow<DeviceClient.State> =
        repo.connectionState.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), DeviceClient.State.DISCONNECTED,
        )

    val lastError: StateFlow<String?> =
        repo.lastError.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    init {
        loadDaemonSettings()
    }

    private fun snapshot() = SettingsUiState(
        hostPort = pairingStore.hostPort ?: PairingStore.DEFAULT_HOST_PORT,
        deviceName = pairingStore.deviceName,
        deviceFingerprint = app.identity.fingerprint,
        daemonFingerprint = pairingStore.daemonFingerprint,
        notificationsEnabled = pairingStore.notificationsEnabled,
        paired = pairingStore.isPaired,
        wakeEnabled = voiceSettings.wakeEnabled,
        readBackEnabled = voiceSettings.readBackEnabled,
        ttsVoice = voiceSettings.ttsVoice,
        hapticsEnabled = appPrefs.hapticsEnabled,
        fingerprintGateEnabled = appPrefs.fingerprintGateEnabled,
    )

    // --- daemon settings parity -------------------------------------------

    fun loadDaemonSettings() {
        _uiState.update { it.copy(loadingDaemon = true, daemonError = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.getSettings() } }
                .onSuccess { s ->
                    val brain = s.get("default_brain")?.takeIf { !it.isJsonNull }?.asString ?: "codex"
                    val model = s.get("default_model")?.takeIf { !it.isJsonNull }?.asString
                    val account =
                        if (s.get("claude_account")?.takeIf { !it.isJsonNull }?.asString == "max") "max" else "pro"
                    val keys = mutableMapOf<String, Boolean>()
                    s.getAsJsonObject("api_keys_set")?.entrySet()?.forEach { (k, v) ->
                        keys[k] = v.asBoolean
                    }
                    val drive = mutableMapOf<String, Boolean>()
                    s.getAsJsonObject("can_drive")?.entrySet()?.forEach { (k, v) ->
                        drive[k] = v.asBoolean
                    }
                    val letCompute = s.get("let_jarvis_use_computer")
                        ?.takeIf { !it.isJsonNull }?.asBoolean ?: true
                    val permLevel = s.get("permission_level")
                        ?.takeIf { !it.isJsonNull }?.asString
                        ?.let { if (it == "high" || it == "low") it else "medium" } ?: "medium"
                    _uiState.update {
                        it.copy(
                            defaultBrain = brain,
                            defaultModel = model,
                            claudeAccount = account,
                            apiKeysSet = keys,
                            canDrive = drive,
                            letJarvisUseComputer = letCompute,
                            permissionLevel = permLevel,
                            loadingDaemon = false,
                            modelsBrain = brain,
                        )
                    }
                    loadModels(brain)
                }
                .onFailure { e -> _uiState.update { it.copy(loadingDaemon = false, daemonError = e.message) } }
        }
    }

    fun loadModels(brain: String) {
        _uiState.update { it.copy(modelsBrain = brain) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listModels(brain) } }
                .onSuccess { list -> _uiState.update { it.copy(models = list) } }
                .onFailure { e -> _uiState.update { it.copy(daemonError = e.message) } }
        }
    }

    /** Default brain -> settings.set (biometric; caller MUST clear the prompt). */
    fun setDefaultBrain(brain: String) {
        patch(JsonObject().apply { addProperty("default_brain", brain) }) {
            _uiState.update { it.copy(defaultBrain = brain) }
            loadModels(brain)
        }
    }

    fun setDefaultModel(model: String) {
        patch(JsonObject().apply { addProperty("default_model", model) }) {
            _uiState.update { it.copy(defaultModel = model) }
        }
    }

    /** Claude account picker: "pro" (default) | "max". Biometric-gated patch. */
    fun setClaudeAccount(account: String) {
        val normalized = if (account == "max") "max" else "pro"
        patch(JsonObject().apply { addProperty("claude_account", normalized) }) {
            _uiState.update { it.copy(claudeAccount = normalized) }
        }
    }

    /** "Let Jarvis use a computer/browser" daemon pref. Biometric-gated patch. */
    fun setLetJarvisUseComputer(enabled: Boolean) {
        patch(JsonObject().apply { addProperty("let_jarvis_use_computer", enabled) }) {
            _uiState.update { it.copy(letJarvisUseComputer = enabled) }
        }
    }

    /** Permission level: "high" | "medium" | "low". Biometric-gated patch. */
    fun setPermissionLevel(level: String) {
        val normalized = if (level == "high" || level == "low") level else "medium"
        patch(JsonObject().apply { addProperty("permission_level", normalized) }) {
            _uiState.update { it.copy(permissionLevel = normalized) }
        }
    }

    /** Set an API key (incl. "mistral"). Biometric — caller MUST clear the prompt. */
    fun setApiKey(provider: String, key: String) {
        val keysObj = JsonObject().apply { addProperty(provider, key) }
        patch(JsonObject().apply { add("api_keys", keysObj) }) {
            _uiState.update { it.copy(apiKeysSet = it.apiKeysSet + (provider to key.isNotBlank())) }
        }
    }

    private fun patch(patch: JsonObject, onOk: () -> Unit) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.setSettings(patch) } }
                .onSuccess { onOk() }
                .onFailure { e -> _uiState.update { it.copy(daemonError = e.message) } }
        }
    }

    // --- local prefs -------------------------------------------------------

    fun setNotificationsEnabled(enabled: Boolean) {
        pairingStore.notificationsEnabled = enabled
        _uiState.update { it.copy(notificationsEnabled = enabled) }
    }

    fun setDeviceName(name: String) {
        pairingStore.deviceName = name
        _uiState.update { it.copy(deviceName = name) }
    }

    fun setWakeEnabled(enabled: Boolean) {
        voiceSettings.wakeEnabled = enabled
        _uiState.update { it.copy(wakeEnabled = enabled) }
    }

    fun setReadBack(enabled: Boolean) {
        voiceSettings.readBackEnabled = enabled
        _uiState.update { it.copy(readBackEnabled = enabled) }
    }

    fun setTtsVoice(voice: String) {
        voiceSettings.ttsVoice = voice
        _uiState.update { it.copy(ttsVoice = voice) }
    }

    fun setHapticsEnabled(enabled: Boolean) {
        appPrefs.hapticsEnabled = enabled
        _uiState.update { it.copy(hapticsEnabled = enabled) }
    }

    fun setFingerprintGateEnabled(enabled: Boolean) {
        appPrefs.fingerprintGateEnabled = enabled
        _uiState.update { it.copy(fingerprintGateEnabled = enabled) }
    }

    fun reconnect() = repo.connect()

    fun unpair(onDone: () -> Unit) {
        viewModelScope.launch {
            repo.disconnect()
            pairingStore.clearPairing()
            _uiState.update { it.copy(paired = false) }
            onDone()
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SettingsViewModel(app, app.repository, app.pairingStore, app.voiceSettings, app.appPrefs) as T
            }
    }
}
