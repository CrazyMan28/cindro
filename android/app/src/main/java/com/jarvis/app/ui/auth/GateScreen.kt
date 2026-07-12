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
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.Biometric
import kotlinx.coroutines.launch

/**
 * App-open fingerprint gate (2FA + fingerprint cross-device unlock). When the app
 * is paired and the gate is enabled, this runs BiometricPrompt on launch BEFORE
 * the shell is shown. FAIL-OPEN: [Biometric.authenticate] returns true when the
 * device has no secure lock, so the user is never locked out of their own app.
 */
@Composable
fun GateScreen(
    activity: FragmentActivity,
    onUnlocked: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf(false) }

    fun runGate() {
        failed = false
        scope.launch {
            val ok = Biometric.authenticate(
                activity,
                title = "Unlock Orin",
                subtitle = "Confirm it's you",
            )
            if (ok) onUnlocked() else failed = true
        }
    }

    LaunchedEffect(Unit) { runGate() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (!failed) {
            CircularProgressIndicator(color = JarvisPalette.Accent)
            Text(
                text = "Confirm your fingerprint to open Orin",
                color = JarvisPalette.TextSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 18.dp),
            )
        } else {
            Text(
                text = "Locked",
                color = JarvisPalette.Error,
                textAlign = TextAlign.Center,
            )
            Button(
                onClick = { runGate() },
                colors = ButtonDefaults.buttonColors(
                    containerColor = JarvisPalette.Accent,
                    contentColor = JarvisPalette.OnAccent,
                ),
                modifier = Modifier.padding(top = 22.dp),
            ) { Text("Unlock") }
        }
    }
}
