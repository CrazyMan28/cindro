package com.agentphone

import android.Manifest
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import com.agentphone.audio.PushToTalkAudio
import com.agentphone.service.AgentPhoneForegroundService
import com.agentphone.service.IncomingCallInfo
import com.agentphone.ui.call.IncomingCallScreen
import com.agentphone.ui.theme.AgentPhoneTheme

class IncomingCallActivity : ComponentActivity() {

    private val audio by lazy { PushToTalkAudio(this) }
    private var info: IncomingCallInfo? = null

    private val requestMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* user taps talk after granting */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureLockScreenBehavior()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
        }
        info = IncomingCallInfo.fromIntent(intent)
        AgentPhoneForegroundService.start(this, "incoming_activity")
        renderUi(showTextFallback = intent.action == ACTION_TEXT_FALLBACK, startInCall = intent.action == ACTION_RESUME_CALL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        info = IncomingCallInfo.fromIntent(intent)
        renderUi(showTextFallback = intent.action == ACTION_TEXT_FALLBACK, startInCall = intent.action == ACTION_RESUME_CALL)
    }

    override fun onDestroy() {
        audio.release()
        super.onDestroy()
    }

    private fun renderUi(showTextFallback: Boolean, startInCall: Boolean = false) {
        val call = info ?: run { finish(); return }
        setContent {
            AgentPhoneTheme {
                IncomingCallScreen(
                    info = call,
                    showTextFallback = showTextFallback,
                    startInCall = startInCall,
                    onAccept = { AgentPhoneForegroundService.dispatchAccept(this, call) },
                    onReject = {
                        AgentPhoneForegroundService.dispatchReject(this, call)
                        finish()
                    },
                    onEnd = {
                        AgentPhoneForegroundService.dispatchEnd(this, call)
                        finish()
                    },
                    onSendText = { text ->
                        AgentPhoneForegroundService.dispatchTextFallback(this, call, text)
                    },
                    audioStart = {
                        // Hands-free continuous capture; the on-device VAD sends one
                        // audio_start/chunk/end cycle per spoken turn via the service socket.
                        audio.startContinuous(
                            onUtteranceStart = { AgentPhoneForegroundService.sendAudioStartFromUi(call.callId) },
                            onChunk = { chunk -> AgentPhoneForegroundService.sendAudioChunkFromUi(call.callId, chunk) },
                            onUtteranceEnd = { AgentPhoneForegroundService.sendAudioEndFromUi(call.callId) }
                        )
                    },
                    audioStop = {
                        audio.stop()
                        AgentPhoneForegroundService.sendAudioEndFromUi(call.callId)
                    },
                    onMuteChanged = { audio.setMuted(it) }
                )
            }
        }
    }

    private fun configureLockScreenBehavior() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
    }

    companion object {
        const val ACTION_SHOW_INCOMING = "com.agentphone.action.SHOW_INCOMING"
        const val ACTION_TEXT_FALLBACK = "com.agentphone.action.SHOW_TEXT_FALLBACK"
        // Re-open the in-call screen for a call that's already active (from the
        // ongoing-call notification) — does NOT re-accept, just resumes the UI/mic.
        const val ACTION_RESUME_CALL = "com.agentphone.action.RESUME_CALL"
    }
}
