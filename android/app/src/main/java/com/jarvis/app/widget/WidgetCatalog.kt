package com.jarvis.app.widget

import android.content.Context
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** One pinnable widget the phone has seen rendered. */
data class CatalogEntry(val id: String, val title: String, val specJson: String, val ts: Long)

/**
 * A small cache of the most-recently-rendered widgets (id -> spec/title), so the
 * widget configuration screen (OS "add widget" flow) can offer something to pin
 * even when launched cold. Updated by the connection service on every widget.render.
 * Plain SharedPreferences, capped to the latest [MAX] entries.
 */
object WidgetCatalog {
    private const val PREFS = "jarvis_widget_catalog"
    private const val MAX = 30
    // Bump to invalidate stale caches across an app update (a deleted widget that
    // lingered in the old cache is wiped once on first run of the new version).
    private const val VERSION = 2
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun ensureVersion(ctx: Context) {
        val p = prefs(ctx)
        if (p.getInt("ver", 0) != VERSION) {
            val e = p.edit()
            p.all.keys.filter { it.startsWith("w_") }.forEach { e.remove(it) }
            e.putInt("ver", VERSION).apply()
        }
    }

    fun remember(ctx: Context, id: String, title: String, specJson: String, ts: Long) {
        if (id.isBlank()) return
        ensureVersion(ctx)
        val p = prefs(ctx)
        val e = JsonObject().apply {
            addProperty("id", id); addProperty("title", title)
            addProperty("spec", specJson); addProperty("ts", ts)
        }
        p.edit().putString("w_$id", e.toString()).apply()
        // Trim oldest beyond MAX.
        val all = list(ctx)
        if (all.size > MAX) {
            val editor = p.edit()
            all.sortedBy { it.ts }.take(all.size - MAX).forEach { editor.remove("w_${it.id}") }
            editor.apply()
        }
    }

    /** Forget a deleted widget so it stops re-appearing in the gallery / pin picker. */
    fun remove(ctx: Context, id: String) {
        if (id.isBlank()) return
        prefs(ctx).edit().remove("w_$id").apply()
    }

    /** Forget all widgets (canvas_clear). */
    fun clear(ctx: Context) {
        val p = prefs(ctx)
        val e = p.edit()
        p.all.keys.filter { it.startsWith("w_") }.forEach { e.remove(it) }
        e.apply()
    }

    fun list(ctx: Context): List<CatalogEntry> {
        ensureVersion(ctx)
        return prefs(ctx).all.entries.mapNotNull { (k, v) ->
            if (!k.startsWith("w_") || v !is String) return@mapNotNull null
            runCatching {
                val o = JsonParser.parseString(v).asJsonObject
                CatalogEntry(
                    id = o.get("id").asString,
                    title = o.get("title")?.asString ?: "Orin",
                    specJson = o.get("spec").asString,
                    ts = o.get("ts")?.asLong ?: 0L,
                )
            }.getOrNull()
        }.sortedByDescending { it.ts }
    }

    fun specFor(ctx: Context, id: String): CatalogEntry? = list(ctx).firstOrNull { it.id == id }
}
