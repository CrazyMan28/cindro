package com.jarvis.app.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** The cyan→blue accent gradient used on FABs, send buttons, the nav indicator. */
val AccentGradient = Brush.linearGradient(
    listOf(JarvisPalette.Accent, JarvisPalette.Accent2),
)

/** A brain-tinted rounded-square avatar with a single initial. */
@Composable
fun Avatar(letter: String, tint: Color, size: Int = 46) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size / 3).dp))
            .background(tint.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            letter.take(1).uppercase(),
            color = tint,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** A colored dot + label, e.g. "● Working" / "● Idle". */
@Composable
fun StatusDot(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(5.dp))
        Text(
            label.replaceFirstChar(Char::uppercase),
            style = MaterialTheme.typography.labelMedium,
            color = color,
        )
    }
}

/** A section header row: bold title + optional trailing action link. */
@Composable
fun SectionHeader(title: String, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold, color = JarvisPalette.TextPrimary)
        if (action != null) {
            Text(
                action,
                style = MaterialTheme.typography.labelLarge,
                color = JarvisPalette.Accent,
                modifier = Modifier.clip(RoundedCornerShape(8.dp))
                    .let { m -> if (onAction != null) m.clickable { onAction() } else m }
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
    }
}

/** A quick-action tile: tinted icon chip + label, in a soft card. */
@Composable
fun QuickTile(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = JarvisPalette.Surface,
        border = BorderStroke(1.dp, JarvisPalette.Outline),
        onClick = onClick,
    ) {
        Row(
            Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(32.dp).clip(RoundedCornerShape(10.dp))
                    .background(tint.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Text(label, style = MaterialTheme.typography.titleSmall,
                color = JarvisPalette.TextPrimary, maxLines = 1)
        }
    }
}

/** A small "📌 Pin to home" chip used on canvas/widget cards. */
@Composable
fun PinChip(text: String = "Pin to home", onClick: () -> Unit) {
    Surface(
        shape = CircleShape,
        color = JarvisPalette.Accent.copy(alpha = 0.13f),
        border = BorderStroke(1.dp, JarvisPalette.Accent.copy(alpha = 0.45f)),
        onClick = onClick,
    ) {
        Row(
            Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("📌", style = MaterialTheme.typography.labelMedium)
            Spacer(Modifier.width(5.dp))
            Text(text, color = JarvisPalette.Accent, style = MaterialTheme.typography.labelMedium)
        }
    }
}
