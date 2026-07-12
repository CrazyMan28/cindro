package com.jarvis.app.fcm

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.jarvis.app.JarvisApp

/**
 * Receives FCM pushes from jarvisd (project "the FCM project"). The daemon sends data-only
 * messages on events needing attention — approval needed, task done, file ready — with
 * fields {kind, title, body, session_id}. We surface them as notifications via
 * [JarvisNotifier] (no foreground service, no polling: the OS wakes us on news).
 *
 * Token rotations are forwarded to the daemon through [PushRegistrar.register].
 */
class FcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        PushRegistrar.onTokenRefreshed(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val app = applicationContext as? JarvisApp ?: return
        if (!app.pairingStore.isPaired) return
        if (!app.pairingStore.notificationsEnabled) return

        val data = message.data
        val kind = data["kind"] ?: data["type"] ?: "update"
        val title = data["title"] ?: message.notification?.title ?: "Cindro"
        val body = data["body"] ?: message.notification?.body ?: ""
        val sessionId = data["session_id"] ?: data["sessionId"]
        // 2FA + fingerprint cross-device unlock: an "auth" push carries the
        // challenge id; tapping the notification opens the Approve screen which
        // runs BiometricPrompt then calls auth.approve over the device WS.
        val challengeId = data["challenge_id"] ?: data["challengeId"]

        Log.d(TAG, "push kind=$kind session=$sessionId challenge=$challengeId")
        JarvisNotifier.notify(applicationContext, kind, title, body, sessionId, challengeId)
    }

    companion object {
        private const val TAG = "JarvisFcm"
    }
}
