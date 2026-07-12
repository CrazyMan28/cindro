package com.cindro.app.ui.home

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.DeviceClient
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.Session
import com.cindro.app.ui.canvas.CanvasItem
import com.cindro.app.widget.WidgetCatalog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HomeUiState(
    val sessions: List<Session> = emptyList(),
    val latestCanvas: CanvasItem? = null,
    val creating: Boolean = false,
)

/** Backs the Home dashboard: recent sessions + the most recent live canvas + connection. */
class HomeViewModel(
    private val repo: JarvisRepository,
    appContext: Context,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        HomeUiState(
            latestCanvas = WidgetCatalog.list(appContext).firstOrNull()
                ?.let { CanvasItem(it.id, it.title, it.specJson) },
        ),
    )
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    val connection: StateFlow<DeviceClient.State> =
        repo.connectionState.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), DeviceClient.State.DISCONNECTED,
        )

    init {
        viewModelScope.launch {
            repo.connectionState.collect { if (it == DeviceClient.State.CONNECTED) refresh() }
        }
        viewModelScope.launch {
            repo.widgetEvents.collect { w ->
                if (w.op == "render" && w.spec != null) {
                    _uiState.update {
                        it.copy(latestCanvas = CanvasItem(w.id, w.title, w.spec.toString()))
                    }
                }
            }
        }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSessions() } }
                .onSuccess { list -> _uiState.update { it.copy(sessions = list) } }
        }
    }

    fun createSession(profile: String = "coworker", brain: String = "codex", onCreated: (String) -> Unit) {
        _uiState.update { it.copy(creating = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.createSession(profile, brain, null) } }
                .onSuccess { id -> _uiState.update { it.copy(creating = false) }; refresh(); onCreated(id) }
                .onFailure { _uiState.update { it.copy(creating = false) } }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    HomeViewModel(app.repository, app.applicationContext) as T
            }
    }
}
