package com.cindro.app.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** A small status pill (CONNECTED / OFFLINE / …) with a colored dot. */
@Composable
fun StatusPill(text: String, color: Color) {
    Surface(
        shape = CircleShape,
        color = color.copy(alpha = 0.14f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.5f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color),
            )
            Text(
                text = text,
                modifier = Modifier.padding(start = 7.dp),
                style = MaterialTheme.typography.labelLarge,
                color = color,
            )
        }
    }
}

/** A subtle elevated card used across list/chat surfaces. */
@Composable
fun GlowCard(
    modifier: Modifier = Modifier,
    accent: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(16.dp),
    content: @Composable () -> Unit,
) {
    val border = if (accent) JarvisPalette.Accent.copy(alpha = 0.55f) else JarvisPalette.Outline
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        color = JarvisPalette.Surface,
        border = BorderStroke(1.dp, border),
    ) {
        Box(Modifier.padding(contentPadding)) { content() }
    }
}
