package com.jarvis.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.ui.ConnectionPill
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onUnpaired: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val conn by viewModel.connection.collectAsStateWithLifecycle()
    val lastError by viewModel.lastError.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Connection
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Daemon", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                        ConnectionPill(conn)
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(state.hostPort, color = JarvisPalette.Accent, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace))
                    lastError?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, color = JarvisPalette.Error, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(onClick = viewModel::reconnect) {
                        Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.height(16.dp))
                        Text("  Reconnect")
                    }
                }
            }

            // Device identity
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text("This device", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = state.deviceName,
                        onValueChange = viewModel::setDeviceName,
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    Text("Key fingerprint", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                    Text(state.deviceFingerprint, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    state.daemonFingerprint?.let {
                        Spacer(Modifier.height(8.dp))
                        Text("Daemon fingerprint", style = MaterialTheme.typography.labelLarge, color = JarvisPalette.TextSecondary)
                        Text(it, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    }
                }
            }

            // Notifications
            GlowCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Notifications", style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                        Text(
                            "Push when an approval is needed, a task finishes, or a file is ready.",
                            style = MaterialTheme.typography.bodySmall,
                            color = JarvisPalette.TextSecondary,
                        )
                    }
                    Switch(
                        checked = state.notificationsEnabled,
                        onCheckedChange = viewModel::setNotificationsEnabled,
                    )
                }
            }

            // Unpair
            Button(
                onClick = { viewModel.unpair(onUnpaired) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = JarvisPalette.Error.copy(alpha = 0.18f),
                    contentColor = JarvisPalette.Error,
                ),
            ) { Text("Unpair this device") }
        }
    }
}
