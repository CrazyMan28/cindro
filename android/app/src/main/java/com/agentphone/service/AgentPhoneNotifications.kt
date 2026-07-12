package com.agentphone.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.os.Build
import com.agentphone.IncomingCallActivity
import com.agentphone.MainActivity
import com.cindro.app.R
import com.agentphone.state.AgentPhoneSettings
import com.agentphone.state.UiMessage

object AgentPhoneNotifications {
    const val ONLINE_CHANNEL_ID = "agent_phone_online"
    const val INCOMING_CHANNEL_ID = "agent_phone_incoming_calls"
    const val MESSAGE_CHANNEL_ID = "agent_phone_messages"
    const val MESSAGE_URGENT_CHANNEL_ID = "agent_phone_messages_urgent"
    const val SCREENING_CHANNEL_ID = "agent_phone_call_screening"
    const val ONLINE_NOTIFICATION_ID = 100
    const val RECONNECT_NOTIFICATION_ID = 101
    const val INCOMING_NOTIFICATION_BASE_ID = 2000
    const val MESSAGE_NOTIFICATION_BASE_ID = 5000
    const val SCREENING_OFFER_NOTIFICATION_ID = 7001
    const val SCREENING_NOTIFICATION_BASE_ID = 7100

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(ONLINE_CHANNEL_ID, "Agent Phone connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps Agent Phone connected for incoming calls."
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(INCOMING_CHANNEL_ID, "Incoming agent calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shows lock-screen and full-screen incoming agent call alerts."
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(MESSAGE_CHANNEL_ID, "Agent messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "In-app text messages from agents."
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(MESSAGE_URGENT_CHANNEL_ID, "Urgent agent messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Urgent or critical in-app messages from agents (no full-screen)."
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(SCREENING_CHANNEL_ID, "Call screening", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Offers to let your agent answer a ringing call, and live screening sessions."
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
    }

    /** Heads-up offer alongside the NATIVE ringer: "let my agent take this call?" */
    fun showScreeningOffer(context: Context, number: String) {
        ensureChannels(context)
        val agentIntent = servicePendingIntent(
            context,
            SCREENING_OFFER_NOTIFICATION_ID,
            Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(AgentPhoneForegroundService.ACTION_AGENT_TAKE_NATIVE_CALL)
                .putExtra(AgentPhoneForegroundService.EXTRA_NUMBER, number),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(context, SCREENING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming call: $number")
            .setContentText("Let your agent answer it? (Declines and forwards to the agent.)")
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setTimeoutAfter(30_000)
            .addAction(R.drawable.ic_notification, "Agent answers", agentIntent)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(SCREENING_OFFER_NOTIFICATION_ID, notification)
    }

    fun cancelScreeningOffer(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(SCREENING_OFFER_NOTIFICATION_ID)
    }

    /** Full-screen alert that opens the live screening transcript window. */
    fun showScreeningCall(context: Context, callId: String, callerNumber: String) {
        ensureChannels(context)
        val requestCode = SCREENING_NOTIFICATION_BASE_ID + callId.hashCode().absoluteValueMod(900_000)
        val fullScreenIntent = PendingIntent.getActivity(
            context,
            requestCode,
            Intent(context, com.agentphone.ScreeningActivity::class.java)
                .setAction(com.agentphone.ScreeningActivity.ACTION_SHOW_SCREENING)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(context, SCREENING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Agent is screening $callerNumber")
            .setContentText("Tap to watch live, take over, or hang up.")
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(screeningNotificationId(callId), notification)
    }

    fun cancelScreening(context: Context, callId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(screeningNotificationId(callId))
    }

    private fun screeningNotificationId(callId: String): Int =
        SCREENING_NOTIFICATION_BASE_ID + callId.hashCode().absoluteValueMod(900_000)

    fun showMessage(context: Context, message: UiMessage) {
        ensureChannels(context)
        context.getSystemService(NotificationManager::class.java).notify(
            messageNotificationId(message.id),
            messageNotification(context, message)
        )
    }

    fun cancelMessage(context: Context, messageId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(messageNotificationId(messageId))
    }

    private fun messageNotification(context: Context, message: UiMessage): Notification {
        val urgent = message.priority == "urgent" || message.priority == "critical"
        val channel = if (urgent) MESSAGE_URGENT_CHANNEL_ID else MESSAGE_CHANNEL_ID
        val openCode = MESSAGE_NOTIFICATION_BASE_ID + message.id.hashCode().absoluteValueMod(900_000)
        val openIntent = PendingIntent.getActivity(
            context,
            openCode,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_THREAD_ID, message.threadId)
                .putExtra(MainActivity.EXTRA_OPEN_MESSAGE_ID, message.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val markReadIntent = servicePendingIntent(
            context,
            openCode + 1,
            Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(AgentPhoneForegroundService.ACTION_MARK_MESSAGE_READ)
                .putExtra(AgentPhoneForegroundService.EXTRA_MESSAGE_ID, message.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("[${message.priority}] ${message.title}")
            .setContentText(message.body.take(120))
            .setStyle(Notification.BigTextStyle().bigText(message.body))
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .setVisibility(if (urgent) Notification.VISIBILITY_PUBLIC else Notification.VISIBILITY_PRIVATE)
            .addAction(R.drawable.ic_notification, "Mark read", markReadIntent)
            .addAction(R.drawable.ic_notification, "Open", openIntent)
        if (Build.VERSION.SDK_INT < 26 && urgent) builder.setPriority(Notification.PRIORITY_HIGH)
        return builder.build()
    }

    private fun messageNotificationId(messageId: String): Int =
        MESSAGE_NOTIFICATION_BASE_ID + messageId.hashCode().absoluteValueMod(900_000)

    fun onlineNotification(context: Context, settings: AgentPhoneSettings, state: String, activeCall: IncomingCallInfo? = null): Notification {
        if (activeCall != null) return activeCallNotification(context, activeCall)
        val openIntent = PendingIntent.getActivity(
            context,
            10,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val disconnectIntent = servicePendingIntent(
            context,
            11,
            Intent(context, AgentPhoneForegroundService::class.java).setAction(AgentPhoneForegroundService.ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(context, ONLINE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Agent Phone online as extension ${settings.extension}")
            .setContentText(state)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(R.drawable.ic_notification, "Disconnect", disconnectIntent)
            .addAction(R.drawable.ic_notification, "Open app", openIntent)
            .build()
    }

    /**
     * The persistent "you're on a call" notification. Tapping it RETURNS to the
     * in-call screen (it does not end anything); only the explicit "End call"
     * action — or the agent / server ending the call — terminates it. This is what
     * stops a call from vanishing when you leave the call screen.
     */
    private fun activeCallNotification(context: Context, info: IncomingCallInfo): Notification {
        val resumeIntent = PendingIntent.getActivity(
            context,
            20,
            info.applyTo(Intent(context, IncomingCallActivity::class.java))
                .setAction(IncomingCallActivity.ACTION_RESUME_CALL)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val endIntent = servicePendingIntent(
            context,
            21,
            info.applyTo(Intent(context, AgentPhoneForegroundService::class.java))
                .setAction(AgentPhoneForegroundService.ACTION_END_CALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val openIntent = PendingIntent.getActivity(
            context,
            22,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(context, ONLINE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("On call with ${info.agentName.ifBlank { "ext ${info.fromExtension}" }}")
            .setContentText("Tap to return to the call")
            .setContentIntent(resumeIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL)
            .addAction(R.drawable.ic_notification, "End call", endIntent)
            .addAction(R.drawable.ic_notification, "Open app", openIntent)
            .build()
    }

    fun incomingCallNotification(context: Context, info: IncomingCallInfo): Notification {
        val requestCode = INCOMING_NOTIFICATION_BASE_ID + info.callId.hashCode().absoluteValueMod(900_000)
        val fullScreenIntent = PendingIntent.getActivity(
            context,
            requestCode,
            info.applyTo(Intent(context, IncomingCallActivity::class.java))
                .setAction(IncomingCallActivity.ACTION_SHOW_INCOMING)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val acceptIntent = servicePendingIntent(
            context,
            requestCode + 1,
            info.applyTo(Intent(context, AgentPhoneForegroundService::class.java))
                .setAction(AgentPhoneForegroundService.ACTION_ACCEPT_CALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val rejectIntent = servicePendingIntent(
            context,
            requestCode + 2,
            info.applyTo(Intent(context, AgentPhoneForegroundService::class.java))
                .setAction(AgentPhoneForegroundService.ACTION_REJECT_CALL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val textIntent = PendingIntent.getActivity(
            context,
            requestCode + 3,
            info.applyTo(Intent(context, IncomingCallActivity::class.java))
                .setAction(IncomingCallActivity.ACTION_TEXT_FALLBACK)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val callerName = info.agentName.ifBlank { "Agent ${info.fromExtension}" }
        val body = listOf(info.reason, info.message).filter { it.isNotBlank() }.joinToString(" - ")
            .ifBlank { "Tap to answer, reject, or send a text fallback." }
        val builder = Notification.Builder(context, INCOMING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Incoming agent call from ${info.fromExtension}")
            .setContentText(body)
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)

        if (Build.VERSION.SDK_INT >= 31) {
            // CallStyle renders a genuine system phone-call card — big Answer /
            // Decline buttons + caller identity — as a heads-up banner and on the
            // lock screen, exactly like a real incoming call.
            val caller = Person.Builder().setName(callerName).setImportant(true).build()
            builder
                .setStyle(Notification.CallStyle.forIncomingCall(caller, rejectIntent, acceptIntent))
                .setColorized(true)
                .addAction(R.drawable.ic_notification, "Text", textIntent)
        } else {
            builder
                .setStyle(Notification.BigTextStyle().bigText(body))
                .addAction(R.drawable.ic_notification, "Accept", acceptIntent)
                .addAction(R.drawable.ic_notification, "Reject", rejectIntent)
                .addAction(R.drawable.ic_notification, "Text", textIntent)
            if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_MAX)
        }
        return builder.build()
    }

    fun showIncomingCall(context: Context, info: IncomingCallInfo) {
        ensureChannels(context)
        context.getSystemService(NotificationManager::class.java).notify(
            incomingNotificationId(info.callId),
            incomingCallNotification(context, info)
        )
    }

    fun cancelIncomingCall(context: Context, callId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(incomingNotificationId(callId))
    }

    fun showReconnectRequiredNotification(context: Context, reason: String) {
        ensureChannels(context)
        val openIntent = PendingIntent.getActivity(
            context,
            12,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(context, ONLINE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Agent Phone needs to reconnect")
            .setContentText(reason)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(RECONNECT_NOTIFICATION_ID, notification)
    }

    private fun incomingNotificationId(callId: String): Int {
        return INCOMING_NOTIFICATION_BASE_ID + callId.hashCode().absoluteValueMod(900_000)
    }

    private fun servicePendingIntent(context: Context, requestCode: Int, intent: Intent, flags: Int): PendingIntent {
        return if (Build.VERSION.SDK_INT >= 26) {
            PendingIntent.getForegroundService(context, requestCode, intent, flags)
        } else {
            PendingIntent.getService(context, requestCode, intent, flags)
        }
    }

    private fun Int.absoluteValueMod(mod: Int): Int {
        return (this.toLong().let { if (it < 0) -it else it } % mod).toInt()
    }
}
