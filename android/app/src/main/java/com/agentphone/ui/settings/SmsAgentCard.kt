package com.agentphone.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors

/**
 * "Text your agent" over SMS.
 *
 * When ON, an SMS sent to your Twilio number is handed to the selected agent,
 * which replies straight back over SMS — a two-way text conversation with your
 * agent from any phone. When OFF, inbound texts just land in your in-app inbox
 * (the prior behaviour). You pick which agent answers here.
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
fun SmsAgentCard(vm: AppViewModel) {
    val semantic = LocalSemanticColors.current

    var enabled by remember { mutableStateOf<Boolean?>(null) }
    var toggling by remember { mutableStateOf(false) }
    var extension by remember { mutableStateOf("") }
    var agents by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    LaunchedEffect(Unit) {
        vm.getSmsAgentConfig { cfg ->
            if (cfg != null) {
                enabled = cfg.enabled
                extension = cfg.extension
                agents = cfg.agents
            }
        }
    }

    GlassCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Text your agent (SMS)", style = MaterialTheme.typography.titleMedium)
                Text(
                    when (enabled) {
                        true -> "ON — texting your number reaches the agent, which texts you back."
                        false -> "OFF — inbound texts just land in your inbox."
                        else -> "…"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted
                )
            }
            Switch(
                checked = enabled == true,
                enabled = enabled != null && !toggling,
                onCheckedChange = { want ->
                    toggling = true
                    vm.setSmsAgentEnabled(want) { now ->
                        enabled = now ?: enabled
                        toggling = false
                    }
                }
            )
        }

        if (agents.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            Text("Who answers your texts", style = MaterialTheme.typography.titleSmall)
            Text(
                "Mistral is a fast, cheap brain for quick replies. Codex/Claude can actually do work " +
                    "and text you the result.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                agents.forEach { (ext, name) ->
                    val selected = ext == extension
                    PressableButton(
                        label = name,
                        variant = if (selected) ButtonVariant.Primary else ButtonVariant.Outline,
                        onClick = {
                            val prev = extension
                            extension = ext
                            vm.setSmsAgent(ext) { ok -> if (!ok) extension = prev }
                        }
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Text(
            "Your number must be on the Twilio allowlist. Note: toll-free SMS may be blocked until " +
                "the number completes carrier verification.",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
    }
}
