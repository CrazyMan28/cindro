package com.jarvis.app.ui.theme

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
 * Mono headings + sans body, echoing the desktop sidebar typography so the two surfaces
 * read as the same product.
 */
private val JarvisTypography = Typography(
    headlineLarge = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 28.sp, letterSpacing = 1.2.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, letterSpacing = 1.0.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, letterSpacing = 0.8.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 15.sp, letterSpacing = 0.6.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 13.sp, letterSpacing = 1.4.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 14.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 12.sp),
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
