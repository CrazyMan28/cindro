package com.jarvis.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Schedule
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
import com.jarvis.app.ui.chat.ChatScreen
import com.jarvis.app.ui.chat.ChatViewModel
import com.jarvis.app.ui.pairing.PairScreen
import com.jarvis.app.ui.pairing.PairingViewModel
import com.jarvis.app.ui.queue.QueueScreen
import com.jarvis.app.ui.queue.QueueViewModel
import com.jarvis.app.ui.sessions.SessionsScreen
import com.jarvis.app.ui.sessions.SessionsViewModel
import com.jarvis.app.ui.settings.SettingsScreen
import com.jarvis.app.ui.settings.SettingsViewModel
import com.jarvis.app.ui.theme.JarvisPalette

private object Routes {
    const val PAIR = "pair"
    const val SHELL = "shell"
    const val SESSIONS = "sessions"
    const val QUEUE = "queue"
    const val SETTINGS = "settings"
    const val CHAT = "chat/{sessionId}"
    fun chat(id: String) = "chat/$id"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val tabs = listOf(
    Tab(Routes.SESSIONS, "Sessions", Icons.AutoMirrored.Filled.List),
    Tab(Routes.QUEUE, "Queue", Icons.Filled.Schedule),
    Tab(Routes.SETTINGS, "Settings", Icons.Filled.Settings),
)

@Composable
fun AppNav(
    app: JarvisApp,
    activity: FragmentActivity,
    deepLinkSessionId: String?,
    onDeepLinkConsumed: () -> Unit,
) {
    val nav = rememberNavController()
    val context = LocalContext.current

    // Ask for notification permission once we're past pairing (API 33+).
    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* result is advisory; FCM still works, just no UI alerts if denied */ }

    val start = if (app.pairingStore.isPaired) Routes.SHELL else Routes.PAIR

    LaunchedEffect(app.pairingStore.isPaired) {
        if (app.pairingStore.isPaired) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PushRegistrar.syncCurrentToken(context)
        }
    }

    // Deep-link from an FCM tap straight into the chat.
    LaunchedEffect(deepLinkSessionId) {
        val sid = deepLinkSessionId ?: return@LaunchedEffect
        if (app.pairingStore.isPaired) {
            nav.navigate(Routes.chat(sid))
            onDeepLinkConsumed()
        }
    }

    NavHost(navController = nav, startDestination = start) {
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
            Shell(app = app, activity = activity, parentNav = nav)
        }

        composable(Routes.CHAT) { entry ->
            val sessionId = entry.arguments?.getString("sessionId").orEmpty()
            val vm: ChatViewModel = viewModel(
                key = "chat-$sessionId",
                factory = ChatViewModel.factory(app, sessionId),
            )
            ChatScreen(viewModel = vm, activity = activity, onBack = { nav.popBackStack() })
        }
    }
}

/** The authed app shell: a bottom-nav over Sessions / Queue / Settings. */
@Composable
private fun Shell(app: JarvisApp, activity: FragmentActivity, parentNav: NavHostController) {
    val tabNav = rememberNavController()
    val backStack by tabNav.currentBackStackEntryAsState()
    val current = backStack?.destination

    Scaffold(
        containerColor = JarvisPalette.Background,
        bottomBar = {
            NavigationBar(containerColor = JarvisPalette.Surface) {
                tabs.forEach { tab ->
                    val selected = current?.hierarchy?.any { it.route == tab.route } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            tabNav.navigate(tab.route) {
                                popUpTo(tabNav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
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
            startDestination = Routes.SESSIONS,
            modifier = Modifier.padding(padding),
        ) {
            composable(Routes.SESSIONS) {
                val vm: SessionsViewModel = viewModel(factory = SessionsViewModel.factory(app))
                SessionsScreen(viewModel = vm, onOpenSession = { parentNav.navigate(Routes.chat(it)) })
            }
            composable(Routes.QUEUE) {
                val vm: QueueViewModel = viewModel(factory = QueueViewModel.factory(app))
                QueueScreen(viewModel = vm)
            }
            composable(Routes.SETTINGS) {
                val vm: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(app))
                SettingsScreen(
                    viewModel = vm,
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
