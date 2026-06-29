package com.agentphone.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Full-duplex-ish call audio: the mic runs continuously (no push-to-talk) and an on-device
 * [VadSegmenter] decides when each spoken turn starts and ends, emitting one
 * `audio_start → chunks → audio_end` cycle per turn. Echo is handled by enabling hardware
 * [AcousticEchoCanceler] / [NoiseSuppressor] and by gating the mic via [HalfDuplexGate]
 * while the agent's TTS plays.
 *
 * (Class name kept as PushToTalkAudio to avoid a wide rename; it is no longer push-to-talk.)
 */
class PushToTalkAudio(private val context: Context) {
    private val sampleRate = 16_000
    private var recorder: AudioRecord? = null
    private var recording = false
    @Volatile private var muted = false
    private var aec: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var pcmTrack: AudioTrack? = null
    private var ttsPlayer: MediaPlayer? = null
    private val ttsBuffers = mutableMapOf<String, ActiveTts>()
    // Serial playback: completed utterances queue here and play one at a time.
    // Without this, each arriving tts_end killed the in-flight player — in a
    // 911 war room every agent cut off the previous one mid-sentence.
    private val ttsQueue = ArrayDeque<Pair<String, ActiveTts>>()
    private var currentTts: Pair<String, ActiveTts>? = null
    private val audioManager by lazy { context.getSystemService(AudioManager::class.java) }
    private var previousMode: Int = AudioManager.MODE_NORMAL
    private var previousSpeakerOn: Boolean = false
    private var inCallAudio: Boolean = false

