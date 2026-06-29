package com.agentphone.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun Stepper(
    totalSteps: Int,
    currentStep: Int,
    modifier: Modifier = Modifier
) {
    val semantic = LocalSemanticColors.current
    Row(
        modifier = modifier.fillMaxWidth().height(8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        for (i in 0 until totalSteps) {
            val active = i == currentStep
            val completed = i < currentStep
            val color by animateColorAsState(
                when {
                    completed -> Palette.Indigo
                    active -> Palette.Indigo
                    else -> semantic.hairlineStrong
                },
                tween(300),
                label = "step-c"
            )
            val targetWidth = if (active) 28.dp else 8.dp
            val width by animateDpAsState(targetWidth, tween(350), label = "step-w")
            Box(
                modifier = Modifier
                    .size(width = width, height = 8.dp)
                    .clip(if (active || completed) RoundedCornerShape(50) else CircleShape)
                    .background(color)
            )
        }
    }
}
