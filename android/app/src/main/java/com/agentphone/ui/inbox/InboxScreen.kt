package com.agentphone.ui.inbox

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import com.agentphone.state.UiThread
import com.agentphone.ui.components.IconPill
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun InboxScreen(vm: AppViewModel, onOpenThread: (String) -> Unit) {
    val threads by vm.threads.collectAsState()
    LaunchedEffect(Unit) { vm.fetchPendingMessages() }

    var showNewChat by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<UiThread?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Chats",
                style = MaterialTheme.typography.titleSmall,
                color = LocalSemanticColors.current.textMuted,
                modifier = Modifier.weight(1f)
            )
            IconPill(icon = Icons.Rounded.Refresh, onClick = { vm.fetchPendingMessages() })
            Spacer(Modifier.width(8.dp))
            IconPill(icon = Icons.Rounded.Add, onClick = { showNewChat = true })
        }

        if (threads.isEmpty()) {
            EmptyState()
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(threads, key = { it.id }) { thread ->
                    ThreadRow(
                        thread = thread,
                        onClick = { onOpenThread(thread.id) },
                        onLongPress = { pendingDelete = thread }
                    )
                }
                item { Spacer(Modifier.height(12.dp)) }
            }
        }
    }

    if (showNewChat) {
        NewChatDialog(
            vm = vm,
            onDismiss = { showNewChat = false },
            onStarted = { threadId -> showNewChat = false; onOpenThread(threadId) }
        )
    }
    pendingDelete?.let { thread ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete chat?") },
            text = { Text("This removes \"${thread.subject.ifBlank { "Untitled" }}\" and its messages.") },
            confirmButton = {
                TextButton(onClick = { vm.deleteThread(thread.id); pendingDelete = null }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } }
        )
    }
}

@Composable
private fun NewChatDialog(vm: AppViewModel, onDismiss: () -> Unit, onStarted: (String) -> Unit) {
    var agents by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var text by remember { mutableStateOf("") }
    val semantic = LocalSemanticColors.current
    LaunchedEffect(Unit) { vm.listAgents { list -> agents = list; if (selected.isEmpty()) list.firstOrNull()?.let { selected = setOf(it.first) } } }

    val isGroup = selected.size > 1

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isGroup) "New group chat · ${selected.size}" else "New chat") },
        text = {
            Column {
                Text("Tap one or more agents", style = MaterialTheme.typography.labelMedium, color = semantic.textMuted)
                Spacer(Modifier.height(6.dp))
                agents.forEach { (ext, name) ->
                    val isSel = ext in selected
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (isSel) Palette.Indigo.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceContainerHigh)
                            .clickable { selected = if (isSel) selected - ext else selected + ext }
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(if (isSel) "✓ " else "○ ", color = if (isSel) Palette.Indigo else semantic.textMuted)
                        Text("$name · $ext", color = if (isSel) Palette.Indigo else MaterialTheme.colorScheme.onSurface)
                    }
                    Spacer(Modifier.height(6.dp))
                }
                Spacer(Modifier.height(6.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text(if (isGroup) "First message to the group…" else "First message…") },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            Row {
                // Voice twin of the group chat: same selection, but a CALL with
                // just these agents (server opens it active and rings us in).
                TextButton(
                    enabled = selected.isNotEmpty(),
                    onClick = {
                        vm.startConferenceCall(selected.toList())
                        onDismiss()
                    }
                ) { Text("📞 Call") }
                TextButton(
                    enabled = selected.isNotEmpty() && text.isNotBlank(),
                    onClick = {
                        val members = selected.toList()
                        if (members.size == 1) {
                            vm.startChat(members.first(), text.trim()) { tid -> onStarted(tid) }
                        } else {
                            vm.startGroupChat(members, text.trim()) { tid -> onStarted(tid) }
                        }
                    }
                ) { Text(if (isGroup) "Start group" else "Start") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ThreadRow(thread: UiThread, onClick: () -> Unit, onLongPress: () -> Unit) {
    val semantic = LocalSemanticColors.current
    val shape = RoundedCornerShape(16.dp)
    val priorityColor = when (thread.highestPriority) {
        "critical" -> Palette.Red
        "urgent" -> Palette.Amber
        "low" -> Palette.Indigo
        else -> Palette.Teal
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .border(1.dp, semantic.hairline, shape)
            .combinedClickable(onClick = onClick, onLongClick = onLongPress)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(priorityColor.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center
        ) {
            Text(
                thread.relatedExtension?.take(2) ?: "AG",
                style = MaterialTheme.typography.titleSmall,
                color = priorityColor
            )
        }
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    thread.subject.ifBlank { "Untitled" },
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    thread.latestMessageAt.takeLast(8).take(5),
                    style = MaterialTheme.typography.labelSmall,
                    color = semantic.textMuted
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                thread.latestPreview,
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted,
                maxLines = 2
            )
        }
        if (thread.unreadCount > 0) {
            Spacer(Modifier.width(10.dp))
            UnreadBadge(count = thread.unreadCount, color = priorityColor)
        }
    }
}

@Composable
private fun UnreadBadge(count: Int, color: androidx.compose.ui.graphics.Color) {
    Box(
        modifier = Modifier
            .size(22.dp)
            .clip(CircleShape)
            .background(color),
        contentAlignment = Alignment.Center
    ) {
        Text(
            if (count > 9) "9+" else count.toString(),
            style = MaterialTheme.typography.labelSmall,
            color = Palette.OnAccent
        )
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(80.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Rounded.Inbox, contentDescription = null, tint = LocalSemanticColors.current.textMuted, modifier = Modifier.size(36.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text("No messages yet", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(6.dp))
        Text(
            "Agents will reach you here when they need a decision.",
            style = MaterialTheme.typography.bodySmall,
            color = LocalSemanticColors.current.textMuted
        )
    }
}
