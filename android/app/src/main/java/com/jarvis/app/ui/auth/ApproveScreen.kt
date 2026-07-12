package com.jarvis.app.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.jarvis.app.JarvisApp
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.Biometric
import kotlinx.coroutines.launch

/**
 * 2FA + fingerprint cross-device unlock — the phone leg.
 *
 * Opened when the user taps the "Unlock Jarvis" FCM notification (challenge id in
 * the intent extra). Immediately runs BiometricPrompt (the second factor — the
 * already-authed device WS is the possession factor). On success it calls
 * [JarvisRepository.approveAuth], flipping the desktop's lock to unlocked. On
 * biometric failure it denies the challenge and offers a Retry.
 */
@Composable
fun ApproveScreen(
    app: JarvisApp,
    activity: FragmentActivity,
    challengeId: String,
    onUnlocked: () -> Unit = {},
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    // "auth" | "working" | "approved" | "denied" | "error"
    var phase by remember { mutableStateOf("auth") }
    var errorText by remember { mutableStateOf("") }

    fun runApproval() {
        phase = "auth"
        scope.launch {
            val ok = Biometric.authenticate(
                activity,
                title = "Unlock Jarvis",
                subtitle = "Confirm it's you to sign in on your computer",
            )
            if (!ok) {
                // Biometric failed/cancelled: tell the daemon (best-effort) so the
                // desktop can show "denied" instead of silently timing out.
                runCatching { app.repository.denyAuth(challengeId) }
                phase = "denied"
                return@launch
            }
            // Biometric cleared: this satisfies the app-open gate too, so returning
            // to the shell doesn't double-prompt with a second BiometricPrompt.
            onUnlocked()
            phase = "working"
            val res = runCatching { app.repository.approveAuth(challengeId) }
            if (res.isSuccess) {
                phase = "approved"
            } else {
                errorText = res.exceptionOrNull()?.message ?: "Could not reach Jarvis."
                phase = "error"
            }
        }
    }

    LaunchedEffect(challengeId) { runApproval() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (phase) {
            "auth", "working" -> {
                CircularProgressIndicator(color = JarvisPalette.Accent)
                Text(
                    text = if (phase == "auth") "Confirm your fingerprint…" else "Approving…",
                    color = JarvisPalette.TextSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 18.dp),
                )
            }
            "approved" -> {
                Text(
                    text = "Approved",
                    color = JarvisPalette.Success,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = "Return to your computer — it's unlocked.",
                    color = JarvisPalette.TextSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Button(
                    onClick = onDone,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Accent,
                        contentColor = JarvisPalette.OnAccent,
                    ),
                    modifier = Modifier.padding(top = 22.dp),
                ) { Text("Done") }
            }
            else -> { // denied | error
                Text(
                    text = if (phase == "denied") "Sign-in not confirmed" else "Couldn't approve",
                    color = JarvisPalette.Error,
                    textAlign = TextAlign.Center,
                )
                if (errorText.isNotEmpty()) {
                    Text(
                        text = errorText,
                        color = JarvisPalette.TextSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                Button(
                    onClick = { runApproval() },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Accent,
                        contentColor = JarvisPalette.OnAccent,
                    ),
                    modifier = Modifier.padding(top = 22.dp),
                ) { Text("Retry") }
                Button(
                    onClick = onDone,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Surface,
                        contentColor = JarvisPalette.TextSecondary,
                    ),
                    modifier = Modifier.padding(top = 8.dp),
                ) { Text("Dismiss") }
            }
        }
    }
}
