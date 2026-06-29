package com.agentphone.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.BarChart
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.agentphone.puck.PuckModeCard
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.LabeledField
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun SettingsScreen(
    vm: AppViewModel,
    onOpenSetup: () -> Unit,
    onOpenDiagnostics: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenEnrollAgent: () -> Unit = {},
    onOpenAgentConfig: (extension: String, name: String) -> Unit = { _, _ -> }
) {
    val settings by vm.settings.collectAsState()
    var serverUrl by remember(settings) { mutableStateOf(settings.serverUrl) }
    var token by remember(settings) { mutableStateOf(settings.token) }
    var extension by remember(settings) { mutableStateOf(settings.extension) }
    var audioFormat by remember(settings) { mutableStateOf(settings.audioFormat) }
    val semantic = LocalSemanticColors.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 8.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ActionTile(
                icon = Icons.Rounded.PowerSettingsNew,
                label = "Run setup wizard",
                description = "Walk through server, permissions, and connection.",
                onClick = onOpenSetup
            )
            ActionTile(
                icon = Icons.Rounded.BarChart,
                label = "Diagnostics",
                description = "Inspect connection, auth, and service health.",
                onClick = onOpenDiagnostics
            )
            ActionTile(
                icon = Icons.Rounded.History,
                label = "Call history",
                description = "Recent calls and missed calls.",
                onClick = onOpenHistory
            )
            ActionTile(
                icon = Icons.Rounded.PersonAdd,
                label = "Add new agent",
                description = "Mint a token + extension and paste it onto a remote VM.",
                onClick = onOpenEnrollAgent
            )
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "Connection",
            style = MaterialTheme.typography.titleSmall,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
        )
        GlassCard {
            LabeledField(
                label = "Server URL",
                value = serverUrl,
                onValueChange = { serverUrl = it },
                mono = true
            )
            Spacer(Modifier.height(12.dp))
            LabeledField(
                label = "Extension",
                value = extension,
                onValueChange = { extension = it },
                mono = true,
                keyboardType = KeyboardType.Number
            )
            Spacer(Modifier.height(12.dp))
            LabeledField(
                label = "Device Token",
                value = token,
                onValueChange = { token = it },
                mono = true,
                password = true
            )
            Spacer(Modifier.height(12.dp))
            LabeledField(
                label = "Audio Format",
                value = audioFormat,
                onValueChange = { audioFormat = it },
                mono = true
            )
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PressableButton(
                    label = "Save",
                    onClick = {
                        vm.updateSettings(
                            serverUrl = serverUrl,
                            token = token,
                            extension = extension,
                            audioFormat = audioFormat
                        )
                    },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "Test",
                    variant = ButtonVariant.Outline,
                    onClick = {
                        vm.updateSettings(
                            serverUrl = serverUrl,
                            token = token,
                            extension = extension,
                            audioFormat = audioFormat
                        )
                        vm.runDiagnostics()
                    },
                    modifier = Modifier.weight(1f)
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "Call screening",
            style = MaterialTheme.typography.titleSmall,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
        )
        CallScreeningCard(vm)
        Spacer(Modifier.height(20.dp))
        Text(
            "Text your agent (SMS)",
            style = MaterialTheme.typography.titleSmall,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
        )
        SmsAgentCard(vm)
        Spacer(Modifier.height(20.dp))
        Text(
            "Bluetooth relay puck",
            style = MaterialTheme.typography.titleSmall,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
        )
        PuckModeCard()
        Spacer(Modifier.height(20.dp))
        Text(
            "Agents",
            style = MaterialTheme.typography.titleSmall,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
        )
        AgentListSection(vm, onOpenAgentConfig)
        Spacer(Modifier.height(24.dp))
    }
}

/** Tap an agent → its dedicated config page (voice, model, thinking, speed). */
@Composable
private fun AgentListSection(vm: AppViewModel, onOpen: (String, String) -> Unit) {
    var agents by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    LaunchedEffect(Unit) { vm.listAgents { list -> agents = list } }
    val semantic = LocalSemanticColors.current
    if (agents.isEmpty()) {
        GlassCard { Text("No agents found.", style = MaterialTheme.typography.bodySmall, color = semantic.textMuted) }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        agents.forEach { (ext, name) ->
            ActionTile(
                icon = Icons.Rounded.Settings,
                label = "$name · $ext",
                description = "Voice, model, thinking, speaking rate",
                onClick = { onOpen(ext, name) }
            )
        }
    }
}

@Composable
private fun ActionTile(icon: ImageVector, label: String, description: String, onClick: () -> Unit) {
    val semantic = LocalSemanticColors.current
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .border(1.dp, semantic.hairline, shape)
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(Palette.Indigo.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, contentDescription = null, tint = Palette.Indigo)
        }
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(description, style = MaterialTheme.typography.bodySmall, color = semantic.textMuted)
        }
        Icon(Icons.Rounded.ChevronRight, contentDescription = null, tint = semantic.textMuted)
    }
}
