package com.agentphone.puck

import android.Manifest
import android.app.Notification
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.agentphone.service.AgentPhoneNotifications
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.state.AgentPhoneSettings
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.lang.reflect.Method
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Relay PUCK mode foreground service.
 *
 * Runs on a SEPARATE rooted device (MediaTek M507, Android 13, Magisk root) that
 * the user carries. The puck pairs to the user's real phone (S25) as a Bluetooth
 * HANDS-FREE (HFP-HF / HeadsetClient) headset, captures the live call's audio,
 * and bridges it to the server's RelayBridge WebSocket (/relay/media) so the AI
 * agent can talk on the call.
 *
 * This is the puck side of the "relay" screening transport. The phone-app side
 * (normal mode) is unchanged; this service only runs when puck mode is ON.
 *
 * IMPORTANT: the audio capture + inject path is UNVERIFIED — it needs a live call
 * to prove which AudioRecord source actually carries the far-end caller over the
 * SCO link, and whether an AudioTrack on STREAM_VOICE_CALL is heard on the call
 * uplink. Both the capture source and the inject stream are CONFIGURABLE (stored
 * in [AgentPhonePreferences]) and there is an [ACTION_PUCK_AUDIO_PROBE] mode that
 * measures RMS on every candidate source during a live call so the spike is
 * decisive.
 */
class RelayPuckService : Service() {

    // --- audio format (matches the RelayBridge default: PCM16 mono 16 kHz) ---
    @Volatile private var sampleRate = 16_000
    private val channelInMono = AudioFormat.CHANNEL_IN_MONO
    private val channelOutMono = AudioFormat.CHANNEL_OUT_MONO
    private val encoding = AudioFormat.ENCODING_PCM_16BIT

    private val audioManager by lazy { getSystemService(AudioManager::class.java) }
    private val bluetoothAdapter: BluetoothAdapter? by lazy {
        getSystemService(android.bluetooth.BluetoothManager::class.java)?.adapter
            ?: @Suppress("DEPRECATION") BluetoothAdapter.getDefaultAdapter()
    }

    // HFP Hands-Free (HeadsetClient) proxy obtained via reflection (it is @hide).
    @Volatile private var headsetClientProxy: BluetoothProfile? = null
    @Volatile private var scoConnected = false
    @Volatile private var callActive = false
    private var foregroundStarted = false

    // WebSocket to /relay/media.
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    @Volatile private var relaySocket: WebSocket? = null
    @Volatile private var relayConnected = false
    @Volatile private var shouldReconnect = false
    @Volatile private var reconnectAttempt = 0
    @Volatile private var lastStartCallNumber: String? = null

    // Capture/inject threads.
    @Volatile private var capturing = false
    private var captureThread: Thread? = null
    @Volatile private var injectTrack: AudioTrack? = null
    private var aec: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    private var settings = AgentPhoneSettings()

