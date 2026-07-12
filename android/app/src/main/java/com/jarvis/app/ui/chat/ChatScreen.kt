package com.jarvis.app.ui.chat

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.util.Biometric
import com.jarvis.app.ui.util.HapticButton
import com.jarvis.app.ui.util.HapticIconButton
import com.jarvis.app.ui.util.HapticOutlinedButton
import com.jarvis.app.ui.util.ImageEncoding
import com.jarvis.app.ui.util.JarvisOrb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    activity: FragmentActivity,
    onBack: () -> Unit,
    autoStartVoice: Boolean = false,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val voicePhase by viewModel.voicePhase.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var draft by remember { mutableStateOf("") }
    var micGranted by remember {
        mutableStateOf(
            androidx.core.content.ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED,
        )
    }

    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri != null) {
            scope.launch {
                val img = withContext(Dispatchers.IO) { ImageEncoding.encode(context, uri) }
                if (img != null) {
                    viewModel.attach(img)
                } else {
                    // Don't let the photo silently vanish — tell the user it failed.
                    android.widget.Toast.makeText(
                        context,
                        "Couldn't attach that photo — try another image.",
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    val requestMic = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> micGranted = granted }

    // "Hey Orin" wake deep-link: start a push-to-talk capture on entry.
    LaunchedEffect(autoStartVoice) {
        if (autoStartVoice && micGranted) viewModel.startRecording()
    }

    // Auto-scroll to the newest item; also follows streaming text growth while busy.
    val lastText = (state.items.lastOrNull() as? ChatItem.Message)?.text
    LaunchedEffect(state.items.size, state.busy, lastText) {
        if (state.items.isNotEmpty()) listState.animateScrollToItem(state.items.lastIndex)
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            if (state.selecting) {
                ChatSelectionBar(
                    count = state.selected.size,
                    onClose = { viewModel.clearSelection() },
                    onCopy = {
                        copyToClipboard(context, selectedText(state))
                        viewModel.clearSelection()
                    },
                    onDelete = { viewModel.deleteItems(state.selected) },
                )
            } else {
                TopAppBar(
                    title = { Text("Chat", fontFamily = FontFamily.Monospace) },
                    navigationIcon = {
                        HapticIconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    actions = {
                        if (state.busy) {
                            HapticIconButton(onClick = viewModel::cancel) {
                                Icon(Icons.Filled.Stop, contentDescription = "Cancel turn", tint = JarvisPalette.Error)
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = JarvisPalette.Background,
                        titleContentColor = JarvisPalette.TextPrimary,
                    ),
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
          Box(Modifier.weight(1f).fillMaxWidth()) {
            // Animated empty state for a fresh chat — no more blank "bland" screen.
            if (state.items.isEmpty()) ChatEmptyState(Modifier.align(Alignment.Center))
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.items, key = { it.id }) { item ->
                    ChatBubble(
                        item = item,
                        onApprove = { approval, decision ->
                            scope.launch {
                                val ok = Biometric.authenticate(
                                    activity,
                                    title = "Confirm action",
                                    subtitle = approval.summary,
                                )
                                if (ok) viewModel.respondApproval(approval.approvalId, decision)
                            }
                        },
                        selecting = state.selecting,
                        selected = item.id in state.selected,
                        onClick = { if (state.selecting) viewModel.toggleSelection(item.id) },
                        onLongClick = {
                            if (state.selecting) viewModel.toggleSelection(item.id)
                            else viewModel.startSelection(item.id)
                        },
                        onStreamReveal = viewModel::onStreamReveal,
                        onWidgetAction = { action ->
                            val open = action.get("open")?.asString
                            if (!open.isNullOrBlank() &&
                                (open.startsWith("http://") || open.startsWith("https://"))
                            ) {
                                runCatching {
                                    context.startActivity(
                                        android.content.Intent(
                                            android.content.Intent.ACTION_VIEW,
                                            android.net.Uri.parse(open),
                                        ),
                                    )
                                }
                            } else {
                                viewModel.onWidgetAction(action)
                            }
                        },
                    )
                }
                // Pulsing "typing" indicator while the brain works (no streamed text yet).
                if (state.busy) {
                    item(key = "typing") { TypingIndicator() }
                }
            }
          }

            // Bottom dock: the error banner, pending attachments and the input row
            // stay pinned just ABOVE the keyboard (imePadding) and clear of the
            // gesture/nav bar (navigationBarsPadding). The messages list above keeps
            // its place; opening the IME never relocates the input to the top.
            Column(Modifier.imePadding().navigationBarsPadding()) {
                state.error?.let { err ->
                    Surface(color = JarvisPalette.Error.copy(alpha = 0.15f), modifier = Modifier.fillMaxWidth()) {
                        Text(
                            err,
                            color = JarvisPalette.Error,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }

                if (state.pending.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        state.pending.forEach { img ->
                            Box {
                                AsyncImage(
                                    model = img.previewUri,
                                    contentDescription = null,
                                    modifier = Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)),
                                )
                                HapticIconButton(
                                    onClick = { viewModel.removeAttachment(img.previewUri) },
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
                        // Lazily fetch agents+skills the moment a "/" menu opens.
                        if (it.startsWith("/") && !it.contains(" ")) viewModel.loadSlashCatalog()
                    },
                    sending = state.sending,
                    busy = state.busy,
                    voicePhase = voicePhase,
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
                                if (img != null) {
                                    viewModel.attach(img)
                                } else {
                                    android.widget.Toast.makeText(
                                        context,
                                        "Couldn't read that clipboard image — try copying it again.",
                                        android.widget.Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        }
                    },
                    onSend = {
                        viewModel.send(draft)
                        draft = ""
                    },
                    onStop = { viewModel.cancel() },
                    onMicDown = {
                        if (!micGranted) {
                            requestMic.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            viewModel.startRecording()
                        }
                    },
                    onMicUp = {
                        viewModel.stopAndTranscribe { text ->
                            draft = if (draft.isBlank()) text else "$draft $text"
                        }
                    },
                    onMicCancel = { viewModel.cancelRecording() },
                    onStopSpeaking = { viewModel.stopSpeaking() },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatSelectionBar(
    count: Int,
    onClose: () -> Unit,
    onCopy: () -> Unit,
    onDelete: () -> Unit,
) {
    TopAppBar(
        title = { Text("$count selected") },
        navigationIcon = {
            HapticIconButton(onClick = onClose) {
                Icon(Icons.Filled.Close, contentDescription = "Cancel selection")
            }
        },
        actions = {
            HapticIconButton(onClick = onCopy) {
                Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = JarvisPalette.Accent)
            }
            HapticIconButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, contentDescription = "Delete", tint = JarvisPalette.Error)
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = JarvisPalette.SurfaceVariant,
            titleContentColor = JarvisPalette.TextPrimary,
        ),
    )
}

/** Concatenate the text of the currently-selected message bubbles, in order. */
private fun selectedText(state: ChatUiState): String =
    state.items
        .filter { it.id in state.selected }
        .joinToString("\n\n") { item ->
            when (item) {
                is ChatItem.Message -> item.text
                is ChatItem.Thinking -> item.text
                is ChatItem.Error -> item.message
                is ChatItem.Diff -> item.patch
                is ChatItem.ToolCall -> listOfNotNull(item.argsJson, item.output).joinToString("\n")
                is ChatItem.Approval -> item.summary
                is ChatItem.FileOffer -> item.name
                is ChatItem.Widget -> item.title
            }
        }

private fun copyToClipboard(context: Context, text: String) {
    if (text.isBlank()) return
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Orin chat", text))
}

@Composable
private fun InputRow(
    draft: String,
    onDraftChange: (String) -> Unit,
    sending: Boolean,
    busy: Boolean,
    voicePhase: com.jarvis.app.voice.VoiceController.Phase,
    slashAgents: List<com.jarvis.app.protocol.Agent>,
    slashSkills: List<com.jarvis.app.protocol.Skill>,
    onSlashPick: (String) -> Unit,
    onAttach: () -> Unit,
    onPasteImage: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicDown: () -> Unit,
    onMicUp: () -> Unit,
    onMicCancel: () -> Unit,
    onStopSpeaking: () -> Unit,
) {
    val recording = voicePhase == com.jarvis.app.voice.VoiceController.Phase.RECORDING
    val transcribing = voicePhase == com.jarvis.app.voice.VoiceController.Phase.TRANSCRIBING
    val speaking = voicePhase == com.jarvis.app.voice.VoiceController.Phase.SPEAKING

    Column(Modifier.fillMaxWidth()) {
        if (recording || transcribing || speaking) {
            val label = when {
                recording -> "Listening… release to send"
                transcribing -> "Transcribing via Voxtral…"
                else -> "Speaking…"
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.GraphicEq,
                    contentDescription = null,
                    tint = JarvisPalette.Accent,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(label, color = JarvisPalette.Accent, style = MaterialTheme.typography.bodySmall)
                if (speaking) {
                    Spacer(Modifier.width(8.dp))
                    HapticIconButton(onClick = onStopSpeaking, modifier = Modifier.size(22.dp)) {
                        Icon(Icons.Filled.VolumeOff, contentDescription = "Stop voice", tint = JarvisPalette.Error)
                    }
                }
            }
        }

        // "/" command palette — rises above the composer when typing a /command.
        SlashPalette(
            draft = draft,
            agents = slashAgents,
            skills = slashSkills,
            onPick = onSlashPick,
        )

        Row(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Tap = gallery picker; LONG-PRESS = paste an image from the
            // clipboard (jarvis#76 bonus). A plain Box, NOT IconButton: the
            // button's internal clickable consumed the tap before our gesture
            // detector could resolve it, so the picker never opened.
            val attach by rememberUpdatedState(onAttach)
            val pasteImg by rememberUpdatedState(onPasteImage)
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onTap = { attach() },
                            onLongPress = { pasteImg() },
                        )
                    }
                    // Raw pointerInput is invisible to TalkBack/keyboard focus —
                    // IconButton used to provide the button role + click actions,
                    // so re-establish them explicitly.
                    .semantics(mergeDescendants = true) {
                        role = Role.Button
                        onClick(label = "Attach photo") { attach(); true }
                        onLongClick(label = "Paste image from clipboard") { pasteImg(); true }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Image, contentDescription = "Attach photo (long-press: paste from clipboard)", tint = JarvisPalette.Accent)
            }
            // Push-to-talk: hold to record, release to transcribe + drop into the draft.
            val micUp by rememberUpdatedState(onMicUp)
            val micDown by rememberUpdatedState(onMicDown)
            val micCancel by rememberUpdatedState(onMicCancel)
            IconButton(
                onClick = {},
                modifier = Modifier.pointerInput(Unit) {
                    detectTapGestures(
                        onPress = {
                            micDown()
                            val released = tryAwaitRelease()
                            if (released) micUp() else micCancel()
                        },
                    )
                },
            ) {
                Icon(
                    Icons.Filled.Mic,
                    contentDescription = "Hold to talk",
                    tint = if (recording) JarvisPalette.Error else JarvisPalette.Accent,
                )
            }
            TextField(
                value = draft,
                onValueChange = onDraftChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message Orin…") },
                maxLines = 5,
                shape = RoundedCornerShape(14.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = JarvisPalette.Surface,
                    unfocusedContainerColor = JarvisPalette.Surface,
                    focusedIndicatorColor = JarvisPalette.Accent,
                    unfocusedIndicatorColor = JarvisPalette.Outline,
                ),
            )
            Spacer(Modifier.width(6.dp))
            // While a turn is in flight, the trailing button becomes a Stop control
            // (mid-turn cancel) so it's reachable without leaving the input row.
            if (busy) {
                HapticIconButton(onClick = onStop) {
                    Icon(
                        Icons.Filled.Stop,
                        contentDescription = "Stop",
                        tint = JarvisPalette.Error,
                    )
                }
            } else {
                HapticIconButton(
                    onClick = onSend,
                    enabled = !sending && draft.isNotBlank(),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (draft.isNotBlank()) JarvisPalette.Accent else JarvisPalette.TextSecondary,
                    )
                }
            }
        }
    }
}

// ---- animated empty state for a fresh chat --------------------------------
@androidx.compose.runtime.Composable
private fun ChatEmptyState(modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Column(
        modifier = modifier.padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        JarvisOrb(size = 132.dp)
        androidx.compose.foundation.layout.Spacer(Modifier.height(22.dp))
        Text(
            "HOW CAN I HELP?",
            color = JarvisPalette.Accent,
            fontSize = 17.sp,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            letterSpacing = 2.5.sp,
        )
        androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
        Text(
            "Ask anything, attach a photo, or have Orin use its computer.",
            color = JarvisPalette.TextSecondary,
            fontSize = 13.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}
