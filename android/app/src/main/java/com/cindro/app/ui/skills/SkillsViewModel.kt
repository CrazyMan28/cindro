package com.cindro.app.ui.skills

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.Skill
import com.cindro.app.protocol.TodayItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SkillsUiState(
    val skills: List<Skill> = emptyList(),
    val archived: List<Skill> = emptyList(),
    val today: List<TodayItem> = emptyList(),
    val loading: Boolean = false,
    val toast: String? = null,
    val error: String? = null,
)

/** skills.list/get/create/invoke + skills.today from the phone. */
class SkillsViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(SkillsUiState())
    val uiState: StateFlow<SkillsUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSkills() } }
                .onSuccess { list -> _uiState.update { it.copy(skills = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.today() } }
                .onSuccess { items -> _uiState.update { it.copy(today = items) } }
        }
        viewModelScope.launch {
            // Old daemons lack skills.list_archived — failures just hide the section.
            runCatching { withContext(Dispatchers.IO) { repo.listArchivedSkills() } }
                .onSuccess { list -> _uiState.update { it.copy(archived = list) } }
        }
    }

    fun unarchive(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.unarchiveSkill(name) } }
                .onSuccess { _uiState.update { it.copy(toast = "Restored $name") }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun setPinned(name: String, pinned: Boolean) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.pinSkill(name, pinned) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun create(name: String, description: String, body: String, onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.createSkill(name, description, body) } }
                .onSuccess { refresh(); onDone() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun invoke(name: String, args: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.invokeSkill(name, args, null) } }
                .onSuccess { _uiState.update { it.copy(toast = "Invoked /$name") } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun remove(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.removeSkill(name) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun clearToast() = _uiState.update { it.copy(toast = null) }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SkillsViewModel(app.repository) as T
            }
    }
}
