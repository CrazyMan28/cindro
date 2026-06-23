package com.jarvis.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import com.jarvis.app.fcm.JarvisNotifier
import com.jarvis.app.ui.AppNav
import com.jarvis.app.ui.theme.JarvisTheme
import com.jarvis.app.ui.util.HapticController
import com.jarvis.app.ui.util.Haptics
import com.jarvis.app.ui.util.LocalHaptics
import com.jarvis.app.voice.WakeService

/**
 * Single-activity host. Extends [FragmentActivity] so the BiometricPrompt (used to gate
 * `biometric`-tier approvals) can attach. The whole UI is Compose; navigation lives in
 * [AppNav]. FCM taps arrive as intent extras and deep-link into a session's chat.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Edge-to-edge: let WindowInsets (incl. the IME) flow into Compose so the
        // chat input row can dock just above the keyboard via Modifier.imePadding()
        // instead of the whole UI being shoved up by the system.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        JarvisNotifier.ensureChannels(this)

        val initialSession = intent?.getStringExtra(JarvisNotifier.EXTRA_SESSION_ID)
        val wokeViaWake = intent?.getBooleanExtra(WakeService.EXTRA_WAKE, false) == true

        val app = application as JarvisApp
        // One app-wide Haptics + a live "haptics on?" reader (re-read each tap so
        // the Settings toggle applies immediately). Published via LocalHaptics so
        // every button/control across the app can tick on tap.
        val hapticController = HapticController(
            haptics = Haptics(this),
            enabled = { app.appPrefs.hapticsEnabled },
        )

        setContent {
            JarvisTheme {
                val activity = this
                val deepLinkSession = remember { mutableStateOf(initialSession) }
                val deepLinkWake = remember { mutableStateOf(wokeViaWake) }
                CompositionLocalProvider(LocalHaptics provides hapticController) {
                    Surface(modifier = Modifier.fillMaxSize()) {
                        AppNav(
                            app = app,
                            activity = activity,
                            deepLinkSessionId = deepLinkSession.value,
                            deepLinkWake = deepLinkWake.value,
                            onDeepLinkConsumed = {
                                deepLinkSession.value = null
                                deepLinkWake.value = false
                            },
                        )
                    }
                }
            }
        }
    }
}
