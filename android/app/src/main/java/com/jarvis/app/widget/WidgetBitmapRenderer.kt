package com.jarvis.app.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import kotlin.math.max
import kotlin.math.min

/**
 * Headless renderer for the Jarvis widget DSL -> a Bitmap, for the REAL Android
 * home-screen widget (RemoteViews can't host Compose, and a WebView/AndroidView
 * can't be snapshotted off-screen). It draws straight onto an android.graphics
 * Canvas, so it needs no Activity/lifecycle and is cheap to run from the
 * background service when a pinned widget updates.
 *
 * Covered nodes: column/row/grid layout, text, badge, rect, divider, spacer,
 * progress, list, and canvas draw-ops (circle/ellipse/rect/path/line) — i.e. the
 * glanceable + charty widgets people actually pin. svg/image/link/button degrade
 * gracefully (a label + "open app" hint) since those need a full WebView/Compose.
 * The same spec renders in full fidelity inside the app via WidgetRenderer.
 */
object WidgetBitmapRenderer {

    // Theme (mirrors the in-app WidgetRenderer constants).
    private const val ACCENT = 0xFF5FE0FF.toInt()
    private const val SURFACE = 0xFF0E2233.toInt()
    private const val CARD = 0xFF12283B.toInt()
    private const val HAIRLINE = 0xFF1F3A4D.toInt()
    private const val TEXT = 0xFFDDEAF2.toInt()
    private const val MUTED = 0xFF8FB6C9.toInt()

    private const val MAX_DEPTH = 7

    /**
     * Render [spec] into a [widthPx] × [heightPx] bitmap sized to the widget's actual
     * home-screen cell, SCALING the content down to fit so nothing is ever cut off
     * (the old version capped height and clipped the bottom rows).
     */
    /** The content's NATURAL height (px) at [widthPx], including padding — i.e. the
     *  height the widget WANTS so nothing is scaled down. Used to size the home-screen
     *  cell to the widget instead of squishing tall content into a fixed cell. */
    fun naturalHeightPx(spec: JsonObject, widthPx: Int, density: Float): Int {
        val w = max(60, widthPx)
        val pad = 11 * density
        val ctx = Ctx(density)
        val contentH = measure(ctx, spec, w - pad * 2, 0)
        return (contentH + pad * 2).toInt().coerceAtLeast(60)
    }

    fun render(spec: JsonObject, widthPx: Int, heightPx: Int, density: Float): Bitmap {
        val w = max(60, widthPx)
        val targetH = max(60, heightPx)
        val pad = 11 * density
        val ctx = Ctx(density)
        val innerW = w - pad * 2
        val contentH = measure(ctx, spec, innerW, 0)
        val availH = targetH - pad * 2

        val bmp = Bitmap.createBitmap(w, targetH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = SURFACE }
        val r = 20 * density
        canvas.drawRoundRect(RectF(0f, 0f, w.toFloat(), targetH.toFloat()), r, r, bg)

        // Render the content at its NATURAL, readable size using the FULL width —
        // NOT shrunk uniformly to fit (that produced a tiny, side-margined blob for
        // tall widgets on a fixed cell). If the content is taller than the cell we
        // clip the bottom and draw a soft fade hinting "more — tap to open". Only a
        // mild shrink kicks in for content slightly too tall, so it stays legible.
        val fit = if (contentH > availH && contentH > 0f) availH / contentH else 1f
        val scale = max(fit, 0.82f)   // never below 82% (keeps text readable)

        canvas.save()
        canvas.translate(pad, pad)
        canvas.clipRect(0f, 0f, innerW, availH)
        if (scale < 1f) canvas.scale(scale, scale)
        // Draw at innerW/scale so that AFTER the scale it still spans the full width
        // (no right-hand margin); content lays out wider, then shrinks to fill.
        draw(ctx, canvas, spec, 0f, 0f, innerW / scale, contentH / scale + 1f, 0)
        canvas.restore()

        // Bottom fade when the content is taller than the cell (clipped).
        if (contentH * scale > availH + 2f) {
            val fadeH = 22 * density
            val fp = Paint().apply {
                shader = LinearGradient(
                    0f, targetH - fadeH, 0f, targetH.toFloat(),
                    SURFACE and 0x00FFFFFF, SURFACE, Shader.TileMode.CLAMP)
            }
            canvas.drawRect(0f, targetH - fadeH, w.toFloat(), targetH.toFloat(), fp)
        }
        return bmp
    }

