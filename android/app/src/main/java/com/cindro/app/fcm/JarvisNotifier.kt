package com.cindro.app.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.cindro.app.MainActivity
import com.cindro.app.R

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
            ).apply { description = "Approvals Cindro is waiting on" },
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
            ).apply { description = "Shown while \"Hey Cindro\" wake is active" },
        )
    }

    /**
     * @param kind one of approval_needed | task_done | file_ready | session_opened |
     *   auth (daemon-defined). kind=="session_opened" rides the generic
     *   session-deep-link path: it carries [sessionId], so tapping deep-links into
     *   that session's chat (via EXTRA_SESSION_ID) — no special-casing needed.
     * @param challengeId present only for kind=="auth" (2FA cross-device unlock):
     *   tapping the notification deep-links into the Approve screen.
     */
    fun notify(
        context: Context,
        kind: String,
        title: String,
        body: String,
        sessionId: String?,
        challengeId: String? = null,
    ) {
        ensureChannels(context)
        // An "auth" unlock is attention-critical (the user is waiting at their
        // computer), so it rides the high-importance attention channel.
        val channel = if (kind == "approval_needed" || kind == "auth")
            CHANNEL_ATTENTION else CHANNEL_UPDATES

        // For the unlock push, override the title/body so the notification reads
        // as a sign-in prompt regardless of what the daemon sent.
        val showTitle = if (kind == "auth") "Unlock Cindro" else title
        val showBody = if (kind == "auth") "Approve to sign in on your computer" else body

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            sessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
            challengeId?.let { putExtra(EXTRA_CHALLENGE_ID, it) }
            putExtra(EXTRA_KIND, kind)
        }
        // A distinct request code per challenge so a new unlock push doesn't reuse
        // a stale PendingIntent extra.
        val requestCode = (challengeId ?: sessionId ?: kind).hashCode()
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(context, requestCode, tapIntent, flags)

        val notif = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(ACCENT)
            .setContentTitle(showTitle)
            .setContentText(showBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(showBody))
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
            nm.notify((challengeId ?: sessionId ?: kind).hashCode(), notif)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted — silently drop.
        }
    }

    const val EXTRA_SESSION_ID = "jarvis.session_id"
    const val EXTRA_KIND = "jarvis.kind"
    const val EXTRA_CHALLENGE_ID = "jarvis.challenge_id"
}
