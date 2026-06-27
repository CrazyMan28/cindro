package com.jarvis.app.ui.chat

import android.graphics.Color as AndroidColor
import android.util.Base64
import android.webkit.WebView
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------------
// WidgetRenderer — a SAFE, recursive Compose interpreter for the render_widget
// JSON DSL (the same one the desktop draws). The spec is DATA — nothing is ever
// evaluated as code. Mirrors desktop/qml/WidgetRenderer.qml: column/row/grid,
// text/badge/rect/progress/list/divider/spacer/link/image, svg/canvas (art), and
// button (action routed back to chat), plus per-node anim.
// ---------------------------------------------------------------------------

private val ACCENT = Color(0xFF5FE0FF)
private val SURFACE = Color(0xFF0E2233)
private val HAIRLINE = Color(0xFF1F3A4D)
private val TEXT = Color(0xFFDDEAF2)
private val MUTED = Color(0xFF8FB6C9)
private val SUCCESS = Color(0xFF39E6A0)
private val DANGER = Color(0xFFFF6B6B)

@Composable
fun WidgetRenderer(specJson: String, onAction: (JsonObject) -> Unit = {}) {
    val node = remember(specJson) {
        runCatching { JsonParser.parseString(specJson).asJsonObject }.getOrNull()
    } ?: return
    WidgetNode(node, fill = true, onAction = onAction)
}

@Composable
private fun WidgetNode(node: JsonObject, fill: Boolean, onAction: (JsonObject) -> Unit) {
    val type = node.str("type") ?: return
    var m: Modifier = Modifier
    if (fill && fillsWidth(type)) m = m.fillMaxWidth()
    m = m.applyAnim(node)
    when (type) {
        "column", "row" -> Container(node, type, m, onAction)
        "pager" -> PagerNode(node, onAction)
        "grid" -> Grid(node, m, onAction)
        "text" -> TextNode(node, m)
        "badge" -> Badge(node)
        "rect" -> RectNode(node)
        "divider" -> DividerNode(node, m)
        "spacer" -> SpacerNode(node)
        "progress" -> Progress(node, m)
        "list" -> ListNode(node, m)
        "link" -> LinkNode(node, m, onAction)
        "image" -> ImageNode(node)
        "svg" -> SvgNode(node)
        "canvas" -> CanvasNode(node)
        "button" -> ButtonNode(node, onAction)
    }
}

// ---- containers -----------------------------------------------------------

@Composable
private fun Container(node: JsonObject, type: String, mod: Modifier, onAction: (JsonObject) -> Unit) {
    val gap = node.num("gap", 6f).dp
    val pad = node.num("pad", 0f).dp
    val bg = node.color("bg")
    val radius = node.num("radius", 0f).dp
    val borderC = node.color("border")
    var box = mod
    if (node.has("w")) box = box.width(node.num("w", 0f).dp)
    if (node.has("h")) box = box.height(node.num("h", 0f).dp)
    if (radius.value > 0f) box = box.clip(RoundedCornerShape(radius))
    if (bg != null) box = box.background(bg)
    if (borderC != null) box = box.border(node.num("borderW", 1f).dp, borderC, RoundedCornerShape(radius))
    box = box.padding(pad)
    val children = node.arr("children")
    if (type == "row") {
        Row(box, horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
            children.objs().forEach { c ->
                val grow = c.bool("grow")
                Box(if (grow) Modifier.weight(1f) else Modifier, contentAlignment = alignOf(c)) {
                    WidgetNode(c, fill = grow, onAction = onAction)
                }
            }
        }
    } else {
        Column(box, verticalArrangement = Arrangement.spacedBy(gap)) {
            children.objs().forEach { c ->
                Box(Modifier.fillMaxWidth(), contentAlignment = alignOf(c)) {
                    WidgetNode(c, fill = true, onAction = onAction)
                }
            }
        }
    }
}

