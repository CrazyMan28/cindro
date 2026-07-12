package com.cindro.app.ui.canvas

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.cindro.app.JarvisApp
import com.cindro.app.net.JarvisRepository
import com.cindro.app.widget.WidgetCatalog
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** One canvas/widget the model has rendered. */
data class CanvasItem(val id: String, val title: String, val specJson: String)

data class CanvasUiState(val items: List<CanvasItem> = emptyList())

/**
 * Owns the phone's Canvas/Widgets gallery: every canvas the model has rendered,
 * deduped by id (a re-render with the same id replaces it — live updates). Seeds
 * from the on-disk [WidgetCatalog] so the gallery isn't empty on a cold open, then
 * folds live widget.render/remove/clear events. While this screen is open it holds
 * an "all" viewer lease so the previews keep updating (battery: dropped when the
 * ViewModel is cleared).
 */
class CanvasViewModel(
    private val repo: JarvisRepository,
    appContext: Context,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        CanvasUiState(
            WidgetCatalog.list(appContext).map { CanvasItem(it.id, it.title, it.specJson) },
        ),
    )
    val uiState: StateFlow<CanvasUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repo.widgetEvents.collect { w ->
                when (w.op) {
                    "render" -> if (w.spec != null) upsert(CanvasItem(w.id, w.title, w.spec.toString()))
                    "remove" -> _uiState.update { st -> st.copy(items = st.items.filterNot { it.id == w.id }) }
                    "clear" -> _uiState.update { it.copy(items = emptyList()) }
                }
            }
        }
        // Keep live widget previews refreshing while the gallery is on screen.
        viewModelScope.launch {
            while (true) {
                repo.widgetViewing("all", active = true, kind = "canvas")
                delay(20_000)
            }
        }
    }

    private fun upsert(item: CanvasItem) = _uiState.update { st ->
        val idx = st.items.indexOfFirst { it.id == item.id }
        if (idx >= 0) st.copy(items = st.items.toMutableList().also { it[idx] = item })
        else st.copy(items = listOf(item) + st.items)
    }

    companion object {
        fun factory(app: JarvisApp): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    CanvasViewModel(app.repository, app.applicationContext) as T
            }
    }
}
