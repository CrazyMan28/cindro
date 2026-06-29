package com.agentphone.ui.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentphone.state.ScreeningLine
import com.agentphone.state.ScreeningSessionUi
import com.agentphone.state.ScreeningStore

@Composable
fun ScreeningScreen(
    onTakeOver: (callId: String) -> Unit,
    onEnd: (callId: String) -> Unit,
    onClose: () -> Unit
) {
    var state by remember { mutableStateOf(ScreeningStore.current()) }
    var takeOverRequested by remember { mutableStateOf(false) }
    DisposableEffect(Unit) {
        val unsubscribe = ScreeningStore.subscribe { state = ScreeningStore.current() }
        onDispose { unsubscribe() }
    }
    val session = state.first
    val lines = state.second
    val listState = rememberLazyListState()
    LaunchedEffect(lines.size) {
        if (lines.isNotEmpty()) listState.animateScrollToItem(lines.lastIndex)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 16.dp, vertical = 24.dp)
    ) {
        ScreeningHeader(session, takeOverRequested)
        Spacer(Modifier.height(12.dp))
        Box(modifier = Modifier.weight(1f)) {
            if (lines.isEmpty()) {
                Text(
                    text = "Your agent is answering the call…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.Center)
                )
            } else {
                LazyColumn(state = listState, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(lines, key = { it.seq }) { line -> ScreeningBubble(line) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        when {
            session == null -> {
                OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Close") }
            }
            session.status == "active" -> {
                if (takeOverRequested) {
                    Text(
                        text = "Your phone will ring from the agent number — answer it to talk to the caller.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(8.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Button(
                        onClick = {
                            takeOverRequested = true
                            onTakeOver(session.callId)
                        },
                        enabled = !takeOverRequested,
                        modifier = Modifier.weight(1f)
                    ) { Text(if (takeOverRequested) "Connecting…" else "Take over") }
                    Button(
                        onClick = { onEnd(session.callId) },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFB3261E), contentColor = Color.White),
                        modifier = Modifier.weight(1f)
                    ) { Text("End call") }
                }
            }
            else -> {
                Text(
                    text = if (session.status == "taken_over") "You took the call on your phone." else "Call ended.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Close") }
            }
        }
    }
}

@Composable
private fun ScreeningHeader(session: ScreeningSessionUi?, takeOverRequested: Boolean) {
    Column {
        Text(
            text = "Agent screening call",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onBackground
        )
        Text(
            text = when {
                session == null -> "No active screening"
                else -> buildString {
                    append(session.callerNumber)
                    session.forwardedFrom?.let { append("  ·  forwarded from $it") }
                }
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (session != null && session.status == "active" && !takeOverRequested) {
            Text(
                text = "Live — the agent is talking for you. Watch, take over, or hang up.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
private fun ScreeningBubble(line: ScreeningLine) {
    val isCaller = line.speaker == "caller"
    val isSystem = line.speaker == "system"
    if (isSystem) {
        Text(
            text = line.text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth()
        )
        return
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isCaller) Arrangement.Start else Arrangement.End
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 14.dp,
                        topEnd = 14.dp,
                        bottomStart = if (isCaller) 4.dp else 14.dp,
                        bottomEnd = if (isCaller) 14.dp else 4.dp
                    )
                )
                .background(
                    if (isCaller) MaterialTheme.colorScheme.surfaceVariant
                    else MaterialTheme.colorScheme.primaryContainer
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text(
                text = if (isCaller) "Caller" else "Agent",
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = line.text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (isCaller) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onPrimaryContainer
            )
        }
    }
}
