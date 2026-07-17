package com.cindro.app.net

import android.util.Log
import com.google.gson.JsonObject
import com.cindro.app.crypto.DeviceIdentity
import com.cindro.app.data.PairingStore
import com.cindro.app.protocol.AuthChallenge
import com.cindro.app.protocol.Protocol
import com.cindro.app.protocol.FileOfferEvent
import com.cindro.app.protocol.FileOffer
import com.cindro.app.protocol.WidgetEvent
import com.cindro.app.protocol.MirrorFrame
import com.cindro.app.protocol.SessionEvent
import com.cindro.app.protocol.SessionOpened
import com.cindro.app.protocol.SessionOpenedEvent
import com.cindro.app.protocol.WsResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Long-lived Contract C device WebSocket client (`ws://<host>:<port>/device/ws`).
 *
 * Lifecycle per connection:
 *  1. Open the socket.
 *  2. **Handshake** — for an already-paired device we send
 *     `{"hello":true,"device_pubkey":<b64>,"name":<str>}`; the daemon replies
 *     `{"challenge":<nonce-b64>}`; we sign the raw nonce bytes and send
 *     `{"sig":<b64>}`; the daemon acks `{"authed":true}`. (Pairing — the
 *     `pair_code` path — is handled separately by [PairingClient] before this
 *     client ever runs.)
 *  3. **Authed envelope phase** — Contract A request/response + session.event frames.
 *
 * Requests are correlated by monotonically increasing `id`; [request] suspends until
 * the matching response (or times out). Unsolicited `session.event` frames are emitted
 * on [events]. The socket auto-reconnects with jittered backoff while [shouldRun].
 */
