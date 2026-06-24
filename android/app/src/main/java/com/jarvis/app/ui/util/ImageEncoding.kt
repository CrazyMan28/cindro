package com.jarvis.app.ui.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.jarvis.app.ui.chat.PendingImage
import java.io.ByteArrayOutputStream
import kotlin.math.max

/**
 * Reads a gallery/camera [Uri], downscales it to a reasonable long-edge, re-encodes as
 * JPEG, and base64s it for session.send `images:[{mime,b64}]`. Keeps payloads small so a
 * photo doesn't blow the WebSocket frame budget.
 */
object ImageEncoding {

    private const val MAX_EDGE = 1600
    private const val JPEG_QUALITY = 82

    // Returns null on ANY failure (unreadable Uri, decode the platform can't handle,
    // OOM, revoked permission) — never throws, so the picker callback can show a clean
    // "couldn't attach" message instead of the photo silently vanishing after "Done".
    // The old version let exceptions escape into the coroutine -> silent drop.
    fun encode(context: Context, uri: Uri): PendingImage? {
        return try {
            val resolver = context.contentResolver

            // First pass: bounds only, to compute a sample size.
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                ?: return null
            val longEdge = max(bounds.outWidth, bounds.outHeight)
            if (longEdge <= 0) return null

            var sample = 1
            while (longEdge / sample > MAX_EDGE * 2) sample *= 2

            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
                ?: return null

            val scaled = downscale(decoded, MAX_EDGE)
            if (scaled !== decoded) decoded.recycle()

            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            scaled.recycle()
            val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            PendingImage(mime = "image/jpeg", b64 = b64, previewUri = uri.toString())
        } catch (t: Throwable) {
            Log.w("ImageEncoding", "failed to encode picked image $uri", t)
            null
        }
    }

    private fun downscale(src: Bitmap, maxEdge: Int): Bitmap {
        val longEdge = max(src.width, src.height)
        if (longEdge <= maxEdge) return src
        val ratio = maxEdge.toFloat() / longEdge
        return Bitmap.createScaledBitmap(
            src,
            (src.width * ratio).toInt().coerceAtLeast(1),
            (src.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }
}
