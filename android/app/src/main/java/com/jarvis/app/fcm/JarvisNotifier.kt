package com.jarvis.app.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.jarvis.app.MainActivity
import com.jarvis.app.R

/**
 * Builds and posts FCM-triggered notifications. Two channels mirror the daemon's push
 * intents: an attention channel (approval needed) and an updates channel (task done,
 * file ready). Posting respects the runtime POST_NOTIFICATIONS permission on API 33+.
 */
object JarvisNotifier {

    const val CHANNEL_ATTENTION = "jarvis_attention"
    const val CHANNEL_UPDATES = "jarvis_updates"
    const val CHANNEL_WAKE = "jarvis_wake"

    private const val ACCENT = 0xFF34D8FF.toInt()

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        mgr.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ATTENTION,
                "Needs attention",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Approvals Jarvis is waiting on" },
        )
        mgr.createNotificationChannel(
            NotificationChannel(
                CHANNEL_UPDATES,
                "Updates",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Task completions and ready files" },
        )
        mgr.createNotificationChannel(
            NotificationChannel(
                CHANNEL_WAKE,
                "Wake listener",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Shown while \"Hey Jarvis\" wake is active" },
        )
    }

    /**
     * @param kind one of approval_needed | task_done | file_ready (daemon-defined).
     */
    fun notify(
        context: Context,
        kind: String,
        title: String,
        body: String,
        sessionId: String?,
    ) {
        ensureChannels(context)
        val channel = if (kind == "approval_needed") CHANNEL_ATTENTION else CHANNEL_UPDATES

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
            putExtra(EXTRA_KIND, kind)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(context, kind.hashCode(), tapIntent, flags)

        val notif = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(
                if (channel == CHANNEL_ATTENTION) NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT,
            )
            .setContentIntent(pending)
            .build()

        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        try {
            nm.notify((sessionId ?: kind).hashCode(), notif)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted — silently drop.
        }
    }

    const val EXTRA_SESSION_ID = "jarvis.session_id"
    const val EXTRA_KIND = "jarvis.kind"
}
