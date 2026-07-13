package com.cindro.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.cindro.app.net.DeviceClient
import com.cindro.app.ui.canvas.CanvasItem
import com.cindro.app.ui.home.HomeUiState
import com.cindro.app.ui.home.HomeViewModel
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.HapticIconButton
import com.cindro.app.ui.util.ImageEncoding
import com.cindro.app.voice.VoiceController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The Claude/ChatGPT-style landing screen: the app now opens straight into this
 * blank composer instead of the old Home dashboard. Reuses [HomeViewModel]
 * unchanged (same sessions/latestCanvas/createSession it always had) and
 * [ChatEmptyState]/[InputRow] from [ChatScreen] so a fresh chat and a real one
 * read as the same "Cindro" moment. Sending the first message creates the
 * session, stashes the draft via [PendingFirstMessage], and hands off to the
 * real [ChatScreen] — see that file's `init` for the other half of the flow.
 * Home's old 2x2 quick actions (Take over/Voice/Canvas) are now a suggestion-chip
 * row here; the live-widget card survives too, just collapsed by default.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(
    viewModel: HomeViewModel,
    // Already collected once by the caller (shared with the drawer's own
    // collection of the same HomeViewModel) — don't re-collect uiState/
    // connection here too, that doubled the collector/recomposition work for
    // no benefit.
    state: HomeUiState,
    conn: DeviceClient.State,
    onOpenDrawer: () -> Unit,
    onSessionCreated: (String) -> Unit,
    onOpenVoiceSession: (String) -> Unit,
    onTakeOver: () -> Unit,
    onCanvas: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<List<PendingImage>>(emptyList()) }

    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri != null) {
            scope.launch {
                val img = withContext(Dispatchers.IO) { ImageEncoding.encode(context, uri) }
                if (img != null) {
                    pending = pending + img
                } else {
                    android.widget.Toast.makeText(
                        context,
                        "Couldn't attach that photo — try another image.",
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    fun sendFirst(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() && pending.isEmpty()) return
        if (state.creating) return // already sending one — don't fire a second createSession
        val images = pending
        // Don't clear draft/pending until we know the session actually exists —
        // a failed createSession() used to silently wipe the typed message with
        // no error shown; now it stays in the composer and the user can retry.
        viewModel.createSession(
            onCreated = { id ->
                draft = ""
                pending = emptyList()
                PendingFirstMessage.stash(id, trimmed, images)
                onSessionCreated(id)
            },
            onError = {
                android.widget.Toast.makeText(
                    context,
                    "Couldn't start a new chat — check your connection and try again.",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            },
        )
    }

    fun startVoiceChat() {
        // Guard against firing while a send is already creating a session (would
        // otherwise race two createSession() calls against PendingFirstMessage's
        // single slot), and never discard an in-progress draft/attachment — the
        // mic is for a hands-free NEW chat, not a way to abandon what's typed.
        if (state.creating || draft.isNotBlank() || pending.isNotEmpty()) return
        viewModel.createSession(
            onCreated = onOpenVoiceSession,
            onError = {
                android.widget.Toast.makeText(
                    context,
                    "Couldn't start voice chat — check your connection and try again.",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            },
        )
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    HapticIconButton(onClick = onOpenDrawer) {
                        Icon(Icons.Filled.Menu, contentDescription = "Open menu")
                    }
                },
                // Old Home showed connection state front-and-center (StatusPill +
                // greeting subtitle); the redesign otherwise only surfaces it inside
                // the closed-by-default drawer. Keep a visible indicator here too.
                actions = { com.cindro.app.ui.ConnectionPill(conn) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    ChatEmptyState()
                    SuggestionChipsRow(
                        onTakeOver = onTakeOver,
                        onVoice = ::startVoiceChat,
                        onCanvas = onCanvas,
                    )
                    state.latestCanvas?.let { canvas ->
                        Spacer(Modifier.height(16.dp))
                        CollapsibleLiveWidget(canvas, onOpenCanvas = onCanvas)
                    }
                }
            }

            // Attached-photo preview, mirroring ChatScreen's pending row — without
            // this, an attached image was invisible and unremovable before the
            // session existed to hold it.
            if (pending.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    pending.forEach { img ->
                        Box {
                            coil.compose.AsyncImage(
                                model = img.previewUri,
                                contentDescription = null,
                                modifier = Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)),
                            )
                            HapticIconButton(
                                onClick = { pending = pending.filterNot { it.previewUri == img.previewUri } },
                                modifier = Modifier.size(22.dp).align(Alignment.TopEnd),
                            ) {
                                Icon(Icons.Filled.Close, contentDescription = "Remove", tint = JarvisPalette.Error)
                            }
                        }
                    }
                }
            }

            InputRow(
                draft = draft,
                onDraftChange = {
                    draft = it
                    // Lazily fetch agents+skills the moment a "/" menu opens —
                    // this screen is the default landing place to start a chat
                    // now, so it needs the same catalog load ChatScreen does.
                    if (it.startsWith("/") && !it.contains(" ")) viewModel.loadSlashCatalog()
                },
                sending = state.creating,
                busy = false,
                hasAttachment = pending.isNotEmpty(),
                voicePhase = VoiceController.Phase.IDLE,
                slashAgents = state.slashAgents,
                slashSkills = state.slashSkills,
                onSlashPick = { draft = it },
                onAttach = { pickImage.launch("image/*") },
                onPasteImage = {
                    val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                        as android.content.ClipboardManager
                    val clip = cm.primaryClip
                    val uri = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).uri else null
                    if (uri == null) {
                        android.widget.Toast.makeText(
                            context,
                            "No image on the clipboard — copy a photo or screenshot first.",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    } else {
                        scope.launch {
                            val img = withContext(Dispatchers.IO) { ImageEncoding.encode(context, uri) }
                            if (img != null) pending = pending + img
                        }
                    }
                },
                onSend = { sendFirst(draft) },
                onStop = {},
                onMicDown = { startVoiceChat() },
                onMicUp = {},
                onMicCancel = {},
                onStopSpeaking = {},
            )
        }
    }
}

