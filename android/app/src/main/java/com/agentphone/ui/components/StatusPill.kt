package com.agentphone.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.state.ConnectionStatus

@Composable
fun StatusPill(status: ConnectionStatus, modifier: Modifier = Modifier) {
    val semantic = LocalSemanticColors.current
    val (label, color) = when (status) {
        ConnectionStatus.ONLINE -> "ONLINE" to semantic.online
        ConnectionStatus.CONNECTING, ConnectionStatus.AUTHENTICATING -> "CONNECTING" to semantic.warning
        ConnectionStatus.RECONNECTING -> "RECONNECTING" to semantic.warning
        ConnectionStatus.ERROR -> "ERROR" to semantic.danger
        ConnectionStatus.DISCONNECTED -> "OFFLINE" to semantic.textMuted
    }
    val animatedColor by animateColorAsState(color, tween(300), label = "pill-color")
    val pulsing = status == ConnectionStatus.CONNECTING ||
        status == ConnectionStatus.AUTHENTICATING ||
        status == ConnectionStatus.RECONNECTING

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(animatedColor.copy(alpha = 0.12f))
            .border(1.dp, animatedColor.copy(alpha = 0.35f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        PulsingDot(color = animatedColor, pulsing = pulsing)
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = animatedColor
        )
    }
}

@Composable
fun PulsingDot(color: Color, pulsing: Boolean) {
    val transition = rememberInfiniteTransition(label = "dot")
    val a by transition.animateFloat(
        initialValue = if (pulsing) 0.35f else 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900), repeatMode = RepeatMode.Reverse),
        label = "dot-a"
    )
    Box(
        modifier = Modifier
            .size(7.dp)
            .alpha(if (pulsing) a else 1f)
            .clip(CircleShape)
            .background(color)
    )
}
