package com.cindro.app.net

import android.util.Log
import com.google.gson.JsonObject
import com.cindro.app.crypto.DeviceIdentity
import com.cindro.app.protocol.Protocol
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * One-shot Contract C pairing handshake. Opens `/device/ws`, sends the `hello` frame
 * with the device public key, name **and** the one-time `pair_code` from the scanned
 * QR (or manual entry). The daemon stores the pubkey in devices.json and acks paired.
 *
 * Distinct from [DeviceClient] (which does the challenge/sign reconnect handshake for an
 * already-paired device); this runs exactly once, returns, and closes the socket.
 */
class PairingClient(private val identity: DeviceIdentity) {

    sealed interface Result {
        /** [fingerprint] is the daemon's identity fingerprint from the pairing ack's
         *  `fp` field (null on older daemons or the bare-`authed` fallback path). */
        data class Paired(val deviceId: String, val fingerprint: String? = null) : Result
        data class Failed(val reason: String) : Result
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    suspend fun pair(
        wsUrl: String,
        code: String,
        deviceName: String,
        timeoutMs: Long = 20_000,
    ): Result {
        val done = CompletableDeferred<Result>()
        val req = Request.Builder().url(wsUrl).build()
        val ws = http.newWebSocket(req, object : WebSocketListener() {

            override fun onOpen(ws: WebSocket, response: Response) {
                val hello = JsonObject().apply {
                    addProperty("hello", true)
                    addProperty("device_pubkey", identity.publicKeyB64)
                    addProperty("name", deviceName)
                    addProperty("pair_code", code)
                }
                ws.send(hello.toString())
            }

            override fun onMessage(ws: WebSocket, text: String) {
                val obj = Protocol.parse(text) ?: return
                when {
                    // Some daemons may issue a challenge even on the pair path
                    // (defense in depth); sign it to prove key possession.
                    obj.has("challenge") &&
                        obj.get("challenge").let { it.isJsonPrimitive && it.asJsonPrimitive.isString } -> {
                        val nonce = android.util.Base64.decode(
                            obj.get("challenge").asString, android.util.Base64.NO_WRAP,
                        )
                        ws.send(JsonObject().apply {
                            addProperty("sig", identity.sign(nonce))
                        }.toString())
                    }

                    obj.has("paired") || obj.get("event")?.takeIf { it.isJsonPrimitive }?.asString == "paired" -> {
                        // A present `paired` must be a real boolean; a malformed value
                        // must NOT persist a false pairing. Only the legacy event-only
                        // shape ({"event":"paired"}, no boolean field) is success by presence.
                        val pairedEl = obj.get("paired")
                        val ok = if (pairedEl != null) {
                            pairedEl.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }
                                ?.asBoolean ?: false
                        } else {
                            true
                        }
                        if (ok) {
                            val id = obj.get("device_id")?.takeIf { it.isJsonPrimitive }?.asString ?: identity.fingerprint
                            val fp = obj.get("fp")
                                ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }
                                ?.asString
                            complete(done, ws, Result.Paired(id, fp))
                        } else {
                            complete(done, ws, Result.Failed("daemon refused pairing"))
                        }
                    }

                    obj.has("authed") -> {
                        // Treat a bare authed ack as success too.
                        complete(done, ws, Result.Paired(identity.fingerprint, null))
                    }

                    obj.has("error") && obj.get("error").isJsonObject -> {
                        val msg = obj.get("error")?.takeIf { it.isJsonObject }?.asJsonObject
                            ?.get("message")?.takeIf { it.isJsonPrimitive }?.asString
                            ?: "pairing error"
                        complete(done, ws, Result.Failed(msg))
                    }
                }
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "pairing failure: ${t.message}")
                complete(done, ws, Result.Failed(t.message ?: "could not reach daemon"))
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (!done.isCompleted) {
                    done.complete(Result.Failed("connection closed before pairing"))
                }
            }
        })

        return try {
            withTimeout(timeoutMs) { done.await() }
        } catch (e: TimeoutCancellationException) {
            ws.close(1000, "timeout")
            Result.Failed("pairing timed out — is the code still showing on the desktop?")
        } finally {
            ws.close(1000, null)
        }
    }

    private fun complete(done: CompletableDeferred<Result>, ws: WebSocket, result: Result) {
        if (!done.isCompleted) done.complete(result)
        ws.close(1000, null)
    }

    companion object {
        private const val TAG = "PairingClient"
    }
}
