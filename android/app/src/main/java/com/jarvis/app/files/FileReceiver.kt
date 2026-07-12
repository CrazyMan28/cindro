package com.jarvis.app.files

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import com.jarvis.app.net.JarvisRepository
import com.jarvis.app.protocol.FileOffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/** A file the daemon pushed (file.offer), materialised on the phone for open/share. */
data class ReceivedFile(
    val id: String,
    val name: String,
    val mime: String?,
    val sizeBytes: Long,
    val localPath: String,
)

/**
 * Process-wide sink for `file.offer` Contract C events. Inline-b64 offers are written
 * straight to cacheDir/downloads; the [files] flow drives the Files screen + an
 * FCM-style local notification, and [shareUri] hands a FileProvider URI to other apps.
 */
class FileReceiver(
    private val context: Context,
    private val repo: JarvisRepository,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _files = MutableStateFlow<List<ReceivedFile>>(emptyList())
    val files: StateFlow<List<ReceivedFile>> = _files

    private val dir: File by lazy {
        File(context.cacheDir, "downloads").apply { mkdirs() }
    }

    fun start() {
        scope.launch {
            repo.fileOffers.collect { offer -> store(offer) }
        }
        // Surface anything already on disk from a previous run.
        loadExisting()
    }

    private fun loadExisting() {
        val existing = dir.listFiles()?.map {
            ReceivedFile(it.name, it.name, guessMime(it.name), it.length(), it.absolutePath)
        } ?: emptyList()
        if (existing.isNotEmpty()) _files.update { (existing + it).distinctBy { f -> f.localPath } }
    }

    private fun store(offer: FileOffer) {
        val b64 = offer.b64 ?: return // non-inline transfers handled by the transfer path
        val bytes = runCatching { Base64.decode(b64, Base64.NO_WRAP) }.getOrNull() ?: return
        var safe = offer.name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "file_${offer.id}" }
        // "." / ".." survive the char-class sanitizer untouched and resolve to the
        // downloads dir itself / its parent — reject them so the write below can
        // never escape cacheDir/downloads.
        if (safe == "." || safe == "..") safe = "file_${offer.id}"
        // A write failure (e.g. the "." / ".." case throwing, or disk-full) must
        // log/no-op rather than propagate out of this collect{} — an uncaught
        // exception here would kill the coroutine and stop ALL future file offers
        // for the rest of the process's life.
        runCatching {
            val out = File(dir, safe)
            out.writeBytes(bytes)
            val rf = ReceivedFile(
                id = offer.id.ifBlank { safe },
                name = offer.name,
                mime = offer.mime ?: guessMime(offer.name),
                sizeBytes = bytes.size.toLong(),
                localPath = out.absolutePath,
            )
            _files.update { listOf(rf) + it.filterNot { f -> f.localPath == rf.localPath } }
        }.onFailure { e ->
            Log.w(TAG, "failed to store file offer ${offer.id} (${offer.name})", e)
        }
    }

    /** A content:// URI other apps can read (open/share). */
    fun shareUri(file: ReceivedFile) =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", File(file.localPath))

    private fun guessMime(name: String): String = when {
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        name.endsWith(".pdf", true) -> "application/pdf"
        name.endsWith(".txt", true) || name.endsWith(".md", true) -> "text/plain"
        name.endsWith(".json", true) -> "application/json"
        name.endsWith(".zip", true) -> "application/zip"
        else -> "application/octet-stream"
    }

    companion object {
        private const val TAG = "FileReceiver"
    }
}
