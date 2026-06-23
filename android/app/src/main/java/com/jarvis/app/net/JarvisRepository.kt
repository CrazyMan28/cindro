package com.jarvis.app.net

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.jarvis.app.crypto.DeviceIdentity
import com.jarvis.app.data.HostPort
import com.jarvis.app.data.PairingStore
import com.jarvis.app.data.SecretStore
import com.jarvis.app.protocol.BrainEvent
import com.jarvis.app.protocol.FileOffer
import com.jarvis.app.protocol.McpServer
import com.jarvis.app.protocol.MemoryEntry
import com.jarvis.app.protocol.MirrorFrame
import com.jarvis.app.protocol.ModelInfo
import com.jarvis.app.protocol.Params
import com.jarvis.app.protocol.Plugin
import com.jarvis.app.protocol.QueuedTask
import com.jarvis.app.protocol.Session
import com.jarvis.app.protocol.SessionEvent
import com.jarvis.app.protocol.Skill
import com.jarvis.app.protocol.Tier
import com.jarvis.app.protocol.TodayItem
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

    /** Decoded binary mirror.frame JPEGs (Contract C live video). */
    val frames: SharedFlow<MirrorFrame> get() = client.frames

    /** file.offer pushes (device->phone). */
    val fileOffers: SharedFlow<FileOffer> get() = client.fileOffers

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

    /** Permanently delete a session (daemon cancels/tears it down first, then drops the row). */
    suspend fun deleteSession(sessionId: String) {
        client.request("session.delete", Params.of("session_id" to sessionId)).orThrow()
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

    // --- voice (Mistral Voxtral, daemon-proxied) ---------------------------

    /** STT: send recorded audio (base64) -> transcript. */
    suspend fun voiceStt(audioB64: String, mime: String = "audio/wav", lang: String? = null): String {
        val r = client.request(
            "voice.stt",
            Params.of("audio_b64" to audioB64, "mime" to mime, "lang" to lang),
            timeoutMs = 60_000,
        ).orThrow()
        return r.get("text")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
    }

    /** TTS: text -> {audioB64, mime}. Defaults to mp3 (ExoPlayer/MediaPlayer plays it). */
    suspend fun voiceTts(text: String, voice: String? = null, format: String = "mp3"): Pair<String, String>? {
        val r = client.request(
            "voice.tts",
            Params.of("text" to text, "voice" to voice, "format" to format),
            timeoutMs = 60_000,
        ).orThrow()
        val b64 = r.get("audio_b64")?.takeIf { !it.isJsonNull }?.asString ?: return null
        val mime = r.get("mime")?.takeIf { !it.isJsonNull }?.asString ?: "audio/mpeg"
        return b64 to mime
    }

    // --- settings / models (parity with desktop) ---------------------------

    suspend fun getSettings(): JsonObject = client.request("settings.get").orThrow()

    /** Apply a settings patch (biometric tier). Caller MUST clear the BiometricPrompt. */
    suspend fun setSettings(patch: JsonObject) {
        client.request("settings.set", Params.of("patch" to patch)).orThrow()
    }

    suspend fun listModels(brain: String): List<ModelInfo> {
        val r = client.request("model.list", Params.of("brain" to brain)).orThrow()
        return r.getAsJsonArray("models")?.toObjects()?.map(ModelInfo::from) ?: emptyList()
    }

    // --- MCP servers -------------------------------------------------------

    suspend fun listMcp(): List<McpServer> {
        val r = client.request("mcp.list").orThrow()
        return r.getAsJsonArray("servers")?.toObjects()?.map(McpServer::from) ?: emptyList()
    }

    /** Add an MCP server (biometric tier). */
    suspend fun addMcp(name: String, url: String?, command: String?) {
        client.request(
            "mcp.add",
            Params.of("name" to name, "url" to url, "command" to command),
        ).orThrow()
    }

    suspend fun removeMcp(name: String) {
        client.request("mcp.remove", Params.of("name" to name)).orThrow()
    }

    suspend fun setMcpEnabled(name: String, enabled: Boolean) {
        client.request("mcp.set_enabled", Params.of("name" to name, "enabled" to enabled)).orThrow()
    }

    /** Returns a human-readable test result (status/error string). */
    suspend fun testMcp(name: String): String {
        val r = client.request("mcp.test", Params.of("name" to name), timeoutMs = 45_000).orThrow()
        return r.get("status")?.takeIf { !it.isJsonNull }?.asString
            ?: r.get("ok")?.let { if (it.asBoolean) "ok" else "failed" }
            ?: r.toString()
    }

    // --- plugins -----------------------------------------------------------

    suspend fun pluginCatalog(): List<Plugin> {
        val r = client.request("plugins.catalog").orThrow()
        return r.getAsJsonArray("plugins")?.toObjects()?.map(Plugin::from) ?: emptyList()
    }

    suspend fun installPlugin(id: String) {
        client.request("plugins.install", Params.of("id" to id), timeoutMs = 60_000).orThrow()
    }

    suspend fun setPluginEnabled(id: String, enabled: Boolean) {
        client.request("plugins.set_enabled", Params.of("id" to id, "enabled" to enabled)).orThrow()
    }

    suspend fun removePlugin(id: String) {
        client.request("plugins.remove", Params.of("id" to id)).orThrow()
    }

    // --- memory ------------------------------------------------------------

    suspend fun listMemory(): List<MemoryEntry> {
        val r = client.request("memory.list").orThrow()
        return r.getAsJsonArray("memories")?.toObjects()?.map(MemoryEntry::from) ?: emptyList()
    }

    suspend fun searchMemory(query: String): List<MemoryEntry> {
        val r = client.request("memory.search", Params.of("query" to query)).orThrow()
        return r.getAsJsonArray("memories")?.toObjects()?.map(MemoryEntry::from) ?: emptyList()
    }

    suspend fun addMemory(content: String, target: String = "memory") {
        client.request("memory.add", Params.of("content" to content, "target" to target)).orThrow()
    }

    suspend fun removeMemory(id: String) {
        client.request("memory.remove", Params.of("id" to id)).orThrow()
    }

    // --- skills ------------------------------------------------------------

    suspend fun listSkills(): List<Skill> {
        val r = client.request("skills.list").orThrow()
        return r.getAsJsonArray("skills")?.toObjects()?.map(Skill::from) ?: emptyList()
    }

    suspend fun getSkill(name: String): Skill? {
        val r = client.request("skills.get", Params.of("name" to name)).orThrow()
        return r.getAsJsonObject("skill")?.let(Skill::from)
    }

    suspend fun createSkill(name: String, description: String, body: String) {
        client.request(
            "skills.create",
            Params.of("name" to name, "description" to description, "body" to body),
        ).orThrow()
    }

    suspend fun invokeSkill(name: String, args: String, sessionId: String?) {
        client.request(
            "skills.invoke",
            Params.of("name" to name, "args" to args, "session_id" to sessionId),
        ).orThrow()
    }

    suspend fun removeSkill(name: String) {
        client.request("skills.remove", Params.of("name" to name)).orThrow()
    }

    suspend fun today(): List<TodayItem> {
        val r = client.request("skills.today").orThrow()
        return r.getAsJsonArray("items")?.toObjects()?.map(TodayItem::from) ?: emptyList()
    }

    // --- computer: mirror + remote drive + take-over -----------------------

    /** Start the live video mirror for a session (biometric tier). Returns {width,height}. */
    suspend fun mirrorStart(sessionId: String): Pair<Int, Int> {
        val r = client.request("mirror.start", Params.of("session_id" to sessionId)).orThrow()
        val w = r.get("width")?.takeIf { !it.isJsonNull }?.asInt ?: 0
        val h = r.get("height")?.takeIf { !it.isJsonNull }?.asInt ?: 0
        return w to h
    }

    suspend fun mirrorStop(sessionId: String) {
        runCatching { client.request("mirror.stop", Params.of("session_id" to sessionId)).orThrow() }
    }

    /** Remote-drive: forward a tap/scroll into the session's nested desktop. */
    suspend fun remoteInput(sessionId: String, kind: String, params: JsonObject) {
        params.addProperty("session_id", sessionId)
        params.addProperty("kind", kind)
        client.request("input.event", params).orThrow()
    }

    /** Take over the laptop's real screen (biometric). Caller MUST clear the prompt. */
    suspend fun takeOver(sessionId: String?) {
        client.request("take_over.request", Params.of("session_id" to sessionId)).orThrow()
    }

    /** Push a file device->phone (the daemon delivers it as a file.offer). Unused on-phone. */
    suspend fun pushFile(name: String, b64: String, sessionId: String?) {
        client.request(
            "file.push",
            Params.of("name" to name, "b64" to b64, "session_id" to sessionId),
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
            "session.list", "session.history", "task.list",
            "settings.get", "model.list", "mcp.list",
            "plugins.catalog", "plugins.list",
            "memory.list", "memory.search",
            "skills.list", "skills.get", "skills.today" -> Tier.READ

            "session.create", "session.send", "session.cancel", "session.delete",
            "task.queue", "push.register", "voice.stt", "voice.tts",
            "plugins.install", "plugins.set_enabled", "plugins.remove",
            "memory.add", "memory.remove",
            "skills.create", "skills.invoke", "skills.remove",
            "mcp.remove", "mcp.set_enabled", "mcp.test",
            "input.event" -> Tier.ACTION

            // Biometric: anything that changes config/secrets or seizes the screen.
            "approval.respond", "settings.set", "mcp.add",
            "take_over.request", "file.push",
            "mirror.start", "mirror.stop" -> Tier.BIOMETRIC

            else -> Tier.ACTION
        }
    }
}

class JarvisRpcException(val code: String, message: String) : Exception(message)
