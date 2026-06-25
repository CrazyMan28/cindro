package com.jarvis.app.ui.chat

import android.content.ContentValues
import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.jarvis.app.ui.util.HapticIconButton
import com.jarvis.app.ui.theme.JarvisPalette
import java.io.OutputStream

/**
 * Fullscreen, pinch-to-zoom viewer for an image the chat received as base64. Tapping
 * a chat image opens this; the user can zoom/pan, save it to Downloads, or dismiss.
 */
@Composable
fun ImageViewerDialog(b64: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val bitmap = remember(b64) {
        runCatching {
            val raw = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(raw, 0, raw.size)?.asImageBitmap()
        }.getOrNull()
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.96f)),
            contentAlignment = Alignment.Center,
        ) {
            if (bitmap != null) {
                var scale by remember { mutableFloatStateOf(1f) }
                var offset by remember { mutableStateOf(Offset.Zero) }
                Image(
                    bitmap = bitmap,
                    contentDescription = "image",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer(
                            scaleX = scale, scaleY = scale,
                            translationX = offset.x, translationY = offset.y,
                        )
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 6f)
                                offset = if (scale <= 1f) Offset.Zero else offset + pan
                            }
                        },
                )
            }

            // Save + close controls (top-right).
            androidx.compose.foundation.layout.Row(
                modifier = Modifier.align(Alignment.TopEnd).padding(10.dp),
            ) {
                HapticIconButton(onClick = {
                    val ok = saveImageToDownloads(context, b64)
                    Toast.makeText(
                        context,
                        if (ok) "Saved to Downloads" else "Couldn't save image",
                        Toast.LENGTH_SHORT,
                    ).show()
                }) {
                    Icon(Icons.Filled.Download, contentDescription = "Save", tint = JarvisPalette.Accent)
                }
                HapticIconButton(onClick = onDismiss) {
                    Icon(Icons.Filled.Close, contentDescription = "Close", tint = JarvisPalette.TextPrimary)
                }
            }
        }
    }
}

/**
 * Write a base64 image to the device's public Downloads folder. Uses MediaStore on
 * API 29+ (no permission needed); falls back to the legacy Downloads path below that.
 * Returns false on any failure.
 */
fun saveImageToDownloads(context: Context, b64: String): Boolean {
    return runCatching {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        val name = "jarvis_${System.currentTimeMillis()}.png"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "image/png")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return false
            resolver.openOutputStream(uri)?.use { out: OutputStream -> out.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } else {
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            dir.mkdirs()
            java.io.File(dir, name).outputStream().use { it.write(bytes) }
            true
        }
    }.getOrDefault(false)
}
