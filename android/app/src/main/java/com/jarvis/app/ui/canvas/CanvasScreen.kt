package com.jarvis.app.ui.canvas

import android.widget.Toast
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.ui.chat.WidgetRenderer
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.widget.WidgetPinHelper

/**
 * The Canvas / Widgets gallery — every canvas the model has drawn, in one place
 * (previously they only appeared inline in a chat). Each card renders live and can
 * be pinned to the home screen as a real Android widget.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasScreen(viewModel: CanvasViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Canvas", fontWeight = FontWeight.SemiBold)
                        if (state.items.isNotEmpty()) {
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "${state.items.size}",
                                color = JarvisPalette.Accent,
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        if (state.items.isEmpty()) {
            EmptyCanvas(Modifier.fillMaxSize().padding(padding))
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(state.items, key = { it.id }) { item ->
                    GlowCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(14.dp)) {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    "◆ CANVAS",
                                    color = JarvisPalette.Accent,
                                    fontSize = 8.sp,
                                    letterSpacing = 1.4.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                if (item.title.isNotBlank()) {
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        item.title,
                                        color = JarvisPalette.TextPrimary,
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                }
                                Spacer(Modifier.weight(1f))
                                PinChip {
                                    val ok = WidgetPinHelper.pinToHome(
                                        context, item.id, item.specJson, item.title.ifBlank { "Cindro" })
                                    Toast.makeText(
                                        context,
                                        if (ok) "Confirm to add the widget to your home screen"
                                        else "Add it from your home-screen widget list",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                            WidgetRenderer(item.specJson)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinChip(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .padding(0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Surface(
            shape = CircleShape,
            color = JarvisPalette.Accent.copy(alpha = 0.14f),
            border = androidx.compose.foundation.BorderStroke(1.dp, JarvisPalette.Accent.copy(alpha = 0.5f)),
            onClick = onClick,
        ) {
            Row(
                Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.PushPin, contentDescription = "Pin to home",
                    tint = JarvisPalette.Accent, modifier = Modifier.size(13.dp))
                Spacer(Modifier.width(5.dp))
                Text("Pin to home", color = JarvisPalette.Accent,
                    style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun EmptyCanvas(modifier: Modifier) {
    Column(
        modifier = modifier.padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(72.dp).clip(RoundedCornerShape(20.dp))
                .padding(0.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.AutoAwesome, contentDescription = null,
                tint = JarvisPalette.AccentDim, modifier = Modifier.size(48.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text("No canvases yet", style = MaterialTheme.typography.titleMedium,
            color = JarvisPalette.TextPrimary)
        Spacer(Modifier.height(6.dp))
        Text(
            "Ask Cindro to draw or show you something — a chart, a status card, a live dashboard. It appears here and can be pinned to your home screen.",
            style = MaterialTheme.typography.bodyMedium,
            color = JarvisPalette.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}
