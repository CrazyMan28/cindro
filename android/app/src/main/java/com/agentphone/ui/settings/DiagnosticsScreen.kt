package com.agentphone.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Help
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.agentphone.state.DiagnosticsState
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.IconPill
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors

@Composable
fun DiagnosticsScreen(vm: AppViewModel, onBack: () -> Unit) {
    val diag by vm.diagnostics.collectAsState()
    val settings by vm.settings.collectAsState()
    val ctx = LocalContext.current

    LaunchedEffect(Unit) { vm.runDiagnostics() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconPill(icon = Icons.Rounded.ArrowBack, onClick = onBack)
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("Diagnostics", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
                Text(diag.lastWebSocketState, style = MaterialTheme.typography.bodySmall, color = LocalSemanticColors.current.textMuted)
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PressableButton(label = "Run", onClick = { vm.runDiagnostics() }, modifier = Modifier.weight(1f))
                PressableButton(label = "Connect", variant = ButtonVariant.Outline, onClick = { vm.connect() }, modifier = Modifier.weight(1f))
                PressableButton(label = "Copy", variant = ButtonVariant.Outline, onClick = {
                    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText(
                        "agent-phone-diagnostics",
                        diag.debugReport(settings.serverUrl, settings.extension, settings.websocketUrl(), settings.token.isNotBlank())
                    ))
                }, modifier = Modifier.weight(1f))
            }
            CheckCard("Server health", diag.healthOk, "GET /health")
            CheckCard("Auth token", diag.authOk, "GET /api/setup/status")
            CheckCard("Extension 100", diag.extensionExists, "User device registered")
            MetricCard("Extensions", diag.extensionCount?.toString() ?: "—")
            MetricCard("Agents", diag.agentCount?.toString() ?: "—", ok = diag.agentsOk)
            CheckCard("WebSocket", diag.websocketOk, "Authenticated as ${settings.extension}")
            CheckCard("Mistral", diag.mistralConfigured, "API key configured")
            CheckCard("Tailscale", diag.tailscaleReachable, diag.suggestedAndroidUrl ?: settings.serverUrl)

            GlassCard {
                Text("Connection values", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.height(8.dp))
                MonoLine("HTTP", settings.serverUrl)
                MonoLine("WS", settings.websocketUrl())
                MonoLine("Ext", settings.extension)
                MonoLine("Token", if (settings.token.isNotBlank()) "configured" else "missing")
            }

            if (diag.lastError != null) {
                GlassCard {
                    Text(
                        "Last error",
                        style = MaterialTheme.typography.titleMedium,
                        color = LocalSemanticColors.current.danger
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(diag.lastError ?: "", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
                    if (diag.suggestedFix != null && diag.suggestedFix != diag.lastError) {
                        Spacer(Modifier.height(8.dp))
                        Text(diag.suggestedFix ?: "", style = MaterialTheme.typography.bodySmall, color = LocalSemanticColors.current.textMuted)
                    }
                }
            }

            PressableButton(
                label = "Open /health in browser",
                variant = ButtonVariant.Outline,
                onClick = {
                    val url = settings.serverUrl.trim().removeSuffix("/") + "/health"
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            )
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun CheckCard(label: String, value: Boolean?, detail: String) {
    val semantic = LocalSemanticColors.current
    val (icon, tint, status) = when (value) {
        true -> Triple(Icons.Rounded.Check, semantic.success, "OK")
        false -> Triple(Icons.Rounded.Close, semantic.danger, "FAIL")
        null -> Triple(Icons.Rounded.Help, semantic.textMuted, "—")
    }
    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(tint.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = semantic.textMuted)
            }
            Text(status, style = MaterialTheme.typography.labelMedium, color = tint)
        }
    }
}

@Composable
private fun MetricCard(label: String, value: String, ok: Boolean? = null) {
    val tint = when (ok) {
        true -> LocalSemanticColors.current.success
        false -> LocalSemanticColors.current.danger
        null -> MaterialTheme.colorScheme.onSurface
    }
    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
            Text(value, style = LocalMonoTypography.current.large, color = tint)
        }
    }
}

@Composable
private fun MonoLine(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = LocalSemanticColors.current.textMuted, modifier = Modifier.width(56.dp))
        Text(value, style = LocalMonoTypography.current.small, color = MaterialTheme.colorScheme.onSurface)
    }
}
