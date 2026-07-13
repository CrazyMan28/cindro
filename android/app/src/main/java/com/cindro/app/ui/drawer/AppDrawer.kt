package com.cindro.app.ui.drawer

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.cindro.app.net.DeviceClient
import com.cindro.app.protocol.Session
import com.cindro.app.ui.ConnectionPill
import com.cindro.app.ui.theme.JarvisPalette
import com.cindro.app.ui.util.JarvisOrb

/**
 * One promoted drawer destination — the flat replacement for the old bottom-tab
 * bar (Canvas/Computer/Phone/Settings) AND the retired "More" hub
 * (Skills/Agents/Queue/MCP servers/Plugins/Memory/Files). Every one of those
 * screens/viewmodels is unchanged — only how you reach them moved.
 */
data class DrawerDestination(val route: String, val label: String, val icon: ImageVector)

val AppDrawerDestinations = listOf(
    DrawerDestination("sessions", "Chats", Icons.AutoMirrored.Filled.Chat),
    DrawerDestination("canvas", "Canvas", Icons.Filled.Dashboard),
    DrawerDestination("computer", "Computer", Icons.Filled.Computer),
    DrawerDestination("phone", "Phone", Icons.Filled.Phone),
    DrawerDestination("skills", "Skills", Icons.Filled.AutoAwesome),
    DrawerDestination("agents", "Agents", Icons.Filled.SmartToy),
    DrawerDestination("queue", "Queue", Icons.Filled.Schedule),
    DrawerDestination("mcp", "MCP servers", Icons.Filled.Hub),
    DrawerDestination("plugins", "Plugins", Icons.Filled.Extension),
    DrawerDestination("memory", "Memory", Icons.Filled.Psychology),
    DrawerDestination("files", "Files", Icons.Filled.Folder),
    DrawerDestination("settings", "Settings", Icons.Filled.Settings),
)

/**
 * The Claude/ChatGPT-style sidebar: brand header, New chat, Recents (live
 * sessions), then every promoted destination. One flat LazyColumn — no nested
 * scrolling — so it stays smooth regardless of how many recents/destinations
 * there are.
 */
@Composable
fun AppDrawerContent(
    connection: DeviceClient.State,
    recents: List<Session>,
    isChatHome: Boolean,
    activeSessionId: String?,
    onNewChat: () -> Unit,
    onOpenSession: (String) -> Unit,
    onNavigate: (String) -> Unit,
) {
    ModalDrawerSheet(drawerContainerColor = JarvisPalette.Surface) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    JarvisOrb(size = 28.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        "Cindro",
                        style = MaterialTheme.typography.headlineSmall,
                        fontFamily = FontFamily.Serif,
                        fontWeight = FontWeight.Bold,
                        color = JarvisPalette.TextPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    ConnectionPill(connection)
                }
                Spacer(Modifier.height(4.dp))
            }

            item {
                NavigationDrawerItem(
                    label = { Text("New chat", fontWeight = FontWeight.SemiBold) },
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    selected = isChatHome,
                    onClick = onNewChat,
                    colors = drawerItemColors(),
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }

            if (recents.isNotEmpty()) {
                item {
                    Text(
                        "Recents",
                        style = MaterialTheme.typography.labelLarge,
                        color = JarvisPalette.TextSecondary,
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 10.dp),
                    )
                }
                items(recents.take(12), key = { it.id }) { session ->
                    NavigationDrawerItem(
                        label = {
                            Text(session.displayTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        },
                        icon = null,
                        selected = session.id == activeSessionId,
                        onClick = { onOpenSession(session.id) },
                        colors = drawerItemColors(),
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
            }

            item {
                HorizontalDivider(
                    Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                    color = JarvisPalette.Outline,
                )
            }

            items(AppDrawerDestinations, key = { it.route }) { dest ->
                NavigationDrawerItem(
                    label = { Text(dest.label) },
                    icon = { Icon(dest.icon, contentDescription = null) },
                    selected = false,
                    onClick = { onNavigate(dest.route) },
                    colors = drawerItemColors(),
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun drawerItemColors() = NavigationDrawerItemDefaults.colors(
    selectedContainerColor = JarvisPalette.Accent.copy(alpha = 0.16f),
    selectedIconColor = JarvisPalette.Accent,
    selectedTextColor = JarvisPalette.Accent,
    unselectedIconColor = JarvisPalette.TextSecondary,
    unselectedTextColor = JarvisPalette.TextPrimary,
)
