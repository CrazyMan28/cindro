package com.jarvis.app.ui.phone

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Message
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.StatusPill

/**
 * Top-level Phone screen. Tab-based: CALLS | INBOX | SETTINGS.
 * Overlays IncomingCallScreen when a ringing call is present.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneScreen(viewModel: PhoneViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    // Full-screen incoming call overlay — takes precedence over everything
    AnimatedVisibility(
        visible = state.incomingCall != null,
        enter = fadeIn(tween(200)),
        exit = fadeOut(tween(200)),
    ) {
        state.incomingCall?.let { call ->
            IncomingCallScreen(
                call = call,
                onAccept = { viewModel.acceptCall(call.id) },
                onDecline = { viewModel.declineCall(call.id) },
            )
        }
    }

    if (state.incomingCall != null) return

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "Phone",
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.TextPrimary,
                    )
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = JarvisPalette.Accent)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = JarvisPalette.Background),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {

            // ── Tab row ───────────────────────────────────────────────────
            TabRow(
                selectedTabIndex = state.tab.ordinal,
                containerColor = JarvisPalette.Surface,
                contentColor = JarvisPalette.Accent,
            ) {
                PhoneTab.entries.forEach { tab ->
                    Tab(
                        selected = state.tab == tab,
                        onClick = { viewModel.setTab(tab) },
                        text = {
                            Text(
                                tab.name,
                                color = if (state.tab == tab) JarvisPalette.Accent else JarvisPalette.TextSecondary,
                                style = MaterialTheme.typography.labelLarge,
                            )
                        },
                    )
                }
            }

            // ── Status banners ────────────────────────────────────────────
            AnimatedVisibility(visible = state.error != null) {
                state.error?.let { err ->
                    Text(
                        err,
                        color = JarvisPalette.Error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(JarvisPalette.Error.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
            AnimatedVisibility(visible = state.toast != null) {
                state.toast?.let { msg ->
                    Text(
                        msg,
                        color = JarvisPalette.Success,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(JarvisPalette.Success.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }

            // ── Tab content ───────────────────────────────────────────────
            when (state.tab) {
                PhoneTab.CALLS -> CallsTab(state, viewModel)
                PhoneTab.INBOX -> InboxTab(state, viewModel)
                PhoneTab.SETTINGS -> SettingsTab(state, viewModel)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLS tab
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun CallsTab(state: PhoneUiState, viewModel: PhoneViewModel) {
    var dialTo by remember { mutableStateOf("") }
    var dialReason by remember { mutableStateOf("") }
    var dialSay by remember { mutableStateOf("") }
    var expandedCallId by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {

        // Active calls section header
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Active Calls",
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                color = JarvisPalette.TextPrimary,
            )
            StatusPill(
                text = if (state.activeCalls.isEmpty()) "IDLE" else "${state.activeCalls.size} ACTIVE",
                color = if (state.activeCalls.isEmpty()) JarvisPalette.TextFaint else JarvisPalette.Success,
            )
        }

        if (state.activeCalls.isEmpty()) {
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "No active calls",
                    color = JarvisPalette.TextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            state.activeCalls.forEach { call ->
                CallCard(
                    call = call,
                    isExpanded = expandedCallId == call.id,
                    transcript = if (expandedCallId == call.id) state.callTranscript else "",
                    onExpand = {
                        if (expandedCallId == call.id) {
                            expandedCallId = null
                        } else {
                            expandedCallId = call.id
                            viewModel.loadCallTranscript(call.id)
                        }
                    },
                    onEnd = { viewModel.endCall(call.id) },
                )
            }
        }

        // Dialer
        GlowCard(modifier = Modifier.fillMaxWidth(), accent = true) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Phone,
                        contentDescription = null,
                        tint = JarvisPalette.Accent,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Place Call",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.Accent,
                    )
                }
                OutlinedTextField(
                    value = dialTo,
                    onValueChange = { dialTo = it },
                    label = { Text("Extension (e.g. 101) or Phone Number (+1…)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = dialReason,
                    onValueChange = { dialReason = it },
                    label = { Text("Reason") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = dialSay,
                    onValueChange = { dialSay = it },
                    label = { Text("Opening message (TTS prompt)") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(
                        onClick = {
                            viewModel.placeCall(dialTo.trim(), dialReason.trim(), dialSay.trim())
                            dialTo = ""; dialReason = ""; dialSay = ""
                        },
                        enabled = dialTo.isNotBlank() && dialReason.isNotBlank() && dialSay.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JarvisPalette.Accent,
                            contentColor = JarvisPalette.OnAccent,
                        ),
                    ) {
                        Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Call")
                    }
                }
            }
        }
    }
}

@Composable
private fun CallCard(
    call: PhoneCall,
    isExpanded: Boolean,
    transcript: String,
    onExpand: () -> Unit,
    onEnd: () -> Unit,
) {
    val stateColor by animateColorAsState(
        targetValue = callStateColor(call.state),
        animationSpec = tween(300),
        label = "callStateColor",
    )

    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Call ${call.id.take(8)}…",
                        style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Monospace),
                        color = JarvisPalette.TextPrimary,
                    )
                    Text(
                        "Ext ${call.fromExtension ?: "?"} → Ext ${call.toExtension ?: "?"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = JarvisPalette.TextSecondary,
                    )
                }
                StatusPill(text = call.state.uppercase(), color = stateColor)
            }

            call.reason?.takeIf { it.isNotBlank() }?.let { reason ->
                Text(
                    "Reason: $reason",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextSecondary,
                )
            }

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = onExpand) {
                    Icon(
                        imageVector = if (isExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = JarvisPalette.Accent,
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        if (isExpanded) "Hide" else "Transcript",
                        color = JarvisPalette.Accent,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
                Button(
                    onClick = onEnd,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Error,
                        contentColor = Color.White,
                    ),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Icon(Icons.Filled.CallEnd, contentDescription = null, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("End", style = MaterialTheme.typography.labelMedium)
                }
            }

            AnimatedVisibility(visible = isExpanded) {
                Column {
                    Box(
                        Modifier.fillMaxWidth().height(1.dp)
                            .background(JarvisPalette.Outline),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = if (transcript.isBlank()) "No transcript yet…" else transcript,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = JarvisPalette.TextSecondary,
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOX tab
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun InboxTab(state: PhoneUiState, viewModel: PhoneViewModel) {
    var composeTitle by remember { mutableStateOf("") }
    var composeBody by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize()) {
        // Compose area
        GlowCard(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            accent = true,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Message,
                        contentDescription = null,
                        tint = JarvisPalette.Accent,
                        modifier = Modifier.size(17.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Send Message",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.Accent,
                    )
                }
                OutlinedTextField(
                    value = composeTitle,
                    onValueChange = { composeTitle = it },
                    label = { Text("Subject") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = composeBody,
                    onValueChange = { composeBody = it },
                    label = { Text("Message") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(
                        onClick = {
                            viewModel.sendText(composeTitle.trim(), composeBody.trim())
                            composeTitle = ""; composeBody = ""
                        },
                        enabled = composeTitle.isNotBlank() && composeBody.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JarvisPalette.Accent,
                            contentColor = JarvisPalette.OnAccent,
                        ),
                    ) {
                        Icon(Icons.Filled.Send, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Send")
                    }
                }
            }
        }

        // Messages
        if (state.inboxMessages.isEmpty()) {
            Box(
                Modifier.fillMaxWidth().padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Inbox empty", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.inboxMessages, key = { it.id }) { msg ->
                    InboxMessageCard(msg = msg)
                }
            }
        }
    }
}

@Composable
private fun InboxMessageCard(msg: InboxMessage) {
    val priorityColor = when (msg.priority) {
        "critical" -> JarvisPalette.Error
        "urgent" -> JarvisPalette.Warning
        "normal" -> JarvisPalette.Accent
        else -> JarvisPalette.TextSecondary
    }

    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    msg.title.ifBlank { "(no subject)" },
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = JarvisPalette.TextPrimary,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(text = msg.status.uppercase(), color = priorityColor)
            }
            Text(
                msg.message,
                style = MaterialTheme.typography.bodyMedium,
                color = JarvisPalette.TextSecondary,
                maxLines = 5,
            )
            msg.fromExtension?.let {
                Text(
                    "From ext $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextFaint,
                )
            }
            if (msg.responseOptions.isNotEmpty()) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    msg.responseOptions.take(4).forEach { opt ->
                        AssistChip(
                            onClick = { /* TODO: reply with selected option */ },
                            label = { Text(opt, style = MaterialTheme.typography.labelSmall) },
                            colors = AssistChipDefaults.assistChipColors(
                                labelColor = JarvisPalette.Accent,
                                containerColor = JarvisPalette.Accent.copy(alpha = 0.10f),
                            ),
                        )
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS tab
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun SettingsTab(state: PhoneUiState, viewModel: PhoneViewModel) {
    var newUserNumber by remember { mutableStateOf("") }
    var allowNumber by remember { mutableStateOf("") }
    var allowLabel by remember { mutableStateOf("") }
    var redAlertMsg by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {

        // ── Twilio status ─────────────────────────────────────────────────
        GlowCard(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Phone,
                        contentDescription = null,
                        tint = JarvisPalette.Accent,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Twilio Status",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.TextPrimary,
                    )
                }
                state.twilioStatus?.let { ts ->
                    StatusPill(
                        text = if (ts.configured) "CONFIGURED" else "NOT CONFIGURED",
                        color = if (ts.configured) JarvisPalette.Success else JarvisPalette.Error,
                    )
                    ts.fromNumber?.let { num ->
                        Text("From: $num", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(JarvisPalette.Outline))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column {
                            Text("Call Screening", style = MaterialTheme.typography.bodyMedium, color = JarvisPalette.TextPrimary)
                            Text("Screen unknown callers automatically", style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                        }
                        Switch(
                            checked = ts.screeningEnabled,
                            onCheckedChange = { viewModel.toggleScreening(it) },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = JarvisPalette.OnAccent,
                                checkedTrackColor = JarvisPalette.Accent,
                                uncheckedThumbColor = JarvisPalette.TextSecondary,
                                uncheckedTrackColor = JarvisPalette.Surface,
                            ),
                        )
                    }
                } ?: Text("Loading Twilio status…", color = JarvisPalette.TextSecondary, style = MaterialTheme.typography.bodySmall)
            }
        }

        // ── User number ───────────────────────────────────────────────────
        GlowCard(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Your Phone Number",
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                    color = JarvisPalette.TextPrimary,
                )
                if (state.defaultUserNumber.isNotBlank()) {
                    Text(
                        "Current: ${state.defaultUserNumber}",
                        style = MaterialTheme.typography.bodySmall,
                        color = JarvisPalette.Accent,
                    )
                }
                OutlinedTextField(
                    value = newUserNumber,
                    onValueChange = { newUserNumber = it },
                    label = { Text("E.164 format, e.g. +12125551234") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Button(
                    onClick = { viewModel.setUserNumber(newUserNumber.trim()); newUserNumber = "" },
                    enabled = newUserNumber.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Accent,
                        contentColor = JarvisPalette.OnAccent,
                    ),
                ) {
                    Text("Set Number")
                }
            }
        }

        // ── Allowlist ─────────────────────────────────────────────────────
        GlowCard(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Phone Allowlist",
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                    color = JarvisPalette.TextPrimary,
                )
                if (state.allowlist.isEmpty()) {
                    Text(
                        "No allowlisted numbers",
                        color = JarvisPalette.TextSecondary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    state.allowlist.forEach { entry ->
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                Icons.Filled.CheckCircle,
                                contentDescription = null,
                                tint = JarvisPalette.Success,
                                modifier = Modifier.size(16.dp),
                            )
                            Column(Modifier.weight(1f)) {
                                Text(
                                    entry.phoneNumber,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = JarvisPalette.TextPrimary,
                                )
                                entry.label?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                                }
                            }
                        }
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(JarvisPalette.Outline))
                }
                Text("Add Number", style = MaterialTheme.typography.labelMedium, color = JarvisPalette.TextSecondary)
                OutlinedTextField(
                    value = allowNumber,
                    onValueChange = { allowNumber = it },
                    label = { Text("Phone number") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = allowLabel,
                    onValueChange = { allowLabel = it },
                    label = { Text("Label (optional)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Button(
                    onClick = {
                        viewModel.addToAllowlist(allowNumber.trim(), allowLabel.trim())
                        allowNumber = ""; allowLabel = ""
                    },
                    enabled = allowNumber.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Accent,
                        contentColor = JarvisPalette.OnAccent,
                    ),
                ) {
                    Text("Add to Allowlist")
                }
            }
        }

        // ── Voice profile ─────────────────────────────────────────────────
        GlowCard(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Mic,
                        contentDescription = null,
                        tint = JarvisPalette.Violet,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Voice Profile",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.TextPrimary,
                    )
                }
                Text(
                    "Voice profiles (Mistral voice UUID or local:jarvis) are managed via the desktop ops dashboard or the set_voice_profile MCP tool.",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextSecondary,
                )
            }
        }

        // ── War Room / Red Alert ──────────────────────────────────────────
        GlowCard(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        tint = JarvisPalette.Error,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "War Room / Red Alert",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = JarvisPalette.Error,
                    )
                }
                Text(
                    "Broadcasts an emergency alert to every agent, creates a group war-room thread, and spawns offline agents.",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextSecondary,
                )
                OutlinedTextField(
                    value = redAlertMsg,
                    onValueChange = { redAlertMsg = it },
                    label = { Text("Alert message") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                Button(
                    onClick = { viewModel.triggerRedAlert(redAlertMsg.trim()); redAlertMsg = "" },
                    enabled = redAlertMsg.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = JarvisPalette.Error,
                        contentColor = Color.White,
                    ),
                ) {
                    Icon(Icons.Filled.Warning, contentDescription = null, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Send Red Alert", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

private fun callStateColor(state: String): Color = when (state) {
    "ringing" -> JarvisPalette.Warning
    "accepted", "active" -> JarvisPalette.Success
    "listening" -> JarvisPalette.Accent
    "transcribing", "agent_thinking" -> JarvisPalette.Violet
    "speaking", "waiting_for_user" -> JarvisPalette.Accent2
    "ended" -> JarvisPalette.TextFaint
    "failed", "rejected", "missed", "timeout" -> JarvisPalette.Error
    else -> JarvisPalette.TextSecondary
}
