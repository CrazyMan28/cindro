package com.agentphone.state

import java.net.URI

data class AgentPhoneSettings(
    val serverUrl: String = "http://TAILSCALE_IP:8799",
    val token: String = "change-me-device-token",
    val extension: String = "100",
    val audioFormat: String = "pcm_s16le",
    val pushToTalkEnabled: Boolean = true
) {
    fun websocketUrl(): String {
        val trimmed = serverUrl.trim().removeSuffix("/")
        val normalized = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "http://$trimmed"
        val uri = URI(normalized)
        val protocol = if (uri.scheme == "https") "wss" else "ws"
        val authority = uri.rawAuthority ?: normalized.removePrefix("http://").removePrefix("https://").substringBefore("/")
        return "$protocol://$authority/ws"
    }

    fun isValid(): Boolean = serverUrl.startsWith("http://") || serverUrl.startsWith("https://")
}

data class PhoneUiState(
    val connection: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    val activeCallId: String? = null,
    val incomingCallId: String? = null,
    val callState: String = "idle",
    val peerExtension: String? = null,
    val muted: Boolean = false,
    val speaker: Boolean = true,
    val pushToTalk: Boolean = false,
    val transcript: List<String> = emptyList(),
    val missedCalls: List<String> = emptyList()
)

enum class ConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    ONLINE,
    RECONNECTING,
    ERROR
}

sealed class PhoneAction {
    data object Connected : PhoneAction()
    data object Disconnected : PhoneAction()
    data class IncomingCall(val callId: String, val fromExtension: String?) : PhoneAction()
    data class CallAccepted(val callId: String) : PhoneAction()
    data class CallEnded(val callId: String?) : PhoneAction()
    data class CallState(val callId: String?, val state: String) : PhoneAction()
    data class MissedCall(val callId: String, val fromExtension: String?) : PhoneAction()
    data class Transcript(val line: String) : PhoneAction()
    data class ToggleMute(val enabled: Boolean) : PhoneAction()
    data class ToggleSpeaker(val enabled: Boolean) : PhoneAction()
    data class PushToTalk(val enabled: Boolean) : PhoneAction()
}

object CallStateReducer {
    fun reduce(state: PhoneUiState, action: PhoneAction): PhoneUiState = when (action) {
        PhoneAction.Connected -> state.copy(connection = ConnectionStatus.ONLINE)
        PhoneAction.Disconnected -> state.copy(connection = ConnectionStatus.DISCONNECTED)
        is PhoneAction.IncomingCall -> state.copy(incomingCallId = action.callId, peerExtension = action.fromExtension)
        is PhoneAction.CallAccepted -> state.copy(activeCallId = action.callId, incomingCallId = null, callState = "active")
        // peerExtension must clear too — leaving it set kept the "active call"
        // card pinned on the Calls tab forever after the call ended.
        is PhoneAction.CallEnded -> state.copy(activeCallId = null, incomingCallId = null, peerExtension = null, pushToTalk = false, callState = "ended")
        is PhoneAction.CallState -> state.copy(activeCallId = action.callId ?: state.activeCallId, callState = action.state)
        is PhoneAction.MissedCall -> state.copy(missedCalls = state.missedCalls + "${action.fromExtension ?: "unknown"}:${action.callId}")
        is PhoneAction.Transcript -> state.copy(transcript = (state.transcript + action.line).takeLast(200))
        is PhoneAction.ToggleMute -> state.copy(muted = action.enabled)
        is PhoneAction.ToggleSpeaker -> state.copy(speaker = action.enabled)
        is PhoneAction.PushToTalk -> state.copy(pushToTalk = action.enabled)
    }
}

data class PermissionState(
    val microphoneGranted: Boolean,
    val notificationGranted: Boolean,
    val foregroundServiceAvailable: Boolean
) {
    fun audioReady(): Boolean = microphoneGranted && foregroundServiceAvailable
}
