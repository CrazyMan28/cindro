package com.jarvis.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * Plays the base64 audio returned by `voice.tts` (Mistral Voxtral; mp3 by default).
 *
 * We materialise the bytes to a temp file and hand the platform [MediaPlayer] a file
 * path — no extra dependency, and MediaPlayer demuxes mp3/wav/ogg natively. One player
 * instance is reused per process so replies keep playing across screen navigation.
 */
class TtsPlayer(context: Context) {

    private val appContext = context.applicationContext
    private var player: MediaPlayer? = null
    private var tempFile: File? = null

    private val _speaking = MutableStateFlow(false)
    val speaking: StateFlow<Boolean> = _speaking

    /** Decode + play [audioB64]. [mime] selects the temp-file extension for the demuxer. */
    fun play(audioB64: String, mime: String) {
        val bytes = runCatching { Base64.decode(audioB64, Base64.NO_WRAP) }.getOrNull() ?: return
        if (bytes.isEmpty()) return
        val ext = when {
            mime.contains("wav") -> "wav"
            mime.contains("ogg") || mime.contains("opus") -> "ogg"
            mime.contains("flac") -> "flac"
            else -> "mp3"
        }
        val f = File.createTempFile("jarvis_tts_", ".$ext", appContext.cacheDir)
        f.writeBytes(bytes)
        f.deleteOnExit()

        stopInternal()
        tempFile?.delete()
        tempFile = f

        val mp = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            setOnCompletionListener { _speaking.value = false }
            setOnErrorListener { _, _, _ -> _speaking.value = false; true }
        }
        player = mp
        runCatching {
            mp.setDataSource(f.absolutePath)
            mp.prepare()
            mp.start()
            _speaking.value = true
        }.onFailure { _speaking.value = false }
    }

    fun stop() {
        stopInternal()
        _speaking.value = false
    }

    private fun stopInternal() {
        player?.runCatching { if (isPlaying) stop() }
        player?.runCatching { reset() }
        player?.release()
        player = null
    }

    fun release() {
        stopInternal()
        tempFile?.delete()
        tempFile = null
        _speaking.value = false
    }
}
