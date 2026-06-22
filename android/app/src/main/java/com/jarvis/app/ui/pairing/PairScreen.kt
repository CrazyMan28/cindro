package com.jarvis.app.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
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
fun PairScreen(viewModel: PairingViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    PairScreenContent(
        state = state,
        onHostPortChange = viewModel::onHostPortChanged,
        onScanQr = viewModel::scanQr,
        onConnect = viewModel::connect,
    )
}

@Composable
private fun PairScreenContent(
    state: PairUiState,
    onHostPortChange: (String) -> Unit,
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

        Spacer(Modifier.height(28.dp))

        Text(
            text = stringResourceCompat(R.string.pair_title),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResourceCompat(R.string.pair_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(36.dp))

        OutlinedTextField(
            value = state.hostPort,
            onValueChange = onHostPortChange,
            singleLine = true,
            label = { Text(stringResourceCompat(R.string.pair_host_label)) },
            placeholder = { Text(stringResourceCompat(R.string.pair_host_hint)) },
            isError = state.status == PairStatus.ERROR,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(20.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onScanQr,
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResourceCompat(R.string.pair_scan_qr))
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
                Text(stringResourceCompat(R.string.pair_connect))
            }
        }

        state.message?.let { msg ->
            Spacer(Modifier.height(20.dp))
            Text(
                text = msg,
                style = MaterialTheme.typography.bodySmall,
                color = if (state.status == PairStatus.ERROR) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.primary
                },
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.weight(1f))

        Text(
            text = stringResourceCompat(R.string.pair_help),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Small reticle-styled brand mark at the top of the screen. */
@Composable
private fun ReticleBadge(icon: ImageVector = Icons.Filled.Link) {
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(72.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(34.dp),
            )
        }
    }
}

/**
 * Tiny indirection so the @Preview below can run without a real Context. In production this
 * just delegates to the platform string resource lookup.
 */
@Composable
private fun stringResourceCompat(id: Int): String =
    androidx.compose.ui.res.stringResource(id)

@Preview(showBackground = true, backgroundColor = 0xFF0A0E14)
@Composable
private fun PairScreenPreview() {
    JarvisTheme {
        Surface(color = JarvisPalette.Background) {
            PairScreenContent(
                state = PairUiState(hostPort = PairingStore.DEFAULT_HOST_PORT),
                onHostPortChange = {},
                onScanQr = {},
                onConnect = {},
            )
        }
    }
}
