package com.jarvis.app.ui.phone

import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.jarvis.app.ui.theme.JarvisPalette
import com.jarvis.app.ui.theme.StatusPill

// ─────────────────────────────────────────────────────────────────────────────
// Internal routes
// ─────────────────────────────────────────────────────────────────────────────

internal object PhoneRoutes {
    const val CALLS     = "calls"
    const val INBOX     = "inbox"
    const val AGENTS    = "agents"
    const val HUD       = "hud"
    const val SETTINGS  = "settings"
    const val THREAD    = "thread/{threadId}"
    const val AGENT_CONFIG = "agent-config/{ext}/{agentName}"
    const val DIAGNOSTICS = "diagnostics"
    const val HISTORY   = "history"
    const val ENROLL    = "enroll"
    const val SETUP     = "setup"

    fun thread(id: String) = "thread/$id"
    fun agentConfig(ext: String, name: String) = "agent-config/$ext/${Uri.encode(name)}"
}

private val TAB_ROUTES = setOf(
    PhoneRoutes.CALLS,
    PhoneRoutes.INBOX,
    PhoneRoutes.AGENTS,
    PhoneRoutes.HUD,
    PhoneRoutes.SETTINGS,
)

private data class PhoneTabItem(val tab: PhoneTab, val route: String, val icon: ImageVector, val label: String)

private val PHONE_TABS = listOf(
    PhoneTabItem(PhoneTab.CALLS,    PhoneRoutes.CALLS,    Icons.Filled.Phone,    "Calls"),
    PhoneTabItem(PhoneTab.INBOX,    PhoneRoutes.INBOX,    Icons.Filled.Inbox,    "Inbox"),
    PhoneTabItem(PhoneTab.AGENTS,   PhoneRoutes.AGENTS,   Icons.Filled.SmartToy, "Agents"),
    PhoneTabItem(PhoneTab.HUD,      PhoneRoutes.HUD,      Icons.Filled.Dashboard,"HUD"),
    PhoneTabItem(PhoneTab.SETTINGS, PhoneRoutes.SETTINGS, Icons.Filled.Settings, "Settings"),
)

