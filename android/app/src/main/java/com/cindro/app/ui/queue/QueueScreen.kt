package com.cindro.app.ui.queue

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
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.protocol.QueuedTask
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueScreen(viewModel: QueueViewModel, onOpenDrawer: () -> Unit) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var draft by remember { mutableStateOf("") }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Queue") },
                navigationIcon = {
                    IconButton(onClick = onOpenDrawer) {
                        Icon(Icons.Filled.Menu, contentDescription = "Open menu")
                    }
                },
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
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(
                Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Queue a task for Cindro…") },
                    maxLines = 3,
                )
                Spacer(Modifier.height(0.dp))
                TextButton(
                    onClick = { viewModel.queue(draft, null); draft = "" },
                    enabled = !state.queueing && draft.isNotBlank(),
                ) {
                    if (state.queueing) {
                        CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp, color = JarvisPalette.Accent)
                    } else {
                        Text("Queue")
                    }
                }
            }

            state.error?.let {
                Text(
                    it, color = JarvisPalette.Error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Box(Modifier.fillMaxSize()) {
                when {
                    state.loading && state.tasks.isEmpty() ->
                        CircularProgressIndicator(Modifier.align(Alignment.Center), color = JarvisPalette.Accent)

                    state.tasks.isEmpty() ->
                        Text(
                            "Nothing queued.",
                            color = JarvisPalette.TextSecondary,
                            modifier = Modifier.align(Alignment.Center),
                        )

                    else -> LazyColumn(
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.tasks, key = { it.id }) { TaskRow(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: QueuedTask) {
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Text(task.text, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Filled.Schedule, contentDescription = null, tint = JarvisPalette.TextSecondary, modifier = Modifier.height(14.dp))
                Text(
                    text = (task.state ?: "queued").uppercase(),
                    style = MaterialTheme.typography.labelLarge,
                    color = JarvisPalette.TextSecondary,
                )
            }
        }
    }
}
