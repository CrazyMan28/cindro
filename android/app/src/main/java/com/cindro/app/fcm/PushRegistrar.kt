package com.cindro.app.fcm

import android.content.Context
import android.util.Log
import com.cindro.app.BuildConfig
import com.cindro.app.JarvisApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Keeps the daemon's record of this device's FCM token current. Registration is
 * best-effort and idempotent: re-sending the same token is harmless (the daemon
 * de-dupes), so we sync on every successful connect and on token rotation.
 *
 * When FCM is not configured at build time (no google-services.json — [BuildConfig
 * .FCM_ENABLED] is false) every entry point is a quiet no-op so the rest of the app
 * behaves identically.
 */
object PushRegistrar {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Fetch the current token and register it with the daemon. Call after auth. */
    fun syncCurrentToken(context: Context) {
        if (!BuildConfig.FCM_ENABLED) return
        val app = context.applicationContext as? JarvisApp ?: return
        if (!app.pairingStore.isPaired) return
        scope.launch {
            runCatching {
                val token = com.google.firebase.messaging.FirebaseMessaging
                    .getInstance().token.await()
                app.repository.registerPush(token)
                Log.d(TAG, "registered FCM token (${token.take(12)}…)")
            }.onFailure { Log.w(TAG, "token sync failed: ${it.message}") }
        }
    }

    /** A rotated token was delivered to [FcmService]. */
    fun onTokenRefreshed(context: Context, token: String) {
        if (!BuildConfig.FCM_ENABLED) return
        val app = context.applicationContext as? JarvisApp ?: return
        if (!app.pairingStore.isPaired) return
        scope.launch {
            runCatching { app.repository.registerPush(token) }
                .onFailure { Log.w(TAG, "token refresh register failed: ${it.message}") }
        }
    }

    private const val TAG = "PushRegistrar"
}
