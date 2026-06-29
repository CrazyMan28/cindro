package com.agentphone.ui.setup

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.state.AlwaysOnDiagnostics
import com.agentphone.state.ConnectionTroubleshooter
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.LabeledField
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.components.Stepper
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Motion
import com.agentphone.ui.theme.Palette

private enum class Step { Server, Permissions, Connect, Done }

@Composable
fun SetupWizardScreen(vm: AppViewModel, onDone: () -> Unit) {
    val settings by vm.settings.collectAsState()
    val diagnostics by vm.diagnostics.collectAsState()
    var step by remember { mutableStateOf(Step.Server) }

    var server by remember { mutableStateOf(settings.serverUrl) }
    var token by remember { mutableStateOf(if (settings.token == "change-me-device-token") "" else settings.token) }
    var extension by remember { mutableStateOf(settings.extension) }

    val ctx = LocalContext.current
    var perms by remember { mutableStateOf(AgentPhonePreferences.loadDiagnostics(ctx)) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .padding(horizontal = 20.dp, vertical = 16.dp)
    ) {
        SetupHeader(step = step)
        Spacer(Modifier.height(24.dp))

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            AnimatedContent(
                targetState = step,
                transitionSpec = {
                    val forward = targetState.ordinal > initialState.ordinal
                    val dir = if (forward) 1 else -1
                    (slideInHorizontally(Motion.medium()) { it * dir } + fadeIn(Motion.medium())) togetherWith
                        (slideOutHorizontally(Motion.medium()) { -it * dir } + fadeOut(Motion.medium()))
                },
                label = "wizard-step"
            ) { current ->
                Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    when (current) {
                        Step.Server -> ServerStep(
                            server = server,
                            token = token,
                            extension = extension,
                            onServerChange = { server = it },
                            onTokenChange = { token = it },
                            onExtensionChange = { extension = it }
                        )
                        Step.Permissions -> PermissionsStep(
                            diagnostics = perms,
                            onRecheck = { perms = AgentPhonePreferences.loadDiagnostics(ctx) }
                        )
                        Step.Connect -> ConnectStep(
                            vm = vm,
                            onRun = {
                                vm.updateSettings(serverUrl = server, token = token, extension = extension)
                                vm.runDiagnostics()
                                vm.connect()
                            }
                        )
                        Step.Done -> DoneStep(onContinue = onDone)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Footer(
            step = step,
            canAdvance = canAdvance(step, server, token, extension, perms, diagnostics),
            onBack = { step = previous(step) },
            onNext = {
                when (step) {
                    Step.Server -> {
                        vm.updateSettings(serverUrl = server, token = token, extension = extension)
                        step = Step.Permissions
                    }
                    Step.Permissions -> {
                        perms = AgentPhonePreferences.loadDiagnostics(ctx)
                        step = Step.Connect
                    }
                    Step.Connect -> step = Step.Done
                    Step.Done -> onDone()
                }
            }
        )
    }
}

private fun canAdvance(
    step: Step,
    server: String,
    token: String,
    extension: String,
    perms: AlwaysOnDiagnostics,
    diagnostics: com.agentphone.state.DiagnosticsState
): Boolean = when (step) {
    Step.Server -> ConnectionTroubleshooter.warningForUrl(server) == null && token.isNotBlank() && extension.isNotBlank()
    Step.Permissions -> perms.notificationPermissionGranted
    Step.Connect -> diagnostics.healthOk == true && diagnostics.websocketOk == true
    Step.Done -> true
}

private fun previous(step: Step): Step = when (step) {
    Step.Permissions -> Step.Server
    Step.Connect -> Step.Permissions
    Step.Done -> Step.Connect
    Step.Server -> Step.Server
}

@Composable
private fun SetupHeader(step: Step) {
    val total = Step.values().size - 1
    val index = step.ordinal.coerceAtMost(total - 1)
    Column {
        Text(
            "Set up Agent Phone",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground
        )
        Spacer(Modifier.height(6.dp))
        Text(
            when (step) {
                Step.Server -> "Tell the app where to find the server."
                Step.Permissions -> "Grant the permissions needed to receive calls."
                Step.Connect -> "Verify the connection end to end."
                Step.Done -> "You're ready to receive calls."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = LocalSemanticColors.current.textMuted
        )
        Spacer(Modifier.height(20.dp))
        Stepper(totalSteps = total, currentStep = index)
    }
}

@Composable
private fun ServerStep(
    server: String,
    token: String,
    extension: String,
    onServerChange: (String) -> Unit,
    onTokenChange: (String) -> Unit,
    onExtensionChange: (String) -> Unit
) {
    val warning = ConnectionTroubleshooter.warningForUrl(server)
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        GlassCard {
            Text(
                "Server",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(14.dp))
            LabeledField(
                label = "Server URL",
                value = server,
                onValueChange = onServerChange,
                placeholder = "http://100.x.x.x:8799",
                mono = true,
                helper = "WebSocket: ${runCatching { com.agentphone.state.AgentPhoneSettings(serverUrl = server).websocketUrl() }.getOrDefault("")}",
                error = warning
            )
        }
        GlassCard {
            Text(
                "Identity",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(14.dp))
            LabeledField(
                label = "Extension",
                value = extension,
                onValueChange = onExtensionChange,
                placeholder = "100",
                mono = true,
                keyboardType = KeyboardType.Number
            )
            Spacer(Modifier.height(14.dp))
            LabeledField(
                label = "Device Token",
                value = token,
                onValueChange = onTokenChange,
                placeholder = "your DEVICE_TOKEN",
                mono = true,
                password = true,
                helper = "From the server .env file"
            )
        }
    }
}

@Composable
private fun PermissionsStep(diagnostics: AlwaysOnDiagnostics, onRecheck: () -> Unit) {
    val ctx = LocalContext.current
    val notifLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { onRecheck() }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PermissionRow(
            label = "Notifications",
            description = "Required for incoming-call alerts",
            granted = diagnostics.notificationPermissionGranted,
            action = {
                if (Build.VERSION.SDK_INT >= 33) notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        )
        PermissionRow(
            label = "Full-screen calls",
            description = "Wake the screen for incoming calls",
            granted = diagnostics.fullScreenPermissionGranted,
            action = {
                if (Build.VERSION.SDK_INT >= 34) {
                    ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${ctx.packageName}")))
                }
                onRecheck()
            }
        )
        PermissionRow(
            label = "Ignore battery saver",
            description = "Keep the receiver alive in background",
            granted = diagnostics.batteryOptimizationIgnored,
            action = {
                val pm = ctx.getSystemService(PowerManager::class.java)
                if (pm?.isIgnoringBatteryOptimizations(ctx.packageName) != true) {
                    ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
                }
                onRecheck()
            }
        )
        Spacer(Modifier.height(4.dp))
        PressableButton(
            label = "Re-check permissions",
            variant = ButtonVariant.Outline,
            onClick = onRecheck
        )
    }
}

@Composable
private fun PermissionRow(label: String, description: String, granted: Boolean, action: () -> Unit) {
    val semantic = LocalSemanticColors.current
    GlassCard(contentPadding = PaddingValues(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(
                        if (granted) semantic.success.copy(alpha = 0.18f)
                        else semantic.warning.copy(alpha = 0.18f)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (granted) Icons.Rounded.Check else Icons.Rounded.ChevronRight,
                    contentDescription = null,
                    tint = if (granted) semantic.success else semantic.warning
                )
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                Text(description, style = MaterialTheme.typography.bodySmall, color = semantic.textMuted)
            }
            if (!granted) {
                PressableButton(
                    label = "Grant",
                    variant = ButtonVariant.Tonal,
                    onClick = action,
                    fillWidth = false
                )
            }
        }
    }
}

@Composable
private fun ConnectStep(vm: AppViewModel, onRun: () -> Unit) {
    val diag by vm.diagnostics.collectAsState()
    val phone by vm.phone.collectAsState()
    LaunchedEffect(Unit) { onRun() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CheckRow("Server health", diag.healthOk)
        CheckRow("Auth token", diag.authOk)
        CheckRow("Extension 100 exists", diag.extensionExists)
        CheckRow("Agents reachable", diag.agentsOk)
        CheckRow("WebSocket", diag.websocketOk)
        Spacer(Modifier.height(8.dp))
        AnimatedVisibility(
            visible = diag.lastError != null,
            enter = fadeIn(Motion.medium()),
            exit = fadeOut(Motion.fast())
        ) {
            GlassCard {
                Text(
                    diag.lastError ?: "",
                    style = MaterialTheme.typography.bodyMedium,
                    color = LocalSemanticColors.current.danger
                )
                if (diag.suggestedFix != null && diag.suggestedFix != diag.lastError) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        diag.suggestedFix ?: "",
                        style = MaterialTheme.typography.bodySmall,
                        color = LocalSemanticColors.current.textMuted
                    )
                }
            }
        }
        PressableButton(
            label = "Run again",
            variant = ButtonVariant.Outline,
            onClick = onRun
        )
    }
}

