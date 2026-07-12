package com.cindro.app.ui.phone

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cindro.app.ui.theme.JarvisPalette

/**
 * Cindro's Phone tab. The full Agent Phone app is vendored verbatim into this one
 * APK under [com.agentphone] — every screen, setting and flow. Rather than re-skin
 * or reimplement any of it, the Phone tab simply launches the real
 * [com.agentphone.MainActivity], which renders the original `AppRoot()` (Calls /
 * Inbox / Agents / HUD / Settings + setup wizard + call screens) full-screen.
 *
 * It opens automatically the first time the tab is shown, and the button reopens it
 * after the user backs out — the Cindro bottom nav stays visible here so this is
 * never a dead end.
 */
@Composable
fun PhoneLaunchScreen() {
    val context = LocalContext.current

    fun openPhone() {
        context.startActivity(Intent(context, com.agentphone.MainActivity::class.java))
    }

    // Auto-open the full Agent Phone the first time the Phone tab is shown.
    LaunchedEffect(Unit) { openPhone() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(JarvisPalette.Background)
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(JarvisPalette.Accent.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.Phone,
                contentDescription = null,
                tint = JarvisPalette.Accent,
                modifier = Modifier.size(46.dp),
            )
        }
        Spacer(Modifier.height(24.dp))
        Text(
            "Agent Phone",
            color = JarvisPalette.TextPrimary,
            fontSize = 26.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            "Calls, inbox, agents, HUD, screening and every phone setting — the full Agent Phone, inside Cindro.",
            color = JarvisPalette.TextSecondary,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = { openPhone() },
            colors = ButtonDefaults.buttonColors(
                containerColor = JarvisPalette.Accent,
                contentColor = JarvisPalette.OnAccent,
            ),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier
                .height(52.dp)
                .fillMaxWidth(0.72f),
        ) {
            Icon(Icons.Filled.Phone, contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text("Open Phone", fontSize = 16.sp, fontWeight = FontWeight.Medium)
        }
    }
}
