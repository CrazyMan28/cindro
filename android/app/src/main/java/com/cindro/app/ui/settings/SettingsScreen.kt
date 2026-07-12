package com.cindro.app.ui.settings

import android.Manifest
import android.content.pm.PackageManager
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.core.content.ContextCompat
import com.cindro.app.voice.AudioRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.ui.ConnectionPill
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.Biometric
import com.cindro.app.voice.WakeService
import kotlinx.coroutines.launch

private val BRAINS = listOf("codex", "claude", "api")
private val API_PROVIDERS = listOf("openai", "anthropic", "ollama", "mistral", "gemini", "xai", "deepseek")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    activity: FragmentActivity,
    onUnpaired: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    val lastError by viewModel.lastError.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            viewModel.setWakeEnabled(true)
            WakeService.start(context)
        }
    }

    // --- Named voice library: record / upload a candidate reference clip ---
    val recorder = remember { AudioRecorder() }
    var recording by remember { mutableStateOf(false) }
    var clipB64 by remember { mutableStateOf<String?>(null) }
    var clipFormat by remember { mutableStateOf("wav") }
    var clipSource by remember { mutableStateOf("upload") }
    var newVoiceName by remember { mutableStateOf("") }
    var cleanClip by remember { mutableStateOf(true) }

    fun beginRecording() {
        if (recorder.start()) recording = true
    }
    val recordPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) beginRecording() }
    fun toggleRecording() {
        if (recording) {
            val wav = recorder.stopToWav()
            recording = false
            clipB64 = Base64.encodeToString(wav, Base64.NO_WRAP)
            clipFormat = "wav"
            clipSource = "record"
        } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            beginRecording()
        } else {
            recordPermLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val uploadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            scope.launch {
                val bytes = withContext(Dispatchers.IO) {
                    runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
                }
                if (bytes != null && bytes.isNotEmpty()) {
                    clipB64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    clipFormat = (uri.lastPathSegment ?: "").substringAfterLast('.', "wav").lowercase().ifBlank { "wav" }
                    clipSource = "upload"
                }
            }
        }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // --- Connection ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Daemon", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                        ConnectionPill(conn)
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(state.hostPort, color = JarvisPalette.Accent, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace))
                    lastError?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(onClick = viewModel::reconnect) {
                        Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.height(16.dp))
                        Text("  Reconnect")
                    }
                }
            }

            // --- Brain & model (settings.set / model.list) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("Default brain", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BRAINS.forEach { b ->
                            FilterChip(
                                selected = state.defaultBrain == b,
                                onClick = {
                                    scope.launch {
                                        if (Biometric.authenticate(activity, "Change default brain", b)) {
                                            viewModel.setDefaultBrain(b)
                                        }
                                    }
                                },
                                label = { Text(b) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = JarvisPalette.AccentDim,
                                    selectedLabelColor = JarvisPalette.TextPrimary,
                                ),
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    // HONEST drive capability — the chosen brain is honored, never
                    // silently swapped. codex + claude drive headless; api needs a key.
                    val driveOk = state.canDrive[state.defaultBrain] == true
                    Text(
                        if (driveOk) "✓ ${state.defaultBrain} can drive the computer-use desktop"
                        else if (state.defaultBrain == "api")
                            "⚠ api can't drive without an OpenAI/Anthropic key — pick codex or claude, or set a key below"
                        else "⚠ ${state.defaultBrain} can't drive the computer-use desktop headless",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (driveOk) JarvisPalette.Accent else JarvisPalette.Warning,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("Model (${state.modelsBrain})", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                    Spacer(Modifier.height(6.dp))
                    if (state.models.isEmpty()) {
                        Text("No models reported.", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodySmall)
                    } else {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(state.models, key = { it.id }) { m ->
                                FilterChip(
                                    selected = state.defaultModel == m.id,
                                    onClick = {
                                        scope.launch {
                                            if (Biometric.authenticate(activity, "Set default model", m.display)) {
                                                viewModel.setDefaultModel(m.id)
                                            }
                                        }
                                    },
                                    label = { Text(m.display, maxLines = 1) },
                                )
                            }
                        }
                    }
                    state.daemonError?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            // TODO(auto-updater): add an "Automatic updates" ToggleRow here,
            //   mirroring the letJarvisUseComputer pattern below:
            //     - SettingsUiState: add `autoUpdate: Boolean = true`, parsed from
            //       settings.get `auto_update` (default true) in the daemon snapshot.
            //     - SettingsViewModel: add `setAutoUpdate(enabled)` that pushes
            //       settings.set { auto_update } (same shape as setLetJarvisUseComputer).
            //     - This screen: a ToggleRow bound to state.autoUpdate.
            //   The daemon side (settings.get/set auto_update + update.check/apply)
            //   already exists; this is only the Android surface.

            // --- Let Cindro use a computer/browser (auto-spawn) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                ToggleRow(
                    title = "Let Cindro use a computer/browser",
                    subtitle = "When on, any chat can open apps and drive Chrome on its own isolated desktop on demand — no \"Computer\" tab needed.",
                    checked = state.letJarvisUseComputer,
                    onChange = { on ->
                        scope.launch {
                            if (Biometric.authenticate(
                                    activity, "Let Cindro use a computer",
                                    if (on) "Enable" else "Disable")) {
                                viewModel.setLetJarvisUseComputer(on)
                            }
                        }
                    },
                )
            }

            // --- Permissions (ask-before-risky policy) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("Permissions", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "How cautious Cindro is before risky actions. Tools are auto-ranked: HIGH = irreversible / your real world (delete files, your real screen, ssh, installs, sending things out), MEDIUM = reversible / agent-scoped (edit files, memory), LOW = read-only.",
                        style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    val levels = listOf(
                        Triple("high", "Cautious", "Ask before HIGH + MEDIUM"),
                        Triple("medium", "Balanced", "Ask before HIGH only"),
                        Triple("low", "Autonomous", "Only confirm the worst"),
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        levels.forEach { (id, name, sub) ->
                            val selected = state.permissionLevel == id
                            Surface(
                                onClick = {
                                    scope.launch {
                                        if (Biometric.authenticate(activity, "Set permission level", name)) {
                                            viewModel.setPermissionLevel(id)
                                        }
                                    }
                                },
                                shape = MaterialTheme.shapes.medium,
                                color = if (selected) JarvisPalette.AccentDim else JarvisPalette.SurfaceVariant,
                                border = if (selected) BorderStroke(1.dp, JarvisPalette.Accent) else null,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            name,
                                            style = MaterialTheme.typography.titleSmall,
                                            color = if (selected) JarvisPalette.TextPrimary else JarvisPalette.TextSecondary,
                                        )
                                        Text(
                                            sub,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = JarvisPalette.TextSecondary,
                                        )
                                    }
                                    if (selected) {
                                        Icon(
                                            Icons.Filled.Check,
                                            contentDescription = "Selected",
                                            tint = JarvisPalette.Accent,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Cindro calls ask_user (you approve here or on the laptop) before any action above your line. It's a policy, not the sandbox.",
                        style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary,
                    )
                }
            }

            // --- Mode + Autonomy (agent_mode/wake_notify parity + jarvis#76 8/9) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("Mode & autonomy", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(10.dp))

                    @Composable
                    fun optionRows(
                        title: String,
                        options: List<Triple<String, String, String>>,
                        selectedId: String,
                        gateLabel: String,
                        onPick: (String) -> Unit,
                    ) {
                        Text(title, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                        Spacer(Modifier.height(6.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            options.forEach { (id, name, sub) ->
                                val selected = selectedId == id
                                Surface(
                                    onClick = {
                                        scope.launch {
                                            if (Biometric.authenticate(activity, gateLabel, name)) onPick(id)
                                        }
                                    },
                                    shape = MaterialTheme.shapes.medium,
                                    color = if (selected) JarvisPalette.AccentDim else JarvisPalette.SurfaceVariant,
                                    border = if (selected) BorderStroke(1.dp, JarvisPalette.Accent) else null,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(name, style = MaterialTheme.typography.titleSmall,
                                                color = if (selected) JarvisPalette.TextPrimary else JarvisPalette.TextSecondary)
                                            Text(sub, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                                        }
                                        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = JarvisPalette.Accent)
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                    }

                    optionRows(
                        "Agent mode",
                        listOf(
                            Triple("plan", "Plan", "Research + plan only, no changes"),
                            Triple("coworker", "Co-worker", "Balanced default"),
                            Triple("build", "Build", "Execute autonomously"),
                        ),
                        state.agentMode, "Set agent mode",
                    ) { viewModel.setAgentMode(it) }

                    optionRows(
                        "Background wake notifications",
                        listOf(
                            Triple("silent", "Silent", "Wake Cindro only"),
                            Triple("ping", "Ping", "Notify phone for long jobs"),
                            Triple("always", "Always", "Notify on every wake"),
                        ),
                        state.wakeNotify, "Set wake notify",
                    ) { viewModel.setWakeNotify(it) }

                    optionRows(
                        "Self-improvement (post-turn review)",
                        listOf(
                            Triple("off", "Off", "Only explicit remember()"),
                            Triple("on", "On", "Auto-save one reusable fact per turn"),
                        ),
                        state.selfImprove, "Set self-improvement",
                    ) { viewModel.setSelfImprove(it) }

                    optionRows(
                        "Auto-continue toward active goals",
                        listOf(
                            Triple("off", "Off", "Never self-continue"),
                            Triple("capped", "Capped", "Up to 3 per user turn"),
                            Triple("on", "On", "Until the goal clears (max 25)"),
                        ),
                        state.autoContinue, "Set auto-continue",
                    ) { viewModel.setAutoContinue(it) }
                }
            }

            // --- Trust policies (jarvis#71): per-tool/per-app guardrails, ENFORCED ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Trust policies",
                            style = MaterialTheme.typography.titleMedium,
                            color = JarvisPalette.TextPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "ENFORCED",
                            style = MaterialTheme.typography.labelSmall,
                            color = JarvisPalette.Success,
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Per-tool / per-app rules enforced on every tool call: DENY fails the call, ASK pops an approval. Most specific rule wins. Globs work: browser_* on app *bank* → ask. Tap a rule's action to cycle it.",
                        style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary,
                    )
                    Spacer(Modifier.height(10.dp))

                    fun actionColor(a: String) = when (a) {
                        "deny" -> JarvisPalette.Error
                        "ask" -> JarvisPalette.Warning
                        else -> JarvisPalette.Success
                    }

                    // Default action for tools no rule matches.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "DEFAULT",
                            style = MaterialTheme.typography.labelSmall,
                            color = JarvisPalette.TextSecondary,
                            modifier = Modifier.weight(1f),
                        )
                        listOf("allow", "ask", "deny").forEach { a ->
                            val sel = state.trustDefault == a
                            Surface(
                                onClick = {
                                    scope.launch {
                                        if (Biometric.authenticate(activity, "Set default policy", a)) {
                                            viewModel.setPolicyDefault(a)
                                        }
                                    }
                                },
                                shape = MaterialTheme.shapes.small,
                                color = if (sel) actionColor(a).copy(alpha = 0.18f) else JarvisPalette.SurfaceVariant,
                                border = if (sel) BorderStroke(1.dp, actionColor(a)) else null,
                                modifier = Modifier.padding(start = 6.dp),
                            ) {
                                Text(
                                    a.uppercase(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (sel) actionColor(a) else JarvisPalette.TextSecondary,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))

                    if (state.trustRules.isEmpty()) {
                        Text(
                            "No rules yet — everything falls through to the default.",
                            style = MaterialTheme.typography.bodySmall,
                            color = JarvisPalette.TextSecondary,
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        state.trustRules.forEach { rule ->
                            Surface(
                                shape = MaterialTheme.shapes.medium,
                                color = JarvisPalette.SurfaceVariant,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                                ) {
                                    Surface(
                                        onClick = {
                                            scope.launch {
                                                if (Biometric.authenticate(activity, "Change rule", rule.tool)) {
                                                    viewModel.cyclePolicy(rule)
                                                }
                                            }
                                        },
                                        shape = MaterialTheme.shapes.small,
                                        color = actionColor(rule.action).copy(alpha = 0.16f),
                                        border = BorderStroke(1.dp, actionColor(rule.action)),
                                    ) {
                                        Text(
                                            rule.action.uppercase(),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = actionColor(rule.action),
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                        )
                                    }
                                    Spacer(Modifier.width(10.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            rule.tool + if (rule.app != "*") "  on ${rule.app}" else "",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = JarvisPalette.TextPrimary,
                                        )
                                        if (!rule.note.isNullOrBlank()) {
                                            Text(
                                                rule.note,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = JarvisPalette.TextSecondary,
                                            )
                                        }
                                    }
                                    IconButton(onClick = {
                                        scope.launch {
                                            if (Biometric.authenticate(activity, "Remove rule", rule.tool)) {
                                                viewModel.removePolicy(rule.id)
                                            }
                                        }
                                    }) {
                                        Icon(
                                            Icons.Filled.Close,
                                            contentDescription = "Remove rule",
                                            tint = JarvisPalette.TextSecondary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))

                    // Add a rule.
                    var newTool by remember { mutableStateOf("") }
                    var newApp by remember { mutableStateOf("") }
                    var newNote by remember { mutableStateOf("") }
                    var newAction by remember { mutableStateOf("ask") }
                    OutlinedTextField(
                        value = newTool, onValueChange = { newTool = it },
                        label = { Text("Tool glob (browser_*)") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = newApp, onValueChange = { newApp = it },
                        label = { Text("App glob (* = any)") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = newNote, onValueChange = { newNote = it },
                        label = { Text("Note (why)") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Surface(
                            onClick = {
                                newAction = when (newAction) { "allow" -> "ask"; "ask" -> "deny"; else -> "allow" }
                            },
                            shape = MaterialTheme.shapes.small,
                            color = actionColor(newAction).copy(alpha = 0.16f),
                            border = BorderStroke(1.dp, actionColor(newAction)),
                        ) {
                            Text(
                                newAction.uppercase(),
                                style = MaterialTheme.typography.labelSmall,
                                color = actionColor(newAction),
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        Button(
                            onClick = {
                                scope.launch {
                                    if (newTool.isBlank() && newApp.isBlank()) return@launch
                                    if (Biometric.authenticate(activity, "Add trust rule", newTool.ifBlank { "*" })) {
                                        viewModel.addPolicy(newTool.trim(), newApp.trim(), newAction, newNote.trim())
                                        newTool = ""; newApp = ""; newNote = ""
                                    }
                                }
                            },
                        ) { Text("Add rule") }
                    }
                }
            }

            // --- Claude account (Pro vs Max) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("Claude account", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Which Claude login the claude brain runs as. Defaults to Pro.",
                        style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary,
                    )
                    Spacer(Modifier.height(8.dp))
                    val accounts = listOf(
                        "pro" to "Pro (you@example.com)",
                        "max" to "Max (you-max@example.com)",
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        accounts.forEach { (id, label) ->
                            FilterChip(
                                selected = state.claudeAccount == id,
                                onClick = {
                                    scope.launch {
                                        if (Biometric.authenticate(activity, "Set Claude account", label)) {
                                            viewModel.setClaudeAccount(id)
                                        }
                                    }
                                },
                                label = { Text(label, maxLines = 1) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = JarvisPalette.AccentDim,
                                    selectedLabelColor = JarvisPalette.TextPrimary,
                                ),
                            )
                        }
                    }
                    if (state.claudeAccount == "max") {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "⚠ Max — uses your Max quota (you-max@example.com).",
                            style = MaterialTheme.typography.bodySmall, color = JarvisPalette.Warning,
                        )
                    }
                }
            }

            // --- API keys (incl. Mistral) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("API keys", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(8.dp))
                    API_PROVIDERS.forEach { provider ->
                        ApiKeyRow(
                            provider = provider,
                            isSet = state.apiKeysSet[provider] == true,
                            onSave = { key ->
                                scope.launch {
                                    if (Biometric.authenticate(activity, "Set $provider key", "Stored on the laptop")) {
                                        viewModel.setApiKey(provider, key)
                                    }
                                }
                            },
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }

            // --- Voice ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("Voice (Mistral Voxtral)", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(10.dp))
                    ToggleRow(
                        title = "\"Hey Cindro\" wake",
                        subtitle = "Foreground mic service with a visible notification",
                        checked = state.wakeEnabled,
                        onChange = { on ->
                            if (on) {
                                micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            } else {
                                viewModel.setWakeEnabled(false)
                                WakeService.stop(context)
                            }
                        },
                    )
                    Spacer(Modifier.height(10.dp))
                    ToggleRow(
                        title = "Speak replies",
                        subtitle = "Read assistant answers aloud via voice.tts",
                        checked = state.readBackEnabled,
                        onChange = viewModel::setReadBack,
                    )
                    Spacer(Modifier.height(10.dp))
                    var voice by remember(state.ttsVoice) { mutableStateOf(state.ttsVoice) }
                    OutlinedTextField(
                        value = voice,
                        onValueChange = { voice = it },
                        label = { Text("TTS voice id (blank = default)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(6.dp))
                    TextButton(onClick = { viewModel.setTtsVoice(voice) }) { Text("Save voice") }

                    Spacer(Modifier.height(14.dp))
                    Text("Default voice", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                    Text(
                        "Record your own or upload a clip, name it, and set it as default — used everywhere Cindro speaks, including phone calls (when it calls you and when it answers).",
                        style = MaterialTheme.typography.bodySmall,
                        color = JarvisPalette.TextSecondary,
                    )
                    Spacer(Modifier.height(8.dp))
                    if (state.voiceLibrary.isEmpty()) {
                        Text(
                            "No saved voices yet — record or upload one below.",
                            style = MaterialTheme.typography.bodySmall,
                            color = JarvisPalette.TextFaint,
                        )
                    } else {
                        state.voiceLibrary.forEach { v ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                            ) {
                                Text(
                                    if (v.isDefault) "● " else "○ ",
                                    color = if (v.isDefault) JarvisPalette.Success else JarvisPalette.TextFaint,
                                )
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        v.label + if (v.isDefault) "  · default" else "",
                                        color = JarvisPalette.TextPrimary,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    Text(
                                        when { v.source == "record" -> "recorded"; v.raw -> "raw clip"; else -> "clip" },
                                        color = JarvisPalette.TextFaint,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                                TextButton(onClick = { viewModel.previewVoice(v.id) }) { Text("Preview") }
                                if (!v.isDefault) {
                                    TextButton(onClick = { viewModel.setDefaultVoice(v.id) }) { Text("Set default") }
                                }
                                TextButton(onClick = { viewModel.deleteVoiceClone(v.id) }) {
                                    Text("Delete", color = JarvisPalette.Error)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = newVoiceName,
                        onValueChange = { newVoiceName = it },
                        label = { Text("New voice name (e.g. My Voice)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = { toggleRecording() }) {
                            Text(if (recording) "■ Stop" else "● Record")
                        }
                        Spacer(Modifier.width(8.dp))
                        OutlinedButton(
                            onClick = { uploadLauncher.launch(arrayOf("audio/*")) },
                            enabled = !recording,
                        ) { Text("Upload clip") }
                        Spacer(Modifier.width(8.dp))
                        if (clipB64 != null) {
                            Text("clip ready ✓", color = JarvisPalette.Accent, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(checked = cleanClip, onCheckedChange = { cleanClip = it })
                        Text("Auto-clean", color = JarvisPalette.TextSecondary, modifier = Modifier.padding(start = 6.dp))
                        Spacer(Modifier.weight(1f))
                        Button(
                            enabled = clipB64 != null && newVoiceName.isNotBlank() && !state.voiceBusy,
                            onClick = {
                                viewModel.createVoiceClone(newVoiceName, clipB64!!, clipFormat, cleanClip, clipSource)
                                newVoiceName = ""
                                clipB64 = null
                            },
                        ) { Text("Save voice") }
                    }
                    state.voiceMsg?.let { msg ->
                        Spacer(Modifier.height(4.dp))
                        Text(
                            msg,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (msg.startsWith("Saved")) JarvisPalette.Success else JarvisPalette.Error,
                        )
                    }
                }
            }

            // --- Haptics ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                ToggleRow(
                    title = "Haptics",
                    subtitle = "Subtle feedback: a tick on send, gentle pulses while a reply streams, and a tick when it finishes.",
                    checked = state.hapticsEnabled,
                    onChange = viewModel::setHapticsEnabled,
                )
            }

            // --- Fingerprint app-open gate (2FA + cross-device unlock) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                ToggleRow(
                    title = "Require fingerprint to open",
                    subtitle = "Ask for your fingerprint each time you open Cindro. Approving a desktop sign-in always requires it. Fails open if no screen lock is set.",
                    checked = state.fingerprintGateEnabled,
                    onChange = viewModel::setFingerprintGateEnabled,
                )
            }

            // --- Device identity ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("This device", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = state.deviceName,
                        onValueChange = viewModel::setDeviceName,
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    Text("Key fingerprint", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                    Text(state.deviceFingerprint, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    state.daemonFingerprint?.let {
                        Spacer(Modifier.height(8.dp))
                        Text("Daemon fingerprint", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                        Text(it, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            }

            // --- Notifications ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                ToggleRow(
                    title = "Notifications",
                    subtitle = "Push when an approval is needed, a task finishes, or a file is ready.",
                    checked = state.notificationsEnabled,
                    onChange = viewModel::setNotificationsEnabled,
                )
            }

            // --- Unpair ---
            Button(
                onClick = { viewModel.unpair(onUnpaired) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = JarvisPalette.Error.copy(alpha = 0.18f),
                    contentColor = JarvisPalette.Error,
                ),
            ) { Text("Unpair this device") }
        }
    }
}

@Composable
private fun ApiKeyRow(provider: String, isSet: Boolean, onSave: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    Column {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(provider.replaceFirstChar { it.uppercase() }, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyLarge)
            Text(if (isSet) "SET" else "—", color = if (isSet) JarvisPalette.Success else JarvisPalette.TextSecondary, style = MaterialTheme.typography.labelLarge)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (isSet) "Replace key…" else "Paste key…") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            TextButton(onClick = { if (value.isNotBlank()) { onSave(value); value = "" } }, enabled = value.isNotBlank()) {
                Text("Save")
            }
        }
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
