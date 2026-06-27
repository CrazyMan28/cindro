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
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun remember(ctx: Context, id: String, title: String, specJson: String, ts: Long) {
        if (id.isBlank()) return
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

    fun list(ctx: Context): List<CatalogEntry> =
        prefs(ctx).all.entries.mapNotNull { (k, v) ->
            if (!k.startsWith("w_") || v !is String) return@mapNotNull null
            runCatching {
                val o = JsonParser.parseString(v).asJsonObject
                CatalogEntry(
                    id = o.get("id").asString,
                    title = o.get("title")?.asString ?: "Jarvis",
                    specJson = o.get("spec").asString,
                    ts = o.get("ts")?.asLong ?: 0L,
                )
            }.getOrNull()
        }.sortedByDescending { it.ts }

    fun specFor(ctx: Context, id: String): CatalogEntry? = list(ctx).firstOrNull { it.id == id }
}
