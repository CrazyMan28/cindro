package com.agentphone.state

data class ConnectionServiceState(
    val running: Boolean = false,
    val webSocketState: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    val reconnectAttempt: Int = 0,
    val nextReconnectDelayMs: Long = 0L,
    val lastReason: String = ""
)

sealed class ConnectionServiceAction {
    data object Started : ConnectionServiceAction()
    data object Online : ConnectionServiceAction()
    data class Disconnected(val reason: String) : ConnectionServiceAction()
    data class Failed(val reason: String) : ConnectionServiceAction()
    data object ManualDisconnect : ConnectionServiceAction()
}

object ConnectionServiceStateReducer {
    fun reduce(state: ConnectionServiceState, action: ConnectionServiceAction): ConnectionServiceState = when (action) {
        ConnectionServiceAction.Started -> state.copy(running = true, webSocketState = ConnectionStatus.CONNECTING)
        ConnectionServiceAction.Online -> state.copy(
            running = true,
            webSocketState = ConnectionStatus.ONLINE,
            reconnectAttempt = 0,
            nextReconnectDelayMs = 0L,
            lastReason = ""
        )
        is ConnectionServiceAction.Disconnected -> nextReconnect(state, action.reason)
        is ConnectionServiceAction.Failed -> nextReconnect(state, action.reason)
        ConnectionServiceAction.ManualDisconnect -> state.copy(
            running = false,
            webSocketState = ConnectionStatus.DISCONNECTED,
            reconnectAttempt = 0,
            nextReconnectDelayMs = 0L,
            lastReason = "manual disconnect"
        )
    }

    private fun nextReconnect(state: ConnectionServiceState, reason: String): ConnectionServiceState {
        val attempt = (state.reconnectAttempt + 1).coerceAtMost(ReconnectBackoff.MAX_ATTEMPT)
        return state.copy(
            running = true,
            webSocketState = ConnectionStatus.RECONNECTING,
            reconnectAttempt = attempt,
            nextReconnectDelayMs = ReconnectBackoff.delayForAttempt(attempt),
            lastReason = reason
        )
    }
}

object ReconnectBackoff {
    const val MAX_ATTEMPT = 8
    private const val BASE_DELAY_MS = 1_500L
    private const val MAX_DELAY_MS = 60_000L

    fun delayForAttempt(attempt: Int): Long {
        val safeAttempt = attempt.coerceAtLeast(1).coerceAtMost(MAX_ATTEMPT)
        val multiplier = 1L shl (safeAttempt - 1)
        return (BASE_DELAY_MS * multiplier).coerceAtMost(MAX_DELAY_MS)
    }
}
