package com.jarvis.app.ui.queue

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jarvis.app.JarvisApp
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.QueuedTask
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class QueueUiState(
    val tasks: List<QueuedTask> = emptyList(),
    val loading: Boolean = false,
    val queueing: Boolean = false,
    val error: String? = null,
)

/** Lists queued tasks (task.list) and enqueues new ones (task.queue). */
class QueueViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(QueueUiState())
    val uiState: StateFlow<QueueUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listTasks() } }
                .onSuccess { list -> _uiState.update { it.copy(tasks = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun queue(text: String, whenAt: Long?) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        _uiState.update { it.copy(queueing = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.queueTask(trimmed, whenAt) } }
                .onSuccess {
                    _uiState.update { it.copy(queueing = false) }
                    refresh()
                }
                .onFailure { e -> _uiState.update { it.copy(queueing = false, error = e.message) } }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    QueueViewModel(app.repository) as T
            }
    }
}
