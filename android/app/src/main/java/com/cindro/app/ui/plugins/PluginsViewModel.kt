package com.cindro.app.ui.plugins

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.Plugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PluginsUiState(
    val plugins: List<Plugin> = emptyList(),
    val loading: Boolean = false,
    val busyId: String? = null,
    val error: String? = null,
)

/** plugins.catalog/install/set_enabled/remove from the phone. */
class PluginsViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(PluginsUiState())
    val uiState: StateFlow<PluginsUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.pluginCatalog() } }
                .onSuccess { list -> _uiState.update { it.copy(plugins = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun install(id: String) = mutate(id) { repo.installPlugin(id) }
    fun remove(id: String) = mutate(id) { repo.removePlugin(id) }
    fun setEnabled(id: String, enabled: Boolean) = mutate(id) { repo.setPluginEnabled(id, enabled) }

    private fun mutate(id: String, block: suspend () -> Unit) {
        _uiState.update { it.copy(busyId = id) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { block() } }
                .onSuccess { _uiState.update { it.copy(busyId = null) }; refresh() }
                .onFailure { e -> _uiState.update { it.copy(busyId = null, error = e.message) } }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    PluginsViewModel(app.repository) as T
            }
    }
}
