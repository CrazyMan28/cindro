pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import JarvisSidebar

// HOME — the desktop landing dashboard, rebuilt to the approved redesign mockup
// (jarvis-desktop-redesign.html): a hero "active agent" card with an always-on
// TEXTURED live peek + spinning reactor, card quick-actions with colored chips,
// avatar'd recent sessions, and a right-hand LIVE mini-dashboard driven by REAL
// CPU / RAM / GPU numbers (animated bars). Motion throughout (entrance fade-up,
// hover lift, pulsing status) so it reads premium, not static. No page is hidden
// — this is just a better front door.
Item {
    id: home

    signal openSession(string sid)
    signal newChat()
    signal goCanvas()
    signal goComputer()
    signal goVoice()

    ListModel { id: sessionModel }
    ListModel { id: widgetModel }

    // rolling history (newest last) for the dashboard mini bar charts
    property var cpuHist: [4, 7, 5, 9, 6]
    property var ramHist: [40, 42, 41, 43, 42]

    function greeting() {
        var h = new Date().getHours()
        return h < 12 ? "Good morning" : (h < 18 ? "Good afternoon" : "Good evening")
    }
    function pushHist(arr, v) {
        var a = arr.slice(1); a.push(v); return a
    }

    Component.onCompleted: {
        bridge.listSessions()
        bridge.replayAllWidgets()
    }

    Connections {
        target: bridge
        function onStatsChanged() {
            home.cpuHist = home.pushHist(home.cpuHist, Math.round(bridge.cpuPercent))
            home.ramHist = home.pushHist(home.ramHist, Math.round(bridge.ramPercent))
        }
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
            // The Home dashboard only shows widgets PINNED to Home (target "home").
            // Everything else lives on the Canvas/Chat — Home stays curated.
            if (("" + (widget.target !== undefined ? widget.target : "")) !== "home") return
            for (var i = 0; i < widgetModel.count; i++) {
                if (widgetModel.get(i).wid === id) {
                    widgetModel.setProperty(i, "title", widget.title !== undefined ? "" + widget.title : "")
                    widgetModel.setProperty(i, "spec", JSON.stringify(widget.spec))
                    return
                }
            }
            if (widgetModel.count < 6)
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
        if (bl === "api") return Theme.violet
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

            // entrance: a soft fade-up the first time Home paints
            opacity: 0
            transform: Translate { id: rise; y: 14 }
            Component.onCompleted: introAnim.start()
            ParallelAnimation {
                id: introAnim
                NumberAnimation { target: col; property: "opacity"; from: 0; to: 1; duration: 360; easing.type: Easing.OutCubic }
                NumberAnimation { target: rise; property: "y"; from: 14; to: 0; duration: 420; easing.type: Easing.OutCubic }
            }

            // ---- greeting -------------------------------------------------
            ColumnLayout {
                spacing: 3
                RowLayout {
                    spacing: 12
                    Text {
                        text: home.greeting() + ", Issac"
                        color: Theme.text
                        font.family: Theme.fontDisplay
                        font.pixelSize: 25
                        font.weight: Font.ExtraBold
                        font.letterSpacing: -0.3
                    }
                    Rectangle {
                        Layout.alignment: Qt.AlignVCenter
                        radius: 999
                        implicitWidth: onRow.implicitWidth + 22
                        implicitHeight: 26
                        color: bridge.connected ? Qt.rgba(0.22, 0.90, 0.63, 0.12) : Qt.rgba(1, 0.7, 0.33, 0.12)
                        border.width: 1
                        border.color: bridge.connected ? Qt.rgba(0.22, 0.90, 0.63, 0.34) : Qt.rgba(1, 0.7, 0.33, 0.34)
                        Row {
                            id: onRow
                            anchors.centerIn: parent
                            spacing: 7
                            Rectangle {
                                id: connDot
                                anchors.verticalCenter: parent.verticalCenter; width: 7; height: 7; radius: 3.5
                                color: bridge.connected ? Theme.success : Theme.amber
                                SequentialAnimation on opacity {
                                    running: true; loops: Animation.Infinite
                                    NumberAnimation { from: 1.0; to: 0.35; duration: 900; easing.type: Easing.InOutSine }
                                    NumberAnimation { from: 0.35; to: 1.0; duration: 900; easing.type: Easing.InOutSine }
                                }
                            }
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

            // ---- HERO: active agent (textured live peek + reactor) --------
            Rectangle {
                id: heroCard
                Layout.fillWidth: true
                radius: Theme.radius
                implicitHeight: 168
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: home.agentActive ? Qt.rgba(0.357,0.549,1.0,0.10) : Theme.surface }
                    GradientStop { position: 1.0; color: home.agentActive ? Qt.rgba(0.239,0.839,1.0,0.05) : Theme.surface }
                }
                border.width: 1
                border.color: home.agentActive ? Theme.accentDim : Theme.hairlineSoft
                Behavior on border.color { ColorAnimation { duration: Theme.durMid } }

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 14
                    spacing: 16

                    // always-visible textured peek (the agent's screen)
                    AgentPeek {
                        Layout.preferredWidth: 236
                        Layout.fillHeight: true
                        Layout.maximumHeight: 140
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.alignment: Qt.AlignVCenter
                        spacing: 7
                        RowLayout {
                            spacing: 9
                            // status badge with a pulsing dot
                            Rectangle {
                                radius: 999; implicitWidth: wkRow.implicitWidth + 18; implicitHeight: 21
                                color: bridge.driving ? Qt.rgba(1,0.42,0.42,0.14)
                                       : home.agentActive ? Qt.rgba(0.22,0.90,0.63,0.13) : Theme.surfaceStrong
                                border.width: 1
                                border.color: bridge.driving ? Qt.rgba(1,0.42,0.42,0.4)
                                              : home.agentActive ? Qt.rgba(0.22,0.90,0.63,0.32) : Theme.hairlineSoft
                                Row {
                                    id: wkRow; anchors.centerIn: parent; spacing: 6
                                    Rectangle {
                                        anchors.verticalCenter: parent.verticalCenter
                                        width: 6; height: 6; radius: 3
                                        color: bridge.driving ? Theme.danger : home.agentActive ? Theme.success : Theme.textFaint
                                        SequentialAnimation on opacity {
                                            running: home.agentActive; loops: Animation.Infinite
                                            NumberAnimation { from: 1.0; to: 0.3; duration: 750; easing.type: Easing.InOutSine }
                                            NumberAnimation { from: 0.3; to: 1.0; duration: 750; easing.type: Easing.InOutSine }
                                        }
                                    }
                                    Text { anchors.verticalCenter: parent.verticalCenter
                                        text: bridge.driving ? "DRIVING YOUR SCREEN" : home.agentActive ? "WORKING" : "IDLE"
                                        color: bridge.driving ? Theme.danger : home.agentActive ? Theme.success : Theme.textMuted
                                        font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1.2; font.weight: Font.DemiBold }
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                text: home.agentActive ? "Jarvis is on it" : "Jarvis is idle"
                                color: Theme.text; font.pixelSize: 15; font.weight: Font.DemiBold; elide: Text.ElideRight
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            text: home.agentActive
                                  ? "Working on its own desktop — watch it live on the left, or stop it."
                                  : "Nothing running. Start a chat or have Jarvis take over to see it work here."
                            color: Theme.textMuted; font.pixelSize: 13; wrapMode: Text.Wrap; lineHeight: 1.3
                        }
                        RowLayout {
                            spacing: 9
                            Layout.topMargin: 4
                            Widgets.PillButton {
                                label: home.agentActive ? "▣ Watch" : "▣ Take over"
                                primary: home.agentActive
                                onClicked: home.goComputer()
                            }
                            Widgets.PillButton { visible: bridge.driving; label: "■ Stop"; danger: true
                                onClicked: bridge.takeOverCancel() }
                        }
                    }
                }
            }

            // ---- quick actions (card chips, hover lift) -------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Repeater {
                    model: [
                        { key: "new",    label: "New chat",  glyph: "＋", tint: Theme.accent },
                        { key: "over",   label: "Take over", glyph: "▣", tint: Theme.violet },
                        { key: "voice",  label: "Voice",     glyph: "◗", tint: Theme.success },
                        { key: "canvas", label: "Canvas",    glyph: "◆", tint: Theme.pink }
                    ]
                    delegate: Rectangle {
                        id: qa
                        required property var modelData
                        Layout.fillWidth: true
                        implicitHeight: 54
                        radius: Theme.radiusSm
                        color: qaMa.containsMouse ? Theme.surfaceStrong : Theme.surface
                        border.width: 1
                        border.color: qaMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                        Behavior on color { ColorAnimation { duration: 120 } }
                        Behavior on border.color { ColorAnimation { duration: 120 } }
                        scale: qaMa.pressed ? 0.97 : (qaMa.containsMouse ? 1.015 : 1.0)
                        Behavior on scale { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }
                        Row {
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.leftMargin: 13
                            spacing: 11
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 32; height: 32; radius: 9
                                color: Qt.rgba(qa.modelData.tint.r, qa.modelData.tint.g, qa.modelData.tint.b, 0.16)
                                Text { anchors.centerIn: parent; text: qa.modelData.glyph; color: qa.modelData.tint; font.pixelSize: 15 }
                            }
                            Text { anchors.verticalCenter: parent.verticalCenter; text: qa.modelData.label
                                color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.Medium }
                        }
                        MouseArea {
                            id: qaMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (qa.modelData.key === "new") home.newChat()
                                else if (qa.modelData.key === "over") home.goComputer()
                                else if (qa.modelData.key === "voice") home.goVoice()
                                else home.goCanvas()
                            }
                        }
                    }
                }
            }

            // ---- recent + live dashboard (two columns) --------------------
            RowLayout {
                Layout.fillWidth: true
                spacing: 16

                // -------- recent sessions --------
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredWidth: 13
                    Layout.alignment: Qt.AlignTop
                    radius: Theme.radius
                    implicitHeight: recCol.implicitHeight + 26
                    color: Theme.surface
                    border.width: 1; border.color: Theme.hairlineSoft
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
                        // nice empty state
                        ColumnLayout {
                            visible: sessionModel.count === 0
                            Layout.fillWidth: true
                            Layout.topMargin: 10; Layout.bottomMargin: 6
                            spacing: 6
                            Text { Layout.alignment: Qt.AlignHCenter; text: "◌"; color: Theme.accentDim; font.pixelSize: 30 }
                            Text { Layout.alignment: Qt.AlignHCenter; text: "No sessions yet"
                                color: Theme.textMuted; font.pixelSize: 13; font.weight: Font.Medium }
                            Text { Layout.alignment: Qt.AlignHCenter; text: "Start a chat and it shows up here."
                                color: Theme.textFaint; font.pixelSize: 11 }
                        }
                        Repeater {
                            model: sessionModel
                            delegate: Rectangle {
                                id: ses
                                required property int index
                                required property var model
                                Layout.fillWidth: true
                                implicitWidth: 10
                                implicitHeight: 50
                                color: sesMa.containsMouse ? Theme.surfaceStrong : "transparent"
                                radius: Theme.radiusXs
                                Behavior on color { ColorAnimation { duration: 110 } }
                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 8; anchors.rightMargin: 8
                                    spacing: 12
                                    Rectangle {
                                        Layout.alignment: Qt.AlignVCenter
                                        width: 34; height: 34; radius: 11
                                        color: Qt.rgba(home.brainColor(ses.model.brain).r, home.brainColor(ses.model.brain).g, home.brainColor(ses.model.brain).b, 0.16)
                                        Text { anchors.centerIn: parent
                                            text: ses.model.brain.length > 0 ? ses.model.brain.charAt(0).toUpperCase() : "J"
                                            color: home.brainColor(ses.model.brain); font.weight: Font.Bold; font.pixelSize: 14 }
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 2
                                        Text { Layout.fillWidth: true; text: ses.model.title; color: Theme.text
                                            font.pixelSize: 13; font.weight: Font.Medium; elide: Text.ElideRight }
                                        RowLayout {
                                            spacing: 6
                                            Rectangle { Layout.alignment: Qt.AlignVCenter; width: 6; height: 6; radius: 3
                                                color: home.stateColor(ses.model.state) }
                                            Text { text: (ses.model.state.length > 0 ? ses.model.state : "idle") +
                                                         (ses.model.brain.length > 0 ? " · " + ses.model.brain : "")
                                                color: Theme.textMuted; font.pixelSize: 11 }
                                        }
                                    }
                                    Text { text: "›"; color: Theme.textFaint; font.pixelSize: 16 }
                                }
                                MouseArea { id: sesMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    onClicked: home.openSession(ses.model.sid) }
                            }
                        }
                    }
                }

                // -------- live dashboard (REAL cpu/ram/gpu + model widgets) --------
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredWidth: 10
                    Layout.alignment: Qt.AlignTop
                    radius: Theme.radius
                    implicitHeight: wCol.implicitHeight + 26
                    color: Theme.surface
                    border.width: 1; border.color: Theme.hairlineSoft
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

                        // CPU + RAM mini stat cards (animated bars, real %)
                        GridLayout {
                            Layout.fillWidth: true
                            columns: 2
                            columnSpacing: 10; rowSpacing: 10
                            Repeater {
                                model: [
                                    { name: "CPU", val: Math.round(bridge.cpuPercent), hist: home.cpuHist },
                                    { name: "RAM", val: Math.round(bridge.ramPercent), hist: home.ramHist }
                                ]
                                delegate: Rectangle {
                                    id: stat
                                    required property var modelData
                                    Layout.fillWidth: true
                                    implicitHeight: 84
                                    radius: Theme.radiusSm
                                    color: Theme.surfaceStrong
                                    border.width: 1; border.color: Theme.hairlineSoft
                                    ColumnLayout {
                                        anchors.fill: parent
                                        anchors.margins: 11
                                        spacing: 1
                                        Text { text: stat.modelData.name; color: Theme.textMuted
                                            font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: 1; font.weight: Font.DemiBold }
                                        Text { text: stat.modelData.val + "%"; color: Theme.accent
                                            font.family: Theme.fontDisplay; font.pixelSize: 21; font.weight: Font.ExtraBold }
                                        Item { Layout.fillHeight: true }
                                        RowLayout {
                                            Layout.fillWidth: true
                                            Layout.preferredHeight: 26
                                            spacing: 4
                                            Repeater {
                                                model: 5
                                                delegate: Rectangle {
                                                    required property int index
                                                    Layout.fillWidth: true
                                                    Layout.alignment: Qt.AlignBottom
                                                    Layout.preferredHeight: Math.max(3, 26 * (stat.modelData.hist[index] / 100))
                                                    radius: 2
                                                    gradient: Gradient {
                                                        GradientStop { position: 0.0; color: Theme.accent }
                                                        GradientStop { position: 1.0; color: Theme.accentDeep }
                                                    }
                                                    Behavior on Layout.preferredHeight { NumberAnimation { duration: 420; easing.type: Easing.OutCubic } }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // GPU (if present) else NET — a real readout card
                        Rectangle {
                            Layout.fillWidth: true
                            implicitHeight: 56
                            radius: Theme.radiusSm
                            color: Theme.surfaceStrong
                            border.width: 1; border.color: Theme.hairlineSoft
                            ColumnLayout {
                                anchors.fill: parent
                                anchors.margins: 11
                                spacing: 1
                                Text {
                                    text: bridge.gpuPresent ? ("GPU · " + bridge.gpuName) : "NETWORK"
                                    color: Theme.textMuted; font.family: Theme.fontDisplay
                                    font.pixelSize: 10; font.letterSpacing: 1; font.weight: Font.DemiBold; elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                                Text {
                                    text: bridge.gpuPresent
                                          ? (Math.round(bridge.gpuPercent) + "% · " + Math.round(bridge.gpuMemUsedMb) + "/" + Math.round(bridge.gpuMemTotalMb) + " MiB")
                                          : ("▲ " + bridge.netUpMbps.toFixed(1) + "   ▼ " + bridge.netDownMbps.toFixed(1) + " Mbps")
                                    color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 16; font.weight: Font.Bold
                                }
                            }
                        }

                        // ---- Pinned-to-Home widgets ----------------------
                        Rectangle { Layout.fillWidth: true; Layout.topMargin: 2; height: 1; color: Theme.hairlineSoft }
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "PINNED TO HOME"; color: Theme.textFaint
                                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1.6; font.weight: Font.DemiBold }
                            Item { Layout.fillWidth: true }
                            Text { visible: widgetModel.count > 0; text: widgetModel.count + ""
                                color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9 }
                        }
                        // empty hint — tells the user (and implies Jarvis) how to pin
                        Text {
                            visible: widgetModel.count === 0
                            Layout.fillWidth: true
                            text: "Nothing pinned yet. Pin any widget here from the Widgets tab, or just ask Jarvis: “add that widget to my home screen.”"
                            color: Theme.textFaint; font.pixelSize: 11; wrapMode: Text.Wrap; lineHeight: 1.25
                        }
                        Repeater {
                            model: widgetModel
                            delegate: Rectangle {
                                id: wrow
                                required property var model
                                Layout.fillWidth: true
                                radius: Theme.radiusSm
                                color: Theme.surfaceDeep
                                border.width: 1; border.color: pinHov.hovered ? Theme.accentDim : Theme.hairlineSoft
                                Behavior on border.color { ColorAnimation { duration: 130 } }
                                implicitHeight: wr.implicitHeight + 20
                                HoverHandler { id: pinHov }
                                WidgetRenderer {
                                    id: wr
                                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                                    anchors.margins: 10
                                    anchors.rightMargin: 26
                                    node: { try { return JSON.parse(wrow.model.spec) } catch (e) { return ({}) } }
                                }
                                // unpin ✕
                                Rectangle {
                                    anchors.top: parent.top; anchors.right: parent.right; anchors.margins: 6
                                    width: 18; height: 18; radius: 9
                                    visible: pinHov.hovered
                                    color: unMa.containsMouse ? Theme.dangerDim : "transparent"
                                    Text { anchors.centerIn: parent; text: "✕"; color: unMa.containsMouse ? Theme.danger : Theme.textFaint; font.pixelSize: 11 }
                                    MouseArea {
                                        id: unMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: bridge.canvasDelete(wrow.model.wid)   // remove marker for "home:<id>"
                                    }
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
