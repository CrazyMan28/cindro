package com.jarvis.app.net

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.jarvis.app.crypto.DeviceIdentity
import com.jarvis.app.data.HostPort
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.SecretStore
import com.jarvis.app.protocol.BrainEvent
import com.jarvis.app.protocol.Params
import com.jarvis.app.protocol.QueuedTask
import com.jarvis.app.protocol.Session
import com.jarvis.app.protocol.SessionEvent
import com.jarvis.app.protocol.Tier
import com.jarvis.app.protocol.WsResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map

/**
 * Single process-wide gateway to the daemon over the authed device WebSocket. Owns the
 * [DeviceClient], exposes typed methods for the Contract C authed surface
 * (session.list/create/send/history/cancel, task.queue/list, push.register,
 * approval.respond), and re-publishes connection state + the session.event stream.
 */
class JarvisRepository(
    private val identity: DeviceIdentity,
    private val pairingStore: PairingStore,
    private val secretStore: SecretStore,
) {
    private val client = DeviceClient(
        identity = identity,
        onAuthFailure = { /* surfaced via state; pairing screen handles re-pair */ },
    )

    val connectionState: StateFlow<DeviceClient.State> get() = client.state
    val lastError: StateFlow<String?> get() = client.lastError
    val events: SharedFlow<SessionEvent> get() = client.events

    /** Open (or retarget) the device socket using the stored host:port. */
    fun connect() {
        val raw = pairingStore.hostPort ?: PairingStore.DEFAULT_HOST_PORT
        val hp = HostPort.parse(raw) ?: return
        client.connect(hp.wsUrl(), pairingStore.deviceName)
    }

    fun disconnect() = client.shutdown()

    /** Events scoped to one session, mapped to their BrainEvent payload. */
    fun eventsFor(sessionId: String): Flow<BrainEvent> =
        events.filter { it.sessionId == sessionId }.map { it.event }

    // --- read tier ---------------------------------------------------------

    suspend fun listSessions(): List<Session> {
        val r = client.request("session.list").orThrow()
        return r.getAsJsonArray("sessions")?.toObjects()?.map(Session::from) ?: emptyList()
    }

    suspend fun history(sessionId: String, limit: Int = 200): List<BrainEvent> {
        val r = client.request(
            "session.history",
            Params.of("session_id" to sessionId, "limit" to limit),
        ).orThrow()
        return r.getAsJsonArray("events")?.toObjects()?.map { evObj ->
            // history events may be wrapped as {ev:{...}} or be the raw event.
            BrainEvent.from(evObj.getAsJsonObject("ev") ?: evObj)
        } ?: emptyList()
    }

    suspend fun listTasks(): List<QueuedTask> {
        val r = client.request("task.list").orThrow()
        return r.getAsJsonArray("tasks")?.toObjects()?.map(QueuedTask::from) ?: emptyList()
    }

    // --- action tier -------------------------------------------------------

    suspend fun createSession(
        profile: String = "coworker",
        brain: String = "codex",
        model: String? = null,
    ): String {
        val r = client.request(
            "session.create",
            Params.of("profile" to profile, "brain" to brain, "model" to model),
        ).orThrow()
        return r.get("session_id")?.asString ?: error("no session_id returned")
    }

    /** Send a turn; [images] are (mime, base64) pairs attached as session.send images. */
    suspend fun send(sessionId: String, text: String, images: List<Pair<String, String>> = emptyList()) {
        val params = Params.of("session_id" to sessionId, "text" to text)
        if (images.isNotEmpty()) {
            val arr = JsonArray()
            images.forEach { (mime, b64) ->
                arr.add(JsonObject().apply {
                    addProperty("mime", mime)
                    addProperty("b64", b64)
                })
            }
            params.add("images", arr)
        }
        client.request("session.send", params).orThrow()
    }

    suspend fun cancel(sessionId: String) {
        client.request("session.cancel", Params.of("session_id" to sessionId)).orThrow()
    }

    suspend fun queueTask(text: String, whenAt: Long? = null) {
        client.request("task.queue", Params.of("text" to text, "when" to whenAt)).orThrow()
    }

    suspend fun registerPush(fcmToken: String) {
        client.request("push.register", Params.of("fcm_token" to fcmToken)).orThrow()
    }

    // --- biometric tier ----------------------------------------------------

    /** Respond to an approval card. Caller MUST have passed the BiometricPrompt first. */
    suspend fun respondApproval(sessionId: String, approvalId: String, decision: String) {
        client.request(
            "approval.respond",
            Params.of(
                "session_id" to sessionId,
                "approval_id" to approvalId,
                "decision" to decision,
            ),
        ).orThrow()
    }

    private fun WsResponse.orThrow(): JsonObject {
        if (!ok) throw JarvisRpcException(errorCode ?: "error", errorMessage ?: "request failed")
        return result ?: JsonObject()
    }

    private fun JsonArray.toObjects(): List<JsonObject> =
        mapNotNull { if (it.isJsonObject) it.asJsonObject else null }

    companion object {
        /**
         * The capability tier each Contract C method requires. The phone gates
         * [Tier.BIOMETRIC] methods behind a device BiometricPrompt.
         */
        fun tierOf(method: String): Tier = when (method) {
            "session.list", "session.history", "task.list" -> Tier.READ
            "session.create", "session.send", "session.cancel",
            "task.queue", "push.register" -> Tier.ACTION
            "approval.respond" -> Tier.BIOMETRIC
            else -> Tier.ACTION
        }
    }
}

class JarvisRpcException(val code: String, message: String) : Exception(message)
