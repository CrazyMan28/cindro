package com.jarvis.app.net

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.jarvis.app.JarvisApp
import com.jarvis.app.MainActivity
import com.jarvis.app.R
import com.jarvis.app.fcm.JarvisNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the daemon device WebSocket alive in the background and posts LOCAL
 * notifications for events that arrive over it — WITHOUT Firebase.
 *
 * The daemon's FCM push is a no-op in this setup (no service account / no Firebase),
 * so this foreground service IS the notification path: while it runs, the authed
 * device WS stays connected and a new session / file offer fans out over it; we
 * surface each one through [JarvisNotifier] exactly like the old FCM path did.
 *
 * Foreground type = dataSync with a quiet ongoing notification so Android keeps the
 * process + socket alive while the app is backgrounded. Started from the app once
 * paired; stopped when the user unpairs.
 */
class JarvisConnectionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var collecting = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithNotification()
        startCollecting()
        return START_STICKY
    }

    private fun startForegroundWithNotification() {
        JarvisNotifier.ensureChannels(this)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, JarvisNotifier.CHANNEL_WAKE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(0xFF34D8FF.toInt())
            .setContentTitle("Jarvis connected")
            .setContentText("Listening for notifications")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun startCollecting() {
        if (collecting) return
        collecting = true
        val app = application as JarvisApp
        // Make sure the socket is up (no-op if already connected).
        if (app.pairingStore.isPaired) app.repository.connect()

        // A new session opened anywhere (phone/desktop/scheduler) -> local notification.
        scope.launch {
            app.repository.sessionOpened.collect { s ->
                if (!app.pairingStore.notificationsEnabled) return@collect
                JarvisNotifier.notify(
                    applicationContext,
                    kind = "session_opened",
                    title = "New session",
                    body = s.title ?: "Untitled session",
                    sessionId = s.sessionId,
                )
            }
        }
        // A file offered from the desktop -> local notification.
        scope.launch {
            app.repository.fileOffers.collect { f ->
                if (!app.pairingStore.notificationsEnabled) return@collect
                JarvisNotifier.notify(
                    applicationContext,
                    kind = "file_offer",
                    title = "File from Jarvis",
                    body = f.name,
                    sessionId = f.sessionId,
                )
            }
        }
        // An unlock challenge (desktop or Chrome) over the WS -> high-priority
        // "Unlock Jarvis" notification that deep-links into the Approve screen. This
        // is the no-Firebase path for 2FA + the Chrome lock.
        scope.launch {
            app.repository.authChallenges.collect { ch ->
                JarvisNotifier.notify(
                    applicationContext,
                    kind = "auth",
                    title = if (ch.origin == "extension") "Unlock Jarvis (Chrome)" else "Unlock Jarvis",
                    body = "Approve sign-in with your fingerprint",
                    sessionId = null,
                    challengeId = ch.challengeId,
                )
            }
        }
    }

    override fun onDestroy() {
        collecting = false
        scope.cancel()
        // Leave the app-scoped repository connected; the app/UI owns its lifecycle.
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "com.jarvis.app.CONNECTION_STOP"
        private const val NOTIF_ID = 0xC0DE

        /** Start the background connection service (paired users only). */
        fun start(context: Context) {
            val i = Intent(context, JarvisConnectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, JarvisConnectionService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
