package com.jarvis.app.ui.computer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.ui.ConnectionPill
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.StatusPill
import com.jarvis.app.ui.util.Biometric
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputerScreen(
    viewModel: ComputerViewModel,
    activity: FragmentActivity,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    val scope = rememberScope()

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Computer") },
                actions = {
                    ConnectionPill(conn)
                    IconButton(onClick = viewModel::refresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                "Live-view a session's nested agent desktop, drive it remotely, or take over your real screen.",
                style = MaterialTheme.typography.bodySmall,
                color = JarvisPalette.TextSecondary,
            )

            // Session selector
            if (state.sessions.isEmpty()) {
                Text(
                    state.error ?: "No sessions to mirror. Start a co-worker session first.",
                    color = if (state.error != null) JarvisPalette.Error else JarvisPalette.TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(state.sessions, key = { it.id }) { s ->
                        FilterChip(
                            selected = state.selected == s.id,
                            onClick = { viewModel.select(s.id) },
                            label = { Text(s.displayTitle, maxLines = 1) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = JarvisPalette.AccentDim,
                                selectedLabelColor = JarvisPalette.TextPrimary,
                            ),
                        )
                    }
                }
            }

            // Video surface
            GlowCard(
                modifier = Modifier.fillMaxWidth(),
                accent = state.mirroring,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(16f / 10f)
                        .background(JarvisPalette.Background),
                    contentAlignment = Alignment.Center,
                ) {
                    val frame = state.frame
                    if (frame != null) {
                        val image = frame.asImageBitmap()
                        Canvas(
                            modifier = Modifier
                                .fillMaxSize()
                                .pointerInputGestures(
                                    onTap = { fx, fy -> viewModel.remoteTap(fx, fy) },
                                ),
                        ) {
                            // Letterbox-fit the JPEG into the canvas, keep aspect.
                            val iw = image.width.toFloat()
                            val ih = image.height.toFloat()
                            if (iw > 0 && ih > 0) {
                                val sx = size.width / iw
                                val sy = size.height / ih
                                val s = minOf(sx, sy)
                                val dx = (size.width - iw * s) / 2f
                                val dy = (size.height - ih * s) / 2f
                                translate(dx, dy) {
                                    scale(s, s, pivot = Offset.Zero) {
                                        drawImage(image)
                                    }
                                }
                            }
                        }
                    } else {
                        Text(
                            if (state.mirroring) "Waiting for first frame…" else "Tap Start to mirror",
                            color = JarvisPalette.TextSecondary,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }

                    state.status?.let {
                        StatusPill(it.uppercase(), JarvisPalette.Accent)
                    }
                }
            }

            state.error?.let {
                Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
            }

            // Controls
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!state.mirroring) {
                    Button(
                        onClick = {
                            scope.launch {
                                val ok = Biometric.authenticate(
                                    activity,
                                    title = "Start screen mirror",
                                    subtitle = "View the agent desktop live",
                                )
                                if (ok) viewModel.startMirror()
                            }
                        },
                        enabled = state.selected != null,
                        colors = ButtonDefaults.buttonColors(containerColor = JarvisPalette.Accent, contentColor = JarvisPalette.OnAccent),
                    ) {
                        Icon(Icons.Filled.PlayArrow, contentDescription = null)
                        Text("  Start")
                    }
                } else {
                    Button(
                        onClick = { viewModel.stopMirror() },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JarvisPalette.Error.copy(alpha = 0.18f),
                            contentColor = JarvisPalette.Error,
                        ),
                    ) {
                        Icon(Icons.Filled.Stop, contentDescription = null)
                        Text("  Stop")
                    }
                }
            }

            Spacer(Modifier.height(4.dp))

            // Take over the real screen (biometric, high-risk).
            Button(
                onClick = {
                    scope.launch {
                        val ok = Biometric.authenticate(
                            activity,
                            title = "Take over the screen",
                            subtitle = "Jarvis will control your real laptop screen",
                        )
                        if (ok) viewModel.takeOver { _, _ -> }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = JarvisPalette.Accent.copy(alpha = 0.16f),
                    contentColor = JarvisPalette.Accent,
                ),
            ) { Text("TAKE OVER MY SCREEN") }
        }
    }
}

@Composable
private fun rememberScope() = androidx.compose.runtime.rememberCoroutineScope()

/** Tap-to-click gesture: reports a source-normalized (0..1) coordinate. */
private fun Modifier.pointerInputGestures(onTap: (Float, Float) -> Unit): Modifier =
    this.pointerInput(Unit) {
        val w = size.width.toFloat()
        val h = size.height.toFloat()
        detectTapGestures(
            onTap = { offset ->
                if (w > 0f && h > 0f) onTap(offset.x / w, offset.y / h)
            },
        )
    }
