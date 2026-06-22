package com.jarvis.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.jarvis.app.net.DeviceClient
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.StatusPill

/** Maps the device-socket state to a labelled, colored status pill. */
@Composable
fun ConnectionPill(state: DeviceClient.State) {
    val (label, color: Color) = when (state) {
        DeviceClient.State.CONNECTED -> "ONLINE" to JarvisPalette.Success
        DeviceClient.State.CONNECTING -> "CONNECTING" to JarvisPalette.Accent
        DeviceClient.State.HANDSHAKING -> "HANDSHAKE" to JarvisPalette.Accent
        DeviceClient.State.ERROR -> "ERROR" to JarvisPalette.Error
        DeviceClient.State.DISCONNECTED -> "OFFLINE" to JarvisPalette.TextSecondary
    }
    StatusPill(text = label, color = color)
}