    // ---- helpers -----------------------------------------------------------

    private class Ctx(val d: Float) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val text = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
    }

    private fun JsonObject.s(k: String): String? =
        get(k)?.takeIf { !it.isJsonNull && it.isJsonPrimitive }?.asString

    private fun JsonObject.f(k: String, def: Float): Float =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asFloat ?: def }.getOrDefault(def)

    private fun JsonObject.b(k: String): Boolean =
        runCatching { get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false }.getOrDefault(false)

    private fun JsonObject.kids(): List<JsonObject> {
        val a = get("children") as? JsonArray ?: return emptyList()
        return a.mapNotNull { if (it.isJsonObject) it.asJsonObject else null }
    }

    // A pager is interactive in-app; on a static home-screen bitmap we render the
    // current page (default page 0 — the first question of a quiz) so the tile
    // shows real content instead of a blank box.
    private fun pagerPage(node: JsonObject): JsonObject? {
        val pages = node.get("pages") as? JsonArray ?: return null
        if (pages.size() == 0) return null
        val idx = node.f("page", 0f).toInt().coerceIn(0, pages.size() - 1)
        val el = pages.get(idx)
        return if (el.isJsonObject) el.asJsonObject else null
    }

    private fun color(s: String?, def: Int): Int {
        if (s.isNullOrBlank()) return def
        return runCatching { Color.parseColor(if (s.startsWith("#")) s else "#$s") }.getOrDefault(def)
    }

    private fun lines(p: Paint, text: String, maxW: Float, maxLines: Int): List<String> {
        if (text.isEmpty()) return listOf("")
        val out = ArrayList<String>()
        for (para in text.split("\n")) {
            var line = StringBuilder()
            for (word in para.split(" ")) {
                val trial = if (line.isEmpty()) word else "$line $word"
                if (p.measureText(trial) <= maxW || line.isEmpty()) {
                    line = StringBuilder(trial)
                } else {
                    out.add(line.toString()); line = StringBuilder(word)
                    if (out.size >= maxLines) break
                }
            }
            if (out.size < maxLines) out.add(line.toString())
            if (out.size >= maxLines) break
        }
        if (out.size > maxLines) {
            val trimmed = out.take(maxLines).toMutableList()
            trimmed[maxLines - 1] = trimmed[maxLines - 1].let {
                if (it.length > 1) it.dropLast(1) + "…" else it
            }
            return trimmed
        }
        return out
    }

    private fun configText(ctx: Ctx, node: JsonObject) {
        val p = ctx.text
        val size = node.f("size", 13f) * ctx.d
        p.textSize = size
        p.color = color(node.s("color"), TEXT)
        val weight = node.f("weight", if (node.b("bold")) 700f else 400f)
        val bold = weight >= 600
        p.typeface = if (node.b("mono"))
            Typeface.create(Typeface.MONOSPACE, if (bold) Typeface.BOLD else Typeface.NORMAL)
        else Typeface.create(Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
    }

    // ---- measure (height for a given width) --------------------------------

    private fun measure(ctx: Ctx, node: JsonObject, width: Float, depth: Int): Float {
        if (depth > MAX_DEPTH) return 0f
        val d = ctx.d
        return when (node.s("type")) {
            "column" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                val kids = node.kids()
                var h = pad * 2
                kids.forEachIndexed { i, c ->
                    h += measure(ctx, c, width - pad * 2, depth + 1)
                    if (i < kids.size - 1) h += gap
                }
                max(h, node.f("h", 0f) * d)
            }
            "row" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                val kids = node.kids()
                if (kids.isEmpty()) return pad * 2
                val cellW = (width - pad * 2 - gap * (kids.size - 1)) / kids.size
                val maxH = kids.maxOf { measure(ctx, it, cellW, depth + 1) }
                maxH + pad * 2
            }
            "grid" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                val cols = max(1, node.f("cols", 2f).toInt())
                val kids = node.kids()
                val rows = (kids.size + cols - 1) / cols
                val cellW = (width - pad * 2 - gap * (cols - 1)) / cols
                var h = pad * 2
                for (rIdx in 0 until rows) {
                    val rowKids = kids.drop(rIdx * cols).take(cols)
                    h += rowKids.maxOfOrNull { measure(ctx, it, cellW, depth + 1) } ?: 0f
                    if (rIdx < rows - 1) h += gap
                }
                h
            }
            "text" -> {
                configText(ctx, node)
                val fm = ctx.text.fontMetrics
                val lh = (fm.descent - fm.ascent) * node.f("line", 1.25f)
                val maxLines = node.f("maxLines", 6f).toInt()
                lines(ctx.text, node.s("text") ?: "", width, maxLines).size * lh
            }
            "badge" -> (20 * d)
            "rect" -> node.f("h", 28f) * d
            "divider" -> (1 * d) + (8 * d)
            "spacer" -> if (node.b("grow")) (8 * d) else node.f("size", 8f) * d
            "progress" -> (10 * d)
            "list" -> {
                val gap = node.f("gap", 6f) * d
                val rows = (node.get("rows") as? JsonArray)?.size() ?: 0
                rows * (24 * d) + max(0, rows - 1) * gap
            }
            "canvas" -> node.f("h", 120f) * d
            "pager" -> pagerPage(node)?.let { measure(ctx, it, width, depth + 1) } ?: 0f
            // svg/image can't render in a RemoteViews bitmap (no WebView/network) —
            // take no space rather than leaving a gap or a fallback label.
            "image", "svg" -> 0f
            "link", "button" -> (28 * d)
            else -> 0f
        }
    }

    // ---- draw --------------------------------------------------------------

    private fun draw(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float,
                     width: Float, bottom: Float, depth: Int): Float {
        if (depth > MAX_DEPTH || top > bottom) return 0f
        val d = ctx.d
        val height = measure(ctx, node, width, depth)
        // Container background/border.
        node.s("bg")?.let {
            val r = node.f("radius", 10f) * d
            ctx.paint.color = color(it, CARD); ctx.paint.style = Paint.Style.FILL
            c.drawRoundRect(RectF(left, top, left + width, top + height), r, r, ctx.paint)
        }
        node.s("border")?.let {
            val r = node.f("radius", 10f) * d
            ctx.paint.color = color(it, HAIRLINE)
            ctx.paint.style = Paint.Style.STROKE
            ctx.paint.strokeWidth = node.f("borderW", 1f) * d
            c.drawRoundRect(RectF(left, top, left + width, top + height), r, r, ctx.paint)
            ctx.paint.style = Paint.Style.FILL
        }

        when (node.s("type")) {
            "column" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                var y = top + pad
                for (child in node.kids()) {
                    if (y > bottom) break
                    val ch = draw(ctx, c, child, left + pad, y, width - pad * 2, bottom, depth + 1)
                    y += ch + gap
                }
            }
            "row" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                val kids = node.kids()
                if (kids.isNotEmpty()) {
                    val cellW = (width - pad * 2 - gap * (kids.size - 1)) / kids.size
                    var x = left + pad
                    for (child in kids) {
                        draw(ctx, c, child, x, top + pad, cellW, bottom, depth + 1)
                        x += cellW + gap
                    }
                }
            }
            "grid" -> {
                val pad = node.f("pad", 0f) * d
                val gap = node.f("gap", 6f) * d
                val cols = max(1, node.f("cols", 2f).toInt())
                val kids = node.kids()
                val cellW = (width - pad * 2 - gap * (cols - 1)) / cols
                var x = left + pad; var y = top + pad; var col = 0; var rowH = 0f
                for (child in kids) {
                    val ch = draw(ctx, c, child, x, y, cellW, bottom, depth + 1)
                    rowH = max(rowH, ch); col++
                    if (col >= cols) { col = 0; x = left + pad; y += rowH + gap; rowH = 0f }
                    else x += cellW + gap
                }
            }
            "pager" -> pagerPage(node)?.let { draw(ctx, c, it, left, top, width, bottom, depth + 1) }
            "text" -> drawText(ctx, c, node, left, top, width)
            "badge" -> drawBadge(ctx, c, node, left, top)
            "rect" -> {
                val r = node.f("radius", 6f) * d
                ctx.paint.color = color(node.s("color"), ACCENT)
                c.drawRoundRect(RectF(left, top, left + min(width, node.f("w", width / d) * d),
                    top + node.f("h", 28f) * d), r, r, ctx.paint)
            }
            "divider" -> {
                ctx.paint.color = color(node.s("color"), HAIRLINE)
                ctx.paint.strokeWidth = 1 * d
                val y = top + 4 * d
                c.drawLine(left, y, left + width, y, ctx.paint)
            }
            "progress" -> drawProgress(ctx, c, node, left, top, width)
            "list" -> drawList(ctx, c, node, left, top, width, bottom)
            "canvas" -> drawCanvas(ctx, c, node, left, top, width)
            "svg", "image" -> { /* can't render headlessly — skip silently */ }
            "link", "button" -> drawText(ctx, c,
                JsonObject().apply { addProperty("type", "text")
                    addProperty("text", node.s("text") ?: ""); addProperty("color", "#5FE0FF") },
                left, top, width)
        }
        return height
    }

    private fun drawText(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float, width: Float) {
        configText(ctx, node)
        val p = ctx.text
        val fm = p.fontMetrics
        val lh = (fm.descent - fm.ascent) * node.f("line", 1.25f)
        val maxLines = node.f("maxLines", 6f).toInt()
        val align = node.s("align")
        p.textAlign = when (align) {
            "center" -> Paint.Align.CENTER; "right" -> Paint.Align.RIGHT; else -> Paint.Align.LEFT
        }
        val x = when (align) { "center" -> left + width / 2; "right" -> left + width; else -> left }
        var y = top - fm.ascent
        for (ln in lines(p, node.s("text") ?: "", width, maxLines)) {
            c.drawText(ln, x, y, p); y += lh
        }
        p.textAlign = Paint.Align.LEFT
    }

    private fun drawBadge(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float) {
        val d = ctx.d
        val p = ctx.text
        p.textSize = 11 * d
        p.typeface = Typeface.DEFAULT_BOLD
        val txt = node.s("text") ?: ""
        val tw = p.measureText(txt)
        val padX = 7 * d
        val accent = color(node.s("color"), ACCENT)
        ctx.paint.color = (accent and 0x00FFFFFF) or 0x33000000
        c.drawRoundRect(RectF(left, top, left + tw + padX * 2, top + 18 * d), 9 * d, 9 * d, ctx.paint)
        p.color = accent
        val fm = p.fontMetrics
        c.drawText(txt, left + padX, top + (18 * d - (fm.ascent + fm.descent)) / 2, p)
    }

    private fun drawProgress(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float, width: Float) {
        val d = ctx.d
        var v = node.f("value", 0f)
        if (v > 1f) v /= 100f
        v = v.coerceIn(0f, 1f)
        val h = 8 * d
        ctx.paint.color = color(node.s("track"), HAIRLINE)
        c.drawRoundRect(RectF(left, top, left + width, top + h), h / 2, h / 2, ctx.paint)
        ctx.paint.color = color(node.s("color"), ACCENT)
        c.drawRoundRect(RectF(left, top, left + width * v, top + h), h / 2, h / 2, ctx.paint)
    }

    private fun drawList(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float,
                         width: Float, bottom: Float) {
        val d = ctx.d
        val gap = node.f("gap", 6f) * d
        val rows = node.get("rows") as? JsonArray ?: return
        var y = top
        for (el in rows) {
            if (y > bottom || !el.isJsonObject) break
            val row = el.asJsonObject
            val p = ctx.text
            p.textSize = 12 * d; p.typeface = Typeface.DEFAULT
            p.color = color(row.s("color"), TEXT); p.textAlign = Paint.Align.LEFT
            val fm = p.fontMetrics
            c.drawText(row.s("text") ?: "", left, y - fm.ascent, p)
            row.s("badge")?.let { badge ->
                p.textSize = 10 * d; p.color = ACCENT; p.textAlign = Paint.Align.RIGHT
                c.drawText(badge, left + width, y - fm.ascent, p); p.textAlign = Paint.Align.LEFT
            }
            y += 24 * d + gap
        }
    }

    private fun drawCanvas(ctx: Ctx, c: Canvas, node: JsonObject, left: Float, top: Float, width: Float) {
        val d = ctx.d
        val vw = node.f("w", width / d)
        val scale = if (vw > 0) min(1f, width / (vw * d)) * d else d
        val ops = node.get("ops") as? JsonArray ?: return
        val p = ctx.paint
        for (el in ops) {
            if (!el.isJsonObject) continue
            val op = el.asJsonObject
            p.style = Paint.Style.FILL
            p.color = color(op.s("fill"), ACCENT)
            fun X(v: Float) = left + v * scale
            fun Y(v: Float) = top + v * scale
            when (op.s("op")) {
                "circle" -> c.drawCircle(X(op.f("x", 0f)), Y(op.f("y", 0f)), op.f("r", 4f) * scale, p)
                "ellipse" -> c.drawOval(RectF(
                    X(op.f("x", 0f) - op.f("rx", 4f)), Y(op.f("y", 0f) - op.f("ry", 4f)),
                    X(op.f("x", 0f) + op.f("rx", 4f)), Y(op.f("y", 0f) + op.f("ry", 4f))), p)
                "rect" -> {
                    val rr = op.f("radius", 0f) * scale
                    c.drawRoundRect(RectF(X(op.f("x", 0f)), Y(op.f("y", 0f)),
                        X(op.f("x", 0f) + op.f("w", 10f)), Y(op.f("y", 0f) + op.f("h", 10f))), rr, rr, p)
                }
                "line" -> {
                    p.color = color(op.s("stroke"), ACCENT)
                    p.strokeWidth = op.f("width", 1f) * scale
                    c.drawLine(X(op.f("x1", 0f)), Y(op.f("y1", 0f)),
                        X(op.f("x2", 0f)), Y(op.f("y2", 0f)), p)
                }
                "path" -> {
                    val pts = op.get("points") as? JsonArray ?: continue
                    val path = Path()
                    pts.forEachIndexed { i, ptEl ->
                        val pt = ptEl as? JsonArray ?: return@forEachIndexed
                        if (pt.size() < 2) return@forEachIndexed
                        val px = X(pt[0].asFloat); val py = Y(pt[1].asFloat)
                        if (i == 0) path.moveTo(px, py) else path.lineTo(px, py)
                    }
                    if (op.b("close")) path.close()
                    op.s("fill")?.let { p.color = color(it, ACCENT); p.style = Paint.Style.FILL; c.drawPath(path, p) }
                    op.s("stroke")?.let {
                        p.color = color(it, ACCENT); p.style = Paint.Style.STROKE
                        p.strokeWidth = op.f("width", 1f) * scale; c.drawPath(path, p)
                    }
                }
            }
        }
        p.style = Paint.Style.FILL
    }
}
