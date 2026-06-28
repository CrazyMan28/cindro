package com.jarvis.app.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.jarvis.app.ui.theme.GlowCard
import com.jarvis.app.ui.theme.JarvisPalette

data class MoreEntry(val route: String, val label: String, val subtitle: String, val icon: ImageVector)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoreScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    val entries = listOf(
        MoreEntry("skills", "Skills", "Browse + invoke Jarvis skills", Icons.Filled.AutoAwesome),
        MoreEntry("agents", "Agents", "Define + dispatch custom subagents", Icons.Filled.SmartToy),
        MoreEntry("queue", "Queue", "Schedule tasks for Jarvis", Icons.Filled.Schedule),
        MoreEntry("mcp", "MCP servers", "Add, test, enable MCP tools", Icons.Filled.Hub),
        MoreEntry("plugins", "Plugins", "Install from the catalog", Icons.Filled.Extension),
        MoreEntry("memory", "Memory", "What Jarvis remembers", Icons.Filled.Psychology),
        MoreEntry("files", "Files", "Files pushed from the laptop", Icons.Filled.Folder),
    )

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text("More") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = JarvisPalette.Background,
                    titleContentColor = JarvisPalette.TextPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            entries.forEach { entry ->
                GlowCard(modifier = Modifier.fillMaxWidth().clickable { onOpen(entry.route) }) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Icon(entry.icon, contentDescription = null, tint = JarvisPalette.Accent, modifier = Modifier.size(26.dp))
                        Spacer(Modifier.height(0.dp))
                        Column(Modifier.weight(1f).padding(start = 14.dp)) {
                            Text(entry.label, style = MaterialTheme.typography.titleMedium, color = JarvisPalette.TextPrimary)
                            Text(entry.subtitle, style = MaterialTheme.typography.bodySmall, color = JarvisPalette.TextSecondary)
                        }
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = JarvisPalette.TextSecondary)
                    }
                }
            }
        }
    }
}
