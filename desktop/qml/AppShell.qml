import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
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
    // Page order (matches NavRail.items): 0 Home · 1 Chat · 2 Voice · 3 Computer ·
    // 4 Canvas · 5 Widgets · 6 Sessions · 7 Memory · 8 Skills · 9 Schedules ·
    // 10 Activity · 11 MCP · 12 Plugins · 13 SSH · 14 Settings.
    readonly property int voiceIndex: 2

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
        } else if (currentIndex === 0 || currentIndex === 4 || currentIndex === 5) { // Home / Canvas / Widgets
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
            if (shell.currentIndex === 1)
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
                            case 9: return schedulesComp
                            case 10: return activityComp
                            case 11: return mcpComp
                            case 12: return pluginsComp
                            case 13: return sshComp
                            case 14: return settingsComp
                            }
                        }
                    }
                }
            }
        }
        }
    }

    // ---- Ctrl+K quick-switcher --------------------------------------------
    // Jump to any page by typing — the fast path when the rail has 15 entries.
    property bool quickOpen: false

    Shortcut {
        sequence: "Ctrl+K"
        onActivated: shell.quickOpen = true
    }

    function quickMatches(q) {
        var ql = (q || "").toLowerCase().trim()
        var out = []
        for (var i = 0; i < rail.items.length; i++) {
            var it = rail.items[i]
            if (ql === "" || it.label.toLowerCase().indexOf(ql) >= 0
                          || it.section.toLowerCase().indexOf(ql) >= 0)
                out.push({ "label": it.label, "section": it.section, "idx": i })
        }
        return out
    }

    Rectangle {
        id: quick
        anchors.fill: parent
        visible: shell.quickOpen
        z: 200
        color: Qt.rgba(0, 0, 0, 0.55)

        MouseArea { anchors.fill: parent; onClicked: shell.quickOpen = false }

        function go(idx) {
            shell.currentIndex = idx
            shell.quickOpen = false
            quickInput.text = ""
        }

        onVisibleChanged: if (visible) { quickInput.text = ""; quickInput.forceActiveFocus() }

        Rectangle {
            width: Math.min(460, parent.width - 80)
            anchors.horizontalCenter: parent.horizontalCenter
            y: Math.round(parent.height * 0.16)
            implicitHeight: quickCol.implicitHeight + 20
            radius: Theme.radius
            color: Theme.panel
            border.width: 1
            border.color: Theme.accentDim
            MouseArea { anchors.fill: parent } // swallow backdrop clicks

            ColumnLayout {
                id: quickCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 10
                spacing: 8

                TextField {
                    id: quickInput
                    Layout.fillWidth: true
                    placeholderText: "Jump to a page…  (Esc to close)"
                    color: Theme.text
                    font.family: Theme.fontDisplay
                    font.pixelSize: 13
                    background: Rectangle {
                        radius: Theme.radiusSm
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: Theme.hairline
                    }
                    Keys.onEscapePressed: shell.quickOpen = false
                    Keys.onReturnPressed: {
                        var m = shell.quickMatches(text)
                        if (m.length > 0) quick.go(m[0].idx)
                    }
                }

                ListView {
                    id: quickList
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(320, contentHeight)
                    clip: true
                    model: shell.quickMatches(quickInput.text)
                    delegate: Rectangle {
                        required property var modelData
                        required property int index
                        width: ListView.view.width
                        height: 36
                        radius: Theme.radiusSm
                        color: hov.hovered ? Theme.navActive : "transparent"
                        HoverHandler { id: hov }
                        Row {
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.leftMargin: 12
                            spacing: 10
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.label
                                color: Theme.text
                                font.family: Theme.fontDisplay
                                font.pixelSize: 12
                                font.weight: Font.Medium
                                font.letterSpacing: Theme.trackMid
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.section
                                color: Theme.textFaint
                                font.family: Theme.fontDisplay
                                font.pixelSize: 8
                                font.letterSpacing: 1.5
                            }
                        }
                        TapHandler { onTapped: quick.go(modelData.idx) }
                    }
                }
            }
        }
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
            onGoComputer: function() { shell.currentIndex = 3 }
            onGoVoice: function() { shell.currentIndex = 2 }
        }
    }
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
    Component {
        id: skillsComp
        SkillsPage {
            // /invoke a skill -> drop the rendered text into the live Chat panel
            // and jump to the Chat page so the user sees it land.
            onRunSkill: function(name, message) {
                if (shell.chatPanel)
                    shell.chatPanel.injectSkill(name, message)
                shell.currentIndex = 1
            }
        }
    }
    Component {
        id: sessionsComp
        SessionsPage {
            onOpenInChat: function(sid) { shell.currentIndex = 1 }
            // "+ New chat": jump to Chat and start a fresh conversation (drops the
            // current session so the next send creates a new one).
            onNewChat: function() {
                if (shell.chatPanel)
                    shell.chatPanel.startNewChat()
                shell.currentIndex = 1
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
            onRenderedToChat: function() { shell.currentIndex = 1 }
            // "Render to canvas" jumps to the Canvas page to show the result.
            onRenderedToCanvas: function() { shell.currentIndex = 4 }
        }
    }
}
