package com.jarvis.app.voice

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationCompat
import com.jarvis.app.MainActivity
import com.jarvis.app.R
import com.jarvis.app.fcm.JarvisNotifier

/**
 * "Hey Cindro" wake. A foreground (microphone) service with a persistent, visible
 * notification — there is NO silent background listening. While it runs it uses the
 * on-device [SpeechRecognizer] as a cheap wake-word detector; on hearing the phrase it
 * launches [MainActivity] with [EXTRA_WAKE] so the chat opens straight into push-to-talk.
 *
 * The actual transcription of what the user then says still goes through the daemon's
 * `voice.stt` (Mistral Voxtral) — the wake detector only listens for the trigger phrase.
 */
class WakeService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithNotification()
        startWakeLoop()
        return START_STICKY
    }

    private fun startForegroundWithNotification() {
        JarvisNotifier.ensureChannels(this)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, WakeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, JarvisNotifier.CHANNEL_WAKE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(0xFF34D8FF.toInt())
            .setContentTitle("Cindro is listening")
            .setContentText("Say \"Hey Cindro\" to talk")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun startWakeLoop() {
        if (running) return
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            // Device can't do on-device recognition; keep the FG notification so the
            // user can still tap to open and push-to-talk manually.
            return
        }
        running = true
        listenOnce()
    }

    private fun listenOnce() {
        if (!running) return
        handler.post {
            recognizer?.destroy()
            val rec = SpeechRecognizer.createSpeechRecognizer(this)
            recognizer = rec
            rec.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
                override fun onPartialResults(partialResults: Bundle?) {
                    checkForWake(partialResults)
                }

                override fun onResults(results: Bundle?) {
                    if (!checkForWake(results)) restartSoon()
                }

                override fun onError(error: Int) {
                    // No-match / timeout are normal between phrases; just loop.
                    restartSoon()
                }
            })
            rec.startListening(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true),
            )
        }
    }

    private fun checkForWake(bundle: Bundle?): Boolean {
        val phrases = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return false
        val hit = phrases.any { it.lowercase().let { p -> p.contains("hey cindro") || p.contains("cindro") } }
        if (hit) onWakeDetected()
        return hit
    }

    private fun onWakeDetected() {
        running = false
        handler.post { recognizer?.destroy(); recognizer = null }
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_WAKE, true),
        )
        // Resume listening shortly after handing off.
        handler.postDelayed({ running = true; listenOnce() }, 4_000)
    }

    private fun restartSoon() {
        if (!running) return
        handler.postDelayed({ listenOnce() }, 600)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        recognizer = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_WAKE = "jarvis.wake"
        const val ACTION_STOP = "com.jarvis.app.WAKE_STOP"
        private const val NOTIF_ID = 0xCAFE

        fun start(context: Context) {
            val i = Intent(context, WakeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, WakeService::class.java).setAction(ACTION_STOP))
        }
    }
}
