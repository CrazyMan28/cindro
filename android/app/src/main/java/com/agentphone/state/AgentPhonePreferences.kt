package com.agentphone.state

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import com.agentphone.service.BootCompletedReceiver
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class AlwaysOnDiagnostics(
    val alwaysOnEnabled: Boolean,
    val notificationPermissionGranted: Boolean,
    val fullScreenPermissionGranted: Boolean,
    val batteryOptimizationIgnored: Boolean,
    val startOnBootEnabled: Boolean,
    val backgroundServiceRunning: Boolean,
    val webSocketState: String,
    val lastBootReceiverTriggered: String,
    val lastReconnectReason: String,
    val lastIncomingCallReceived: String
)

object AgentPhonePreferences {
    private const val PREFS_NAME = "agent-phone"
    private const val KEY_SERVER_URL = "serverUrl"
    private const val KEY_TOKEN = "token"
    private const val KEY_EXTENSION = "extension"
    private const val KEY_AUDIO_FORMAT = "audioFormat"
    private const val KEY_PUSH_TO_TALK = "pushToTalkEnabled"
    private const val KEY_ALWAYS_ON = "alwaysOnEnabled"
    private const val KEY_SERVICE_RUNNING = "serviceRunning"
    private const val KEY_WEBSOCKET_STATE = "backgroundWebSocketState"
    private const val KEY_BOOT_LAST_ACTION = "bootLastAction"
    private const val KEY_BOOT_LAST_MS = "bootLastMs"
    private const val KEY_RECONNECT_REASON = "lastReconnectReason"
    private const val KEY_INCOMING_SUMMARY = "lastIncomingCallSummary"
    private const val KEY_INCOMING_MS = "lastIncomingCallMs"
    private const val KEY_PENDING_THREAD_DELETES = "pendingThreadDeletes"

    // --- Relay PUCK mode (separate rooted M507 acting as a Bluetooth HFP-HF
    // relay between the user's real phone and the server's /relay/media socket).
    // All additive; when KEY_PUCK_MODE is false the app behaves exactly as before.
    private const val KEY_PUCK_MODE = "puckModeEnabled"
    private const val KEY_PAIRED_PHONE_MAC = "puckPairedPhoneMac"
    private const val KEY_PUCK_CAPTURE_SOURCE = "puckCaptureSource"
    private const val KEY_PUCK_INJECT_STREAM = "puckInjectStream"
    private const val KEY_PUCK_STATUS = "puckStatusLine"

    /**
     * Default capture source: VOICE_COMMUNICATION (MediaRecorder.AudioSource.VOICE_COMMUNICATION = 7).
     * Needs no special permission and is the safest first guess for the far-end
     * caller's audio over an SCO link. The live spike can change it via the probe.
     */
    const val DEFAULT_CAPTURE_SOURCE = 7 // MediaRecorder.AudioSource.VOICE_COMMUNICATION
    /**
     * Default inject stream: AudioManager.STREAM_VOICE_CALL (0). Paired with
     * AudioAttributes.USAGE_VOICE_COMMUNICATION on the AudioTrack so the agent's
     * TTS rides the call uplink.
     */
    const val DEFAULT_INJECT_STREAM = 0 // AudioManager.STREAM_VOICE_CALL

