package com.cindro.app.ui.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.protocol.Agent
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.Biometric
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentsScreen(viewModel: AgentsViewModel, activity: FragmentActivity, onOpenChat: (String) -> Unit) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }
    var dispatchFor by remember { mutableStateOf<Agent?>(null) }

    // When a dispatch returns a session id, jump to its chat.
    LaunchedEffect(state.dispatchedSession) {
        state.dispatchedSession?.let { sid ->
            if (sid.isNotEmpty()) onOpenChat(sid)
            viewModel.clearDispatched()
        }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Agents") },
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
                text = { Text("New agent") },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            state.error?.let {
                Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
            }
            state.toast?.let {
                Text(it, color = JarvisPalette.Success, style = MaterialTheme.typography.bodySmall)
            }

            Text(
                "Custom subagents — you define what each does + when to call it. Cindro dispatches them; they report back in Chat.",
                style = MaterialTheme.typography.bodyMedium,
                color = JarvisPalette.TextSecondary,
            )

            if (state.agents.isEmpty()) {
                Text("No agents yet — create a specialist Cindro can delegate to.", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            } else {
                state.agents.forEach { agent ->
                    AgentRow(
                        agent = agent,
                        onDispatch = { dispatchFor = agent },
                        onRemove = {
                            scope.launch {
                                val ok = Biometric.authenticate(
                                    activity,
                                    title = "Remove agent",
                                    subtitle = agent.name,
                                )
                                if (ok) viewModel.remove(agent.name)
                            }
                        },
                    )
                }
            }
        }
    }

    if (showCreate) {
        CreateAgentDialog(
            onDismiss = { showCreate = false },
            onCreate = { name, desc, whenTo, brain, model, profile, prompt ->
                scope.launch {
                    val ok = Biometric.authenticate(activity, title = "Create agent", subtitle = name)
                    if (ok) {
                        viewModel.create(name, desc, whenTo, prompt, brain, model, profile) { showCreate = false }
                    }
                }
            },
        )
    }
    dispatchFor?.let { agent ->
        DispatchAgentDialog(
            agent = agent,
            onDismiss = { dispatchFor = null },
            onDispatch = { task ->
                dispatchFor = null
                scope.launch {
                    val ok = Biometric.authenticate(activity, title = "Dispatch ${agent.name}", subtitle = task)
                    if (ok) viewModel.dispatch(agent.name, task)
                }
            },
        )
    }
}

@Composable
private fun AgentRow(agent: Agent, onDispatch: () -> Unit, onRemove: () -> Unit) {
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(agent.name, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace), color = JarvisPalette.TextPrimary)
                IconButton(onClick = onDispatch) {
                    Icon(Icons.Filled.Send, contentDescription = "Dispatch", tint = JarvisPalette.Accent)
                }
            }
            agent.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
            agent.whenToUse?.takeIf { it.isNotBlank() }?.let {
                Text("↪ when: $it", color = JarvisPalette.Accent, style = MaterialTheme.typography.bodySmall)
            }
            val chips = listOfNotNull(
                agent.brain?.takeIf { it.isNotBlank() },
                agent.profile?.takeIf { it.isNotBlank() },
            )
            if (chips.isNotEmpty()) {
                Text(chips.joinToString("  ") { "[$it]" }, color = JarvisPalette.AccentDim, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            TextButton(onClick = onRemove) { Text("Remove", color = JarvisPalette.Error) }
        }
    }
}

@Composable
private fun CreateAgentDialog(
    onDismiss: () -> Unit,
    onCreate: (String, String, String, String, String, String, String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var whenTo by remember { mutableStateOf("") }
    var brain by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var profile by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Define agent", color = JarvisPalette.TextPrimary) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name (slug)") }, singleLine = true)
                OutlinedTextField(value = desc, onValueChange = { desc = it }, label = { Text("What it does") }, singleLine = true)
                OutlinedTextField(value = whenTo, onValueChange = { whenTo = it }, label = { Text("When to call it") }, maxLines = 2)
                OutlinedTextField(value = brain, onValueChange = { brain = it }, label = { Text("Brain (codex|claude|api, optional)") }, singleLine = true)
                OutlinedTextField(value = model, onValueChange = { model = it }, label = { Text("Model (optional)") }, singleLine = true)
                OutlinedTextField(value = profile, onValueChange = { profile = it }, label = { Text("Profile (coworker|coder, optional)") }, singleLine = true)
                OutlinedTextField(value = prompt, onValueChange = { prompt = it }, label = { Text("System prompt (its role)") }, maxLines = 6)
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name, desc, whenTo, brain, model, profile, prompt) },
                enabled = name.isNotBlank(),
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DispatchAgentDialog(agent: Agent, onDismiss: () -> Unit, onDispatch: (String) -> Unit) {
    var task by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Dispatch ${agent.name}", color = JarvisPalette.TextPrimary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("The agent runs as its own session and reports back in Chat.", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(value = task, onValueChange = { task = it }, label = { Text("Task") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
            }
        },
        confirmButton = { TextButton(onClick = { onDispatch(task) }, enabled = task.isNotBlank()) { Text("Dispatch") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
