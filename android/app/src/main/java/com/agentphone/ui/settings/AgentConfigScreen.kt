package com.agentphone.ui.settings

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette
import kotlin.math.roundToInt

private val THINKING_LEVELS = listOf("minimal", "low", "medium", "high", "xhigh")

// Which daemon brain (if any) this agent's model picker should query via
// model.list — codex/claude only; other extensions (Copilot, Echo, Hermes,
// Mistral Screener, ...) have no selectable Jarvis-brain model.
private fun brainFor(name: String): String? = when {
    name.contains("claude", ignoreCase = true) -> "claude"
    name.contains("codex", ignoreCase = true) -> "codex"
    else -> null
}

/**
 * Per-agent configuration: voice (grouped by speaker, with ▶ preview),
 * speaking rate, model, and thinking level. Opened by tapping an agent on the
 * Settings screen.
 */
@Composable
fun AgentConfigScreen(vm: AppViewModel, extension: String, agentName: String, onBack: () -> Unit) {
    val semantic = LocalSemanticColors.current
    var voices by remember { mutableStateOf<List<Pair<String?, String>>>(emptyList()) }
    var voiceId by remember(extension) { mutableStateOf<String?>(null) }
    var speed by remember(extension) { mutableDoubleStateOf(1.0) }
    var model by remember(extension) { mutableStateOf<String?>(null) }
    var reasoning by remember(extension) { mutableStateOf<String?>(null) }
    var modelOptions by remember(extension) { mutableStateOf<List<String>>(emptyList()) }
    val brain = remember(agentName) { brainFor(agentName) }

    LaunchedEffect(extension) {
        vm.listVoices { list -> voices = list }
        vm.getVoiceProfileFull(extension) { v, s -> voiceId = v; speed = s }
        vm.getModelConfig(extension) { m, r -> model = m; reasoning = r }
        brain?.let { b -> vm.listModelsForBrain(b) { ids -> modelOptions = ids } }
    }
    // Leaving the screen stops any playing preview.
    DisposableEffect(Unit) { onDispose { vm.stopVoicePreview() } }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back", tint = MaterialTheme.colorScheme.onSurface)
            }
            Column(Modifier.padding(start = 4.dp)) {
                Text(agentName, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
                Text("Extension $extension", style = MaterialTheme.typography.labelMedium, color = semantic.textMuted)
            }
        }
        Spacer(Modifier.height(12.dp))

        // ----- Voice -----
        SectionLabel("Voice")
        GlassCard {
            val selectedName = voices.firstOrNull { it.first == voiceId }?.second ?: "Default"
            Text("Current: $selectedName", style = MaterialTheme.typography.labelMedium, color = Palette.Indigo)
            // Live feedback: model downloads, save failures, preview errors.
            val status by vm.statusLine.collectAsState()
            if (status.contains("voice", ignoreCase = true) || status.contains("Download", ignoreCase = true)) {
                Spacer(Modifier.height(4.dp))
                Text(status, style = MaterialTheme.typography.labelSmall, color = semantic.textMuted)
            }
            Spacer(Modifier.height(10.dp))
            // Group "Paul - Cheerful" style names by speaker; each group is one
            // row of emotion chips. Tap to set; ▶ previews the selected voice.
            val groups = voices.groupBy { (id, name) -> if (id == null) "Default" else name.substringBefore(" - ").trim() }
            groups.forEach { (speaker, options) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(speaker, style = MaterialTheme.typography.labelSmall, color = semantic.textMuted, modifier = Modifier.width(64.dp))
                    Row(
                        modifier = Modifier
                            .weight(1f)
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        options.forEach { (id, name) ->
                            // "Paul - Cheerful" → "Cheerful"; single-name voices
                            // (e.g. "Jarvis (on-device)") keep their first word —
                            // the old "Neutral" fallback mislabeled Jarvis.
                            val label = when {
                                id == null -> "Default"
                                name.contains(" - ") -> name.substringAfter(" - ").trim()
                                else -> name.substringBefore(" (").trim()
                            }
                            val isSel = id == voiceId
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (isSel) Palette.Indigo.copy(alpha = 0.20f) else MaterialTheme.colorScheme.surfaceContainerHigh)
                                    .clickable {
                                        val previous = voiceId
                                        voiceId = id
                                        vm.setVoiceConfig(extension, id, if (id == null) null else name) { ok ->
                                            // Server rejected it (or network died) — revert the
                                            // chip so the UI never lies about what's saved.
                                            if (!ok) voiceId = previous
                                        }
                                        vm.previewVoice(id)
                                    }
                                    .padding(horizontal = 12.dp, vertical = 7.dp)
                            ) {
                                Text(
                                    label,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (isSel) Palette.Indigo else MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .clickable { vm.previewVoice(voiceId) }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            ) {
                Icon(Icons.Rounded.PlayArrow, contentDescription = null, tint = Palette.Indigo, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Preview voice", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
            }
        }
        Spacer(Modifier.height(16.dp))

        // ----- Speaking rate -----
        SectionLabel("Speaking rate")
        GlassCard {
            Text("${(speed * 100).roundToInt() / 100.0}×", style = MaterialTheme.typography.labelMedium, color = Palette.Indigo)
            Slider(
                value = speed.toFloat(),
                onValueChange = { speed = (it * 20).roundToInt() / 20.0 },
                onValueChangeFinished = { vm.setVoiceSpeed(extension, speed) },
                valueRange = 0.5f..2.0f
            )
            Text("0.5× slow · 1× normal · 2× fast", style = MaterialTheme.typography.labelSmall, color = semantic.textMuted)
        }
        Spacer(Modifier.height(16.dp))

        // ----- Model + thinking (only for agents with selectable models) -----
        if (brain != null && modelOptions.isNotEmpty()) {
            SectionLabel("Model")
            GlassCard {
                ChipRow(
                    labels = modelOptions,
                    selectedLabel = model ?: modelOptions.first(),
                    onSelect = { id ->
                        model = id
                        vm.setModelConfig(extension, model = id, reasoning = null)
                    }
                )
                Spacer(Modifier.height(12.dp))
                Text("Thinking", style = MaterialTheme.typography.labelSmall, color = semantic.textMuted)
                Spacer(Modifier.height(4.dp))
                ChipRow(
                    labels = THINKING_LEVELS,
                    selectedLabel = reasoning ?: "low",
                    onSelect = { level ->
                        reasoning = level
                        vm.setModelConfig(extension, model = null, reasoning = level)
                    }
                )
            }
            Spacer(Modifier.height(16.dp))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = LocalSemanticColors.current.textMuted,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp)
    )
}

@Composable
private fun ChipRow(labels: List<String>, selectedLabel: String?, onSelect: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        labels.forEach { label ->
            val isSel = label == selectedLabel
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (isSel) Palette.Indigo.copy(alpha = 0.20f) else MaterialTheme.colorScheme.surfaceContainerHigh)
                    .clickable { onSelect(label) }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (isSel) Palette.Indigo else MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}
