package com.cindro.app.ui.chat

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.Biometric
import com.cindro.app.ui.util.HapticButton
import com.cindro.app.ui.util.HapticIconButton
import com.cindro.app.ui.util.HapticOutlinedButton
import com.cindro.app.ui.util.ImageEncoding
import com.cindro.app.ui.util.JarvisOrb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Mirrors LazyColumn's own built-in `animateItem()` default placement spring —
 *  used explicitly (not the parameterless default) so it can be swapped for
 *  `null` per-item while a bubble is still streaming (see the message list). */
private val DefaultBubblePlacementSpec: FiniteAnimationSpec<IntOffset> =
    spring(stiffness = Spring.StiffnessMediumLow)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    activity: FragmentActivity,
    onOpenDrawer: () -> Unit,
    autoStartVoice: Boolean = false,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val voicePhase by viewModel.voicePhase.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var draft by remember { mutableStateOf("") }
    var showModelInfo by remember { mutableStateOf(false) }
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
    ) { granted ->
        micGranted = granted
        // If this permission prompt was triggered by the auto-voice entry below
        // (not the manual mic button), finish that flow once granted.
        if (granted && autoStartVoice) viewModel.startRecording()
    }

    // "Hey Cindro" wake deep-link / the New Chat screen's Voice suggestion chip:
    // start a push-to-talk capture on entry. Used to silently do nothing when mic
    // permission had never been granted (a fresh install) — now requests it, same
    // as the manual mic button already does, instead of looking like a dead button.
    LaunchedEffect(autoStartVoice) {
        if (!autoStartVoice) return@LaunchedEffect
        if (micGranted) viewModel.startRecording() else requestMic.launch(Manifest.permission.RECORD_AUDIO)
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
                    title = {},
                    navigationIcon = {
                        HapticIconButton(onClick = onOpenDrawer) {
                            Icon(Icons.Filled.Menu, contentDescription = "Open menu")
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
                    // Each new bubble fades + slides in as it's added (and animates
                    // out of the way on delete) instead of just popping into place.
                    // A streaming assistant bubble's height keeps growing every
                    // ~20ms via ChatBubble's own typewriter reveal — animating ITS
                    // placement too would have the list-item spring fighting that
                    // growth for the whole reveal, so placement animation is
                    // skipped until the bubble finishes (fade in/out still apply).
                    val streaming = item is ChatItem.Message && item.streaming
                    Box(
                        Modifier.animateItem(
                            placementSpec = if (streaming) null else DefaultBubblePlacementSpec,
                        ),
                    ) {
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
                }
                // Pulsing "typing" indicator while the brain works (no streamed text yet).
                if (state.busy) {
                    item(key = "typing") { TypingIndicator(Modifier.animateItem()) }
                }
            }
          }

            // Bottom dock: the model chip, error banner, pending attachments and
            // the input row stay pinned just ABOVE the keyboard (imePadding) and
            // clear of the gesture/nav bar (navigationBarsPadding). The messages
            // list above keeps its place; opening the IME never relocates the
            // input to the top. The model chip lives HERE (part of the chat bar,
            // ChatGPT-style) rather than the top app bar.
            Column(Modifier.imePadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                    ChatModelChip(
                        brain = state.brain,
                        model = state.model,
                        onClick = { showModelInfo = true },
                    )
                }
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
                    hasAttachment = state.pending.isNotEmpty(),
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

    // Brain/model are fixed for a chat's whole lifetime (no daemon RPC to switch
    // them mid-session) — this is an info card, not a picker. Start a New chat
    // from the sidebar to pick a different one.
    if (showModelInfo) {
        AlertDialog(
            onDismissRequest = { showModelInfo = false },
            containerColor = JarvisPalette.Surface,
            title = { Text("This chat's brain", color = JarvisPalette.TextPrimary) },
            text = {
                Column {
                    Text(
                        (state.brain?.replaceFirstChar(Char::uppercase) ?: "Cindro default") +
                            (state.model?.let { "  ·  $it" } ?: ""),
                        color = JarvisPalette.Accent,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Brain and model are fixed for a chat's lifetime. Start a New chat from " +
                            "the sidebar to pick a different one.",
                        color = JarvisPalette.TextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            },
            confirmButton = { TextButton(onClick = { showModelInfo = false }) { Text("Got it") } },
        )
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

/** A compact "brain · model" pill that lives in the chat bar (bottom, above the
 *  composer), echoing ChatGPT's model selector chip — not the top app bar.
 *  Shared by [ChatScreen] (read-only there; tapping shows an info card since a
 *  live session's brain/model can't be switched) and [NewChatScreen] (a real
 *  picker there, since brain/model is still choosable before the first send). */
@Composable
fun ChatModelChip(brain: String?, model: String?, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = JarvisPalette.SurfaceVariant,
        border = BorderStroke(1.dp, JarvisPalette.Outline),
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                brain?.replaceFirstChar(Char::uppercase) ?: "Cindro",
                style = MaterialTheme.typography.titleSmall,
                color = JarvisPalette.TextPrimary,
                maxLines = 1,
            )
            if (!model.isNullOrBlank()) {
                Text(
                    "  ·  $model",
                    style = MaterialTheme.typography.bodySmall,
                    color = JarvisPalette.TextSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 140.dp),
                )
            }
            Spacer(Modifier.width(2.dp))
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = JarvisPalette.TextSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
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
    cm.setPrimaryClip(ClipData.newPlainText("Cindro chat", text))
}

@Composable
fun InputRow(
    draft: String,
    onDraftChange: (String) -> Unit,
    sending: Boolean,
    busy: Boolean,
    // Whether a photo is already attached — a picture-only message (no typed
    // text) is valid and must still be sendable, not just gated on draft text.
    hasAttachment: Boolean = false,
    voicePhase: com.cindro.app.voice.VoiceController.Phase,
    slashAgents: List<com.cindro.app.protocol.Agent>,
    slashSkills: List<com.cindro.app.protocol.Skill>,
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
    val recording = voicePhase == com.cindro.app.voice.VoiceController.Phase.RECORDING
    val transcribing = voicePhase == com.cindro.app.voice.VoiceController.Phase.TRANSCRIBING
    val speaking = voicePhase == com.cindro.app.voice.VoiceController.Phase.SPEAKING

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
                placeholder = { Text("Message Cindro…") },
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
                    enabled = !sending && (draft.isNotBlank() || hasAttachment),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (draft.isNotBlank() || hasAttachment) JarvisPalette.Accent else JarvisPalette.TextSecondary,
                    )
                }
            }
        }
    }
}

// ---- animated empty state for a fresh chat --------------------------------
/**
 * Shared between an existing session with no messages yet and [NewChatScreen]'s
 * blank landing composer, so both read as the same "Cindro" moment. Fades +
 * slides up on first appearance (same [androidx.compose.animation.core.Animatable]
 * idiom used for the old Home header) instead of just popping in.
 */
@Composable
fun ChatEmptyState(modifier: Modifier = Modifier, subtitle: String = DEFAULT_EMPTY_SUBTITLE) {
    val appear = remember { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(Unit) {
        appear.animateTo(1f, androidx.compose.animation.core.tween(420))
    }
    androidx.compose.foundation.layout.Column(
        modifier = modifier
            .padding(32.dp)
            .graphicsLayer {
                alpha = appear.value
                translationY = (1f - appear.value) * 18f
            },
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
            subtitle,
            color = JarvisPalette.TextSecondary,
            fontSize = 13.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

private const val DEFAULT_EMPTY_SUBTITLE = "Ask anything, attach a photo, or have Cindro use its computer."
