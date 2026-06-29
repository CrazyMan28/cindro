package com.agentphone.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.agentphone.state.AgentPhonePreferences

class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_LOCKED_BOOT_COMPLETED) return
        AgentPhonePreferences.recordBootTriggered(context, action)
        when (BootStartupPlanner.plan(AgentPhonePreferences.isAlwaysOnEnabled(context))) {
            BootStartupDecision.IGNORE -> return
            BootStartupDecision.START_SERVICE -> startOrSchedule(context, action)
            BootStartupDecision.SCHEDULE_RETRY -> scheduleRetry(context, "Boot receiver scheduled reconnect after $action")
        }
    }

    private fun startOrSchedule(context: Context, action: String) {
        try {
            AgentPhoneForegroundService.start(context, "boot:$action")
        } catch (error: RuntimeException) {
            scheduleRetry(context, "Boot service start blocked: ${error.message ?: error.javaClass.simpleName}")
            try {
                AgentPhoneNotifications.showReconnectRequiredNotification(context, "Open Agent Phone to reconnect after boot.")
            } catch (_: RuntimeException) {
            }
        }
    }

    private fun scheduleRetry(context: Context, reason: String) {
        AgentPhoneReconnectWorker.schedule(context, reason)
    }
}
