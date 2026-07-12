package com.cindro.app.ui.mcp

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.cindro.app.protocol.CliMcp
import com.cindro.app.protocol.McpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class McpUiState(
    val servers: List<McpServer> = emptyList(),
    // Per-brain CLI MCP servers (codex/claude CLI's own). Off = isolated (default).
    val cliServers: List<CliMcp> = emptyList(),
    val loading: Boolean = false,
    val testResults: Map<String, String> = emptyMap(),
    val error: String? = null,
)

/** mcp.list/add/remove/test/set_enabled from the phone. add = biometric tier. */
class McpViewModel(private val repo: JarvisRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(McpUiState())
    val uiState: StateFlow<McpUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        _uiState.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listMcp() } }
                .onSuccess { list -> _uiState.update { it.copy(servers = list, loading = false) } }
                .onFailure { e -> _uiState.update { it.copy(loading = false, error = e.message) } }
        }
        // CLI per-brain servers load independently; a daemon without them just
        // yields an empty list (the section then hides) rather than failing the page.
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.cliListMcp() } }
                .onSuccess { list -> _uiState.update { it.copy(cliServers = list) } }
                .onFailure { /* leave cliServers as-is; section stays hidden if empty */ }
        }
    }

    fun setCliEnabled(brain: String, name: String, enabled: Boolean) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.cliSetMcpEnabled(brain, name, enabled) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    /** Caller MUST have cleared the BiometricPrompt (mcp.add is biometric). */
    fun add(
        name: String,
        transport: String,
        endpoint: String,
        token: String?,
        onDone: () -> Unit,
    ) {
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    repo.addMcp(name, transport, endpoint, token?.ifBlank { null })
                }
            }
                .onSuccess { refresh(); onDone() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun remove(name: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.removeMcp(name) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun setEnabled(name: String, enabled: Boolean) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.setMcpEnabled(name, enabled) } }
                .onSuccess { refresh() }
                .onFailure { e -> _uiState.update { it.copy(error = e.message) } }
        }
    }

    fun test(name: String) {
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { repo.testMcp(name) } }
                .getOrElse { it.message ?: "error" }
            _uiState.update { it.copy(testResults = it.testResults + (name to result)) }
        }
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    McpViewModel(app.repository) as T
            }
    }
}
