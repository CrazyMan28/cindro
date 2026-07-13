package com.cindro.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.cindro.app.JarvisApp
import com.cindro.app.fcm.PushRegistrar
import com.cindro.app.ui.agents.AgentsScreen
import com.cindro.app.ui.agents.AgentsViewModel
import com.cindro.app.ui.auth.ApproveScreen
import com.cindro.app.ui.auth.GateScreen
import com.cindro.app.ui.canvas.CanvasScreen
import com.cindro.app.ui.canvas.CanvasViewModel
import com.cindro.app.ui.chat.ChatScreen
import com.cindro.app.ui.chat.ChatViewModel
import com.cindro.app.ui.chat.NewChatScreen
import com.cindro.app.ui.computer.ComputerScreen
import com.cindro.app.ui.computer.ComputerViewModel
import com.cindro.app.ui.drawer.AppDrawerContent
import com.cindro.app.ui.files.FilesScreen
import com.cindro.app.ui.home.HomeViewModel
import com.cindro.app.ui.mcp.McpScreen
import com.cindro.app.ui.mcp.McpViewModel
import com.cindro.app.ui.memory.MemoryScreen
import com.cindro.app.ui.memory.MemoryViewModel
import com.cindro.app.ui.pairing.PairScreen
import com.cindro.app.ui.pairing.PairingViewModel
import com.cindro.app.ui.phone.PhoneLaunchScreen
import com.cindro.app.ui.plugins.PluginsScreen
import com.cindro.app.ui.plugins.PluginsViewModel
import com.cindro.app.ui.queue.QueueScreen
import com.cindro.app.ui.queue.QueueViewModel
import com.cindro.app.ui.sessions.SessionsScreen
import com.cindro.app.ui.sessions.SessionsViewModel
import com.cindro.app.ui.settings.SettingsScreen
import com.cindro.app.ui.settings.SettingsViewModel
import com.cindro.app.ui.skills.SkillsScreen
import com.cindro.app.ui.skills.SkillsViewModel
import com.cindro.app.ui.theme.JarvisPalette
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import com.cindro.app.voice.WakeService
import kotlinx.coroutines.launch

/**
 * Flat, drawer-driven route table. The old two-tier nav (an outer graph plus an
 * inner bottom-tab "Shell") is gone — every promoted destination (formerly a
 * bottom tab OR a "More" hub row) is a plain sibling here, reached from the
 * sidebar drawer exactly like Claude/ChatGPT: tapping a drawer item pushes that
 * screen over chat, and back returns to chat. See docs/STATUS.md for the design
 * writeup.
 */
private object Routes {
    const val PAIR = "pair"
    const val CHAT_HOME = "chat_home"
    const val SESSIONS = "sessions"
    const val CANVAS = "canvas"
    const val COMPUTER = "computer"
    const val SKILLS = "skills"
    const val AGENTS = "agents"
    const val SETTINGS = "settings"
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

    val start = if (app.pairingStore.isPaired) Routes.CHAT_HOME else Routes.PAIR

