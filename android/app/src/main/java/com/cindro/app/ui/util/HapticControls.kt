package com.cindro.app.ui.util

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.semantics.Role

/**
 * App-wide haptics for EVERY tap.
 *
 * A single [Haptics] instance + the live "haptics on?" flag are published through
 * [LocalHaptics] at the app root. Buttons use [HapticButton] / [HapticIconButton]
 * / [HapticOutlinedButton] (drop-in replacements for the Material3 ones) or the
 * [hapticClickable] modifier so a crisp tick fires on every press — not just
 * send/receive — while still honoring the Settings haptics toggle.
 */
class HapticController(
    val haptics: Haptics,
    /** Re-read each tap so the Settings toggle takes effect immediately. */
    val enabled: () -> Boolean,
) {
    fun tap() = haptics.tap(enabled())
}

/** Provided at the app root; defaults to a no-op so previews/tests don't crash. */
val LocalHaptics = compositionLocalOf<HapticController?> { null }

/**
 * Like [Modifier.clickable] but fires an app-wide haptic tick first. Use this for
 * any tappable surface that isn't a [HapticButton]/[HapticIconButton].
 */
fun Modifier.hapticClickable(
    enabled: Boolean = true,
    role: Role? = null,
    onClick: () -> Unit,
): Modifier = composed {
    val hc = LocalHaptics.current
    clickable(enabled = enabled, role = role) {
        hc?.tap()
        onClick()
    }
}

/** Fire a tick whenever the given [interactionSource] sees a press. Lets a stock
 *  control (e.g. an IconButton built elsewhere) gain tap haptics by sharing its
 *  interaction source. */
@Composable
fun HapticOnPress(interactionSource: MutableInteractionSource) {
    val hc = LocalHaptics.current ?: return
    LaunchedEffect(interactionSource) {
        interactionSource.interactions.collect { i ->
            if (i is PressInteraction.Press) hc.tap()
        }
    }
}

@Composable
fun HapticIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: IconButtonColors = IconButtonDefaults.iconButtonColors(),
    content: @Composable () -> Unit,
) {
    val hc = LocalHaptics.current
    IconButton(
        onClick = { hc?.tap(); onClick() },
        modifier = modifier,
        enabled = enabled,
        colors = colors,
        content = content,
    )
}

@Composable
fun HapticButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val hc = LocalHaptics.current
    Button(
        onClick = { hc?.tap(); onClick() },
        modifier = modifier,
        enabled = enabled,
        colors = colors,
        content = content,
    )
}

@Composable
fun HapticOutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    val hc = LocalHaptics.current
    OutlinedButton(
        onClick = { hc?.tap(); onClick() },
        modifier = modifier,
        enabled = enabled,
        content = content,
    )
}
