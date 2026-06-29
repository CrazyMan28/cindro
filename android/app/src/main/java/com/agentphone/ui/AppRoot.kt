package com.agentphone.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.agentphone.ui.agents.AgentsScreen
import com.agentphone.ui.calls.CallsScreen
import com.agentphone.ui.hud.HudScreen
import com.agentphone.ui.components.StatusPill
import com.agentphone.ui.inbox.InboxScreen
import com.agentphone.ui.inbox.ThreadScreen
import com.agentphone.ui.settings.AgentConfigScreen
import com.agentphone.ui.settings.DiagnosticsScreen
import com.agentphone.ui.settings.EnrollAgentScreen
import com.agentphone.ui.settings.HistoryScreen
import com.agentphone.ui.settings.SettingsScreen
import com.agentphone.ui.setup.SetupWizardScreen
import com.agentphone.ui.state.AppViewModel
import com.agentphone.ui.theme.LocalSemanticColors
import com.agentphone.ui.theme.Motion

object Routes {
    const val Setup = "setup"
    const val Calls = "calls"
    const val Inbox = "inbox"
    const val Thread = "thread/{threadId}"
    const val Agents = "agents"
    const val Hud = "hud"
    const val Settings = "settings"
    const val Diagnostics = "diagnostics"
    const val History = "history"
    const val EnrollAgent = "enroll-agent"
    const val AgentConfig = "agent-config/{extension}/{name}"
    fun thread(id: String) = "thread/$id"
    fun agentConfig(extension: String, name: String) =
        "agent-config/$extension/${java.net.URLEncoder.encode(name, "UTF-8")}"
}

private data class TopTab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    TopTab(Routes.Calls, "Calls", Icons.Rounded.Phone),
    TopTab(Routes.Inbox, "Inbox", Icons.Rounded.Inbox),
    TopTab(Routes.Agents, "Agents", Icons.Rounded.SmartToy),
    TopTab(Routes.Hud, "HUD", Icons.Rounded.Dashboard),
    TopTab(Routes.Settings, "Settings", Icons.Rounded.Settings)
)

