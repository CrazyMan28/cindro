package com.jarvis.app.ui.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.net.DeviceClient
import com.jarvis.app.protocol.Session
import com.jarvis.app.ui.canvas.CanvasItem
import com.jarvis.app.ui.chat.WidgetRenderer
import com.jarvis.app.ui.theme.Avatar
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.QuickTile
import com.jarvis.app.ui.theme.SectionHeader
import com.jarvis.app.ui.theme.StatusDot
import com.jarvis.app.ui.theme.StatusPill

private fun brainColor(brain: String?): Color = when (brain?.lowercase()) {
    "codex" -> JarvisPalette.Accent
    "claude" -> JarvisPalette.Warning
    "api" -> JarvisPalette.Violet
    else -> JarvisPalette.TextSecondary
}

private fun stateColor(state: String?): Color = when (state?.lowercase()) {
    "working", "running", "busy" -> JarvisPalette.Success
    "paused" -> JarvisPalette.Warning
    else -> JarvisPalette.TextSecondary
}

@Composable
fun HomeScreen(
    viewModel: HomeViewModel,
    onOpenSession: (String) -> Unit,
    onOpenVoice: (String) -> Unit,
    onAllSessions: () -> Unit,
    onTakeOver: () -> Unit,
    onCanvas: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    HomeContent(
        state = state,
        online = conn == DeviceClient.State.CONNECTED,
        onNewChat = { viewModel.createSession(onCreated = onOpenSession) },
        onVoice = { viewModel.createSession(onCreated = onOpenVoice) },
        onOpenSession = onOpenSession,
        onAllSessions = onAllSessions,
        onTakeOver = onTakeOver,
        onCanvas = onCanvas,
    )
}

@Composable
fun HomeContent(
    state: HomeUiState,
    online: Boolean,
    onNewChat: () -> Unit,
    onVoice: () -> Unit,
    onOpenSession: (String) -> Unit,
    onAllSessions: () -> Unit,
    onTakeOver: () -> Unit,
    onCanvas: () -> Unit,
) {
    val greeting = remember {
        when (java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)) {
            in 0..11 -> "Good morning"
            in 12..17 -> "Good afternoon"
            else -> "Good evening"
        }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewChat,
                containerColor = JarvisPalette.Accent,
                contentColor = JarvisPalette.OnAccent,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New", fontWeight = FontWeight.Bold) },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 96.dp),
        ) {
            item {
                // Header: spinning reactor + greeting (fades/slides in on entry).
                val appear = remember { androidx.compose.animation.core.Animatable(0f) }
                LaunchedEffect(Unit) {
                    appear.animateTo(1f, androidx.compose.animation.core.tween(420))
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .graphicsLayer {
                            alpha = appear.value
                            translationY = (1f - appear.value) * 18f
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    com.jarvis.app.ui.util.JarvisOrb(size = 40.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(greeting, style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.ExtraBold, color = JarvisPalette.TextPrimary)
                        Text(
                            if (online) "Jarvis is on your laptop & ready." else "Connecting to Jarvis…",
                            style = MaterialTheme.typography.bodyMedium, color = JarvisPalette.TextSecondary,
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                StatusPill(
                    text = if (online) "ONLINE" else "OFFLINE",
                    color = if (online) JarvisPalette.Success else JarvisPalette.Warning,
                )
                Spacer(Modifier.height(20.dp))

                // Quick actions (2×2)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.weight(1f)) {
                        QuickTile(Icons.Filled.Add, "New chat", JarvisPalette.Accent, onNewChat)
                    }
                    Box(Modifier.weight(1f)) {
                        QuickTile(Icons.Filled.Computer, "Take over", JarvisPalette.Violet, onTakeOver)
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.weight(1f)) {
                        QuickTile(Icons.Filled.Mic, "Voice", JarvisPalette.Success, onVoice)
                    }
                    Box(Modifier.weight(1f)) {
                        QuickTile(Icons.Filled.Dashboard, "Canvas", JarvisPalette.Pink, onCanvas)
                    }
                }
                Spacer(Modifier.height(18.dp))
                SectionHeader("Jump back in", action = "All sessions", onAction = onAllSessions)
            }

            items(state.sessions.take(3), key = { it.id }) { session ->
                HomeSessionCard(session, onClick = { onOpenSession(session.id) })
                Spacer(Modifier.height(10.dp))
            }

            item {
                Spacer(Modifier.height(8.dp))
                SectionHeader("Live widget", action = "Canvas", onAction = onCanvas)
                LiveWidgetCard(state.latestCanvas)
            }
        }
    }
}

@Composable
private fun HomeSessionCard(session: Session, onClick: () -> Unit) {
    GlowCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        contentPadding = PaddingValues(13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(session.brain?.take(1) ?: "J", brainColor(session.brain))
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    session.displayTitle, style = MaterialTheme.typography.titleMedium,
                    color = JarvisPalette.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(5.dp))
                Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    session.state?.let { StatusDot(it, stateColor(it)) }
                    val meta = listOfNotNull(session.brain, session.profile)
                        .joinToString(" · ") { it.replaceFirstChar(Char::uppercase) }
                    if (meta.isNotEmpty()) {
                        Text(meta, style = MaterialTheme.typography.bodySmall,
                            color = JarvisPalette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                tint = JarvisPalette.TextFaint)
        }
    }
}

@Composable
private fun LiveWidgetCard(canvas: CanvasItem?) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = JarvisPalette.Surface,
        border = BorderStroke(1.dp, JarvisPalette.Outline),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box(Modifier.padding(15.dp)) {
            if (canvas != null) {
                Column {
                    Text(canvas.title.ifBlank { "Live canvas" },
                        style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(10.dp))
                    WidgetRenderer(canvas.specJson)
                }
            } else {
                Text(
                    "No live widgets yet — ask Jarvis to show you a chart or a status card, and it'll appear here.",
                    style = MaterialTheme.typography.bodyMedium, color = JarvisPalette.TextSecondary,
                )
            }
        }
    }
}
