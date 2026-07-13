package com.cindro.app.ui.mcp

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
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
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.cindro.app.protocol.CliMcp
import com.cindro.app.protocol.McpServer
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.Biometric
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun McpScreen(viewModel: McpViewModel, activity: FragmentActivity, onOpenDrawer: () -> Unit) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var showAdd by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("MCP servers") },
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
            if (state.servers.isEmpty() && state.cliServers.isEmpty()) {
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

                    // ---- CLI servers (per brain) -----------------------------
                    if (state.cliServers.isNotEmpty()) {
                        item(key = "cli-header") {
                            Column {
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    "CLI servers (per brain)",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = JarvisPalette.TextPrimary,
                                )
                                Text(
                                    "These are your codex/claude CLI's own MCP servers. " +
                                        "Off = isolated (default). Toggle on to let Cindro use one.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = JarvisPalette.TextSecondary,
                                )
                            }
                        }
                        // Group by brain, codex first then claude, each with a subheader.
                        val grouped = state.cliServers.groupBy { it.brain }
                        val order = (listOf("codex", "claude") + grouped.keys).distinct()
                        order.forEach { brain ->
                            val rows = grouped[brain] ?: return@forEach
                            item(key = "cli-brain-$brain") {
                                Text(
                                    brain.uppercase(),
                                    style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace),
                                    color = JarvisPalette.Accent,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                            items(rows, key = { "cli-${it.brain}-${it.name}" }) { cli ->
                                CliMcpRow(
                                    server = cli,
                                    onToggle = { viewModel.setCliEnabled(cli.brain, cli.name, it) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAdd) {
        AddMcpDialog(
            onDismiss = { showAdd = false },
            onAdd = { name, transport, endpoint, token ->
                scope.launch {
                    val ok = Biometric.authenticate(
                        activity,
                        title = "Add MCP server",
                        subtitle = name,
                    )
                    if (ok) viewModel.add(name, transport, endpoint, token) { showAdd = false }
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
private fun CliMcpRow(
    server: CliMcp,
    onToggle: (Boolean) -> Unit,
) {
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = server.enabled) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(server.name, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                Text(
                    server.transport,
                    color = JarvisPalette.Accent,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
            Switch(checked = server.enabled, onCheckedChange = onToggle)
        }
    }
}

@Composable
private fun AddMcpDialog(
    onDismiss: () -> Unit,
    onAdd: (name: String, transport: String, endpoint: String, token: String?) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var transport by remember { mutableStateOf("http") }
    var endpoint by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var pasteJson by remember { mutableStateOf("") }
    var parseError by remember { mutableStateOf<String?>(null) }

    val isHttp = transport == "http"

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = { Text("Add MCP server", color = JarvisPalette.TextPrimary) },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                // Paste a standard MCP config JSON to auto-fill the fields below.
                OutlinedTextField(
                    value = pasteJson,
                    onValueChange = { pasteJson = it; parseError = null },
                    label = { Text("Paste config JSON (optional)") },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = {
                            when (val parsed = parseMcpConfig(pasteJson)) {
                                null -> parseError = "Couldn't parse MCP config JSON."
                                else -> {
                                    parsed.name?.let { name = it }
                                    transport = parsed.transport
                                    endpoint = parsed.endpoint
                                    token = parsed.token.orEmpty()
                                    parseError = null
                                }
                            }
                        },
                        enabled = pasteJson.isNotBlank(),
                    ) { Text("Parse") }
                    parseError?.let {
                        Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
                    }
                }

                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true)

                Text("Transport", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("http", "stdio").forEach { t ->
                        FilterChip(selected = transport == t, onClick = { transport = t }, label = { Text(t) })
                    }
                }

                OutlinedTextField(
                    value = endpoint,
                    onValueChange = { endpoint = it },
                    label = { Text(if (isHttp) "URL" else "Command") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (isHttp) {
                    OutlinedTextField(
                        value = token,
                        onValueChange = { token = it },
                        label = { Text("Token (bearer / OAuth, optional)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onAdd(name.trim(), transport, endpoint.trim(), token.ifBlank { null }) },
                enabled = name.isNotBlank() && endpoint.isNotBlank(),
            ) {
                Text("Add")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private data class ParsedMcp(
    val name: String?,
    val transport: String,
    val endpoint: String,
    val token: String?,
)

/**
 * Parse a standard MCP config JSON into form fields. Accepts:
 *  - {"mcpServers": {"<name>": {"url": ..., "headers": {"Authorization": "Bearer <tok>"}}}}
 *  - {"mcpServers": {"<name>": {"command": "npx", "args": [...]}}}
 *  - a bare single-server object {"url":..., "headers":{...}} or {"command":..., "args":[...]}
 * Returns null on any parse failure (caller shows an inline error; never crashes).
 */
private fun parseMcpConfig(raw: String): ParsedMcp? = runCatching {
    val root = JsonParser.parseString(raw).asJsonObject
    var name: String? = root.get("name")?.takeIf { !it.isJsonNull }?.asString

    // Unwrap {"mcpServers": {"<name>": {...}}} -> the first server object.
    val server: JsonObject = root.getAsJsonObject("mcpServers")?.let { servers ->
        val entry = servers.entrySet().firstOrNull() ?: return@runCatching null
        name = name ?: entry.key
        entry.value.asJsonObject
    } ?: root

    when {
        server.has("url") && !server.get("url").isJsonNull -> {
            val url = server.get("url").asString
            // token: explicit top-level token/bearer, else Authorization header (strip "Bearer ").
            val headerAuth = server.getAsJsonObject("headers")
                ?.get("Authorization")?.takeIf { !it.isJsonNull }?.asString
                ?.removePrefix("Bearer ")?.removePrefix("bearer ")?.trim()
            val token = server.get("token")?.takeIf { !it.isJsonNull }?.asString
                ?: server.get("bearer")?.takeIf { !it.isJsonNull }?.asString
                ?: headerAuth
            ParsedMcp(name = name, transport = "http", endpoint = url, token = token?.ifBlank { null })
        }
        server.has("command") && !server.get("command").isJsonNull -> {
            val command = server.get("command").asString
            val args = server.getAsJsonArray("args")
                ?.mapNotNull { if (it.isJsonNull) null else it.asString }
                ?: emptyList()
            val endpoint = (listOf(command) + args).joinToString(" ").trim()
            ParsedMcp(name = name, transport = "stdio", endpoint = endpoint, token = null)
        }
        else -> null
    }
}.getOrNull()
