package com.jarvis.app.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.jarvis.app.JarvisApp
import com.jarvis.app.data.HostPort
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.SecretStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Connection lifecycle for the pairing screen. The actual Contract C WebSocket handshake
 * (P-256 device-signed, QR-delivered token) lands in Wave 3 — for now Connect/Scan validate
 * input and surface a clear "not wired yet" status without faking success.
 */
enum class PairStatus { IDLE, CONNECTING, CONNECTED, ERROR }

data class PairUiState(
    val hostPort: String,
    val status: PairStatus = PairStatus.IDLE,
    val message: String? = null,
) {
    val canConnect: Boolean
        get() = status != PairStatus.CONNECTING && HostPort.parse(hostPort) != null
}

class PairingViewModel(
    private val pairingStore: PairingStore,
    @Suppress("unused") private val secretStore: SecretStore,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        PairUiState(hostPort = pairingStore.hostPort ?: PairingStore.DEFAULT_HOST_PORT)
    )
    val uiState: StateFlow<PairUiState> = _uiState.asStateFlow()

    fun onHostPortChanged(value: String) {
        _uiState.update { it.copy(hostPort = value, status = PairStatus.IDLE, message = null) }
    }

    /** Persist the address and (eventually) open the device WebSocket. */
    fun connect() {
        val raw = _uiState.value.hostPort
        val endpoint = HostPort.parse(raw)
        if (endpoint == null) {
            _uiState.update {
                it.copy(status = PairStatus.ERROR, message = "Enter a valid host:port, e.g. 192.168.0.47:8796")
            }
            return
        }

        pairingStore.hostPort = endpoint.toString()
        _uiState.update { it.copy(status = PairStatus.CONNECTING, message = "Reaching ${endpoint}…") }

        // TODO(Wave 3): open endpoint.wsUrl(), run the P-256 handshake, stash the bearer
        // token in secretStore under SecretStore.KEY_DEVICE_TOKEN, then mark paired.
        _uiState.update {
            it.copy(
                status = PairStatus.IDLE,
                message = "Saved ${endpoint}. Device link lands in the next build.",
            )
        }
    }

    /** Launch the QR scanner to read a pairing payload. */
    fun scanQr() {
        // TODO(Wave 3): launch CameraX/ML-Kit scanner; decode host:port + one-time token.
        _uiState.update {
            it.copy(message = "QR scanning ships with device pairing (next build).")
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PairingViewModel(app.pairingStore, app.secretStore) as T
            }
    }
}
