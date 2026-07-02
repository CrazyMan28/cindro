import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import JarvisSidebar

// AppShell — the full multi-page application body. A slim left NavRail routes
// between the pages rendered in the content area on the right:
//   0 Home · 1 Chat · 2 Voice · 3 Computer · 4 Canvas · 5 Widgets · 6 Sessions ·
//   7 Memory · 8 Skills · 9 Agents · 10 Schedules · 11 Activity · 12 Graph ·
//   13 MCP · 14 Plugins · 15 SSH · 16 Phone · 17 Settings.
//
// NOTE: this switch + NavRail.items MUST stay in lock-step (same order, same
// length). The page Repeater derives its count from rail.items.length so adding
// a page can never silently leave the LAST page unrenderable again (Settings
// was blank for anyone clicking it: 18 nav items, `model: 17`).
//
// This is the single shared content surface reparented between the floating
// window and the docked layer-shell surface (see Main.qml), so all page state
// (including the live chat transcript) survives dock/undock.
//
// All pages are kept instantiated; switching pages cross-fades + slides them so
// the Chat session and every page's loaded data persist across navigation.
Item {
    id: shell

    property int currentIndex: 0
    // The NavRail/switch index of the Voice page (used by the --voice CLI flag in
    // Main.qml to boot straight onto it). Keep in sync with the page order in the
    // header comment above.
    readonly property int voiceIndex: 2
    // The Computer page's index (the chat peek's "⛶ Full" + Home's quick action).
    readonly property int computerIndex: 3

    // Drive hands-free voice capture by PAGE: start continuous listening the moment
    // the Voice page becomes active, stop it when leaving. This is the reliable
    // trigger (page cross-fade uses opacity, so a page's `visible` is unreliable).
    onCurrentIndexChanged: {
        if (currentIndex === voiceIndex) {
            if (bridge.connected) bridge.startConversation()
        } else {
            bridge.stopConversation()
        }
        updateWidgetViewing()
    }

    // Hold a live-widget viewer lease for the visible page so the engine only runs
    // a live widget while someone is watching it (battery). Chat -> the current
    // session's scope; Canvas/Widgets -> "all" (and replay so the tab isn't empty);
    // any other page -> no lease (its live widgets idle until you come back).
    //   0 Chat · 3 Canvas · 14 Widgets  (keep in sync with the page switch above)
    function updateWidgetViewing() {
        if (!bridge)
            return
        if (currentIndex === 1) {                                    // Chat
            bridge.setPageViewing(bridge.sessionId, "chat")
        } else if (currentIndex === 3) {                             // Computer (Full)
            // Watching the agent desktop = a viewer of this session, so the daemon's
            // idle-teardown keeps the nested desktop alive while it's on screen.
            bridge.setPageViewing(bridge.sessionId, "mirror")
        } else if (currentIndex === 0 || currentIndex === 4 || currentIndex === 5) { // Home / Canvas / Widgets
            bridge.setPageViewing("all", "canvas")
            bridge.replayAllWidgets()
        } else {
            bridge.setPageViewing("", "")
        }
    }

    Component.onCompleted: {
        // --page <n> (screenshots/testing): jump to a specific page on load.
        if (typeof startPage !== "undefined" && startPage >= 0 && startPage < rail.items.length)
            shell.currentIndex = startPage
        updateWidgetViewing()
    }

    // If the session changes while the Chat page is open, move the lease with it.
    Connections {
        target: bridge
        function onSessionIdChanged() {
            if (shell.currentIndex === 1)
                bridge.setPageViewing(bridge.sessionId, "chat")
        }
    }

    // Set by the Chat loader so other pages (e.g. Skills /invoke) can inject into
    // the live transcript without coupling to load order.
    property var chatPanel: null
    // Set by the Replay loader so the Sessions page can drive it (open a session
    // into Mission Control Replay). The Replay page's index in the rail.
    property var replayPanel: null
    readonly property int replayIndex: 13

    // Singleton-style access to shared inline widgets (Widgets.PillButton, etc.).
    // QML resolves `Widgets` inside pages because it's in the same module.

    RowLayout {
        anchors.fill: parent
        spacing: 0

        NavRail {
            id: rail
            Layout.fillHeight: true
            currentIndex: shell.currentIndex
            // Surface the COMPUTER item whenever a live agent desktop exists — and
            // ALWAYS while the user is on the page (otherwise the rail highlight
            // lands on a hidden zero-height row and the user is "nowhere").
            computerAvailable: shell.currentIndex === shell.computerIndex
                               || bridge.hasAgentDesktop
                               || bridge.coworkerSessionId.length > 0
            onNavigate: function(i) { shell.currentIndex = i }
        }

        // ---- Right column: HUD status strip on top, page stack below -------
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8

            HudStatusStrip {
                id: hudStrip
                Layout.fillWidth: true
                Layout.topMargin: 8
                Layout.leftMargin: 8
                Layout.rightMargin: 10
                onOpenSearch: cmdPalette.show()
            }

        // ---- Content area --------------------------------------------------
        Item {
            id: content
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            // Each page is wrapped so we can animate opacity + a small x-slide.
            // Only the active page is interactive; the rest fade out behind it.
            Repeater {
                // One wrap per nav item — derived, never a hand-counted literal.
                model: rail.items.length
                delegate: Item {
                    id: pageWrap
                    required property int index
                    anchors.fill: parent
                    readonly property bool active: shell.currentIndex === index
                    visible: opacity > 0.01
                    opacity: active ? 1.0 : 0.0
                    enabled: active
                    z: active ? 1 : 0

                    // Home (0, landing) + Chat (1, holds chatPanel that other pages
                    // inject into) preload; every other page loads on first visit,
                    // then stays warm. Cuts startup cost (was: all 15 built eagerly).
                    property bool loadedOnce: index === 0 || index === 1
                    onActiveChanged: if (active) loadedOnce = true

                    transform: Translate {
                        // active page rests at 0; inactive pages sit slightly to
                        // the right so the transition reads as a soft push-in.
                        x: pageWrap.active ? 0 : 18
                        Behavior on x { NumberAnimation { duration: 240; easing.type: Easing.OutCubic } }
                    }
                    Behavior on opacity { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }

                    Loader {
                        anchors.fill: parent
                        // Lazy: load on first visit, then keep warm so data prefetched
                        // by a page survives later navigation.
                        active: pageWrap.loadedOnce
                        sourceComponent: {
                            // Index order MUST match NavRail.items (grouped sections).
                            switch (pageWrap.index) {
                            case 0: return homeComp
                            case 1: return chatComp
                            case 2: return voiceComp
                            case 3: return computerComp
                            case 4: return canvasComp
                            case 5: return widgetsComp
                            case 6: return sessionsComp
                            case 7: return memoryComp
                            case 8: return skillsComp
                            case 9: return agentsComp
                            case 10: return schedulesComp
                            case 11: return activityComp
                            case 12: return memGraphComp
                            case 13: return replayComp
                            case 14: return mcpComp
                            case 15: return pluginsComp
                            case 16: return sshComp
                            case 17: return phoneComp
                            case 18: return settingsComp
                            }
                        }
                    }
                }
            }
        }
        }
    }

    // ---- ⌘K command palette (quick-switcher) ------------------------------
    function palettePages() {
        var out = []
        for (var i = 0; i < rail.items.length; i++)
            out.push({ key: rail.items[i].key, label: rail.items[i].label,
                       section: rail.items[i].section, index: i })
        return out
    }

    Shortcut {
        sequence: "Ctrl+K"
        onActivated: cmdPalette.show()
    }

    CommandPalette {
        id: cmdPalette
        pages: shell.palettePages()
        onNavigate: function(idx) { shell.currentIndex = idx }
        onOpenSession: function(sid) { bridge.openSession(sid); shell.currentIndex = 1 }
    }

    // ---- page components ---------------------------------------------------
    // Index 0: the Home dashboard (landing). Its quick actions + cards route into
    // the right pages without hiding any of them.
    Component {
        id: homeComp
        HomePage {
            onOpenSession: function(sid) {
                if (sid.length === 0) { shell.currentIndex = 6; return }  // "All sessions"
                bridge.openSession(sid)
                shell.currentIndex = 1
            }
            onNewChat: function() {
                if (shell.chatPanel) shell.chatPanel.startNewChat()
                shell.currentIndex = 1
            }
            onGoCanvas: function() { shell.currentIndex = 4 }
            onGoComputer: function() { shell.currentIndex = shell.computerIndex }
            onGoVoice: function() { shell.currentIndex = 2 }
        }
    }
    Component {
        id: chatComp
        JarvisPanel {
            Component.onCompleted: shell.chatPanel = this
            // The peek panel's "⛶ Full" jumps to the Computer page.
            onRequestComputerPage: shell.currentIndex = shell.computerIndex
            // Slash-command navigation: /voice, /agents, /skills jump to their pages.
            onRequestVoice: shell.currentIndex = 2
            onRequestAgents: shell.currentIndex = 9
            onRequestSkills: shell.currentIndex = 8
        }
    }
    Component { id: voiceComp;    VoiceMode {} }
    Component { id: computerComp; ComputerPage { pageVisible: shell.currentIndex === 3 } }
    Component {
        id: canvasComp
        CanvasPage {
            // A CANVAS widget `button` with action {"send":"…"} drops the text
            // into the live Chat panel (creating a session if needed) and jumps to
            // the Chat page so the user sees it land — same path as /invoke skills.
            onSendChat: function(text) {
                if (shell.chatPanel) {
                    shell.chatPanel.injectUser(text)
                    shell.currentIndex = 1
                } else {
                    bridge.sendMessage(text)
                }
            }
        }
    }
    Component { id: schedulesComp; SchedulesPage {} }
    Component { id: activityComp; ActivityPage {} }
    Component { id: sshComp;      SshPage {} }
    Component { id: memoryComp;   MemoryPage {} }
    Component { id: memGraphComp; MemoryGraphPage {} }
    Component { id: replayComp;   ReplayPage { Component.onCompleted: shell.replayPanel = this } }
    Component {
        id: skillsComp
        SkillsPage {
            // Running a skill sends "/skill-name" into the chat; the model loads it
            // via the skill_load tool. Jump to Chat so the user sees it land.
            onRunSkill: function(name, message) {
                if (shell.chatPanel)
                    shell.chatPanel.sendSkillCommand(name)
                shell.currentIndex = 1
            }
        }
    }
    Component {
        id: agentsComp
        AgentsPage {
            // Dispatching an agent spawns a child session that reports back in Chat;
            // open the chat (the child opens via session.opened too) so the user sees it.
            onRunAgent: function(sessionId, agent) {
                if (sessionId.length > 0)
                    bridge.openSession(sessionId)
                shell.currentIndex = 1
            }
        }
    }
    Component {
        id: sessionsComp
        SessionsPage {
            onOpenInChat: function(sid) { shell.currentIndex = 1 }
            // "▶ Replay" opens the session in Mission Control Replay (jarvis#66).
            onReplaySession: function(sid) {
                shell.currentIndex = shell.replayIndex
                if (shell.replayPanel) shell.replayPanel.load(sid)
            }
            // "+ New chat": jump to Chat and start a fresh conversation (drops the
            // current session so the next send creates a new one).
            onNewChat: function() {
                if (shell.chatPanel)
                    shell.chatPanel.startNewChat()
                shell.currentIndex = 1
            }
        }
    }
    Component { id: phoneComp;    PhonePage {} }
    Component { id: settingsComp; SettingsPage {} }
    Component { id: mcpComp;      McpPage {} }
    Component { id: pluginsComp;  PluginsPage {} }
    Component {
        id: widgetsComp
        WidgetsPage {
            // "Render to chat" drops a saved widget into the live conversation and
            // jumps to Chat so the user sees it land.
            onRenderedToChat: function() { shell.currentIndex = 1 }
            // "Render to canvas" jumps to the Canvas page to show the result.
            onRenderedToCanvas: function() { shell.currentIndex = 4 }
        }
    }
}
