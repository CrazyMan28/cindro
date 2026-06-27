package com.jarvis.app.ui.settings

import android.Manifest
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.jarvis.app.ui.ConnectionPill
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.Biometric
import com.jarvis.app.voice.WakeService
import kotlinx.coroutines.launch

private val BRAINS = listOf("codex", "claude", "api")
private val API_PROVIDERS = listOf("openai", "anthropic", "ollama", "mistral")

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

            // --- Let Jarvis use a computer/browser (auto-spawn) ---
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                ToggleRow(
                    title = "Let Jarvis use a computer/browser",
                    subtitle = "When on, any chat can open apps and drive Chrome on its own isolated desktop on demand — no \"Computer\" tab needed.",
                    checked = state.letJarvisUseComputer,
                    onChange = { on ->
                        scope.launch {
                            if (Biometric.authenticate(
                                    activity, "Let Jarvis use a computer",
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
                        "How cautious Jarvis is before risky actions. Tools are auto-ranked: HIGH = irreversible / your real world (delete files, your real screen, ssh, installs, sending things out), MEDIUM = reversible / agent-scoped (edit files, memory), LOW = read-only.",
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
                        "Jarvis calls ask_user (you approve here or on the laptop) before any action above your line. It's a policy, not the sandbox.",
                        style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary,
                    )
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
                        "pro" to "Pro (ogkihi2024@gmail.com)",
                        "max" to "Max (issac676767@proton.me)",
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
                            "⚠ Max — uses your Max quota (issac676767@proton.me).",
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
                        title = "\"Hey Jarvis\" wake",
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
                    subtitle = "Ask for your fingerprint each time you open Jarvis. Approving a desktop sign-in always requires it. Fails open if no screen lock is set.",
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
