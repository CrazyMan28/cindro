package com.jarvis.app.ui.phone

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DialerSip
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jarvis.app.ui.theme.JarvisPalette
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

// ─────────────────────────────────────────────────────────────────────────────
// Shared private helpers
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PhoneCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Brush.verticalGradient(listOf(JarvisPalette.SurfaceVariant, JarvisPalette.Surface)))
            .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(18.dp))
            .padding(18.dp),
        content = content,
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
        color = JarvisPalette.TextFaint,
        modifier = Modifier.padding(start = 2.dp, bottom = 6.dp, top = 10.dp),
    )
}

@Composable
private fun StatusDotBadge(status: String) {
    val color = when (status.lowercase()) {
        "online", "working", "active", "connected", "answered" -> JarvisPalette.Success
        "offline", "idle" -> JarvisPalette.TextFaint
        "ringing" -> JarvisPalette.Warning
        "busy" -> JarvisPalette.Violet
        else -> JarvisPalette.TextSecondary
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(5.dp))
        Text(
            status.replaceFirstChar(Char::uppercase),
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
    }
}

@Composable
private fun CyanButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            containerColor = JarvisPalette.Accent,
            contentColor = JarvisPalette.OnAccent,
            disabledContainerColor = JarvisPalette.AccentDim,
            disabledContentColor = JarvisPalette.TextFaint,
        ),
        shape = RoundedCornerShape(12.dp),
    ) {
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun OutlineButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            contentColor = JarvisPalette.Accent,
        ),
        border = androidx.compose.foundation.BorderStroke(1.dp, JarvisPalette.Outline),
        shape = RoundedCornerShape(12.dp),
    ) {
        Text(label)
    }
}

@Composable
private fun SelectionChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) JarvisPalette.Accent.copy(alpha = 0.20f) else JarvisPalette.SurfaceVariant)
            .border(
                1.dp,
                if (selected) JarvisPalette.Accent.copy(alpha = 0.60f) else JarvisPalette.Outline,
                RoundedCornerShape(10.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) JarvisPalette.Accent else JarvisPalette.TextSecondary,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

@Composable
private fun CheckRow(label: String, value: Boolean?, detail: String = "") {
    val (color, statusText) = when (value) {
        true -> JarvisPalette.Success to "OK"
        false -> JarvisPalette.Error to "FAIL"
        null -> JarvisPalette.TextFaint to "—"
    }
    val icon = when (value) {
        true -> Icons.Filled.Done
        false -> Icons.Filled.Error
        else -> Icons.Filled.Warning
    }
    PhoneCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(36.dp).clip(CircleShape).background(color.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
            }
            Text(statusText, style = MaterialTheme.typography.labelMedium, color = color)
        }
    }
}

