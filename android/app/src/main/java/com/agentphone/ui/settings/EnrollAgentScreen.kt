package com.agentphone.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.IconPill
import com.agentphone.ui.components.LabeledField
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.components.Stepper
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.state.EnrollmentPackage
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette
import kotlinx.coroutines.launch

private enum class Step { Define, Show }

@Composable
fun EnrollAgentScreen(vm: AppViewModel, onBack: () -> Unit) {
    var step by remember { mutableStateOf(Step.Define) }
    var name by remember { mutableStateOf("") }
    var agentId by remember { mutableStateOf("") }
    var extension by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pkg by remember { mutableStateOf<EnrollmentPackage?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        Header(step = step, onBack = onBack)
        AnimatedContent(
            targetState = step,
            transitionSpec = {
                val dir = if (targetState.ordinal > initialState.ordinal) 1 else -1
                (slideInHorizontally { it * dir } + fadeIn()) togetherWith
                    (slideOutHorizontally { -it * dir } + fadeOut())
            },
            label = "enroll-step",
            modifier = Modifier.weight(1f).fillMaxWidth()
        ) { current ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                when (current) {
                    Step.Define -> DefineForm(
                        name = name, onNameChange = { name = it },
                        agentId = agentId, onAgentIdChange = { agentId = it },
                        extension = extension, onExtensionChange = { extension = it },
                        command = command, onCommandChange = { command = it },
                        loading = loading,
                        error = error,
                        onGenerate = {
                            error = null
                            loading = true
                            scope.launch {
                                try {
                                    val result = vm.enrollAgent(
                                        name = name.trim(),
                                        agentIdOverride = agentId.trim().takeIf { it.isNotBlank() },
                                        extensionOverride = extension.trim().takeIf { it.isNotBlank() },
                                        command = command.trim().takeIf { it.isNotBlank() }
                                    )
                                    pkg = result
                                    step = Step.Show
                                } catch (e: Throwable) {
                                    error = e.message ?: "Enrollment failed"
                                } finally {
                                    loading = false
                                }
                            }
                        }
                    )
                    Step.Show -> ShowPackage(
                        pkg = pkg,
                        onCopyBootstrap = { copyToClipboard(ctx, "agent-phone-bootstrap", it) },
                        onCopyJson = { copyToClipboard(ctx, "agent-phone-config", it) },
                        onCopyMcp = { copyToClipboard(ctx, "agent-phone-mcp", it) },
                        onDone = onBack
                    )
                }
            }
        }
    }
}

@Composable
private fun Header(step: Step, onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconPill(icon = Icons.Rounded.ArrowBack, onClick = onBack)
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text("Add new agent", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
            Text(
                if (step == Step.Define) "Mint a token + extension for a remote agent."
                else "Paste this onto the agent VM.",
                style = MaterialTheme.typography.bodySmall,
                color = LocalSemanticColors.current.textMuted
            )
        }
        Stepper(totalSteps = 2, currentStep = step.ordinal, modifier = Modifier.width(56.dp))
    }
}

