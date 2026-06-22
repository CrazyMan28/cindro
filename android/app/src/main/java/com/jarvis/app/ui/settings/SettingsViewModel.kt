package com.jarvis.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.data.PairingStore
import com.jarvis.app.net.DeviceClient
import com.jarvis.app.net.JarvisRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsUiState(
    val hostPort: String,
    val deviceName: String,
    val deviceFingerprint: String,
    val daemonFingerprint: String?,
    val notificationsEnabled: Boolean,
    val paired: Boolean,
)

/** Daemon host:port, device identity, notifications toggle, paired status, and unpair. */
class SettingsViewModel(
    private val app: JarvisApp,
    private val repo: JarvisRepository,
    private val pairingStore: PairingStore,
) : ViewModel() {

    private val _uiState = MutableStateFlow(snapshot())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    val connection: StateFlow<DeviceClient.State> =
        repo.connectionState.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), DeviceClient.State.DISCONNECTED,
        )

    val lastError: StateFlow<String?> =
        repo.lastError.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private fun snapshot() = SettingsUiState(
        hostPort = pairingStore.hostPort ?: PairingStore.DEFAULT_HOST_PORT,
        deviceName = pairingStore.deviceName,
        deviceFingerprint = app.identity.fingerprint,
        daemonFingerprint = pairingStore.daemonFingerprint,
        notificationsEnabled = pairingStore.notificationsEnabled,
        paired = pairingStore.isPaired,
    )

    fun setNotificationsEnabled(enabled: Boolean) {
        pairingStore.notificationsEnabled = enabled
        _uiState.update { it.copy(notificationsEnabled = enabled) }
    }

    fun setDeviceName(name: String) {
        pairingStore.deviceName = name
        _uiState.update { it.copy(deviceName = name) }
    }

    fun reconnect() = repo.connect()

    /** Forget the daemon; drops the socket and returns the user to the pairing screen. */
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
                    SettingsViewModel(app, app.repository, app.pairingStore) as T
            }
    }
}
