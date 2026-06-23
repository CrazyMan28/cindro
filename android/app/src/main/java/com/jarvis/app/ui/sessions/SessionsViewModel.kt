package com.jarvis.app.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
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

data class SessionsUiState(
    val sessions: List<Session> = emptyList(),
    val loading: Boolean = false,
    val creating: Boolean = false,
    val error: String? = null,
    /** Multi-select mode: long-press a row to enter; holds the selected session ids. */
    val selecting: Boolean = false,
    val selected: Set<String> = emptySet(),
    val deleting: Boolean = false,
)

/** Lists sessions and creates new ones. Auto-refreshes on (re)connect. */
class SessionsViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(SessionsUiState())
    val uiState: StateFlow<SessionsUiState> = _uiState.asStateFlow()

    val connection: StateFlow<DeviceClient.State> =
        repo.connectionState.stateIn(
            viewModelScope, SharingStarted.WhileSubscribed(5_000), DeviceClient.State.DISCONNECTED,
        )

    init {
        viewModelScope.launch {
            repo.connectionState.collect { state ->
                if (state == DeviceClient.State.CONNECTED) refresh()
            }
        }
        refresh()
    }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSessions() } }
                .onSuccess { list -> _uiState.update { it.copy(sessions = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun createSession(
        profile: String,
        brain: String,
        onCreated: (String) -> Unit,
    ) {
        _uiState.update { it.copy(creating = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.createSession(profile, brain) } }
                .onSuccess { id ->
                    _uiState.update { it.copy(creating = false) }
                    refresh()
                    onCreated(id)
                }
                .onFailure { e -> _uiState.update { it.copy(creating = false, error = e.message) } }
        }
    }

    fun reconnect() = repo.connect()

    // --- multi-select + delete --------------------------------------------

    /** Enter selection mode with [id] pre-selected (called from a long-press). */
    fun startSelection(id: String) =
        _uiState.update { it.copy(selecting = true, selected = setOf(id)) }

    /** Toggle a row's membership in the selection; exits selection if it empties. */
    fun toggleSelection(id: String) = _uiState.update { st ->
        val next = if (id in st.selected) st.selected - id else st.selected + id
        st.copy(selecting = next.isNotEmpty(), selected = next)
    }

    fun clearSelection() = _uiState.update { it.copy(selecting = false, selected = emptySet()) }

    /** Delete the currently-selected sessions on the daemon, then drop them locally. */
    fun deleteSelected() {
        val ids = _uiState.value.selected
        if (ids.isEmpty()) return
        _uiState.update { it.copy(deleting = true, error = null) }
        viewModelScope.launch {
            val failed = mutableListOf<String>()
            withContext(Dispatchers.IO) {
                ids.forEach { id ->
                    runCatching { repo.deleteSession(id) }.onFailure { failed += id }
                }
            }
            _uiState.update { st ->
                st.copy(
                    sessions = st.sessions.filterNot { it.id in ids && it.id !in failed },
                    selecting = false,
                    selected = emptySet(),
                    deleting = false,
                    error = if (failed.isEmpty()) null
                            else "Failed to delete ${failed.size} session(s)",
                )
            }
            refresh()
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SessionsViewModel(app.repository) as T
            }
    }
}
