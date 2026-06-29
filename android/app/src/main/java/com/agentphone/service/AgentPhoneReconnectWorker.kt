package com.agentphone.service

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.agentphone.state.AgentPhonePreferences
import java.util.concurrent.TimeUnit

class AgentPhoneReconnectWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (!AgentPhonePreferences.isAlwaysOnEnabled(applicationContext)) return Result.success()
        return try {
            AgentPhoneForegroundService.start(applicationContext, "workmanager_retry")
            Result.success()
        } catch (error: RuntimeException) {
            AgentPhonePreferences.recordReconnectReason(applicationContext, "WorkManager retry blocked: ${error.message ?: error.javaClass.simpleName}")
            AgentPhoneNotifications.showReconnectRequiredNotification(applicationContext, "Open Agent Phone to reconnect always-on mode.")
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_WORK_NAME = "agent-phone-background-reconnect"

        fun schedule(context: Context, reason: String, initialDelayMs: Long = 30_000L) {
            AgentPhonePreferences.recordReconnectReason(context, reason)
            val request = OneTimeWorkRequest.Builder(AgentPhoneReconnectWorker::class.java)
                .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
