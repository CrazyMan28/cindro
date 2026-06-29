package com.agentphone.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentphone.ui.components.GlassCard
import com.agentphone.ui.components.IconPill
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalMonoTypography
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Palette
import org.json.JSONArray
import org.json.JSONObject

data class CallEntry(val from: String, val to: String, val state: String, val reason: String, val createdAt: String, val missed: Boolean)

@Composable
fun HistoryScreen(vm: AppViewModel, onBack: () -> Unit) {
    var loading by remember { mutableStateOf(true) }
    var calls by remember { mutableStateOf<List<CallEntry>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true
        vm.getCalls { recent ->
            vm.getMissedCalls { missed ->
                loading = false
                val list = mutableListOf<CallEntry>()
                if (recent.ok) list += parseCalls(recent.body, false)
                if (missed.ok) list += parseCalls(missed.body, true)
                if (!recent.ok && !missed.ok) error = recent.error ?: missed.error
                calls = list.sortedByDescending { it.createdAt }.take(50)
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconPill(icon = Icons.Rounded.ArrowBack, onClick = onBack)
            Spacer(Modifier.width(12.dp))
            Text("History", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        }
        when {
            loading -> CircularProgressIndicator(
                color = Palette.Indigo,
                modifier = Modifier.padding(32.dp).align(Alignment.CenterHorizontally)
            )
            error != null -> Text(
                error ?: "",
                style = MaterialTheme.typography.bodyMedium,
                color = LocalSemanticColors.current.danger,
                modifier = Modifier.padding(20.dp)
            )
            calls.isEmpty() -> Text(
                "No call history yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = LocalSemanticColors.current.textMuted,
                modifier = Modifier.padding(20.dp)
            )
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(calls, key = { "${it.from}-${it.to}-${it.createdAt}" }) { entry ->
                    CallEntryCard(entry)
                }
                item { Spacer(Modifier.height(20.dp)) }
            }
        }
    }
}

private fun parseCalls(body: String, missed: Boolean): List<CallEntry> {
    return try {
        val arr = JSONArray(body)
        (0 until arr.length()).mapNotNull { i ->
            val obj: JSONObject = arr.optJSONObject(i) ?: return@mapNotNull null
            CallEntry(
                from = obj.optString("from_extension"),
                to = obj.optString("to_extension"),
                state = obj.optString("state", if (missed) "missed" else ""),
                reason = obj.optString("reason", ""),
                createdAt = obj.optString("created_at", ""),
                missed = missed
            )
        }
    } catch (_: Throwable) { emptyList() }
}

@Composable
private fun CallEntryCard(entry: CallEntry) {
    val semantic = LocalSemanticColors.current
    val tint = when {
        entry.missed -> semantic.danger
        entry.state == "ended" -> semantic.online
        else -> semantic.textMuted
    }
    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "${entry.from} → ${entry.to}",
                    style = LocalMonoTypography.current.medium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    listOfNotNull(entry.state.ifBlank { null }, entry.reason.ifBlank { null }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = semantic.textMuted
                )
            }
            Text(
                entry.createdAt.takeLast(8).take(5),
                style = MaterialTheme.typography.labelSmall,
                color = tint
            )
        }
    }
}
