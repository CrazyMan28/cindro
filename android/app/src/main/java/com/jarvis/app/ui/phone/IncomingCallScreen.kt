package com.jarvis.app.ui.phone

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvis.app.ui.theme.JarvisPalette

/**
 * Full-screen incoming call overlay. Displayed whenever a ringing PhoneCall is
 * detected. Features a pulsing accent ring around the caller icon and Accept /
 * Decline FABs.
 */
@Composable
fun IncomingCallScreen(
    call: PhoneCall,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    // ── Infinite pulse animation ──────────────────────────────────────────
    val transition = rememberInfiniteTransition(label = "incomingPulse")
    val pulseScale by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1.30f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 850, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "scale",
    )
    val pulseAlpha by transition.animateFloat(
        initialValue = 0.45f,
        targetValue = 0.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 850, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "alpha",
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(JarvisPalette.Background),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            // ── Header label ─────────────────────────────────────────────
            Text(
                text = "INCOMING CALL",
                style = MaterialTheme.typography.labelLarge.copy(
                    letterSpacing = 4.sp,
                    fontWeight = FontWeight.Bold,
                ),
                color = JarvisPalette.Accent,
            )

            // ── Pulsing ring + phone icon ─────────────────────────────────
            Box(contentAlignment = Alignment.Center) {
                // Outer pulsing halo
                Box(
                    modifier = Modifier
                        .size(168.dp)
                        .scale(pulseScale)
                        .clip(CircleShape)
                        .background(JarvisPalette.Accent.copy(alpha = pulseAlpha)),
                )
                // Middle ring
                Box(
                    modifier = Modifier
                        .size(128.dp)
                        .clip(CircleShape)
                        .background(JarvisPalette.Accent.copy(alpha = 0.15f)),
                )
                // Inner icon circle
                Box(
                    modifier = Modifier
                        .size(96.dp)
                        .clip(CircleShape)
                        .background(JarvisPalette.AccentDim.copy(alpha = 0.55f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Phone,
                        contentDescription = null,
                        tint = JarvisPalette.Accent,
                        modifier = Modifier.size(46.dp),
                    )
                }
            }

            // ── Caller details ────────────────────────────────────────────
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "Ext ${call.fromExtension ?: "?"} → Ext ${call.toExtension ?: "100"}",
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = JarvisPalette.TextPrimary,
                )
                call.reason?.takeIf { it.isNotBlank() }?.let { reason ->
                    Text(
                        text = reason,
                        style = MaterialTheme.typography.bodyLarge,
                        color = JarvisPalette.TextSecondary,
                    )
                }
                call.urgency?.takeIf { it.isNotBlank() }?.let { urgency ->
                    val urgencyColor = when (urgency.lowercase()) {
                        "critical", "high" -> JarvisPalette.Error
                        "medium" -> JarvisPalette.Warning
                        else -> JarvisPalette.TextSecondary
                    }
                    Text(
                        text = "URGENCY: ${urgency.uppercase()}",
                        style = MaterialTheme.typography.labelLarge.copy(letterSpacing = 2.sp),
                        color = urgencyColor,
                    )
                }
            }

            // ── Accept / Decline ─────────────────────────────────────────
            Row(
                horizontalArrangement = Arrangement.spacedBy(56.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Decline
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FloatingActionButton(
                        onClick = onDecline,
                        containerColor = JarvisPalette.Error,
                        contentColor = Color.White,
                        modifier = Modifier.size(72.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.CallEnd,
                            contentDescription = "Decline",
                            modifier = Modifier.size(34.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Decline", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.Error)
                }

                // Accept
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FloatingActionButton(
                        onClick = onAccept,
                        containerColor = JarvisPalette.Success,
                        contentColor = Color.White,
                        modifier = Modifier.size(72.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Call,
                            contentDescription = "Accept",
                            modifier = Modifier.size(34.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Accept", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.Success)
                }
            }

            // ── Urgency warning footer ────────────────────────────────────
            val isUrgent = call.urgency?.lowercase().let { it == "critical" || it == "high" }
            if (isUrgent) {
                Text(
                    text = "⚠  Agent requires immediate attention",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.Warning,
                    modifier = Modifier.padding(horizontal = 32.dp),
                )
            }
        }
    }
}
