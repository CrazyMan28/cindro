package com.agentphone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import com.agentphone.state.OutgoingCallBridge
import com.agentphone.ui.call.OutgoingCallScreen
import com.agentphone.ui.theme.AgentPhoneTheme

class OutgoingCallActivity : ComponentActivity() {

    private var callId: String = ""
    private var toExtension: String = ""

    // Push-to-talk needs RECORD_AUDIO. MainActivity asks at launch, but if it
    // wasn't granted then, the call screen must be able to prompt itself instead
    // of dead-ending on "microphone unavailable".
    private val requestMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* user taps talk after granting */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        callId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty()
        toExtension = intent.getStringExtra(EXTRA_TO_EXTENSION).orEmpty()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
        }
        // callId may be blank at launch (we open the screen as soon as the user
        // dials, before the server assigns one). Only bail if we have neither a
        // callId nor a target to show.
        if (callId.isBlank() && toExtension.isBlank()) { finish(); return }

        // Audio + hang-up go through the bridge → AppViewModel, which owns the
        // live WebSocket that placed this call (and plays its TTS). Using the
        // foreground service here sent audio over a different/absent socket,
        // which is why push-to-talk reported "microphone unavailable".
        setContent {
            AgentPhoneTheme {
                OutgoingCallScreen(
                    callId = callId,
                    toExtension = toExtension,
                    onEnd = {
                        OutgoingCallBridge.onAudioStop?.invoke()
                        OutgoingCallBridge.onEndCall?.invoke()
                        finish()
                    },
                    onAudioStart = { OutgoingCallBridge.onAudioStart?.invoke() ?: false },
                    onMuteChanged = { OutgoingCallBridge.onMuteChanged?.invoke(it) }
                )
            }
        }
    }

    companion object {
        const val EXTRA_CALL_ID: String = "callId"
        const val EXTRA_TO_EXTENSION: String = "toExtension"

        @Suppress("unused")
        fun start(activity: Activity, callId: String, toExtension: String) {
            activity.startActivity(
                Intent(activity, OutgoingCallActivity::class.java)
                    .putExtra(EXTRA_CALL_ID, callId)
                    .putExtra(EXTRA_TO_EXTENSION, toExtension)
            )
        }
    }
}
