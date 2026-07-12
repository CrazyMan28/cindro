package com.cindro.app.ui.util

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Subtle ChatGPT-style haptic feedback for the chat surface.
 *
 * - [send]: a light tick when the user fires a turn.
 * - [streamTick]: a very soft micro-vibration emitted WHILE a reply streams in.
 *   Self-throttled (see [STREAM_MIN_GAP_MS]) so per-chunk / per-character callers
 *   can call it freely without machine-gunning the motor.
 * - [complete]: a slightly stronger tick when the reply finishes.
 *
 * All effects are no-ops when haptics are disabled (the caller passes `enabled`)
 * or when the device has no vibrator. Amplitude control degrades gracefully on
 * pre-API-26 / non-amplitude hardware.
 */
class Haptics(context: Context) {

    private val vibrator: Vibrator? = run {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val mgr = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            mgr?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }?.takeIf { it.hasVibrator() }

    private val hasAmplitude = vibrator?.hasAmplitudeControl() == true

    @Volatile private var lastStreamTickAt = 0L
    @Volatile private var lastTapAt = 0L

    /** Light tick on send. */
    fun send(enabled: Boolean) {
        if (!enabled) return
        vibrate(durationMs = 12, amplitude = 90)
    }

    /**
     * Crisp tick on ANY button / control tap, app-wide (via [hapticClickable] /
     * the LocalHaptics wrapper). Lightly throttled so a double-fire (e.g. ripple +
     * onClick) doesn't double-buzz.
     */
    fun tap(enabled: Boolean) {
        if (!enabled) return
        val now = SystemClock.uptimeMillis()
        if (now - lastTapAt < TAP_MIN_GAP_MS) return
        lastTapAt = now
        vibrate(durationMs = 10, amplitude = 110)
    }

    /**
     * Gentle micro-vibration during streaming. Throttled internally to at most one
     * tick per [STREAM_MIN_GAP_MS] so it stays a soft "purr" rather than a buzz,
     * regardless of how often the streaming loop calls it.
     */
    fun streamTick(enabled: Boolean) {
        if (!enabled) return
        val now = SystemClock.uptimeMillis()
        if (now - lastStreamTickAt < STREAM_MIN_GAP_MS) return
        lastStreamTickAt = now
        vibrate(durationMs = 6, amplitude = 40)
    }

    /** Slightly stronger tick when the reply completes. */
    fun complete(enabled: Boolean) {
        if (!enabled) return
        vibrate(durationMs = 22, amplitude = 160)
    }

    private fun vibrate(durationMs: Long, amplitude: Int) {
        val v = vibrator ?: return
        runCatching {
            val effect = if (hasAmplitude) {
                VibrationEffect.createOneShot(durationMs, amplitude.coerceIn(1, 255))
            } else {
                VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
            }
            v.vibrate(effect)
        }
    }

    companion object {
        private const val STREAM_MIN_GAP_MS = 90L
        private const val TAP_MIN_GAP_MS = 40L
    }
}