@Composable
fun AppRoot(openThreadId: String? = null) {
    val vm: AppViewModel = viewModel(factory = AppViewModel.Factory)
    val nav = rememberNavController()
    val settings by vm.settings.collectAsState()
    val phone by vm.phone.collectAsState()
    val statusLine by vm.statusLine.collectAsState()

    // "Not set up yet" means there's no real server URL yet — the default token
    // is a valid credential for the local server, so it must NOT count as unconfigured.
    val firstLaunch = settings.serverUrl.isBlank() || settings.serverUrl.contains("TAILSCALE_IP")
    val startRoute = if (firstLaunch) Routes.Setup else Routes.Calls

    LaunchedEffect(Unit) {
        if (!firstLaunch) vm.connect()
        vm.fetchPendingMessages()
    }
    LaunchedEffect(openThreadId) {
        if (openThreadId != null) nav.navigate(Routes.thread(openThreadId))
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            val backStack by nav.currentBackStackEntryAsState()
            val route = backStack?.destination?.route
            val hideNav = route == Routes.Setup || route?.startsWith("thread/") == true ||
                route == Routes.Diagnostics || route == Routes.History || route == Routes.EnrollAgent
            if (!hideNav) {
                BottomBar(currentRoute = route, onSelect = { dest ->
                    nav.navigate(dest) {
                        popUpTo(nav.graph.startDestinationId) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                })
            }
        },
        topBar = {
            val backStack by nav.currentBackStackEntryAsState()
            val route = backStack?.destination?.route
            if (route != Routes.Setup && route?.startsWith("thread/") != true && route != Routes.EnrollAgent) {
                TopBar(
                    title = tabs.firstOrNull { it.route == route }?.label
                        ?: when (route) {
                            Routes.Diagnostics -> "Diagnostics"
                            Routes.History -> "History"
                            else -> "Agent Phone"
                        },
                    statusLine = statusLine,
                    phoneState = phone
                )
            }
        }
    ) { inner ->
        NavHost(
            navController = nav,
            startDestination = startRoute,
            modifier = Modifier
                .padding(inner)
                .fillMaxSize()
        ) {
            composable(Routes.Setup) {
                SetupWizardScreen(
                    vm = vm,
                    onDone = {
                        nav.navigate(Routes.Calls) {
                            popUpTo(Routes.Setup) { inclusive = true }
                        }
                    }
                )
            }
            composable(Routes.Calls) { CallsScreen(vm = vm) }
            composable(Routes.Inbox) {
                InboxScreen(vm = vm, onOpenThread = { nav.navigate(Routes.thread(it)) })
            }
            composable(
                Routes.Thread,
                arguments = listOf(navArgument("threadId") { type = NavType.StringType })
            ) { entry ->
                val threadId = entry.arguments?.getString("threadId").orEmpty()
                ThreadScreen(vm = vm, threadId = threadId, onBack = { nav.popBackStack() })
            }
            composable(Routes.Agents) {
                AgentsScreen(vm = vm, onDial = { ext ->
                    vm.dial(ext)
                    nav.navigate(Routes.Calls) { launchSingleTop = true }
                })
            }
            composable(Routes.Hud) { HudScreen(vm = vm) }
            composable(Routes.Settings) {
                SettingsScreen(
                    vm = vm,
                    onOpenSetup = { nav.navigate(Routes.Setup) },
                    onOpenDiagnostics = { nav.navigate(Routes.Diagnostics) },
                    onOpenHistory = { nav.navigate(Routes.History) },
                    onOpenEnrollAgent = { nav.navigate(Routes.EnrollAgent) },
                    onOpenAgentConfig = { ext, name -> nav.navigate(Routes.agentConfig(ext, name)) }
                )
            }
            composable(
                Routes.AgentConfig,
                arguments = listOf(
                    navArgument("extension") { type = NavType.StringType },
                    navArgument("name") { type = NavType.StringType }
                )
            ) { entry ->
                val ext = entry.arguments?.getString("extension").orEmpty()
                val name = java.net.URLDecoder.decode(entry.arguments?.getString("name").orEmpty(), "UTF-8")
                AgentConfigScreen(vm = vm, extension = ext, agentName = name, onBack = { nav.popBackStack() })
            }
            composable(Routes.Diagnostics) { DiagnosticsScreen(vm = vm, onBack = { nav.popBackStack() }) }
            composable(Routes.History) { HistoryScreen(vm = vm, onBack = { nav.popBackStack() }) }
            composable(Routes.EnrollAgent) { EnrollAgentScreen(vm = vm, onBack = { nav.popBackStack() }) }
        }
    }
}

@Composable
private fun TopBar(title: String, statusLine: String, phoneState: com.agentphone.state.PhoneUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column {
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onBackground
            )
            Text(
                statusLine,
                style = MaterialTheme.typography.bodySmall,
                color = LocalSemanticColors.current.textMuted
            )
        }
        StatusPill(status = phoneState.connection)
    }
}

@Composable
private fun BottomBar(currentRoute: String?, onSelect: (String) -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            tabs.forEach { tab ->
                val selected = currentRoute == tab.route
                BottomTab(tab = tab, selected = selected, onClick = { onSelect(tab.route) })
            }
        }
    }
}

@Composable
private fun BottomTab(tab: TopTab, selected: Boolean, onClick: () -> Unit) {
    val semantic = LocalSemanticColors.current
    val bg = if (selected) MaterialTheme.colorScheme.background else Color.Transparent
    val fg = if (selected) MaterialTheme.colorScheme.primary else semantic.textMuted
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(bg)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick
            )
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(tab.icon, contentDescription = tab.label, tint = fg, modifier = Modifier.size(20.dp))
        AnimatedContent(
            targetState = selected,
            transitionSpec = {
                fadeIn(Motion.fast()) togetherWith fadeOut(Motion.fast())
            },
            label = "tab-label"
        ) { isSelected ->
            if (isSelected) {
                Text(
                    tab.label,
                    style = MaterialTheme.typography.titleSmall,
                    color = fg
                )
            } else {
                Box(modifier = Modifier.size(0.dp))
            }
        }
    }
}
