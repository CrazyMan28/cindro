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
import androidx.navigation.compose.currentBackStackEntryAsState
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
 * bottom tab OR a "More" hub row) is a plain sibling here, reached from ONE
 * sidebar drawer that wraps the whole app (not just chat) exactly like Claude/
 * ChatGPT: the hamburger is reachable from every page, tapping a drawer item
 * replaces whatever screen is showing. See docs/STATUS.md for the design writeup.
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

    // The sidebar's Recents/online data (HomeViewModel, unchanged) and the
    // drawer's own open/close state — hoisted once so the drawer is identical
    // and reachable no matter which screen is showing.
    val homeVm: HomeViewModel = viewModel(factory = HomeViewModel.factory(app))
    val homeState by homeVm.uiState.collectAsStateWithLifecycle()
    val conn by homeVm.connection.collectAsStateWithLifecycle()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val drawerScope = rememberCoroutineScope()
    val currentBackStackEntry by nav.currentBackStackEntryAsState()
    val currentRoute = currentBackStackEntry?.destination?.route
    val currentSessionId = if (currentRoute == Routes.CHAT) {
        currentBackStackEntry?.arguments?.getString("sessionId")
    } else null

    fun openDrawer() {
        drawerScope.launch { drawerState.open() }
    }

    /**
     * Every drawer action replaces whatever's currently showing rather than
     * stacking on top of it — the drawer is reachable from ANY screen now (not
     * just chat), so without this, repeated hops (Settings -> Canvas -> Sessions
     * -> …) would grow the back stack unboundedly. The one exception: CHAT_HOME
     * (the app's true root) is never popped, so back always has somewhere to land
     * instead of exiting the app.
     */
    fun navigateFromDrawer(route: String) {
        drawerScope.launch { drawerState.close() }
        val current = nav.currentBackStackEntry
        val atRoot = current?.destination?.route == Routes.CHAT_HOME
        nav.navigate(route) {
            current?.let { popUpTo(it.destination.id) { inclusive = !atRoot } }
            launchSingleTop = true
        }
    }

    fun openSessionFromDrawer(id: String) {
        if (currentRoute == Routes.CHAT && currentSessionId == id) {
            drawerScope.launch { drawerState.close() }
            return
        }
        navigateFromDrawer(Routes.chat(id))
    }

    fun newChatFromDrawer() {
        drawerScope.launch { drawerState.close() }
        nav.navigate(Routes.CHAT_HOME) {
            popUpTo(Routes.CHAT_HOME) { inclusive = true }
            launchSingleTop = true
        }
    }

    // Soft, dismissible warning if a reconnect's daemon identity fingerprint doesn't
    // match the one pinned at pairing time (see DeviceClient). Never blocks anything —
    // just an advisory the user can dismiss. Used to live inside the old bottom-tab
    // Shell (so it only covered its 6 tabs); hoisted above the WHOLE flat graph now
    // so it's visible no matter which drawer destination is open, not just former tabs.
    val identityWarning by app.repository.identityWarning.collectAsStateWithLifecycle()

    ModalNavigationDrawer(
        drawerState = drawerState,
        // No edge-swipe on the pre-pairing/2FA screens — there's nothing useful
        // in the drawer yet and neither screen has a hamburger to open it anyway.
        gesturesEnabled = currentRoute != Routes.PAIR && currentRoute != Routes.APPROVE,
        drawerContent = {
            AppDrawerContent(
                connection = conn,
                recents = homeState.sessions,
                isChatHome = currentRoute == Routes.CHAT_HOME,
                activeSessionId = currentSessionId,
                activeRoute = currentRoute,
                onNewChat = ::newChatFromDrawer,
                onOpenSession = ::openSessionFromDrawer,
                onNavigate = ::navigateFromDrawer,
            )
        },
    ) {
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

            composable(Routes.CHAT_HOME) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    NewChatScreen(
                        viewModel = homeVm,
                        state = homeState,
                        conn = conn,
                        onOpenDrawer = ::openDrawer,
                        onSessionCreated = { id -> nav.navigate(Routes.chat(id)) },
                        onOpenVoiceSession = { id -> nav.navigate(Routes.chat(id, wake = true)) },
                        onTakeOver = { navigateFromDrawer(Routes.COMPUTER) },
                        onCanvas = { navigateFromDrawer(Routes.CANVAS) },
                    )
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

            // Every destination below is gated behind the SAME app-open biometric
            // check as CHAT_HOME/CHAT (`Gated`, defined below AppNav), and every one
            // gets the SAME hamburger (`onOpenDrawer`) — reachable from anywhere,
            // not just chat, so you can jump straight from e.g. Settings to Canvas
            // without detouring back through chat first.
            composable(Routes.QUEUE) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: QueueViewModel = viewModel(factory = QueueViewModel.factory(app))
                    QueueScreen(viewModel = vm, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.MCP) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: McpViewModel = viewModel(factory = McpViewModel.factory(app))
                    McpScreen(viewModel = vm, activity = activity, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.PLUGINS) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: PluginsViewModel = viewModel(factory = PluginsViewModel.factory(app))
                    PluginsScreen(viewModel = vm, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.MEMORY) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: MemoryViewModel = viewModel(factory = MemoryViewModel.factory(app))
                    MemoryScreen(viewModel = vm, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.FILES) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    FilesScreen(app = app, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.SKILLS) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: SkillsViewModel = viewModel(factory = SkillsViewModel.factory(app))
                    SkillsScreen(viewModel = vm, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.AGENTS) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: AgentsViewModel = viewModel(factory = AgentsViewModel.factory(app))
                    AgentsScreen(
                        viewModel = vm,
                        activity = activity,
                        onOpenDrawer = ::openDrawer,
                        // Dispatching opens the spawned child session's chat.
                        onOpenChat = { sid -> nav.navigate(Routes.chat(sid)) },
                    )
                }
            }

            // Promoted from the old bottom-tab Shell — same screens/viewmodels as
            // before, just reached from the drawer instead of a tab bar.
            composable(Routes.SESSIONS) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: SessionsViewModel = viewModel(factory = SessionsViewModel.factory(app))
                    SessionsScreen(
                        viewModel = vm,
                        onOpenSession = { nav.navigate(Routes.chat(it)) },
                        onOpenDrawer = ::openDrawer,
                    )
                }
            }
            composable(Routes.CANVAS) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: CanvasViewModel = viewModel(factory = CanvasViewModel.factory(app))
                    CanvasScreen(viewModel = vm, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.COMPUTER) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val vm: ComputerViewModel = viewModel(factory = ComputerViewModel.factory(app))
                    ComputerScreen(viewModel = vm, activity = activity, onOpenDrawer = ::openDrawer)
                }
            }
            composable(Routes.PHONE) {
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    // The full Agent Phone app is vendored into this APK; the Phone
                    // destination launches the real com.agentphone.MainActivity (see
                    // PhoneLaunchScreen).
                    PhoneLaunchScreen(onOpenDrawer = ::openDrawer)
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
                        onOpenDrawer = ::openDrawer,
                    )
                }
            }

            composable(Routes.CHAT) { entry ->
                // The app-open fingerprint gate must hold on EVERY path into chat —
                // a notification tap / "Hey Cindro" wake deep-links straight here, so
                // without this check anyone could read private chat history from the
                // lock screen while CHAT_HOME was still gated underneath.
                Gated(appUnlocked, activity, { appUnlocked = true }) {
                    val sessionId = entry.arguments?.getString("sessionId").orEmpty()
                    val wake = entry.arguments?.getString("wake") == "true"
                    val vm: ChatViewModel = viewModel(
                        key = "chat-$sessionId",
                        factory = ChatViewModel.factory(app, sessionId),
                    )
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
 * `remember` state (not `rememberSaveable`), so it resets to locked on process
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
