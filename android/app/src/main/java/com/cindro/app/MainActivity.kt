package com.cindro.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import com.agentphone.service.AgentPhoneForegroundService
import com.agentphone.state.AgentPhonePreferences
import com.cindro.app.fcm.JarvisNotifier
import com.cindro.app.net.JarvisConnectionService
import com.cindro.app.ui.AppNav
import com.cindro.app.ui.theme.JarvisTheme
import com.cindro.app.ui.util.HapticController
import com.cindro.app.ui.util.Haptics
import com.cindro.app.ui.util.LocalHaptics
import com.cindro.app.voice.WakeService

/**
 * Single-activity host. Extends [FragmentActivity] so the BiometricPrompt (used to gate
 * `biometric`-tier approvals) can attach. The whole UI is Compose; navigation lives in
 * [AppNav]. FCM taps arrive as intent extras and deep-link into a session's chat.
 *
 * Deep-link state is hoisted to Activity-level Compose [mutableStateOf] holders so that a
 * tapped notification works in BOTH activity lifecycles: a cold start / from-background
 * launch (handled in [onCreate]) AND a tap while the app is already in the foreground
 * (delivered to [onNewIntent], which the default `standard`/`singleTop` launch reuses).
 * Without the [onNewIntent] path, an "Unlock Cindro" push tapped while the app was already
 * open would silently fail to open the Approve screen.
 */
class MainActivity : FragmentActivity() {

    // Compose-observable deep-link holders, updated from whichever intent arrives.
    private val deepLinkSession = mutableStateOf<String?>(null)
    private val deepLinkWake = mutableStateOf(false)
    private val deepLinkAuth = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Edge-to-edge: let WindowInsets (incl. the IME) flow into Compose so the
        // chat input row can dock just above the keyboard via Modifier.imePadding()
        // instead of the whole UI being shoved up by the system.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        JarvisNotifier.ensureChannels(this)

        // Keep notifications flowing WITHOUT Firebase: a foreground service holds the
        // daemon device WS open and posts local notifications (new session, file
        // offer). Paired users only; harmless to call repeatedly.
        if ((application as JarvisApp).pairingStore.isPaired)
            JarvisConnectionService.start(this)

        // Keep the PHONE device (ext 100) ONLINE in the background so incoming VOIP
        // calls/texts reach the user even when the app is closed — start the vendored
        // agent-phone foreground service (it holds the device WS to the phone server)
        // on EVERY Cindro launch, not only when the Phone tab is opened. Idempotent;
        // also (re-)enables the boot receiver so it comes back after a reboot.
        if (AgentPhonePreferences.isAlwaysOnEnabled(this)) {
            AgentPhonePreferences.setAlwaysOnEnabled(this, true)
            AgentPhoneForegroundService.start(this, "jarvis_launch")
        }

        // Seed deep-link state from the launching intent (cold start / from background).
        applyIntentExtras(intent)

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
                CompositionLocalProvider(LocalHaptics provides hapticController) {
                    Surface(modifier = Modifier.fillMaxSize()) {
                        AppNav(
                            app = app,
                            activity = activity,
                            deepLinkSessionId = deepLinkSession.value,
                            deepLinkWake = deepLinkWake.value,
                            deepLinkAuthChallenge = deepLinkAuth.value,
                            onDeepLinkConsumed = {
                                deepLinkSession.value = null
                                deepLinkWake.value = false
                                deepLinkAuth.value = null
                            },
                        )
                    }
                }
            }
        }
    }

    /**
     * A notification tapped while this Activity is already running (foreground or
     * background-but-alive) is delivered here rather than re-running [onCreate]. Re-point
     * [getIntent] and re-apply the extras so the same deep-link navigation fires.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIntentExtras(intent)
    }

    /** Read deep-link extras from [intent] into the Compose state holders (null-safe;
     *  absent extras never clobber existing pending state). */
    private fun applyIntentExtras(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(JarvisNotifier.EXTRA_SESSION_ID)
            ?.let { deepLinkSession.value = it }
        if (intent.getBooleanExtra(WakeService.EXTRA_WAKE, false)) deepLinkWake.value = true
        // 2FA + fingerprint cross-device unlock: a tapped "Unlock Cindro" push carries
        // the challenge id; deep-link into the Approve screen.
        intent.getStringExtra(JarvisNotifier.EXTRA_CHALLENGE_ID)
            ?.let { deepLinkAuth.value = it }
    }
}
