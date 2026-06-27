import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// AppShell — the full multi-page application body. A slim left NavRail routes
// between fourteen pages rendered in the content area on the right:
//   0 Chat (the existing JarvisPanel), 1 Voice (the voice-mode orb),
//   2 Computer (co-worker / take-over), 3 Canvas (model-rendered widgets),
//   4 Browser (agent's tab), 5 Schedules (cron jobs), 6 Memory, 7 Skills,
//   8 Sessions (+ sub-agent tree), 9 Activity (audit), 10 SSH (allow-list +
//   gated exec), 11 Settings, 12 MCP, 13 Plugins.
//
// NOTE: this switch + the Repeater `model` count + NavRail.items MUST stay in
// lock-step (same order, same length).
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
    // Main.qml to boot straight onto it). Keep in sync with the order below.
    readonly property int voiceIndex: 1

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
        if (currentIndex === 0) {
            bridge.setPageViewing(bridge.sessionId, "chat")
        } else if (currentIndex === 3 || currentIndex === 14) {
            bridge.setPageViewing("all", "canvas")
            bridge.replayAllWidgets()
        } else {
            bridge.setPageViewing("", "")
        }
    }

    Component.onCompleted: updateWidgetViewing()

    // If the session changes while the Chat page is open, move the lease with it.
    Connections {
        target: bridge
        function onSessionIdChanged() {
            if (shell.currentIndex === 0)
                bridge.setPageViewing(bridge.sessionId, "chat")
        }
    }

    // Set by the Chat loader so other pages (e.g. Skills /invoke) can inject into
    // the live transcript without coupling to load order.
    property var chatPanel: null

    // Singleton-style access to shared inline widgets (Widgets.PillButton, etc.).
    // QML resolves `Widgets` inside pages because it's in the same module.

    RowLayout {
        anchors.fill: parent
        spacing: 0

        NavRail {
            id: rail
            Layout.fillHeight: true
            currentIndex: shell.currentIndex
            onNavigate: function(i) { shell.currentIndex = i }
        }

        // ---- Right column: HUD status strip on top, page stack below -------
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8

            HudStatusStrip {
                Layout.fillWidth: true
                Layout.topMargin: 8
                Layout.leftMargin: 8
                Layout.rightMargin: 10
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
                model: 15
                delegate: Item {
                    id: pageWrap
                    required property int index
                    anchors.fill: parent
                    readonly property bool active: shell.currentIndex === index
                    visible: opacity > 0.01
                    opacity: active ? 1.0 : 0.0
                    enabled: active
                    z: active ? 1 : 0

                    transform: Translate {
                        // active page rests at 0; inactive pages sit slightly to
                        // the right so the transition reads as a soft push-in.
                        x: pageWrap.active ? 0 : 18
                        Behavior on x { NumberAnimation { duration: 240; easing.type: Easing.OutCubic } }
                    }
                    Behavior on opacity { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }

                    Loader {
                        anchors.fill: parent
                        // Instantiate immediately so each page can prefetch its
                        // data and keep it warm across navigation.
                        active: true
                        sourceComponent: {
                            switch (pageWrap.index) {
                            case 0: return chatComp
                            case 1: return voiceComp
                            case 2: return computerComp
                            case 3: return canvasComp
                            case 4: return browserComp
                            case 5: return schedulesComp
                            case 6: return memoryComp
                            case 7: return skillsComp
                            case 8: return sessionsComp
                            case 9: return activityComp
                            case 10: return sshComp
                            case 11: return settingsComp
                            case 12: return mcpComp
                            case 13: return pluginsComp
                            case 14: return widgetsComp
                            }
                        }
                    }
                }
            }
        }
        }
    }

    // ---- page components ---------------------------------------------------
    Component {
        id: chatComp
        JarvisPanel { Component.onCompleted: shell.chatPanel = this }
    }
    Component { id: voiceComp;    VoiceMode {} }
    Component { id: computerComp; ComputerPage {} }
    Component {
        id: canvasComp
        CanvasPage {
            // A CANVAS widget `button` with action {"send":"…"} drops the text
            // into the live Chat panel (creating a session if needed) and jumps to
            // the Chat page so the user sees it land — same path as /invoke skills.
            onSendChat: function(text) {
                if (shell.chatPanel) {
                    shell.chatPanel.injectUser(text)
                    shell.currentIndex = 0
                } else {
                    bridge.sendMessage(text)
                }
            }
        }
    }
    Component { id: browserComp;  BrowserPage {} }
    Component { id: schedulesComp; SchedulesPage {} }
    Component { id: activityComp; ActivityPage {} }
    Component { id: sshComp;      SshPage {} }
    Component { id: memoryComp;   MemoryPage {} }
    Component {
        id: skillsComp
        SkillsPage {
            // /invoke a skill -> drop the rendered text into the live Chat panel
            // and jump to the Chat page so the user sees it land.
            onRunSkill: function(name, message) {
                if (shell.chatPanel)
                    shell.chatPanel.injectSkill(name, message)
                shell.currentIndex = 0
            }
        }
    }
    Component {
        id: sessionsComp
        SessionsPage {
            onOpenInChat: function(sid) { shell.currentIndex = 0 }
            // "+ New chat": jump to Chat and start a fresh conversation (drops the
            // current session so the next send creates a new one).
            onNewChat: function() {
                if (shell.chatPanel)
                    shell.chatPanel.startNewChat()
                shell.currentIndex = 0
            }
        }
    }
    Component { id: settingsComp; SettingsPage {} }
    Component { id: mcpComp;      McpPage {} }
    Component { id: pluginsComp;  PluginsPage {} }
    Component {
        id: widgetsComp
        WidgetsPage {
            // "Render to chat" drops a saved widget into the live conversation and
            // jumps to Chat so the user sees it land.
            onRenderedToChat: function() { shell.currentIndex = 0 }
            // "Render to canvas" jumps to the Canvas page to show the result.
            onRenderedToCanvas: function() { shell.currentIndex = 3 }
        }
    }
}