    LaunchedEffect(app.pairingStore.isPaired) {
        if (app.pairingStore.isPaired) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PushRegistrar.syncCurrentToken(context)
            // Resume the "Hey Cindro" wake service if the user left it enabled.
            val micOk = ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED
            if (app.voiceSettings.wakeEnabled && micOk) WakeService.start(context)
        }
    }

    // Deep-link from an FCM tap or a "Hey Cindro" wake into a session's chat.
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
    // navigate from the session.create reply (NewChatScreen/SessionsScreen onCreated),
    // and JarvisConnectionService already posts a notification for every foreign
    // session.opened whose tap deep-links into chat (deepLinkSessionId above). So
    // there is deliberately NO auto-navigation collector here.

    // Deep-link from a tapped "Unlock Cindro" push into the Approve screen (the
    // phone leg of the 2FA + fingerprint cross-device unlock).
    LaunchedEffect(deepLinkAuthChallenge) {
        val cid = deepLinkAuthChallenge ?: return@LaunchedEffect
        if (app.pairingStore.isPaired && cid.isNotEmpty()) {
            // The app-open gate must still hold here — ApproveScreen's own
            // BiometricPrompt (the 2FA second factor) is what flips appUnlocked,
            // and only once it actually succeeds (see composable(APPROVE) below).
            nav.navigate(Routes.approve(cid))
            onDeepLinkConsumed()
        }
    }

    // Shared across CHAT_HOME + every live chat: the sidebar's Recents/online data
    // (HomeViewModel, unchanged — it already had exactly what the drawer needs) and
    // the drawer's own open/close state. Hoisted once here (not per-nav-entry) so
    // "New chat" / Recents behave identically no matter which chat you're viewing
    // from, and the drawer doesn't reset when you switch chats.
    val homeVm: HomeViewModel = viewModel(factory = HomeViewModel.factory(app))
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val drawerScope = rememberCoroutineScope()

    fun openDrawer() {
        drawerScope.launch { drawerState.open() }
    }

    fun closeDrawerThen(action: () -> Unit) {
        drawerScope.launch { drawerState.close() }
        action()
    }

    // Soft, dismissible warning if a reconnect's daemon identity fingerprint doesn't
    // match the one pinned at pairing time (see DeviceClient). Never blocks anything —
    // just an advisory the user can dismiss. Used to live inside the old bottom-tab
    // Shell (so it only covered its 6 tabs); hoisted above the WHOLE flat graph now
    // so it's visible no matter which drawer destination is open, not just former tabs.
    val identityWarning by app.repository.identityWarning.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxWidth()) {
        identityWarning?.let { msg ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(JarvisPalette.Error.copy(alpha = 0.15f))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    msg,
                    color = JarvisPalette.Error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { app.repository.dismissIdentityWarning() }) {
                    Text("Dismiss")
                }
            }
        }

        NavHost(
            navController = nav,
            startDestination = start,
            modifier = Modifier.weight(1f),
            // Detail screens (chat, sessions, canvas, …) slide in over whatever was
            // showing; back slides out. Every promoted former-tab/More-hub screen now
            // shares this one transition, instead of the old split between a tab
            // fade-through and a detail-screen slide.
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
                    nav.navigate(Routes.CHAT_HOME) {
                        popUpTo(Routes.PAIR) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.CHAT_HOME) { entry ->
            if (!appUnlocked) {
                GateScreen(activity = activity, onUnlocked = { appUnlocked = true })
            } else {
                val homeState by homeVm.uiState.collectAsStateWithLifecycle()
                val conn by homeVm.connection.collectAsStateWithLifecycle()
                ModalNavigationDrawer(
                    drawerState = drawerState,
                    drawerContent = {
                        AppDrawerContent(
                            connection = conn,
                            recents = homeState.sessions,
                            isChatHome = true,
                            activeSessionId = null,
                            onNewChat = { drawerScope.launch { drawerState.close() } },
                            onOpenSession = { id -> closeDrawerThen { nav.navigate(Routes.chat(id)) } },
                            onNavigate = { route ->
                                // Drawer destinations always sit exactly one level above
                                // whichever chat they were opened from — pop back to THIS
                                // entry first so repeated drawer hops don't stack (the old
                                // tab bar's switchTab() had the same "never grows" property
                                // via popUpTo the start tab).
                                closeDrawerThen {
                                    nav.navigate(route) {
                                        popUpTo(entry.destination.id) { inclusive = false }
                                        launchSingleTop = true
                                    }
                                }
                            },
                        )
                    },
                ) {
                    NewChatScreen(
                        viewModel = homeVm,
                        onOpenDrawer = ::openDrawer,
                        onSessionCreated = { id -> nav.navigate(Routes.chat(id)) },
                        onOpenVoiceSession = { id -> nav.navigate(Routes.chat(id, wake = true)) },
                        onTakeOver = { nav.navigate(Routes.COMPUTER) { launchSingleTop = true } },
                        onCanvas = { nav.navigate(Routes.CANVAS) { launchSingleTop = true } },
                    )
                }
            }
        }

        composable(Routes.APPROVE) { entry ->
            val cid = entry.arguments?.getString("challengeId").orEmpty()
            ApproveScreen(
                app = app,
                activity = activity,
                challengeId = cid,
                // Flip the app-open gate open ONLY once ApproveScreen's own
                // BiometricPrompt actually succeeds — never preemptively — so a
                // failed/cancelled approval still re-gates the shell behind GateScreen.
                onUnlocked = { appUnlocked = true },
                onDone = {
                    if (!nav.popBackStack()) {
                        nav.navigate(Routes.CHAT_HOME) {
                            popUpTo(Routes.APPROVE) { inclusive = true }
                        }
                    }
                },
            )
        }

        // Every destination below is gated behind the SAME app-open biometric check
        // as CHAT_HOME/CHAT (`Gated`, defined below AppNav). Sessions/Canvas/Computer/
        // Phone/Settings used to be safe INSIDE the old bottom-tab Shell (which was
        // itself gated); promoting them to top-level routes silently dropped that
        // check — restored here. Skills/Agents/Queue/MCP/Plugins/Memory/Files were
        // ALREADY separate top-level routes with no gate even before this redesign;
        // fixed here too rather than leaving a known gap in a file already being
        // restructured.
        composable(Routes.QUEUE) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: QueueViewModel = viewModel(factory = QueueViewModel.factory(app))
                QueueScreen(viewModel = vm)
            }
        }
        composable(Routes.MCP) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: McpViewModel = viewModel(factory = McpViewModel.factory(app))
                McpScreen(viewModel = vm, activity = activity)
            }
        }
        composable(Routes.PLUGINS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: PluginsViewModel = viewModel(factory = PluginsViewModel.factory(app))
                PluginsScreen(viewModel = vm)
            }
        }
        composable(Routes.MEMORY) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: MemoryViewModel = viewModel(factory = MemoryViewModel.factory(app))
                MemoryScreen(viewModel = vm)
            }
        }
        composable(Routes.FILES) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                FilesScreen(app = app)
            }
        }
        composable(Routes.SKILLS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: SkillsViewModel = viewModel(factory = SkillsViewModel.factory(app))
                SkillsScreen(viewModel = vm)
            }
        }
        composable(Routes.AGENTS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: AgentsViewModel = viewModel(factory = AgentsViewModel.factory(app))
                AgentsScreen(
                    viewModel = vm,
                    activity = activity,
                    // Dispatching opens the spawned child session's chat.
                    onOpenChat = { sid -> nav.navigate(Routes.chat(sid)) },
                )
            }
        }

        // Promoted from the old bottom-tab Shell — same screens/viewmodels as
        // before, just reached from the drawer instead of a tab bar, each now
        // wired with its own back arrow (they used to rely on being a tab, with
        // no back concept) that pops back to whichever chat opened them.
        composable(Routes.SESSIONS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: SessionsViewModel = viewModel(factory = SessionsViewModel.factory(app))
                SessionsScreen(
                    viewModel = vm,
                    onOpenSession = { nav.navigate(Routes.chat(it)) },
                    onBack = { nav.popBackStack() },
                )
            }
        }
        composable(Routes.CANVAS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: CanvasViewModel = viewModel(factory = CanvasViewModel.factory(app))
                CanvasScreen(viewModel = vm, onBack = { nav.popBackStack() })
            }
        }
        composable(Routes.COMPUTER) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: ComputerViewModel = viewModel(factory = ComputerViewModel.factory(app))
                ComputerScreen(viewModel = vm, activity = activity, onBack = { nav.popBackStack() })
            }
        }
        composable(Routes.PHONE) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                // The full Agent Phone app is vendored into this APK; the Phone
                // destination launches the real com.agentphone.MainActivity (see
                // PhoneLaunchScreen).
                PhoneLaunchScreen(onBack = { nav.popBackStack() })
            }
        }
        composable(Routes.SETTINGS) {
            Gated(appUnlocked, activity, { appUnlocked = true }) {
                val vm: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(app))
                SettingsScreen(
                    viewModel = vm,
                    activity = activity,
                    onUnpaired = {
                        nav.navigate(Routes.PAIR) {
                            popUpTo(nav.graph.findStartDestination().id) { inclusive = true }
                        }
                    },
                    onBack = { nav.popBackStack() },
                )
            }
        }

        composable(Routes.CHAT) { entry ->
            // The app-open fingerprint gate must hold on EVERY path into chat —
            // a notification tap / "Hey Cindro" wake deep-links straight here, so
            // without this check anyone could read private chat history from the
            // lock screen while CHAT_HOME was still gated underneath. Gate the
            // chat route itself (same GateScreen as CHAT_HOME) so no entry bypasses it.
            if (!appUnlocked) {
                GateScreen(activity = activity, onUnlocked = { appUnlocked = true })
            } else {
                val sessionId = entry.arguments?.getString("sessionId").orEmpty()
                val wake = entry.arguments?.getString("wake") == "true"
                val vm: ChatViewModel = viewModel(
                    key = "chat-$sessionId",
                    factory = ChatViewModel.factory(app, sessionId),
                )
                val homeState by homeVm.uiState.collectAsStateWithLifecycle()
                val conn by homeVm.connection.collectAsStateWithLifecycle()
                ModalNavigationDrawer(
                    drawerState = drawerState,
                    drawerContent = {
                        AppDrawerContent(
                            connection = conn,
                            recents = homeState.sessions,
                            isChatHome = false,
                            activeSessionId = sessionId,
                            onNewChat = {
                                closeDrawerThen {
                                    nav.navigate(Routes.CHAT_HOME) {
                                        popUpTo(Routes.CHAT_HOME) { inclusive = true }
                                        launchSingleTop = true
                                    }
                                }
                            },
                            onOpenSession = { id ->
                                closeDrawerThen { if (id != sessionId) nav.navigate(Routes.chat(id)) }
                            },
                            onNavigate = { route ->
                                closeDrawerThen {
                                    nav.navigate(route) {
                                        popUpTo(entry.destination.id) { inclusive = false }
                                        launchSingleTop = true
                                    }
                                }
                            },
                        )
                    },
                ) {
                    ChatScreen(
                        viewModel = vm,
                        activity = activity,
                        onOpenDrawer = ::openDrawer,
                        autoStartVoice = wake,
                    )
                }
            }
        }
        }
    }
}

/**
 * The app-open biometric/2FA gate every non-pairing, non-approve destination must
 * pass through — same check CHAT_HOME/CHAT apply inline. `appUnlocked` is plain
 * `remember` state (not rememberSaveable), so it resets to locked on process
 * recreation; without this wrapper a saved-back-stack restore straight onto e.g.
 * Canvas after process death would render private content with no gate at all.
 */
@Composable
private fun Gated(
    appUnlocked: Boolean,
    activity: FragmentActivity,
    onUnlocked: () -> Unit,
    content: @Composable () -> Unit,
) {
    if (!appUnlocked) GateScreen(activity = activity, onUnlocked = onUnlocked) else content()
}
