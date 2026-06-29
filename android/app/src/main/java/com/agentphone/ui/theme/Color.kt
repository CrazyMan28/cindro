package com.agentphone.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// 2026 cyberpunk / Jarvis HUD palette. Field names are kept identical to the
// previous theme on purpose: every screen reads these (and MaterialTheme +
// LocalSemanticColors derive from them), so recoloring here re-skins the whole
// app — neon cyan as the primary accent, magenta/violet flourishes, deep black.
object Palette {
    val Black = Color(0xFF04050A)
    val Surface = Color(0xFF0A0E18)
    val SurfaceElevated = Color(0xFF111A2B)
    val SurfaceSunken = Color(0xFF06080F)
    val Hairline = Color(0xFF16324A)
    val HairlineStrong = Color(0xFF1F4A6B)

    val TextPrimary = Color(0xFFEAF7FF)
    val TextSecondary = Color(0xFF92B6CC)
    val TextMuted = Color(0xFF5C7488)
    val TextDisabled = Color(0xFF38485A)
    val OnAccent = Color(0xFFFFFFFF)
    val Ink = Color(0xFF021019) // dark text/icon on top of bright neon fills

    // Primary accent — neon cyan (kept the name "Indigo" so all call sites cascade).
    val Indigo = Color(0xFF00E5FF)
    val IndigoDim = Color(0xFF0B4C5E)
    val IndigoGlow = Color(0x3300E5FF)

    // Secondary — neon aqua/teal, used for "online".
    val Teal = Color(0xFF2BF5DE)
    val TealDim = Color(0xFF124E48)

    // Tertiary / warning — neon amber.
    val Amber = Color(0xFFFFC04D)
    val AmberDim = Color(0xFF5E4420)

    // Danger — neon magenta-red.
    val Red = Color(0xFFFF3B6B)
    val RedDim = Color(0xFF5E1A2C)

    // Success — neon green.
    val Green = Color(0xFF2BFFA3)
    val GreenDim = Color(0xFF155E3E)

    // Pure cyberpunk magenta/violet for glows + accents.
    val Magenta = Color(0xFFFF3DE0)
    val Violet = Color(0xFFB14DFF)
    val MagentaGlow = Color(0x33FF3DE0)
}

@Immutable
data class SemanticColors(
    val online: Color = Palette.Teal,
    val onlineDim: Color = Palette.TealDim,
    val warning: Color = Palette.Amber,
    val warningDim: Color = Palette.AmberDim,
    val danger: Color = Palette.Red,
    val dangerDim: Color = Palette.RedDim,
    val success: Color = Palette.Green,
    val successDim: Color = Palette.GreenDim,
    val hairline: Color = Palette.Hairline,
    val hairlineStrong: Color = Palette.HairlineStrong,
    val surfaceSunken: Color = Palette.SurfaceSunken,
    val accentGlow: Color = Palette.IndigoGlow,
    val textMuted: Color = Palette.TextMuted,
    val textDisabled: Color = Palette.TextDisabled
)

val LocalSemanticColors = staticCompositionLocalOf { SemanticColors() }

val AgentPhoneColorScheme = darkColorScheme(
    primary = Palette.Indigo,
    onPrimary = Palette.OnAccent,
    primaryContainer = Palette.IndigoDim,
    onPrimaryContainer = Palette.TextPrimary,
    secondary = Palette.Teal,
    onSecondary = Palette.Black,
    secondaryContainer = Palette.TealDim,
    onSecondaryContainer = Palette.TextPrimary,
    tertiary = Palette.Amber,
    onTertiary = Palette.Black,
    background = Palette.Black,
    onBackground = Palette.TextPrimary,
    surface = Palette.Surface,
    onSurface = Palette.TextPrimary,
    surfaceVariant = Palette.SurfaceElevated,
    onSurfaceVariant = Palette.TextSecondary,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.SurfaceElevated,
    surfaceContainerHighest = Palette.SurfaceElevated,
    surfaceContainerLow = Palette.SurfaceSunken,
    surfaceContainerLowest = Palette.Black,
    outline = Palette.Hairline,
    outlineVariant = Palette.HairlineStrong,
    error = Palette.Red,
    onError = Palette.OnAccent,
    errorContainer = Palette.RedDim,
    onErrorContainer = Palette.TextPrimary,
    scrim = Color(0xCC000000)
)