    fun isPuckModeEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_PUCK_MODE, false)

    fun setPuckMode(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_PUCK_MODE, enabled).apply()
    }

    fun pairedPhoneMac(context: Context): String = prefs(context).getString(KEY_PAIRED_PHONE_MAC, "") ?: ""

    fun setPairedPhoneMac(context: Context, mac: String) {
        prefs(context).edit().putString(KEY_PAIRED_PHONE_MAC, mac.trim().uppercase()).apply()
    }

    fun captureSource(context: Context): Int = prefs(context).getInt(KEY_PUCK_CAPTURE_SOURCE, DEFAULT_CAPTURE_SOURCE)

    fun setCaptureSource(context: Context, source: Int) {
        prefs(context).edit().putInt(KEY_PUCK_CAPTURE_SOURCE, source).apply()
    }

    fun injectStream(context: Context): Int = prefs(context).getInt(KEY_PUCK_INJECT_STREAM, DEFAULT_INJECT_STREAM)

    fun setInjectStream(context: Context, stream: Int) {
        prefs(context).edit().putInt(KEY_PUCK_INJECT_STREAM, stream).apply()
    }

    /** Human-readable status line the puck service writes and the settings card reads. */
    fun puckStatus(context: Context): String = prefs(context).getString(KEY_PUCK_STATUS, "Idle") ?: "Idle"

    fun setPuckStatus(context: Context, status: String) {
        prefs(context).edit().putString(KEY_PUCK_STATUS, status).apply()
    }

    /** Thread deletions the server hasn't confirmed yet — retried until 2xx/404
     *  so a flaky request can't make a "deleted" conversation reappear. */
    fun pendingThreadDeletes(context: Context): Set<String> =
        prefs(context).getStringSet(KEY_PENDING_THREAD_DELETES, emptySet()) ?: emptySet()

    fun addPendingThreadDelete(context: Context, threadId: String) {
        val next = pendingThreadDeletes(context).toMutableSet().apply { add(threadId) }
        prefs(context).edit().putStringSet(KEY_PENDING_THREAD_DELETES, next).apply()
    }

    fun removePendingThreadDelete(context: Context, threadId: String) {
        val next = pendingThreadDeletes(context).toMutableSet().apply { remove(threadId) }
        prefs(context).edit().putStringSet(KEY_PENDING_THREAD_DELETES, next).apply()
    }

    fun loadSettings(context: Context): AgentPhoneSettings {
        migrateLegacyPrefs(context)
        val prefs = prefs(context)
        return AgentPhoneSettings(
            prefs.getString(KEY_SERVER_URL, "http://100.114.201.41:8801") ?: "http://100.114.201.41:8801",
            prefs.getString(KEY_TOKEN, "change-me-device-token") ?: "change-me-device-token",
            prefs.getString(KEY_EXTENSION, "100") ?: "100",
            prefs.getString(KEY_AUDIO_FORMAT, "pcm_s16le") ?: "pcm_s16le",
            prefs.getBoolean(KEY_PUSH_TO_TALK, true)
        )
    }

    fun saveSettings(context: Context, settings: AgentPhoneSettings) {
        prefs(context)
            .edit()
            .putString(KEY_SERVER_URL, settings.serverUrl)
            .putString(KEY_TOKEN, settings.token)
            .putString(KEY_EXTENSION, settings.extension)
            .putString(KEY_AUDIO_FORMAT, settings.audioFormat)
            .putBoolean(KEY_PUSH_TO_TALK, settings.pushToTalkEnabled)
            .apply()
    }

    // Default ON so the background receiver runs and calls/texts arrive 24/7,
    // even when the app is closed.
    fun isAlwaysOnEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ALWAYS_ON, true)

    fun setAlwaysOnEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ALWAYS_ON, enabled).apply()
        setBootReceiverEnabled(context, enabled)
    }

    fun markServiceRunning(context: Context, running: Boolean, webSocketState: String? = null) {
        val edit = prefs(context).edit().putBoolean(KEY_SERVICE_RUNNING, running)
        if (webSocketState != null) edit.putString(KEY_WEBSOCKET_STATE, webSocketState)
        edit.apply()
    }

    fun recordWebSocketState(context: Context, state: String) {
        prefs(context).edit().putString(KEY_WEBSOCKET_STATE, state).apply()
    }

    fun recordBootTriggered(context: Context, action: String) {
        prefs(context)
            .edit()
            .putString(KEY_BOOT_LAST_ACTION, action)
            .putLong(KEY_BOOT_LAST_MS, System.currentTimeMillis())
            .apply()
    }

    fun recordReconnectReason(context: Context, reason: String) {
        prefs(context).edit().putString(KEY_RECONNECT_REASON, reason).apply()
    }

    fun recordIncomingCall(context: Context, summary: String) {
        prefs(context)
            .edit()
            .putString(KEY_INCOMING_SUMMARY, summary)
            .putLong(KEY_INCOMING_MS, System.currentTimeMillis())
            .apply()
    }

    fun loadDiagnostics(context: Context): AlwaysOnDiagnostics {
        val prefs = prefs(context)
        return AlwaysOnDiagnostics(
            alwaysOnEnabled = prefs.getBoolean(KEY_ALWAYS_ON, true),
            notificationPermissionGranted = hasNotificationPermission(context),
            fullScreenPermissionGranted = canUseFullScreenIntent(context),
            batteryOptimizationIgnored = isIgnoringBatteryOptimizations(context),
            startOnBootEnabled = isBootReceiverEnabled(context),
            backgroundServiceRunning = prefs.getBoolean(KEY_SERVICE_RUNNING, false),
            webSocketState = prefs.getString(KEY_WEBSOCKET_STATE, "DISCONNECTED") ?: "DISCONNECTED",
            lastBootReceiverTriggered = formatEvent(
                prefs.getString(KEY_BOOT_LAST_ACTION, "") ?: "",
                prefs.getLong(KEY_BOOT_LAST_MS, 0L)
            ),
            lastReconnectReason = prefs.getString(KEY_RECONNECT_REASON, "") ?: "",
            lastIncomingCallReceived = formatEvent(
                prefs.getString(KEY_INCOMING_SUMMARY, "") ?: "",
                prefs.getLong(KEY_INCOMING_MS, 0L)
            )
        )
    }

    fun hasNotificationPermission(context: Context): Boolean {
        return Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    fun canUseFullScreenIntent(context: Context): Boolean {
        return Build.VERSION.SDK_INT < 34 ||
            context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    }

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val powerManager = context.getSystemService(PowerManager::class.java)
        return powerManager?.isIgnoringBatteryOptimizations(context.packageName) == true
    }

    private fun prefs(context: Context) = protectedContext(context).getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun protectedContext(context: Context): Context {
        return if (Build.VERSION.SDK_INT >= 24) context.createDeviceProtectedStorageContext() else context
    }

    private fun migrateLegacyPrefs(context: Context) {
        if (Build.VERSION.SDK_INT < 24) return
        val deviceContext = context.createDeviceProtectedStorageContext()
        deviceContext.moveSharedPreferencesFrom(context, PREFS_NAME)
    }

    private fun setBootReceiverEnabled(context: Context, enabled: Boolean) {
        val state = if (enabled) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
        context.packageManager.setComponentEnabledSetting(
            ComponentName(context, BootCompletedReceiver::class.java),
            state,
            PackageManager.DONT_KILL_APP
        )
    }

    private fun isBootReceiverEnabled(context: Context): Boolean {
        val component = ComponentName(context, BootCompletedReceiver::class.java)
        val state = context.packageManager.getComponentEnabledSetting(component)
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED ||
            state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
    }

    private fun formatEvent(label: String, timestampMs: Long): String {
        if (label.isBlank() || timestampMs <= 0L) return "never"
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(timestampMs))
        return "$label at $time"
    }
}