    /** Receives HFP-HF profile broadcasts so we know when a call/SCO becomes active. */
    private val hfpReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                ACTION_HF_AUDIO_STATE_CHANGED -> {
                    val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
                    // HeadsetClient audio states: 0 disconnected, 1 connecting, 2 connected.
                    val connected = state == HF_AUDIO_STATE_CONNECTED
                    Log.i(TAG, "HFP-HF audio state changed -> $state (connected=$connected)")
                    if (connected) onScoUp(intent.callerNumber()) else onScoDown()
                }
                ACTION_HF_CALL_CHANGED -> {
                    Log.i(TAG, "HFP-HF AG call changed: ${intent.extras?.keySet()?.joinToString()}")
                    // A ringing/active call on the AG side — proactively connect audio.
                    maybeConnectAudio(intent.deviceFromIntent())
                }
                ACTION_HF_CONNECTION_STATE_CHANGED -> {
                    val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
                    Log.i(TAG, "HFP-HF connection state changed -> $state")
                    if (state == BluetoothProfile.STATE_CONNECTED) {
                        status("Linked to phone — waiting for a call")
                    }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        settings = AgentPhonePreferences.loadSettings(this)
        AgentPhoneNotifications.ensureChannels(this)
        registerHfpReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        settings = AgentPhonePreferences.loadSettings(this)
        ensureForeground("Relay puck starting")
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_PUCK_AUDIO_PROBE -> {
                runAudioProbe()
                return START_STICKY
            }
            else -> {
                startRelay()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopEverything()
        runCatching { unregisterReceiver(hfpReceiver) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    private fun startRelay() {
        if (!hasBluetoothConnectPermission()) {
            status("Grant Bluetooth permission to run the relay puck")
            return
        }
        shouldReconnect = true
        connectHeadsetClientProxy()
        status("Relay puck online — connecting to phone")
    }

    private fun stopEverything() {
        shouldReconnect = false
        stopCapture()
        releaseInjectTrack()
        sendControl(JSONObject().put("kind", "end"))
        relaySocket?.close(1000, "puck stop")
        relaySocket = null
        relayConnected = false
        closeHeadsetAudio()
        closeHeadsetClientProxy()
        callActive = false
        scoConnected = false
        status("Relay puck stopped")
    }

    // ---------------------------------------------------------------------
    // Bluetooth HFP Hands-Free (HeadsetClient) via reflection
    // ---------------------------------------------------------------------

    private fun connectHeadsetClientProxy() {
        val adapter = bluetoothAdapter
        if (adapter == null) {
            status("No Bluetooth adapter on this device")
            return
        }
        val listener = object : BluetoothProfile.ServiceListener {
            override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                if (profile != PROFILE_HEADSET_CLIENT) return
                headsetClientProxy = proxy
                Log.i(TAG, "HFP-HF (HeadsetClient) proxy connected")
                status("HFP-HF proxy ready — connecting to phone")
                connectConfiguredDevice(proxy)
            }

            override fun onServiceDisconnected(profile: Int) {
                if (profile == PROFILE_HEADSET_CLIENT) {
                    headsetClientProxy = null
                    Log.i(TAG, "HFP-HF (HeadsetClient) proxy disconnected")
                }
            }
        }
        val ok = runCatching {
            // HEADSET_CLIENT == 16 (hidden constant). Pass it directly.
            adapter.getProfileProxy(this, listener, PROFILE_HEADSET_CLIENT)
        }.getOrDefault(false)
        if (!ok) status("Could not bind HFP-HF profile (HEADSET_CLIENT=16)")
    }

    private fun connectConfiguredDevice(proxy: BluetoothProfile) {
        val device = resolveTargetPhone()
        if (device == null) {
            status("No paired phone found — pair the S25 over Bluetooth first")
            return
        }
        val label = runCatching { device.name }.getOrNull()?.ifBlank { device.address } ?: device.address
        // connect(device) — @hide on BluetoothHeadsetClient — call via reflection.
        val connected = invokeProxyBool(proxy, "connect", arrayOf(BluetoothDevice::class.java), arrayOf(device))
        Log.i(TAG, "HFP-HF connect(${device.address}) returned $connected")
        status(if (connected == true) "Connecting to $label" else "Connect to $label requested")
    }

    /**
     * Which phone to attach to. A manually-set MAC wins (disambiguation); otherwise
     * AUTO-DETECT: pick the bonded device that is a phone (major class PHONE). With
     * exactly one paired phone — the normal case — no MAC entry is ever needed.
     */
    private fun resolveTargetPhone(): BluetoothDevice? {
        val mac = AgentPhonePreferences.pairedPhoneMac(this)
        if (mac.isNotBlank()) return runCatching { bluetoothAdapter?.getRemoteDevice(mac) }.getOrNull()
        val bonded = runCatching { bluetoothAdapter?.bondedDevices?.toList() }.getOrNull().orEmpty()
        val phones = bonded.filter {
            runCatching { it.bluetoothClass?.majorDeviceClass == android.bluetooth.BluetoothClass.Device.Major.PHONE }.getOrDefault(false)
        }
        // Exactly one paired phone → use it. Multiple → the user can pin a MAC in settings.
        return phones.singleOrNull() ?: phones.firstOrNull() ?: bonded.firstOrNull()
    }

    /** A call became active on the AG (phone). Open the SCO audio link so we can capture it. */
    private fun maybeConnectAudio(device: BluetoothDevice?) {
        val proxy = headsetClientProxy ?: return
        val target = device ?: connectedHeadsetClientDevice(proxy) ?: return
        // connectAudio(device) — @hide — open the SCO link to carry call audio.
        val ok = invokeProxyBool(proxy, "connectAudio", arrayOf(BluetoothDevice::class.java), arrayOf(target))
        Log.i(TAG, "HFP-HF connectAudio() returned $ok")
    }

    private fun connectedHeadsetClientDevice(proxy: BluetoothProfile): BluetoothDevice? {
        return runCatching {
            @Suppress("UNCHECKED_CAST")
            (proxy.connectedDevices as? List<BluetoothDevice>)?.firstOrNull()
        }.getOrNull()
    }

    private fun closeHeadsetAudio() {
        val proxy = headsetClientProxy ?: return
        val device = connectedHeadsetClientDevice(proxy) ?: return
        invokeProxyBool(proxy, "disconnectAudio", arrayOf(BluetoothDevice::class.java), arrayOf(device))
    }

    private fun closeHeadsetClientProxy() {
        val proxy = headsetClientProxy ?: return
        runCatching { bluetoothAdapter?.closeProfileProxy(PROFILE_HEADSET_CLIENT, proxy) }
        headsetClientProxy = null
    }

    /** Reflectively invoke a (BluetoothDevice)->boolean method on the @hide proxy. */
    private fun invokeProxyBool(
        proxy: BluetoothProfile,
        name: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>
    ): Boolean? {
        return try {
            val method: Method = proxy.javaClass.getMethod(name, *paramTypes)
            val result = method.invoke(proxy, *args)
            (result as? Boolean) ?: true // some hidden methods return void/Unit
        } catch (error: Throwable) {
            Log.w(TAG, "reflective $name() failed: ${error.message}")
            null
        }
    }

    // ---------------------------------------------------------------------
    // SCO / call state
    // ---------------------------------------------------------------------

    private fun onScoUp(callerNumber: String?) {
        if (scoConnected) return
        scoConnected = true
        callActive = true
        lastStartCallNumber = callerNumber
        Log.i(TAG, "SCO up — call active (caller=${callerNumber ?: "unknown"})")
        status("Call active — relaying audio")
        enterCommunicationMode()
        ensureRelayConnected()
        startCapture()
    }

    private fun onScoDown() {
        if (!scoConnected) return
        scoConnected = false
        callActive = false
        Log.i(TAG, "SCO down — call ended")
        status("Call ended — waiting for the next one")
        stopCapture()
        releaseInjectTrack()
        sendControl(JSONObject().put("kind", "end"))
        exitCommunicationMode()
    }

    private fun enterCommunicationMode() {
        val mgr = audioManager ?: return
        runCatching { mgr.mode = AudioManager.MODE_IN_COMMUNICATION }
        if (Build.VERSION.SDK_INT >= 31) {
            val sco = runCatching {
                mgr.availableCommunicationDevices.firstOrNull {
                    it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                }
            }.getOrNull()
            if (sco != null) runCatching { mgr.setCommunicationDevice(sco) }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                mgr.isBluetoothScoOn = true
                mgr.startBluetoothSco()
            }
        }
    }

    private fun exitCommunicationMode() {
        val mgr = audioManager ?: return
        if (Build.VERSION.SDK_INT >= 31) {
            runCatching { mgr.clearCommunicationDevice() }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                mgr.stopBluetoothSco()
                mgr.isBluetoothScoOn = false
            }
        }
        runCatching { mgr.mode = AudioManager.MODE_NORMAL }
    }

