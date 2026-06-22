package com.jarvis.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

@Composable
fun ChatBubble(
    item: ChatItem,
    onApprove: (ChatItem.Approval, String) -> Unit,
) {
    when (item) {
        is ChatItem.Message -> MessageBubble(item)
        is ChatItem.Thinking -> ThinkingBubble(item)
        is ChatItem.ToolCall -> ToolCallBubble(item)
        is ChatItem.Diff -> DiffBubble(item)
        is ChatItem.Approval -> ApprovalCard(item, onApprove)
        is ChatItem.Error -> ErrorBubble(item)
    }
}

@Composable
private fun MessageBubble(item: ChatItem.Message) {
    val isUser = item.role == "user"
    val align = if (isUser) Alignment.End else Alignment.Start
    val bg = if (isUser) JarvisPalette.AccentDim else JarvisPalette.Surface
    val fg = if (isUser) JarvisPalette.TextPrimary else JarvisPalette.TextPrimary
    Column(Modifier.fillMaxWidth(), horizontalAlignment = align) {
        Surface(
            color = bg,
            shape = RoundedCornerShape(
                topStart = 14.dp, topEnd = 14.dp,
                bottomStart = if (isUser) 14.dp else 2.dp,
                bottomEnd = if (isUser) 2.dp else 14.dp,
            ),
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Text(
                text = item.text,
                color = fg,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                style = MaterialTheme.typography.bodyLarge,
            )
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
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val tint = when (item.ok) {
                    true -> JarvisPalette.Success
                    false -> JarvisPalette.Error
                    null -> JarvisPalette.Accent
                }
                Icon(Icons.Filled.Build, contentDescription = null, tint = tint, modifier = Modifier.height(16.dp))
                Spacer(Modifier.height(0.dp))
                Text(
                    text = "  ${item.name}",
                    style = MaterialTheme.typography.titleMedium,
                    color = JarvisPalette.TextPrimary,
                )
            }
            item.argsJson?.takeIf { it.isNotBlank() && it != "{}" }?.let { args ->
                Spacer(Modifier.height(6.dp))
                MonoBlock(args)
            }
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
                    OutlinedButton(onClick = { onApprove(item, "deny") }) { Text("Deny") }
                    Button(
                        onClick = { onApprove(item, "allow") },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JarvisPalette.Accent, contentColor = JarvisPalette.OnAccent,
                        ),
                    ) { Text("Allow") }
                    OutlinedButton(onClick = { onApprove(item, "always") }) { Text("Always") }
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
