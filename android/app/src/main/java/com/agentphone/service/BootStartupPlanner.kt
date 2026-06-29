package com.agentphone.service

enum class BootStartupDecision {
    IGNORE,
    START_SERVICE,
    SCHEDULE_RETRY
}

object BootStartupPlanner {
    fun plan(alwaysOnEnabled: Boolean, serviceStartBlocked: Boolean = false): BootStartupDecision {
        if (!alwaysOnEnabled) return BootStartupDecision.IGNORE
        return if (serviceStartBlocked) BootStartupDecision.SCHEDULE_RETRY else BootStartupDecision.START_SERVICE
    }
}
