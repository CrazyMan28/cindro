package com.jarvis.app.voice

import android.util.Base64
import com.jarvis.app.net.JarvisRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext

/**
 * Push-to-talk orchestration for one chat session: hold the mic, [startRecording]; on
 * release, [stopAndTranscribe] sends the captured WAV to the daemon's `voice.stt`
 * (Mistral Voxtral) and returns the transcript. Replies are spoken via [speak] ->
 * `voice.tts` -> [TtsPlayer].
 *
 * The Mistral key never touches the phone — both legs are daemon-proxied over Contract C.
 */
class VoiceController(
    private val repo: JarvisRepository,
    private val player: TtsPlayer,
) {
    enum class Phase { IDLE, RECORDING, TRANSCRIBING, SPEAKING }

    private val recorder = AudioRecorder()

    private val _phase = MutableStateFlow(Phase.IDLE)
    val phase: StateFlow<Phase> = _phase

    /** True once recording starts; false if the mic couldn't be acquired. */
    fun startRecording(): Boolean {
        if (_phase.value == Phase.RECORDING) return true
        val ok = recorder.start()
        if (ok) _phase.value = Phase.RECORDING
        return ok
    }

    fun cancelRecording() {
        recorder.cancel()
        if (_phase.value == Phase.RECORDING) _phase.value = Phase.IDLE
    }

    /** Stop the mic, upload the WAV, return the transcript (or null on failure/empty). */
    suspend fun stopAndTranscribe(lang: String? = null): String? {
        if (_phase.value != Phase.RECORDING) return null
        val wav = withContext(Dispatchers.Default) { recorder.stopToWav() }
        if (wav.size <= 44) { _phase.value = Phase.IDLE; return null } // header-only = silence
        _phase.value = Phase.TRANSCRIBING
        return try {
            val b64 = Base64.encodeToString(wav, Base64.NO_WRAP)
            val text = repo.voiceStt(b64, AudioRecorder.MIME, lang)
            text.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            null
        } finally {
            if (_phase.value == Phase.TRANSCRIBING) _phase.value = Phase.IDLE
        }
    }

    /** Synthesize [text] via voice.tts and play it back. No-op on empty/failure. */
    suspend fun speak(text: String, voice: String?) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        _phase.value = Phase.SPEAKING
        try {
            val out = repo.voiceTts(trimmed.take(2_000), voice?.ifBlank { null })
            if (out != null) {
                val (b64, mime) = out
                withContext(Dispatchers.Main) { player.play(b64, mime) }
            }
        } catch (_: Exception) {
            // playback unavailable; stay silent
        } finally {
            _phase.value = Phase.IDLE
        }
    }

    fun stopSpeaking() {
        player.stop()
        if (_phase.value == Phase.SPEAKING) _phase.value = Phase.IDLE
    }
}
