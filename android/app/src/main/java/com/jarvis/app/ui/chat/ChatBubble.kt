package com.jarvis.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.HapticButton
import com.jarvis.app.ui.util.HapticOutlinedButton
import kotlinx.coroutines.delay

@Composable
fun ChatBubble(
    item: ChatItem,
    onApprove: (ChatItem.Approval, String) -> Unit,
    selecting: Boolean = false,
    selected: Boolean = false,
    onClick: () -> Unit = {},
    onLongClick: () -> Unit = {},
    onStreamReveal: () -> Unit = {},
) {
    // Long-press anywhere on a bubble enters / toggles selection; in selecting
    // mode a plain tap toggles too. The selected bubble dims slightly.
    val selectable = Modifier
        .fillMaxWidth()
        .combinedClickable(onClick = onClick, onLongClick = onLongClick)
        .alpha(if (selecting && !selected) 0.55f else 1f)
    Box(selectable) {
        when (item) {
            is ChatItem.Message -> MessageBubble(item, selected, onStreamReveal)
            is ChatItem.Thinking -> ThinkingBubble(item)
            is ChatItem.ToolCall -> ToolCallBubble(item)
            is ChatItem.Diff -> DiffBubble(item)
            is ChatItem.Approval -> ApprovalCard(item, onApprove)
            is ChatItem.Error -> ErrorBubble(item)
            is ChatItem.FileOffer -> FileOfferBubble(item)
        }
    }
}

@Composable
private fun FileOfferBubble(item: ChatItem.FileOffer) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val isImage = item.mime?.startsWith("image/") == true && item.b64 != null
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = true) {
        Column {
            Text(
                text = item.name.ifBlank { "file" },
                style = MaterialTheme.typography.titleMedium,
                color = JarvisPalette.Accent,
            )
            item.size?.let { sz ->
                Text(
                    text = humanSize(sz) + (item.mime?.let { "  •  $it" } ?: ""),
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextSecondary,
                )
            }
            if (isImage && item.b64 != null) {
                // Render images inline (tap to open fullscreen + save).
                val bmp = remember(item.b64) {
                    runCatching {
                        val raw = Base64.decode(item.b64, Base64.DEFAULT)
                        val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(raw, 0, raw.size, b)
                        var s = 1
                        while (b.outWidth / s > 2048) s *= 2
                        BitmapFactory.decodeByteArray(
                            raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = s },
                        )?.asImageBitmap()
                    }.getOrNull()
                }
                if (bmp != null) {
                    var showViewer by remember { mutableStateOf(false) }
                    Spacer(Modifier.height(8.dp))
                    Image(
                        bitmap = bmp,
                        contentDescription = item.name,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 360.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .clickable { showViewer = true },
                    )
                    if (showViewer) {
                        ImageViewerDialog(b64 = item.b64, onDismiss = { showViewer = false })
                    }
                }
            }
            if (item.b64 != null) {
                Spacer(Modifier.height(8.dp))
                HapticOutlinedButton(onClick = {
                    val ok = saveFileToDownloads(context, item.b64, item.name, item.mime)
                    android.widget.Toast.makeText(
                        context,
                        if (ok) "Saved to Downloads" else "Couldn't save",
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
                }) {
                    Icon(Icons.Filled.Download, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text("  Save to Downloads")
                }
            }
        }
    }
}

private fun humanSize(bytes: Long): String = when {
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "%.0f KB".format(bytes / 1_000.0)
    else -> "$bytes B"
}

