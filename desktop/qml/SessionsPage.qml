pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// Sessions page: list of stored sessions (title, brain/model, state, updated).
// Clicking a row opens that thread in Chat (bridge.openSession -> sessionOpened,
// which AppShell routes back to the Chat page).
Item {
    id: page

    signal openInChat(string sessionId)
    // Start a brand-new conversation (AppShell routes this to the Chat page and
    // tells JarvisPanel.startNewChat()).
    signal newChat()
    // Scrub a session's timeline in Mission Control Replay (jarvis#66).
    signal replaySession(string sessionId)

    ListModel { id: sessionsModel }

    function refresh() { bridge.listSessions() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        // A delete landed (or was optimistically applied) — re-pull the list.
        function onSessionDeleted(sessionId) { page.refresh() }
        function onSessionsListed(sessions) {
            sessionsModel.clear()
            // Subagent CHILD sessions are not normal chats: they belong to their
            // parent (master) chat, live in its right-side sub-agent pop-out, and
            // disappear when done. They never render as top-level rows here — the
            // parent row shows a live "✦ n" badge while its children run (jarvis#72).
            var liveKids = {}
            for (var k = 0; k < sessions.length; k++) {
                var c = sessions[k]
                var cpar = c.parent_session_id !== undefined ? ("" + c.parent_session_id) : ""
                if (cpar.length > 0 && (c.state === "running" || c.state === "starting"))
                    liveKids[cpar] = (liveKids[cpar] || 0) + 1
            }
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i]
                var spar = s.parent_session_id !== undefined ? ("" + s.parent_session_id) : ""
                if (spar.length > 0)
                    continue
                sessionsModel.append({
                    "sid": s.id !== undefined ? s.id : "",
                    "title": (s.title && s.title.length > 0) ? s.title : "Untitled session",
                    "brain": s.brain !== undefined ? s.brain : "",
                    "model": s.model !== undefined ? s.model : "",
                    "sstate": s.state !== undefined ? s.state : "idle",
                    "updated": s.updated !== undefined ? s.updated : 0,
                    "liveAgents": (liveKids[s.id] !== undefined ? liveKids[s.id] : 0)
                })
            }
        }
    }

    function relTime(ms) {
        if (!ms || ms <= 0) return "—"
        var diff = Date.now() - ms
        if (diff < 60000) return "just now"
        if (diff < 3600000) return Math.floor(diff/60000) + "m ago"
        if (diff < 86400000) return Math.floor(diff/3600000) + "h ago"
        return Math.floor(diff/86400000) + "d ago"
    }

    function stateColor(st) {
        if (st === "running") return Theme.accent
        if (st === "error") return Theme.danger
        if (st === "done") return Theme.ok
        return Theme.textFaint
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "Sessions"
                subtitle: "Open a past conversation to resume it in Chat, or start a new one."
            }
            Widgets.PillButton {
                label: "+ New chat"
                primary: true
                Layout.alignment: Qt.AlignTop
                onClicked: page.newChat()
            }
            Widgets.PillButton {
                label: "Refresh"
                Layout.alignment: Qt.AlignTop
                onClicked: page.refresh()
            }
        }

        // (The sub-agent tree was removed — sessions are a single flat list now.)

        // empty state
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: sessionsModel.count === 0

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 10
                width: parent.width - 60
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "No sessions yet"
                    color: Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 15
                    font.weight: Font.Medium
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: "Start a conversation on the Chat page and it will appear here."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                }
            }
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: sessionsModel.count > 0
            clip: true
            spacing: 9
            model: sessionsModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                width: 5
                background: Item {}
                contentItem: Rectangle {
                    implicitWidth: 4; radius: 2
                    color: Theme.hairline
                    opacity: parent.pressed ? 0.9 : 0.5
                }
            }

            delegate: Rectangle {
                id: row
                required property string sid
                required property string title
                required property string brain
                required property string model
                required property string sstate
                required property double updated
                required property int liveAgents

                // Inline two-step delete: the trash icon arms a "Delete?" confirm
                // chip so a misclick can't nuke a thread.
                property bool confirming: false
                // The row is "hot" (hover affordances visible) on either MouseArea.
                readonly property bool hot: rowMa.containsMouse || actionsMa.containsMouse

                width: ListView.view.width
                implicitHeight: 70
                radius: Theme.radiusSm
                color: row.hot ? Theme.surfaceStrong : Theme.panelSoft
                border.color: row.hot ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1
                Behavior on color { ColorAnimation { duration: 110 } }
                Behavior on border.color { ColorAnimation { duration: 110 } }

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 15
                    // leave room on the right for the delete/confirm actions overlay
                    anchors.rightMargin: row.confirming ? 150 : 50
                    Behavior on anchors.rightMargin { NumberAnimation { duration: 110 } }
                    spacing: 14

                    // timeline node: ringed state dot with a short spine
                    Item {
                        width: 16
                        Layout.fillHeight: true
                        Layout.alignment: Qt.AlignVCenter
                        // spine
                        Rectangle {
                            anchors.horizontalCenter: parent.horizontalCenter
                            anchors.top: parent.top; anchors.bottom: parent.bottom
                            width: 1
                            color: Theme.hairlineSoft
                            opacity: 0.6
                        }
                        Rectangle {
                            anchors.centerIn: parent
                            width: 14; height: 14; radius: 7
                            color: Theme.bgDeep
                            border.width: 1.3
                            border.color: page.stateColor(row.sstate)
                        }
                        Rectangle {
                            anchors.centerIn: parent
                            width: 7; height: 7; radius: 3.5
                            color: page.stateColor(row.sstate)
                            SequentialAnimation on opacity {
                                running: row.sstate === "running"
                                loops: Animation.Infinite
                                NumberAnimation { from: 1; to: 0.3; duration: 700 }
                                NumberAnimation { from: 0.3; to: 1; duration: 700 }
                            }
                        }
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 3
                        Text {
                            Layout.fillWidth: true
                            text: row.title
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: Font.Medium
                            elide: Text.ElideRight
                        }
                        RowLayout {
                            spacing: 8
                            Text {
                                text: row.brain + (row.model.length ? " · " + row.model : "")
                                color: Theme.textMuted
                                font.family: Theme.fontMono
                                font.pixelSize: 11
                                elide: Text.ElideRight
                            }
                            // subtle "click to open" affordance, revealed on hover
                            Text {
                                text: "→ OPEN"
                                color: Theme.accent
                                font.family: Theme.fontDisplay
                                font.pixelSize: 9
                                font.letterSpacing: Theme.trackMid
                                opacity: row.hot && !row.confirming ? 0.9 : 0.0
                                Behavior on opacity { NumberAnimation { duration: 110 } }
                            }
                        }
                    }

                    ColumnLayout {
                        spacing: 4
                        Layout.alignment: Qt.AlignVCenter
                        RowLayout {
                            Layout.alignment: Qt.AlignRight
                            spacing: 6
                            // live subagents badge: this chat's dispatched agents
                            // still working (children hidden from the list itself)
                            Rectangle {
                                visible: row.liveAgents > 0
                                radius: 6
                                implicitWidth: liveTxt.implicitWidth + 14
                                implicitHeight: 18
                                color: Qt.rgba(0.694, 0.294, 1.0, 0.10)
                                border.width: 1
                                border.color: Qt.rgba(0.694, 0.294, 1.0, 0.45)
                                Text {
                                    id: liveTxt
                                    anchors.centerIn: parent
                                    text: "✦ " + row.liveAgents
                                    color: Theme.violet
                                    font.family: Theme.fontDisplay
                                    font.pixelSize: 9
                                    font.letterSpacing: Theme.trackTight
                                }
                            }
                            // state pill
                            Rectangle {
                                radius: 6
                                implicitWidth: stTxt.implicitWidth + 14
                                implicitHeight: 18
                                color: "transparent"
                                border.width: 1
                                border.color: page.stateColor(row.sstate)
                                Text {
                                    id: stTxt
                                    anchors.centerIn: parent
                                    text: row.sstate.toUpperCase()
                                    color: page.stateColor(row.sstate)
                                    font.family: Theme.fontDisplay
                                    font.pixelSize: 9
                                    font.letterSpacing: Theme.trackTight
                                }
                            }
                        }
                        Text {
                            Layout.alignment: Qt.AlignRight
                            text: page.relTime(row.updated)
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                        }
                    }
                }

                MouseArea {
                    id: rowMa
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    // Clicking the row body opens it; a pending confirm is dismissed
                    // first so an outside click backs out of the delete.
                    onClicked: {
                        if (row.confirming) {
                            row.confirming = false
                            return
                        }
                        bridge.openSession(row.sid)
                        page.openInChat(row.sid)
                    }
                }

                // ---- Replay button (overlay, left of the delete actions) --------
                // Opens this session in Mission Control Replay (jarvis#66).
                Rectangle {
                    id: replayBtn
                    anchors.right: actions.left
                    anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    width: replayInner.implicitWidth + 16
                    height: 26
                    radius: Theme.radiusXs
                    visible: !row.confirming
                    color: replayMa.containsMouse ? Theme.accentDim : "transparent"
                    border.width: 1
                    border.color: replayMa.containsMouse ? Theme.accent
                                  : (row.hot ? Theme.hairlineSoft : "transparent")
                    Behavior on border.color { ColorAnimation { duration: 110 } }
                    opacity: row.hot ? 1.0 : 0.0
                    Behavior on opacity { NumberAnimation { duration: 110 } }
                    Row {
                        id: replayInner
                        anchors.centerIn: parent
                        spacing: 5
                        Text { text: "▶"; color: replayMa.containsMouse ? Theme.accentBright : Theme.accent
                            font.pixelSize: 10; anchors.verticalCenter: parent.verticalCenter }
                        Text { text: "REPLAY"; color: replayMa.containsMouse ? Theme.accentBright : Theme.textMuted
                            font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackMid
                            anchors.verticalCenter: parent.verticalCenter }
                    }
                    MouseArea {
                        id: replayMa
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: page.replaySession(row.sid)
                    }
                }

                // ---- Delete / confirm actions (overlay, on top of rowMa) --------
                // Declared after rowMa so it sits above it and handles its own
                // clicks without the row body's open-on-click swallowing them.
                Item {
                    id: actions
                    anchors.right: parent.right
                    anchors.rightMargin: 12
                    anchors.verticalCenter: parent.verticalCenter
                    width: row.confirming ? confirmRow.implicitWidth : 30
                    height: 30

                    MouseArea {
                        id: actionsMa
                        anchors.fill: parent
                        hoverEnabled: true
                    }

                    // trash icon button (idle state)
                    Rectangle {
                        anchors.fill: parent
                        radius: Theme.radiusXs
                        visible: !row.confirming
                        color: trashMa.containsMouse ? Theme.dangerDim : "transparent"
                        border.width: 1
                        border.color: trashMa.containsMouse ? Qt.rgba(1, 0.30, 0.369, 0.45)
                                      : (row.hot ? Theme.hairlineSoft : "transparent")
                        Behavior on border.color { ColorAnimation { duration: 110 } }
                        opacity: row.hot ? 1.0 : 0.0
                        Behavior on opacity { NumberAnimation { duration: 110 } }

                        Canvas {
                            anchors.centerIn: parent
                            width: 14; height: 14
                            property color ink: trashMa.containsMouse ? Theme.danger : Theme.textMuted
                            onInkChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d"); ctx.reset()
                                ctx.strokeStyle = ink; ctx.lineWidth = 1.3
                                ctx.lineCap = "round"; ctx.lineJoin = "round"
                                // lid
                                ctx.beginPath(); ctx.moveTo(2, 4); ctx.lineTo(12, 4); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(5.5, 4); ctx.lineTo(6, 2.5)
                                ctx.lineTo(8, 2.5); ctx.lineTo(8.5, 4); ctx.stroke()
                                // can
                                ctx.beginPath(); ctx.moveTo(3, 4); ctx.lineTo(3.8, 12.5)
                                ctx.lineTo(10.2, 12.5); ctx.lineTo(11, 4); ctx.stroke()
                                // ribs
                                ctx.beginPath(); ctx.moveTo(5.5, 6); ctx.lineTo(5.7, 11); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(7, 6); ctx.lineTo(7, 11); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(8.5, 6); ctx.lineTo(8.3, 11); ctx.stroke()
                            }
                        }
                        MouseArea {
                            id: trashMa
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: row.confirming = true
                        }
                    }

                    // confirm chip (Delete? + ✕) — armed state
                    Row {
                        id: confirmRow
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 6
                        visible: row.confirming

                        // confirm delete
                        Rectangle {
                            width: delTxt.implicitWidth + 18; height: 26
                            radius: Theme.radiusXs
                            color: confMa.containsMouse ? Theme.danger : Theme.dangerDim
                            border.width: 1
                            border.color: Qt.rgba(1, 0.30, 0.369, 0.55)
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text {
                                id: delTxt
                                anchors.centerIn: parent
                                text: "DELETE"
                                color: confMa.containsMouse ? Theme.inkOnAccent : Theme.danger
                                font.family: Theme.fontDisplay
                                font.pixelSize: 9
                                font.weight: Font.DemiBold
                                font.letterSpacing: Theme.trackMid
                            }
                            MouseArea {
                                id: confMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    row.confirming = false
                                    bridge.deleteSession(row.sid)
                                    // Optimistic + sessionDeleted both refresh; this
                                    // makes the row disappear instantly.
                                    page.refresh()
                                }
                            }
                        }
                        // cancel
                        Rectangle {
                            width: 26; height: 26
                            radius: Theme.radiusXs
                            color: cxlMa.containsMouse ? Theme.surfaceStrong : "transparent"
                            border.width: 1
                            border.color: Theme.hairlineSoft
                            Text {
                                anchors.centerIn: parent
                                text: "✕"
                                color: Theme.textMuted
                                font.pixelSize: 12
                            }
                            MouseArea {
                                id: cxlMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: row.confirming = false
                            }
                        }
                    }
                }
            }
        }
    }
}
