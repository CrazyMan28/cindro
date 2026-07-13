package com.cindro.app.ui.phone

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.Biometric
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhonePermissionsScreen(
    viewModel: PhonePermissionsViewModel,
    activity: FragmentActivity,
    onOpenDrawer: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Phone Permissions") },
                navigationIcon = {
                    IconButton(onClick = onOpenDrawer) {
                        Icon(Icons.Filled.Menu, contentDescription = "Open menu")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::refresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
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
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "What Cindro may do over the phone. Deny blocks the action; Ask requires your approval first.",
                style = MaterialTheme.typography.bodySmall,
                color = JarvisPalette.TextSecondary,
            )
            state.error?.let {
                Text("Error: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            state.status?.let {
                Text(it, color = JarvisPalette.Accent, style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = {
                scope.launch {
                    // Editing phone guardrails is biometric-tier (mirrors policy.*
                    // + DeviceServer::tierFor): require a fresh BiometricPrompt so
                    // an already-unlocked app can't weaken permissions silently.
                    if (Biometric.authenticate(
                            activity,
                            title = "Reset phone permissions",
                            subtitle = "Restore the defaults",
                        )
                    ) {
                        viewModel.resetAll()
                    }
                }
            }) { Text("Reset to defaults") }

            state.capabilities.forEach { cap ->
                GlowCard(modifier = Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                cap.label,
                                style = MaterialTheme.typography.bodyMedium,
                                color = JarvisPalette.TextPrimary,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                if (cap.enforced) "ENFORCED" else "GUIDANCE",
                                style = MaterialTheme.typography.labelSmall,
                                color = if (cap.enforced) JarvisPalette.Accent else JarvisPalette.Warning,
                            )
                        }
                        if (cap.note.isNotEmpty()) {
                            Text(
                                cap.note,
                                style = MaterialTheme.typography.bodySmall,
                                color = JarvisPalette.TextSecondary,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            cap.choices.forEach { choice ->
                                FilterChip(
                                    selected = cap.value == choice,
                                    onClick = {
                                        if (cap.value != choice) {
                                            scope.launch {
                                                // Biometric-gate the guardrail change (see reset above).
                                                if (Biometric.authenticate(
                                                        activity,
                                                        title = "Change phone permission",
                                                        subtitle = "${cap.label}: ${cap.labelFor(choice)}",
                                                    )
                                                ) {
                                                    viewModel.setValue(cap.id, choice)
                                                }
                                            }
                                        }
                                    },
                                    label = { Text(cap.labelFor(choice)) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
