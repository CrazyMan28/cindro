package com.agentphone

import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import com.agentphone.service.AgentPhoneForegroundService
import com.agentphone.state.ScreeningStore
import com.agentphone.ui.call.ScreeningScreen
import com.agentphone.ui.theme.AgentPhoneTheme

/**
 * Live call-screening window: the agent is talking to an unknown caller on the
 * user's behalf; this shows both sides as they speak, with Take over / End.
 */
class ScreeningActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureLockScreenBehavior()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        AgentPhoneForegroundService.start(this, "screening_activity")
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        render()
    }

    private fun render() {
        setContent {
            AgentPhoneTheme {
                ScreeningScreen(
                    onTakeOver = { callId ->
                        ScreeningStore.markTakingOver()
                        AgentPhoneForegroundService.dispatchScreeningTakeOver(this, callId)
                    },
                    onEnd = { callId ->
                        AgentPhoneForegroundService.dispatchScreeningEnd(this, callId)
                    },
                    onClose = {
                        ScreeningStore.clear()
                        finish()
                    }
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
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
    }

    companion object {
        const val ACTION_SHOW_SCREENING = "com.agentphone.action.SHOW_SCREENING"
    }
}
