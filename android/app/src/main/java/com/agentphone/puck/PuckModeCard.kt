package com.agentphone.puck

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.agentphone.state.AgentPhonePreferences
import com.agentphone.ui.components.ButtonVariant
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.LabeledField
import com.agentphone.ui.components.PressableButton
import com.agentphone.ui.theme.LocalSemanticColors

/**
 * Settings card for Relay PUCK mode.
 *
 * This is shown in the normal app; turning the master toggle ON makes THIS device
 * act as the Bluetooth relay puck (start [RelayPuckService]). OFF restores the
 * exact prior behavior — nothing puck-related runs.
 *
 * The capture-source and inject-stream pickers exist so the live spike can pick
 * what actually works for the far-end caller audio without a rebuild. The "Run
 * audio probe" button sweeps every candidate source and logs the RMS so the right
 * source is obvious. All values persist in [AgentPhonePreferences].
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
fun PuckModeCard() {
    val context = LocalContext.current
    val semantic = LocalSemanticColors.current

    var puckOn by remember { mutableStateOf(AgentPhonePreferences.isPuckModeEnabled(context)) }
    var mac by remember { mutableStateOf(AgentPhonePreferences.pairedPhoneMac(context)) }
    var captureSource by remember { mutableStateOf(AgentPhonePreferences.captureSource(context)) }
    var injectStream by remember { mutableStateOf(AgentPhonePreferences.injectStream(context)) }
    var statusLine by remember { mutableStateOf(AgentPhonePreferences.puckStatus(context)) }

    fun hasBluetoothPermission(): Boolean =
        Build.VERSION.SDK_INT < 31 ||
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    var bluetoothGranted by remember { mutableStateOf(hasBluetoothPermission()) }
    val bluetoothLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        bluetoothGranted = hasBluetoothPermission()
    }

    GlassCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Relay puck mode", style = MaterialTheme.typography.titleMedium)
                Text(
                    if (puckOn)
                        "ON — this device is the Bluetooth relay between the phone and the agent."
                    else
                        "OFF — this device behaves as the normal phone app.",
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted
                )
            }
            Switch(
                checked = puckOn,
                onCheckedChange = { want ->
                    puckOn = want
                    AgentPhonePreferences.setPuckMode(context, want)
                    if (want) {
                        if (!bluetoothGranted && Build.VERSION.SDK_INT >= 31) {
                            bluetoothLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
                        }
                        RelayPuckService.start(context)
                    } else {
                        RelayPuckService.stop(context)
                    }
                    statusLine = AgentPhonePreferences.puckStatus(context)
                }
            )
        }

        Spacer(Modifier.height(14.dp))
        // AUTO-DETECT the paired phone. Bonded Bluetooth devices that are phones are
        // listed; with one paired phone (normal case) the puck picks it automatically
        // and no MAC entry is needed. The manual field below is just an override.
        val bondedPhones = remember(bluetoothGranted, puckOn) {
            runCatching {
                val mgr = context.getSystemService(android.bluetooth.BluetoothManager::class.java)
                mgr?.adapter?.bondedDevices
                    ?.filter { runCatching { it.bluetoothClass?.majorDeviceClass == android.bluetooth.BluetoothClass.Device.Major.PHONE }.getOrDefault(false) }
                    ?.map { (runCatching { it.name }.getOrNull()?.ifBlank { null } ?: it.address) to it.address }
                    ?: emptyList()
            }.getOrDefault(emptyList())
        }
        Text("Paired phone", style = MaterialTheme.typography.titleSmall)
        Text(
            when {
                mac.isNotBlank() -> "Pinned: $mac"
                bondedPhones.size == 1 -> "Auto-detected: ${bondedPhones[0].first}"
                bondedPhones.size > 1 -> "Multiple phones paired — tap one to pin it."
                else -> "No paired phone yet — pair the S25 over Bluetooth (Settings), then it appears here."
            },
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
        if (bondedPhones.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                bondedPhones.forEach { (name, addr) ->
                    PressableButton(
                        label = name,
                        variant = if (mac == addr) ButtonVariant.Primary else ButtonVariant.Outline,
                        onClick = { mac = addr; AgentPhonePreferences.setPairedPhoneMac(context, addr) }
                    )
                }
                PressableButton(
                    label = "Auto",
                    variant = if (mac.isBlank()) ButtonVariant.Primary else ButtonVariant.Outline,
                    onClick = { mac = ""; AgentPhonePreferences.setPairedPhoneMac(context, "") }
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        LabeledField(
            label = "Override MAC (optional)",
            value = mac,
            onValueChange = { mac = it; AgentPhonePreferences.setPairedPhoneMac(context, it) },
            placeholder = "blank = auto-detect",
            mono = true,
            helper = "Leave blank to auto-detect the paired phone."
        )

        Spacer(Modifier.height(16.dp))
        Text("Capture source (caller voice)", style = MaterialTheme.typography.titleSmall)
        Text(
            "Which mic input carries the far-end caller over SCO. Default VOICE_COMMUNICATION " +
                "needs no special permission.",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CAPTURE_SOURCES.forEach { (label, value) ->
                PressableButton(
                    label = label,
                    variant = if (captureSource == value) ButtonVariant.Primary else ButtonVariant.Outline,
                    fillWidth = false,
                    onClick = {
                        captureSource = value
                        AgentPhonePreferences.setCaptureSource(context, value)
                    }
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Inject stream (agent TTS)", style = MaterialTheme.typography.titleSmall)
        Text(
            "Which output stream plays the agent's voice into the call uplink.",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            INJECT_STREAMS.forEach { (label, value) ->
                PressableButton(
                    label = label,
                    variant = if (injectStream == value) ButtonVariant.Primary else ButtonVariant.Outline,
                    fillWidth = false,
                    onClick = {
                        injectStream = value
                        AgentPhonePreferences.setInjectStream(context, value)
                    }
                )
            }
        }

        Spacer(Modifier.height(16.dp))
        PressableButton(
            label = "Run audio probe (during a call)",
            variant = ButtonVariant.Outline,
            onClick = {
                RelayPuckService.runProbe(context)
                statusLine = AgentPhonePreferences.puckStatus(context)
            },
            modifier = Modifier.fillMaxWidth()
        )
        Text(
            "Sweeps every candidate source for ~8s and logs which one has real signal " +
                "(check the status line or logcat tag RelayPuck).",
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )

        Spacer(Modifier.height(14.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Status", style = MaterialTheme.typography.bodyMedium)
            PressableButton(
                label = "Refresh",
                variant = ButtonVariant.Ghost,
                fillWidth = false,
                onClick = { statusLine = AgentPhonePreferences.puckStatus(context) }
            )
        }
        Text(
            statusLine,
            style = MaterialTheme.typography.bodySmall,
            color = semantic.textMuted
        )
        if (puckOn && !bluetoothGranted) {
            Spacer(Modifier.height(10.dp))
            PressableButton(
                label = "Allow Bluetooth",
                onClick = {
                    if (Build.VERSION.SDK_INT >= 31) bluetoothLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
                },
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

// Use the literal AudioManager.STREAM_* / MediaRecorder.AudioSource.* values so
// the spike picker maps 1:1 onto what the service stores in preferences.
private val CAPTURE_SOURCES: List<Pair<String, Int>> = listOf(
    "VOICE_COMMUNICATION" to MediaRecorder.AudioSource.VOICE_COMMUNICATION,
    "VOICE_CALL" to MediaRecorder.AudioSource.VOICE_CALL,
    "VOICE_DOWNLINK" to MediaRecorder.AudioSource.VOICE_DOWNLINK,
    "MIC" to MediaRecorder.AudioSource.MIC
)

private val INJECT_STREAMS: List<Pair<String, Int>> = listOf(
    "VOICE_CALL" to AudioManager.STREAM_VOICE_CALL,
    "MUSIC" to AudioManager.STREAM_MUSIC
)