private fun copyToClipboard(ctx: Context, label: String, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB SCREENS
// ─────────────────────────────────────────────────────────────────────────────

// ── Calls ────────────────────────────────────────────────────────────────────

@Composable
fun PhoneCallsScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    var dialTarget by remember { mutableStateOf("101") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Active calls
        SectionLabel("Active Calls")
        if (state.loading && state.activeCalls.isEmpty()) {
            CircularProgressIndicator(color = JarvisPalette.Accent, modifier = Modifier.align(Alignment.CenterHorizontally))
        } else if (state.activeCalls.isEmpty()) {
            PhoneCard {
                Text(
                    "No active calls",
                    style = MaterialTheme.typography.bodyMedium,
                    color = JarvisPalette.TextFaint,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                )
            }
        } else {
            state.activeCalls.forEach { call ->
                PhoneCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(42.dp).clip(RoundedCornerShape(12.dp))
                                .background(JarvisPalette.Accent.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Filled.Call, contentDescription = null, tint = JarvisPalette.Accent, modifier = Modifier.size(22.dp))
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            val from = call.fromExtension ?: "?"
                            val to = call.toExtension ?: "?"
                            Text("$from → $to", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.SemiBold)
                            StatusDotBadge(call.state)
                            if (!call.reason.isNullOrBlank()) {
                                Text(call.reason, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                            }
                        }
                        IconButton(onClick = { viewModel.endCall(call.id) }) {
                            Icon(Icons.Filled.CallEnd, contentDescription = "End call", tint = JarvisPalette.Error)
                        }
                    }
                }
            }
        }

        // Dialer — big display + quick chips + keypad + call button (parity)
        SectionLabel("New Call")
        Spacer(Modifier.height(4.dp))
        Text(
            text = dialTarget.ifBlank { "•" },
            style = MaterialTheme.typography.displayLarge.copy(
                fontFamily = FontFamily.Monospace, fontSize = 44.sp, fontWeight = FontWeight.Light),
            color = JarvisPalette.TextPrimary,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Text(
            text = if (dialTarget.isBlank()) "Enter an extension or number" else "Ready to dial",
            style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Spacer(Modifier.height(10.dp))
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("101", "102", "103", "104", "105", "900").forEach { ext ->
                Box(
                    Modifier.clip(RoundedCornerShape(50)).background(JarvisPalette.Surface)
                        .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(50))
                        .clickable { dialTarget = ext }
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                ) {
                    Text(ext, style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace), color = JarvisPalette.TextPrimary)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("*", "0", "#")).forEach { keyRow ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                keyRow.forEach { digit ->
                    Box(
                        Modifier.weight(1f).height(60.dp)
                            .clip(RoundedCornerShape(20.dp)).background(JarvisPalette.Surface)
                            .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(20.dp))
                            .clickable { if (dialTarget.length < 18) dialTarget += digit },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(digit, style = MaterialTheme.typography.headlineMedium.copy(fontSize = 24.sp), color = JarvisPalette.TextPrimary)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f))
            Box(
                Modifier.size(70.dp).clip(CircleShape)
                    .background(if (dialTarget.isNotBlank()) JarvisPalette.Accent else JarvisPalette.AccentDim.copy(alpha = 0.4f))
                    .clickable(enabled = dialTarget.isNotBlank()) {
                        viewModel.placeCall(dialTarget.trim())
                        dialTarget = "101"
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Call, contentDescription = "Call", tint = JarvisPalette.OnAccent, modifier = Modifier.size(30.dp))
            }
            Box(
                Modifier.weight(1f).height(70.dp).clickable { dialTarget = dialTarget.dropLast(1) },
                contentAlignment = Alignment.Center,
            ) {
                Text("⌫", fontSize = 24.sp, color = JarvisPalette.TextSecondary)
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun outlinedFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = JarvisPalette.Accent,
    unfocusedBorderColor = JarvisPalette.Outline,
    cursorColor = JarvisPalette.Accent,
    focusedLabelColor = JarvisPalette.Accent,
    unfocusedLabelColor = JarvisPalette.TextFaint,
)

// ── Inbox ─────────────────────────────────────────────────────────────────────

@Composable
fun PhoneInboxScreen(
    state: PhoneUiState,
    viewModel: PhoneViewModel,
    onOpenThread: (String) -> Unit,
) {
    var showNewChat by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<PhoneThread?>(null) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        // Header: title + refresh + NEW CHAT (text an agent)
        Row(
            Modifier.fillMaxWidth().padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Chats", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = { viewModel.refreshThreads() }) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = JarvisPalette.TextSecondary)
            }
            IconButton(onClick = { viewModel.refreshAgents(); showNewChat = true }) {
                Icon(Icons.Filled.Add, contentDescription = "New chat", tint = JarvisPalette.Accent)
            }
        }
        pendingDelete?.let { thread ->
            AlertDialog(
                onDismissRequest = { pendingDelete = null },
                containerColor = JarvisPalette.Surface,
                title = { Text("Delete thread?", color = JarvisPalette.TextPrimary) },
                text = { Text(thread.subject, color = JarvisPalette.TextSecondary) },
                confirmButton = {
                    CyanButton("Delete", onClick = {
                        viewModel.deleteThread(thread.id)
                        pendingDelete = null
                    })
                },
                dismissButton = { OutlineButton("Cancel", onClick = { pendingDelete = null }) },
            )
        }
        if (showNewChat) {
            NewChatDialog(
                agents = state.phoneAgents,
                onDismiss = { showNewChat = false },
                onStartChat = { ext, msg -> viewModel.startChat(ext, msg) { onOpenThread(it) } },
                onStartGroup = { members, msg -> viewModel.startGroupChat(members, msg) { onOpenThread(it) } },
                onCall = { members -> viewModel.startConferenceCall(members) },
            )
        }
        if (state.threads.isEmpty() && state.inboxMessages.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Inbox, contentDescription = null, tint = JarvisPalette.TextFaint, modifier = Modifier.size(48.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No messages", style = MaterialTheme.typography.bodyLarge, color = JarvisPalette.TextFaint)
                }
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 8.dp),
            ) {
                if (state.threads.isNotEmpty()) {
                    item { SectionLabel("Threads") }
                    items(state.threads, key = { it.id }) { thread ->
                        val priorityColor = when (thread.highestPriority) {
                            "critical" -> JarvisPalette.Error
                            "urgent" -> JarvisPalette.Warning
                            else -> JarvisPalette.TextFaint
                        }
                        PhoneCard(
                            modifier = Modifier.combinedClickable(
                                onClick = { onOpenThread(thread.id) },
                                onLongClick = { pendingDelete = thread },
                            ),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.size(42.dp).clip(RoundedCornerShape(12.dp))
                                        .background(JarvisPalette.Accent.copy(alpha = 0.13f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        (thread.relatedExtension?.firstOrNull() ?: thread.subject.firstOrNull() ?: 'M').uppercaseChar().toString(),
                                        color = JarvisPalette.Accent,
                                        fontWeight = FontWeight.Bold,
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                }
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(thread.subject, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1)
                                    Text(thread.latestPreview, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary, maxLines = 2)
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    if (thread.unreadCount > 0) {
                                        Box(
                                            Modifier.size(20.dp).clip(CircleShape).background(JarvisPalette.Accent),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(thread.unreadCount.toString(), style = MaterialTheme.typography.labelSmall, color = JarvisPalette.OnAccent)
                                        }
                                    }
                                    Text(thread.latestMessageAt.takeLast(8).take(5), style = MaterialTheme.typography.labelSmall, color = priorityColor)
                                }
                            }
                        }
                    }
                }
                if (state.inboxMessages.isNotEmpty()) {
                    item { SectionLabel("Messages") }
                    items(state.inboxMessages, key = { it.id }) { msg ->
                        PhoneCard(
                            modifier = Modifier.clickable { msg.threadId?.let { onOpenThread(it) } },
                        ) {
                            val priColor = when (msg.priority) {
                                "critical" -> JarvisPalette.Error
                                "urgent" -> JarvisPalette.Warning
                                else -> JarvisPalette.TextFaint
                            }
                            Row(verticalAlignment = Alignment.Top) {
                                Column(Modifier.weight(1f)) {
                                    if (msg.title.isNotBlank()) Text(msg.title, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.SemiBold)
                                    Text(msg.message, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary, maxLines = 3)
                                    if (msg.fromExtension != null) Text("From: ${msg.fromExtension}", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                                }
                                Spacer(Modifier.width(8.dp))
                                Text(msg.priority.uppercase(), style = MaterialTheme.typography.labelSmall, color = priColor)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

// ── Agents ───────────────────────────────────────────────────────────────────

@Composable
fun PhoneAgentsScreen(
    state: PhoneUiState,
    viewModel: PhoneViewModel,
    onConfig: (String, String) -> Unit,
) {
    LaunchedEffect(Unit) { viewModel.refreshAgents() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        if (state.agentsLoading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = JarvisPalette.Accent)
            }
        } else if (state.phoneAgents.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Groups, contentDescription = null, tint = JarvisPalette.TextFaint, modifier = Modifier.size(48.dp))
                    Spacer(Modifier.height(12.dp))
                    Text("No agents registered", style = MaterialTheme.typography.bodyLarge, color = JarvisPalette.TextFaint)
                }
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 8.dp),
            ) {
                items(state.phoneAgents, key = { it.extension }) { agent ->
                    PhoneCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(46.dp).clip(RoundedCornerShape(14.dp))
                                    .background(JarvisPalette.Violet.copy(alpha = 0.15f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    agent.name.take(1).uppercase(),
                                    color = JarvisPalette.Violet,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.titleMedium,
                                )
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(agent.name, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.SemiBold)
                                Text("Ext ${agent.extension}", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                                StatusDotBadge(agent.status)
                                if (agent.task.isNotBlank()) {
                                    Text(agent.task, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary, maxLines = 1)
                                }
                            }
                            IconButton(onClick = { onConfig(agent.extension, agent.name) }) {
                                Icon(Icons.Filled.Tune, contentDescription = "Configure", tint = JarvisPalette.Accent)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

// ── HUD ──────────────────────────────────────────────────────────────────────

@Composable
fun PhoneHudScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    var redAlertMsg by remember { mutableStateOf("") }
    var showRedAlert by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Summary tiles
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HudTile(modifier = Modifier.weight(1f), icon = Icons.Filled.Call, label = "Active Calls", value = state.activeCalls.size.toString(), tint = JarvisPalette.Accent)
            HudTile(modifier = Modifier.weight(1f), icon = Icons.Filled.Groups, label = "Agents", value = state.phoneAgents.size.toString(), tint = JarvisPalette.Violet)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            HudTile(modifier = Modifier.weight(1f), icon = Icons.Filled.Inbox, label = "Threads", value = state.threads.size.toString(), tint = JarvisPalette.Success)
            HudTile(modifier = Modifier.weight(1f), icon = Icons.Filled.Warning, label = "Unread", value = state.threads.sumOf { it.unreadCount }.toString(), tint = JarvisPalette.Warning)
        }

        // Active calls detail
        if (state.activeCalls.isNotEmpty()) {
            SectionLabel("Active Calls")
            state.activeCalls.forEach { call ->
                PhoneCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            val from = call.fromExtension ?: "?"
                            val to = call.toExtension ?: "?"
                            Text("$from → $to", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                            StatusDotBadge(call.state)
                        }
                        if (!call.urgency.isNullOrBlank()) {
                            Text(call.urgency.uppercase(), style = MaterialTheme.typography.labelSmall, color = JarvisPalette.Warning)
                        }
                    }
                }
            }
        }

        // Red Alert
        SectionLabel("Broadcast")
        PhoneCard {
            Text("Red Alert", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.Error, fontWeight = FontWeight.Bold)
            Text("Broadcasts an urgent message to all registered agents.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
            Spacer(Modifier.height(10.dp))
            if (showRedAlert) {
                OutlinedTextField(
                    value = redAlertMsg,
                    onValueChange = { redAlertMsg = it },
                    placeholder = { Text("Message to broadcast…", color = JarvisPalette.TextFaint) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = outlinedFieldColors(),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = JarvisPalette.TextPrimary),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton("Cancel", onClick = { showRedAlert = false; redAlertMsg = "" }, modifier = Modifier.weight(1f))
                    Button(
                        onClick = {
                            if (redAlertMsg.isNotBlank()) {
                                viewModel.triggerRedAlert(redAlertMsg)
                                showRedAlert = false
                                redAlertMsg = ""
                            }
                        },
                        enabled = redAlertMsg.isNotBlank(),
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = JarvisPalette.Error, contentColor = JarvisPalette.TextPrimary),
                        shape = RoundedCornerShape(12.dp),
                    ) { Text("SEND", fontWeight = FontWeight.Bold) }
                }
            } else {
                Button(
                    onClick = { showRedAlert = true },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Error.copy(alpha = 0.15f),
                        contentColor = JarvisPalette.Error,
                    ),
                    border = androidx.compose.foundation.BorderStroke(1.dp, JarvisPalette.Error.copy(alpha = 0.50f)),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(Icons.Filled.NotificationsActive, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Trigger Red Alert", fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun HudTile(modifier: Modifier, icon: ImageVector, label: String, value: String, tint: Color) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(JarvisPalette.Surface)
            .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(16.dp))
            .padding(16.dp),
        horizontalAlignment = Alignment.Start,
    ) {
        Box(
            Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.height(10.dp))
        Text(value, style = MaterialTheme.typography.headlineSmall, color = tint, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextFaint)
    }
}

// ── Settings ──────────────────────────────────────────────────────────────────

@Composable
fun PhoneSettingsScreen(
    state: PhoneUiState,
    viewModel: PhoneViewModel,
    onDiagnostics: () -> Unit,
    onHistory: () -> Unit,
    onEnroll: () -> Unit,
    onSetup: () -> Unit,
    onAgentConfig: (String, String) -> Unit,
) {
    LaunchedEffect(Unit) { viewModel.loadScreeningConfig() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Twilio status
        val ts = state.twilioStatus
        SectionLabel("Twilio Status")
        PhoneCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (ts?.configured == true) "Configured" else "Not configured", style = MaterialTheme.typography.titleSmall, color = if (ts?.configured == true) JarvisPalette.Success else JarvisPalette.TextFaint, fontWeight = FontWeight.SemiBold)
                    if (ts?.fromNumber != null) {
                        Text(ts.fromNumber, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                    }
                }
                if (ts != null) {
                    StatusDotBadge(if (ts.configured) "connected" else "offline")
                }
            }
            if (ts != null) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("Screening", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                        Text(if (ts.screeningEnabled) "On" else "Off", style = MaterialTheme.typography.labelMedium, color = if (ts.screeningEnabled) JarvisPalette.Success else JarvisPalette.TextSecondary)
                    }
                    Column(Modifier.weight(1f)) {
                        Text("SMS Agent", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                        Text(if (ts.smsAgentEnabled) "On" else "Off", style = MaterialTheme.typography.labelMedium, color = if (ts.smsAgentEnabled) JarvisPalette.Success else JarvisPalette.TextSecondary)
                    }
                }
            }
        }

        // Screening toggle + full config
        val sc = state.screeningConfig
        val settingsCtx = LocalContext.current
        if (sc != null) {
            SectionLabel("Call Screening")
            PhoneCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Enable screening", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                        Text("Route inbound calls through an agent first.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                    }
                    Switch(
                        checked = sc.enabled,
                        onCheckedChange = { viewModel.toggleScreening(it) },
                        colors = SwitchDefaults.colors(checkedThumbColor = JarvisPalette.OnAccent, checkedTrackColor = JarvisPalette.Accent),
                    )
                }
                if (sc.enabled) {
                    Spacer(Modifier.height(12.dp))
                    Text("Transport", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SelectionChip("Twilio (anywhere)", selected = sc.transport == "twilio" || sc.transport.isBlank(), onClick = { viewModel.setScreeningTransport("twilio") {} })
                        SelectionChip("Bluetooth relay", selected = sc.transport == "bluetooth", onClick = { viewModel.setScreeningTransport("bluetooth") {} })
                    }
                    if (sc.agents.isNotEmpty()) {
                        Spacer(Modifier.height(12.dp))
                        Text("Who answers inbound calls", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                        Spacer(Modifier.height(6.dp))
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            sc.agents.forEach { (ext, name) ->
                                SelectionChip("$name ($ext)", selected = sc.inboundExtension == ext, onClick = { viewModel.setInboundAgent(ext) {} })
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        Text("Who screens unknown callers", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                        Spacer(Modifier.height(6.dp))
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            sc.agents.forEach { (ext, name) ->
                                SelectionChip("$name ($ext)", selected = sc.screeningExtension == ext, onClick = { viewModel.setScreeningAgent(ext) {} })
                            }
                        }
                    }
                }
            }
            SectionLabel("Carrier Forwarding")
            PhoneCard {
                Text("Copy the code for your carrier to forward calls to Jarvis.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                Spacer(Modifier.height(8.dp))
                ForwardCodeRow("Set all-forward (GSM)", "**004*+NUMBER#", settingsCtx)
                ForwardCodeRow("Cancel all forwards", "##002#", settingsCtx)
                Spacer(Modifier.height(6.dp))
                Text("Verizon", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                ForwardCodeRow("Verizon: Start forward", "*72 + NUMBER", settingsCtx)
                ForwardCodeRow("Verizon: Cancel forward", "*73", settingsCtx)
            }
        }

        // Navigation items
        SectionLabel("Tools")
        val navItems = listOf(
            Triple(Icons.Filled.History, "Call History", onHistory),
            Triple(Icons.Filled.Settings, "Diagnostics", onDiagnostics),
            Triple(Icons.Filled.PersonAdd, "Enroll Agent", onEnroll),
            Triple(Icons.Filled.DialerSip, "Phone Setup", onSetup),
        )
        navItems.forEach { (icon, label, action) ->
            PhoneCard(modifier = Modifier.clickable(onClick = action)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(JarvisPalette.Accent.copy(alpha = 0.12f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(icon, contentDescription = null, tint = JarvisPalette.Accent, modifier = Modifier.size(20.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Text(label, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary, modifier = Modifier.weight(1f))
                    Icon(Icons.Filled.Settings, contentDescription = null, tint = JarvisPalette.TextFaint, modifier = Modifier.size(16.dp))
                }
            }
        }

        // Agent voice/model config shortcuts
        if (state.phoneAgents.isNotEmpty()) {
            SectionLabel("Agent Config")
            state.phoneAgents.forEach { agent ->
                PhoneCard(modifier = Modifier.clickable { onAgentConfig(agent.extension, agent.name) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(JarvisPalette.Violet.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(agent.name.take(1).uppercase(), color = JarvisPalette.Violet, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(agent.name, style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                            Text("Ext ${agent.extension}", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                        }
                        Icon(Icons.Filled.Tune, contentDescription = "Configure", tint = JarvisPalette.Accent, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCREENS
// ─────────────────────────────────────────────────────────────────────────────

// ── Thread ───────────────────────────────────────────────────────────────────

@Composable
fun PhoneThreadScreen(state: PhoneUiState, viewModel: PhoneViewModel, threadId: String) {
    val listState = rememberLazyListState()
    var replyText by remember { mutableStateOf("") }

    val messages = state.currentThreadMessages
    val peer = remember(messages) {
        messages.firstOrNull { it.fromExtension != "101" }?.fromExtension
            ?: messages.firstOrNull()?.toExtension ?: "agent"
    }
    val pending = remember(messages) {
        messages.lastOrNull { it.requiresResponse && it.selectedOption == null && it.responseText == null }
    }

    // A-11: auto-mark the pending unread message as read when thread is opened
    LaunchedEffect(pending?.id) {
        pending?.id?.let { msgId -> viewModel.markMessageRead(msgId) }
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(
        modifier = Modifier.fillMaxSize().imePadding(),
    ) {
        if (state.threadLoading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = JarvisPalette.Accent)
            }
        } else if (messages.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("No messages in this thread yet.", style = MaterialTheme.typography.bodyMedium, color = JarvisPalette.TextFaint)
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(messages, key = { it.id }) { msg ->
                    val outbound = msg.fromExtension == "101"
                    val shape = if (outbound) RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp)
                                else RoundedCornerShape(22.dp, 22.dp, 22.dp, 6.dp)
                    val bg = if (outbound) JarvisPalette.Accent else JarvisPalette.Surface
                    val fg = if (outbound) JarvisPalette.OnAccent else JarvisPalette.TextPrimary

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = if (outbound) Arrangement.End else Arrangement.Start,
                    ) {
                        Column(
                            modifier = Modifier
                                .widthIn(max = 300.dp)
                                .clip(shape)
                                .background(bg)
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                        ) {
                            if (!outbound && msg.title.isNotBlank()) {
                                Text(msg.title, style = MaterialTheme.typography.titleSmall, color = fg, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.height(3.dp))
                            }
                            if (msg.body.isNotBlank()) {
                                Text(msg.body, style = MaterialTheme.typography.bodyMedium, color = fg)
                            }
                            if (!msg.responseText.isNullOrBlank() || !msg.selectedOption.isNullOrBlank()) {
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    "↪ ${msg.responseText ?: msg.selectedOption}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (outbound) JarvisPalette.OnAccent.copy(alpha = 0.80f) else JarvisPalette.Accent,
                                )
                            }
                            Spacer(Modifier.height(3.dp))
                            Text(
                                "${msg.createdAt.takeLast(8).take(5)} · ${msg.status}",
                                style = MaterialTheme.typography.labelSmall,
                                color = if (outbound) JarvisPalette.OnAccent.copy(alpha = 0.65f) else JarvisPalette.TextFaint,
                            )
                        }
                    }
                }
            }
        }

        // Response options
        if (pending != null && pending.responseOptions.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                pending.responseOptions.take(3).forEach { option ->
                    OutlineButton(
                        option,
                        onClick = { viewModel.replyMessage(pending.id, threadId, null, option) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        // Reply bar
        ThreadReplyBar(
            text = replyText,
            onTextChange = { replyText = it },
            onSend = {
                if (replyText.isNotBlank()) {
                    viewModel.sendInThread(threadId, peer, replyText)
                    replyText = ""
                }
            },
        )
    }
}

@Composable
private fun ThreadReplyBar(text: String, onTextChange: (String) -> Unit, onSend: () -> Unit) {
    val shape = RoundedCornerShape(26.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(JarvisPalette.Surface)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .clip(shape)
                .background(JarvisPalette.SurfaceVariant)
                .border(1.dp, JarvisPalette.Outline, shape)
                .padding(horizontal = 18.dp, vertical = 13.dp),
        ) {
            if (text.isEmpty()) Text("Message…", style = MaterialTheme.typography.bodyLarge, color = JarvisPalette.TextFaint)
            BasicTextField(
                value = text,
                onValueChange = onTextChange,
                textStyle = LocalTextStyle.current.copy(color = JarvisPalette.TextPrimary),
                cursorBrush = SolidColor(JarvisPalette.Accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.width(10.dp))
        val canSend = text.isNotBlank()
        Box(
            modifier = Modifier
                .size(50.dp)
                .clip(CircleShape)
                .background(if (canSend) JarvisPalette.Accent else JarvisPalette.SurfaceVariant)
                .clickable { if (canSend) onSend() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Send, contentDescription = "Send", tint = if (canSend) JarvisPalette.OnAccent else JarvisPalette.TextFaint)
        }
    }
}

// ── Agent Config ──────────────────────────────────────────────────────────────

private val THINKING_LEVELS = listOf("minimal", "low", "medium", "high", "xhigh")
private val CLAUDE_MODELS = listOf(
    "Sonnet 4.6" to "claude-sonnet-4-6",
    "Opus 4.8" to "claude-opus-4-8",
    "Haiku 4.5" to "claude-haiku-4-5",
)

@Composable
fun PhoneAgentConfigScreen(
    state: PhoneUiState,
    viewModel: PhoneViewModel,
    extension: String,
    agentName: String,
) {
    val voiceConfig = state.agentVoiceConfigs[extension]
    val modelConfig = state.agentModelConfigs[extension]

    var localVoiceId by remember(extension, voiceConfig) { mutableStateOf(voiceConfig?.first) }
    var localSpeed by remember(extension, voiceConfig) { mutableDoubleStateOf(voiceConfig?.second ?: 1.0) }
    var localModel by remember(extension, modelConfig) { mutableStateOf(modelConfig?.first) }
    var localReasoning by remember(extension, modelConfig) { mutableStateOf(modelConfig?.second) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Header
        PhoneCard {
            Text(agentName, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.Bold)
            Text("Extension $extension", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextFaint)
        }

        // Voice section
        SectionLabel("Voice")
        PhoneCard {
            val selectedName = state.voiceOptions.firstOrNull { it.id == localVoiceId }?.name ?: "Default"
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Current: $selectedName", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.Accent)
                }
                if (state.voicePreviewStatus.isNotBlank()) {
                    Text(state.voicePreviewStatus, style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                }
            }
            Spacer(Modifier.height(10.dp))

            // Group by speaker name (e.g. "Paul - Cheerful" → speaker "Paul")
            val groups = state.voiceOptions.groupBy { opt ->
                if (opt.id == null) "Default"
                else opt.name.substringBefore(" - ").trim()
            }
            groups.forEach { (speaker, options) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(speaker, style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint, modifier = Modifier.width(68.dp))
                    Row(
                        modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        options.forEach { opt ->
                            val label = when {
                                opt.id == null -> "Default"
                                opt.name.contains(" - ") -> opt.name.substringAfter(" - ").trim()
                                else -> opt.name.substringBefore(" (").trim()
                            }
                            val isSel = opt.id == localVoiceId
                            SelectionChip(
                                label = label,
                                selected = isSel,
                                onClick = {
                                    val prev = localVoiceId
                                    localVoiceId = opt.id
                                    viewModel.setVoiceProfile(extension, opt.id, if (opt.id == null) null else opt.name) { ok ->
                                        if (!ok) localVoiceId = prev
                                    }
                                    viewModel.previewVoice(opt.id)
                                },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
            }

            Spacer(Modifier.height(6.dp))
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(JarvisPalette.SurfaceVariant)
                    .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(10.dp))
                    .clickable { viewModel.previewVoice(localVoiceId) }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = JarvisPalette.Accent, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Preview voice", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextPrimary)
                }
            }
        }

        // Speaking rate
        SectionLabel("Speaking Rate")
        PhoneCard {
            Text("${(localSpeed * 100).roundToInt() / 100.0}×", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.Accent)
            Slider(
                value = localSpeed.toFloat(),
                onValueChange = { localSpeed = (it * 20).roundToInt() / 20.0 },
                onValueChangeFinished = { viewModel.setVoiceSpeed(extension, localSpeed) },
                valueRange = 0.5f..2.0f,
                colors = SliderDefaults.colors(
                    thumbColor = JarvisPalette.Accent,
                    activeTrackColor = JarvisPalette.Accent,
                    inactiveTrackColor = JarvisPalette.Outline,
                ),
            )
            Text("0.5× slow · 1× normal · 2× fast", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
        }

        // Model + thinking (only for claude agents)
        val isClaudeAgent = agentName.contains("claude", ignoreCase = true) || agentName.contains("jarvis", ignoreCase = true)
        if (isClaudeAgent) {
            SectionLabel("Model")
            PhoneCard {
                Text("Model", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CLAUDE_MODELS.forEach { (displayName, id) ->
                        SelectionChip(
                            label = displayName,
                            selected = localModel == id,
                            onClick = {
                                localModel = id
                                viewModel.setModelConfig(extension, model = id, reasoning = null)
                            },
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text("Thinking", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    THINKING_LEVELS.forEach { level ->
                        SelectionChip(
                            label = level,
                            selected = localReasoning == level,
                            onClick = {
                                localReasoning = level
                                viewModel.setModelConfig(extension, model = null, reasoning = level)
                            },
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

@Composable
fun PhoneDiagnosticsScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    val diag = state.diagnostics
    val running = diag.lastWebSocketState == "running…"

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CyanButton(
                label = if (running) "Running…" else "Run Diagnostics",
                onClick = { viewModel.runDiagnostics() },
                enabled = !running,
                modifier = Modifier.weight(1f),
            )
        }

        CheckRow("Server health", diag.healthOk, "phone.mcp reachable")
        CheckRow("Auth token", diag.authOk, "credentials verified")
        CheckRow("Agents", diag.agentsOk, if (diag.agentCount != null) "${diag.agentCount} agents found" else "list_agents")

        // WebSocket state
        PhoneCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("WebSocket", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                    Text(diag.lastWebSocketState, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                }
                val wsColor = when {
                    diag.lastWebSocketState.contains("connected") -> JarvisPalette.Success
                    diag.lastWebSocketState == "running…" -> JarvisPalette.Warning
                    diag.lastWebSocketState == "idle" -> JarvisPalette.TextFaint
                    else -> JarvisPalette.Error
                }
                Text(diag.lastWebSocketState.uppercase(), style = MaterialTheme.typography.labelSmall, color = wsColor)
            }
        }

        if (diag.lastError != null) {
            PhoneCard {
                Text("Last Error", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.Error, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text(diag.lastError, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextPrimary, fontFamily = FontFamily.Monospace)
                if (diag.suggestedFix != null && diag.suggestedFix != diag.lastError) {
                    Spacer(Modifier.height(8.dp))
                    Text(diag.suggestedFix, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

// ── History ───────────────────────────────────────────────────────────────────

@Composable
fun PhoneHistoryScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        when {
            state.historyLoading -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = JarvisPalette.Accent)
                }
            }
            state.callHistory.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Filled.History, contentDescription = null, tint = JarvisPalette.TextFaint, modifier = Modifier.size(48.dp))
                        Spacer(Modifier.height(12.dp))
                        Text("No call history yet.", style = MaterialTheme.typography.bodyLarge, color = JarvisPalette.TextFaint)
                    }
                }
            }
            else -> {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 8.dp),
                ) {
                    items(state.callHistory, key = { "${it.from}-${it.to}-${it.createdAt}" }) { entry ->
                        val tint = when {
                            entry.missed -> JarvisPalette.Error
                            entry.state == "ended" -> JarvisPalette.Success
                            else -> JarvisPalette.TextFaint
                        }
                        PhoneCard {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(tint.copy(alpha = 0.12f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        if (entry.missed) Icons.Filled.CallEnd else Icons.Filled.Call,
                                        contentDescription = null,
                                        tint = tint,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "${entry.from} → ${entry.to}",
                                        style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Monospace),
                                        color = JarvisPalette.TextPrimary,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    val detail = listOfNotNull(
                                        entry.state.ifBlank { null },
                                        entry.reason.ifBlank { null },
                                    ).joinToString(" · ")
                                    if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                                }
                                Text(entry.createdAt.takeLast(8).take(5), style = MaterialTheme.typography.labelSmall, color = tint)
                            }
                        }
                    }
                    item { Spacer(Modifier.height(16.dp)) }
                }
            }
        }
    }
}

// ── Enroll ────────────────────────────────────────────────────────────────────

private enum class EnrollStep { Define, Result }

@Composable
fun PhoneEnrollScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    var step by remember { mutableStateOf(EnrollStep.Define) }
    var nameField by remember { mutableStateOf("") }
    var agentIdField by remember { mutableStateOf("") }
    var extensionField by remember { mutableStateOf("") }
    var commandField by remember { mutableStateOf("") }
    val ctx = LocalContext.current

    // When a result arrives, jump to the result step
    LaunchedEffect(state.enrollResult) {
        if (state.enrollResult != null) step = EnrollStep.Result
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when (step) {
            EnrollStep.Define -> {
                PhoneCard {
                    Text("Enroll a new agent", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.Bold)
                    Text("Mint a token + extension for a remote agent.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                }
                PhoneCard {
                    LabeledPhoneField("Name", nameField, { nameField = it }, "Hermes VM")
                    Spacer(Modifier.height(10.dp))
                    LabeledPhoneField("Agent ID (optional)", agentIdField, { agentIdField = it }, "hermes-vm", mono = true)
                    Spacer(Modifier.height(10.dp))
                    LabeledPhoneField("Extension (optional)", extensionField, { extensionField = it }, "auto-assigned", mono = true)
                    Spacer(Modifier.height(10.dp))
                    LabeledPhoneField("Command (optional)", commandField, { commandField = it }, "claude --print", mono = true)
                }
                if (state.enrollError != null) {
                    PhoneCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Error, contentDescription = null, tint = JarvisPalette.Error, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(state.enrollError, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextPrimary)
                        }
                    }
                }
                CyanButton(
                    label = if (state.enrollLoading) "Generating…" else "Generate Enrollment",
                    onClick = {
                        viewModel.enrollAgent(
                            name = nameField.trim(),
                            agentId = agentIdField.trim().takeIf { it.isNotBlank() },
                            extension = extensionField.trim().takeIf { it.isNotBlank() },
                            command = commandField.trim().takeIf { it.isNotBlank() },
                        )
                    },
                    enabled = !state.enrollLoading && nameField.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            EnrollStep.Result -> {
                val pkg = state.enrollResult
                if (pkg == null) {
                    Text("No result.", color = JarvisPalette.TextFaint)
                } else {
                    PhoneCard {
                        Text("Extension", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextFaint)
                        Text(
                            pkg.extension,
                            style = MaterialTheme.typography.displayMedium.copy(fontSize = 48.sp),
                            color = JarvisPalette.Accent,
                            fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text("${pkg.name} · agentId ${pkg.agentId}", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                    }
                    PhoneCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Warning, contentDescription = null, tint = JarvisPalette.Warning, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("This token is shown ONCE. Copy it now.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextPrimary)
                        }
                    }
                    EnrollCopyBlock(title = "Bootstrap command (run on agent VM)", text = pkg.bootstrapCmd) {
                        copyToClipboard(ctx, "bootstrap", it)
                    }
                    EnrollCopyBlock(title = "MCP config JSON", text = pkg.mcpConfigJson) {
                        copyToClipboard(ctx, "mcp-config", it)
                    }
                    OutlineButton(
                        label = "Enroll another",
                        onClick = { viewModel.clearEnrollResult(); step = EnrollStep.Define; nameField = "" },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun LabeledPhoneField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    mono: Boolean = false,
) {
    Text(label, style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextSecondary)
    Spacer(Modifier.height(4.dp))
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, color = JarvisPalette.TextFaint, style = if (mono) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyMedium) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        colors = outlinedFieldColors(),
        textStyle = MaterialTheme.typography.bodyLarge.copy(
            color = JarvisPalette.TextPrimary,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        ),
    )
}

@Composable
private fun EnrollCopyBlock(title: String, text: String, onCopy: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(JarvisPalette.SurfaceVariant)
                .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(12.dp))
                .padding(12.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = JarvisPalette.TextPrimary)
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) {
                IconButton(onClick = { onCopy(text) }) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = JarvisPalette.Accent, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

@Composable
fun PhoneSetupScreen(state: PhoneUiState, viewModel: PhoneViewModel) {
    var userNumber by remember(state.defaultUserNumber) { mutableStateOf(state.defaultUserNumber) }
    var numberSaved by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PhoneCard {
            Text("Phone Setup", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary, fontWeight = FontWeight.Bold)
            Text("Configure the Twilio phone integration for this Jarvis installation.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
        }

        // Twilio status summary
        val ts = state.twilioStatus
        SectionLabel("Twilio")
        PhoneCard {
            if (ts == null) {
                Text("Loading status…", color = JarvisPalette.TextFaint, style = MaterialTheme.typography.bodySmall)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(if (ts.configured) "Configured" else "Not configured", style = MaterialTheme.typography.titleSmall, color = if (ts.configured) JarvisPalette.Success else JarvisPalette.Error)
                        if (ts.fromNumber != null) Text("From: ${ts.fromNumber}", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                    }
                    StatusDotBadge(if (ts.configured) "online" else "offline")
                }
            }
        }

        // User number
        SectionLabel("Your Phone Number")
        PhoneCard {
            Text("Set the user's phone number for outbound Twilio calls.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = userNumber,
                onValueChange = { userNumber = it; numberSaved = false },
                placeholder = { Text("+1 555 555 5555", color = JarvisPalette.TextFaint) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                colors = outlinedFieldColors(),
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = JarvisPalette.TextPrimary, fontFamily = FontFamily.Monospace),
            )
            Spacer(Modifier.height(8.dp))
            CyanButton(
                label = if (numberSaved) "Saved!" else "Save Number",
                onClick = {
                    if (userNumber.isNotBlank()) {
                        viewModel.setUserNumber(userNumber)
                        numberSaved = true
                    }
                },
                enabled = userNumber.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // Screening
        SectionLabel("Call Screening")
        val sc = state.screeningConfig
        val setupCtx = LocalContext.current
        PhoneCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Enable call screening", style = MaterialTheme.typography.titleSmall, color = JarvisPalette.TextPrimary)
                    Text("Inbound calls are routed through an agent before ringing you.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
                }
                Switch(
                    checked = sc?.enabled == true,
                    onCheckedChange = { viewModel.toggleScreening(it) },
                    colors = SwitchDefaults.colors(checkedThumbColor = JarvisPalette.OnAccent, checkedTrackColor = JarvisPalette.Accent),
                )
            }
            if (sc != null && sc.enabled) {
                Spacer(Modifier.height(12.dp))
                Text("Transport", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SelectionChip("Twilio (anywhere)", selected = sc.transport == "twilio" || sc.transport.isBlank(), onClick = { viewModel.setScreeningTransport("twilio") {} })
                    SelectionChip("Bluetooth relay", selected = sc.transport == "bluetooth", onClick = { viewModel.setScreeningTransport("bluetooth") {} })
                }
                if (sc.agents.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Text("Who answers inbound calls", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        sc.agents.forEach { (ext, name) ->
                            SelectionChip("$name ($ext)", selected = sc.inboundExtension == ext, onClick = { viewModel.setInboundAgent(ext) {} })
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Text("Who screens unknown callers", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        sc.agents.forEach { (ext, name) ->
                            SelectionChip("$name ($ext)", selected = sc.screeningExtension == ext, onClick = { viewModel.setScreeningAgent(ext) {} })
                        }
                    }
                }
            }
        }
        SectionLabel("Carrier Forwarding")
        PhoneCard {
            Text("Copy the code for your carrier to forward calls to Jarvis.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
            Spacer(Modifier.height(8.dp))
            ForwardCodeRow("Set all-forward (GSM)", "**004*+NUMBER#", setupCtx)
            ForwardCodeRow("Cancel all forwards", "##002#", setupCtx)
            Spacer(Modifier.height(6.dp))
            Text("Verizon", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
            ForwardCodeRow("Verizon: Start forward", "*72 + NUMBER", setupCtx)
            ForwardCodeRow("Verizon: Cancel forward", "*73", setupCtx)
        }

        // TODO: Full Twilio number provisioning requires VM-side credentials
        // that are not yet surfaced through the phone.mcp API.
        PhoneCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Settings, contentDescription = null, tint = JarvisPalette.TextFaint, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Full Twilio provisioning (buy number, configure webhooks) is done via the Jarvis server admin panel.", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextFaint)
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

// ── Outgoing call overlay (A-7) ───────────────────────────────────────────────

@Composable
fun PhoneOutgoingCallScreen(
    call: PhoneCall,
    transcript: String,
    viewModel: PhoneViewModel,
) {
    var elapsedSeconds by remember { mutableIntStateOf(0) }
    var muted by remember { mutableStateOf(false) }

    LaunchedEffect(call.id) { viewModel.loadCallTranscript(call.id) }
    LaunchedEffect(Unit) { while (true) { delay(1000L); elapsedSeconds++ } }
    LaunchedEffect(Unit) { while (true) { delay(5000L); viewModel.loadCallTranscript(call.id) } }

    val timeStr = "%02d:%02d".format(elapsedSeconds / 60, elapsedSeconds % 60)
    val peer = call.toExtension ?: call.fromExtension ?: "?"

    Box(Modifier.fillMaxSize().background(JarvisPalette.Background)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(40.dp))

            // Avatar circle
            Box(
                Modifier.size(96.dp).clip(CircleShape)
                    .background(JarvisPalette.Accent.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    peer.take(3),
                    style = MaterialTheme.typography.headlineMedium,
                    color = JarvisPalette.Accent,
                    fontFamily = FontFamily.Monospace,
                )
            }

            Text(
                call.state.replaceFirstChar { it.uppercase() } + "…",
                style = MaterialTheme.typography.titleMedium,
                color = JarvisPalette.TextSecondary,
            )
            Text(
                peer,
                style = MaterialTheme.typography.displaySmall,
                color = JarvisPalette.TextPrimary,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                timeStr,
                style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                color = JarvisPalette.TextFaint,
            )

            // Transcript panel
            if (transcript.isNotBlank()) {
                Column(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .background(JarvisPalette.Surface)
                        .border(1.dp, JarvisPalette.Outline, RoundedCornerShape(16.dp))
                        .padding(12.dp),
                ) {
                    Text("Transcript", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        transcript,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = JarvisPalette.TextSecondary,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Control buttons
            Row(
                horizontalArrangement = Arrangement.spacedBy(32.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Mute toggle (placeholder — local only)
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        Modifier.size(56.dp).clip(CircleShape)
                            .background(if (muted) JarvisPalette.Warning.copy(alpha = 0.2f) else JarvisPalette.Surface)
                            .border(1.dp, if (muted) JarvisPalette.Warning else JarvisPalette.Outline, CircleShape)
                            .clickable { muted = !muted },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            if (muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                            contentDescription = if (muted) "Unmute" else "Mute",
                            tint = if (muted) JarvisPalette.Warning else JarvisPalette.TextSecondary,
                            modifier = Modifier.size(24.dp),
                        )
                    }
                    Text(if (muted) "Unmute" else "Mute", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                }

                // End call button
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        Modifier.size(72.dp).clip(CircleShape).background(JarvisPalette.Error)
                            .clickable { viewModel.endCall(call.id); viewModel.dismissOutgoingCall() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.CallEnd, contentDescription = "End call", tint = Color.White, modifier = Modifier.size(32.dp))
                    }
                    Text("End", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                }
            }
        }
    }
}

// ── Carrier forwarding code row ───────────────────────────────────────────────

@Composable
private fun ForwardCodeRow(label: String, code: String, ctx: Context) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextPrimary)
            Text(code, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = JarvisPalette.Accent)
        }
        IconButton(onClick = { copyToClipboard(ctx, label, code) }) {
            Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = JarvisPalette.TextFaint, modifier = Modifier.size(16.dp))
        }
    }
}

// ── New chat dialog (text / call an agent) ────────────────────────────────────
@Composable
private fun NewChatDialog(
    agents: List<PhoneAgent>,
    onDismiss: () -> Unit,
    onStartChat: (ext: String, text: String) -> Unit,
    onStartGroup: (members: List<String>, text: String) -> Unit,
    onCall: (members: List<String>) -> Unit,
) {
    var selected by remember { mutableStateOf(setOf(agents.firstOrNull()?.extension ?: "")) }
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = JarvisPalette.Surface,
        title = {
            Text(
                if (selected.count { it.isNotBlank() } > 1) "New group chat · ${selected.count { it.isNotBlank() }}" else "New chat",
                color = JarvisPalette.TextPrimary,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Tap one or more agents", style = MaterialTheme.typography.labelSmall, color = JarvisPalette.TextFaint)
                agents.forEach { agent ->
                    val isSel = agent.extension in selected
                    Row(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (isSel) JarvisPalette.Accent.copy(alpha = 0.18f) else Color.Transparent)
                            .clickable { selected = if (isSel) selected - agent.extension else selected + agent.extension }
                            .padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (isSel) "✓ " else "○ ", color = JarvisPalette.Accent)
                        Text("${agent.name} · ${agent.extension}", color = JarvisPalette.TextPrimary)
                    }
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text(if (selected.count { it.isNotBlank() } > 1) "First message to the group…" else "First message…", color = JarvisPalette.TextFaint) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = outlinedFieldColors(),
                    textStyle = LocalTextStyle.current.copy(color = JarvisPalette.TextPrimary),
                )
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlineButton(label = "Call", onClick = {
                    val m = selected.filter { it.isNotBlank() }
                    if (m.isNotEmpty()) { onCall(m); onDismiss() }
                })
                CyanButton(
                    label = if (selected.count { it.isNotBlank() } > 1) "Start group" else "Start",
                    enabled = selected.any { it.isNotBlank() } && text.isNotBlank(),
                    onClick = {
                        val m = selected.filter { it.isNotBlank() }
                        if (m.size == 1) onStartChat(m.first(), text) else onStartGroup(m, text)
                        onDismiss()
                    },
                )
            }
        },
        dismissButton = { OutlineButton(label = "Cancel", onClick = onDismiss) },
    )
}
