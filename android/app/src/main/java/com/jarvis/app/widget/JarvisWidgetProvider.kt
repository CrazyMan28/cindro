package com.jarvis.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.google.gson.JsonParser
import com.jarvis.app.MainActivity
import com.jarvis.app.R

/**
 * The REAL Android home-screen widget. Each placed instance (appWidgetId) is bound
 * to a Jarvis widget/canvas id and shows its DSL spec drawn to a bitmap by
 * [WidgetBitmapRenderer]. Live updates arrive over the device WS: the background
 * service calls [refreshForWidgetId] when the daemon forwards a render for a pinned
 * id. Tapping the widget opens the app.
 */
class JarvisWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) {
            // A freshly-placed instance (e.g. from the 1-click pin) adopts the
            // stashed pending bind so it shows the right widget immediately.
            if (WidgetBindings.widgetIdFor(context, id) == null)
                WidgetBindings.consumePending(context, id)
            renderInto(context, mgr, id)
        }
    }

    override fun onAppWidgetOptionsChanged(
        context: Context, mgr: AppWidgetManager, appWidgetId: Int, newOptions: android.os.Bundle,
    ) {
        renderInto(context, mgr, appWidgetId) // re-render at the new size
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_PINNED) {
            val appWidgetId = intent.getIntExtra(
                AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                if (WidgetBindings.widgetIdFor(context, appWidgetId) == null)
                    WidgetBindings.consumePending(context, appWidgetId)
                renderInto(context, AppWidgetManager.getInstance(context), appWidgetId)
            }
            return
        }
        super.onReceive(context, intent)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        for (id in appWidgetIds) {
            val widgetId = WidgetBindings.widgetIdFor(context, id)
            WidgetBindings.unbind(context, id)
            // If no other home-screen instance shows this widget, tell the daemon to
            // unpin it (so its live job can stop). Routed through the service which
            // owns the WS.
            if (widgetId != null && WidgetBindings.appWidgetIdsFor(context, widgetId).isEmpty())
                com.jarvis.app.net.JarvisConnectionService.requestUnpin(context, widgetId)
        }
    }

    companion object {
        const val ACTION_PINNED = "com.jarvis.app.WIDGET_PINNED"

        /** Re-render every placed instance bound to [widgetId] with a fresh spec. */
        fun refreshForWidgetId(context: Context, widgetId: String, specJson: String, title: String) {
            val mgr = AppWidgetManager.getInstance(context)
            for (id in WidgetBindings.appWidgetIdsFor(context, widgetId)) {
                WidgetBindings.setSpec(context, id, specJson, title)
                renderInto(context, mgr, id)
            }
        }

        fun renderInto(context: Context, mgr: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_jarvis)
            val specJson = WidgetBindings.specFor(context, appWidgetId)
            val title = WidgetBindings.titleFor(context, appWidgetId)
            val density = context.resources.displayMetrics.density

            val opts = mgr.getAppWidgetOptions(appWidgetId)
            val portrait = context.resources.configuration.orientation ==
                android.content.res.Configuration.ORIENTATION_PORTRAIT
            // Render to the cell's ACTUAL size so content scales to fit (no cut-off).
            val minWidthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180)
                .takeIf { it > 0 } ?: 180
            // In portrait the visible height is MAX_HEIGHT; in landscape it's MIN_HEIGHT.
            val heightDp = (if (portrait) opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0)
                            else opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0))
                .takeIf { it > 0 } ?: 120
            val wpx = (minWidthDp * density).toInt().coerceAtLeast(120)
            val hpx = (heightDp * density).toInt().coerceIn(90, 1400)

            val bitmap = specJson?.let {
                runCatching {
                    WidgetBitmapRenderer.render(
                        JsonParser.parseString(it).asJsonObject, wpx, hpx, density)
                }.getOrNull()
            }
            if (bitmap != null) {
                views.setImageViewBitmap(R.id.widget_image, bitmap)
                views.setViewVisibility(R.id.widget_image, View.VISIBLE)
                views.setViewVisibility(R.id.widget_placeholder, View.GONE)
            } else {
                views.setViewVisibility(R.id.widget_image, View.GONE)
                views.setViewVisibility(R.id.widget_placeholder, View.VISIBLE)
                views.setTextViewText(R.id.widget_placeholder, "$title\nopen Jarvis")
            }

            val tap = PendingIntent.getActivity(
                context, appWidgetId,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_root, tap)
            mgr.updateAppWidget(appWidgetId, views)
        }
    }
}
