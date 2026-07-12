package com.jarvis.app.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.jarvis.app.ui.theme.JarvisTheme

/**
 * Configuration screen shown when an Orin widget is added from the home-screen
 * widget picker (the in-app "pin to home" button skips this via a pending bind).
 * Lists widgets the phone has recently seen rendered; picking one binds this
 * appWidget instance to it and pins it.
 */
class WidgetConfigActivity : ComponentActivity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Default result: if the user backs out, the widget isn't added.
        setResult(Activity.RESULT_CANCELED)
        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }

        val entries = WidgetCatalog.list(this)
        setContent {
            JarvisTheme {
                ConfigScreen(entries) { entry -> bindAndFinish(entry) }
            }
        }
    }

    private fun bindAndFinish(entry: CatalogEntry) {
        WidgetBindings.bind(this, appWidgetId, entry.id, entry.title)
        WidgetBindings.setSpec(this, appWidgetId, entry.specJson, entry.title)
        JarvisWidgetProvider.renderInto(this, AppWidgetManager.getInstance(this), appWidgetId)
        com.jarvis.app.net.JarvisConnectionService.requestPin(this, entry.id)
        setResult(Activity.RESULT_OK,
            Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }
}

@Composable
private fun ConfigScreen(entries: List<CatalogEntry>, onPick: (CatalogEntry) -> Unit) {
    Scaffold { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Pick a widget to pin", style = MaterialTheme.typography.titleMedium)
            if (entries.isEmpty()) {
                Text("No widgets yet. Open Orin and render a canvas, then add the widget again.",
                    style = MaterialTheme.typography.bodyMedium)
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(entries, key = { it.id }) { e ->
                        Card(
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth().clickable { onPick(e) },
                        ) {
                            Column(Modifier.padding(14.dp)) {
                                Text(e.title.ifBlank { e.id },
                                    style = MaterialTheme.typography.titleSmall)
                                Text(e.id, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }
}
