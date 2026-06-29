package com.agentphone

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.core.view.WindowCompat
import com.agentphone.puck.RelayPuckService
import com.agentphone.service.AgentPhoneForegroundService
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.ui.AppRoot
import com.agentphone.ui.theme.AgentPhoneTheme

class MainActivity : ComponentActivity() {

    private val openThreadId = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        requestRuntimePermissions()
        ensureAlwaysOnAndBattery()
        startPuckIfEnabled()
        openThreadId.value = intent.getStringExtra(EXTRA_OPEN_THREAD_ID)
        setContent {
            AgentPhoneTheme { AppRoot(openThreadId = openThreadId.value) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openThreadId.value = intent.getStringExtra(EXTRA_OPEN_THREAD_ID)
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        // Relay puck mode needs BLUETOOTH_CONNECT to drive the HFP-HF profile; only
        // request it when puck mode is actually enabled so normal mode is unchanged.
        if (Build.VERSION.SDK_INT >= 31 && AgentPhonePreferences.isPuckModeEnabled(this)) {
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        requestPermissions(permissions.toTypedArray(), 10)
    }

    /** When puck mode is ON, launching the app starts the relay service; OFF: no-op. */
    private fun startPuckIfEnabled() {
        if (AgentPhonePreferences.isPuckModeEnabled(this)) {
            RelayPuckService.start(this)
        }
    }

    /**
     * Keep the background receiver alive 24/7 so calls/texts arrive even when the
     * app is closed: persist always-on (which also enables the boot receiver),
     * start the foreground service, and ask Android to stop battery-killing it.
     */
    private fun ensureAlwaysOnAndBattery() {
        if (AgentPhonePreferences.isAlwaysOnEnabled(this)) {
            AgentPhonePreferences.setAlwaysOnEnabled(this, true)
            AgentPhoneForegroundService.start(this, "app_launch")
        }
        val pm = getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        }
    }

    companion object {
        const val EXTRA_OPEN_THREAD_ID = "openThreadId"
        const val EXTRA_OPEN_MESSAGE_ID = "openMessageId"
    }
}
