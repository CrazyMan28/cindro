package com.jarvis.app.ui.mcp

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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
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
import com.jarvis.app.protocol.McpServer
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.Biometric
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun McpScreen(viewModel: McpViewModel, activity: FragmentActivity) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var showAdd by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("MCP servers") },
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
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showAdd = true },
                containerColor = JarvisPalette.Accent,
                contentColor = JarvisPalette.OnAccent,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("Add") },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (state.servers.isEmpty()) {
                Text(
                    state.error ?: "No MCP servers configured.",
                    color = if (state.error != null) JarvisPalette.Error else JarvisPalette.TextSecondary,
                    modifier = Modifier.align(Alignment.Center),
                )
            } else {
                LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.servers, key = { it.name }) { server ->
                        McpRow(
                            server = server,
                            testResult = state.testResults[server.name],
                            onToggle = { viewModel.setEnabled(server.name, it) },
                            onTest = { viewModel.test(server.name) },
                            onRemove = { viewModel.remove(server.name) },
                        )
                    }
                }
            }
        }
    }

    if (showAdd) {
        AddMcpDialog(
            onDismiss = { showAdd = false },
            onAdd = { name, url, command ->
                scope.launch {
                    val ok = Biometric.authenticate(
                        activity,
                        title = "Add MCP server",
                        subtitle = name,
                    )
                    if (ok) viewModel.add(name, url, command) { showAdd = false }
                }
            },
        )
    }
}

@Composable
private fun McpRow(
    server: McpServer,
    testResult: String?,
    onToggle: (Boolean) -> Unit,
    onTest: () -> Unit,
    onRemove: () -> Unit,
) {
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = server.enabled) {
        Column {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(server.name, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                Switch(checked = server.enabled, onCheckedChange = onToggle)
            }
            (server.url ?: server.command)?.let {
                Text(it, color = JarvisPalette.Accent, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            }
            testResult?.let {
                Spacer(Modifier.height(4.dp))
                Text("test: $it", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onTest) { Text("Test") }
                TextButton(onClick = onRemove) {
                    Icon(Icons.Filled.Delete, contentDescription = null, tint = JarvisPalette.Error, modifier = Modifier.height(16.dp))
                    Text(" Remove", color = JarvisPalette.Error)
                }
            }
        }
    }
}

@Composable
private fun AddMcpDialog(
    onDismiss: () -> Unit,
    onAdd: (name: String, url: String, command: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Add MCP server", color = JarvisPalette.TextPrimary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("URL (http MCP)") }, singleLine = true)
                OutlinedTextField(value = command, onValueChange = { command = it }, label = { Text("Command (stdio)") }, singleLine = true)
            }
        },
        confirmButton = {
            TextButton(onClick = { onAdd(name, url, command) }, enabled = name.isNotBlank() && (url.isNotBlank() || command.isNotBlank())) {
                Text("Add")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