@Composable
private fun MessageBubble(
    item: ChatItem.Message,
    selected: Boolean = false,
    onStreamReveal: () -> Unit = {},
) {
    val isUser = item.role == "user"
    val align = if (isUser) Alignment.End else Alignment.Start
    val bg = if (isUser) JarvisPalette.AccentDim else JarvisPalette.Surface

    // Typewriter reveal: while streaming, animate the number of visible characters
    // up to the accumulated text length (~ a few hundred chars/sec). When the
    // streaming flag clears (turn final) the full text snaps in.
    var revealed by remember(item.id) { mutableIntStateOf(if (item.streaming) 0 else item.text.length) }
    // Count of WORDS revealed so far — a haptic tick fires once per newly-revealed
    // word (not per character/batch) so the streaming "purr" tracks real typing.
    var wordsRevealed by remember(item.id) { mutableIntStateOf(if (item.streaming) 0 else wordCount(item.text)) }
    LaunchedEffect(item.text, item.streaming) {
        if (!item.streaming) {
            revealed = item.text.length
            return@LaunchedEffect
        }
        // Reveal forward toward the current text length. ~16ms/char ≈ 60 chars/sec
        // floor, but we step by a small batch so longer replies feel ChatGPT-fast
        // (~300+ chars/sec). The bubble GROWS as `revealed` climbs and the list
        // auto-scrolls to follow (ChatScreen keys its scroll off the live text),
        // so the reply flows DOWN like real typing.
        while (revealed < item.text.length) {
            val step = (item.text.length - revealed).coerceAtMost(REVEAL_BATCH)
            revealed += step
            // Fire a per-WORD haptic tick: when this step crossed one or more word
            // boundaries, tick once (the Haptics layer self-throttles bursts).
            val nowWords = wordCount(item.text.take(revealed))
            if (nowWords > wordsRevealed) {
                wordsRevealed = nowWords
                onStreamReveal()
            }
            delay(REVEAL_FRAME_MS)
        }
    }
    val shown = if (revealed >= item.text.length) item.text else item.text.take(revealed)

    Column(Modifier.fillMaxWidth(), horizontalAlignment = align) {
        Surface(
            color = bg,
            shape = RoundedCornerShape(
                topStart = 14.dp, topEnd = 14.dp,
                bottomStart = if (isUser) 14.dp else 2.dp,
                bottomEnd = if (isUser) 2.dp else 14.dp,
            ),
            modifier = Modifier
                .widthIn(max = 320.dp)
                .alpha(if (selected) 0.8f else 1f),
        ) {
            // Soft fade on the revealing text while streaming.
            val streamingNow = item.streaming && revealed < item.text.length
            Text(
                text = shown,
                color = JarvisPalette.TextPrimary,
                modifier = Modifier
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                    .alpha(if (streamingNow) 0.92f else 1f),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

// Whimsical "working" phrases (Claude-Code flavored) rotated while the brain runs.
private val WORK_PHRASES = listOf(
    "Conquering the world", "Just chillin", "Pondering the universe", "Cooking",
    "Summoning electrons", "Reticulating splines", "Bending spacetime",
    "Consulting the oracle", "Vibing", "Untangling the matrix", "Herding photons",
    "Caffeinating neurons", "Manifesting", "Hacking the mainframe",
    "Plotting world domination", "Overthinking it", "Galaxy-braining", "Locking in",
)

@Composable
fun TypingIndicator(modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Surface(
            color = JarvisPalette.Surface,
            shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomStart = 2.dp, bottomEnd = 14.dp),
        ) {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val transition = rememberInfiniteTransition(label = "typing")
                // spinning ring
                val angle by transition.animateFloat(
                    initialValue = 0f, targetValue = 360f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 850, easing = LinearEasing),
                        repeatMode = RepeatMode.Restart,
                    ),
                    label = "spin",
                )
                CircularProgressIndicator(
                    progress = { 0.75f },
                    modifier = Modifier.size(13.dp).graphicsLayer { rotationZ = angle },
                    color = JarvisPalette.Accent,
                    trackColor = JarvisPalette.Accent.copy(alpha = 0.18f),
                    strokeWidth = 2.dp,
                )
                // rotating funny phrase
                var phrase by remember { mutableStateOf(WORK_PHRASES.random()) }
                LaunchedEffect(Unit) {
                    while (true) {
                        kotlinx.coroutines.delay(2400)
                        phrase = WORK_PHRASES.random()
                    }
                }
                Text(
                    text = "$phrase…",
                    color = JarvisPalette.Accent,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        }
    }
}

@Composable
private fun ThinkingBubble(item: ChatItem.Thinking) {
    Text(
        text = item.text,
        color = JarvisPalette.TextSecondary,
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
    )
}

@Composable
private fun ToolCallBubble(item: ChatItem.ToolCall) {
    // Collapsed by default: a compact row with a small spinner (running) / check
    // (done) / error (failed). Tap to expand the params + output. Keeps the
    // transcript clean while every tool call stays inspectable.
    val running = item.output == null && item.ok == null && item.images.isEmpty()
    var expanded by remember { mutableStateOf(false) }
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
            ) {
                // status: a small spinning reactor while running, else check / error
                when {
                    running -> CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = JarvisPalette.Accent,
                    )
                    item.ok == false -> Icon(
                        Icons.Filled.Error, contentDescription = null,
                        tint = JarvisPalette.Error, modifier = Modifier.size(18.dp),
                    )
                    else -> Icon(
                        Icons.Filled.CheckCircle, contentDescription = null,
                        tint = JarvisPalette.Success, modifier = Modifier.size(18.dp),
                    )
                }
                Text(
                    text = "  ${item.name}",
                    style = MaterialTheme.typography.titleMedium,
                    color = JarvisPalette.TextPrimary,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = if (running) "running…" else if (item.ok == false) "failed" else "done",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (item.ok == false) JarvisPalette.Error else JarvisPalette.TextSecondary,
                )
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (expanded) "collapse" else "expand",
                    tint = JarvisPalette.TextSecondary,
                    modifier = Modifier.size(20.dp).rotate(if (expanded) 180f else 0f),
                )
            }
            AnimatedVisibility(visible = expanded) {
                Column {
                    item.argsJson?.takeIf { it.isNotBlank() && it != "{}" }?.let { args ->
                        Spacer(Modifier.height(8.dp))
                        Text("parameters", style = MaterialTheme.typography.labelSmall,
                            color = JarvisPalette.Accent)
                        Spacer(Modifier.height(2.dp))
                        MonoBlock(args)
                    }
                    if (item.output?.isNotBlank() == true || item.images.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text("output", style = MaterialTheme.typography.labelSmall,
                            color = JarvisPalette.Accent)
                    }
                    ToolCallBody(item)
                }
            }
        }
    }
}

