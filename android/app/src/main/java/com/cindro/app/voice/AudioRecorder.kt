package com.cindro.app.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Records 16 kHz mono PCM from the mic and packages it as a WAV container so the
 * daemon's `voice.stt` (Mistral Voxtral transcribe) gets a self-describing file.
 *
 * We use [AudioRecord] rather than MediaRecorder so we control the exact sample rate
 * and can stream a clean WAV — Voxtral accepts wav/mp3/etc., and 16 kHz mono is the
 * sweet spot for speech transcription size/accuracy.
 */
class AudioRecorder {

    private var record: AudioRecord? = null
    @Volatile private var recording = false
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()

    val isRecording: Boolean get() = recording

    @SuppressLint("MissingPermission") // caller checks RECORD_AUDIO before invoking
    fun start(): Boolean {
        if (recording) return true
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuf <= 0) return false
        val bufSize = maxOf(minBuf, SAMPLE_RATE) // ~1s headroom
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE, CHANNEL, ENCODING, bufSize,
            )
        } catch (e: Exception) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        synchronized(pcm) { pcm.reset() }
        record = rec
        recording = true
        rec.startRecording()
        thread = Thread {
            val buf = ByteArray(bufSize)
            while (recording) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) synchronized(pcm) { pcm.write(buf, 0, n) }
            }
        }.apply { isDaemon = true; start() }
        return true
    }

    /** Stop recording and return the captured audio as a complete WAV byte array. */
    fun stopToWav(): ByteArray {
        recording = false
        thread?.join(500)
        thread = null
        record?.runCatching { stop() }
        record?.release()
        record = null
        val raw = synchronized(pcm) { pcm.toByteArray() }
        return wrapWav(raw)
    }

    fun cancel() {
        recording = false
        thread?.join(200)
        thread = null
        record?.runCatching { stop() }
        record?.release()
        record = null
        synchronized(pcm) { pcm.reset() }
    }

    private fun wrapWav(pcmBytes: ByteArray): ByteArray {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = SAMPLE_RATE * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val dataLen = pcmBytes.size
        val out = ByteArrayOutputStream(44 + dataLen)
        fun str(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun i32(v: Int) = out.write(
            ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array(),
        )
        fun i16(v: Int) = out.write(
            ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(v.toShort()).array(),
        )
        str("RIFF"); i32(36 + dataLen); str("WAVE")
        str("fmt "); i32(16); i16(1); i16(channels)
        i32(SAMPLE_RATE); i32(byteRate); i16(blockAlign); i16(bitsPerSample)
        str("data"); i32(dataLen)
        out.write(pcmBytes)
        return out.toByteArray()
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val MIME = "audio/wav"
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }
}
