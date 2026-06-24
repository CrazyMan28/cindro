package com.jarvis.app.data

import android.content.Context

/**
 * Misc local app preferences (not secret, not daemon-backed). Currently just the
 * chat haptics toggle (ChatGPT-style send/stream/complete feedback), default ON.
 */
class AppPrefs(context: Context) {

    private val prefs = context.getSharedPreferences("jarvis_app", Context.MODE_PRIVATE)

    /** Subtle haptic feedback in chat (send tick, streaming micro-ticks, completion). */
    var hapticsEnabled: Boolean
        get() = prefs.getBoolean(KEY_HAPTICS, true)
        set(value) = prefs.edit().putBoolean(KEY_HAPTICS, value).apply()

    /**
     * Gate the phone app itself behind BiometricPrompt on launch (default ON). Part
     * of the 2FA + fingerprint cross-device unlock feature: the second factor for
     * approving a desktop sign-in is a fresh BiometricPrompt, and the app-open gate
     * keeps the paired-device session itself behind the fingerprint.
     */
    var fingerprintGateEnabled: Boolean
        get() = prefs.getBoolean(KEY_FINGERPRINT_GATE, true)
        set(value) = prefs.edit().putBoolean(KEY_FINGERPRINT_GATE, value).apply()

    companion object {
        private const val KEY_HAPTICS = "haptics_enabled"
        private const val KEY_FINGERPRINT_GATE = "fingerprint_gate_enabled"
    }
}