@Composable
private fun DefineForm(
    name: String, onNameChange: (String) -> Unit,
    agentId: String, onAgentIdChange: (String) -> Unit,
    extension: String, onExtensionChange: (String) -> Unit,
    command: String, onCommandChange: (String) -> Unit,
    loading: Boolean,
    error: String?,
    onGenerate: () -> Unit
) {
    val semantic = LocalSemanticColors.current
    GlassCard {
        LabeledField(
            label = "Name",
            value = name,
            onValueChange = onNameChange,
            placeholder = "Hermes VM"
        )
        Spacer(Modifier.height(12.dp))
        LabeledField(
            label = "Agent ID (optional)",
            value = agentId,
            onValueChange = onAgentIdChange,
            placeholder = "hermes-vm",
            mono = true,
            helper = "Defaults to a slug of the name."
        )
        Spacer(Modifier.height(12.dp))
        LabeledField(
            label = "Extension (optional)",
            value = extension,
            onValueChange = onExtensionChange,
            placeholder = "auto",
            mono = true,
            keyboardType = KeyboardType.Number,
            helper = "Server allocates the next free slot (105+) if blank."
        )
        Spacer(Modifier.height(12.dp))
        LabeledField(
            label = "Agent command (optional)",
            value = command,
            onValueChange = onCommandChange,
            placeholder = "claude --print",
            mono = true,
            helper = "If set, the connector runs this on the VM per turn."
        )
    }
    if (error != null) {
        GlassCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(32.dp).clip(CircleShape).background(semantic.danger.copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center
                ) {
                    androidx.compose.material3.Icon(Icons.Rounded.Warning, contentDescription = null, tint = semantic.danger)
                }
                Spacer(Modifier.width(12.dp))
                Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
    PressableButton(
        label = if (loading) "Generating…" else "Generate enrollment",
        onClick = onGenerate,
        enabled = !loading && name.isNotBlank(),
        loading = loading
    )
}

@Composable
private fun ShowPackage(
    pkg: EnrollmentPackage?,
    onCopyBootstrap: (String) -> Unit,
    onCopyJson: (String) -> Unit,
    onCopyMcp: (String) -> Unit,
    onDone: () -> Unit
) {
    val semantic = LocalSemanticColors.current
    if (pkg == null) {
        Text("No package", color = semantic.textMuted)
        return
    }
    var showJson by remember { mutableStateOf(false) }

    GlassCard {
        Text("Extension", style = MaterialTheme.typography.labelMedium, color = semantic.textMuted)
        Spacer(Modifier.height(2.dp))
        Text(
            pkg.extension,
            style = MaterialTheme.typography.displayLarge.copy(fontSize = androidx.compose.ui.unit.TextUnit(48f, androidx.compose.ui.unit.TextUnitType.Sp)),
            color = MaterialTheme.colorScheme.onSurface
        )
        Spacer(Modifier.height(6.dp))
        Text("${pkg.name} · agentId ${pkg.agentId}", style = MaterialTheme.typography.bodySmall, color = semantic.textMuted)
    }

    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier.size(28.dp).clip(CircleShape).background(Palette.Amber.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center
            ) {
                androidx.compose.material3.Icon(Icons.Rounded.Warning, contentDescription = null, tint = Palette.Amber, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Text(
                "This token is shown ONCE. Tap copy now — it's not recoverable.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }

    Section(title = "Run this on the agent VM") {
        MonoBlock(text = pkg.bootstrapCmd, onCopy = { onCopyBootstrap(pkg.bootstrapCmd) })
    }

    Section(title = "MCP config (paste into the agent's MCP client)") {
        MonoBlock(text = pkg.mcpConfigJson, onCopy = { onCopyMcp(pkg.mcpConfigJson) })
    }

    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Raw enrollment JSON",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f)
            )
            PressableButton(
                label = if (showJson) "Hide" else "Show",
                variant = ButtonVariant.Outline,
                onClick = { showJson = !showJson },
                fillWidth = false
            )
        }
        if (showJson) {
            Spacer(Modifier.height(10.dp))
            MonoBlock(text = pkg.fullJson, onCopy = { onCopyJson(pkg.fullJson) })
        }
    }

    PressableButton(label = "Done", onClick = onDone)
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = LocalSemanticColors.current.textMuted)
        content()
    }
}

@Composable
private fun MonoBlock(text: String, onCopy: () -> Unit) {
    val semantic = LocalSemanticColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp, semantic.hairline, RoundedCornerShape(12.dp))
            .padding(14.dp)
    ) {
        Text(text, style = LocalMonoTypography.current.small, color = MaterialTheme.colorScheme.onSurface)
        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) {
            IconPill(icon = Icons.Rounded.ContentCopy, onClick = onCopy)
        }
    }
}

private fun copyToClipboard(ctx: Context, label: String, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}
