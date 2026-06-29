package com.agentphone.ui.call

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material.icons.rounded.Sms
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentphone.service.IncomingCallInfo
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Motion
import com.agentphone.ui.theme.Palette
import kotlinx.coroutines.delay

@Composable
fun IncomingCallScreen(
    info: IncomingCallInfo,
    showTextFallback: Boolean,
    onAccept: () -> Unit,
    onReject: () -> Unit,
    onSendText: (String) -> Unit,
    audioStart: () -> Boolean,
    audioStop: () -> Unit,
    onMuteChanged: (Boolean) -> Unit,
    startInCall: Boolean = false
) {
    var inCall by remember { mutableStateOf(startInCall) }
    var muted by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var quickReply by remember { mutableStateOf(if (showTextFallback) "I can't talk right now." else "") }
    var showReply by remember { mutableStateOf(showTextFallback) }
    val startMs = remember { mutableLongStateOf(0L) }
    var elapsed by remember { mutableStateOf(0L) }

    LaunchedEffect(inCall) {
        if (inCall) {
            startMs.longValue = System.currentTimeMillis()
            while (true) {
                elapsed = (System.currentTimeMillis() - startMs.longValue) / 1000
                delay(1000)
            }
        }
    }

    // Hands-free: start continuous listening the moment the call is accepted. No button.
    LaunchedEffect(inCall) {
        if (inCall) {
            val started = audioStart()
            status = if (started) "Listening — just talk, I'll reply when you pause." else "Microphone permission missing."
        }
    }

    val semantic = LocalSemanticColors.current

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(
                        Palette.Black,
                        Color(0xFF0E0F18),
                        Palette.Black
                    )
                )
            )
            .padding(horizontal = 24.dp, vertical = 48.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                if (inCall) "AGENT CALL" else "INCOMING AGENT CALL",
                style = MaterialTheme.typography.labelMedium,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(36.dp))

            CallerAvatar(
                initial = info.agentName.firstOrNull()?.uppercase() ?: "A",
                pulsing = !inCall
            )

            Spacer(Modifier.height(28.dp))
            Text(
                info.agentName.ifBlank { "Agent ${info.fromExtension}" },
                style = MaterialTheme.typography.displaySmall,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Extension ${info.fromExtension}",
                style = MaterialTheme.typography.bodyMedium,
                color = semantic.textMuted
            )

            val detail = listOfNotNull(
                info.reason.takeIf { it.isNotBlank() },
                info.message.takeIf { it.isNotBlank() },
                if (info.urgency.isNotBlank() && info.urgency != "normal") "Urgency: ${info.urgency.uppercase()}" else null
            ).joinToString("\n")
            if (detail.isNotBlank()) {
                Spacer(Modifier.height(14.dp))
                Text(detail, style = MaterialTheme.typography.bodySmall, color = semantic.textMuted, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.height(20.dp))
            Text(
                if (inCall) formatTimer(elapsed) else "Ringing…",
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 22.sp, fontFamily = FontFamily.Monospace),
                color = if (inCall) semantic.online else semantic.textMuted
            )

            AnimatedVisibility(visible = status != null, enter = fadeIn(Motion.fast()), exit = fadeOut(Motion.fast())) {
                Column {
                    Spacer(Modifier.height(10.dp))
                    Text(status ?: "", style = MaterialTheme.typography.bodySmall, color = semantic.textMuted, textAlign = TextAlign.Center)
                }
            }

            Spacer(Modifier.weight(1f))

            if (!inCall) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    BigCallButton(
                        icon = Icons.Rounded.CallEnd,
                        label = "Reject",
                        color = semantic.danger,
                        onClick = onReject
                    )
                    BigCallButton(
                        icon = Icons.Rounded.Sms,
                        label = "Text",
                        color = Palette.Indigo,
                        size = 64.dp,
                        onClick = {
                            showReply = true
                            status = "Send a quick reply without enabling the microphone."
                        }
                    )
                    BigCallButton(
                        icon = Icons.Rounded.Phone,
                        label = "Accept",
                        color = semantic.success,
                        pulse = true,
                        onClick = {
                            onAccept()
                            inCall = true
                            status = "Connecting…"
                        }
                    )
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    BigCallButton(
                        icon = if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                        label = if (muted) "Unmute" else "Mute",
                        color = if (muted) semantic.warning else Palette.IndigoDim,
                        size = 72.dp,
                        onClick = {
                            muted = !muted
                            onMuteChanged(muted)
                            status = if (muted) "Muted — tap Unmute to talk." else "Listening — just talk."
                        }
                    )
                    BigCallButton(
                        icon = Icons.Rounded.CallEnd,
                        label = "End",
                        color = semantic.danger,
                        size = 80.dp,
                        onClick = {
                            audioStop()
                            onReject()
                        }
                    )
                }
                Spacer(Modifier.height(14.dp))
                Text(
                    "Hands-free — just speak naturally. I'll reply when you pause.",
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted,
                    textAlign = TextAlign.Center
                )
            }

            AnimatedVisibility(visible = showReply, enter = fadeIn(Motion.medium()), exit = fadeOut(Motion.fast())) {
                Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
                    androidx.compose.foundation.text.BasicTextField(
                        value = quickReply,
                        onValueChange = { quickReply = it },
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Palette.Indigo),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                            .padding(14.dp)
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        com.agentphone.ui.components.PressableButton(
                            label = "Send text",
                            onClick = {
                                if (quickReply.isNotBlank()) {
                                    onSendText(quickReply.trim())
                                    status = "Text fallback sent."
                                }
                            },
                            modifier = Modifier.weight(1f)
                        )
                        com.agentphone.ui.components.PressableButton(
                            label = "Dismiss",
                            variant = com.agentphone.ui.components.ButtonVariant.Outline,
                            onClick = { showReply = false },
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BigCallButton(
    icon: ImageVector,
    label: String,
    color: Color,
    onClick: () -> Unit,
    size: androidx.compose.ui.unit.Dp = 72.dp,
    pulse: Boolean = false
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val pressScale by animateFloatAsState(if (pressed) 0.92f else 1f, Motion.springSnappy(), label = "press")
    val transition = rememberInfiniteTransition(label = "pulse")
    val pulseScale by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (pulse) 1.08f else 1f,
        animationSpec = infiniteRepeatable(tween(1400), repeatMode = RepeatMode.Reverse),
        label = "pulse-scale"
    )
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(size)
                .scale(pressScale * pulseScale)
                .clip(CircleShape)
                .background(color)
                .clickable(interactionSource = interaction, indication = null, onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, contentDescription = label, tint = Palette.OnAccent, modifier = Modifier.size(size * 0.4f))
        }
        Spacer(Modifier.height(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = Palette.OnAccent)
    }
}

