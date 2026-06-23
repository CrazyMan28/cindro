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

    companion object {
        private const val KEY_HAPTICS = "haptics_enabled"
    }
}
