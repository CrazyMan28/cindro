package com.cindro.app.ui.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.util.Log
import com.cindro.app.ui.chat.PendingImage
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
            // Decode robustly: ImageDecoder (API 28+) handles HEIC/HEIF/WebP/etc. that
            // BitmapFactory chokes on — which is the usual cause of "Couldn't attach
            // that photo" on modern phones (camera shots are often HEIC). Force a
            // SOFTWARE bitmap so the later JPEG compress() can't fail on a HARDWARE one.
            // Fall back to BitmapFactory on older devices or if ImageDecoder refuses.
            val decoded = decodeRobust(context, uri) ?: return null

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

    private fun decodeRobust(context: Context, uri: Uri): Bitmap? {
        val resolver = context.contentResolver
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                val src = ImageDecoder.createSource(resolver, uri)
                return ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    decoder.isMutableRequired = false
                    // Downsample at decode time so a 50MP HEIC doesn't OOM.
                    val longEdge = max(info.size.width, info.size.height)
                    if (longEdge > MAX_EDGE) {
                        val ratio = MAX_EDGE.toFloat() / longEdge
                        decoder.setTargetSize(
                            (info.size.width * ratio).toInt().coerceAtLeast(1),
                            (info.size.height * ratio).toInt().coerceAtLeast(1),
                        )
                    }
                }
            } catch (t: Throwable) {
                Log.w("ImageEncoding", "ImageDecoder failed, falling back to BitmapFactory", t)
            }
        }
        // Legacy / fallback path.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        val longEdge = max(bounds.outWidth, bounds.outHeight)
        if (longEdge <= 0) return null
        var sample = 1
        while (longEdge / sample > MAX_EDGE * 2) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
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
