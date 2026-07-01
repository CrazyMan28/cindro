package com.jarvis.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.jarvis.app.JarvisApp
import com.jarvis.app.fcm.PushRegistrar
import com.jarvis.app.ui.auth.ApproveScreen
import com.jarvis.app.ui.auth.GateScreen
import com.jarvis.app.ui.canvas.CanvasScreen
import com.jarvis.app.ui.canvas.CanvasViewModel
import com.jarvis.app.ui.chat.ChatScreen
import com.jarvis.app.ui.chat.ChatViewModel
import com.jarvis.app.ui.computer.ComputerScreen
import com.jarvis.app.ui.computer.ComputerViewModel
import com.jarvis.app.ui.home.HomeScreen
import com.jarvis.app.ui.home.HomeViewModel
import com.jarvis.app.ui.files.FilesScreen
import com.jarvis.app.ui.mcp.McpScreen
import com.jarvis.app.ui.mcp.McpViewModel
import com.jarvis.app.ui.memory.MemoryScreen
import com.jarvis.app.ui.memory.MemoryViewModel
import com.jarvis.app.ui.more.MoreScreen
import com.jarvis.app.ui.pairing.PairScreen
import com.jarvis.app.ui.pairing.PairingViewModel
import com.jarvis.app.ui.plugins.PluginsScreen
import com.jarvis.app.ui.plugins.PluginsViewModel
import com.jarvis.app.ui.queue.QueueScreen
import com.jarvis.app.ui.queue.QueueViewModel
import com.jarvis.app.ui.sessions.SessionsScreen
import com.jarvis.app.ui.sessions.SessionsViewModel
import com.jarvis.app.ui.settings.SettingsScreen
import com.jarvis.app.ui.settings.SettingsViewModel
import com.jarvis.app.ui.agents.AgentsScreen
import com.jarvis.app.ui.agents.AgentsViewModel
import com.jarvis.app.ui.phone.PhoneLaunchScreen
import com.jarvis.app.ui.skills.SkillsScreen
import com.jarvis.app.ui.skills.SkillsViewModel
import com.jarvis.app.ui.theme.JarvisPalette
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import com.jarvis.app.voice.WakeService

private object Routes {
    const val PAIR = "pair"
    const val SHELL = "shell"
    const val HOME = "home"
    const val SESSIONS = "sessions"
    const val CANVAS = "canvas"
    const val COMPUTER = "computer"
    const val SKILLS = "skills"
    const val AGENTS = "agents"
    const val SETTINGS = "settings"
    const val MORE = "more"
    const val QUEUE = "queue"
    const val MCP = "mcp"
    const val PLUGINS = "plugins"
    const val MEMORY = "memory"
    const val FILES = "files"
    const val PHONE = "phone"
    const val CHAT = "chat/{sessionId}?wake={wake}"
    fun chat(id: String, wake: Boolean = false) = "chat/$id?wake=$wake"
    // 2FA + fingerprint cross-device unlock — the phone Approve leg.
    const val APPROVE = "approve/{challengeId}"
    fun approve(challengeId: String) = "approve/$challengeId"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab(Routes.HOME, "Home", Icons.Filled.Home),
    Tab(Routes.SESSIONS, "Chat", Icons.AutoMirrored.Filled.Chat),
    Tab(Routes.CANVAS, "Canvas", Icons.Filled.Dashboard),
    Tab(Routes.COMPUTER, "Computer", Icons.Filled.Computer),
    Tab(Routes.PHONE, "Phone", Icons.Filled.Phone),
    Tab(Routes.SETTINGS, "Settings", Icons.Filled.Settings),
)

