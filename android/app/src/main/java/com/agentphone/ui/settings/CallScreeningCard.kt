package com.agentphone.ui.settings

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import androidx.compose.ui.unit.dp

/** The Twilio number screened calls are forwarded to. */
private const val AGENT_NUMBER = "+18449040251"

/** Verizon uses its own *7x codes (not GSM **SC*), with a 10-digit number, no #. */
private const val AGENT_NUMBER_10 = "8449040251"

/**
 * One-time setup for AI call screening of NATIVE calls:
 * 1. Grant the call-screening role (lets the app see incoming numbers and offer the popup).
 * 2. Grant ANSWER_PHONE_CALLS (lets the popup's button decline the ringing call).
 * 3. Set carrier conditional call forwarding to the agent number (replaces voicemail).
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
fun CallScreeningCard(vm: AppViewModel) {
    val context = LocalContext.current
    val semantic = LocalSemanticColors.current

    // Master switch + which agent answers forwarded calls.
    var screeningOn by remember { mutableStateOf<Boolean?>(null) }
    var toggling by remember { mutableStateOf(false) }
    var inboundExt by remember { mutableStateOf("") }
    var screeningExt by remember { mutableStateOf("") }
    var agents by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    // Transport: "twilio" (carrier-forwarded, anywhere) or "relay" (Bluetooth puck).
    var transport by remember { mutableStateOf("twilio") }
    LaunchedEffect(Unit) {
        vm.getScreeningConfig { cfg ->
            if (cfg != null) {
                screeningOn = cfg.enabled
                inboundExt = cfg.inboundExtension
                screeningExt = cfg.screeningExtension
                agents = cfg.agents
                transport = cfg.transport
            }
        }
    }

    fun hasRole(): Boolean {
        if (Build.VERSION.SDK_INT < 29) return false
        val roleManager = context.getSystemService(RoleManager::class.java) ?: return false
        return roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }

    fun hasAnswerPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED

    fun hasBluetoothPermission(): Boolean =
        Build.VERSION.SDK_INT < 31 ||
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    var roleHeld by remember { mutableStateOf(hasRole()) }
    var answerGranted by remember { mutableStateOf(hasAnswerPermission()) }
    var bluetoothGranted by remember { mutableStateOf(hasBluetoothPermission()) }

    val roleLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        roleHeld = hasRole()
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        answerGranted = hasAnswerPermission()
    }
    val bluetoothLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        bluetoothGranted = hasBluetoothPermission()
    }

    GlassCard {
        // Transport selector — how a screened call reaches your agent.
        Text("Transport", style = MaterialTheme.typography.titleSmall)
        Text(
            "How a screened call reaches your agent.",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            PressableButton(
                label = "Twilio (anywhere)",
                variant = if (transport == "twilio") ButtonVariant.Primary else ButtonVariant.Outline,
                onClick = {
                    if (transport != "twilio") {
                        val prev = transport
                        transport = "twilio"
                        vm.setScreeningTransport("twilio") { ok -> if (!ok) transport = prev }
                    }
                },
                modifier = Modifier.weight(1f)
            )
            PressableButton(
                label = "Bluetooth relay (M507)",
                variant = if (transport == "relay") ButtonVariant.Primary else ButtonVariant.Outline,
                onClick = {
                    if (transport != "relay") {
                        val prev = transport
                        transport = "relay"
                        vm.setScreeningTransport("relay") { ok -> if (!ok) transport = prev }
                    }
                },
                modifier = Modifier.weight(1f)
            )
        }
        Spacer(Modifier.height(14.dp))
        // The on/off master switch — auto-screen declined / unanswered calls.
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Auto-screen calls", style = MaterialTheme.typography.titleMedium)
                Text(
                    when (screeningOn) {
                        true -> "ON — your agent answers calls you decline or don't pick up."
                        false -> "OFF — calls are not screened."
                        else -> "…"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted
                )
            }
            Switch(
                checked = screeningOn == true,
                enabled = screeningOn != null && !toggling,
                onCheckedChange = { want ->
                    toggling = true
                    vm.setScreeningEnabled(want) { now ->
                        screeningOn = now ?: screeningOn
                        toggling = false
                    }
                }
            )
        }
        Spacer(Modifier.height(14.dp))
        Text(
            "When a call comes in you can answer it normally. If you decline it (or miss it), it goes " +
                "to your agent — you watch the live transcript and can take over anytime.",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )

        // Two SEPARATE choices so picking a screener never changes who takes YOUR calls.
        if (agents.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            Text("Who answers when YOU call in", style = MaterialTheme.typography.titleSmall)
            Text(
                "When you dial your own number, this agent picks up (e.g. Codex). Independent of screening.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                agents.forEach { (ext, name) ->
                    val selected = ext == inboundExt
                    PressableButton(
                        label = name,
                        variant = if (selected) ButtonVariant.Primary else ButtonVariant.Outline,
                        onClick = {
                            val prev = inboundExt
                            inboundExt = ext
                            vm.setInboundAgent(ext) { ok -> if (!ok) inboundExt = prev }
                        }
                    )
                }
            }

            Spacer(Modifier.height(14.dp))
            Text("Who screens unknown callers", style = MaterialTheme.typography.titleSmall)
            Text(
                "Mistral Screener is a fast, tool-free brain made for screening. Your other agents have full tools.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                agents.forEach { (ext, name) ->
                    val selected = ext == screeningExt
                    PressableButton(
                        label = name,
                        variant = if (selected) ButtonVariant.Primary else ButtonVariant.Outline,
                        onClick = {
                            val prev = screeningExt
                            screeningExt = ext
                            vm.setScreeningAgent(ext) { ok -> if (!ok) screeningExt = prev }
                        }
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        StatusRow("Screening role", roleHeld)
        StatusRow("Decline permission", answerGranted)
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PressableButton(
                label = if (roleHeld) "Role granted" else "Grant role",
                onClick = {
                    if (Build.VERSION.SDK_INT >= 29 && !roleHeld) {
                        context.getSystemService(RoleManager::class.java)
                            ?.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
                            ?.let { roleLauncher.launch(it) }
                    }
                },
                variant = if (roleHeld) ButtonVariant.Outline else ButtonVariant.Primary,
                modifier = Modifier.weight(1f)
            )
            PressableButton(
                label = if (answerGranted) "Decline OK" else "Allow decline",
                onClick = { if (!answerGranted) permissionLauncher.launch(Manifest.permission.ANSWER_PHONE_CALLS) },
                variant = if (answerGranted) ButtonVariant.Outline else ButtonVariant.Primary,
                modifier = Modifier.weight(1f)
            )
        }
        if (transport == "relay") {
            // Bluetooth relay: the agent rides on the paired M507 puck — no carrier
            // forwarding, but we need BLUETOOTH_CONNECT to route the call's audio.
            Spacer(Modifier.height(14.dp))
            Text(
                "Carry the M507 relay puck (paired over Bluetooth). When you let your agent answer, " +
                    "the call is auto-answered and its audio is routed to the puck — no carrier forwarding.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(12.dp))
            StatusRow("Bluetooth permission", bluetoothGranted)
            Spacer(Modifier.height(12.dp))
            PressableButton(
                label = if (bluetoothGranted) "Bluetooth OK" else "Allow Bluetooth",
                onClick = {
                    if (!bluetoothGranted && Build.VERSION.SDK_INT >= 31) {
                        bluetoothLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
                    }
                },
                variant = if (bluetoothGranted) ButtonVariant.Outline else ButtonVariant.Primary,
                modifier = Modifier.fillMaxWidth()
            )
        } else {
            // Twilio transport: one-time carrier conditional call forwarding.
            Spacer(Modifier.height(14.dp))
            Text(
                "Carrier forwarding (one-time): sends declined/missed calls to the agent instead of " +
                    "voicemail. Tap a code to open the dialer pre-filled, then press call. Needs cellular " +
                    "service (won't work on Wi-Fi only). Undo with ##002#.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(12.dp))
            // Carrier-specific, step-by-step. Verizon (and Verizon MVNOs / "5G UW")
            // REJECT the GSM ** codes below — lead those users straight to the *7x
            // codes so they don't hit "invalid MMI code".
            Text(
                "📱 Verizon / \"5G UW\" — the ** buttons below DON'T work on Verizon. Do THIS instead:",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "Open your normal Phone dialer, type the code, and press call:\n" +
                    "1.  *71$AGENT_NUMBER_10  — forwards calls you MISS or DECLINE to your agent (it still rings you first). You'll hear a confirmation tone. RECOMMENDED.\n" +
                    "2.  *72$AGENT_NUMBER_10  — forwards EVERY call straight to your agent.\n" +
                    "3.  *73  — turns forwarding OFF.\n" +
                    "4.  *#21#  — check what's currently set.\n" +
                    "(You can also just tap the \"VZ busy/no-ans\" button further down — it pre-fills *71$AGENT_NUMBER_10 for you. You do NOT need forwarding to talk to your agent — you can always just call $AGENT_NUMBER directly.)",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onBackground
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Other carriers (T-Mobile, etc.) — use the GSM ** codes below:",
                style = MaterialTheme.typography.titleSmall
            )
            Spacer(Modifier.height(8.dp))
            // **SC*number# is the GSM REGISTER form (double asterisk). The single-
            // asterisk *SC* form is "activate" and rejects a number → "invalid MMI".
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                PressableButton(
                    label = "Set all forwarding",
                    onClick = { context.openDialerWithCode("**004*$AGENT_NUMBER#") },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "Check (*#002#)",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("*#002#") },
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "If \"Set all\" is rejected, set them individually (busy = a declined call):",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                PressableButton(
                    label = "When busy",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("**67*$AGENT_NUMBER#") },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "No answer",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("**61*$AGENT_NUMBER#") },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "Unreachable",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("**62*$AGENT_NUMBER#") },
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(Modifier.height(14.dp))
            Text(
                "Verizon: the codes above don't work — use Verizon's own. Try \"Busy/no-answer\" " +
                    "first (rings you, rolls to the agent if you decline or miss it). \"All\" sends every " +
                    "call straight to the agent. Press call after each; no extra screen confirms it.",
                style = MaterialTheme.typography.bodySmall,
                color = semantic.textMuted
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                PressableButton(
                    label = "VZ busy/no-ans",
                    onClick = { context.openDialerWithCode("*71$AGENT_NUMBER_10") },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "VZ all (*72)",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("*72$AGENT_NUMBER_10") },
                    modifier = Modifier.weight(1f)
                )
                PressableButton(
                    label = "VZ off (*73)",
                    variant = ButtonVariant.Outline,
                    onClick = { context.openDialerWithCode("*73") },
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun StatusRow(label: String, ok: Boolean) {
    val semantic = LocalSemanticColors.current
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(
            if (ok) "ON" else "OFF",
            style = MaterialTheme.typography.bodyMedium,
            color = if (ok) MaterialTheme.colorScheme.primary else semantic.textMuted
        )
    }
}

private fun android.content.Context.openDialerWithCode(code: String) {
    // USSD codes can't be auto-executed; pre-fill the dialer and let the user press call.
    runCatching {
        startActivity(
            Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(code)}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
