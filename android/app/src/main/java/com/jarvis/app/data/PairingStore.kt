package com.jarvis.app.data

import android.content.Context
import android.os.Build

/**
 * Non-secret pairing preferences: the daemon host:port, whether pairing has completed,
 * the pinned daemon public-key fingerprint, this device's human name, and the user's
 * notification preference. Signing-key material lives in [SecretStore], never here.
 */
class PairingStore(context: Context) {

    private val prefs = context.getSharedPreferences("jarvis_pairing", Context.MODE_PRIVATE)

    var hostPort: String?
        get() = prefs.getString(KEY_HOST_PORT, null)
        set(value) = prefs.edit().putString(KEY_HOST_PORT, value).apply()

    var isPaired: Boolean
        get() = prefs.getBoolean(KEY_PAIRED, false)
        set(value) = prefs.edit().putBoolean(KEY_PAIRED, value).apply()

    /** Pinned daemon ed25519 public-key fingerprint from the pairing payload (advisory). */
    var daemonFingerprint: String?
        get() = prefs.getString(KEY_FP, null)
        set(value) = prefs.edit().putString(KEY_FP, value).apply()

    /** Human label this device advertises in the `hello` frame. */
    var deviceName: String
        get() = prefs.getString(KEY_NAME, null) ?: defaultDeviceName()
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIFS, true)
        set(value) = prefs.edit().putBoolean(KEY_NOTIFS, value).apply()

    fun clearPairing() {
        prefs.edit()
            .putBoolean(KEY_PAIRED, false)
            .remove(KEY_FP)
            .apply()
    }

    private fun defaultDeviceName(): String {
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return model.ifBlank { "Android phone" }
    }

    companion object {
        private const val KEY_HOST_PORT = "host_port"
        private const val KEY_PAIRED = "paired"
        private const val KEY_FP = "daemon_fp"
        private const val KEY_NAME = "device_name"
        private const val KEY_NOTIFS = "notifications_enabled"

        /**
         * Default device-WebSocket endpoint (Contract C, port 8796) on the laptop's
         * Tailscale address. The user can override it in the pairing screen.
         */
        const val DEFAULT_HOST_PORT = "100.114.201.41:8796"
    }
}
