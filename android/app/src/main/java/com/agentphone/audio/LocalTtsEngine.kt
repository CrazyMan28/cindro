package com.agentphone.audio

import android.content.Context
import android.util.Log
import com.agentphone.net.AgentPhoneClient
import com.agentphone.state.AgentPhoneSettings
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.zip.ZipInputStream

/**
 * ON-DEVICE TTS for "local:*" voices (e.g. the Jarvis Piper model). The model
 * is DOWNLOADED from the Agent Phone server on first use and all synthesis
 * runs HERE on the phone (sherpa-onnx) — the laptop never runs inference.
 */
object LocalTtsEngine {
    private const val TAG = "LocalTtsEngine"

    private var tts: OfflineTts? = null
    private var loadedVoice: String? = null
    private val lock = Any()

    private fun voiceDir(context: Context, voice: String): File =
        File(context.filesDir, "local-voices/$voice")

    private fun espeakDir(context: Context): File =
        File(context.filesDir, "local-voices/espeak-ng-data")

    fun isReady(context: Context, voiceId: String): Boolean {
        val voice = voiceId.removePrefix("local:")
        val dir = voiceDir(context, voice)
        return File(dir, "model.onnx").length() > 0 &&
            File(dir, "tokens.txt").length() > 0 &&
            File(espeakDir(context), "phontab").exists()
    }

    /**
     * Download model + espeak data from the server (blocking; call off-main).
     * Returns true when everything is in place.
     */
    fun ensureReady(
        context: Context,
        client: AgentPhoneClient,
        settings: AgentPhoneSettings,
        voiceId: String,
        onStatus: (String) -> Unit = {}
    ): Boolean {
        val voice = voiceId.removePrefix("local:")
        val dir = voiceDir(context, voice).apply { mkdirs() }

        fun fetch(path: String, dest: File): Boolean {
            if (dest.length() > 0) return true
            val latch = CountDownLatch(1)
            var ok = false
            client.downloadFile(settings, path, dest) { success -> ok = success; latch.countDown() }
            latch.await()
            if (!ok) dest.delete()
            return ok
        }

        // Cache invalidation: if the server's model differs in SIZE from what's
        // cached, the cached copy is stale (e.g. the old crash-prone de_DE model)
        // — delete it so the corrected model is re-downloaded. A stale cached
        // model is exactly what made on-device calls crash after a model swap.
        val expectedSize = fetchExpectedModelSize(client, settings, voice)
        val cachedModel = File(dir, "model.onnx")
        if (expectedSize != null && cachedModel.length() != expectedSize) {
            Log.i(TAG, "model size ${cachedModel.length()} != server $expectedSize — re-downloading $voice")
            cachedModel.delete()
            File(dir, "tokens.txt").delete()
            File(dir, "config.json").delete()
            tts?.release(); tts = null; loadedVoice = null
        }

        if (isReady(context, voiceId)) return true

        onStatus("Downloading $voice voice model…")
        if (!fetch("/api/local-voices/$voice/model.onnx", File(dir, "model.onnx"))) return false
        if (!fetch("/api/local-voices/$voice/tokens.txt", File(dir, "tokens.txt"))) return false
        if (!fetch("/api/local-voices/$voice/config.json", File(dir, "config.json"))) return false

        val espeak = espeakDir(context)
        if (!File(espeak, "phontab").exists()) {
            onStatus("Downloading speech data…")
            val zip = File(context.cacheDir, "espeak-ng-data.zip")
            if (!fetch("/api/local-voices/espeak-ng-data.zip", zip)) return false
            try {
                unzip(zip, espeak.parentFile!!)
            } catch (error: Throwable) {
                Log.e(TAG, "espeak unzip failed", error)
                return false
            } finally {
                zip.delete()
            }
        }
        onStatus("$voice voice ready")
        return isReady(context, voiceId)
    }

