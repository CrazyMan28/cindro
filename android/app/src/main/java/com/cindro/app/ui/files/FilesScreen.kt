package com.cindro.app.ui.files

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cindro.app.JarvisApp
import com.cindro.app.files.ReceivedFile
import com.cindro.app.ui.theme.GlowCard
import com.cindro.app.ui.theme.JarvisPalette

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(app: JarvisApp) {
    val files by app.fileReceiver.files.collectAsStateWithLifecycle()
    val context = LocalContext.current

    fun openOrShare(file: ReceivedFile, share: Boolean) {
        val uri = app.fileReceiver.shareUri(file)
        val action = if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW
        val intent = Intent(action).apply {
            if (share) {
                type = file.mime ?: "*/*"
                putExtra(Intent.EXTRA_STREAM, uri)
            } else {
                setDataAndType(uri, file.mime ?: "*/*")
            }
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(Intent.createChooser(intent, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("Files") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (files.isEmpty()) {
                Text(
                    "No files yet. Cindro can push files here from the laptop.",
                    color = JarvisPalette.TextSecondary,
                    modifier = Modifier.align(Alignment.Center).padding(32.dp),
                )
            } else {
                LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(files, key = { it.localPath }) { file ->
                        FileRow(file, onOpen = { openOrShare(file, share = false) }, onShare = { openOrShare(file, share = true) })
                    }
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: ReceivedFile, onOpen: () -> Unit, onShare: () -> Unit) {
    GlowCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(file.name, color = JarvisPalette.TextPrimary, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), maxLines = 1)
                Spacer(Modifier.height(2.dp))
                Text(
                    "${file.mime ?: "file"} · ${file.sizeBytes / 1024} KB",
                    color = JarvisPalette.TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = onOpen) { Text("Open") }
            }
            IconButton(onClick = onShare) {
                Icon(Icons.Filled.Share, contentDescription = "Share", tint = JarvisPalette.Accent)
            }
        }
    }
}
