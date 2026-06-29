package com.agentphone.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.telecom.TelecomManager
import android.util.Log
import com.agentphone.IncomingCallActivity
import com.agentphone.audio.LocalTtsEngine
import com.agentphone.audio.PushToTalkAudio
import com.agentphone.net.AgentPhoneClient
import com.agentphone.net.PhoneEvent
import com.agentphone.net.optStringOrNull
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.state.AgentPhoneSettings
import com.agentphone.state.InAppMessageStore
import com.agentphone.state.ScreeningStore
import com.agentphone.state.UiMessage
import com.agentphone.state.parseMessageList
import org.json.JSONObject

class AgentPhoneForegroundService : Service() {
    private var foregroundStarted = false
    private var settings = AgentPhoneSettings()
    private var activeCallId: String? = null
    private var activeCallInfo: IncomingCallInfo? = null
    private var webSocketOnline = false
    private var pendingAccept: IncomingCallInfo? = null
    private var pendingReject: IncomingCallInfo? = null
    private var pendingText: Pair<IncomingCallInfo, String>? = null
    /** action ("take_over"|"end") to callId, queued while the socket is offline. */
    private var pendingScreening: Pair<String, String>? = null
    /** Active screening transport, refreshed from GET /api/screening on connect. */
    @Volatile
    private var screeningTransport: String = "twilio"
    /** True on the S25 that auto-answered a relay call + routed its audio to the puck.
     *  Lets take-over/end (tapped on EITHER the S25 or the M507 transcript) re-route
     *  this phone's audio via the server's screening_ended event. */
    @Volatile
    private var relayAutoAnswerActive = false
    private val audio by lazy { PushToTalkAudio(this) }
    private val audioManager by lazy { getSystemService(AudioManager::class.java) }
    private val client by lazy {
        AgentPhoneClient(::handleEvent) { status ->
            Log.i(TAG, "WebSocket status $status")
            webSocketOnline = status == "ONLINE"
            AgentPhonePreferences.recordWebSocketState(this, status)
            if (status == "RECONNECTING" || status.startsWith("ERROR") || status == "DISCONNECTED") {
                AgentPhonePreferences.recordReconnectReason(this, status)
            }
            updateForeground(status)
            if (webSocketOnline) {
                flushPendingActions()
                fetchPendingMessages()
                refreshScreeningTransport()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = AgentPhonePreferences.loadSettings(this)
        AgentPhoneNotifications.ensureChannels(this)
        AgentPhonePreferences.markServiceRunning(this, true, "STARTING")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_DISCONNECT) {
            disconnectAndStop()
            return START_NOT_STICKY
        }

        settings = AgentPhonePreferences.loadSettings(this)
        ensureForeground("Starting background receiver")

        when (action) {
            ACTION_ACCEPT_CALL -> intent?.let { acceptCall(IncomingCallInfo.fromIntent(it)) }
            ACTION_REJECT_CALL -> intent?.let { rejectCall(IncomingCallInfo.fromIntent(it)) }
            ACTION_END_CALL -> endActiveCall(intent?.let { IncomingCallInfo.fromIntent(it) })
            ACTION_TEXT_FALLBACK -> sendTextFallback(intent)
            ACTION_AGENT_TAKE_NATIVE_CALL -> agentTakeNativeCall(intent?.getStringExtra(EXTRA_NUMBER).orEmpty())
            ACTION_RELAY_TAKE_OVER -> relayTakeOver(intent?.getStringExtra(EXTRA_CALL_ID).orEmpty())
            ACTION_RELAY_END -> relayEndCall()
            ACTION_SCREENING_TAKE_OVER -> intent?.getStringExtra(EXTRA_CALL_ID)?.let { screeningTakeOver(it) }
            ACTION_SCREENING_END -> intent?.getStringExtra(EXTRA_CALL_ID)?.let { screeningEnd(it) }
            ACTION_MARK_MESSAGE_READ -> intent?.getStringExtra(EXTRA_MESSAGE_ID)?.let { markMessageRead(it) }
            ACTION_REPLY_MESSAGE -> intent?.let { handleReplyIntent(it) }
            ACTION_START, ACTION_BOOT_START, ACTION_RETRY_START -> connectIfAllowed(intent?.getStringExtra(EXTRA_REASON) ?: action)
            else -> connectIfAllowed(action)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        audio.release()
        client.disconnect()
        AgentPhonePreferences.markServiceRunning(this, false, "DISCONNECTED")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun connectIfAllowed(reason: String) {
        if (!AgentPhonePreferences.isAlwaysOnEnabled(this)) {
            AgentPhonePreferences.recordReconnectReason(this, "Always-on disabled; service start ignored")
            stopSelf()
            return
        }
        AgentPhonePreferences.recordReconnectReason(this, "connect requested: $reason")
        client.connect(settings)
        updateForeground("Connecting")
    }

    private fun acceptCall(info: IncomingCallInfo) {
        if (info.callId.isBlank()) return
        activeCallId = info.callId
        activeCallInfo = info
        AgentPhoneNotifications.cancelIncomingCall(this, info.callId)
        if (!client.accept(info.callId, settings.extension)) {
            pendingAccept = info
            client.connect(settings)
        }
        // Answering from the notification should land you ON the call screen — open
        // the in-call UI directly (otherwise you'd just see the normal app with no
        // sign you're in a call).
        runCatching {
            startActivity(
                info.applyTo(Intent(this, IncomingCallActivity::class.java))
                    .setAction(IncomingCallActivity.ACTION_RESUME_CALL)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
        updateForeground("On call with ${info.agentName.ifBlank { "ext ${info.fromExtension}" }}")
    }

    private fun rejectCall(info: IncomingCallInfo) {
        if (info.callId.isBlank()) return
        AgentPhoneNotifications.cancelIncomingCall(this, info.callId)
        if (!client.reject(info.callId, settings.extension)) {
            pendingReject = info
            client.connect(settings)
        }
        if (activeCallId == info.callId) { activeCallId = null; activeCallInfo = null }
        updateForeground("Call rejected")
    }

    // The user (or the agent) ended an active call. Only this and an explicit
    // server-side end terminate it — leaving the call screen does NOT.
    private fun endActiveCall(info: IncomingCallInfo?) {
        val callId = info?.callId?.takeIf { it.isNotBlank() } ?: activeCallId ?: return
        AgentPhoneNotifications.cancelIncomingCall(this, callId)
        sendEndCall(callId)
        updateForeground("Agent Phone online as extension ${settings.extension}")
    }

    private fun sendTextFallback(intent: Intent?) {
        val info = intent?.let { IncomingCallInfo.fromIntent(it) } ?: return
        val text = intent.getStringExtra(EXTRA_TEXT).orEmpty()
        if (info.callId.isBlank() || text.isBlank()) return
        if (!client.sendText(info.callId, settings.extension, text)) {
            pendingText = info to text
            client.connect(settings)
        }
        AgentPhoneNotifications.cancelIncomingCall(this, info.callId)
        updateForeground("Text fallback sent")
    }

    private fun handleEvent(event: PhoneEvent) {
        when (event.type) {
            "hello" -> {
                webSocketOnline = true
                flushPendingActions()
                updateForeground("Agent Phone online as extension ${settings.extension}")
            }
            "incoming_call" -> handleIncomingCall(event)
            "call_accept" -> {
                event.callId?.let {
                    activeCallId = it
                    AgentPhoneNotifications.cancelIncomingCall(this, it)
                }
                audio.enterCallAudio(forceSpeaker = true)
                updateForeground("Agent call active")
            }
            "call_reject", "call_end", "call_failed", "call_timeout" -> {
                event.callId?.let {
                    AgentPhoneNotifications.cancelIncomingCall(this, it)
                    audio.clearTtsForCall(it)
                }
                if (event.callId == activeCallId) { activeCallId = null; activeCallInfo = null }
                audio.exitCallAudio()
                updateForeground("Agent Phone online as extension ${settings.extension}")
            }
            "tts_start" -> event.callId?.let { callId ->
                audio.beginTts(callId, event.messageId, event.audioFormat ?: "mp3", event.mimeType ?: "audio/mpeg")
            }
            "tts_chunk" -> event.callId?.let { callId ->
                event.audioBase64?.let { audio.appendTtsChunk(callId, event.messageId, it) }
            }
            "tts_end" -> event.callId?.let { callId ->
                audio.endTts(callId, event.messageId)
            }
            "tts_local" -> {
                // On-device voice: synthesize HERE (claim first — the in-app
                // socket gets the same event and only one instance may play).
                val callId = event.callId
                val voiceId = event.raw.optString("voiceId")
                val text = event.text ?: event.raw.optString("text")
                if (callId != null && voiceId.isNotBlank() && !text.isNullOrBlank() && audio.claimCallPlayback(callId)) {
                    val speed = event.raw.optDouble("speed", 1.0).toFloat()
                    Thread {
                        try {
                            if (LocalTtsEngine.ensureReady(this, client, settings, voiceId)) {
                                LocalTtsEngine.synthesizeToWav(this, voiceId, text, speed)?.let { wav ->
                                    audio.enqueueLocalTts(callId, event.messageId, wav)
                                }
                            }
                        } catch (_: Throwable) { /* logged by engine */ }
                    }.start()
                }
            }
            "audio_error" -> {
                // Utterance-scoped when the server names the failed message —
                // a call-wide clear cuts off other agents' queued speech.
                event.callId?.let { id ->
                    val mid = event.messageId
                    if (mid != null) audio.clearTtsUtterance(id, mid) else audio.clearTtsForCall(id)
                }
                AgentPhonePreferences.recordReconnectReason(this, event.message ?: "audio_error")
            }
            "message_new", "missed_call_fallback" -> handleMessageEvent(event, notify = true)
            "message_updated", "message_read", "message_reply" -> handleMessageEvent(event, notify = false)
            "call_live_log" -> handleMessageEvent(event, notify = false)
            "screening_started" -> handleScreeningStarted(event)
            "screening_update" -> ScreeningStore.append(
                event.callId,
                event.raw.optInt("seq", -1),
                event.raw.optString("speaker"),
                event.text ?: event.raw.optString("text")
            )
            "screening_ended" -> {
                val outcome = event.raw.optString("outcome", "ended")
                ScreeningStore.end(event.callId, outcome)
                event.callId?.let { AgentPhoneNotifications.cancelScreening(this, it) }
                // If THIS phone auto-answered the relay call, react to a take-over/end
                // that may have come from EITHER device (the S25 or the M507 transcript):
                // taken_over → pull audio back to the earpiece so the user talks;
                // ended → hang up the native call. Both clear the BT route.
                if (relayAutoAnswerActive) {
                    if (outcome == "taken_over") relayRouteAudioToEarpiece() else relayEndCall()
                    relayAutoAnswerActive = false
                }
                updateForeground("Agent Phone online as extension ${settings.extension}")
            }
            "send_sms" -> sendDeviceSms(event.raw.optString("number"), event.raw.optString("body"))
        }
    }

    /**
     * Send a REAL SMS from the user's OWN SIM/carrier — free, instant, no Twilio.
     * The server asks for this when an agent texts a real phone number.
     */
    private fun sendDeviceSms(number: String, body: String) {
        if (number.isBlank() || body.isBlank()) return
        if (checkSelfPermission(android.Manifest.permission.SEND_SMS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            AgentPhonePreferences.recordReconnectReason(this, "send_sms denied: SMS permission not granted")
            return
        }
        try {
            val sms = if (Build.VERSION.SDK_INT >= 31) getSystemService(android.telephony.SmsManager::class.java)
            else @Suppress("DEPRECATION") android.telephony.SmsManager.getDefault()
            val parts = sms.divideMessage(body)
            if (parts.size > 1) sms.sendMultipartTextMessage(number, null, parts, null, null)
            else sms.sendTextMessage(number, null, body, null, null)
            AgentPhonePreferences.recordReconnectReason(this, "sent SMS to $number via device SIM")
        } catch (error: Throwable) {
            AgentPhonePreferences.recordReconnectReason(this, "send_sms failed: ${error.message}")
        }
    }

    private fun handleScreeningStarted(event: PhoneEvent) {
        val callId = event.callId ?: return
        val callerNumber = event.raw.optString("callerNumber").ifBlank { "unknown number" }
        val forwardedFrom = event.raw.optStringOrNull("forwardedFrom")
        ScreeningStore.start(callId, callerNumber, forwardedFrom)
        AgentPhoneNotifications.cancelScreeningOffer(this)
        AgentPhoneNotifications.showScreeningCall(this, callId, callerNumber)
        updateForeground("Agent screening $callerNumber")
    }

    /**
     * The user tapped "Agent answers" on a ringing NATIVE call. The behaviour
     * depends on the active screening transport:
     *
     *  - "relay": auto-answer the native call here and route its audio to the
     *    paired Bluetooth relay puck (the agent runs on the puck side).
     *  - "twilio" (default): decline it so the carrier's conditional call
     *    forwarding routes the caller to the Twilio number, where the agent
     *    picks up and the screening session begins.
     */
    private fun agentTakeNativeCall(number: String) {
        if (screeningTransport == "relay") {
            relayAutoAnswer(number)
            return
        }
        AgentPhoneNotifications.cancelScreeningOffer(this)
        val ended = runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                val telecom = getSystemService(android.telecom.TelecomManager::class.java)
                @Suppress("DEPRECATION", "MissingPermission")
                telecom.endCall()
            } else {
                false
            }
        }.getOrDefault(false)
        AgentPhonePreferences.recordReconnectReason(
            this,
            if (ended) "screening: declined native call from $number — forwarding to agent"
            else "screening: could NOT decline native call from $number (decline it manually)"
        )
        updateForeground(if (ended) "Forwarding $number to your agent…" else "Decline the call to forward it to your agent")
    }

    /** GET /api/screening and cache the active transport ("twilio"|"relay"). */
    private fun refreshScreeningTransport() {
        client.getScreeningEnabled(settings) { result ->
            if (!result.ok) return@getScreeningEnabled
            val transport = try {
                JSONObject(result.body).optString("transport", "twilio")
            } catch (_: Throwable) { "twilio" }
            screeningTransport = if (transport == "relay") "relay" else "twilio"
            Log.i(TAG, "screening transport = $screeningTransport")
        }
    }

    /**
     * RELAY transport: auto-answer the ringing NATIVE call and route its audio to
     * the paired Bluetooth relay puck (the agent talks/listens through the puck's
     * SCO link). The puck triggers the server-side start_call itself when SCO
     * opens, so here we just answer + route + record state.
     */
    private fun relayAutoAnswer(number: String) {
        AgentPhoneNotifications.cancelScreeningOffer(this)
        if (Build.VERSION.SDK_INT >= 31 &&
            checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        ) {
            AgentPhonePreferences.recordReconnectReason(
                this,
                "relay: BLUETOOTH_CONNECT not granted — can't route $number to the relay puck"
            )
            updateForeground("Grant Bluetooth permission to use the relay")
            return
        }
        val answered = runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                val telecom = getSystemService(TelecomManager::class.java)
                @Suppress("DEPRECATION", "MissingPermission")
                telecom.acceptRingingCall()
                true
            } else {
                false
            }
        }.getOrDefault(false)

        val mgr = audioManager
        if (mgr != null) {
            try { mgr.mode = AudioManager.MODE_IN_COMMUNICATION } catch (error: Throwable) {
                Log.w(TAG, "relay: could not set MODE_IN_COMMUNICATION: ${error.message}")
            }
            val routed = if (Build.VERSION.SDK_INT >= 31) {
                val sco = mgr.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                if (sco != null) runCatching { mgr.setCommunicationDevice(sco) }.getOrDefault(false) else false
            } else {
                @Suppress("DEPRECATION")
                runCatching {
                    mgr.isBluetoothScoOn = true
                    mgr.startBluetoothSco()
                    true
                }.getOrDefault(false)
            }
            Log.i(TAG, "relay: answered=$answered routed-to-bluetooth=$routed for $number")
        }
        relayAutoAnswerActive = answered
        AgentPhonePreferences.recordReconnectReason(
            this,
            if (answered) "relay: auto-answered $number — routing audio to the relay puck"
            else "relay: could NOT auto-answer $number (answer it manually)"
        )
        updateForeground(if (answered) "Relaying $number to your agent…" else "Answer the call to relay it to your agent")
    }

    /**
     * RELAY transport: pull audio back to the phone (built-in earpiece) and tell
     * the server to end the agent leg so the user can talk to the caller.
     */
    private fun relayTakeOver(callId: String) {
        relayRouteAudioToEarpiece()
        relayAutoAnswerActive = false
        if (callId.isNotBlank()) screeningCommand("take_over", callId)
        AgentPhonePreferences.recordReconnectReason(this, "relay: took over $callId — audio back on the phone")
        updateForeground("You took over the call")
    }

    /** Pull the native call's audio back to this phone's built-in earpiece. */
    private fun relayRouteAudioToEarpiece() {
        val mgr = audioManager ?: return
        if (Build.VERSION.SDK_INT >= 31) {
            val ear = mgr.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            runCatching { if (ear != null) mgr.setCommunicationDevice(ear) else mgr.clearCommunicationDevice() }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                mgr.stopBluetoothSco()
                mgr.isBluetoothScoOn = false
            }
        }
    }

    /**
     * RELAY transport: end the active native call (mirrors the Twilio decline
     * path's TelecomManager.endCall()).
     */
    private fun relayEndCall() {
        val mgr = audioManager
        if (mgr != null) {
            if (Build.VERSION.SDK_INT >= 31) runCatching { mgr.clearCommunicationDevice() }
            else @Suppress("DEPRECATION") runCatching {
                mgr.stopBluetoothSco()
                mgr.isBluetoothScoOn = false
            }
        }
        val ended = runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                val telecom = getSystemService(TelecomManager::class.java)
                @Suppress("DEPRECATION", "MissingPermission")
                telecom.endCall()
            } else {
                false
            }
        }.getOrDefault(false)
        AgentPhonePreferences.recordReconnectReason(this, if (ended) "relay: ended native call" else "relay: could not end native call")
        updateForeground("Agent Phone online as extension ${settings.extension}")
    }

    /**
     * Transcript "Take over" (tapped on the S25). The control command to the server
     * is identical for both transports, but for a RELAY call THIS phone is holding
     * the native call and routing its audio over Bluetooth to the puck — so pull the
     * audio back to the earpiece *immediately* instead of waiting for the server's
     * screening_ended echo. Guarded by relayAutoAnswerActive, so it only fires on the
     * phone that actually answered (never the pocket M507). The screening_ended event
     * is then idempotent (the flag is already cleared).
     */
    private fun screeningTakeOver(callId: String) {
        if (screeningTransport == "relay" && relayAutoAnswerActive) {
            relayTakeOver(callId)
        } else {
            screeningCommand("take_over", callId)
        }
    }

    /** Transcript "End": hang up. For a relay call we answered, end the native call
     *  here directly; otherwise just tell the server to end the agent leg. */
    private fun screeningEnd(callId: String) {
        if (screeningTransport == "relay" && relayAutoAnswerActive) {
            relayAutoAnswerActive = false
            relayEndCall()
        }
        screeningCommand("end", callId)
    }

    private fun screeningCommand(action: String, callId: String) {
        val sent = when (action) {
            "take_over" -> client.screeningTakeOver(callId, settings.extension)
            else -> client.screeningEnd(callId, settings.extension)
        }
        if (!sent) {
            pendingScreening = action to callId
            client.connect(settings)
        }
    }

    private fun handleMessageEvent(event: PhoneEvent, notify: Boolean) {
        val payload = event.raw.optJSONObject("message") ?: return
        val message = UiMessage.fromJson(payload)
        InAppMessageStore.upsert(message)
        if (notify && message.toExtension == settings.extension && message.status !in setOf("read", "replied", "expired")) {
            AgentPhoneNotifications.showMessage(this, message)
        }
        if (message.status == "read" || message.status == "replied") {
            AgentPhoneNotifications.cancelMessage(this, message.id)
        }
        if (notify) client.ackMessage(message.id)
    }

    private fun fetchPendingMessages() {
        client.getPendingMessages(settings) { result ->
            if (!result.ok) return@getPendingMessages
            try {
                val messages = parseMessageList(result.body)
                if (messages.isEmpty()) return@getPendingMessages
                InAppMessageStore.upsertAll(messages)
                messages.forEach { message ->
                    if (message.toExtension == settings.extension && message.status !in setOf("read", "replied", "expired")) {
                        AgentPhoneNotifications.showMessage(this, message)
                    }
                }
            } catch (_: Throwable) { /* ignore parse failure */ }
        }
    }

    private fun markMessageRead(messageId: String) {
        InAppMessageStore.markStatus(messageId, "read")
        AgentPhoneNotifications.cancelMessage(this, messageId)
        if (!client.markMessageRead(messageId)) {
            client.postMessageRead(settings, messageId) { _ -> }
        }
    }

    private fun handleReplyIntent(intent: Intent) {
        val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return
        val replyText = intent.getStringExtra(EXTRA_REPLY_TEXT)
        val selectedOption = intent.getStringExtra(EXTRA_SELECTED_OPTION)
        replyToMessage(messageId, replyText, selectedOption)
    }

    fun replyToMessage(messageId: String, replyText: String?, selectedOption: String?) {
        InAppMessageStore.markStatus(messageId, "replied", replyText, selectedOption)
        AgentPhoneNotifications.cancelMessage(this, messageId)
        if (!client.replyMessage(messageId, replyText, selectedOption)) {
            client.postMessageReply(settings, messageId, replyText, selectedOption) { _ -> }
        }
    }

    private fun handleIncomingCall(event: PhoneEvent) {
        val info = IncomingCallInfo.fromEvent(event, settings.extension) ?: return
        AgentPhonePreferences.recordIncomingCall(this, info.summary())
        AgentPhoneNotifications.showIncomingCall(this, info)
        updateForeground("Incoming call from ${info.fromExtension}")
    }

    private fun sendAudioStart(callId: String): Boolean {
        if (callId.isBlank()) return false
        activeCallId = callId
        return client.audioStart(callId, settings.extension, "pcm_s16le", 16_000, 1)
    }

    private fun sendAudioChunk(callId: String, chunk: String): Boolean {
        if (callId.isBlank() || chunk.isBlank()) return false
        return client.audioChunk(callId, settings.extension, chunk)
    }

    private fun sendAudioEnd(callId: String): Boolean {
        if (callId.isBlank()) return false
        return client.audioEnd(callId, settings.extension)
    }

    private fun sendEndCall(callId: String): Boolean {
        if (callId.isBlank()) return false
        if (activeCallId == callId) { activeCallId = null; activeCallInfo = null }
        audio.exitCallAudio()
        return client.end(callId, settings.extension)
    }

    private fun flushPendingActions() {
        pendingAccept?.let {
            if (client.accept(it.callId, settings.extension)) pendingAccept = null
        }
        pendingReject?.let {
            if (client.reject(it.callId, settings.extension)) pendingReject = null
        }
        pendingText?.let { (info, text) ->
            if (client.sendText(info.callId, settings.extension, text)) pendingText = null
        }
        pendingScreening?.let { (action, callId) ->
            val sent = if (action == "take_over") client.screeningTakeOver(callId, settings.extension)
            else client.screeningEnd(callId, settings.extension)
            if (sent) pendingScreening = null
        }
    }

    private fun disconnectAndStop() {
        AgentPhonePreferences.setAlwaysOnEnabled(this, false)
        AgentPhonePreferences.markServiceRunning(this, false, "DISCONNECTED")
        client.disconnect()
        stopForegroundCompat()
        stopSelf()
    }

    private fun ensureForeground(state: String) {
        if (foregroundStarted) {
            updateForeground(state)
            return
        }
        val notification = AgentPhoneNotifications.onlineNotification(this, settings, state, activeCallInfo)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                AgentPhoneNotifications.ONLINE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            )
        } else {
            startForeground(AgentPhoneNotifications.ONLINE_NOTIFICATION_ID, notification)
        }
        foregroundStarted = true
        AgentPhonePreferences.markServiceRunning(this, true, state)
    }

    private fun updateForeground(state: String) {
        if (!foregroundStarted) return
        val text = if (state.startsWith("Agent Phone online")) state else state.ifBlank { "Online" }
        val notification = AgentPhoneNotifications.onlineNotification(this, settings, text, activeCallInfo)
        getSystemService(android.app.NotificationManager::class.java)
            .notify(AgentPhoneNotifications.ONLINE_NOTIFICATION_ID, notification)
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        foregroundStarted = false
    }

    companion object {
        private const val TAG = "AgentPhoneReceiver"
        const val ACTION_START = "com.agentphone.action.START_ALWAYS_ON"
        const val ACTION_BOOT_START = "com.agentphone.action.BOOT_START"
        const val ACTION_RETRY_START = "com.agentphone.action.RETRY_START"
        const val ACTION_DISCONNECT = "com.agentphone.action.DISCONNECT"
        const val ACTION_ACCEPT_CALL = "com.agentphone.action.ACCEPT_CALL"
        const val ACTION_REJECT_CALL = "com.agentphone.action.REJECT_CALL"
        const val ACTION_END_CALL = "com.agentphone.action.END_CALL"
        const val ACTION_TEXT_FALLBACK = "com.agentphone.action.TEXT_FALLBACK"
        const val ACTION_MARK_MESSAGE_READ = "com.agentphone.action.MARK_MESSAGE_READ"
        const val ACTION_REPLY_MESSAGE = "com.agentphone.action.REPLY_MESSAGE"
        const val ACTION_AGENT_TAKE_NATIVE_CALL = "com.agentphone.action.AGENT_TAKE_NATIVE_CALL"
        const val ACTION_RELAY_TAKE_OVER = "com.agentphone.action.RELAY_TAKE_OVER"
        const val ACTION_RELAY_END = "com.agentphone.action.RELAY_END"
        const val ACTION_SCREENING_TAKE_OVER = "com.agentphone.action.SCREENING_TAKE_OVER"
        const val ACTION_SCREENING_END = "com.agentphone.action.SCREENING_END"
        const val EXTRA_REASON = "reason"
        const val EXTRA_TEXT = "text"
        const val EXTRA_NUMBER = "number"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_MESSAGE_ID = "messageId"
        const val EXTRA_REPLY_TEXT = "replyText"
        const val EXTRA_SELECTED_OPTION = "selectedOption"

        @Volatile
        private var instance: AgentPhoneForegroundService? = null

        fun start(context: Context, reason: String = "manual") {
            val action = when {
                reason.startsWith("boot:") -> ACTION_BOOT_START
                reason == "workmanager_retry" -> ACTION_RETRY_START
                else -> ACTION_START
            }
            val intent = Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(action)
                .putExtra(EXTRA_REASON, reason)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun dispatchAccept(context: Context, info: IncomingCallInfo) {
            dispatchCallAction(context, ACTION_ACCEPT_CALL, info)
        }

        fun dispatchReject(context: Context, info: IncomingCallInfo) {
            dispatchCallAction(context, ACTION_REJECT_CALL, info)
        }

        fun dispatchScreeningTakeOver(context: Context, callId: String) {
            dispatchScreeningAction(context, ACTION_SCREENING_TAKE_OVER, callId)
        }

        fun dispatchScreeningEnd(context: Context, callId: String) {
            dispatchScreeningAction(context, ACTION_SCREENING_END, callId)
        }

        /** RELAY: pull audio back to the phone + end the agent leg. */
        fun dispatchRelayTakeOver(context: Context, callId: String) {
            dispatchScreeningAction(context, ACTION_RELAY_TAKE_OVER, callId)
        }

        /** RELAY: end the active native call. */
        fun dispatchRelayEnd(context: Context) {
            val intent = Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(ACTION_RELAY_END)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        private fun dispatchScreeningAction(context: Context, action: String, callId: String) {
            val intent = Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(action)
                .putExtra(EXTRA_CALL_ID, callId)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun dispatchTextFallback(context: Context, info: IncomingCallInfo, text: String) {
            val intent = info.applyTo(Intent(context, AgentPhoneForegroundService::class.java))
                .setAction(ACTION_TEXT_FALLBACK)
                .putExtra(EXTRA_TEXT, text)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun dispatchReply(context: Context, messageId: String, replyText: String?, selectedOption: String?) {
            val intent = Intent(context, AgentPhoneForegroundService::class.java)
                .setAction(ACTION_REPLY_MESSAGE)
                .putExtra(EXTRA_MESSAGE_ID, messageId)
            if (replyText != null) intent.putExtra(EXTRA_REPLY_TEXT, replyText)
            if (selectedOption != null) intent.putExtra(EXTRA_SELECTED_OPTION, selectedOption)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun replyDirect(messageId: String, replyText: String?, selectedOption: String?): Boolean {
            return instance?.let {
                it.replyToMessage(messageId, replyText, selectedOption)
                true
            } == true
        }

        fun markReadDirect(messageId: String): Boolean {
            return instance?.let {
                it.markMessageRead(messageId)
                true
            } == true
        }

        fun sendAudioStartFromUi(callId: String): Boolean = instance?.sendAudioStart(callId) == true

        fun sendAudioChunkFromUi(callId: String, chunk: String): Boolean = instance?.sendAudioChunk(callId, chunk) == true

        fun sendAudioEndFromUi(callId: String): Boolean = instance?.sendAudioEnd(callId) == true

        fun endCallFromUi(callId: String): Boolean = instance?.sendEndCall(callId) == true

        private fun dispatchCallAction(context: Context, action: String, info: IncomingCallInfo) {
            val intent = info.applyTo(Intent(context, AgentPhoneForegroundService::class.java)).setAction(action)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
