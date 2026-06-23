package com.jarvis.app.ui.skills

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
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Today
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.protocol.Skill
import com.jarvis.app.protocol.TodayItem
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SkillsScreen(viewModel: SkillsViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var showCreate by remember { mutableStateOf(false) }
    var invokeFor by remember { mutableStateOf<Skill?>(null) }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Skills") },
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
                text = { Text("New skill") },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // TODAY card
            TodayCard(state.today)

            state.error?.let {
                Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
            }
            state.toast?.let {
                Text(it, color = JarvisPalette.Success, style = MaterialTheme.typography.bodySmall)
            }

            Text("Self-authored skills", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)

            if (state.skills.isEmpty()) {
                Text("No skills yet — create one Jarvis can run on command.", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            } else {
                state.skills.forEach { skill ->
                    SkillRow(
                        skill = skill,
                        onInvoke = { invokeFor = skill },
                        onRemove = { viewModel.remove(skill.name) },
                    )
                }
            }
        }
    }

    if (showCreate) {
        CreateSkillDialog(
            onDismiss = { showCreate = false },
            onCreate = { name, desc, body -> viewModel.create(name, desc, body) { showCreate = false } },
        )
    }
    invokeFor?.let { skill ->
        InvokeSkillDialog(
            skill = skill,
            onDismiss = { invokeFor = null },
            onInvoke = { args -> viewModel.invoke(skill.name, args); invokeFor = null },
        )
    }
}

@Composable
private fun TodayCard(items: List<TodayItem>) {
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = true) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Today, contentDescription = null, tint = JarvisPalette.Accent, modifier = Modifier.height(20.dp))
                Spacer(Modifier.height(0.dp))
                Text("  Today", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.Accent)
            }
            Spacer(Modifier.height(8.dp))
            if (items.isEmpty()) {
                Text("Nothing on the agenda.", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            } else {
                items.forEach {
                    Text("• ${it.title}", color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium)
                    it.detail?.let { d -> Text("   $d", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}

@Composable
private fun SkillRow(skill: Skill, onInvoke: () -> Unit, onRemove: () -> Unit) {
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("/${skill.name}", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace), color = JarvisPalette.TextPrimary)
                IconButton(onClick = onInvoke) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = "Invoke", tint = JarvisPalette.Accent)
                }
            }
            skill.description?.let {
                Text(it, color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
            if (skill.tags.isNotEmpty()) {
                Text(skill.tags.joinToString(" ") { "#$it" }, color = JarvisPalette.AccentDim, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            TextButton(onClick = onRemove) { Text("Remove", color = JarvisPalette.Error) }
        }
    }
}

@Composable
private fun CreateSkillDialog(onDismiss: () -> Unit, onCreate: (String, String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Create skill", color = JarvisPalette.TextPrimary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name (slug)") }, singleLine = true)
                OutlinedTextField(value = desc, onValueChange = { desc = it }, label = { Text("Description") }, singleLine = true)
                OutlinedTextField(value = body, onValueChange = { body = it }, label = { Text("Body (markdown)") }, maxLines = 6)
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(name, desc, body) }, enabled = name.isNotBlank() && body.isNotBlank()) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun InvokeSkillDialog(skill: Skill, onDismiss: () -> Unit, onInvoke: (String) -> Unit) {
    var args by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Run /${skill.name}", color = JarvisPalette.TextPrimary) },
        text = {
            OutlinedTextField(value = args, onValueChange = { args = it }, label = { Text("Arguments") }, modifier = Modifier.fillMaxWidth())
        },
        confirmButton = { TextButton(onClick = { onInvoke(args) }) { Text("Run") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
