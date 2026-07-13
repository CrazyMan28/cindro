package com.cindro.app.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SelectAll
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.protocol.ModelInfo
import com.cindro.app.protocol.Session
import com.cindro.app.ui.ConnectionPill
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    viewModel: SessionsViewModel,
    onOpenSession: (String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    var showCreate by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            if (state.selecting) {
                // Contextual selection action bar: count + delete + close.
                TopAppBar(
                    title = { Text("${state.selected.size} selected") },
                    navigationIcon = {
                        IconButton(onClick = { viewModel.clearSelection() }) {
                            Icon(Icons.Filled.Close, contentDescription = "Cancel selection")
                        }
                    },
                    actions = {
                        if (state.deleting) {
                            CircularProgressIndicator(
                                Modifier.size(22.dp).padding(end = 8.dp),
                                strokeWidth = 2.dp,
                                color = JarvisPalette.Error,
                            )
                        } else {
                            IconButton(
                                onClick = { confirmDelete = true },
                                enabled = state.selected.isNotEmpty(),
                            ) {
                                Icon(Icons.Filled.Delete, contentDescription = "Delete", tint = JarvisPalette.Error)
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = JarvisPalette.SurfaceVariant,
                        titleContentColor = JarvisPalette.TextPrimary,
                    ),
                )
            } else {
                TopAppBar(
                    title = {
                        Text("Sessions",
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold)
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    actions = {
                        ConnectionPill(conn)
                        Spacer(Modifier.height(0.dp))
                        if (state.sessions.isNotEmpty()) {
                            IconButton(onClick = { viewModel.selectAll() }) {
                                Icon(Icons.Filled.SelectAll, contentDescription = "Select all")
                            }
                        }
                        IconButton(onClick = { viewModel.refresh() }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = JarvisPalette.Background,
                        titleContentColor = JarvisPalette.TextPrimary,
                    ),
                )
            }
        },
        floatingActionButton = {
            if (!state.selecting) {
                ExtendedFloatingActionButton(
                    onClick = { showCreate = true },
                    containerColor = JarvisPalette.Accent,
                    contentColor = JarvisPalette.OnAccent,
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    text = { Text("New") },
                )
            }
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
                        SessionRow(
                            session = session,
                            selecting = state.selecting,
                            selected = session.id in state.selected,
                            onClick = {
                                if (state.selecting) viewModel.toggleSelection(session.id)
                                else onOpenSession(session.id)
                            },
                            onLongClick = {
                                if (state.selecting) viewModel.toggleSelection(session.id)
                                else viewModel.startSelection(session.id)
                            },
                        )
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = JarvisPalette.Surface,
            title = { Text("Delete sessions?", color = JarvisPalette.TextPrimary) },
            text = {
                Text(
                    "Permanently delete ${state.selected.size} session(s) and their history. This can't be undone.",
                    color = JarvisPalette.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; viewModel.deleteSelected() }) {
                    Text("Delete", color = JarvisPalette.Error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }

    if (showCreate) {
        CreateSessionDialog(
            creating = state.creating,
            models = state.models,
            onBrainChange = { viewModel.loadModels(it) },
            onDismiss = { showCreate = false },
            onCreate = { profile, brain, model ->
                viewModel.createSession(profile, brain, model) { id ->
                    showCreate = false
                    onOpenSession(id)
                }
            },
        )
    }
}

private fun brainColor(brain: String?): Color = when (brain?.lowercase()) {
    "codex" -> JarvisPalette.Accent
    "claude" -> Color(0xFFFF9D5C)   // warm amber
    "api" -> Color(0xFFB28BFF)      // violet
    else -> JarvisPalette.TextSecondary
}

private fun stateColor(state: String?): Color = when (state?.lowercase()) {
    "working", "running", "busy" -> JarvisPalette.Success
    "paused" -> JarvisPalette.Warning
    else -> JarvisPalette.TextSecondary
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionRow(
    session: Session,
    selecting: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val accent = brainColor(session.brain)
    GlowCard(
        modifier = Modifier.fillMaxWidth().combinedClickable(
            onClick = onClick,
            onLongClick = onLongClick,
        ),
        accent = selected,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Leading: selection check, or a brain-tinted avatar with its initial.
            if (selecting) {
                Icon(
                    imageVector = if (selected) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                    contentDescription = if (selected) "Selected" else "Not selected",
                    tint = if (selected) JarvisPalette.Accent else JarvisPalette.TextSecondary,
                    modifier = Modifier.size(24.dp),
                )
            } else {
                Box(
                    Modifier.size(46.dp).clip(RoundedCornerShape(14.dp))
                        .background(accent.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        (session.brain?.take(1) ?: "J").uppercase(),
                        color = accent,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = session.displayTitle,
                    style = MaterialTheme.typography.titleMedium,
                    color = JarvisPalette.TextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    session.state?.let { StatusDot(it) }
                    val meta = listOfNotNull(session.brain, session.profile)
                        .joinToString(" · ") { it.replaceFirstChar(Char::uppercase) }
                    if (meta.isNotEmpty()) {
                        Text(
                            meta,
                            style = MaterialTheme.typography.bodySmall,
                            color = JarvisPalette.TextSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            if (!selecting) {
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = JarvisPalette.TextSecondary.copy(alpha = 0.6f),
                )
            }
        }
    }
}

@Composable
private fun StatusDot(state: String) {
    val c = stateColor(state)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(c))
        Spacer(Modifier.width(5.dp))
        Text(
            state.replaceFirstChar(Char::uppercase),
            style = MaterialTheme.typography.labelMedium,
            color = c,
        )
    }
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

/** The brain + model FilterChip picker used by [CreateSessionDialog] when starting
 *  a new session (the chat top-bar's model chip is a separate, read-only display —
 *  there's no daemon RPC to switch brain/model on a session already in flight). */
@Composable
fun BrainModelPicker(
    brain: String,
    model: String?,
    models: List<ModelInfo>,
    onBrainChange: (String) -> Unit,
    onModelChange: (String?) -> Unit,
) {
    Column {
        Text("Brain", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("codex", "claude", "api").forEach { b ->
                FilterChip(selected = brain == b, onClick = { onBrainChange(b) }, label = { Text(b) })
            }
        }
        if (models.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text("Model", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                FilterChip(selected = model == null, onClick = { onModelChange(null) }, label = { Text("Default") })
                models.forEach { m ->
                    FilterChip(
                        selected = model == m.id,
                        onClick = { onModelChange(m.id) },
                        label = { Text(m.display) },
                    )
                }
            }
        }
    }
}

@Composable
private fun CreateSessionDialog(
    creating: Boolean,
    models: List<ModelInfo>,
    onBrainChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onCreate: (profile: String, brain: String, model: String?) -> Unit,
) {
    var profile by remember { mutableStateOf("coworker") }
    var brain by remember { mutableStateOf("codex") }
    // null = daemon default; otherwise a model id from the picked brain's models.
    var model by remember { mutableStateOf<String?>(null) }

    // Load the default brain's models on open and whenever the brain changes.
    LaunchedEffect(brain) { onBrainChange(brain) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("New session", color = JarvisPalette.TextPrimary) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text("Profile", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("coder", "coworker").forEach { p ->
                        FilterChip(selected = profile == p, onClick = { profile = p }, label = { Text(p) })
                    }
                }
                Spacer(Modifier.height(12.dp))
                BrainModelPicker(
                    brain = brain,
                    model = model,
                    models = models,
                    onBrainChange = { brain = it; model = null },
                    onModelChange = { model = it },
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(profile, brain, model) }, enabled = !creating) {
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
