package com.jarvis.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * One-click "pin to home screen" for a Jarvis widget. Asks the launcher to place a
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
        val provider = ComponentName(context, JarvisWidgetProvider::class.java)
        val callback = PendingIntent.getBroadcast(
            context, 0,
            Intent(JarvisWidgetProvider.ACTION_PINNED).setClass(context, JarvisWidgetProvider::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return mgr.requestPinAppWidget(provider, null, callback)
    }
}
