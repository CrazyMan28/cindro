package com.jarvis.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.jarvis.app.protocol.Session
import com.jarvis.app.ui.canvas.CanvasItem
import com.jarvis.app.ui.home.HomeContent
import com.jarvis.app.ui.home.HomeUiState
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.JarvisTheme

/**
 * Debug-only design preview: renders the new Home dashboard + bottom nav with sample
 * data, no pairing/daemon required. Launched via adb to screenshot the redesign:
 *   adb shell am start -n com.jarvis.app.debug/com.jarvis.app.ui.PreviewActivity
 * Not in the launcher; harmless if shipped.
 */
class PreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { JarvisTheme { Preview() } }
    }
}

private val SAMPLE = HomeUiState(
    sessions = listOf(
        Session("1", "Python Desktop Main", "coder", "codex", "working", 0),
        Session("2", "Open Spotify and play music", "coworker", "codex", "idle", 0),
        Session("3", "Show me live CPU usage", "coworker", "claude", "idle", 0),
    ),
    latestCanvas = CanvasItem(
        "cpu", "CPU & Memory",
        """{"type":"column","gap":9,"children":[
            {"type":"text","text":"CPU 34%","weight":700,"color":"#EAF2F8"},
            {"type":"progress","value":34,"color":"#3DD6FF"},
            {"type":"text","text":"RAM 46%","weight":700,"color":"#EAF2F8"},
            {"type":"progress","value":46,"color":"#5B8CFF"}]}""",
    ),
)

private val TABS = listOf(
    "Home" to Icons.Filled.Home,
    "Chat" to Icons.AutoMirrored.Filled.Chat,
    "Canvas" to Icons.Filled.Dashboard,
    "Computer" to Icons.Filled.Computer,
    "Settings" to Icons.Filled.Settings,
)

@Composable
private fun Preview() {
    Scaffold(
        containerColor = JarvisPalette.Background,
        bottomBar = {
            NavigationBar(containerColor = JarvisPalette.Surface) {
                TABS.forEachIndexed { i, (label, icon) ->
                    NavigationBarItem(
                        selected = i == 0,
                        onClick = {},
                        icon = { Icon(icon, contentDescription = label) },
                        label = { Text(label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = JarvisPalette.OnAccent,
                            selectedTextColor = JarvisPalette.Accent,
                            indicatorColor = JarvisPalette.Accent,
                            unselectedIconColor = JarvisPalette.TextSecondary,
                            unselectedTextColor = JarvisPalette.TextSecondary,
                        ),
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            HomeContent(
                state = SAMPLE, online = true,
                onNewChat = {}, onVoice = {}, onOpenSession = {},
                onAllSessions = {}, onTakeOver = {}, onCanvas = {},
            )
        }
    }
}
