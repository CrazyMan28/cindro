package com.jarvis.app.widget

import android.content.Context

/**
 * Persistent map of a placed home-screen AppWidget instance (its appWidgetId) to
 * the Cindro widget/canvas id it shows, plus the last spec + title so the widget
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

    /** Drop the rendered spec (keep the binding) so the tile shows its placeholder —
     *  used when the underlying canvas is deleted. A later render for the same id
     *  re-populates it. */
    fun clearSpec(ctx: Context, appWidgetId: Int) {
        prefs(ctx).edit().remove("spec_$appWidgetId").apply()
    }

    fun widgetIdFor(ctx: Context, appWidgetId: Int): String? =
        prefs(ctx).getString("bind_$appWidgetId", null)

    fun specFor(ctx: Context, appWidgetId: Int): String? =
        prefs(ctx).getString("spec_$appWidgetId", null)

    // Loop guard for content-based sizing: the last height (dp) we asked the
    // launcher to give this widget, so we don't re-request on every re-render.
    fun requestedHeight(ctx: Context, appWidgetId: Int): Int =
        prefs(ctx).getInt("reqh_$appWidgetId", 0)

    fun setRequestedHeight(ctx: Context, appWidgetId: Int, dp: Int) {
        prefs(ctx).edit().putInt("reqh_$appWidgetId", dp).apply()
    }

    fun titleFor(ctx: Context, appWidgetId: Int): String =
        prefs(ctx).getString("title_$appWidgetId", null) ?: "Cindro"

    /** Placed AppWidget instances bound to a given Cindro widget id (a render fans
     *  out to all of them). */
    fun appWidgetIdsFor(ctx: Context, widgetId: String): List<Int> =
        prefs(ctx).all.entries
            .filter { it.key.startsWith("bind_") && it.value == widgetId }
            .mapNotNull { it.key.removePrefix("bind_").toIntOrNull() }

    /** Every distinct Cindro widget id currently pinned to the home screen (used to
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
        val title = p.getString("pending_title", "Cindro") ?: "Cindro"
        p.edit()
            .putString("bind_$appWidgetId", widgetId)
            .putString("spec_$appWidgetId", spec)
            .putString("title_$appWidgetId", title)
            .remove("pending_widget").remove("pending_spec").remove("pending_title")
            .apply()
        return true
    }
}
