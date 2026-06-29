package com.agentphone.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentphone.state.UiMessage
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette

@Composable
fun ThreadScreen(vm: AppViewModel, threadId: String, onBack: () -> Unit) {
    val threads by vm.threads.collectAsState()
    val messages = remember(threadId, threads) { vm.threadMessages(threadId) }
    val settings by vm.settings.collectAsState()
    val extension = settings.extension
    val listState = rememberLazyListState()
    var reply by remember { mutableStateOf("") }

    val pending = remember(messages) {
        messages.lastOrNull { it.toExtension == extension && it.status !in setOf("read", "replied", "expired") }
    }
    val peer = remember(messages, extension) {
        messages.firstOrNull { it.fromExtension != extension }?.fromExtension
            ?: messages.firstOrNull()?.toExtension ?: "agent"
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }
    LaunchedEffect(pending?.id) { pending?.let { vm.markMessageRead(it) } }

    val semantic = LocalSemanticColors.current

    // Single full-height column: header (fixed) → messages (fills, scrolls) →
    // options + reply bar pinned at the bottom. imePadding lifts the bar above
    // the keyboard. This structure can't collapse the way the old one did.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .imePadding()
    ) {
        ThreadHeader(peer = peer, count = messages.size, onBack = onBack)

        if (messages.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    "No messages yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = semantic.textMuted
                )
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(messages, key = { it.id }) { message ->
                    MessageBubble(message = message, outbound = message.fromExtension == extension)
                }
            }
        }

        if (pending != null && pending.requiresResponse && pending.responseOptions.isNotEmpty()) {
            OptionsRow(options = pending.responseOptions, onSelect = { vm.replyMessage(pending, null, it) })
        }

        ReplyBar(
            text = reply,
            onTextChange = { reply = it },
            onSend = {
                if (reply.isBlank()) return@ReplyBar
                // Send as a message in THIS thread so the agent keeps this chat's context.
                vm.sendInThread(threadId, peer, reply)
                reply = ""
            }
        )
    }
}

@Composable
private fun ThreadHeader(peer: String, count: Int, onBack: () -> Unit) {
    val semantic = LocalSemanticColors.current
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Rounded.ArrowBack, contentDescription = "Back", tint = MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.width(8.dp))
            Box(
                modifier = Modifier.size(40.dp).clip(CircleShape).background(Palette.Indigo),
                contentAlignment = Alignment.Center
            ) {
                Text(peer.firstOrNull()?.uppercase() ?: "A", color = Palette.OnAccent, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    "Extension $peer",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1
                )
                Text(
                    if (count == 0) "no messages" else "$count message${if (count == 1) "" else "s"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(message: UiMessage, outbound: Boolean) {
    val semantic = LocalSemanticColors.current
    val shape = if (outbound)
        RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp)
    else
        RoundedCornerShape(22.dp, 22.dp, 22.dp, 6.dp)
    val bg = if (outbound) Palette.Indigo else MaterialTheme.colorScheme.surfaceContainerHigh
    val fg = if (outbound) Palette.OnAccent else MaterialTheme.colorScheme.onSurface

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (outbound) Arrangement.End else Arrangement.Start
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(shape)
                .background(bg)
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            if (!outbound && message.priority in setOf("urgent", "critical")) {
                PriorityRibbon(message.priority)
                Spacer(Modifier.height(6.dp))
            }
            // Agent messages show a sender/title label; your own outgoing bubbles don't.
            if (!outbound && message.title.isNotBlank()) {
                Text(message.title, style = MaterialTheme.typography.titleSmall, color = fg)
                if (message.body.isNotBlank()) Spacer(Modifier.height(3.dp))
            }
            if (message.body.isNotBlank()) {
                Text(message.body, style = MaterialTheme.typography.bodyLarge, color = fg.copy(alpha = 0.95f))
            }
            if (!message.responseText.isNullOrBlank() || !message.selectedOption.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "↪ ${message.responseText ?: message.selectedOption}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (outbound) Palette.OnAccent.copy(alpha = 0.85f) else Palette.Indigo
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "${message.createdAt.takeLast(8).take(5)} · ${message.status}",
                style = MaterialTheme.typography.labelSmall,
                color = if (outbound) Palette.OnAccent.copy(alpha = 0.7f) else semantic.textMuted
            )
        }
    }
}

@Composable
private fun PriorityRibbon(priority: String) {
    val (label, color) = when (priority) {
        "critical" -> "CRITICAL" to Palette.Red
        "urgent" -> "URGENT" to Palette.Amber
        "low" -> "LOW" to Palette.Indigo
        else -> "NORMAL" to Palette.Teal
    }
    Box(
        modifier = Modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.22f)).padding(horizontal = 8.dp, vertical = 2.dp)
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

@Composable
private fun OptionsRow(options: List<String>, onSelect: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        options.take(3).forEach { option ->
            PressableButton(
                label = option,
                variant = optionVariant(option),
                onClick = { onSelect(option) },
                modifier = Modifier.weight(1f),
                fillWidth = false
            )
        }
    }
}

private fun optionVariant(option: String): ButtonVariant = when (option.lowercase()) {
    "approve", "yes", "ok", "works", "got_it", "heard_you" -> ButtonVariant.Success
    "deny", "no", "reject" -> ButtonVariant.Danger
    "call_me", "call_again" -> ButtonVariant.Primary
    else -> ButtonVariant.Tonal
}

@Composable
private fun ReplyBar(text: String, onTextChange: (String) -> Unit, onSend: () -> Unit) {
    val semantic = LocalSemanticColors.current
    val shape = RoundedCornerShape(26.dp)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(shape)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                    .border(1.dp, semantic.hairline, shape)
                    .padding(horizontal = 18.dp, vertical = 14.dp)
            ) {
                if (text.isEmpty()) {
                    Text("Message…", style = MaterialTheme.typography.bodyLarge, color = semantic.textMuted)
                }
                BasicTextField(
                    value = text,
                    onValueChange = onTextChange,
                    textStyle = LocalTextStyle.current.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(Palette.Indigo),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            Spacer(Modifier.width(10.dp))
            val canSend = text.isNotBlank()
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(if (canSend) Palette.Indigo else MaterialTheme.colorScheme.surfaceContainerHighest)
                    .clickable { if (canSend) onSend() },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Rounded.Send,
                    contentDescription = "Send",
                    tint = if (canSend) Palette.OnAccent else semantic.textMuted
                )
            }
        }
    }
}
