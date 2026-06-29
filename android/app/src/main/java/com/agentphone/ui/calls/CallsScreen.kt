package com.agentphone.ui.calls

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Backspace
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentphone.state.ConnectionStatus
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun CallsScreen(vm: AppViewModel) {
    val phone by vm.phone.collectAsState()
    var target by remember { mutableStateOf("101") }
    val connected = phone.connection == ConnectionStatus.ONLINE
    val activeCall = phone.activeCallId

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 12.dp)
    ) {
        DialDisplay(value = target, semanticHint = hintFor(phone.connection))
        Spacer(Modifier.height(20.dp))
        QuickContacts(onPick = { target = it })
        Spacer(Modifier.height(20.dp))
        Dialpad(
            onDigit = { target = (target + it).take(8) },
            onBackspace = { target = target.dropLast(1) },
            onCall = {
                if (connected && target.isNotBlank()) vm.dial(target.trim())
            },
            callEnabled = connected && target.isNotBlank()
        )

        AnimatedVisibility(
            visible = activeCall != null || phone.peerExtension != null,
            enter = fadeIn(),
            exit = fadeOut()
        ) {
            Column(modifier = Modifier.padding(top = 16.dp)) {
                GlassCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(40.dp)
                                .clip(CircleShape)
                                .background(Palette.Indigo.copy(alpha = 0.2f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(Icons.Rounded.Phone, contentDescription = null, tint = Palette.Indigo)
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                phone.peerExtension ?: "active call",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                phone.callState,
                                style = MaterialTheme.typography.bodySmall,
                                color = LocalSemanticColors.current.textMuted
                            )
                        }
                        if (activeCall != null) {
                            PressableButton(
                                label = "End",
                                variant = ButtonVariant.Danger,
                                onClick = { vm.endActiveCall() },
                                fillWidth = false
                            )
                        }
                    }
                }
            }
        }

        if (!connected) {
            Spacer(Modifier.height(16.dp))
            GlassCard {
                Text(
                    "Connect required",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    hintFor(phone.connection),
                    style = MaterialTheme.typography.bodyMedium,
                    color = LocalSemanticColors.current.textMuted
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PressableButton(label = "Connect", onClick = { vm.connect() }, modifier = Modifier.weight(1f))
                    PressableButton(
                        label = "Reconnect",
                        variant = ButtonVariant.Outline,
                        onClick = { vm.reconnect() },
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}

private fun hintFor(status: ConnectionStatus): String = when (status) {
    ConnectionStatus.ONLINE -> "Ready to dial."
    ConnectionStatus.RECONNECTING -> "Reconnecting…"
    ConnectionStatus.CONNECTING, ConnectionStatus.AUTHENTICATING -> "Authenticating…"
    ConnectionStatus.ERROR -> "Last connect failed. Tap Connect to retry."
    ConnectionStatus.DISCONNECTED -> "Tap Connect to bring the line up."
}

@Composable
private fun DialDisplay(value: String, semanticHint: String) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            value.ifBlank { "•" },
            style = MaterialTheme.typography.displayLarge.copy(fontSize = 44.sp),
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(4.dp))
        Text(
            semanticHint,
            style = MaterialTheme.typography.bodySmall,
            color = LocalSemanticColors.current.textMuted
        )
    }
}

@Composable
private fun QuickContacts(onPick: (String) -> Unit) {
    val quick = listOf("101", "102", "103", "104", "105", "900")
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(quick) { ext ->
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .border(1.dp, LocalSemanticColors.current.hairline, RoundedCornerShape(50))
                    .clickable { onPick(ext) }
                    .padding(horizontal = 14.dp, vertical = 8.dp)
            ) {
                Text(
                    ext,
                    style = LocalMonoTypography.current.medium,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}

@Composable
private fun Dialpad(onDigit: (String) -> Unit, onBackspace: () -> Unit, onCall: () -> Unit, callEnabled: Boolean) {
    val rows = listOf(
        listOf("1", "2", "3"),
        listOf("4", "5", "6"),
        listOf("7", "8", "9"),
        listOf("*", "0", "#")
    )
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { key ->
                    DialKey(label = key, onClick = { onDigit(key) }, modifier = Modifier.weight(1f))
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(modifier = Modifier.weight(1f))
            CallActionButton(onClick = onCall, enabled = callEnabled)
            BackspaceKey(onClick = onBackspace, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun DialKey(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val semantic = LocalSemanticColors.current
    Box(
        modifier = modifier
            .height(64.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .border(1.dp, semantic.hairline, RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Text(
            label,
            style = MaterialTheme.typography.headlineMedium.copy(fontSize = 24.sp),
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun CallActionButton(onClick: () -> Unit, enabled: Boolean) {
    Box(
        modifier = Modifier
            .size(72.dp)
            .clip(CircleShape)
            .background(if (enabled) Palette.Indigo else Palette.IndigoDim.copy(alpha = 0.4f))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            Icons.Rounded.Phone,
            contentDescription = "Call",
            tint = Palette.OnAccent,
            modifier = Modifier.size(28.dp)
        )
    }
}

@Composable
private fun BackspaceKey(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(64.dp)
            .clip(RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            Icons.Rounded.Backspace,
            contentDescription = "Delete",
            tint = LocalSemanticColors.current.textMuted
        )
    }
}
