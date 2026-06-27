pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// HOME — the desktop landing dashboard. Greeting + status, a live "Jarvis is
// working" card (spinning reactor + an AgentPeek of its desktop), quick actions,
// recent sessions, and a few live widgets. A glanceable front door that fixes the
// "where do I start" flow without hiding any page (all stay in the rail).
Item {
    id: home

    signal openSession(string sid)
    signal newChat()
    signal goCanvas()
    signal goComputer()
    signal goVoice()

    ListModel { id: sessionModel }
    ListModel { id: widgetModel }

    function greeting() {
        var h = new Date().getHours()
        return h < 12 ? "Good morning" : (h < 18 ? "Good afternoon" : "Good evening")
    }

    Component.onCompleted: {
        bridge.listSessions()
        bridge.replayAllWidgets()
    }

    Connections {
        target: bridge
        function onSessionsListed(list) {
            sessionModel.clear()
            for (var i = 0; i < list.length && i < 4; i++) {
                var s = list[i]
                sessionModel.append({
                    "sid": s.id !== undefined ? "" + s.id : "",
                    "title": (s.title !== undefined && ("" + s.title).length > 0) ? "" + s.title : "Untitled session",
                    "brain": s.brain !== undefined ? "" + s.brain : "",
                    "state": s.state !== undefined ? "" + s.state : ""
                })
            }
        }
        function onWidgetRendered(widget) {
            var id = widget.id !== undefined ? "" + widget.id : ""
            if (id.length === 0) return
            for (var i = 0; i < widgetModel.count; i++) {
                if (widgetModel.get(i).wid === id) {
                    widgetModel.setProperty(i, "title", widget.title !== undefined ? "" + widget.title : "")
                    widgetModel.setProperty(i, "spec", JSON.stringify(widget.spec))
                    return
                }
            }
            if (widgetModel.count < 4)
                widgetModel.append({ "wid": id, "title": widget.title !== undefined ? "" + widget.title : "",
                                     "spec": JSON.stringify(widget.spec) })
        }
        function onWidgetRemoved(id) {
            for (var i = 0; i < widgetModel.count; i++)
                if (widgetModel.get(i).wid === id) { widgetModel.remove(i); return }
        }
        function onWidgetsCleared() { widgetModel.clear() }
    }

    function brainColor(b) {
        var bl = ("" + b).toLowerCase()
        if (bl === "claude") return Theme.amber
        if (bl === "api") return Theme.violet !== undefined ? Theme.violet : Theme.accent
        return Theme.accent
    }
    function stateColor(s) {
        var sl = ("" + s).toLowerCase()
        if (sl === "working" || sl === "running" || sl === "busy") return Theme.success
        if (sl === "paused") return Theme.amber
        return Theme.textFaint
    }

    Flickable {
        anchors.fill: parent
        anchors.margins: 18
        contentHeight: col.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        WheelHandler {
            acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
            onWheel: function(ev) {
                var maxY = Math.max(0, parent.contentHeight - parent.height)
                parent.contentY = Math.max(0, Math.min(maxY, parent.contentY - ev.angleDelta.y * 2.0))
                ev.accepted = true
            }
        }

        ColumnLayout {
            id: col
            width: parent.width
            spacing: 16

            // ---- greeting -------------------------------------------------
            ColumnLayout {
                spacing: 3
                RowLayout {
                    spacing: 12
                    Text {
                        text: home.greeting() + ", Issac"
                        color: Theme.text
                        font.family: Theme.fontDisplay
                        font.pixelSize: 26
                        font.weight: Font.ExtraBold
                        font.letterSpacing: -0.3
                    }
                    // ONLINE pill
                    Rectangle {
                        Layout.alignment: Qt.AlignVCenter
                        radius: 999
                        implicitWidth: onRow.implicitWidth + 22
                        implicitHeight: 26
                        color: bridge.connected ? Qt.rgba(0.22, 0.90, 0.63, 0.13) : Qt.rgba(1, 0.7, 0.33, 0.13)
                        border.width: 1
                        border.color: bridge.connected ? Qt.rgba(0.22, 0.90, 0.63, 0.34) : Qt.rgba(1, 0.7, 0.33, 0.34)
                        Row {
                            id: onRow
                            anchors.centerIn: parent
                            spacing: 7
                            Rectangle { anchors.verticalCenter: parent.verticalCenter; width: 7; height: 7; radius: 3.5
                                color: bridge.connected ? Theme.success : Theme.amber }
                            Text { anchors.verticalCenter: parent.verticalCenter
                                text: bridge.connected ? "ONLINE" : "CONNECTING"
                                color: bridge.connected ? Theme.success : Theme.amber
                                font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: 1.4; font.weight: Font.DemiBold }
                        }
                    }
                }
                Text {
                    text: (bridge.connected ? "Jarvis is online" : "Connecting to Jarvis…") +
                          " · " + sessionModel.count + " sessions · " + widgetModel.count + " live widgets"
                    color: Theme.textMuted
                    font.pixelSize: 13
                }
            }

            // ---- ACTIVE AGENT card (spinning reactor + live peek) ---------
            Rectangle {
                Layout.fillWidth: true
                radius: Theme.radius
                implicitHeight: activeRow.implicitHeight + 28
                color: home.agentActive ? Qt.rgba(0.36, 0.55, 1.0, 0.07) : Theme.surface
                border.width: 1
                border.color: home.agentActive ? Theme.accentDim : Theme.hairline

                RowLayout {
                    id: activeRow
                    anchors.fill: parent
                    anchors.margins: 14
                    spacing: 16

                    // the spinning Jarvis reactor — red while driving the real screen,
                    // cyan while co-working, calm when idle. (Kept by request.)
                    ArcReactor {
                        Layout.alignment: Qt.AlignTop
                        size: 54
                        tint: bridge.driving ? Theme.danger : Theme.accent
                        thinking: home.agentActive
                        spinning: true
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 6
                        RowLayout {
                            spacing: 8
                            Rectangle {
                                visible: home.agentActive
                                radius: 999; implicitWidth: wk.implicitWidth + 18; implicitHeight: 20
                                color: bridge.driving ? Qt.rgba(1,0.42,0.42,0.16) : Qt.rgba(0.22,0.90,0.63,0.14)
                                border.width: 1; border.color: bridge.driving ? Qt.rgba(1,0.42,0.42,0.4) : Qt.rgba(0.22,0.90,0.63,0.32)
                                Text { id: wk; anchors.centerIn: parent
                                    text: bridge.driving ? "DRIVING YOUR SCREEN" : "WORKING"
                                    color: bridge.driving ? Theme.danger : Theme.success
                                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1.2; font.weight: Font.DemiBold }
                            }
                            Text {
                                text: home.agentActive ? "Jarvis is on it" : "Jarvis is idle"
                                color: Theme.text; font.pixelSize: 14; font.weight: Font.DemiBold
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            text: home.agentActive
                                  ? "Working on its own desktop — watch it live, or stop it."
                                  : "Nothing running. Start a chat or have Jarvis take over to see it work here."
                            color: Theme.textMuted; font.pixelSize: 12; wrapMode: Text.Wrap
                        }
                        RowLayout {
                            spacing: 9
                            Widgets.PillButton { label: home.agentActive ? "▣ Watch" : "▣ Take over"
                                onClicked: home.goComputer() }
                            Widgets.PillButton { visible: bridge.driving; label: "■ Stop"
                                onClicked: bridge.takeOverCancel() }
                        }
                    }

                    // live peek of the agent desktop (only when something's running)
                    AgentPeek {
                        visible: home.agentActive
                        Layout.preferredWidth: 240
                        Layout.preferredHeight: 132
                        Layout.alignment: Qt.AlignVCenter
                    }
                }
            }

            // ---- quick actions -------------------------------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Repeater {
                    model: [
                        { key: "new",    label: "New chat",  glyph: "＋", tint: Theme.accent },
                        { key: "over",   label: "Take over", glyph: "▣", tint: (Theme.violet !== undefined ? Theme.violet : Theme.accent) },
                        { key: "voice",  label: "Voice",     glyph: "◗", tint: Theme.success },
                        { key: "canvas", label: "Canvas",    glyph: "◆", tint: (Theme.pink !== undefined ? Theme.pink : Theme.accent) }
                    ]
                    delegate: Rectangle {
                        required property var modelData
                        Layout.fillWidth: true
                        implicitHeight: 52
                        radius: Theme.radiusSm
                        color: qaMa.containsMouse ? Theme.surfaceInput : Theme.surface
                        border.width: 1; border.color: Theme.hairline
                        Behavior on color { ColorAnimation { duration: 120 } }
                        Row {
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.leftMargin: 14
                            spacing: 11
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 30; height: 30; radius: 9
                                color: Qt.rgba(modelData.tint.r, modelData.tint.g, modelData.tint.b, 0.16)
                                Text { anchors.centerIn: parent; text: modelData.glyph; color: modelData.tint; font.pixelSize: 14 }
                            }
                            Text { anchors.verticalCenter: parent.verticalCenter; text: modelData.label
                                color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.Medium }
                        }
                        MouseArea {
                            id: qaMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (modelData.key === "new") home.newChat()
                                else if (modelData.key === "over") home.goComputer()
                                else if (modelData.key === "voice") home.goVoice()
                                else home.goCanvas()
                            }
                        }
                    }
                }
            }

            // ---- recent + live widgets (two columns) ----------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 16

                // recent sessions
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredWidth: 1
                    Layout.alignment: Qt.AlignTop
                    radius: Theme.radius
                    implicitHeight: recCol.implicitHeight + 26
                    color: Theme.surface
                    border.width: 1; border.color: Theme.hairline
                    ColumnLayout {
                        id: recCol
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                        anchors.margins: 14
                        spacing: 2
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Recent"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Item { Layout.fillWidth: true }
                            Text { text: "All sessions"; color: Theme.accent; font.pixelSize: 12
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: home.openSession("") } }
                        }
                        Text {
                            visible: sessionModel.count === 0
                            text: "No sessions yet — start a chat."
                            color: Theme.textFaint; font.pixelSize: 12; topPadding: 8
                        }
                        Repeater {
                            model: sessionModel
                            delegate: Rectangle {
                                required property int index
                                required property var model
                                Layout.fillWidth: true
                                implicitWidth: 10
                                implicitHeight: 50
                                color: sesMa.containsMouse ? Theme.surfaceInput : "transparent"
                                radius: Theme.radiusXs
                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 8; anchors.rightMargin: 8
                                    spacing: 12
                                    Rectangle {
                                        Layout.alignment: Qt.AlignVCenter
                                        width: 34; height: 34; radius: 10
                                        color: Qt.rgba(home.brainColor(model.brain).r, home.brainColor(model.brain).g, home.brainColor(model.brain).b, 0.16)
                                        Text { anchors.centerIn: parent
                                            text: model.brain.length > 0 ? model.brain.charAt(0).toUpperCase() : "J"
                                            color: home.brainColor(model.brain); font.weight: Font.Bold; font.pixelSize: 14 }
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 2
                                        Text { Layout.fillWidth: true; text: model.title; color: Theme.text
                                            font.pixelSize: 13; font.weight: Font.Medium; elide: Text.ElideRight }
                                        RowLayout {
                                            spacing: 6
                                            Rectangle { Layout.alignment: Qt.AlignVCenter; width: 6; height: 6; radius: 3
                                                color: home.stateColor(model.state) }
                                            Text { text: (model.state.length > 0 ? model.state : "idle") +
                                                         (model.brain.length > 0 ? " · " + model.brain : "")
                                                color: Theme.textMuted; font.pixelSize: 11 }
                                        }
                                    }
                                    Text { text: "›"; color: Theme.textFaint; font.pixelSize: 16 }
                                }
                                MouseArea { id: sesMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    onClicked: home.openSession(model.sid) }
                            }
                        }
                    }
                }

                // live widgets
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredWidth: 1
                    Layout.alignment: Qt.AlignTop
                    radius: Theme.radius
                    implicitHeight: wCol.implicitHeight + 26
                    color: Theme.surface
                    border.width: 1; border.color: Theme.hairline
                    ColumnLayout {
                        id: wCol
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                        anchors.margins: 14
                        spacing: 10
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Live widgets"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Item { Layout.fillWidth: true }
                            Text { text: "Canvas"; color: Theme.accent; font.pixelSize: 12
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: home.goCanvas() } }
                        }
                        Text {
                            visible: widgetModel.count === 0
                            text: "Ask Jarvis to draw a chart or status card — it shows up here."
                            color: Theme.textFaint; font.pixelSize: 12; wrapMode: Text.Wrap; Layout.fillWidth: true
                        }
                        Repeater {
                            model: widgetModel
                            delegate: Rectangle {
                                required property var model
                                Layout.fillWidth: true
                                radius: Theme.radiusSm
                                color: Theme.surfaceDeep
                                border.width: 1; border.color: Theme.hairline
                                implicitHeight: wr.implicitHeight + 20
                                WidgetRenderer {
                                    id: wr
                                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                                    anchors.margins: 10
                                    node: { try { return JSON.parse(model.spec) } catch (e) { return ({}) } }
                                }
                            }
                        }
                    }
                }
            }

            Item { Layout.preferredHeight: 8 }
        }
    }

    readonly property bool agentActive: bridge.driving || bridge.coworkerSessionId.length > 0
}
