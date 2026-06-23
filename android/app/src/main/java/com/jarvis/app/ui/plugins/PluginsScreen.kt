package com.jarvis.app.ui.plugins

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.protocol.Plugin
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PluginsScreen(viewModel: PluginsViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Plugins") },
                actions = {
                    IconButton(onClick = viewModel::refresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading && state.plugins.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center), color = JarvisPalette.Accent)

                state.plugins.isEmpty() ->
                    Text(
                        state.error ?: "No plugins in the catalog.",
                        color = if (state.error != null) JarvisPalette.Error else JarvisPalette.TextSecondary,
                        modifier = Modifier.align(Alignment.Center),
                    )

                else -> LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.plugins, key = { it.id }) { plugin ->
                        PluginRow(
                            plugin = plugin,
                            busy = state.busyId == plugin.id,
                            onInstall = { viewModel.install(plugin.id) },
                            onRemove = { viewModel.remove(plugin.id) },
                            onToggle = { viewModel.setEnabled(plugin.id, it) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PluginRow(
    plugin: Plugin,
    busy: Boolean,
    onInstall: () -> Unit,
    onRemove: () -> Unit,
    onToggle: (Boolean) -> Unit,
) {
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = plugin.enabled) {
        Column {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(plugin.display, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    plugin.version?.let { Text("v$it", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary) }
                }
                if (plugin.installed) {
                    Switch(checked = plugin.enabled, onCheckedChange = onToggle)
                }
            }
            plugin.description?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = JarvisPalette.TextSecondary)
            }
            Spacer(Modifier.height(6.dp))
            Row {
                if (busy) {
                    CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp, color = JarvisPalette.Accent)
                } else if (plugin.installed) {
                    TextButton(onClick = onRemove) { Text("Remove", color = JarvisPalette.Error) }
                } else {
                    TextButton(onClick = onInstall) { Text("Install") }
                }
            }
        }
    }
}
