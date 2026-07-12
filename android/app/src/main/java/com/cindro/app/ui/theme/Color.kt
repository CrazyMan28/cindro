package com.cindro.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Jarvis palette — the "premium UI concept" system. Deep near-black canvas, soft
 * elevated surfaces, a cyan→blue accent gradient, and a small set of status hues.
 * Dark-only.
 */
internal object JarvisPalette {
    val Background = Color(0xFF070A10)
    val BackgroundElevated = Color(0xFF0B1018)
    val Surface = Color(0xFF121A24)
    val SurfaceVariant = Color(0xFF172230)
    val Outline = Color(0xFF22303F)

    val Accent = Color(0xFF3DD6FF)
    val Accent2 = Color(0xFF5B8CFF)   // gradient end (cyan → blue)
    val AccentDim = Color(0xFF1E6E86)
    val OnAccent = Color(0xFF052230)

    val TextPrimary = Color(0xFFEAF2F8)
    val TextSecondary = Color(0xFF93A7B8)
    val TextFaint = Color(0xFF5E7286)

    val Error = Color(0xFFFF6B6B)
    val Success = Color(0xFF39E6A0)
    val Warning = Color(0xFFFFB454)
    val Violet = Color(0xFFB28BFF)
    val Pink = Color(0xFFFF7AC6)
}