    fun enterCallAudio(forceSpeaker: Boolean = true) {
        val mgr = audioManager ?: return
        if (inCallAudio) {
            if (forceSpeaker) try { mgr.isSpeakerphoneOn = true } catch (_: Throwable) {}
            return
        }
        previousMode = try { mgr.mode } catch (_: Throwable) { AudioManager.MODE_NORMAL }
        previousSpeakerOn = try { mgr.isSpeakerphoneOn } catch (_: Throwable) { false }
        try {
            mgr.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (error: Throwable) {
            Log.w(TAG, "could not switch to MODE_IN_COMMUNICATION: ${error.message}")
        }
        if (forceSpeaker) {
            try { mgr.isSpeakerphoneOn = true } catch (error: Throwable) {
                Log.w(TAG, "could not enable speakerphone: ${error.message}")
            }
        }
        try {
            val max = mgr.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            val current = mgr.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
            if (current < max) {
                mgr.setStreamVolume(AudioManager.STREAM_VOICE_CALL, max, 0)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "could not bump VOICE_CALL volume: ${error.message}")
        }
        inCallAudio = true
        Log.i(TAG, "entered call audio mode (speakerphone=$forceSpeaker, previousMode=$previousMode)")
    }

    fun exitCallAudio() {
        // The call is over — make sure the mic is never left gated by a stale "agent speaking".
        HalfDuplexGate.agentStoppedSpeaking()
        if (!inCallAudio) return
        val mgr = audioManager ?: return
        try { mgr.isSpeakerphoneOn = previousSpeakerOn } catch (_: Throwable) {}
        try { mgr.mode = previousMode } catch (_: Throwable) {}
        inCallAudio = false
        Log.i(TAG, "exited call audio mode")
    }

    /** Mute/unmute the live mic without tearing down the continuous capture. */
    fun setMuted(value: Boolean) {
        muted = value
        Log.i(TAG, "mic muted=$value")
    }

    /**
     * Start continuous capture for the whole call. The recorder runs until [stop]; the VAD
     * fires [onUtteranceStart] / [onChunk] / [onUtteranceEnd] as the user speaks and pauses.
     * Returns false if the mic can't be opened (e.g. permission missing).
     */
    fun startContinuous(
        onUtteranceStart: () -> Unit,
        onChunk: (String) -> Unit,
        onUtteranceEnd: () -> Unit
    ): Boolean {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "startContinuous() blocked: RECORD_AUDIO not granted")
            return false
        }
        if (recording) {
            Log.i(TAG, "startContinuous() ignored: already recording")
            return true
        }
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            .coerceAtLeast(FRAME_BYTES * 4)
        val rec = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(minBuffer)
                .build()
        } catch (error: Throwable) {
            Log.e(TAG, "AudioRecord build failed: ${error.message}", error)
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord not initialized (state=${rec.state}); is the mic in use?")
            rec.release()
            return false
        }
        recorder = rec
        recording = true
        enableEchoEffects(rec.audioSessionId)
        try {
            rec.startRecording()
        } catch (error: Throwable) {
            Log.e(TAG, "startRecording failed: ${error.message}", error)
            recording = false
            releaseEchoEffects()
            rec.release()
            recorder = null
            return false
        }
        Log.i(TAG, "continuous capture started sampleRate=$sampleRate frameBytes=$FRAME_BYTES")
        thread(name = "agent-phone-recorder") {
            val buffer = ByteArray(FRAME_BYTES)
            val segmenter = VadSegmenter(START_RMS, END_RMS, MIN_SPEECH_FRAMES, SILENCE_FRAMES_TO_END)
            val preroll = ArrayDeque<ByteArray>()
            var inUtterance = false
            while (recording) {
                val read = recorder?.read(buffer, 0, FRAME_BYTES) ?: 0
                if (read <= 0) continue
                // Half-duplex: while the agent talks (or we're muted) drop the mic so its own
                // voice is never recorded and echoed back. Flush any in-flight turn first.
                if (muted || HalfDuplexGate.isAgentSpeaking()) {
                    if (inUtterance) {
                        if (segmenter.end() == VadEvent.UTTERANCE_END) onUtteranceEnd()
                        inUtterance = false
                    } else {
                        segmenter.reset()
                    }
                    preroll.clear()
                    continue
                }
                val frame = buffer.copyOf(read)
                when (segmenter.accept(rms16(frame, read))) {
                    VadEvent.UTTERANCE_START -> {
                        inUtterance = true
                        onUtteranceStart()
                        // Replay the few frames just before onset so the first word isn't clipped.
                        while (preroll.isNotEmpty()) onChunk(encode(preroll.removeFirst()))
                        onChunk(encode(frame))
                    }
                    VadEvent.UTTERANCE_END -> {
                        onChunk(encode(frame))
                        onUtteranceEnd()
                        inUtterance = false
                        preroll.clear()
                    }
                    VadEvent.NONE -> {
                        if (inUtterance) {
                            onChunk(encode(frame))
                        } else {
                            preroll.addLast(frame)
                            while (preroll.size > MAX_PREROLL_FRAMES) preroll.removeFirst()
                        }
                    }
                }
            }
        }
        return true
    }

    fun stop() {
        recording = false
        releaseEchoEffects()
        recorder?.run {
            try {
                stop()
            } catch (error: IllegalStateException) {
                Log.w(TAG, "stop() ignored: ${error.message}")
            }
            release()
        }
        recorder = null
    }

    private fun enableEchoEffects(sessionId: Int) {
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(sessionId)?.also { it.enabled = true }
                Log.i(TAG, "AcousticEchoCanceler enabled=${aec?.enabled}")
            } else {
                Log.w(TAG, "AcousticEchoCanceler not available on this device")
            }
        } catch (error: Throwable) {
            Log.w(TAG, "could not enable AEC: ${error.message}")
        }
        try {
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.also { it.enabled = true }
                Log.i(TAG, "NoiseSuppressor enabled=${noiseSuppressor?.enabled}")
            }
        } catch (error: Throwable) {
            Log.w(TAG, "could not enable NoiseSuppressor: ${error.message}")
        }
    }

    private fun releaseEchoEffects() {
        try { aec?.release() } catch (_: Throwable) {}
        try { noiseSuppressor?.release() } catch (_: Throwable) {}
        aec = null
        noiseSuppressor = null
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    /** Root-mean-square energy of a little-endian PCM16 frame. */
    private fun rms16(bytes: ByteArray, length: Int): Double {
        var sum = 0.0
        var count = 0
        var i = 0
        val limit = length - 1
        while (i < limit) {
            val lo = bytes[i].toInt() and 0xff
            val hi = bytes[i + 1].toInt() // signed high byte
            val sample = (hi shl 8) or lo
            sum += sample.toDouble() * sample.toDouble()
            count++
            i += 2
        }
        return if (count == 0) 0.0 else sqrt(sum / count)
    }

    fun beginTts(callId: String, messageId: String?, audioFormat: String, mimeType: String) {
        val key = ttsKey(callId, messageId)
        clearTtsBuffer(key)
        // One audio instance owns the WHOLE call — the phone holds multiple
        // sockets on its extension and all receive every TTS event. Claiming
        // per call (not per message) keeps all utterances on ONE serial queue;
        // per-message claims could split a call across two instances whose
        // independent queues then play over each other.
        if (!TtsPlaybackRegistry.claim(callId, this)) {
            Log.i(TAG, "tts for call $callId owned by another audio instance; skipping")
            return
        }
        val dir = File(context.cacheDir, "agent-phone-audio")
        if (!dir.exists()) dir.mkdirs()
        val file = File.createTempFile("tts-${safeFilePart(key)}-", ".mp3", dir)
        val stream = FileOutputStream(file, false)
        ttsBuffers[key] = ActiveTts(callId, messageId, audioFormat, mimeType, file, stream)
        Log.i(TAG, "tts_start callId=$callId messageId=${messageId ?: "none"} format=$audioFormat mimeType=$mimeType file=${file.absolutePath}")
    }

    fun appendTtsChunk(callId: String, messageId: String?, audioBase64: String) {
        val key = ttsKey(callId, messageId)
        val active = ttsBuffers[key]
        if (active == null) {
            Log.w(TAG, "tts_chunk ignored for missing buffer callId=$callId messageId=${messageId ?: "none"}")
            return
        }
        val bytes = Base64.decode(audioBase64, Base64.DEFAULT)
        active.stream.write(bytes)
        Log.d(TAG, "tts_chunk callId=$callId messageId=${messageId ?: "none"} bytes=${bytes.size}")
    }

    fun endTts(callId: String, messageId: String?) {
        val key = ttsKey(callId, messageId)
        val active = ttsBuffers.remove(key)
        if (active == null) {
            Log.w(TAG, "tts_end ignored for missing buffer callId=$callId messageId=${messageId ?: "none"}")
            return
        }
        try {
            active.stream.flush()
            active.stream.close()
            Log.i(TAG, "tts_end callId=$callId messageId=${messageId ?: "none"} bytes=${active.file.length()} file=${active.file.absolutePath}")
            // Queue instead of play-now: utterances play strictly one at a time,
            // so a second speaker (war room) waits instead of cutting this one off.
            synchronized(ttsQueue) {
                ttsQueue.addLast(key to active)
                if (currentTts == null) playNextTts()
            }
        } catch (error: IOException) {
            Log.e(TAG, "tts_end failed callId=$callId messageId=${messageId ?: "none"}", error)
            cleanupTtsFile(key, active.file)
        }
    }

    /**
     * Claim playback ownership for a call WITHOUT starting a buffer — used by
     * the on-device TTS path so only ONE of the phone's audio instances
     * synthesizes + plays a tts_local utterance.
     */
    fun claimCallPlayback(callId: String): Boolean = TtsPlaybackRegistry.claim(callId, this)

    /**
     * Queue an utterance that was synthesized ON THIS DEVICE (local voice,
     * e.g. Jarvis) — joins the same serial queue / half-duplex gating as
     * server-streamed TTS so local and Mistral voices never talk over each
     * other.
     */
    fun enqueueLocalTts(callId: String, messageId: String?, wavFile: File) {
        if (!TtsPlaybackRegistry.claim(callId, this)) {
            Log.i(TAG, "local tts for call $callId owned by another audio instance; skipping")
            wavFile.delete()
            return
        }
        val key = ttsKey(callId, messageId)
        val stream = try { FileOutputStream(wavFile, true).also { it.close() } } catch (error: IOException) {
            Log.e(TAG, "local tts enqueue failed", error)
            wavFile.delete()
            return
        }
        val active = ActiveTts(callId, messageId, "wav", "audio/wav", wavFile, stream)
        Log.i(TAG, "local tts queued callId=$callId messageId=${messageId ?: "none"} bytes=${wavFile.length()}")
        synchronized(ttsQueue) {
            ttsQueue.addLast(key to active)
            if (currentTts == null) playNextTts()
        }
    }

    /** Pop and play the next queued utterance; no-op when the queue is empty. */
    private fun playNextTts() {
        val next = synchronized(ttsQueue) {
            val item = ttsQueue.removeFirstOrNull()
            currentTts = item
            item
        } ?: return
        playTtsFile(next.first, next.second)
    }

    /**
     * Drop ONE utterance's dangling buffer (a mid-stream synthesis failure).
     * Unlike [clearTtsForCall] this touches nothing else: queued/playing
     * utterances keep going and the per-call playback claim stays held — a
     * call-scoped clear here silenced other agents mid-sentence in war rooms
     * and re-opened the dual-socket double-playback race.
     */
    fun clearTtsUtterance(callId: String, messageId: String) {
        val key = ttsKey(callId, messageId)
        val active = ttsBuffers.remove(key) ?: return
        try {
            active.stream.close()
        } catch (_: IOException) {
        }
        if (active.file.exists() && !active.file.delete()) {
            Log.w(TAG, "failed to delete dangling TTS file for $key")
        }
        Log.i(TAG, "cleared dangling tts utterance $key (synthesis failed server-side)")
    }

    fun clearTtsForCall(callId: String) {
        val keys = ttsBuffers.keys.filter { it.startsWith("$callId:") || it == callId }
        for (key in keys) {
            clearTtsBuffer(key)
        }
        // Drop queued (not-yet-played) utterances for this call and, if the one
        // currently playing belongs to it, stop it and move on.
        var stopCurrent = false
        synchronized(ttsQueue) {
            val iterator = ttsQueue.iterator()
            while (iterator.hasNext()) {
                val (key, active) = iterator.next()
                if (active.callId == callId) {
                    cleanupTtsFile(key, active.file)
                    iterator.remove()
                }
            }
            val playing = currentTts
            if (playing != null && playing.second.callId == callId) {
                cleanupTtsFile(playing.first, playing.second.file)
                currentTts = null
                stopCurrent = true
            }
        }
        if (stopCurrent) {
            releaseTtsPlayer()
            playNextTts()
        }
        // Free any playback claims for this call (covers a socket that claimed
        // but disconnected before finishing).
        TtsPlaybackRegistry.releaseForCall(callId)
    }

    fun playPcm(bytes: ByteArray) {
        val track = pcmTrack ?: AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build()
            )
            .setBufferSizeInBytes(AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(3200))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        pcmTrack = track
        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
        track.write(bytes, 0, bytes.size)
    }

    fun playBase64(audioBase64: String) {
        val bytes = Base64.decode(audioBase64, Base64.DEFAULT)
        val pcm = if (bytes.size > 44 && String(bytes.copyOfRange(0, 4)) == "RIFF") bytes.copyOfRange(44, bytes.size) else bytes
        playPcm(pcm)
    }

    fun release() {
        stop()
        for (key in ttsBuffers.keys.toList()) {
            clearTtsBuffer(key)
        }
        synchronized(ttsQueue) {
            for ((key, active) in ttsQueue) cleanupTtsFile(key, active.file)
            ttsQueue.clear()
            currentTts?.let { cleanupTtsFile(it.first, it.second.file) }
            currentTts = null
        }
        // Free this instance's call claims so a surviving audio instance (e.g.
        // the foreground service when the in-app socket dies) can take over.
        TtsPlaybackRegistry.releaseOwnedBy(this)
        releasePcmTrack()
        releaseTtsPlayer()
    }

    private fun playTtsFile(key: String, active: ActiveTts) {
        releaseTtsPlayer()
        // Ensure we are in call-mode audio routing so the voice-call stream is loud and audible.
        enterCallAudio(forceSpeaker = true)
        val mediaPlayer = MediaPlayer()
        ttsPlayer = mediaPlayer
        // Shared epilogue for complete/error/exception: clean this utterance up,
        // release the player, then let the next queued speaker take the floor.
        val finish = {
            cleanupTtsFile(key, active.file)
            releaseTtsPlayer()
            synchronized(ttsQueue) { currentTts = null }
            playNextTts()
        }
        try {
            mediaPlayer.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
                    .build()
            )
            mediaPlayer.setVolume(1.0f, 1.0f)
            mediaPlayer.setDataSource(active.file.absolutePath)
            mediaPlayer.setOnCompletionListener {
                Log.i(TAG, "tts playback complete callId=${active.callId} messageId=${active.messageId ?: "none"}")
                finish()
            }
            mediaPlayer.setOnErrorListener { _, what, extra ->
                Log.e(TAG, "tts playback error callId=${active.callId} messageId=${active.messageId ?: "none"} what=$what extra=$extra")
                finish()
                true
            }
            mediaPlayer.prepare()
            // Half-duplex: tell the mic to hold off until this finishes (see HalfDuplexGate).
            HalfDuplexGate.agentStartedSpeaking()
            mediaPlayer.start()
            Log.i(TAG, "tts playback started callId=${active.callId} messageId=${active.messageId ?: "none"} format=${active.audioFormat} mimeType=${active.mimeType}")
        } catch (error: Exception) {
            // Catch broadly, not just IOException: prepare()/setDataSource also
            // throw IllegalState/IllegalArgument/SecurityException (e.g. a 0-byte
            // file from a truncated chunk stream). If one escaped, finish() would
            // never run, currentTts would never clear, and the queue — all agent
            // speech — would stall forever.
            Log.e(TAG, "tts playback failed callId=${active.callId} messageId=${active.messageId ?: "none"}", error)
            finish()
        }
    }

    private fun clearTtsBuffer(key: String) {
        val active = ttsBuffers.remove(key) ?: return
        try {
            active.stream.close()
        } catch (_: IOException) {
        }
        cleanupTtsFile(key, active.file)
    }

    private fun cleanupTtsFile(key: String, file: File) {
        // NOTE: do NOT release the registry claim here — claims are per CALL
        // (not per message), so surrendering after one utterance would hand the
        // rest of the call to the other audio instance mid-conversation. Claims
        // are freed in clearTtsForCall (call end) and release() (teardown).
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "failed to delete TTS temp file for $key: ${file.absolutePath}")
        }
    }

    private fun releasePcmTrack() {
        pcmTrack?.run {
            try {
                stop()
            } catch (error: IllegalStateException) {
                Log.w(TAG, "player stop ignored: ${error.message}")
            }
            release()
        }
        pcmTrack = null
    }

    private fun releaseTtsPlayer() {
        // Playback is ending (complete/error/replaced) — let the mic listen again.
        HalfDuplexGate.agentStoppedSpeaking()
        ttsPlayer?.run {
            try {
                stop()
            } catch (error: IllegalStateException) {
                Log.w(TAG, "player stop ignored: ${error.message}")
            }
            release()
        }
        ttsPlayer = null
    }

    private fun ttsKey(callId: String, messageId: String?): String = messageId?.let { "$callId:$it" } ?: callId

    private fun safeFilePart(value: String): String = value.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private data class ActiveTts(
        val callId: String,
        val messageId: String?,
        val audioFormat: String,
        val mimeType: String,
        val file: File,
        val stream: FileOutputStream
    )

    companion object {
        private const val TAG = "AgentPhoneAudio"

        // ~100 ms frame @ 16 kHz mono PCM16 (3200 bytes = 1600 samples).
        private const val FRAME_BYTES = 3200
        // VAD tuning (RMS on the PCM16 0..32767 scale). May need per-device adjustment.
        private const val START_RMS = 1200.0          // sustained energy above this = speech onset
        private const val END_RMS = 700.0             // energy below this = silence (hysteresis)
        private const val MIN_SPEECH_FRAMES = 2       // ~200 ms before a turn starts (debounce)
        private const val SILENCE_FRAMES_TO_END = 8   // ~800 ms of silence ends a turn
        // ~700 ms kept before onset. 300 ms was clipping short leading words —
        // "Kick Claude" reached STT as just "Claude.", turning a kick command
        // into a question routed straight to Claude.
        private const val MAX_PREROLL_FRAMES = 7
    }
}
