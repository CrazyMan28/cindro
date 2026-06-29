package com.agentphone.state

data class DiagnosticsState(
    val healthOk: Boolean? = null,
    val authOk: Boolean? = null,
    val setupStatusOk: Boolean? = null,
    val extensionExists: Boolean? = null,
    val extensionCount: Int? = null,
    val agentsOk: Boolean? = null,
    val agentCount: Int? = null,
    val websocketOk: Boolean? = null,
    val mistralConfigured: Boolean? = null,
    val tailscaleReachable: Boolean? = null,
    val lastWebSocketState: String = "disconnected",
    val lastWebSocketEvent: String = "",
    val lastWebSocketError: String = "",
    val lastError: String? = null,
    val suggestedFix: String? = null,
    val suggestedAndroidUrl: String? = null
) {
    fun debugReport(serverUrl: String, extension: String, websocketUrl: String = "", tokenConfigured: Boolean? = null): String = listOf(
        "serverUrl=$serverUrl",
        "websocketUrl=$websocketUrl",
        "extension=$extension",
        "tokenConfigured=${tokenConfigured?.let { if (it) "yes" else "no" } ?: ""}",
        "healthOk=$healthOk",
        "authOk=$authOk",
        "setupStatusOk=$setupStatusOk",
        "extensionExists=$extensionExists",
        "extensionCount=$extensionCount",
        "agentsOk=$agentsOk",
        "agentCount=$agentCount",
        "websocketOk=$websocketOk",
        "lastWebSocketState=$lastWebSocketState",
        "lastWebSocketEvent=$lastWebSocketEvent",
        "lastWebSocketError=$lastWebSocketError",
        "mistralConfigured=$mistralConfigured",
        "tailscaleReachable=$tailscaleReachable",
        "suggestedAndroidUrl=${suggestedAndroidUrl ?: ""}",
        "lastError=${lastError ?: ""}",
        "suggestedFix=${suggestedFix ?: ""}"
    ).joinToString("\n")
}

object ConnectionTroubleshooter {
    const val KNOWN_TAILSCALE_URL = "http://127.0.0.1:8799"
    const val TIMEOUT_MESSAGE =
        "Could not reach server. Check that Tailscale is on, server is running, firewall allows 8799, and URL is http://127.0.0.1:8799."
    const val AUTH_MESSAGE = "Auth failed. Check DEVICE_TOKEN in .env and app settings."
    const val EXTENSION_100_MESSAGE = "Extension 100 is missing. Run ./scripts/dev-fix-empty-extensions.sh on the server."
    const val LOOPBACK_MESSAGE = "127.0.0.1 means this phone, not your laptop/server. Use your Tailscale URL."

    fun warningForUrl(serverUrl: String): String? {
        val normalized = serverUrl.trim().lowercase()
        return when {
            normalized.contains("127.0.0.1") || normalized.contains("localhost") -> LOOPBACK_MESSAGE
            normalized.isBlank() -> "Enter the server URL from ./scripts/diagnose-phone-connect.sh."
            !normalized.startsWith("http://") && !normalized.startsWith("https://") -> "Server URL must start with http:// or https://."
            else -> null
        }
    }

    fun isTailscaleUrl(serverUrl: String): Boolean {
        val host = serverUrl.trim()
            .removePrefix("http://")
            .removePrefix("https://")
            .substringBefore("/")
            .substringBefore(":")
        return host.startsWith("100.")
    }

    fun messageForHttpStatus(statusCode: Int): String = when (statusCode) {
        401, 403 -> AUTH_MESSAGE
        404 -> "Server endpoint was not found. Check that the app is pointed at agent-phone on port 8799."
        else -> "Server returned HTTP $statusCode. Check server logs and run ./scripts/diagnose-phone-connect.sh."
    }

    fun messageForFailure(message: String?): String {
        val text = message.orEmpty()
        val lower = text.lowercase()
        return when {
            lower.contains("127.0.0.1") || lower.contains("localhost") -> LOOPBACK_MESSAGE
            lower.contains("timeout") || lower.contains("timed out") || lower.contains("failed to connect") || lower.contains("unreachable") -> TIMEOUT_MESSAGE
            lower.contains("401") || lower.contains("403") || lower.contains("unauthorized") -> AUTH_MESSAGE
            lower.contains("extension 100") || lower.contains("extension_not_found") -> EXTENSION_100_MESSAGE
            lower.contains("connection refused") -> "Server is not accepting connections. Start it with SERVER_HOST=0.0.0.0 SERVER_PORT=8799 ./scripts/run-server.sh."
            else -> text.ifBlank { "Request failed. Run ./scripts/diagnose-phone-connect.sh on the server." }
        }
    }
}