// ─────────────────────────────────────────────────────────────────────────────
// PhoneScreen — full-screen phone section host
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full-screen phone section.  The Jarvis shell hides its main bottom nav when
 * this composable is on screen, so Phone owns the entire content area.
 *
 * @param onBack  Called when the user taps the "back to Jarvis" arrow in the
 *                top-bar.  Wired by Shell to `switchTab(Routes.HOME)`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneScreen(viewModel: PhoneViewModel, onBack: () -> Unit = {}) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val phoneNav = rememberNavController()
    val backStack by phoneNav.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    LaunchedEffect(Unit) { viewModel.refresh() }

    // ── Full-screen incoming call overlay ─────────────────────────────────
    AnimatedVisibility(
        visible = state.incomingCall != null,
        enter = fadeIn(tween(180)),
        exit  = fadeOut(tween(180)),
    ) {
        state.incomingCall?.let { call ->
            IncomingCallScreen(
                call      = call,
                onAccept  = { viewModel.acceptCall(call.id) },
                onDecline = { viewModel.declineCall(call.id) },
            )
        }
    }
    if (state.incomingCall != null) return

    // ── Route → top-bar title ─────────────────────────────────────────────
    val title = when {
        currentRoute == PhoneRoutes.CALLS      -> "Calls"
        currentRoute == PhoneRoutes.INBOX      -> "Inbox"
        currentRoute == PhoneRoutes.AGENTS     -> "Agents"
        currentRoute == PhoneRoutes.HUD        -> "HUD"
        currentRoute == PhoneRoutes.SETTINGS   -> "Settings"
        currentRoute == PhoneRoutes.THREAD     -> "Thread"
        currentRoute == PhoneRoutes.AGENT_CONFIG -> "Agent Config"
        currentRoute == PhoneRoutes.DIAGNOSTICS -> "Diagnostics"
        currentRoute == PhoneRoutes.HISTORY    -> "Call History"
        currentRoute == PhoneRoutes.ENROLL     -> "Enroll Agent"
        currentRoute == PhoneRoutes.SETUP      -> "Phone Setup"
        else -> "Phone"
    }
    val isTabScreen = currentRoute in TAB_ROUTES

    fun switchPhoneTab(route: String) {
        phoneNav.navigate(route) {
            popUpTo(phoneNav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState    = true
        }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (isTabScreen) {
                        // Back arrow exits Phone section → rest of Jarvis
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back to Jarvis",
                                tint = JarvisPalette.TextSecondary,
                            )
                        }
                    } else {
                        // Back arrow pops the sub-screen
                        IconButton(onClick = { phoneNav.popBackStack() }) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = "Back",
                                tint = JarvisPalette.Accent,
                            )
                        }
                    }
                },
                title = {
                    Column {
                        Text(
                            title,
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                            color = JarvisPalette.TextPrimary,
                        )
                        if (state.statusLine.isNotBlank()) {
                            StatusPill(
                                text  = state.statusLine.uppercase(),
                                color = if (state.statusLine == "connected") JarvisPalette.Success
                                        else JarvisPalette.TextFaint,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = JarvisPalette.Accent)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = JarvisPalette.Background),
            )
        },
        bottomBar = {
            if (isTabScreen) {
                NavigationBar(containerColor = JarvisPalette.Surface) {
                    PHONE_TABS.forEach { item ->
                        val selected = currentRoute == item.route
                        NavigationBarItem(
                            selected = selected,
                            onClick  = { switchPhoneTab(item.route) },
                            icon     = { Icon(item.icon, contentDescription = item.label) },
                            label    = { Text(item.label) },
                            colors   = NavigationBarItemDefaults.colors(
                                selectedIconColor   = JarvisPalette.OnAccent,
                                selectedTextColor   = JarvisPalette.Accent,
                                indicatorColor      = JarvisPalette.Accent,
                                unselectedIconColor = JarvisPalette.TextSecondary,
                                unselectedTextColor = JarvisPalette.TextSecondary,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // ── Global error / toast banners ──────────────────────────────
            AnimatedVisibility(visible = state.error != null) {
                state.error?.let { err ->
                    Text(
                        err,
                        color  = JarvisPalette.Error,
                        style  = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(JarvisPalette.Error.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
            AnimatedVisibility(visible = state.toast != null) {
                state.toast?.let { msg ->
                    Text(
                        msg,
                        color  = JarvisPalette.Success,
                        style  = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(JarvisPalette.Success.copy(alpha = 0.08f))
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }

            // ── Internal NavHost ──────────────────────────────────────────
            NavHost(
                navController   = phoneNav,
                startDestination = PhoneRoutes.CALLS,
                modifier         = Modifier.weight(1f),
            ) {
                composable(PhoneRoutes.CALLS) {
                    PhoneCallsScreen(state = state, viewModel = viewModel)
                }
                composable(PhoneRoutes.INBOX) {
                    PhoneInboxScreen(
                        state    = state,
                        viewModel = viewModel,
                        onOpenThread = { phoneNav.navigate(PhoneRoutes.thread(it)) },
                    )
                }
                composable(PhoneRoutes.AGENTS) {
                    PhoneAgentsScreen(
                        state    = state,
                        viewModel = viewModel,
                        onConfig = { ext, name ->
                            phoneNav.navigate(PhoneRoutes.agentConfig(ext, name))
                        },
                    )
                }
                composable(PhoneRoutes.HUD) {
                    PhoneHudScreen(state = state, viewModel = viewModel)
                }
                composable(PhoneRoutes.SETTINGS) {
                    PhoneSettingsScreen(
                        state    = state,
                        viewModel = viewModel,
                        onDiagnostics = { phoneNav.navigate(PhoneRoutes.DIAGNOSTICS) },
                        onHistory     = { phoneNav.navigate(PhoneRoutes.HISTORY) },
                        onEnroll      = { phoneNav.navigate(PhoneRoutes.ENROLL) },
                        onSetup       = { phoneNav.navigate(PhoneRoutes.SETUP) },
                        onAgentConfig = { ext: String, name: String ->
                            phoneNav.navigate(PhoneRoutes.agentConfig(ext, name))
                        },
                    )
                }

                // Sub-screens
                composable(PhoneRoutes.THREAD) { entry ->
                    val threadId = entry.arguments?.getString("threadId").orEmpty()
                    LaunchedEffect(threadId) { viewModel.loadThread(threadId) }
                    PhoneThreadScreen(state = state, viewModel = viewModel, threadId = threadId)
                }
                composable(PhoneRoutes.AGENT_CONFIG) { entry ->
                    val ext  = entry.arguments?.getString("ext").orEmpty()
                    val name = Uri.decode(entry.arguments?.getString("agentName").orEmpty())
                    LaunchedEffect(ext) {
                        viewModel.listVoices()
                        viewModel.getVoiceProfile(ext)
                        viewModel.getModelConfig(ext)
                    }
                    PhoneAgentConfigScreen(
                        state     = state,
                        viewModel = viewModel,
                        extension = ext,
                        agentName = name,
                    )
                }
                composable(PhoneRoutes.DIAGNOSTICS) {
                    LaunchedEffect(Unit) { viewModel.runDiagnostics() }
                    PhoneDiagnosticsScreen(state = state, viewModel = viewModel)
                }
                composable(PhoneRoutes.HISTORY) {
                    LaunchedEffect(Unit) { viewModel.loadHistory() }
                    PhoneHistoryScreen(state = state, viewModel = viewModel)
                }
                composable(PhoneRoutes.ENROLL) {
                    PhoneEnrollScreen(state = state, viewModel = viewModel)
                }
                composable(PhoneRoutes.SETUP) {
                    PhoneSetupScreen(state = state, viewModel = viewModel)
                }
            }
        }
    }
}