@Composable
private fun Grid(node: JsonObject, mod: Modifier, onAction: (JsonObject) -> Unit) {
    val cols = node.num("cols", 2f).toInt().coerceAtLeast(1)
    val gap = node.num("gap", 8f).dp
    val pad = node.num("pad", 0f).dp
    val bg = node.color("bg")
    val radius = node.num("radius", 0f).dp
    var box = mod
    if (radius.value > 0f) box = box.clip(RoundedCornerShape(radius))
    if (bg != null) box = box.background(bg)
    box = box.padding(pad)
    val items = node.arr("children").objs()
    Column(box, verticalArrangement = Arrangement.spacedBy(gap)) {
        items.chunked(cols).forEach { rowItems ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                rowItems.forEach { c ->
                    Box(Modifier.weight(1f), contentAlignment = alignOf(c)) {
                        WidgetNode(c, fill = true, onAction = onAction)
                    }
                }
                repeat(cols - rowItems.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

// ---- leaves ---------------------------------------------------------------

@Composable
private fun TextNode(node: JsonObject, mod: Modifier) {
    val align = when (node.str("align")) {
        "center" -> TextAlign.Center; "right" -> TextAlign.End; else -> TextAlign.Start
    }
    val weightNum = node.optNum("weight")
    val weight = when {
        weightNum != null -> FontWeight(weightNum.toInt().coerceIn(100, 900))
        node.bool("bold") -> FontWeight.SemiBold
        else -> FontWeight.Normal
    }
    Text(
        text = node.str("text") ?: "",
        modifier = mod,
        color = node.color("color") ?: TEXT,
        fontSize = node.num("size", 14f).sp,
        fontWeight = weight,
        textAlign = align,
        letterSpacing = node.num("spacing", 0f).sp,
        maxLines = node.optNum("maxLines")?.toInt() ?: Int.MAX_VALUE,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun Badge(node: JsonObject) {
    Box(
        Modifier.clip(RoundedCornerShape(50))
            .background(node.color("color") ?: Color(0xFF13414F))
            .border(1.dp, HAIRLINE, RoundedCornerShape(50))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Text(node.str("text") ?: "", color = TEXT, fontSize = 11.sp)
    }
}

@Composable
private fun RectNode(node: JsonObject) {
    Box(
        Modifier.size(node.num("w", 40f).dp, node.num("h", 40f).dp)
            .clip(RoundedCornerShape(node.num("radius", 0f).dp))
            .background(node.color("color") ?: ACCENT),
    )
}

@Composable
private fun DividerNode(node: JsonObject, mod: Modifier) {
    Box(mod.then(Modifier.fillMaxWidth().height(1.dp).background(node.color("color") ?: HAIRLINE)))
}

@Composable
private fun SpacerNode(node: JsonObject) {
    val s = node.num("size", 8f).dp
    Spacer(Modifier.size(node.num("w", s.value).dp, node.num("h", s.value).dp))
}

@Composable
private fun Progress(node: JsonObject, mod: Modifier) {
    val raw = node.optNum("value") ?: 0f
    val v = (if (raw > 1f) raw / 100f else raw).coerceIn(0f, 1f)
    val color = node.color("color") ?: ACCENT
    Box(mod.then(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(50)).background(node.color("track") ?: SURFACE))) {
        Box(Modifier.fillMaxWidth(v).height(8.dp).clip(RoundedCornerShape(50)).background(color))
    }
}

@Composable
private fun ListNode(node: JsonObject, mod: Modifier) {
    val gap = node.num("gap", 6f).dp
    Column(mod, verticalArrangement = Arrangement.spacedBy(gap)) {
        node.arr("rows").objs().forEach { r ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(3.dp).height(28.dp).clip(RoundedCornerShape(2.dp)).background(r.color("color") ?: ACCENT))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(r.str("text") ?: "", color = TEXT, fontSize = 13.sp)
                    r.str("sub")?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, color = MUTED, fontSize = 11.sp)
                    }
                }
                r.str("badge")?.takeIf { it.isNotEmpty() }?.let {
                    Box(Modifier.clip(RoundedCornerShape(50)).background(Color(0xFF13414F)).padding(horizontal = 7.dp, vertical = 3.dp)) {
                        Text(it, color = TEXT, fontSize = 10.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun LinkNode(node: JsonObject, mod: Modifier, onAction: (JsonObject) -> Unit) {
    val url = node.str("url") ?: ""
    val safe = url.startsWith("http://") || url.startsWith("https://")
    Text(
        text = node.str("text")?.ifEmpty { url } ?: url,
        modifier = mod.then(if (safe) Modifier.clickable {
            val a = JsonObject(); a.addProperty("open", url); onAction(a)
        } else Modifier),
        color = node.color("color") ?: ACCENT,
        fontSize = 13.sp,
    )
}

@Composable
private fun ImageNode(node: JsonObject) {
    // Render via a transparent WebView so any url / data URI works without a new dep.
    val url = node.str("url") ?: return
    val w = node.num("w", 120f); val h = node.num("h", 120f)
    HtmlBox("<img src='$url' style='width:100%;height:100%;object-fit:contain'/>", w, h)
}

@Composable
private fun SvgNode(node: JsonObject) {
    val svg = node.str("svg") ?: return
    HtmlBox(svg, node.num("w", 200f), node.num("h", 160f))
}

@Composable
private fun HtmlBox(inner: String, w: Float, h: Float) {
    val html = "<html><head><meta name='viewport' content='width=device-width'/></head>" +
        "<body style='margin:0;padding:0;background:transparent'>$inner</body></html>"
    AndroidView(
        modifier = Modifier.size(w.dp, h.dp),
        factory = { ctx ->
            WebView(ctx).apply {
                setBackgroundColor(AndroidColor.TRANSPARENT)
                settings.javaScriptEnabled = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = false
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
            }
        },
        update = { wv ->
            val b64 = Base64.encodeToString(html.toByteArray(), Base64.NO_PADDING)
            wv.loadData(b64, "text/html", "base64")
        },
    )
}

@Composable
private fun CanvasNode(node: JsonObject) {
    val w = node.num("w", 120f); val h = node.num("h", 120f)
    val ops = node.arr("ops").objs()
    Canvas(Modifier.size(w.dp, h.dp)) {
        ops.forEach { o ->
            val fill = o.color("fill"); val stroke = o.color("stroke")
            val sw = o.num("width", 1.5f)
            when (o.str("op")) {
                "circle" -> {
                    val c = Offset(o.num("x", 0f), o.num("y", 0f)); val r = o.num("r", 0f)
                    fill?.let { drawCircle(it, r, c) }
                    if (stroke != null) drawCircle(stroke, r, c, style = Stroke(sw))
                }
                "ellipse" -> {
                    val cx = o.num("x", 0f); val cy = o.num("y", 0f)
                    val rx = o.num("rx", 1f); val ry = o.num("ry", 1f)
                    val topLeft = Offset(cx - rx, cy - ry); val sz = Size(rx * 2, ry * 2)
                    fill?.let { drawOval(it, topLeft, sz) }
                    if (stroke != null) drawOval(stroke, topLeft, sz, style = Stroke(sw))
                }
                "rect" -> {
                    val tl = Offset(o.num("x", 0f), o.num("y", 0f)); val sz = Size(o.num("w", 0f), o.num("h", 0f))
                    val rad = o.num("radius", 0f)
                    if (rad > 0f) {
                        val cr = androidx.compose.ui.geometry.CornerRadius(rad, rad)
                        fill?.let { drawRoundRect(it, tl, sz, cr) }
                        if (stroke != null) drawRoundRect(stroke, tl, sz, cr, style = Stroke(sw))
                    } else {
                        fill?.let { drawRect(it, tl, sz) }
                        if (stroke != null) drawRect(stroke, tl, sz, style = Stroke(sw))
                    }
                }
                "line" -> {
                    drawLine(stroke ?: ACCENT, Offset(o.num("x1", 0f), o.num("y1", 0f)),
                        Offset(o.num("x2", 0f), o.num("y2", 0f)), strokeWidth = sw)
                }
                "path" -> {
                    val pts = o.arr("points")
                    val p = Path()
                    var first = true
                    pts.forEach { el ->
                        val a = el as? JsonArray ?: return@forEach
                        if (a.size() < 2) return@forEach
                        val x = a[0].asFloat; val y = a[1].asFloat
                        if (first) { p.moveTo(x, y); first = false } else p.lineTo(x, y)
                    }
                    if (o.bool("close")) p.close()
                    fill?.let { drawPath(p, it) }
                    if (stroke != null) drawPath(p, stroke, style = Stroke(sw))
                }
            }
        }
    }
}

@Composable
private fun ButtonNode(node: JsonObject, onAction: (JsonObject) -> Unit) {
    val action = node.getAsJsonObject("action")
    val scope = rememberCoroutineScope()
    // "" | "correct" | "wrong" — quiz feedback flash
    var feedback by remember { mutableStateOf("") }
    val base = node.color("color") ?: ACCENT
    val bg by animateColorAsState(
        when (feedback) { "correct" -> SUCCESS; "wrong" -> DANGER; else -> base },
        label = "btnbg",
    )
    val label = node.str("text") ?: "Button"
    Box(
        Modifier.clip(RoundedCornerShape(node.num("radius", 8f).dp))
            .background(bg)
            .border(1.dp, HAIRLINE, RoundedCornerShape(node.num("radius", 8f).dp))
            .clickable(enabled = action != null) {
                val a = action ?: return@clickable
                if (a.has("correct")) {
                    feedback = if (a.bool("correct")) "correct" else "wrong"
                    if (a.bool("next") || a.bool("prev") || a.has("goto")) {
                        scope.launch { delay(520); onAction(a) }   // flash, then navigate
                    } else {
                        onAction(a)
                    }
                } else {
                    onAction(a)
                }
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(
            when (feedback) { "correct" -> "✓ $label"; "wrong" -> "✗ $label"; else -> label },
            color = if (feedback != "") Color(0xFF06140C) else node.color("textColor") ?: Color(0xFF03121A),
            fontSize = node.num("size", 12f).sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

// ---- pager : multi-page widget (quizzes, wizards, slideshows) --------------
@Composable
private fun PagerNode(node: JsonObject, onAction: (JsonObject) -> Unit) {
    val pages = node.arr("pages").objs()
    if (pages.isEmpty()) return
    var page by remember { mutableIntStateOf(node.num("page", 0f).toInt().coerceIn(0, pages.size - 1)) }
    // Intercept navigation; bubble everything else (send/skill) to the host.
    val pagerAction: (JsonObject) -> Unit = { a ->
        when {
            a.has("goto") -> page = a.num("goto", page.toFloat()).toInt().coerceIn(0, pages.size - 1)
            a.bool("next") -> page = (page + 1).coerceIn(0, pages.size - 1)
            a.bool("prev") -> page = (page - 1).coerceIn(0, pages.size - 1)
            else -> onAction(a)
        }
    }
    Column(Modifier.fillMaxWidth()) {
        Crossfade(targetState = page, label = "pager") { p ->
            WidgetNode(pages[p.coerceIn(0, pages.size - 1)], fill = true, onAction = pagerAction)
        }
        if (pages.size > 1 && node.str("dots") != "false") {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                for (i in pages.indices) {
                    Box(
                        Modifier.padding(horizontal = 3.dp)
                            .width(if (i == page) 14.dp else 6.dp)
                            .height(6.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(if (i == page) ACCENT else HAIRLINE),
                    )
                }
            }
        }
    }
}

// ---- animation ------------------------------------------------------------

@Composable
private fun Modifier.applyAnim(node: JsonObject): Modifier {
    val anim = node.getAsJsonObject("anim") ?: return this
    val type = anim.str("type") ?: return this
    val dur = anim.num("duration", 1200f).toInt().coerceAtLeast(100)
    val t = rememberInfiniteTransition(label = "anim")
    return when (type) {
        "pulse" -> {
            val s by t.animateFloat(1f, 1.12f, infiniteRepeatable(tween(dur / 2), RepeatMode.Reverse), label = "p")
            this.scale(s)
        }
        "fade" -> {
            val a by t.animateFloat(1f, 0.3f, infiniteRepeatable(tween(dur / 2), RepeatMode.Reverse), label = "f")
            this.alpha(a)
        }
        "blink" -> {
            val a by t.animateFloat(1f, 0f, infiniteRepeatable(tween(dur / 2, easing = LinearEasing), RepeatMode.Reverse), label = "b")
            this.alpha(a)
        }
        "spin" -> {
            val r by t.animateFloat(0f, 360f, infiniteRepeatable(tween(dur, easing = LinearEasing), RepeatMode.Restart), label = "s")
            this.rotate(r)
        }
        "float" -> {
            val y by t.animateFloat(0f, -6f, infiniteRepeatable(tween(dur / 2), RepeatMode.Reverse), label = "fl")
            this.graphicsLayer { translationY = y }
        }
        else -> this
    }
}

// ---- helpers --------------------------------------------------------------

private fun fillsWidth(type: String): Boolean =
    type in setOf("text", "progress", "list", "divider", "column", "row", "grid", "link")

@Composable
private fun alignOf(node: JsonObject): Alignment = when (node.str("align")) {
    "center" -> Alignment.Center
    "right" -> Alignment.CenterEnd
    else -> Alignment.CenterStart
}

private fun JsonObject.str(key: String): String? =
    get(key)?.takeIf { it.isJsonPrimitive }?.asString

private fun JsonObject.bool(key: String): Boolean =
    get(key)?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

private fun JsonObject.num(key: String, default: Float): Float =
    runCatching { get(key)?.asFloat ?: default }.getOrDefault(default)

private fun JsonObject.optNum(key: String): Float? =
    if (has(key)) runCatching { get(key).asFloat }.getOrNull() else null

private fun JsonObject.arr(key: String): JsonArray =
    get(key) as? JsonArray ?: JsonArray()

private fun JsonArray.objs(): List<JsonObject> = mapNotNull { it as? JsonObject }

private fun JsonObject.color(key: String): Color? {
    val s = str(key) ?: return null
    if (s.isEmpty()) return null
    return runCatching { Color(AndroidColor.parseColor(s)) }.getOrNull()
}

private val JsonElement.asFloatSafe: Float get() = runCatching { asFloat }.getOrDefault(0f)
