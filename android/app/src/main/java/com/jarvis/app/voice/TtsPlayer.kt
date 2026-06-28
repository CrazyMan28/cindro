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
 * STRICT FIFO QUEUE: every clip — every segment of one reply AND every separate
 * message — is appended to a single queue and played one at a time on ONE shared
 * [MediaPlayer]. Message 1 finishes completely before message 2 begins; clips never
 * overlap or cut each other off.
 *
 * This fixes the old behavior, which stopped the current player and spawned a NEW
 * MediaPlayer for every clip — so a second reply arriving mid-playback talked over
 * (and corrupted the temp file of) the first.
 *
 * [stop] is a barge-in: it clears the queue and silences playback.
 */
class TtsPlayer(context: Context) {

    private val appContext = context.applicationContext
    private val lock = Any()
    private var player: MediaPlayer? = null
    private val queue = ArrayDeque<File>()   // pending clip files, in arrival order
    private var playing = false

    private val _speaking = MutableStateFlow(false)
    val speaking: StateFlow<Boolean> = _speaking

    /** Decode [audioB64], stage it, and ENQUEUE it. Plays now only if idle. */
    fun play(audioB64: String, mime: String) {
        val bytes = runCatching { Base64.decode(audioB64, Base64.NO_WRAP) }.getOrNull() ?: return
        if (bytes.isEmpty()) return
        val ext = when {
            mime.contains("wav") -> "wav"
            mime.contains("ogg") || mime.contains("opus") -> "ogg"
            mime.contains("flac") -> "flac"
            else -> "mp3"
        }
        val f = runCatching {
            File.createTempFile("jarvis_tts_", ".$ext", appContext.cacheDir).also {
                it.writeBytes(bytes)
                it.deleteOnExit()
            }
        }.getOrNull() ?: return

        synchronized(lock) {
            queue.addLast(f)
            if (!playing) playNextLocked()
        }
    }

    /** Pop the head of the queue and play it. Caller holds [lock]. */
    private fun playNextLocked() {
        val f = queue.removeFirstOrNull()
        if (f == null) {
            playing = false
            _speaking.value = false
            return
        }
        playing = true
        _speaking.value = true

        // Reuse a single player: reset between clips instead of creating new ones.
        val mp = player ?: MediaPlayer().also { player = it }
        runCatching {
            mp.reset()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            mp.setOnCompletionListener { onClipDone(f) }
            mp.setOnErrorListener { _, _, _ -> onClipDone(f); true }
            mp.setDataSource(f.absolutePath)
            mp.prepare()
            mp.start()
        }.onFailure {
            // Couldn't play this clip — drop it and advance so the queue never stalls.
            onClipDone(f)
        }
    }

    /** A clip finished (or errored): clean it up and advance to the next. */
    private fun onClipDone(finished: File) {
        synchronized(lock) {
            runCatching { finished.delete() }
            playNextLocked()
        }
    }

    /** Barge-in: drop everything queued and silence the player. */
    fun stop() {
        synchronized(lock) {
            queue.forEach { runCatching { it.delete() } }
            queue.clear()
            playing = false
            player?.runCatching { if (isPlaying) stop() }
            player?.runCatching { reset() }
            _speaking.value = false
        }
    }

    fun release() {
        synchronized(lock) {
            queue.forEach { runCatching { it.delete() } }
            queue.clear()
            playing = false
            player?.runCatching { reset() }
            player?.release()
            player = null
            _speaking.value = false
        }
    }
}
