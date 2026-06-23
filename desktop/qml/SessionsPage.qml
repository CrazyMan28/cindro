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

    ListModel { id: sessionsModel }

    function refresh() { bridge.listSessions() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onSessionsListed(sessions) {
            sessionsModel.clear()
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i]
                sessionsModel.append({
                    "sid": s.id !== undefined ? s.id : "",
                    "title": (s.title && s.title.length > 0) ? s.title : "Untitled session",
                    "brain": s.brain !== undefined ? s.brain : "",
                    "model": s.model !== undefined ? s.model : "",
                    "sstate": s.state !== undefined ? s.state : "idle",
                    "updated": s.updated !== undefined ? s.updated : 0
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
                subtitle: "Open a past conversation to resume it in Chat."
            }
            Widgets.PillButton {
                label: "Refresh"
                Layout.alignment: Qt.AlignTop
                onClicked: { page.refresh(); subTree.refresh() }
            }
        }

        // sub-agent tree (child sessions, indented) — built from parent links
        Widgets.SectionCard {
            Layout.fillWidth: true
            SubAgentTree {
                id: subTree
                Layout.fillWidth: true
                onOpenSession: function(sid) { page.openInChat(sid) }
            }
        }

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

                width: ListView.view.width
                implicitHeight: 70
                radius: Theme.radiusSm
                color: rowMa.containsMouse ? Theme.surfaceStrong : Theme.panelSoft
                border.color: rowMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1
                Behavior on color { ColorAnimation { duration: 110 } }
                Behavior on border.color { ColorAnimation { duration: 110 } }

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 15
                    anchors.rightMargin: 14
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
                        }
                    }

                    ColumnLayout {
                        spacing: 4
                        Layout.alignment: Qt.AlignVCenter
                        // state pill
                        Rectangle {
                            Layout.alignment: Qt.AlignRight
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
                    onClicked: {
                        bridge.openSession(row.sid)
                        page.openInChat(row.sid)
                    }
                }
            }
        }
    }
}
