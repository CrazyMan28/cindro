package com.jarvis.app.widget

import android.content.Context

/**
 * Persistent map of a placed home-screen AppWidget instance (its appWidgetId) to
 * the Jarvis widget/canvas id it shows, plus the last spec + title so the widget
 * can be redrawn after a reboot or when the app process was dead. Plain
 * SharedPreferences — tiny, synchronous, survives process death.
 */
object WidgetBindings {
    private const val PREFS = "jarvis_home_widgets"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun bind(ctx: Context, appWidgetId: Int, widgetId: String, title: String) {
        prefs(ctx).edit()
            .putString("bind_$appWidgetId", widgetId)
            .putString("title_$appWidgetId", title)
            .apply()
    }

    fun setSpec(ctx: Context, appWidgetId: Int, specJson: String, title: String?) {
        val e = prefs(ctx).edit().putString("spec_$appWidgetId", specJson)
        if (title != null) e.putString("title_$appWidgetId", title)
        e.apply()
    }

    fun widgetIdFor(ctx: Context, appWidgetId: Int): String? =
        prefs(ctx).getString("bind_$appWidgetId", null)

    fun specFor(ctx: Context, appWidgetId: Int): String? =
        prefs(ctx).getString("spec_$appWidgetId", null)

    fun titleFor(ctx: Context, appWidgetId: Int): String =
        prefs(ctx).getString("title_$appWidgetId", null) ?: "Jarvis"

    /** Placed AppWidget instances bound to a given Jarvis widget id (a render fans
     *  out to all of them). */
    fun appWidgetIdsFor(ctx: Context, widgetId: String): List<Int> =
        prefs(ctx).all.entries
            .filter { it.key.startsWith("bind_") && it.value == widgetId }
            .mapNotNull { it.key.removePrefix("bind_").toIntOrNull() }

    /** Every distinct Jarvis widget id currently pinned to the home screen (used to
     *  send pin heartbeats so the daemon keeps those live jobs alive). */
    fun pinnedWidgetIds(ctx: Context): Set<String> =
        prefs(ctx).all.entries
            .filter { it.key.startsWith("bind_") }
            .mapNotNull { it.value as? String }
            .toSet()

    fun unbind(ctx: Context, appWidgetId: Int) {
        prefs(ctx).edit()
            .remove("bind_$appWidgetId")
            .remove("spec_$appWidgetId")
            .remove("title_$appWidgetId")
            .apply()
    }

    // ---- pending bind (1-click "pin to home") ------------------------------
    // requestPinAppWidget doesn't reliably hand us the new appWidgetId on every
    // launcher, so the in-app pin button stashes what to bind; the first unbound
    // instance that appears (provider onUpdate / success callback) consumes it.

    fun setPending(ctx: Context, widgetId: String, specJson: String, title: String) {
        prefs(ctx).edit()
            .putString("pending_widget", widgetId)
            .putString("pending_spec", specJson)
            .putString("pending_title", title)
            .apply()
    }

    /** Bind [appWidgetId] to a stashed pending request, if any. Returns true if it
     *  consumed one (and cleared it). */
    fun consumePending(ctx: Context, appWidgetId: Int): Boolean {
        val p = prefs(ctx)
        val widgetId = p.getString("pending_widget", null) ?: return false
        val spec = p.getString("pending_spec", null) ?: return false
        val title = p.getString("pending_title", "Jarvis") ?: "Jarvis"
        p.edit()
            .putString("bind_$appWidgetId", widgetId)
            .putString("spec_$appWidgetId", spec)
            .putString("title_$appWidgetId", title)
            .remove("pending_widget").remove("pending_spec").remove("pending_title")
            .apply()
        return true
    }
}