    // ---------------------------------------------------------------------
    // RelayBridge WebSocket (/relay/media)
    // ---------------------------------------------------------------------

    private fun ensureRelayConnected() {
        if (relayConnected || relaySocket != null) {
            // Already (re)connecting — just (re)send start_call once open.
            if (relayConnected) sendStartCall()
            return
        }
        openRelaySocket()
    }

    private fun openRelaySocket() {
        val url = relayUrl()
        val request = runCatching { Request.Builder().url(url).build() }.getOrNull()
        if (request == null) {
            status("Bad relay URL: $url")
            return
        }
        Log.i(TAG, "opening relay socket $url")
        relaySocket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                relayConnected = true
                reconnectAttempt = 0
                Log.i(TAG, "relay socket open")
                if (callActive) sendStartCall()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleRelayMessage(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "relay socket closed code=$code reason=$reason")
                relayConnected = false
                relaySocket = null
                if (shouldReconnect && callActive) scheduleRelayReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "relay socket failure: ${t.message}")
                relayConnected = false
                relaySocket = null
                if (shouldReconnect && callActive) scheduleRelayReconnect()
            }
        })
    }

    private fun scheduleRelayReconnect() {
        reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(6)
        val delayMs = (500L * (1 shl (reconnectAttempt - 1))).coerceAtMost(10_000L)
        Log.i(TAG, "relay reconnect in ${delayMs}ms (attempt $reconnectAttempt)")
        thread(name = "relay-reconnect") {
            SystemClock.sleep(delayMs)
            if (shouldReconnect && callActive && relaySocket == null) openRelaySocket()
        }
    }

    private fun sendStartCall() {
        val payload = JSONObject().put("kind", "start_call").put("screening", true)
        lastStartCallNumber?.let { if (it.isNotBlank()) payload.put("callerNumber", it) }
        sendControl(payload)
    }

    private fun handleRelayMessage(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("kind")) {
            "media" -> {
                val pcmBase64 = json.optString("pcmBase64")
                if (pcmBase64.isNotBlank()) playInject(Base64.decode(pcmBase64, Base64.DEFAULT))
            }
            "mark" -> {
                val name = json.optString("name")
                // Echo the mark back once the inject track has drained.
                drainInjectThen {
                    sendControl(JSONObject().put("kind", "mark").put("name", name))
                }
            }
            "takeover" -> {
                Log.i(TAG, "server requested takeover")
                onScoDown()
            }
            "end" -> {
                Log.i(TAG, "server ended relay session")
                onScoDown()
            }
        }
    }

    private fun sendControl(json: JSONObject): Boolean {
        return relaySocket?.send(json.toString()) == true
    }

    // ---------------------------------------------------------------------
    // Capture (caller voice -> server) + Inject (agent TTS -> call uplink)
    // ---------------------------------------------------------------------

    private fun startCapture() {
        if (capturing) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status("RECORD_AUDIO not granted — cannot capture call audio")
            return
        }
        val source = AgentPhonePreferences.captureSource(this)
        val rec = openRecord(source) ?: run {
            status("Could not open AudioRecord (source=$source)")
            return
        }
        capturing = true
        enableEchoEffects(rec.audioSessionId)
        runCatching { rec.startRecording() }.onFailure {
            Log.e(TAG, "startRecording failed: ${it.message}")
            capturing = false
            releaseEchoEffects()
            rec.release()
            return
        }
        Log.i(TAG, "capture started source=$source sampleRate=$sampleRate")
        captureThread = thread(name = "relay-puck-capture") {
            val frameBytes = frameBytesFor(sampleRate)
            val buffer = ByteArray(frameBytes)
            try {
                while (capturing) {
                    val read = rec.read(buffer, 0, frameBytes)
                    if (read <= 0) continue
                    val frame = if (read == frameBytes) buffer else buffer.copyOf(read)
                    val b64 = Base64.encodeToString(frame, Base64.NO_WRAP)
                    sendControl(JSONObject().put("kind", "media").put("pcmBase64", b64))
                }
            } catch (error: Throwable) {
                Log.w(TAG, "capture loop error: ${error.message}")
            } finally {
                runCatching { rec.stop() }
                releaseEchoEffects()
                rec.release()
            }
        }
    }

    private fun stopCapture() {
        capturing = false
        captureThread?.let { runCatching { it.join(500) } }
        captureThread = null
    }

    /**
     * Open an AudioRecord on [source] at [sampleRate] (falling back to 8 kHz),
     * trying the modern Builder and the legacy constructor. Returns null on
     * failure. If VOICE_CALL is requested and fails, the caller may retry with a
     * root-elevated path; we prefer VOICE_COMMUNICATION which needs no special perm.
     */
    private fun openRecord(source: Int): AudioRecord? {
        for (rate in intArrayOf(sampleRate, 8_000)) {
            val minBuffer = AudioRecord.getMinBufferSize(rate, channelInMono, encoding)
            if (minBuffer <= 0) continue
            val bufferSize = minBuffer.coerceAtLeast(frameBytesFor(rate) * 4)
            val rec = runCatching {
                AudioRecord.Builder()
                    .setAudioSource(source)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(rate)
                            .setChannelMask(channelInMono)
                            .setEncoding(encoding)
                            .build()
                    )
                    .setBufferSizeInBytes(bufferSize)
                    .build()
            }.getOrNull()
            if (rec != null && rec.state == AudioRecord.STATE_INITIALIZED) {
                sampleRate = rate
                return rec
            }
            rec?.release()
            // Legacy constructor fallback.
            val legacy = runCatching {
                @Suppress("DEPRECATION")
                AudioRecord(source, rate, channelInMono, encoding, bufferSize)
            }.getOrNull()
            if (legacy != null && legacy.state == AudioRecord.STATE_INITIALIZED) {
                sampleRate = rate
                return legacy
            }
            legacy?.release()
        }
        // VOICE_CALL needs CAPTURE_AUDIO_OUTPUT / privileged access on most devices;
        // a root-enabled fallback can flip the relevant app op. PREFER not to need it.
        if (source == MediaRecorder.AudioSource.VOICE_CALL) tryRootElevateVoiceCall()
        return null
    }

    private fun playInject(pcm: ByteArray) {
        val track = injectTrack ?: buildInjectTrack().also { injectTrack = it }
        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) runCatching { track.play() }
        runCatching { track.write(pcm, 0, pcm.size) }
    }

    private fun buildInjectTrack(): AudioTrack {
        val stream = AgentPhonePreferences.injectStream(this)
        val minBuffer = AudioTrack.getMinBufferSize(sampleRate, channelOutMono, encoding).coerceAtLeast(3200)
        // Map the configured legacy STREAM_* to a matching AudioAttributes usage so
        // both the modern and legacy paths route the agent TTS onto the call uplink.
        val usage = when (stream) {
            AudioManager.STREAM_VOICE_CALL -> AudioAttributes.USAGE_VOICE_COMMUNICATION
            AudioManager.STREAM_MUSIC -> AudioAttributes.USAGE_MEDIA
            else -> AudioAttributes.USAGE_VOICE_COMMUNICATION
        }
        return runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(usage)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelOutMono)
                        .setEncoding(encoding)
                        .build()
                )
                .setBufferSizeInBytes(minBuffer)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        }.getOrElse {
            @Suppress("DEPRECATION")
            AudioTrack(stream, sampleRate, channelOutMono, encoding, minBuffer, AudioTrack.MODE_STREAM)
        }
    }

    private fun releaseInjectTrack() {
        injectTrack?.let { t ->
            runCatching { t.stop() }
            runCatching { t.release() }
        }
        injectTrack = null
    }

    /** Block until the inject track has drained, then run [after] (echo the mark). */
    private fun drainInjectThen(after: () -> Unit) {
        thread(name = "relay-inject-drain") {
            val track = injectTrack
            if (track != null) {
                // Poll the playback head until it stops advancing (rough drain detect).
                var lastHead = -1
                repeat(50) {
                    val head = runCatching { track.playbackHeadPosition }.getOrDefault(0)
                    if (head == lastHead) return@repeat
                    lastHead = head
                    SystemClock.sleep(20)
                }
            }
            after()
        }
    }

    private fun enableEchoEffects(sessionId: Int) {
        runCatching {
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(sessionId)?.also { it.enabled = true }
            }
        }
        runCatching {
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.also { it.enabled = true }
            }
        }
    }

    private fun releaseEchoEffects() {
        runCatching { aec?.release() }
        runCatching { noiseSuppressor?.release() }
        aec = null
        noiseSuppressor = null
    }

    // ---------------------------------------------------------------------
    // Audio probe — measure RMS on every candidate source during a live call
    // ---------------------------------------------------------------------

    /**
     * For ~8 seconds during an active call, open an AudioRecord on EACH candidate
     * source in turn, compute RMS, and log which source(s) carry real signal — so
     * the live spike can pick the one capturing the far-end caller. Writes the
     * winning summary to [AgentPhonePreferences.setPuckStatus] and recordReconnectReason.
     */
    private fun runAudioProbe() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status("Probe: RECORD_AUDIO not granted")
            return
        }
        // Make sure we are in comms mode + SCO is up; otherwise the probe measures silence.
        enterCommunicationMode()
        val wasCapturing = capturing
        if (wasCapturing) stopCapture()
        status("Audio probe running (8s) — keep the call active")
        thread(name = "relay-puck-probe") {
            val results = StringBuilder("audio probe: ")
            for ((label, source) in PROBE_SOURCES) {
                val rms = measureSourceRms(source, perSourceMs = PROBE_PER_SOURCE_MS)
                val line = "$label(src=$source) rms=${"%.1f".format(rms)}"
                Log.i(TAG, "PROBE $line")
                results.append(line).append("  ")
            }
            val summary = results.toString().trim()
            Log.i(TAG, "PROBE summary: $summary")
            AgentPhonePreferences.recordReconnectReason(this, summary)
            status(summary)
            if (wasCapturing && callActive) startCapture()
        }
    }

    /** Open [source], read for [perSourceMs], return the mean RMS (0 on failure). */
    private fun measureSourceRms(source: Int, perSourceMs: Long): Double {
        val rec = openRecordRaw(source) ?: return 0.0
        return try {
            rec.startRecording()
            val frameBytes = frameBytesFor(sampleRate)
            val buffer = ByteArray(frameBytes)
            val deadline = SystemClock.elapsedRealtime() + perSourceMs
            var sumRms = 0.0
            var frames = 0
            while (SystemClock.elapsedRealtime() < deadline) {
                val read = rec.read(buffer, 0, frameBytes)
                if (read <= 0) continue
                sumRms += rms16(buffer, read)
                frames++
            }
            if (frames == 0) 0.0 else sumRms / frames
        } catch (error: Throwable) {
            Log.w(TAG, "probe source=$source failed: ${error.message}")
            0.0
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    /** Like [openRecord] but no root fallback and no sampleRate mutation side effects. */
    private fun openRecordRaw(source: Int): AudioRecord? {
        val rate = sampleRate
        val minBuffer = AudioRecord.getMinBufferSize(rate, channelInMono, encoding)
        if (minBuffer <= 0) return null
        val bufferSize = minBuffer.coerceAtLeast(frameBytesFor(rate) * 4)
        val rec = runCatching {
            AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(rate)
                        .setChannelMask(channelInMono)
                        .setEncoding(encoding)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .build()
        }.getOrNull()
        if (rec != null && rec.state == AudioRecord.STATE_INITIALIZED) return rec
        rec?.release()
        return null
    }

    // ---------------------------------------------------------------------
    // Root fallback (guarded; preferred path needs no root)
    // ---------------------------------------------------------------------

    /**
     * VOICE_CALL capture is privileged on most devices. On the rooted M507 we can,
     * as a fallback, grant CAPTURE_AUDIO_OUTPUT to ourselves via Magisk su. This is
     * best-effort and guarded: the PREFERRED source (VOICE_COMMUNICATION) needs none
     * of this.
     */
    private fun tryRootElevateVoiceCall() {
        Log.i(TAG, "attempting root elevation for VOICE_CALL capture (fallback)")
        runCatching {
            val cmd = "appops set ${packageName} android:record_audio allow; " +
                "pm grant ${packageName} android.permission.CAPTURE_AUDIO_OUTPUT"
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))
            val finished = process.waitFor(4, TimeUnit.SECONDS)
            Log.i(TAG, "root elevation su exited finished=$finished code=${if (finished) process.exitValue() else -1}")
        }.onFailure {
            Log.w(TAG, "root elevation failed (su unavailable?): ${it.message}")
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun relayUrl(): String {
        val base = settings.serverUrl.trim().removeSuffix("/")
        val normalized = if (base.startsWith("http://") || base.startsWith("https://")) base else "http://$base"
        val protocol = if (normalized.startsWith("https://")) "wss" else "ws"
        val authority = normalized.removePrefix("http://").removePrefix("https://").substringBefore("/")
        return "$protocol://$authority/relay/media"
    }

    private fun hasBluetoothConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < 31 ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    private fun registerHfpReceiver() {
        val filter = IntentFilter().apply {
            addAction(ACTION_HF_AUDIO_STATE_CHANGED)
            addAction(ACTION_HF_CALL_CHANGED)
            addAction(ACTION_HF_CONNECTION_STATE_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(hfpReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(hfpReceiver, filter)
        }
    }

    private fun status(line: String) {
        Log.i(TAG, "status: $line")
        AgentPhonePreferences.setPuckStatus(this, line)
        updateForeground(line)
    }

    private fun ensureForeground(state: String) {
        if (foregroundStarted) {
            updateForeground(state)
            return
        }
        val notification = puckNotification(state)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                PUCK_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(PUCK_NOTIFICATION_ID, notification)
        }
        foregroundStarted = true
    }

    private fun updateForeground(state: String) {
        if (!foregroundStarted) return
        getSystemService(android.app.NotificationManager::class.java)
            .notify(PUCK_NOTIFICATION_ID, puckNotification(state))
    }

    private fun puckNotification(state: String): Notification {
        return Notification.Builder(this, AgentPhoneNotifications.ONLINE_CHANNEL_ID)
            .setContentTitle("Relay puck")
            .setContentText(state)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .build()
    }

    private fun frameBytesFor(rate: Int): Int {
        // 20 ms frame, mono PCM16 -> rate * 0.02 * 2 bytes.
        return (rate / 50) * 2
    }

    private fun rms16(bytes: ByteArray, length: Int): Double {
        var sum = 0.0
        var count = 0
        var i = 0
        val limit = length - 1
        while (i < limit) {
            val lo = bytes[i].toInt() and 0xff
            val hi = bytes[i + 1].toInt()
            val sample = (hi shl 8) or lo
            sum += sample.toDouble() * sample.toDouble()
            count++
            i += 2
        }
        return if (count == 0) 0.0 else sqrt(sum / count)
    }

    /** Pull the AG caller number out of an HFP-HF call/audio intent if present. */
    private fun Intent.callerNumber(): String? {
        for (key in arrayOf("android.bluetooth.headsetclient.extra.NUMBER", "EXTRA_NUMBER", "number")) {
            val value = getStringExtra(key)
            if (!value.isNullOrBlank()) return value
        }
        return null
    }

    private fun Intent.deviceFromIntent(): BluetoothDevice? {
        return runCatching {
            if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else @Suppress("DEPRECATION") getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        }.getOrNull()
    }

    companion object {
        private const val TAG = "RelayPuck"

        /** BluetoothProfile.HEADSET_CLIENT is @hide; its value is 16. */
        const val PROFILE_HEADSET_CLIENT = 16

        /** HeadsetClient audio connected state (BluetoothHeadsetClient.STATE_AUDIO_CONNECTED == 2). */
        private const val HF_AUDIO_STATE_CONNECTED = 2

        // BluetoothHeadsetClient broadcast actions (string-stable across versions).
        private const val ACTION_HF_AUDIO_STATE_CHANGED =
            "android.bluetooth.headsetclient.profile.action.AUDIO_STATE_CHANGED"
        private const val ACTION_HF_CALL_CHANGED =
            "android.bluetooth.headsetclient.profile.action.AG_CALL_CHANGED"
        private const val ACTION_HF_CONNECTION_STATE_CHANGED =
            "android.bluetooth.headsetclient.profile.action.CONNECTION_STATE_CHANGED"

        const val ACTION_START = "com.agentphone.puck.action.START"
        const val ACTION_STOP = "com.agentphone.puck.action.STOP"
        const val ACTION_PUCK_AUDIO_PROBE = "com.agentphone.puck.action.AUDIO_PROBE"

        const val PUCK_NOTIFICATION_ID = 9100

        private const val PROBE_PER_SOURCE_MS = 1_600L

        /** Candidate capture sources the probe sweeps, in likely-best order. */
        private val PROBE_SOURCES: List<Pair<String, Int>> = listOf(
            "VOICE_COMMUNICATION" to MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            "VOICE_CALL" to MediaRecorder.AudioSource.VOICE_CALL,
            "VOICE_DOWNLINK" to MediaRecorder.AudioSource.VOICE_DOWNLINK,
            "MIC" to MediaRecorder.AudioSource.MIC
        )

        fun start(context: Context) {
            val intent = Intent(context, RelayPuckService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, RelayPuckService::class.java).setAction(ACTION_STOP)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun runProbe(context: Context) {
            val intent = Intent(context, RelayPuckService::class.java).setAction(ACTION_PUCK_AUDIO_PROBE)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
