package com.jarvis.app.net

import android.app.KeyguardManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.jarvis.app.JarvisApp
import com.jarvis.app.MainActivity
import com.jarvis.app.R
import com.jarvis.app.fcm.JarvisNotifier
import com.jarvis.app.widget.JarvisWidgetProvider
import com.jarvis.app.widget.WidgetBindings
import com.jarvis.app.widget.WidgetCatalog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
        when (intent?.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_PIN -> intent.getStringExtra(EXTRA_WIDGET_ID)?.let { id ->
                scope.launch { (application as JarvisApp).repository.widgetPin(id, active = true) }
            }
            ACTION_UNPIN -> intent.getStringExtra(EXTRA_WIDGET_ID)?.let { id ->
                scope.launch { (application as JarvisApp).repository.widgetUnpin(id) }
            }
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
            .setContentTitle("Cindro connected")
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

        // One-time on this app version: clear stale home-widget tiles so a widget that
        // was deleted before remove-handling existed stops showing old data. Live pins
        // re-render fresh within ~60s (the pin heartbeat keeps their job alive).
        run {
            val hp = applicationContext.getSharedPreferences("jarvis_home_widgets", Context.MODE_PRIVATE)
            if (hp.getInt("svc_clear_ver", 0) != 2) {
                JarvisWidgetProvider.clearAll(applicationContext)
                hp.edit().putInt("svc_clear_ver", 2).apply()
            }
        }

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
                    title = "File from Cindro",
                    body = f.name,
                    sessionId = f.sessionId,
                )
            }
        }
        // An unlock challenge (desktop or Chrome) over the WS -> high-priority
        // "Unlock Cindro" notification that deep-links into the Approve screen. This
        // is the no-Firebase path for 2FA + the Chrome lock.
        scope.launch {
            app.repository.authChallenges.collect { ch ->
                JarvisNotifier.notify(
                    applicationContext,
                    kind = "auth",
                    title = if (ch.origin == "extension") "Unlock Cindro (Chrome)" else "Unlock Cindro",
                    body = "Approve sign-in with your fingerprint",
                    sessionId = null,
                    challengeId = ch.challengeId,
                )
            }
        }

        // A live render forwarded from the bus -> remember it (so the widget picker
        // can offer it) and redraw any home-screen instance pinned to that id, even
        // while the app UI is closed (this service holds the socket).
        scope.launch {
            app.repository.widgetEvents.collect { w ->
                when (w.op) {
                    "render" -> if (w.spec != null) {
                        val specJson = w.spec.toString()
                        WidgetCatalog.remember(applicationContext, w.id, w.title, specJson,
                            System.currentTimeMillis())
                        JarvisWidgetProvider.refreshForWidgetId(applicationContext, w.id, specJson, w.title)
                    }
                    // A deleted/cleared canvas must stop showing on BOTH the home-screen
                    // widget and the in-app gallery (catalog), not linger with stale data.
                    "remove" -> {
                        WidgetCatalog.remove(applicationContext, w.id)
                        JarvisWidgetProvider.clearForWidgetId(applicationContext, w.id)
                    }
                    "clear" -> {
                        WidgetCatalog.clear(applicationContext)
                        JarvisWidgetProvider.clearAll(applicationContext)
                    }
                }
            }
        }

        // Home-screen pin heartbeats (AGGRESSIVE battery policy): keep a pinned
        // widget's live job alive ONLY while the phone is unlocked/interactive; when
        // it's off/locked we send active=false so the daemon lease expires and the
        // job idles. ~30s cadence stays well inside the 45s lease TTL.
        scope.launch {
            while (true) {
                val pinned = WidgetBindings.pinnedWidgetIds(applicationContext)
                if (pinned.isNotEmpty()) {
                    val awake = isInteractiveAndUnlocked()
                    for (id in pinned) app.repository.widgetPin(id, active = awake)
                }
                delay(30_000)
            }
        }
    }

    private fun isInteractiveAndUnlocked(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val interactive = pm?.isInteractive ?: true
        val locked = km?.isKeyguardLocked ?: false
        return interactive && !locked
    }

    override fun onDestroy() {
        collecting = false
        scope.cancel()
        // Leave the app-scoped repository connected; the app/UI owns its lifecycle.
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "com.jarvis.app.CONNECTION_STOP"
        const val ACTION_PIN = "com.jarvis.app.WIDGET_PIN"
        const val ACTION_UNPIN = "com.jarvis.app.WIDGET_UNPIN"
        const val EXTRA_WIDGET_ID = "widget_id"
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

        /** Immediately register a home-screen pin for [widgetId] (the heartbeat loop
         *  then keeps it alive while unlocked). */
        fun requestPin(context: Context, widgetId: String) {
            val i = Intent(context, JarvisConnectionService::class.java)
                .setAction(ACTION_PIN).putExtra(EXTRA_WIDGET_ID, widgetId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }

        /** Drop a home-screen pin (the last instance was removed). */
        fun requestUnpin(context: Context, widgetId: String) {
            val i = Intent(context, JarvisConnectionService::class.java)
                .setAction(ACTION_UNPIN).putExtra(EXTRA_WIDGET_ID, widgetId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }
    }
}
