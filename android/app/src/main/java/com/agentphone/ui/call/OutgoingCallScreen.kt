package com.agentphone.ui.call

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
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
import com.agentphone.state.OutgoingCallBridge
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Motion
import com.agentphone.ui.theme.Palette
import kotlinx.coroutines.delay

@Composable
fun OutgoingCallScreen(
    callId: String,
    toExtension: String,
    onEnd: () -> Unit,
    onAudioStart: () -> Boolean,
    onMuteChanged: (Boolean) -> Unit
) {
    var dialing by remember { mutableStateOf(callId.isBlank()) }
    var ringing by remember { mutableStateOf(!callId.isBlank()) }
    var active by remember { mutableStateOf(false) }
    var endedReason by remember { mutableStateOf<String?>(null) }
    var liveCallId by remember { mutableStateOf(callId) }
    var muted by remember { mutableStateOf(false) }
    var micError by remember { mutableStateOf<String?>(null) }
    val transcript = remember { mutableStateListOf<String>() }
    val startMs = remember { mutableLongStateOf(0L) }
    var elapsed by remember { mutableStateOf(0L) }

    DisposableEffect(callId) {
        val listener = object : OutgoingCallBridge.Listener {
            override fun onStateChanged(state: OutgoingCallBridge.State) {
                fun matches(id: String?): Boolean = id == null || liveCallId.isBlank() || id == liveCallId
                when (state) {
                    is OutgoingCallBridge.State.Dialing -> { dialing = true; ringing = false; active = false }
                    is OutgoingCallBridge.State.Ringing -> { dialing = false; ringing = true; active = false; liveCallId = state.callId }
                    is OutgoingCallBridge.State.Active -> { dialing = false; ringing = false; active = true; liveCallId = state.callId }
                    is OutgoingCallBridge.State.Ended -> if (matches(state.callId)) { endedReason = "Call ended" }
                    is OutgoingCallBridge.State.Failed -> if (matches(state.callId)) { endedReason = state.reason ?: "Call failed" }
                }
            }
            override fun onTranscriptAppended(line: String) {
                transcript.add(line)
                if (transcript.size > 200) transcript.removeAt(0)
            }
        }
        OutgoingCallBridge.subscribe(listener)
        onDispose { OutgoingCallBridge.unsubscribe(listener) }
    }

    LaunchedEffect(active) {
        if (active && startMs.longValue == 0L) {
            startMs.longValue = System.currentTimeMillis()
            while (true) {
                elapsed = (System.currentTimeMillis() - startMs.longValue) / 1000
                delay(1000)
            }
        }
    }

    LaunchedEffect(endedReason) {
        if (endedReason != null) {
            delay(1100)
            onEnd()
        }
    }

    // Hands-free: the moment the call connects, start continuous listening. No button.
    LaunchedEffect(active) {
        if (active) {
            val started = onAudioStart()
            micError = if (started) null else "Microphone unavailable — allow the mic permission, then try again"
        }
    }

    val semantic = LocalSemanticColors.current

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Palette.Black, Color(0xFF0E0F18), Palette.Black)
                )
            )
            .padding(horizontal = 24.dp, vertical = 48.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                "CALLING AGENT",
                style = MaterialTheme.typography.labelMedium,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(36.dp))
            CallerAvatar(initial = toExtension.firstOrNull()?.uppercase() ?: "A", pulsing = dialing || ringing)
            Spacer(Modifier.height(28.dp))
            Text(
                "Extension $toExtension",
                style = MaterialTheme.typography.displaySmall,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    endedReason != null -> endedReason!!
                    active -> "Connected"
                    dialing -> "Calling…"
                    else -> "Ringing…"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = semantic.textMuted
            )
            if (active) {
                Spacer(Modifier.height(20.dp))
                Text(
                    formatTimer(elapsed),
                    style = MaterialTheme.typography.headlineMedium.copy(fontSize = 22.sp, fontFamily = FontFamily.Monospace),
                    color = semantic.online
                )
            }

            Spacer(Modifier.height(22.dp))
            TranscriptPanel(transcript = transcript, modifier = Modifier.weight(1f))

            Spacer(Modifier.height(12.dp))
            Text(
                when {
                    micError != null -> micError!!
                    muted -> "Muted — tap Unmute to talk"
                    active -> "Listening — just talk, I'll reply when you pause"
                    else -> "Connecting…"
                },
                style = MaterialTheme.typography.bodySmall,
                color = when {
                    micError != null -> semantic.danger
                    muted -> semantic.warning
                    active -> semantic.online
                    else -> semantic.textMuted
                },
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                CircleAction(
                    icon = if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                    label = if (muted) "Unmute" else "Mute",
                    color = if (muted) semantic.warning else Palette.IndigoDim,
                    size = 72.dp,
                    onClick = {
                        muted = !muted
                        onMuteChanged(muted)
                    }
                )
                CircleAction(
                    icon = Icons.Rounded.CallEnd,
                    label = "End",
                    color = semantic.danger,
                    size = 80.dp,
                    onClick = onEnd
                )
            }
        }
    }
}

@Composable
private fun TranscriptPanel(transcript: SnapshotStateList<String>, modifier: Modifier = Modifier) {
    val semantic = LocalSemanticColors.current
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp, semantic.hairline, shape)
            .padding(14.dp)
    ) {
        if (transcript.isEmpty()) {
            Text("Transcript will appear here.", style = MaterialTheme.typography.bodySmall, color = semantic.textMuted)
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                transcript.takeLast(60).forEach { line ->
                    Text(
                        line,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                }
            }
        }
    }
}

@Composable
private fun CircleAction(
    icon: ImageVector,
    label: String,
    color: Color,
    onClick: () -> Unit,
    size: androidx.compose.ui.unit.Dp = 72.dp,
    active: Boolean = false
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // When latched "down" (active), keep it visibly pressed-in; otherwise spring on touch.
    val scale by animateFloatAsState(
        if (pressed) 0.92f else if (active) 0.94f else 1f,
        Motion.springSnappy(),
        label = "press"
    )
    // Pulsing halo so a latched (recording) button is unmistakably "on".
    val pulse = rememberInfiniteTransition(label = "latch")
    val ringAlpha by pulse.animateFloat(
        initialValue = 0.55f,
        targetValue = if (active) 0.12f else 0.55f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), repeatMode = RepeatMode.Reverse),
        label = "ringAlpha"
    )
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center) {
            if (active) {
                Box(
                    modifier = Modifier
                        .size(size + 16.dp)
                        .clip(CircleShape)
                        .background(color.copy(alpha = ringAlpha))
                )
            }
            Box(
                modifier = Modifier
                    .size(size)
                    .scale(scale)
                    .clip(CircleShape)
                    .background(color)
                    .then(if (active) Modifier.border(3.dp, Palette.OnAccent, CircleShape) else Modifier)
                    .clickable(interactionSource = interaction, indication = null, onClick = onClick),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = label, tint = Palette.OnAccent, modifier = Modifier.size(size * 0.4f))
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = Palette.OnAccent)
    }
}

