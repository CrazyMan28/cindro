pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CindroSidebar

// SCREENING tab — polls get_screening_status and renders a live caller/agent
// transcript while a carrier call is being screened by the AI.
Item {
    id: tab
    property var phonePage

    // ---- async helper --------------------------------------------------------
    property var _pending: ({})
    property int _seq: 0

    function callTool(tool, args, cb) {
        var id = "scr_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
    }

    // ---- state ---------------------------------------------------------------
    property bool   active:      false   // screening session in progress
    property string callerNum:   ""
    property string callerName:  ""
    property string agentExt:    ""
    property string statusLine:  "No active screening session"
    ListModel { id: transcriptModel }

    // ---- polling -------------------------------------------------------------
    function refresh() {
        tab.callTool("get_screening_status", {}, function(r) {
            if (r.error) {
                tab.statusLine = "Error: " + (r.error.message || "?")
                tab.active = false
                return
            }
            var d = r.data || {}
            tab.active     = !!d.active
            tab.callerNum  = d.caller_number  !== undefined ? ("" + d.caller_number)  : ""
            tab.callerName = d.caller_name    !== undefined ? ("" + d.caller_name)    : ""
            tab.agentExt   = d.agent_extension !== undefined ? ("" + d.agent_extension) : ""
            tab.statusLine = tab.active ? "Screening in progress" : "No active screening session"

            var msgs = d.transcript instanceof Array ? d.transcript : []
            transcriptModel.clear()
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i]
                transcriptModel.append({
                    "speaker": m.speaker || (m.from_extension !== undefined ? ("ext " + m.from_extension) : "?"),
                    "body":    m.text || m.content || m.message || "",
                    "isAgent": !!(m.is_agent || (m.speaker && m.speaker !== "caller"))
                })
            }
        })
    }

    // auto-poll every 4 s when this tab is visible
    Timer {
        id: _poll
        interval: 4000; repeat: true; running: tab.visible && bridge.connected
        onTriggered: tab.refresh()
    }

    onVisibleChanged: { if (visible && bridge.connected) tab.refresh() }

    // =========================================================================
    // UI
    // =========================================================================
    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        // ── header / status ──────────────────────────────────────────────────
        RowLayout {
            Layout.fillWidth: true
            Text {
                text: "LIVE SCREENING"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                Layout.fillWidth: true
            }
            // active indicator dot
            Rectangle {
                width: 8; height: 8; radius: 4
                color: tab.active ? Theme.success : Theme.textFaint
                SequentialAnimation on opacity {
                    running: tab.active; loops: Animation.Infinite
                    NumberAnimation { to: 0.3; duration: 700 }
                    NumberAnimation { to: 1.0; duration: 700 }
                }
            }
            Item { width: 6 }
            Rectangle {
                width: 26; height: 26; radius: Theme.radiusXs
                color: _refreshMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                border.color: Theme.hairlineSoft; border.width: 1
                Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 13 }
                MouseArea { id: _refreshMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.refresh() }
            }
        }

        // ── caller / agent info card ─────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            height: _infoCol.implicitHeight + 20
            color: tab.active ? Theme.accentDim : Theme.surface
            radius: Theme.radiusSm
            border.color: tab.active ? Theme.accent : Theme.hairlineSoft; border.width: 1
            Behavior on color { ColorAnimation { duration: Theme.durFast } }

            ColumnLayout {
                id: _infoCol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                spacing: 4

                Text {
                    text: tab.statusLine
                    color: tab.active ? Theme.accentBright : Theme.textMuted
                    font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: 0.8; font.weight: Font.DemiBold
                }

                RowLayout {
                    visible: tab.active; spacing: 16
                    ColumnLayout {
                        spacing: 1
                        Text { text: "CALLER"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 1.0 }
                        Text {
                            text: tab.callerName.length > 0 ? (tab.callerName + "  " + tab.callerNum) : (tab.callerNum.length > 0 ? tab.callerNum : "Unknown")
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                        }
                    }
                    ColumnLayout {
                        spacing: 1
                        Text { text: "SCREENING AGENT"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 1.0 }
                        Text {
                            text: tab.agentExt.length > 0 ? ("ext " + tab.agentExt) : "—"
                            color: Theme.accent; font.family: Theme.fontMono; font.pixelSize: 12
                        }
                    }
                }
            }
        }

        // ── transcript label ─────────────────────────────────────────────────
        Text {
            text: "TRANSCRIPT"; color: Theme.textFaint
            font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
        }

        // ── transcript bubbles ───────────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Theme.surface; radius: Theme.radiusSm
            border.color: Theme.hairlineSoft; border.width: 1; clip: true

            // empty state
            ColumnLayout {
                anchors.centerIn: parent; spacing: 8
                visible: transcriptModel.count === 0
                Text { Layout.alignment: Qt.AlignHCenter; text: "📵"; font.pixelSize: 32; color: Theme.textFaint }
                Text { Layout.alignment: Qt.AlignHCenter; text: tab.active ? "Awaiting transcript…" : "No screening in progress"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 11 }
            }

            ListView {
                anchors { fill: parent; margins: 10 }
                visible: transcriptModel.count > 0
                model: transcriptModel
                spacing: 6; clip: true
                ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                delegate: Item {
                    id: _scBubble
                    required property string speaker
                    required property string body
                    required property bool   isAgent
                    // agent = right (accent), caller = left (surface)
                    width: ListView.view.width
                    height: _scRect.height + 4

                    Rectangle {
                        id: _scRect
                        width: Math.min(_scBody.implicitWidth + 24, parent.width * 0.80)
                        height: _scBCol.implicitHeight + 16
                        x: _scBubble.isAgent ? (parent.width - width) : 0
                        radius: Theme.radiusXs
                        color:        _scBubble.isAgent ? Theme.accentDim   : Theme.surfaceStrong
                        border.color: _scBubble.isAgent ? Theme.accent       : Theme.hairlineSoft
                        border.width: 1

                        ColumnLayout {
                            id: _scBCol
                            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 8 }
                            spacing: 1

                            Text {
                                text: _scBubble.speaker.toUpperCase()
                                color: _scBubble.isAgent ? Theme.accent : Theme.amber
                                font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 0.8
                            }
                            Text {
                                id: _scBody
                                text: _scBubble.body
                                color: _scBubble.isAgent ? Theme.accentBright : Theme.text
                                font.family: Theme.fontSans; font.pixelSize: 10
                                wrapMode: Text.WordWrap; Layout.fillWidth: true
                            }
                        }
                    }
                }
            }
        }

        // ── offline guard ────────────────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true; height: _offlineCol.implicitHeight + 16
            visible: !bridge.connected
            color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
            ColumnLayout {
                id: _offlineCol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
                spacing: 4
                Text { text: "OFFLINE"; color: Theme.amber; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0 }
                Text { text: "Connect to the Cindro daemon to enable screening view."; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            }
        }

        Item { height: 8 }
    }
}
