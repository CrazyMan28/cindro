import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// AppShell — the full multi-page application body. A slim left NavRail routes
// between five pages rendered in the content area on the right:
//   0 Chat (the existing JarvisPanel), 1 Sessions, 2 Settings, 3 MCP, 4 Plugins.
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
                model: 5
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
                            case 1: return sessionsComp
                            case 2: return settingsComp
                            case 3: return mcpComp
                            case 4: return pluginsComp
                            }
                        }
                    }
                }
            }
        }
        }
    }

    // ---- page components ---------------------------------------------------
    Component { id: chatComp;     JarvisPanel {} }
    Component {
        id: sessionsComp
        SessionsPage {
            onOpenInChat: function(sid) { shell.currentIndex = 0 }
        }
    }
    Component { id: settingsComp; SettingsPage {} }
    Component { id: mcpComp;      McpPage {} }
    Component { id: pluginsComp;  PluginsPage {} }
}
