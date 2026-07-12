package com.cindro.app.ui.util

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import com.cindro.app.ui.theme.JarvisPalette

/**
 * The arc-reactor orb — two counter-rotating rings + a breathing core. Shared so
 * the chat empty-state, the Home header, and anywhere else show the same spinning
 * Jarvis mark.
 */
@Composable
fun JarvisOrb(size: Dp) {
    val t = rememberInfiniteTransition(label = "orb")
    val spin by t.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(9000, easing = LinearEasing)),
        label = "spin",
    )
    val spin2 by t.animateFloat(
        360f, 0f,
        infiniteRepeatable(tween(6000, easing = LinearEasing)),
        label = "spin2",
    )
    val pulse by t.animateFloat(
        0.85f, 1.12f,
        infiniteRepeatable(tween(1600, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse",
    )
    Canvas(modifier = Modifier.size(size)) {
        val c = Offset(this.size.width / 2f, this.size.height / 2f)
        val r = this.size.minDimension / 2f
        val accent = JarvisPalette.Accent
        drawCircle(accent.copy(alpha = 0.10f), radius = r * 0.95f * pulse, center = c)
        rotate(spin, pivot = c) {
            for (i in 0 until 8) {
                drawArc(
                    color = accent.copy(alpha = 0.8f),
                    startAngle = i * 45f + 6f, sweepAngle = 28f, useCenter = false,
                    topLeft = Offset(c.x - r * 0.88f, c.y - r * 0.88f),
                    size = Size(r * 1.76f, r * 1.76f),
                    style = Stroke(width = 3f),
                )
            }
        }
        rotate(spin2, pivot = c) {
            for (i in 0 until 3) {
                drawArc(
                    color = JarvisPalette.Accent2.copy(alpha = 0.85f),
                    startAngle = i * 120f, sweepAngle = 70f, useCenter = false,
                    topLeft = Offset(c.x - r * 0.55f, c.y - r * 0.55f),
                    size = Size(r * 1.10f, r * 1.10f),
                    style = Stroke(width = 2.5f),
                )
            }
        }
        drawCircle(accent.copy(alpha = 0.25f), radius = r * 0.30f * pulse, center = c)
        drawCircle(accent, radius = r * 0.13f * pulse, center = c)
    }
}
