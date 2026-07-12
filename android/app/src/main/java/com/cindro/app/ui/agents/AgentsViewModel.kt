package com.cindro.app.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.Agent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class AgentsUiState(
    val agents: List<Agent> = emptyList(),
    val loading: Boolean = false,
    val toast: String? = null,
    val error: String? = null,
    // The session id of the most recent dispatch (so the screen can open Chat).
    val dispatchedSession: String? = null,
)

/** agents.list/get/create/remove + agents.dispatch from the phone. */
class AgentsViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AgentsUiState())
    val uiState: StateFlow<AgentsUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listAgents() } }
                .onSuccess { list -> _uiState.update { it.copy(agents = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun create(
        name: String,
        description: String,
        whenToUse: String,
        systemPrompt: String,
        brain: String,
        model: String,
        profile: String,
        onDone: () -> Unit,
    ) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.createAgent(name, description, whenToUse, systemPrompt, brain, model, profile)
                }
            }
                .onSuccess { refresh(); onDone() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun dispatch(name: String, task: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.dispatchAgent(name, task) } }
                .onSuccess { sid ->
                    _uiState.update { it.copy(toast = "Dispatched $name", dispatchedSession = sid) }
                }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun remove(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.removeAgent(name) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun clearToast() = _uiState.update { it.copy(toast = null) }
    fun clearDispatched() = _uiState.update { it.copy(dispatchedSession = null) }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    AgentsViewModel(app.repository) as T
            }
    }
}
