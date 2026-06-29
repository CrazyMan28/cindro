package com.agentphone.ui.call

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentphone.ui.theme.Palette

@Composable
internal fun CallerAvatar(initial: String, pulsing: Boolean) {
    val transition = rememberInfiniteTransition(label = "halo")
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (pulsing) 1.25f else 1f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing), repeatMode = RepeatMode.Reverse),
        label = "scale"
    )
    val alpha by transition.animateFloat(
        initialValue = 0.55f,
        targetValue = if (pulsing) 0.15f else 0.4f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing), repeatMode = RepeatMode.Reverse),
        label = "alpha"
    )

    Box(
        modifier = Modifier.size(196.dp),
        contentAlignment = Alignment.Center
    ) {
        // Outer magenta halo — the wide cyberpunk glow.
        Box(
            modifier = Modifier
                .size(196.dp)
                .scale(scale)
                .alpha(alpha * 0.7f)
                .clip(CircleShape)
                .background(Palette.Magenta.copy(alpha = 0.45f))
        )
        // Inner cyan halo, counter-pulse (using 1-alpha keeps the two out of phase).
        Box(
            modifier = Modifier
                .size(168.dp)
                .scale(2f - scale)
                .alpha(0.7f - alpha)
                .clip(CircleShape)
                .background(Palette.Indigo.copy(alpha = 0.55f))
        )
        // Arc-reactor core: gradient fill + a bright neon ring.
        Box(
            modifier = Modifier
                .size(140.dp)
                .clip(CircleShape)
                .background(Brush.linearGradient(listOf(Palette.Indigo, Palette.IndigoDim)))
                .border(BorderStroke(2.dp, Brush.sweepGradient(listOf(Palette.Indigo, Palette.Magenta, Palette.Violet, Palette.Indigo))), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Text(initial, color = Palette.OnAccent, style = MaterialTheme.typography.displayLarge.copy(fontSize = 56.sp))
        }
    }
}

internal fun formatTimer(seconds: Long): String {
    val m = seconds / 60
    val s = seconds % 60
    return "%02d:%02d".format(m, s)
}
