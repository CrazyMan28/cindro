import QtQuick
import QtQuick.Layouts
import CindroSidebar

// HudStatusStrip — top telemetry bar: a reactor mini + tracked mono readouts
// (CPU / RAM / NET up-down / MCP servers / ACTIVE agents) each with a tiny bar
// or sparkline gauge. Connection state comes from the real bridge; the system
// metrics animate plausibly (no cheap host hook from QML). UPPERCASE tracked.
Rectangle {
    id: strip
    implicitHeight: 38
    color: Theme.surfaceDeep
    radius: Theme.radiusSm

    // Raised when the user clicks the "Search or jump…" field (or hits Ctrl+K);
    // AppShell opens the command palette.
    signal openSearch()
    border.width: 1
    border.color: Theme.hairlineSoft
    clip: true

    // REAL telemetry from the Bridge (polled /proc + nvidia-smi); the Gauge's own
    // Behavior smooths the value changes so it still reads as a live, animated HUD.
    property real cpu: bridge.cpuPercent
    property real ram: bridge.ramPercent
    property real netUp: bridge.netUpMbps
    property real netDown: bridge.netDownMbps
    // REAL count of enabled MCP servers from mcp.list; 0 while the daemon link is down
    // (was hard-coded 1, so the HUD claimed an MCP server was up when nothing was).
    property int mcpCount: 0
    Connections {
        target: bridge
        function onMcpListed(servers) {
            var n = 0
            for (var i = 0; i < servers.length; i++)
                if (servers[i].enabled === true) n++
            strip.mcpCount = n
        }
        function onConnectedChanged() {
            if (bridge.connected) bridge.listMcp(); else strip.mcpCount = 0
        }
    }
    Component.onCompleted: if (bridge.connected) bridge.listMcp()
    property int agents: bridge.sessionId.length > 0 ? 1 : 0

    // top hairline glow
    Rectangle {
        anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
        anchors.topMargin: 1; anchors.leftMargin: 10; anchors.rightMargin: 10
        height: 1
        gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0.0; color: "transparent" }
            GradientStop { position: 0.5; color: Theme.accentDim }
            GradientStop { position: 1.0; color: "transparent" }
        }
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        spacing: 14

        // reactor mini
        ArcReactor {
            size: 24
            Layout.alignment: Qt.AlignVCenter
            tint: bridge.connected ? Theme.accent : Theme.textFaint
        }

        // ---- agent MODE chip (plan | build | coworker) ----------------------
        // Live from bridge.agentMode; click to cycle coworker → plan → build.
        // Colored per mode (violet=plan, amber=build, cyan=coworker); the dot
        // pulses while in BUILD (actively executing).
        Rectangle {
            id: modeChip
            Layout.alignment: Qt.AlignVCenter
            implicitHeight: 22
            implicitWidth: modeRow.implicitWidth + 18
            radius: 11
            readonly property string mode: bridge.agentMode
            readonly property color modeTint: mode === "plan" ? Theme.violet
                                            : mode === "build" ? Theme.amber
                                            : Theme.accent
            color: Qt.rgba(modeTint.r, modeTint.g, modeTint.b,
                           modeChipMa.containsMouse ? 0.22 : 0.13)
            border.width: 1
            border.color: Qt.rgba(modeTint.r, modeTint.g, modeTint.b, 0.55)
            Behavior on color { ColorAnimation { duration: 180 } }
            Behavior on border.color { ColorAnimation { duration: 180 } }
            Behavior on implicitWidth { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
            Row {
                id: modeRow
                anchors.centerIn: parent
                spacing: 5
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 6; height: 6; radius: 3
                    color: modeChip.modeTint
                    SequentialAnimation on opacity {
                        running: modeChip.mode === "build"
                        loops: Animation.Infinite
                        NumberAnimation { from: 1.0; to: 0.4; duration: 700; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 0.4; to: 1.0; duration: 700; easing.type: Easing.InOutSine }
                    }
                }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: modeChip.mode === "plan" ? "PLAN"
                        : modeChip.mode === "build" ? "BUILD" : "COWORK"
                    color: modeChip.modeTint
                    font.family: Theme.fontDisplay
                    font.pixelSize: 9
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackMid
                }
            }
            MouseArea {
                id: modeChipMa
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    var m = bridge.agentMode
                    var next = m === "coworker" ? "plan"
                             : (m === "plan" ? "build" : "coworker")
                    bridge.setAgentMode(next)
                }
            }
        }

        Gauge { label: "CPU"; value: strip.cpu; suffix: "%"; tint: Theme.accent }
        Gauge { label: "RAM"; value: strip.ram; suffix: "%"; tint: Theme.violet }

        // NET up / down readout
        ColumnLayout {
            spacing: 1
            Layout.alignment: Qt.AlignVCenter
            Text {
                text: "NET"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 8
                font.letterSpacing: Theme.trackWide
            }
            RowLayout {
                spacing: 6
                Text {
                    text: "▲ " + strip.netUp.toFixed(1)
                    color: Theme.success
                    font.family: Theme.fontMono
                    font.pixelSize: 10
                }
                Text {
                    text: "▼ " + strip.netDown.toFixed(1)
                    color: Theme.accent
                    font.family: Theme.fontMono
                    font.pixelSize: 10
                }
            }
        }

        // ---- "Search or jump…" command bar (⌘K) ----------------------------
        Rectangle {
            Layout.fillWidth: true
            Layout.maximumWidth: 280
            Layout.minimumWidth: 110
            Layout.leftMargin: 8
            Layout.rightMargin: 8
            Layout.alignment: Qt.AlignVCenter
            implicitHeight: 26
            radius: 8
            color: kbarMa.containsMouse ? Theme.surfaceStrong : Theme.surfaceInput
            border.width: 1
            border.color: kbarMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
            Behavior on color { ColorAnimation { duration: 130 } }
            Behavior on border.color { ColorAnimation { duration: 130 } }
            Row {
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 10; anchors.rightMargin: 10
                spacing: 8
                Text { anchors.verticalCenter: parent.verticalCenter; text: "⌕"; color: Theme.textFaint; font.pixelSize: 13 }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Search or jump…"
                    color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 12 }
                Item { width: 1; height: 1 }
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: parent.width > 180
                    radius: 4; width: kbT.implicitWidth + 10; height: 16
                    color: Theme.surfaceDeep; border.color: Theme.hairlineSoft; border.width: 1
                    Text { id: kbT; anchors.centerIn: parent; text: "⌘K"; color: Theme.textFaint
                        font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.5 }
                }
            }
            MouseArea {
                id: kbarMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                onClicked: strip.openSearch()
            }
        }

        // MCP count
        Stat { label: "MCP"; value: strip.mcpCount + ""; tint: Theme.accent }
        // ACTIVE agents
        Stat {
            label: "AGENTS"
            value: strip.agents + ""
            tint: strip.agents > 0 ? Theme.amber : Theme.textFaint
            pulsing: strip.agents > 0
        }

        // link status
        RowLayout {
            spacing: 6
            Layout.alignment: Qt.AlignVCenter
            Rectangle {
                width: 7; height: 7; radius: 3.5
                color: bridge.connected ? Theme.success : Theme.danger
                SequentialAnimation on opacity {
                    running: bridge.connected
                    loops: Animation.Infinite
                    NumberAnimation { from: 1.0; to: 0.35; duration: 1100; easing.type: Easing.InOutSine }
                    NumberAnimation { from: 0.35; to: 1.0; duration: 1100; easing.type: Easing.InOutSine }
                }
            }
            Text {
                text: bridge.connected ? "LINK" : "OFFLINE"
                color: bridge.connected ? Theme.success : Theme.danger
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackMid
            }
        }
    }

    // ---- gauge with mini bar ------------------------------------------------
    component Gauge: ColumnLayout {
        property string label: ""
        property real value: 0
        property string suffix: ""
        property color tint: Theme.accent
        spacing: 2
        Layout.alignment: Qt.AlignVCenter
        RowLayout {
            spacing: 5
            Text {
                text: label
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 8
                font.letterSpacing: Theme.trackWide
            }
            Text {
                text: Math.round(value) + suffix
                color: tint
                font.family: Theme.fontMono
                font.pixelSize: 10
            }
        }
        Rectangle {
            Layout.preferredWidth: 56
            height: 3
            radius: 1.5
            color: Theme.surfaceDeep
            Rectangle {
                width: parent.width * Math.max(0, Math.min(1, value / 100))
                height: parent.height
                radius: 1.5
                color: tint
                Behavior on width { NumberAnimation { duration: 800; easing.type: Easing.OutCubic } }
            }
        }
    }

    // ---- compact stat (label + big value) -----------------------------------
    component Stat: ColumnLayout {
        property string label: ""
        property string value: ""
        property color tint: Theme.accent
        property bool pulsing: false
        spacing: 0
        Layout.alignment: Qt.AlignVCenter
        Text {
            text: label
            color: Theme.textFaint
            font.family: Theme.fontDisplay
            font.pixelSize: 8
            font.letterSpacing: Theme.trackWide
            Layout.alignment: Qt.AlignHCenter
        }
        Text {
            text: value
            color: tint
            font.family: Theme.fontDisplay
            font.pixelSize: 14
            font.weight: Font.DemiBold
            Layout.alignment: Qt.AlignHCenter
            SequentialAnimation on opacity {
                running: pulsing
                loops: Animation.Infinite
                NumberAnimation { from: 1.0; to: 0.45; duration: 900; easing.type: Easing.InOutSine }
                NumberAnimation { from: 0.45; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
            }
        }
    }
}
