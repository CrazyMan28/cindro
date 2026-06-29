package com.agentphone.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.IconPill
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette
import org.json.JSONArray

data class AgentRow(val name: String, val extension: String, val status: String, val task: String)

@Composable
fun AgentsScreen(vm: AppViewModel, onDial: (String) -> Unit) {
    var loading by remember { mutableStateOf(true) }
    var agents by remember { mutableStateOf<List<AgentRow>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    fun refresh() {
        loading = true
        error = null
        vm.getAgents { result ->
            loading = false
            if (!result.ok) {
                error = result.error ?: "Could not load agents."
                agents = emptyList()
            } else {
                val arr = try { JSONArray(result.body) } catch (_: Throwable) { JSONArray() }
                agents = (0 until arr.length()).mapNotNull { i ->
                    val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                    AgentRow(
                        name = obj.optString("name", "Agent"),
                        extension = obj.optString("extension"),
                        status = obj.optString("status", "offline"),
                        task = obj.optString("current_task", "")
                    )
                }
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Active",
                style = MaterialTheme.typography.titleSmall,
                color = LocalSemanticColors.current.textMuted,
                modifier = Modifier.weight(1f)
            )
            IconPill(icon = Icons.Rounded.Refresh, onClick = { refresh() })
        }

        when {
            loading -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Palette.Indigo)
            }
            error != null -> ErrorState(message = error ?: "", onRetry = { refresh() })
            agents.isEmpty() -> EmptyState()
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(agents, key = { it.extension }) { agent ->
                    AgentCard(agent = agent, onCall = { onDial(agent.extension) })
                }
            }
        }
    }
}

@Composable
private fun AgentCard(agent: AgentRow, onCall: () -> Unit) {
    val semantic = LocalSemanticColors.current
    val online = agent.status == "online"
    val tint = if (online) semantic.online else semantic.textMuted
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .border(1.dp, semantic.hairline, shape)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Rounded.SmartToy, contentDescription = null, tint = tint)
        }
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    agent.name,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    agent.extension,
                    style = LocalMonoTypography.current.small,
                    color = semantic.textMuted
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                agent.task.ifBlank { "No current task" },
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted,
                maxLines = 2
            )
        }
        Spacer(Modifier.width(12.dp))
        PressableButton(
            label = "Call",
            variant = if (online) ButtonVariant.Primary else ButtonVariant.Outline,
            onClick = onCall,
            fillWidth = false
        )
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Rounded.SmartToy, contentDescription = null, tint = LocalSemanticColors.current.textMuted, modifier = Modifier.size(32.dp))
        }
        Spacer(Modifier.height(14.dp))
        Text("No agents registered", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(6.dp))
        Text(
            "Run ./scripts/dev-fix-empty-extensions.sh on the server.",
            style = MaterialTheme.typography.bodySmall,
            color = LocalSemanticColors.current.textMuted
        )
    }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(top = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("Couldn't load agents", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(8.dp))
        Text(message, style = MaterialTheme.typography.bodySmall, color = LocalSemanticColors.current.danger)
        Spacer(Modifier.height(16.dp))
        PressableButton(label = "Retry", onClick = onRetry, fillWidth = false)
    }
}
