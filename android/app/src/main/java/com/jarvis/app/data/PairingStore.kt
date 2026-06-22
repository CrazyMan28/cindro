package com.jarvis.app.data

import android.content.Context

/**
 * Non-secret pairing preferences: the last host:port the user entered and whether a pairing
 * has been completed. The bearer token itself lives in [SecretStore], never here.
 */
class PairingStore(context: Context) {

    private val prefs = context.getSharedPreferences("jarvis_pairing", Context.MODE_PRIVATE)

    var hostPort: String?
        get() = prefs.getString(KEY_HOST_PORT, null)
        set(value) = prefs.edit().putString(KEY_HOST_PORT, value).apply()

    var isPaired: Boolean
        get() = prefs.getBoolean(KEY_PAIRED, false)
        set(value) = prefs.edit().putBoolean(KEY_PAIRED, value).apply()

    companion object {
        private const val KEY_HOST_PORT = "host_port"
        private const val KEY_PAIRED = "paired"

        /**
         * Default device-WebSocket endpoint (Contract C, port 8796) on the laptop's
         * Tailscale address. The user can override it in the pairing screen.
         */
        const val DEFAULT_HOST_PORT = "127.0.0.1:8796"
    }
}
