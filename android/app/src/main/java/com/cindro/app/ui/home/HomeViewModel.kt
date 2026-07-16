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
    /** "/" command palette catalog for the blank composer — same shape/lazy-load
     *  pattern as ChatViewModel's, since this screen is now the default place to
     *  start a chat and needs the same agent/skill picker. */
    val slashAgents: List<com.cindro.app.protocol.Agent> = emptyList(),
    val slashSkills: List<com.cindro.app.protocol.Skill> = emptyList(),
    /** Models offered by the brain currently picked in NewChatScreen's model
     *  chip (empty = daemon default) — same field SessionsUiState uses for its
     *  create-session dialog. */
    val models: List<com.cindro.app.protocol.ModelInfo> = emptyList(),
)

/** Backs the Home dashboard: recent sessions + the most recent live canvas + connection. */
class HomeViewModel(
    private val repo: JarvisRepository,
    appContext: Context,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        HomeUiState(
            // Never seed the "live widget" preview from a plan/checklist card
            // (id "__todo__:<session>") — those are session-private (see the
            // widgetEvents collector below).
            latestCanvas = WidgetCatalog.list(appContext)
                .firstOrNull { !it.id.startsWith("__todo__") }
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
                // Skip the session-private plan/checklist card (id "__todo__:<session>")
                // — it belongs to its owning chat, not this session-neutral "live
                // widget" preview (Home + new-chat composer). A LIVE plan update from
                // any session would otherwise reappear here (the cross-session leak);
                // filtering only the on-disk seed above is not enough.
                if (w.op == "render" && w.spec != null && !w.id.startsWith("__todo__")) {
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
                .onSuccess { list ->
                    // Subagent child sessions are not normal chats: they belong to
                    // their parent chat and disappear when done — never top-level
                    // rows, on any surface (jarvis#72; see SessionsViewModel for the
                    // same filter). The drawer's Recents list reads this state, so
                    // without it a running subagent would show up as an openable
                    // top-level chat in the sidebar.
                    _uiState.update { it.copy(sessions = list.filterNot(Session::isSubagent)) }
                }
        }
    }

    fun createSession(
        profile: String = "coworker",
        brain: String = "codex",
        model: String? = null,
        onCreated: (String) -> Unit,
        onError: (() -> Unit)? = null,
    ) {
        // Guarded here, not just at the call site: PendingFirstMessage is a
        // single-slot handoff, so two rapid createSession() calls before the
        // UI recomposes (the caller's own `state.creating` check hasn't taken
        // effect yet) could both fire session.create — the second stash()
        // would silently overwrite the first chat's typed message.
        if (_uiState.value.creating) return
        _uiState.update { it.copy(creating = true) }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.createSession(profile, brain, model) } }
                .onSuccess { id -> _uiState.update { it.copy(creating = false) }; refresh(); onCreated(id) }
                .onFailure { _uiState.update { it.copy(creating = false) }; onError?.invoke() }
        }
    }

    /** Lazily load the "/" palette catalog (agents + skills) the first time the
     *  user opens it, so the dropdown has live data to filter — mirrors
     *  ChatViewModel.loadSlashCatalog() exactly. */
    fun loadSlashCatalog() {
        if (_uiState.value.slashAgents.isNotEmpty() || _uiState.value.slashSkills.isNotEmpty()) return
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listAgents() } }
                .onSuccess { a -> _uiState.update { it.copy(slashAgents = a) } }
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listSkills() } }
                .onSuccess { s -> _uiState.update { it.copy(slashSkills = s) } }
        }
    }

    /** Load the models a brain offers, for NewChatScreen's model chip — mirrors
     *  SessionsViewModel.loadModels() exactly. On failure just clears the list so
     *  the picker falls back to the daemon default — never blocks. */
    fun loadModels(brain: String) {
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { repo.listModels(brain) } }
                .onSuccess { list -> _uiState.update { it.copy(models = list) } }
                .onFailure { _uiState.update { it.copy(models = emptyList()) } }
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