@Composable
fun AppNav(
    app: JarvisApp,
    activity: FragmentActivity,
    deepLinkSessionId: String?,
    deepLinkWake: Boolean,
    deepLinkAuthChallenge: String? = null,
    onDeepLinkConsumed: () -> Unit,
) {
    val nav = rememberNavController()
    val context = LocalContext.current

    // 2FA + fingerprint app-open gate: when paired AND the gate is enabled, hold
    // the shell behind a BiometricPrompt for THIS app launch. Fail-open lives in
    // GateScreen (Biometric.authenticate returns true when no secure lock exists).
    var appUnlocked by remember {
        mutableStateOf(!(app.pairingStore.isPaired && app.appPrefs.fingerprintGateEnabled))
    }

    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* advisory */ }

    val start = if (app.pairingStore.isPaired) Routes.SHELL else Routes.PAIR

    LaunchedEffect(app.pairingStore.isPaired) {
        if (app.pairingStore.isPaired) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PushRegistrar.syncCurrentToken(context)
            // Resume the "Hey Jarvis" wake service if the user left it enabled.
            val micOk = ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED
            if (app.voiceSettings.wakeEnabled && micOk) WakeService.start(context)
        }
    }

    // Deep-link from an FCM tap or a "Hey Jarvis" wake into a session's chat.
    LaunchedEffect(deepLinkSessionId, deepLinkWake) {
        val sid = deepLinkSessionId ?: return@LaunchedEffect
        if (app.pairingStore.isPaired) {
            nav.navigate(Routes.chat(sid, deepLinkWake))
            onDeepLinkConsumed()
        }
    }

    // A session created on ANOTHER surface (desktop/MCP/scheduler) must NEVER yank
    // this phone into its chat — starting a chat on the desktop and then opening
    // the app dropped you straight inside that session. The phone's OWN creations
    // navigate from the session.create reply (HomeScreen/SessionsScreen onCreated),
    // and JarvisConnectionService already posts a notification for every foreign
    // session.opened whose tap deep-links into chat (deepLinkSessionId above). So
    // there is deliberately NO auto-navigation collector here.

    // Deep-link from a tapped "Unlock Jarvis" push into the Approve screen (the
    // phone leg of the 2FA + fingerprint cross-device unlock).
    LaunchedEffect(deepLinkAuthChallenge) {
        val cid = deepLinkAuthChallenge ?: return@LaunchedEffect
        if (app.pairingStore.isPaired && cid.isNotEmpty()) {
            // Approving requires the device WS + BiometricPrompt — consider the
            // app unlocked for this launch so the gate doesn't double-prompt.
            appUnlocked = true
            nav.navigate(Routes.approve(cid))
            onDeepLinkConsumed()
        }
    }

    NavHost(
        navController = nav,
        startDestination = start,
        // Detail screens (chat, more, …) slide in over the shell; back slides out.
        enterTransition = { slideInHorizontally(tween(220)) { it / 3 } + fadeIn(tween(220)) },
        exitTransition = { fadeOut(tween(140)) },
        popEnterTransition = { fadeIn(tween(180)) },
        popExitTransition = { slideOutHorizontally(tween(200)) { it / 3 } + fadeOut(tween(180)) },
    ) {
        composable(Routes.PAIR) {
            val vm: PairingViewModel = viewModel(factory = PairingViewModel.factory(app))
            PairScreen(
                viewModel = vm,
                onPaired = {
                    nav.navigate(Routes.SHELL) {
                        popUpTo(Routes.PAIR) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.SHELL) {
            if (!appUnlocked) {
                GateScreen(activity = activity, onUnlocked = { appUnlocked = true })
            } else {
                Shell(app = app, activity = activity, parentNav = nav)
            }
        }

        composable(Routes.APPROVE) { entry ->
            val cid = entry.arguments?.getString("challengeId").orEmpty()
            ApproveScreen(
                app = app,
                activity = activity,
                challengeId = cid,
                onDone = {
                    if (!nav.popBackStack()) {
                        nav.navigate(Routes.SHELL) {
                            popUpTo(Routes.APPROVE) { inclusive = true }
                        }
                    }
                },
            )
        }

        composable(Routes.MORE) {
            MoreScreen(onBack = { nav.popBackStack() }, onOpen = { nav.navigate(it) })
        }
        composable(Routes.QUEUE) {
            val vm: QueueViewModel = viewModel(factory = QueueViewModel.factory(app))
            QueueScreen(viewModel = vm)
        }
        composable(Routes.MCP) {
            val vm: McpViewModel = viewModel(factory = McpViewModel.factory(app))
            McpScreen(viewModel = vm, activity = activity)
        }
        composable(Routes.PLUGINS) {
            val vm: PluginsViewModel = viewModel(factory = PluginsViewModel.factory(app))
            PluginsScreen(viewModel = vm)
        }
        composable(Routes.MEMORY) {
            val vm: MemoryViewModel = viewModel(factory = MemoryViewModel.factory(app))
            MemoryScreen(viewModel = vm)
        }
        composable(Routes.FILES) {
            FilesScreen(app = app)
        }
        composable(Routes.SKILLS) {
            val vm: SkillsViewModel = viewModel(factory = SkillsViewModel.factory(app))
            SkillsScreen(viewModel = vm)
        }
        composable(Routes.AGENTS) {
            val vm: AgentsViewModel = viewModel(factory = AgentsViewModel.factory(app))
            AgentsScreen(
                viewModel = vm,
                // Dispatching opens the spawned child session's chat.
                onOpenChat = { sid -> nav.navigate(Routes.chat(sid)) },
            )
        }

        composable(Routes.CHAT) { entry ->
            val sessionId = entry.arguments?.getString("sessionId").orEmpty()
            val wake = entry.arguments?.getString("wake") == "true"
            val vm: ChatViewModel = viewModel(
                key = "chat-$sessionId",
                factory = ChatViewModel.factory(app, sessionId),
            )
            ChatScreen(
                viewModel = vm,
                activity = activity,
                onBack = { nav.popBackStack() },
                autoStartVoice = wake,
            )
        }
    }
}

/** The authed app shell: a bottom-nav over Sessions / Computer / Skills / Settings. */
@Composable
private fun Shell(app: JarvisApp, activity: FragmentActivity, parentNav: NavHostController) {
    val tabNav = rememberNavController()
    val backStack by tabNav.currentBackStackEntryAsState()
    val current = backStack?.destination
    val haptics = com.jarvis.app.ui.util.LocalHaptics.current

    fun switchTab(route: String) {
        tabNav.navigate(route) {
            popUpTo(tabNav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    Scaffold(
        containerColor = JarvisPalette.Background,
        bottomBar = {
            NavigationBar(containerColor = JarvisPalette.Surface) {
                tabs.forEach { tab ->
                    val selected = current?.hierarchy?.any { it.route == tab.route } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = { haptics?.tap(); switchTab(tab.route) },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = JarvisPalette.OnAccent,
                            selectedTextColor = JarvisPalette.Accent,
                            indicatorColor = JarvisPalette.Accent,
                            unselectedIconColor = JarvisPalette.TextSecondary,
                            unselectedTextColor = JarvisPalette.TextSecondary,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = tabNav,
            startDestination = Routes.HOME,
            modifier = Modifier.padding(padding),
            // Fade-through between tabs (Material 3 Expressive motion) instead of a hard cut.
            enterTransition = { fadeIn(tween(190)) + scaleIn(initialScale = 0.985f, animationSpec = tween(190)) },
            exitTransition = { fadeOut(tween(110)) },
            popEnterTransition = { fadeIn(tween(190)) },
            popExitTransition = { fadeOut(tween(110)) },
        ) {
            composable(Routes.HOME) {
                val vm: HomeViewModel = viewModel(factory = HomeViewModel.factory(app))
                HomeScreen(
                    viewModel = vm,
                    onOpenSession = { parentNav.navigate(Routes.chat(it)) },
                    onOpenVoice = { parentNav.navigate(Routes.chat(it, wake = true)) },
                    onAllSessions = { switchTab(Routes.SESSIONS) },
                    onTakeOver = { switchTab(Routes.COMPUTER) },
                    onCanvas = { switchTab(Routes.CANVAS) },
                )
            }
            composable(Routes.SESSIONS) {
                val vm: SessionsViewModel = viewModel(factory = SessionsViewModel.factory(app))
                SessionsScreen(
                    viewModel = vm,
                    onOpenSession = { parentNav.navigate(Routes.chat(it)) },
                    onOpenMore = { parentNav.navigate(Routes.MORE) },
                )
            }
            composable(Routes.CANVAS) {
                val vm: CanvasViewModel = viewModel(factory = CanvasViewModel.factory(app))
                CanvasScreen(viewModel = vm)
            }
            composable(Routes.COMPUTER) {
                val vm: ComputerViewModel = viewModel(factory = ComputerViewModel.factory(app))
                ComputerScreen(viewModel = vm, activity = activity)
            }
            composable(Routes.PHONE) {
                // The full Agent Phone app is vendored into this APK; the Phone tab
                // launches the real com.agentphone.MainActivity (see PhoneLaunchScreen).
                PhoneLaunchScreen()
            }
            composable(Routes.SETTINGS) {
                val vm: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(app))
                SettingsScreen(
                    viewModel = vm,
                    activity = activity,
                    onUnpaired = {
                        parentNav.navigate(Routes.PAIR) {
                            popUpTo(Routes.SHELL) { inclusive = true }
                        }
                    },
                )
            }
        }
    }
}
