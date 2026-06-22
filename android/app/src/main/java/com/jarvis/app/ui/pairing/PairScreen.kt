package com.jarvis.app.ui.pairing

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarvis.app.R
import com.jarvis.app.data.PairingStore
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.JarvisTheme

@Composable
fun PairScreen(viewModel: PairingViewModel, onPaired: () -> Unit) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val paired by viewModel.paired.collectAsStateWithLifecycle()
    var scanning by remember { mutableStateOf(false) }

    androidx.compose.runtime.LaunchedEffect(paired) { if (paired) onPaired() }

    if (scanning) {
        QrScanSheet(
            onResult = { value ->
                scanning = false
                viewModel.onQrScanned(value)
            },
            onPermissionDenied = { scanning = false },
            onCancel = { scanning = false },
        )
        return
    }

    PairScreenContent(
        state = state,
        onHostPortChange = viewModel::onHostPortChanged,
        onCodeChange = viewModel::onCodeChanged,
        onNameChange = viewModel::onDeviceNameChanged,
        onScanQr = { scanning = true },
        onConnect = viewModel::connect,
    )
}

@Composable
private fun PairScreenContent(
    state: PairUiState,
    onHostPortChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onNameChange: (String) -> Unit,
    onScanQr: () -> Unit,
    onConnect: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 28.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ReticleBadge()

        Spacer(Modifier.height(24.dp))

        Text(
            text = stringResource(R.string.pair_title),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.pair_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = state.hostPort,
            onValueChange = onHostPortChange,
            singleLine = true,
            label = { Text(stringResource(R.string.pair_host_label)) },
            placeholder = { Text(stringResource(R.string.pair_host_hint)) },
            isError = state.status == PairStatus.ERROR,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = state.code,
            onValueChange = onCodeChange,
            singleLine = true,
            label = { Text(stringResource(R.string.pair_code_label)) },
            placeholder = { Text("123456") },
            isError = state.status == PairStatus.ERROR,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = state.deviceName,
            onValueChange = onNameChange,
            singleLine = true,
            label = { Text(stringResource(R.string.pair_name_label)) },
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(20.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(onClick = onScanQr, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.pair_scan_qr))
            }

            Button(
                onClick = onConnect,
                enabled = state.canConnect,
                modifier = Modifier.weight(1f),
            ) {
                if (state.status == PairStatus.CONNECTING) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(Icons.Filled.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.pair_connect))
            }
        }

        AnimatedVisibility(visible = state.message != null) {
            Column {
                Spacer(Modifier.height(18.dp))
                Text(
                    text = state.message.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = when (state.status) {
                        PairStatus.ERROR -> MaterialTheme.colorScheme.error
                        PairStatus.PAIRED -> JarvisPalette.Success
                        else -> MaterialTheme.colorScheme.primary
                    },
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun ReticleBadge(icon: ImageVector = Icons.Filled.Link) {
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(72.dp),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(34.dp),
            )
        }
    }
}

/** Full-bleed camera scanner overlay with a reticle frame and cancel control. */
@Composable
private fun QrScanSheet(
    onResult: (String) -> Unit,
    onPermissionDenied: () -> Unit,
    onCancel: () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        QrScanner(
            modifier = Modifier.fillMaxSize(),
            onResult = onResult,
            onPermissionDenied = onPermissionDenied,
        )
        // Reticle frame
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(240.dp)
                .clip(RoundedCornerShape(20.dp)),
        )
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "Point at the Jarvis pairing QR",
                color = JarvisPalette.TextPrimary,
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedButton(onClick = onCancel) {
                Text(stringResource(R.string.pair_cancel))
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0A0E14)
@Composable
private fun PairScreenPreview() {
    JarvisTheme {
        Surface(color = JarvisPalette.Background) {
            PairScreenContent(
                state = PairUiState(
                    hostPort = PairingStore.DEFAULT_HOST_PORT,
                    code = "428913",
                    deviceName = "Pixel 9",
                ),
                onHostPortChange = {},
                onCodeChange = {},
                onNameChange = {},
                onScanQr = {},
                onConnect = {},
            )
        }
    }
}
