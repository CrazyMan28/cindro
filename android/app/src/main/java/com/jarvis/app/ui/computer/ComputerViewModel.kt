package com.jarvis.app.ui.computer

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.google.gson.JsonObject
import com.jarvis.app.JarvisApp
import com.jarvis.app.net.DeviceClient
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ComputerUiState(
    val sessions: List<Session> = emptyList(),
    val selected: String? = null,
    val mirroring: Boolean = false,
    val frame: Bitmap? = null,
    val sourceWidth: Int = 0,
    val sourceHeight: Int = 0,
    val status: String? = null,
    val error: String? = null,
)

/**
 * Owns the live-video mirror for the COMPUTER page: lists mirrorable sessions, calls
 * `mirror.start` (biometric), decodes incoming binary `mirror.frame` JPEGs to bitmaps,
 * forwards remote tap/scroll as `input.event`, and requests real-screen take-over.
 */
class ComputerViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(ComputerUiState())
    val uiState: StateFlow<ComputerUiState> = _uiState.asStateFlow()

    val connection: StateFlow<DeviceClient.State> =
        repo.connectionState.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), DeviceClient.State.DISCONNECTED,
        )

    init {
        refresh()
        // Decode binary mirror frames for the selected session into bitmaps.
        viewModelScope.launch {
            repo.frames.collect { frame ->
                if (frame.sessionId == _uiState.value.selected) {
                    val bmp = withContext(Dispatchers.Default) {
                        runCatching { BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size) }.getOrNull()
                    }
                    if (bmp != null) {
                        _uiState.update {
                            it.copy(
                                frame = bmp,
                                sourceWidth = bmp.width,
                                sourceHeight = bmp.height,
                            )
                        }
                    }
                }
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSessions() } }
                .onSuccess { list ->
                    _uiState.update {
                        // Auto-select the most-recent session so "Start" is one tap
                        // away — most chats now have a nested agent desktop to mirror.
                        val sel = it.selected ?: list.firstOrNull()?.id
                        it.copy(sessions = list, selected = sel, error = null)
                    }
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun select(sessionId: String) {
        if (_uiState.value.selected == sessionId) return
        stopMirror()
        _uiState.update { it.copy(selected = sessionId, frame = null) }
    }

    /** Caller MUST have cleared the BiometricPrompt (mirror.start is biometric tier). */
    fun startMirror() {
        val sid = _uiState.value.selected ?: return
        _uiState.update { it.copy(status = "Connecting…", error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.mirrorStart(sid) } }
                .onSuccess { (w, h) ->
                    _uiState.update {
                        it.copy(mirroring = true, status = "Live", sourceWidth = w, sourceHeight = h)
                    }
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message, status = null) } }
        }
    }

    fun stopMirror() {
        val sid = _uiState.value.selected
        if (sid != null && _uiState.value.mirroring) {
            viewModelScope.launch { repo.mirrorStop(sid) }
        }
        _uiState.update { it.copy(mirroring = false, status = null) }
    }

    /** Remote tap at source-normalized coords (0..1) -> input.event into the desktop. */
    fun remoteTap(nx: Float, ny: Float) {
        val sid = _uiState.value.selected ?: return
        val w = _uiState.value.sourceWidth
        val h = _uiState.value.sourceHeight
        if (w <= 0 || h <= 0) return
        val params = JsonObject().apply {
            addProperty("x", (nx * w).toInt())
            addProperty("y", (ny * h).toInt())
            addProperty("button", "left")
        }
        viewModelScope.launch { runCatching { repo.remoteInput(sid, "click", params) } }
    }

    fun remoteScroll(nx: Float, ny: Float, dy: Float) {
        val sid = _uiState.value.selected ?: return
        val w = _uiState.value.sourceWidth
        val h = _uiState.value.sourceHeight
        if (w <= 0 || h <= 0) return
        val params = JsonObject().apply {
            addProperty("x", (nx * w).toInt())
            addProperty("y", (ny * h).toInt())
            addProperty("dy", dy.toInt())
        }
        viewModelScope.launch { runCatching { repo.remoteInput(sid, "scroll", params) } }
    }

    /** Take over the laptop's REAL screen. Caller MUST clear the BiometricPrompt. */
    fun takeOver(onResult: (Boolean, String?) -> Unit) {
        val sid = _uiState.value.selected
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.takeOver(sid) } }
                .onSuccess { onResult(true, null) }
                .onFailure { e -> onResult(false, e.message) }
        }
    }

    override fun onCleared() {
        stopMirror()
        super.onCleared()
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ComputerViewModel(app.repository) as T
            }
    }
}