@Composable
private fun CheckRow(label: String, value: Boolean?) {
    val semantic = LocalSemanticColors.current
    val (icon, tint, status) = when (value) {
        true -> Triple(Icons.Rounded.Check, semantic.success, "OK")
        false -> Triple(Icons.Rounded.ChevronRight, semantic.danger, "FAILED")
        null -> Triple(Icons.Rounded.ChevronRight, semantic.textMuted, "TESTING…")
    }
    GlassCard(contentPadding = PaddingValues(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(tint.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text(label, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
            Text(status, style = MaterialTheme.typography.labelSmall, color = tint)
        }
    }
}

@Composable
private fun DoneStep(onContinue: () -> Unit) {
    val semantic = LocalSemanticColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(top = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(semantic.success.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Rounded.Check, contentDescription = null, tint = semantic.success, modifier = Modifier.size(48.dp))
        }
        Spacer(Modifier.height(24.dp))
        Text("All set.", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your phone is registered. Lock the screen and let an agent call you.",
            style = MaterialTheme.typography.bodyMedium,
            color = semantic.textMuted
        )
        Spacer(Modifier.height(24.dp))
        PressableButton(label = "Continue", onClick = onContinue, fillWidth = false)
    }
}

@Composable
private fun Footer(step: Step, canAdvance: Boolean, onBack: () -> Unit, onNext: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (step != Step.Server && step != Step.Done) {
            PressableButton(
                label = "Back",
                variant = ButtonVariant.Outline,
                onClick = onBack,
                modifier = Modifier.weight(1f)
            )
        }
        if (step != Step.Done) {
            PressableButton(
                label = if (step == Step.Connect) "Continue" else "Next",
                onClick = onNext,
                enabled = canAdvance,
                modifier = Modifier.weight(if (step == Step.Server) 1f else 2f)
            )
        }
    }
}
