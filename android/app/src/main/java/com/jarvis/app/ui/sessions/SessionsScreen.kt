package com.jarvis.app.ui.sessions

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.protocol.Session
import com.jarvis.app.ui.ConnectionPill
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    viewModel: SessionsViewModel,
    onOpenSession: (String) -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    var showCreate by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Sessions") },
                actions = {
                    ConnectionPill(conn)
                    Spacer(Modifier.height(0.dp))
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showCreate = true },
                containerColor = JarvisPalette.Accent,
                contentColor = JarvisPalette.OnAccent,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New") },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading && state.sessions.isEmpty() ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center), color = JarvisPalette.Accent)

                state.sessions.isEmpty() ->
                    EmptyState(state.error, onReconnect = { viewModel.reconnect(); viewModel.refresh() })

                else -> LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.sessions, key = { it.id }) { session ->
                        SessionRow(session, onClick = { onOpenSession(session.id) })
                    }
                }
            }
        }
    }

    if (showCreate) {
        CreateSessionDialog(
            creating = state.creating,
            onDismiss = { showCreate = false },
            onCreate = { profile, brain ->
                viewModel.createSession(profile, brain) { id ->
                    showCreate = false
                    onOpenSession(id)
                }
            },
        )
    }
}

@Composable
private fun SessionRow(session: Session, onClick: () -> Unit) {
    GlowCard(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column {
            Text(
                text = session.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                color = JarvisPalette.TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                session.brain?.let { Tag(it) }
                session.profile?.let { Tag(it) }
                session.state?.let { Tag(it) }
            }
        }
    }
}

@Composable
private fun Tag(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelLarge,
        color = JarvisPalette.TextSecondary,
    )
}

@Composable
private fun EmptyState(error: String?, onReconnect: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = error ?: "No sessions yet — tap New to start one.",
            color = if (error != null) JarvisPalette.Error else JarvisPalette.TextSecondary,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = onReconnect) { Text("Reconnect") }
        }
    }
}

@Composable
private fun CreateSessionDialog(
    creating: Boolean,
    onDismiss: () -> Unit,
    onCreate: (profile: String, brain: String) -> Unit,
) {
    var profile by remember { mutableStateOf("coworker") }
    var brain by remember { mutableStateOf("codex") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("New session", color = JarvisPalette.TextPrimary) },
        text = {
            Column {
                Text("Profile", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("coder", "coworker").forEach { p ->
                        FilterChip(selected = profile == p, onClick = { profile = p }, label = { Text(p) })
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text("Brain", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("codex", "claude", "api").forEach { b ->
                        FilterChip(selected = brain == b, onClick = { brain = b }, label = { Text(b) })
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(profile, brain) }, enabled = !creating) {
                if (creating) {
                    CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp, color = JarvisPalette.Accent)
                } else {
                    Text("Create")
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
