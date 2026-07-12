package com.jarvis.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.gson.JsonParser

/**
 * One-click "pin to home screen" for a Cindro widget. Asks the launcher to place a
 * [JarvisWidgetProvider] instance via requestPinAppWidget (API 26+); the widget id +
 * spec are stashed as a pending bind that the new instance adopts (the launcher
 * doesn't reliably hand us the new appWidgetId, so the provider consumes the stash).
 */
object WidgetPinHelper {

    /** @return true if the pin request was dispatched (the system then shows its
     *  confirm UI). false if the launcher doesn't support in-app pinning — the user
     *  can still add the widget from the home-screen widget picker. */
    fun pinToHome(context: Context, widgetId: String, specJson: String, title: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val mgr = AppWidgetManager.getInstance(context)
        if (!mgr.isRequestPinAppWidgetSupported) return false
        WidgetBindings.setPending(context, widgetId, specJson, title)

        // DYNAMIC SIZE: measure the content's natural height and pin via the
        // size-tier provider that fits it (Android has no per-pin size API, but it
        // honors each provider's own default cell). Compact / default / tall / xtall.
        val providerClass = pickProvider(context, specJson)
        val provider = ComponentName(context, providerClass)
        val callback = PendingIntent.getBroadcast(
            context, 0,
            Intent(JarvisWidgetProvider.ACTION_PINNED).setClass(context, providerClass),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return mgr.requestPinAppWidget(provider, null, callback)
    }

    private fun pickProvider(context: Context, specJson: String): Class<*> {
        val density = context.resources.displayMetrics.density
        val naturalDp = runCatching {
            val spec = JsonParser.parseString(specJson).asJsonObject
            // Measure at a typical 4-cell width (~260dp) so the height reflects how it
            // will actually wrap on the home screen.
            WidgetBitmapRenderer.naturalHeightPx(spec, (260 * density).toInt(), density) / density
        }.getOrDefault(220f)
        return when {
            naturalDp < 150f -> JarvisWidgetCompactProvider::class.java   // 3×2
            naturalDp < 300f -> JarvisWidgetProvider::class.java          // 3×3 (default)
            naturalDp < 460f -> JarvisWidgetTallProvider::class.java      // 4×5
            else -> JarvisWidgetXTallProvider::class.java                 // 4×7
        }
    }
}