@Composable
private fun ToolCallBody(item: ChatItem.ToolCall) {
    Column {
            if (item.images.isNotEmpty()) {
                // Render screenshots / image results as actual pictures. Decode with
                // BitmapFactory (downsampled so a 3-monitor screenshot can't OOM) and
                // draw via Compose Image — Coil 2.x has no ByteArray fetcher, so this
                // is the reliable path for inline base64.
                item.images.forEach { b64 ->
                    val bmp = remember(b64) {
                        runCatching {
                            val raw = Base64.decode(b64, Base64.DEFAULT)
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
                            var sample = 1
                            while (bounds.outWidth / sample > 2048) sample *= 2
                            BitmapFactory.decodeByteArray(
                                raw, 0, raw.size,
                                BitmapFactory.Options().apply { inSampleSize = sample },
                            )?.asImageBitmap()
                        }.getOrNull()
                    }
                    if (bmp != null) {
                        var showViewer by remember { mutableStateOf(false) }
                        Spacer(Modifier.height(6.dp))
                        Image(
                            bitmap = bmp,
                            contentDescription = "image result — tap to open",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 360.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .clickable { showViewer = true },
                        )
                        if (showViewer) {
                            ImageViewerDialog(b64 = b64, onDismiss = { showViewer = false })
                        }
                    }
                }
            } else {
                item.output?.takeIf { it.isNotBlank() }?.let { out ->
                    Spacer(Modifier.height(6.dp))
                    MonoBlock(out.take(2000))
                }
            }
        }
}

@Composable
private fun DiffBubble(item: ChatItem.Diff) {
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = true) {
        Column {
            Text(
                text = item.path,
                style = MaterialTheme.typography.titleMedium,
                color = JarvisPalette.Accent,
            )
            Spacer(Modifier.height(6.dp))
            DiffBlock(item.patch)
        }
    }
}

@Composable
private fun ApprovalCard(item: ChatItem.Approval, onApprove: (ChatItem.Approval, String) -> Unit) {
    val riskColor = when (item.risk.lowercase()) {
        "high" -> JarvisPalette.Error
        "medium" -> JarvisPalette.Accent
        else -> JarvisPalette.Success
    }
    GlowCard(modifier = Modifier.fillMaxWidth(), accent = true) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = riskColor, modifier = Modifier.height(18.dp))
                Text(
                    text = "  Approval needed · ${item.risk.uppercase()}",
                    style = MaterialTheme.typography.titleMedium,
                    color = riskColor,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(item.summary, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(12.dp))
            if (item.resolved != null) {
                Text(
                    "Responded: ${item.resolved.uppercase()}",
                    color = JarvisPalette.TextSecondary,
                    style = MaterialTheme.typography.labelLarge,
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HapticOutlinedButton(onClick = { onApprove(item, "deny") }) { Text("Deny") }
                    HapticButton(
                        onClick = { onApprove(item, "allow") },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JarvisPalette.Accent, contentColor = JarvisPalette.OnAccent,
                        ),
                    ) { Text("Allow") }
                    HapticOutlinedButton(onClick = { onApprove(item, "always") }) { Text("Always") }
                }
            }
        }
    }
}

@Composable
private fun ErrorBubble(item: ChatItem.Error) {
    Surface(
        color = JarvisPalette.Error.copy(alpha = 0.12f),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Error, contentDescription = null, tint = JarvisPalette.Error, modifier = Modifier.height(18.dp))
            Text("  ${item.message}", color = JarvisPalette.Error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun MonoBlock(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(JarvisPalette.Background)
            .horizontalScroll(rememberScrollState())
            .padding(10.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = JarvisPalette.TextSecondary,
        )
    }
}

@Composable
private fun DiffBlock(patch: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(JarvisPalette.Background)
            .horizontalScroll(rememberScrollState())
            .padding(10.dp),
    ) {
        Column {
            patch.lineSequence().take(400).forEach { line ->
                val color = when {
                    line.startsWith("+") && !line.startsWith("+++") -> JarvisPalette.Success
                    line.startsWith("-") && !line.startsWith("---") -> JarvisPalette.Error
                    line.startsWith("@@") -> JarvisPalette.Accent
                    else -> JarvisPalette.TextSecondary
                }
                Text(
                    text = line.ifEmpty { " " },
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = color,
                )
            }
        }
    }
}

// Typewriter reveal pacing: reveal up to REVEAL_BATCH chars every REVEAL_FRAME_MS,
// i.e. ~ (REVEAL_BATCH * 1000 / REVEAL_FRAME_MS) chars/sec (≈ 350/sec by default).
private const val REVEAL_BATCH = 7
private const val REVEAL_FRAME_MS = 20L

/** Number of whitespace-delimited words in [s] (used for per-word streaming
 *  haptics). Cheap; called only on the revealed prefix while streaming. */
private fun wordCount(s: String): Int {
    if (s.isBlank()) return 0
    return s.trim().split(Regex("\\s+")).size
}