class DeviceClient(
    private val identity: DeviceIdentity,
    private val pairingStore: PairingStore? = null,
    private val onAuthFailure: () -> Unit = {},
) {
    enum class State { DISCONNECTED, CONNECTING, HANDSHAKING, CONNECTED, ERROR }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // streaming socket
        .build()

    private val _state = MutableStateFlow(State.DISCONNECTED)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _events = MutableSharedFlow<SessionEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<SessionEvent> = _events.asSharedFlow()

    /**
     * Decoded binary `mirror.frame` JPEGs (Contract C video). Buffer is kept shallow
     * and overflow drops the oldest so a slow renderer can't back-pressure the socket.
     */
    private val _frames = MutableSharedFlow<MirrorFrame>(
        extraBufferCapacity = 4,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
    val frames: SharedFlow<MirrorFrame> = _frames.asSharedFlow()

    /** `file.offer` events: the daemon pushed a file (device->phone). */
    private val _fileOffers = MutableSharedFlow<FileOffer>(extraBufferCapacity = 16)
    val fileOffers: SharedFlow<FileOffer> = _fileOffers.asSharedFlow()

    /** `widget.render` / `widget.remove` / `widget.clear`: the model rendered a
     *  canvas/widget the daemon forwarded from the bus. */
    private val _widgetEvents = MutableSharedFlow<WidgetEvent>(extraBufferCapacity = 32)
    val widgetEvents: SharedFlow<WidgetEvent> = _widgetEvents.asSharedFlow()

    /** `session.opened` events: a new session was created (any surface) — open its chat. */
    private val _sessionOpened = MutableSharedFlow<SessionOpened>(extraBufferCapacity = 16)
    val sessionOpened: SharedFlow<SessionOpened> = _sessionOpened.asSharedFlow()

    /** `auth.challenge` events: a desktop/Chrome unlock request (the no-Firebase path). */
    private val _authChallenges = MutableSharedFlow<AuthChallenge>(extraBufferCapacity = 8)
    val authChallenges: SharedFlow<AuthChallenge> = _authChallenges.asSharedFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    /**
     * Soft, dismissible warning when a reconnect ack's daemon identity fingerprint
     * (`fp`) doesn't match the one pinned at pairing time. Never hard-blocks the
     * connection (anti-brick on a legit reinstall/key rotation) — advisory only.
     */
    private val _identityWarning = MutableStateFlow<String?>(null)
    val identityWarning: StateFlow<String?> = _identityWarning.asStateFlow()

    fun dismissIdentityWarning() { _identityWarning.value = null }

    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<WsResponse>>()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var authed = false
    @Volatile private var deviceName: String = "Android phone"

    @Volatile private var shouldRun = false
    @Volatile private var wsUrl: String? = null
    private var reconnectAttempts = 0

    /** A deferred that completes when the current connection finishes its handshake. */
    @Volatile private var authReady: CompletableDeferred<Boolean>? = null

    /** Start (or retarget) the connection. Safe to call repeatedly. */
    fun connect(url: String, name: String) {
        wsUrl = url
        deviceName = name
        shouldRun = true
        // Synchronize the check-then-open on `this` — the SAME monitor the reconnect
        // thread ([scheduleReconnect]) uses — so a caller thread and the reconnect
        // thread can't both see socket==null and open TWO WebSockets (TOCTOU).
        synchronized(this) { if (socket == null) openSocket() }
    }

    /** Permanently stop reconnecting and close the socket. */
    fun shutdown() {
        shouldRun = false
        authed = false
        socket?.close(1000, "client shutdown")
        socket = null
        failAllPending("client shutdown")
        _state.value = State.DISCONNECTED
    }

    private fun openSocket() {
        val url = wsUrl ?: return
        _state.value = State.CONNECTING
        authed = false
        authReady = CompletableDeferred()
        val req = Request.Builder().url(url).build()
        socket = http.newWebSocket(req, Listener())
    }

    /**
     * Send an authed Contract A request and await the response. Waits for the
     * handshake to finish first (up to [authTimeoutMs]).
     */
    suspend fun request(
        method: String,
        params: JsonObject = JsonObject(),
        timeoutMs: Long = 30_000,
        authTimeoutMs: Long = 15_000,
    ): WsResponse {
        awaitAuth(authTimeoutMs)
        val ws = socket ?: throw IllegalStateException("not connected")
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<WsResponse>()
        pending[id] = deferred
        val sent = ws.send(Protocol.request(id, method, params))
        if (!sent) {
            pending.remove(id)
            throw IllegalStateException("send failed (socket closing)")
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            pending.remove(id)
            throw IllegalStateException("request '$method' timed out")
        }
    }

    private suspend fun awaitAuth(timeoutMs: Long) {
        if (authed) return
        if (!shouldRun) { connect(wsUrl ?: error("no url"), deviceName) }
        val ready = authReady ?: CompletableDeferred<Boolean>().also { authReady = it }
        val ok = runCatching { withTimeout(timeoutMs) { ready.await() } }.getOrDefault(false)
        if (!ok || !authed) throw IllegalStateException("device not authenticated")
    }

    private fun failAllPending(reason: String) {
        val snapshot = pending.values.toList()
        pending.clear()
        snapshot.forEach { it.completeExceptionally(IllegalStateException(reason)) }
    }

    private inner class Listener : WebSocketListener() {

        override fun onOpen(ws: WebSocket, response: Response) {
            // Step 2 (handshake): send hello for an already-paired device.
            _state.value = State.HANDSHAKING
            val hello = JsonObject().apply {
                addProperty("hello", true)
                addProperty("device_pubkey", identity.publicKeyB64)
                addProperty("name", deviceName)
            }
            ws.send(hello.toString())
        }

        override fun onMessage(ws: WebSocket, text: String) {
            val obj = Protocol.parse(text) ?: return

            // --- handshake frames (no envelope) ---
            if (!authed) {
                if (obj.has("challenge")) {
                    val challengeEl = obj.get("challenge")
                    if (!challengeEl.isJsonPrimitive || !challengeEl.asJsonPrimitive.isString) {
                        // Malformed frame: drop it and keep handshaking rather than
                        // throwing out of asString (which tears the socket down).
                        return
                    }
                    val nonce = android.util.Base64.decode(challengeEl.asString, android.util.Base64.NO_WRAP)
                    val sig = identity.sign(nonce)
                    ws.send(JsonObject().apply { addProperty("sig", sig) }.toString())
                    return
                }
                if (obj.has("authed") || obj.get("event")?.takeIf { it.isJsonPrimitive }?.asString == "authed") {
                    val okAuth = obj.get("authed")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: true
                    if (okAuth) {
                        checkIdentityFingerprint(obj)
                        authed = true
                        reconnectAttempts = 0
                        _state.value = State.CONNECTED
                        _lastError.value = null
                        authReady?.complete(true)
                    } else {
                        handleAuthRejected(ws, "daemon rejected device")
                    }
                    return
                }
                if (obj.has("error") && obj.get("error").isJsonObject) {
                    val msg = obj.getAsJsonObject("error").get("message")
                        ?.takeIf { it.isJsonPrimitive }?.asString ?: "handshake error"
                    handleAuthRejected(ws, msg)
                    return
                }
                // Unrecognized pre-auth frame: drop it, don't fall through to the
                // authed envelope phase below.
                return
            }

            // --- authed envelope phase ---
            SessionEvent.from(obj)?.let { ev ->
                _events.tryEmit(ev)
                return
            }
            FileOfferEvent.from(obj)?.let { fo ->
                _fileOffers.tryEmit(fo.offer)
                return
            }
            WidgetEvent.from(obj)?.let { w ->
                _widgetEvents.tryEmit(w)
                return
            }
            SessionOpenedEvent.from(obj)?.let {
                _sessionOpened.tryEmit(it.opened)
                return
            }
            AuthChallenge.from(obj)?.let {
                _authChallenges.tryEmit(it)
                return
            }
            WsResponse.from(obj)?.let { resp ->
                pending.remove(resp.id)?.complete(resp)
                return
            }
        }

        override fun onMessage(ws: WebSocket, bytes: ByteString) {
            // Binary frame layout (Contract C video):
            //   [4-byte BE header length][header JSON utf8][JPEG bytes]
            //   header = {"t":"mirror.frame","session_id":..,"ts":..,"len":..}
            MirrorFrame.parse(bytes.toByteArray())?.let { _frames.tryEmit(it) }
        }

        override fun onClosing(ws: WebSocket, code: Int, reason: String) {
            ws.close(1000, null)
        }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            onDown("closed: $reason", retry = code != 1000)
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure: ${t.message}")
            onDown(t.message ?: "connection failed", retry = true)
        }
    }

    /**
     * Compare the reconnect ack's daemon identity fingerprint (`fp`) against the one
     * pinned at pairing time. Fail OPEN when nothing is pinned yet or the daemon
     * didn't send one (older daemon) — ordinary reconnects must keep working. On a
     * mismatch, surface a soft/dismissible warning; never hard-block the connection.
     */
    private fun checkIdentityFingerprint(obj: JsonObject) {
        val fpEl = obj.get("fp") ?: return
        if (!fpEl.isJsonPrimitive || !fpEl.asJsonPrimitive.isString) return
        val fp = fpEl.asString
        val pinned = pairingStore?.daemonFingerprint
        if (pinned.isNullOrBlank()) return
        _identityWarning.value = if (fp != pinned) {
            "This device's paired computer identity looks different from when you paired. " +
                "If you didn't reinstall or re-pair Cindro, consider re-pairing to be safe."
        } else {
            null
        }
    }

    private fun handleAuthRejected(ws: WebSocket, msg: String) {
        _lastError.value = msg
        authed = false
        authReady?.complete(false)
        _state.value = State.ERROR
        shouldRun = false
        ws.close(1000, "auth rejected")
        socket = null
        onAuthFailure()
    }

    private fun onDown(reason: String, retry: Boolean) {
        val wasAuthed = authed
        authed = false
        socket = null
        authReady?.takeIf { !it.isCompleted }?.complete(false)
        failAllPending(reason)
        if (shouldRun && retry) {
            _state.value = State.CONNECTING
            scheduleReconnect()
        } else {
            _state.value = if (wasAuthed) State.DISCONNECTED else State.ERROR
            _lastError.value = reason
        }
    }

    private fun scheduleReconnect() {
        reconnectAttempts++
        val base = (500L * (1 shl minOf(reconnectAttempts, 5))).coerceAtMost(15_000L)
        val jitter = (0..400).random().toLong()
        val delay = base + jitter
        Thread {
            try { Thread.sleep(delay) } catch (_: InterruptedException) { return@Thread }
            if (shouldRun && socket == null) {
                synchronized(this) { if (socket == null) openSocket() }
            }
        }.apply { isDaemon = true }.start()
    }

    companion object {
        private const val TAG = "DeviceClient"
    }
}
