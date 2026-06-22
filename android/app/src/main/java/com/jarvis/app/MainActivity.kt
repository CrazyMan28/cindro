package com.jarvis.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import com.jarvis.app.fcm.JarvisNotifier
import com.jarvis.app.ui.AppNav
import com.jarvis.app.ui.theme.JarvisTheme

/**
 * Single-activity host. Extends [FragmentActivity] so the BiometricPrompt (used to gate
 * `biometric`-tier approvals) can attach. The whole UI is Compose; navigation lives in
 * [AppNav]. FCM taps arrive as intent extras and deep-link into a session's chat.
 */
class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        JarvisNotifier.ensureChannels(this)

        val initialSession = intent?.getStringExtra(JarvisNotifier.EXTRA_SESSION_ID)

        setContent {
            JarvisTheme {
                val activity = this
                val deepLinkSession = remember { mutableStateOf(initialSession) }
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppNav(
                        app = application as JarvisApp,
                        activity = activity,
                        deepLinkSessionId = deepLinkSession.value,
                        onDeepLinkConsumed = { deepLinkSession.value = null },
                    )
                }
            }
        }
    }
}
