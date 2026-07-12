package com.jarvis.app.data

import android.content.Context

/**
 * Local voice preferences (not secret): "Hey Orin" wake on/off, spoken read-back of
 * assistant replies on/off, and the Mistral Voxtral TTS voice id to request. STT/TTS
 * themselves are daemon-proxied (the Mistral key never leaves the laptop).
 */
class VoiceSettings(context: Context) {

    private val prefs = context.getSharedPreferences("jarvis_voice", Context.MODE_PRIVATE)

    var wakeEnabled: Boolean
        get() = prefs.getBoolean(KEY_WAKE, false)
        set(value) = prefs.edit().putBoolean(KEY_WAKE, value).apply()

    /** Speak assistant replies aloud via voice.tts after each turn. Default OFF —
     *  the chat stays quiet unless the user explicitly turns "Speak replies" on. */
    var readBackEnabled: Boolean
        get() = prefs.getBoolean(KEY_READBACK, false)
        set(value) = prefs.edit().putBoolean(KEY_READBACK, value).apply()

    /** Mistral Voxtral TTS voice id (blank => daemon default). */
    var ttsVoice: String
        get() = prefs.getString(KEY_VOICE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_VOICE, value).apply()

    companion object {
        private const val KEY_WAKE = "wake_enabled"
        private const val KEY_READBACK = "readback_enabled"
        private const val KEY_VOICE = "tts_voice"
    }
}
