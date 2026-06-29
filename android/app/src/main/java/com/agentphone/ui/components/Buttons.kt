package com.agentphone.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Motion
import com.agentphone.ui.theme.Palette

enum class ButtonVariant { Primary, Tonal, Outline, Danger, Success, Ghost }

@Composable
fun PressableButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Primary,
    enabled: Boolean = true,
    loading: Boolean = false,
    leading: ImageVector? = null,
    fillWidth: Boolean = true
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.97f else 1f,
        animationSpec = Motion.springSnappy(),
        label = "btn-scale"
    )
    val semantic = LocalSemanticColors.current
    val shape = RoundedCornerShape(14.dp)

    val bg: Brush
    val fg: Color
    val border: BorderStroke?
    when (variant) {
        ButtonVariant.Primary -> {
            bg = Brush.verticalGradient(listOf(Palette.Indigo, Palette.IndigoDim))
            fg = Palette.OnAccent
            border = null
        }
        ButtonVariant.Tonal -> {
            bg = Brush.verticalGradient(listOf(MaterialTheme.colorScheme.surfaceContainerHigh, MaterialTheme.colorScheme.surface))
            fg = MaterialTheme.colorScheme.onSurface
            border = BorderStroke(1.dp, semantic.hairlineStrong)
        }
        ButtonVariant.Outline -> {
            bg = Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent))
            fg = MaterialTheme.colorScheme.onSurface
            border = BorderStroke(1.dp, semantic.hairlineStrong)
        }
        ButtonVariant.Danger -> {
            bg = Brush.verticalGradient(listOf(semantic.danger, semantic.dangerDim))
            fg = Palette.OnAccent
            border = null
        }
        ButtonVariant.Success -> {
            bg = Brush.verticalGradient(listOf(semantic.success, semantic.successDim))
            fg = Palette.OnAccent
            border = null
        }
        ButtonVariant.Ghost -> {
            bg = Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent))
            fg = MaterialTheme.colorScheme.onSurfaceVariant
            border = null
        }
    }

    val alpha = if (enabled) 1f else 0.45f

    Box(
        modifier = modifier
            .let { if (fillWidth) it.fillMaxWidth() else it }
            .height(52.dp)
            .scale(scale)
            .clip(shape)
            .background(bg)
            .let { if (border != null) it.border(border, shape) else it }
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled && !loading,
                onClick = onClick
            )
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center
    ) {
        CompositionLocalProvider(LocalContentColor provides fg.copy(alpha = alpha)) {
            if (loading) {
                CircularProgressIndicator(
                    color = fg.copy(alpha = alpha),
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(20.dp)
                )
            } else {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    if (leading != null) {
                        androidx.compose.material3.Icon(
                            imageVector = leading,
                            contentDescription = null,
                            tint = fg.copy(alpha = alpha)
                        )
                    }
                    Text(
                        label,
                        style = MaterialTheme.typography.titleMedium,
                        color = fg.copy(alpha = alpha)
                    )
                }
            }
        }
    }
}

@Composable
fun IconPill(
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    background: Color = MaterialTheme.colorScheme.surfaceContainerHigh
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, Motion.springSnappy(), label = "pill")
    Box(
        modifier = modifier
            .size(44.dp)
            .scale(scale)
            .clip(RoundedCornerShape(50))
            .background(background)
            .border(1.dp, LocalSemanticColors.current.hairline, RoundedCornerShape(50))
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        androidx.compose.material3.Icon(icon, contentDescription = null, tint = tint)
    }
}
