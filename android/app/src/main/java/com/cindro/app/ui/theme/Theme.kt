package com.cindro.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

private val JarvisDarkColors = darkColorScheme(
    primary = JarvisPalette.Accent,
    onPrimary = JarvisPalette.OnAccent,
    primaryContainer = JarvisPalette.AccentDim,
    onPrimaryContainer = JarvisPalette.TextPrimary,
    secondary = JarvisPalette.AccentDim,
    onSecondary = JarvisPalette.TextPrimary,
    background = JarvisPalette.Background,
    onBackground = JarvisPalette.TextPrimary,
    surface = JarvisPalette.Surface,
    onSurface = JarvisPalette.TextPrimary,
    surfaceVariant = JarvisPalette.SurfaceVariant,
    onSurfaceVariant = JarvisPalette.TextSecondary,
    outline = JarvisPalette.Outline,
    error = JarvisPalette.Error,
)

/**
 * Premium, first-party-app typography: a clean sans (Roboto) across headings, titles
 * and body — NOT the old monospace-everything, which read like a terminal. Monospace
 * is now reserved for genuine code/data (chat code blocks, the widget DSL), not chrome.
 * Tighter tracking + a fuller weight range give the "Google-grade" feel.
 */
private val Sans = FontFamily.SansSerif

private val JarvisTypography = Typography(
    headlineLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Bold, fontSize = 30.sp, letterSpacing = (-0.4).sp, lineHeight = 36.sp),
    headlineMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Bold, fontSize = 24.sp, letterSpacing = (-0.2).sp, lineHeight = 30.sp),
    headlineSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, letterSpacing = 0.sp, lineHeight = 26.sp),
    titleLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, letterSpacing = 0.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, letterSpacing = 0.1.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 14.sp, letterSpacing = 0.1.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 0.4.sp),
    labelMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.4.sp),
    labelSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 10.sp, letterSpacing = 0.5.sp),
    bodyLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
)

/**
 * Dark-only Material 3 theme. The [darkTheme] flag is accepted for API symmetry but the
 * app intentionally renders the dark scheme regardless of the system setting.
 */
@Composable
fun JarvisTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = JarvisPalette.Background.toArgb()
            window.navigationBarColor = JarvisPalette.Background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
        }
    }

    MaterialTheme(
        colorScheme = JarvisDarkColors,
        typography = JarvisTypography,
        content = content,
    )
}
