package com.agentphone.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun LabeledField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    mono: Boolean = false,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    helper: String? = null,
    error: String? = null
) {
    val semantic = LocalSemanticColors.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val borderColor by animateColorAsState(
        when {
            error != null -> semantic.danger
            focused -> Palette.Indigo
            else -> semantic.hairline
        },
        tween(180),
        label = "border"
    )
    val shape = RoundedCornerShape(12.dp)
    val style = (if (mono) LocalMonoTypography.current.medium else LocalTextStyle.current)
        .copy(color = MaterialTheme.colorScheme.onSurface)

    Column(modifier = modifier) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = semantic.textMuted,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(MaterialTheme.colorScheme.surfaceContainerLow)
                .border(1.dp, borderColor, shape)
                .padding(horizontal = 14.dp, vertical = 14.dp)
        ) {
            if (value.isEmpty() && placeholder != null) {
                Text(
                    placeholder,
                    style = style,
                    color = semantic.textMuted
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(Palette.Indigo),
                interactionSource = interaction,
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType),
                modifier = Modifier.fillMaxWidth()
            )
        }
        val helperText = error ?: helper
        if (helperText != null) {
            Text(
                helperText,
                style = MaterialTheme.typography.bodySmall,
                color = if (error != null) semantic.danger else semantic.textMuted,
                modifier = Modifier.padding(start = 4.dp, top = 6.dp)
            )
        }
    }
}
