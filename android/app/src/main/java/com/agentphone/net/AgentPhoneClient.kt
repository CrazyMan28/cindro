package com.agentphone.net

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.agentphone.state.AgentPhoneSettings
import com.agentphone.state.ConnectionTroubleshooter
import com.agentphone.state.ReconnectBackoff
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class ApiResult(
    val ok: Boolean,
    val statusCode: Int? = null,
    val body: String = "",
    val error: String? = null
)

private enum class MainWsState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATING,
    ONLINE,
    RECONNECTING,
    ERROR
}

class AgentPhoneClient(
    private val onEvent: (PhoneEvent) -> Unit,
    private val onStatus: (String) -> Unit
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // A WebSocket is long-lived and idle between events. A 10s readTimeout
        // killed the socket (code 1006) before the 20s keepalive ping ever ran,
        // causing a reconnect storm where the phone was almost never connected
        // (so calls/texts never arrived). Disable the read timeout and let
        // pingInterval detect dead connections.
        .readTimeout(0, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var webSocket: WebSocket? = null
    private var activeSocketId = 0L
    private var nextSocketId = 0L
    private var lastUrl: String? = null
    private var activeSettings: AgentPhoneSettings? = null
    private var shouldReconnect = true
    private var state = MainWsState.DISCONNECTED
    private var reconnectRunnable: Runnable? = null
    private var lastManualConnectMs = 0L
    private var reconnectAttempt = 0

    fun connect(settings: AgentPhoneSettings) {
        activeSettings = settings
        val now = SystemClock.elapsedRealtime()
        if (state == MainWsState.ONLINE) {
            Log.i(TAG, "connect ignored; already online")
            onStatus(MainWsState.ONLINE.name)
            return
        }
        if (state == MainWsState.CONNECTING || state == MainWsState.AUTHENTICATING || state == MainWsState.RECONNECTING) {
            Log.i(TAG, "connect ignored; already connecting")
            return
        }
        if (now - lastManualConnectMs < CONNECT_DEBOUNCE_MS) {
            Log.i(TAG, "connect ignored; already connecting")
            return
        }
        lastManualConnectMs = now
        startMainSocket(settings, MainWsState.CONNECTING, closeExistingReason = null)
    }

    fun connect(websocketUrl: String) {
        val settings = activeSettings?.copy(serverUrl = websocketUrl.removePrefix("ws://").removePrefix("wss://").substringBefore("/ws"))
            ?: AgentPhoneSettings(serverUrl = websocketUrl.removePrefix("ws://").removePrefix("wss://").substringBefore("/ws"))
        connect(settings)
    }

    fun manualReconnect(settings: AgentPhoneSettings) {
        Log.i(TAG, "manual reconnect requested")
        activeSettings = settings
        lastManualConnectMs = SystemClock.elapsedRealtime()
        startMainSocket(settings, MainWsState.CONNECTING, closeExistingReason = "manual reconnect")
    }

    fun disconnect() {
        shouldReconnect = false
        clearReconnectTimer()
        reconnectAttempt = 0
        state = MainWsState.DISCONNECTED
        val old = webSocket
        webSocket = null
        activeSocketId += 1
        old?.close(1000, "user disconnect")
        onStatus(MainWsState.DISCONNECTED.name)
    }

    fun dial(fromExtension: String, toExtension: String): Boolean {
        return send(PhoneCommandFactory.dial(fromExtension, toExtension))
    }

    fun accept(callId: String, extension: String): Boolean {
        return send(PhoneCommandFactory.accept(callId, extension))
    }

    fun reject(callId: String, extension: String): Boolean {
        return send(PhoneCommandFactory.reject(callId, extension))
    }

    fun end(callId: String, extension: String): Boolean {
        return send(PhoneCommandFactory.end(callId, extension))
    }

    fun sendText(callId: String, fromExtension: String, text: String): Boolean {
        return send(PhoneCommandFactory.text(callId, fromExtension, text))
    }

    fun screeningTakeOver(callId: String, extension: String): Boolean {
        return send(PhoneCommandFactory.screeningTakeOver(callId, extension))
    }

    fun screeningEnd(callId: String, extension: String): Boolean {
        return send(PhoneCommandFactory.screeningEnd(callId, extension))
    }

    fun audioStart(callId: String, fromExtension: String, audioFormat: String = "pcm_s16le", sampleRate: Int = 16_000, channels: Int = 1): Boolean {
        return send(PhoneCommandFactory.audioStart(callId, fromExtension, audioFormat, sampleRate, channels))
    }

    fun audioChunk(callId: String, fromExtension: String, audioBase64: String): Boolean {
        return send(PhoneCommandFactory.audioChunk(callId, fromExtension, audioBase64))
    }

    fun audioEnd(callId: String, fromExtension: String): Boolean {
        return send(PhoneCommandFactory.audioEnd(callId, fromExtension))
    }

    fun ackMessage(messageId: String): Boolean = send(PhoneCommandFactory.messageAck(messageId))

    fun markMessageRead(messageId: String): Boolean = send(PhoneCommandFactory.messageRead(messageId))

    fun replyMessage(messageId: String, responseText: String?, selectedOption: String?): Boolean =
        send(PhoneCommandFactory.messageReply(messageId, responseText, selectedOption))

    fun getPendingMessages(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(
            settings.serverUrl,
            "/api/messages?extension=${settings.extension}&status=queued",
            settings.token,
            callback
        )
    }

    fun postMessageRead(settings: AgentPhoneSettings, messageId: String, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/messages/$messageId/read", settings.token, JSONObject(), callback)
    }

    fun postMessageReply(
        settings: AgentPhoneSettings,
        messageId: String,
        responseText: String?,
        selectedOption: String?,
        callback: (ApiResult) -> Unit
    ) {
        val body = JSONObject()
        if (!responseText.isNullOrBlank()) body.put("response_text", responseText)
        if (!selectedOption.isNullOrBlank()) body.put("selected_option", selectedOption)
        post(settings.serverUrl, "/api/messages/$messageId/reply", settings.token, body, callback)
    }

    fun getHealth(serverUrl: String, callback: (ApiResult) -> Unit) {
        get(serverUrl, "/health", token = null, callback = callback)
    }

    fun enrollAgent(settings: AgentPhoneSettings, body: JSONObject, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/agents/enroll", settings.token, body, callback)
    }

    fun getSetupStatus(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/setup/status", settings.token, callback)
    }

    fun getScreeningEnabled(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/screening", settings.token, callback)
    }

    fun setScreeningEnabled(settings: AgentPhoneSettings, enabled: Boolean, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/screening", settings.token, JSONObject().put("enabled", enabled), callback)
    }

    /** Who SCREENS unknown callers. */
    fun setScreeningAgent(settings: AgentPhoneSettings, extension: String, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/screening", settings.token, JSONObject().put("screening_extension", extension), callback)
    }

    /** Who answers when YOU (allowlisted) dial the Twilio number. */
    fun setInboundAgent(settings: AgentPhoneSettings, extension: String, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/screening", settings.token, JSONObject().put("inbound_extension", extension), callback)
    }

    /** Choose the screening transport: "twilio" (carrier-forwarded) or "relay" (Bluetooth puck). */
    fun setScreeningTransport(settings: AgentPhoneSettings, transport: String, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/screening", settings.token, JSONObject().put("transport", transport), callback)
    }

    /** "Text your agent" over SMS: master switch + which agent answers inbound texts. */
    fun getSmsAgent(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/sms-agent", settings.token, callback)
    }

    fun setSmsAgentEnabled(settings: AgentPhoneSettings, enabled: Boolean, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/sms-agent", settings.token, JSONObject().put("enabled", enabled), callback)
    }

    fun setSmsAgent(settings: AgentPhoneSettings, extension: String, callback: (ApiResult) -> Unit) {
        post(settings.serverUrl, "/api/sms-agent", settings.token, JSONObject().put("extension", extension), callback)
    }

    fun getExtensions(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/extensions", settings.token, callback)
    }

    fun getAgents(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/agents", settings.token, callback)
    }

    /** Start a new chat (threadId null) or continue one (threadId set) with an agent. */
    fun createMessage(settings: AgentPhoneSettings, toExtension: String, body: String, threadId: String?, callback: (ApiResult) -> Unit) {
        val payload = JSONObject()
            .put("to_extension", toExtension)
            .put("from_extension", settings.extension)
            .put("body", body)
        if (!threadId.isNullOrBlank()) payload.put("thread_id", threadId)
        post(settings.serverUrl, "/api/messages", settings.token, payload, callback)
    }

    /** Start a group chat: broadcast an opening message to several agents at once. */
    fun createGroupChat(settings: AgentPhoneSettings, members: List<String>, body: String, callback: (ApiResult) -> Unit) {
        val payload = JSONObject()
            .put("from_extension", settings.extension)
            .put("members", JSONArray(members))
            .put("message", body)
        post(settings.serverUrl, "/api/group-chat", settings.token, payload, callback)
    }

    /** Start a conference CALL with only the chosen agents (voice twin of group chat). */
    fun startConference(settings: AgentPhoneSettings, members: List<String>, callback: (ApiResult) -> Unit) {
        val payload = JSONObject()
            .put("from_extension", settings.extension)
            .put("members", JSONArray(members))
        post(settings.serverUrl, "/api/conference", settings.token, payload, callback)
    }

    /** Voice catalog for the per-agent voice picker. */
    fun getVoices(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/voices", settings.token, callback)
    }

    fun getVoiceProfile(settings: AgentPhoneSettings, extension: String, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/extensions/$extension/voice", settings.token, callback)
    }

    /** Set (or clear with null) an agent's call voice. */
    fun putVoiceProfile(settings: AgentPhoneSettings, extension: String, voiceId: String?, voiceName: String?, callback: (ApiResult) -> Unit) {
        val payload = JSONObject()
        payload.put("voiceId", voiceId ?: JSONObject.NULL)
        payload.put("name", voiceName ?: JSONObject.NULL)
        put(settings.serverUrl, "/api/extensions/$extension/voice", settings.token, payload, callback)
    }

    /** Set ONLY the speaking rate (must not touch voiceId — null would clear it). */
    fun putVoiceSpeed(settings: AgentPhoneSettings, extension: String, speed: Double, callback: (ApiResult) -> Unit) {
        put(settings.serverUrl, "/api/extensions/$extension/voice", settings.token, JSONObject().put("speed", speed), callback)
    }

    /** On-device voice manifest (model file sizes for cache invalidation). */
    fun getLocalVoiceManifest(settings: AgentPhoneSettings, callback: (String?) -> Unit) {
        get(settings.serverUrl, "/api/local-voices", settings.token) { r -> callback(if (r.ok) r.body else null) }
    }

    /** Download a small binary (e.g. a voice preview sample) to a file. */
    fun downloadFile(settings: AgentPhoneSettings, path: String, dest: java.io.File, callback: (Boolean) -> Unit) {
        val request = try {
            Request.Builder()
                .url(settings.serverUrl.trim().removeSuffix("/") + path)
                .apply { if (settings.token.isNotBlank()) header("Authorization", "Bearer ${settings.token}") }
                .get()
                .build()
        } catch (_: Throwable) {
            main.post { callback(false) }
            return
        }
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { callback(false) }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    // STREAM to disk — buffering a 114MB voice model through
                    // body.bytes() risked OOM on the phone.
                    val ok = it.isSuccessful && try {
                        val body = it.body
                        if (body == null) false
                        else {
                            body.byteStream().use { input ->
                                java.io.FileOutputStream(dest).use { out -> input.copyTo(out, 64 * 1024) }
                            }
                            dest.length() > 0
                        }
                    } catch (_: Throwable) { dest.delete(); false }
                    main.post { callback(ok) }
                }
            }
        })
    }

    fun deleteThread(settings: AgentPhoneSettings, threadId: String, callback: (ApiResult) -> Unit) {
        httpDelete(settings.serverUrl, "/api/message-threads/$threadId", settings.token, callback)
    }

    fun getCalls(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/calls", settings.token, callback)
    }

    fun getMissedCalls(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/missed-calls?extension=${settings.extension}", settings.token, callback)
    }

    fun probeWebSocket(settings: AgentPhoneSettings, callback: (ApiResult) -> Unit) {
        Log.i(TAG, "diagnostics ws test started")
        if (state == MainWsState.ONLINE) {
            Log.i(TAG, "diagnostics ws test finished")
            callback(ApiResult(true, statusCode = 101, body = "main websocket online"))
            return
        }
        val request = try {
            Request.Builder().url(settings.websocketUrl()).build()
        } catch (error: IllegalArgumentException) {
            Log.i(TAG, "diagnostics ws test finished")
            callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(error.message)))
            return
        }
        var completed = false
        lateinit var socket: WebSocket
        fun finish(result: ApiResult) {
            if (completed) return
            completed = true
            Log.i(TAG, "diagnostics ws test finished")
            main.post { callback(result) }
        }
        val timeout = Runnable {
            if (completed) return@Runnable
            socket.close(1001, "diagnostics timeout")
            finish(ApiResult(false, error = ConnectionTroubleshooter.TIMEOUT_MESSAGE))
        }
        main.postDelayed(timeout, DIAGNOSTICS_TIMEOUT_MS)
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "opened diagnostics socket")
                webSocket.send(PhoneCommandFactory.auth(settings).toString())
                Log.i(TAG, "auth sent diagnostics extension ${settings.extension}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = PhoneEventParser.parse(text)
                if (event.type == "hello" && event.raw.optString("extension") == settings.extension) {
                    main.removeCallbacks(timeout)
                    webSocket.close(1000, "diagnostics complete")
                    finish(ApiResult(true, statusCode = 101, body = "authenticated"))
                } else if (event.type == "error") {
                    main.removeCallbacks(timeout)
                    val message = event.raw.optString("message", "websocket auth failed")
                    webSocket.close(1002, message)
                    finish(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(message)))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!completed) {
                    main.removeCallbacks(timeout)
                    finish(ApiResult(false, error = "WebSocket closed before auth completed: $code ${reason.ifBlank { "(no reason)" }}"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.removeCallbacks(timeout)
                val error = response?.let { ConnectionTroubleshooter.messageForHttpStatus(it.code) }
                    ?: ConnectionTroubleshooter.messageForFailure(t.message)
                finish(ApiResult(false, response?.code, error = error))
            }
        })
    }

    private fun startMainSocket(settings: AgentPhoneSettings, nextState: MainWsState, closeExistingReason: String?) {
        clearReconnectTimer()
        shouldReconnect = true
        activeSettings = settings
        val url = settings.websocketUrl()
        lastUrl = url
        val old = webSocket
        val socketId = ++nextSocketId
        activeSocketId = socketId
        setState(nextState)
        Log.i(TAG, "connecting URL $url")
        val request = try {
            Request.Builder().url(url).build()
        } catch (error: IllegalArgumentException) {
            Log.e(TAG, "failure exception", error)
            setError(ConnectionTroubleshooter.messageForFailure(error.message))
            return
        }
        webSocket = http.newWebSocket(request, mainListener(socketId))
        if (closeExistingReason != null) old?.close(1000, closeExistingReason)
    }

    private fun mainListener(socketId: Long) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isActiveSocket(socketId)) return
            Log.i(TAG, "main ws opened")
            val settings = activeSettings
            if (settings == null) {
                setError("missing Android settings for WebSocket auth")
                return
            }
            setState(MainWsState.AUTHENTICATING)
            webSocket.send(PhoneCommandFactory.auth(settings).toString())
            Log.i(TAG, "auth sent extension ${settings.extension}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isActiveSocket(socketId)) return
            val event = PhoneEventParser.parse(text)
            when (event.type) {
                "hello" -> {
                    Log.i(TAG, "hello received")
                    val settings = activeSettings
                    if (settings != null && event.raw.optString("extension") == settings.extension) {
                        send(PhoneCommandFactory.presence(settings))
                        Log.i(TAG, "main ws authenticated")
                        reconnectAttempt = 0
                        clearReconnectTimer()
                        setState(MainWsState.ONLINE)
                    }
                }
                "presence_update" -> Log.i(TAG, "presence update received ${event.raw}")
                "incoming_call" -> Log.i(TAG, "incoming call")
                "error" -> setError(event.raw.optString("message", "websocket error"), scheduleReconnect = false)
            }
            main.post { onEvent(event) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "main ws closed code=$code reason=${reason.ifBlank { "(none)" }}")
            if (!isActiveSocket(socketId)) return
            if (!shouldReconnect || reason == "user disconnect") {
                setState(MainWsState.DISCONNECTED)
                return
            }
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.e(TAG, "failure exception", t)
            if (!isActiveSocket(socketId)) return
            val error = response?.let { ConnectionTroubleshooter.messageForHttpStatus(it.code) }
                ?: ConnectionTroubleshooter.messageForFailure(t.message)
            setError(error)
        }
    }

    private fun send(json: JSONObject): Boolean {
        return webSocket?.send(json.toString()) == true
    }

    private fun post(serverUrl: String, path: String, token: String?, body: JSONObject, callback: (ApiResult) -> Unit) {
        val url = serverUrl.trim().removeSuffix("/") + path
        val request = try {
            val builder = Request.Builder().url(url)
                .post(body.toString().toRequestBody(JSON_MEDIA))
            if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            builder.build()
        } catch (error: IllegalArgumentException) {
            main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(error.message))) }
            return
        }
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(e.message))) }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string().orEmpty()
                    val result = if (it.isSuccessful) {
                        ApiResult(true, it.code, text)
                    } else {
                        ApiResult(false, it.code, text, ConnectionTroubleshooter.messageForHttpStatus(it.code))
                    }
                    main.post { callback(result) }
                }
            }
        })
    }

    fun getModelConfig(settings: AgentPhoneSettings, extension: String, callback: (ApiResult) -> Unit) {
        get(settings.serverUrl, "/api/extensions/$extension/model", settings.token, callback)
    }

    fun putModelConfig(settings: AgentPhoneSettings, extension: String, model: String?, reasoning: String?, callback: (ApiResult) -> Unit) {
        val payload = JSONObject()
        if (model != null) payload.put("model", model)
        if (reasoning != null) payload.put("reasoning", reasoning)
        put(settings.serverUrl, "/api/extensions/$extension/model", settings.token, payload, callback)
    }

    private fun put(serverUrl: String, path: String, token: String?, body: JSONObject, callback: (ApiResult) -> Unit) {
        val url = serverUrl.trim().removeSuffix("/") + path
        val request = try {
            val builder = Request.Builder().url(url).put(body.toString().toRequestBody(JSON_MEDIA))
            if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            builder.build()
        } catch (error: IllegalArgumentException) {
            main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(error.message))) }
            return
        }
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(e.message))) }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string().orEmpty()
                    main.post { callback(if (it.isSuccessful) ApiResult(true, it.code, text) else ApiResult(false, it.code, text, ConnectionTroubleshooter.messageForHttpStatus(it.code))) }
                }
            }
        })
    }

    private fun httpDelete(serverUrl: String, path: String, token: String?, callback: (ApiResult) -> Unit) {
        val url = serverUrl.trim().removeSuffix("/") + path
        val request = try {
            val builder = Request.Builder().url(url).delete()
            if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            builder.build()
        } catch (error: IllegalArgumentException) {
            main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(error.message))) }
            return
        }
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(e.message))) }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string().orEmpty()
                    val result = if (it.isSuccessful) ApiResult(true, it.code, text)
                    else ApiResult(false, it.code, text, ConnectionTroubleshooter.messageForHttpStatus(it.code))
                    main.post { callback(result) }
                }
            }
        })
    }

    private fun get(serverUrl: String, path: String, token: String?, callback: (ApiResult) -> Unit) {
        val url = serverUrl.trim().removeSuffix("/") + path
        val request = try {
            val builder = Request.Builder().url(url)
            if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            builder.build()
        } catch (error: IllegalArgumentException) {
            main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(error.message))) }
            return
        }
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { callback(ApiResult(false, error = ConnectionTroubleshooter.messageForFailure(e.message))) }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty()
                    val result = if (it.isSuccessful) {
                        ApiResult(true, it.code, body)
                    } else {
                        ApiResult(false, it.code, body, ConnectionTroubleshooter.messageForHttpStatus(it.code))
                    }
                    main.post { callback(result) }
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        val settings = activeSettings ?: return
        setState(MainWsState.RECONNECTING)
        clearReconnectTimer()
        reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(ReconnectBackoff.MAX_ATTEMPT)
        val delayMs = ReconnectBackoff.delayForAttempt(reconnectAttempt)
        val runnable = Runnable {
            if (!shouldReconnect) return@Runnable
            if (state == MainWsState.ONLINE || state == MainWsState.CONNECTING || state == MainWsState.AUTHENTICATING) return@Runnable
            startMainSocket(settings, MainWsState.CONNECTING, closeExistingReason = null)
        }
        reconnectRunnable = runnable
        main.postDelayed(runnable, delayMs)
    }

    private fun clearReconnectTimer() {
        reconnectRunnable?.let { main.removeCallbacks(it) }
        reconnectRunnable = null
    }

    private fun setError(message: String, scheduleReconnect: Boolean = true) {
        state = MainWsState.ERROR
        main.post { onStatus("${MainWsState.ERROR.name}: $message") }
        if (scheduleReconnect && shouldReconnect) scheduleReconnect()
    }

    private fun setState(next: MainWsState) {
        state = next
        main.post { onStatus(next.name) }
    }

    private fun isActiveSocket(socketId: Long): Boolean = socketId == activeSocketId

    companion object {
        private const val TAG = "AgentPhoneWS"
        private const val CONNECT_DEBOUNCE_MS = 900L
        private const val DIAGNOSTICS_TIMEOUT_MS = 5000L
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
