package com.jarvis.app.ui.memory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.MemoryEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class MemoryUiState(
    val entries: List<MemoryEntry> = emptyList(),
    val query: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

/** memory.list/search/add/remove from the phone. */
class MemoryViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(MemoryUiState())
    val uiState: StateFlow<MemoryUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listMemory() } }
                .onSuccess { list -> _uiState.update { it.copy(entries = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun setQuery(q: String) = _uiState.update { it.copy(query = q) }

    fun search() {
        val q = _uiState.value.query.trim()
        if (q.isBlank()) { refresh(); return }
        _uiState.update { it.copy(loading = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.searchMemory(q) } }
                .onSuccess { list -> _uiState.update { it.copy(entries = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun add(content: String, onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.addMemory(content) } }
                .onSuccess { refresh(); onDone() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun remove(id: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.removeMemory(id) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    MemoryViewModel(app.repository) as T
            }
    }
}