@Composable
private fun SuggestionChipsRow(
    onTakeOver: () -> Unit,
    onVoice: () -> Unit,
    onCanvas: () -> Unit,
) {
    Row(
        Modifier
            .padding(top = 4.dp)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SuggestionChip(
            onClick = onTakeOver,
            label = { Text("Take over") },
            icon = {
                Icon(Icons.Filled.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
            },
            colors = SuggestionChipDefaults.suggestionChipColors(
                containerColor = JarvisPalette.Surface,
                labelColor = JarvisPalette.TextPrimary,
                iconContentColor = JarvisPalette.Violet,
            ),
            border = SuggestionChipDefaults.suggestionChipBorder(
                enabled = true, borderColor = JarvisPalette.Outline,
            ),
        )
        SuggestionChip(
            onClick = onVoice,
            label = { Text("Voice") },
            icon = {
                Icon(Icons.Filled.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
            },
            colors = SuggestionChipDefaults.suggestionChipColors(
                containerColor = JarvisPalette.Surface,
                labelColor = JarvisPalette.TextPrimary,
                iconContentColor = JarvisPalette.Success,
            ),
            border = SuggestionChipDefaults.suggestionChipBorder(
                enabled = true, borderColor = JarvisPalette.Outline,
            ),
        )
        SuggestionChip(
            onClick = onCanvas,
            label = { Text("Canvas") },
            icon = {
                Icon(Icons.Filled.Dashboard, contentDescription = null, modifier = Modifier.size(18.dp))
            },
            colors = SuggestionChipDefaults.suggestionChipColors(
                containerColor = JarvisPalette.Surface,
                labelColor = JarvisPalette.TextPrimary,
                iconContentColor = JarvisPalette.Pink,
            ),
            border = SuggestionChipDefaults.suggestionChipBorder(
                enabled = true, borderColor = JarvisPalette.Outline,
            ),
        )
    }
}

/** The old Home "Live widget" card, ported verbatim but collapsed by default
 *  (tap to expand) since it now shares the screen with suggestion chips. */
@Composable
private fun CollapsibleLiveWidget(canvas: CanvasItem, onOpenCanvas: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.Dashboard, contentDescription = null,
                    tint = JarvisPalette.Accent, modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    canvas.title.ifBlank { "Live widget" },
                    style = MaterialTheme.typography.titleSmall,
                    color = JarvisPalette.TextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onOpenCanvas) { Text("Canvas") }
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (expanded) "Collapse" else "Expand",
                    tint = JarvisPalette.TextSecondary,
                )
            }
            AnimatedVisibility(visible = expanded) {
                Column(Modifier.padding(top = 10.dp)) {
                    WidgetRenderer(canvas.specJson)
                }
            }
        }
    }
}