    /** The server's current model.onnx size for this voice (null if unknown). */
    private fun fetchExpectedModelSize(client: AgentPhoneClient, settings: AgentPhoneSettings, voice: String): Long? {
        val latch = CountDownLatch(1)
        var size: Long? = null
        client.getLocalVoiceManifest(settings) { result ->
            if (result != null) try {
                val voices = org.json.JSONObject(result).optJSONArray("voices")
                if (voices != null) for (i in 0 until voices.length()) {
                    val v = voices.getJSONObject(i)
                    if (v.optString("id") == "local:$voice") {
                        size = v.optJSONObject("files")?.optJSONObject("model")?.optLong("size")?.takeIf { it > 0 }
                    }
                }
            } catch (_: Throwable) {}
            latch.countDown()
        }
        latch.await()
        return size
    }

    /** Synthesize to a 16-bit PCM WAV file. Returns null on failure. */
    fun synthesizeToWav(context: Context, voiceId: String, text: String, speed: Float = 1.0f): File? {
        val voice = voiceId.removePrefix("local:")
        if (!isReady(context, voiceId)) return null
        synchronized(lock) {
            try {
                if (tts == null || loadedVoice != voice) {
                    tts?.release()
                    val dir = voiceDir(context, voice)
                    val config = OfflineTtsConfig(
                        model = OfflineTtsModelConfig(
                            vits = OfflineTtsVitsModelConfig(
                                model = File(dir, "model.onnx").absolutePath,
                                tokens = File(dir, "tokens.txt").absolutePath,
                                dataDir = espeakDir(context).absolutePath
                            ),
                            numThreads = 2
                        )
                    )
                    tts = OfflineTts(config = config)
                    loadedVoice = voice
                    Log.i(TAG, "loaded on-device voice $voice")
                }
                val engine = tts ?: return null
                val audio = engine.generate(text = text, sid = 0, speed = speed)
                if (audio.samples.isEmpty()) return null
                val out = File(context.cacheDir, "local-tts-${System.currentTimeMillis()}.wav")
                writeWav(out, audio.samples, audio.sampleRate)
                return out
            } catch (error: Throwable) {
                Log.e(TAG, "synthesis failed for $voice", error)
                // Drop the engine so a corrupt state doesn't poison later calls.
                try { tts?.release() } catch (_: Throwable) {}
                tts = null
                loadedVoice = null
                return null
            }
        }
    }

    private fun writeWav(file: File, samples: FloatArray, sampleRate: Int) {
        val pcm = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            val v = (samples[i].coerceIn(-1f, 1f) * 32767f).toInt()
            pcm[i * 2] = (v and 0xff).toByte()
            pcm[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
        }
        FileOutputStream(file).use { out ->
            val dataLen = pcm.size
            val header = ByteArray(44)
            fun putStr(o: Int, s: String) { s.forEachIndexed { i, c -> header[o + i] = c.code.toByte() } }
            fun putInt(o: Int, v: Int) { for (i in 0..3) header[o + i] = ((v shr (8 * i)) and 0xff).toByte() }
            fun putShort(o: Int, v: Int) { header[o] = (v and 0xff).toByte(); header[o + 1] = ((v shr 8) and 0xff).toByte() }
            putStr(0, "RIFF"); putInt(4, 36 + dataLen); putStr(8, "WAVE")
            putStr(12, "fmt "); putInt(16, 16); putShort(20, 1); putShort(22, 1)
            putInt(24, sampleRate); putInt(28, sampleRate * 2); putShort(32, 2); putShort(34, 16)
            putStr(36, "data"); putInt(40, dataLen)
            out.write(header); out.write(pcm)
        }
        // Sanity: a truncated header write would produce an unplayable file.
        RandomAccessFile(file, "r").use { if (it.length() < 44L + 2) throw IllegalStateException("wav write failed") }
    }

    private fun unzip(zip: File, destDir: File) {
        destDir.mkdirs()
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            var entry = zin.nextEntry
            while (entry != null) {
                val target = File(destDir, entry.name)
                // Zip-slip guard.
                if (!target.canonicalPath.startsWith(destDir.canonicalPath)) {
                    entry = zin.nextEntry
                    continue
                }
                if (entry.isDirectory) target.mkdirs()
                else {
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { zin.copyTo(it) }
                }
                entry = zin.nextEntry
            }
        }
    }
}
