package com.jarvis.app.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.crypto.DeviceIdentity
import com.jarvis.app.data.HostPort
import com.jarvis.app.data.PairingStore
import com.jarvis.app.fcm.PushRegistrar
import com.jarvis.app.net.PairingClient
import com.jarvis.app.protocol.PairPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class PairStatus { IDLE, CONNECTING, PAIRED, ERROR }

data class PairUiState(
    val hostPort: String,
    val code: String = "",
    val deviceName: String,
    val status: PairStatus = PairStatus.IDLE,
    val message: String? = null,
) {
    val canConnect: Boolean
        get() = status != PairStatus.CONNECTING &&
            HostPort.parse(hostPort) != null &&
            code.trim().length >= 4
}

/**
 * Drives the pairing screen: validates host:port + 6-digit code, runs the one-shot
 * Contract C pairing handshake ([PairingClient]) — hello + device_pubkey + pair_code —
 * and on success persists the pairing, opens the long-lived device socket, and syncs the
 * FCM token. QR scans are decoded into the same fields via [PairPayload].
 */
class PairingViewModel(
    private val app: JarvisApp,
    private val identity: DeviceIdentity,
    private val pairingStore: PairingStore,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        PairUiState(
            hostPort = pairingStore.hostPort ?: PairingStore.DEFAULT_HOST_PORT,
            deviceName = pairingStore.deviceName,
        ),
    )
    val uiState: StateFlow<PairUiState> = _uiState.asStateFlow()

    /** Fires once when pairing completes so the UI can navigate into the app shell. */
    private val _paired = MutableStateFlow(false)
    val paired: StateFlow<Boolean> = _paired.asStateFlow()

    fun onHostPortChanged(value: String) =
        _uiState.update { it.copy(hostPort = value, status = PairStatus.IDLE, message = null) }

    fun onCodeChanged(value: String) =
        _uiState.update {
            it.copy(code = value.filter(Char::isDigit).take(8), status = PairStatus.IDLE, message = null)
        }

    fun onDeviceNameChanged(value: String) {
        pairingStore.deviceName = value
        _uiState.update { it.copy(deviceName = value) }
    }

    /** Decode a scanned `jarvis://pair?...` payload into the form fields. */
    fun onQrScanned(raw: String) {
        val payload = PairPayload.parse(raw)
        if (payload == null) {
            _uiState.update {
                it.copy(status = PairStatus.ERROR, message = "That QR code isn't a Jarvis pairing code.")
            }
            return
        }
        pairingStore.daemonFingerprint = payload.fingerprint
        _uiState.update {
            it.copy(hostPort = payload.hostPort, code = payload.code, status = PairStatus.IDLE, message = null)
        }
        connect()
    }

    fun connect() {
        val state = _uiState.value
        val endpoint = HostPort.parse(state.hostPort)
        if (endpoint == null) {
            _uiState.update {
                it.copy(status = PairStatus.ERROR, message = "Enter a valid host:port, e.g. 100.114.201.41:8796")
            }
            return
        }
        val code = state.code.trim()
        if (code.length < 4) {
            _uiState.update {
                it.copy(status = PairStatus.ERROR, message = "Enter the 6-digit code shown in the desktop Settings.")
            }
            return
        }

        pairingStore.hostPort = endpoint.toString()
        _uiState.update { it.copy(status = PairStatus.CONNECTING, message = "Pairing with ${endpoint}…") }

        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                PairingClient(identity).pair(endpoint.wsUrl(), code, state.deviceName)
            }
            when (result) {
                is PairingClient.Result.Paired -> {
                    pairingStore.isPaired = true
                    app.repository.connect()
                    PushRegistrar.syncCurrentToken(app)
                    _uiState.update {
                        it.copy(status = PairStatus.PAIRED, message = "Paired. Opening your sessions…")
                    }
                    _paired.value = true
                }
                is PairingClient.Result.Failed -> _uiState.update {
                    it.copy(status = PairStatus.ERROR, message = result.reason)
                }
            }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PairingViewModel(app, app.identity, app.pairingStore) as T
            }
    }
}
