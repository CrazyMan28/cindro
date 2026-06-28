pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// HUD tab — native QML ops dashboard (no WebEngine required).
// Shows connection status, Twilio health, active calls, agent roster stats,
// a live activity log, and the Red Alert broadcast button.
// All data driven via bridge.phoneMcp (twilio_status + list_active_calls +
// list_extensions / list_agents).
Item {
    id: tab
    property var phonePage

    // ---- async helper ---------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    function callTool(tool, args, cb) {
        var id = "hud_" + (++tab._seq)
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

    // ---- state ----------------------------------------------------------------
    property bool   twilioOk:        false
    property string twilioNumber:    "—"
    property bool   screeningOn:     false
    property int    activeCallCount: 0
    property int    agentCount:      0
    property int    onlineCount:     0
    property string lastRefresh:     "—"
    property var    activityLog:     []  // [{ts, msg, level}]

    // ---- functions ------------------------------------------------------------
    function refresh() {
        tab.lastRefresh = new Date().toLocaleTimeString()

        tab.callTool("twilio_status", {}, function(r) {
            if (!r.error) {
                var d = r.data || {}
                tab.twilioOk     = d.configured === true
                tab.twilioNumber = d.from_number || "—"
                tab.screeningOn  = d.screening_enabled === true
                tab._log("Twilio status refreshed", "info")
            } else {
                tab.twilioOk = false
                tab._log("Twilio: " + (r.error.message || "error"), "warn")
            }
        })

        tab.callTool("list_active_calls", {}, function(r) {
            var arr = r.data instanceof Array ? r.data : []
            tab.activeCallCount = arr.length
        })

        tab.callTool("list_extensions", {}, function(r) {
            if (!r.error && r.data instanceof Array) {
                tab.agentCount  = r.data.length
                tab.onlineCount = 0
                for (var i = 0; i < r.data.length; i++) {
                    if (r.data[i].status === "online") tab.onlineCount++
                }
            } else {
                // fallback
                tab.callTool("list_agents", {}, function(r2) {
                    if (!r2.error && r2.data instanceof Array) {
                        tab.agentCount  = r2.data.length
                        tab.onlineCount = 0
                        for (var j = 0; j < r2.data.length; j++) {
                            if (r2.data[j].status === "online") tab.onlineCount++
                        }
                    }
                })
            }
        })
    }

    function _log(msg, level) {
        var ts = new Date().toLocaleTimeString()
        var log = tab.activityLog.slice()
        log.unshift({ ts: ts, msg: msg, level: level || "info" })
        if (log.length > 20) log.pop()
        tab.activityLog = log
    }

    // ---- UI -------------------------------------------------------------------
    Flickable {
        anchors.fill: parent
        contentWidth: width; contentHeight: _hudCol.implicitHeight + 24; clip: true
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        ColumnLayout {
            id: _hudCol; width: parent.width; spacing: 14

            // header row
            RowLayout {
                Layout.fillWidth: true
                ArcReactor { size: 22; tint: Theme.accent; spinning: true; Layout.alignment: Qt.AlignVCenter }
                Item { width: 8 }
                Text { text: "OPS HUD"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold; Layout.fillWidth: true }
                Rectangle {
                    width: 26; height: 26; radius: Theme.radiusXs
                    color: _hudRefMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                    border.color: Theme.hairlineSoft; border.width: 1
                    Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 13 }
                    MouseArea { id: _hudRefMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.refresh() }
                }
            }
            Text {
                text: "Last updated: " + tab.lastRefresh
                color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 9
            }

            // ── status grid ───────────────────────────────────────────────────
            GridLayout {
                Layout.fillWidth: true
                columns: 2; rowSpacing: 10; columnSpacing: 10

                // Twilio configured
                Rectangle {
                    Layout.fillWidth: true; height: _twCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: tab.twilioOk ? Qt.rgba(0.22,0.90,0.63,0.35) : Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _twCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15
                            color: tab.twilioOk ? Qt.rgba(0.22,0.90,0.63,0.18) : Qt.rgba(1.0,0.42,0.42,0.15)
                            Text { anchors.centerIn: parent; text: tab.twilioOk ? "✓" : "✗"; color: tab.twilioOk ? Theme.success : Theme.danger; font.pixelSize: 15 }
                        }
                        ColumnLayout { spacing: 0; Layout.fillWidth: true
                            Text { text: "Twilio"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12 }
                            Text { text: tab.twilioNumber; color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 10 }
                        }
                        Text { text: tab.twilioOk ? "OK" : "FAIL"; color: tab.twilioOk ? Theme.success : Theme.danger; font.family: Theme.fontDisplay; font.pixelSize: 10; font.weight: Font.DemiBold }
                    }
                }

                // Screening
                Rectangle {
                    Layout.fillWidth: true; height: _scCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: tab.screeningOn ? Qt.rgba(0.239,0.839,1.0,0.30) : Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _scCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15
                            color: tab.screeningOn ? Qt.rgba(0.239,0.839,1.0,0.18) : Qt.rgba(0.36,0.49,0.58,0.14)
                            Text { anchors.centerIn: parent; text: "📞"; font.pixelSize: 14 }
                        }
                        Text { text: "Screening"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; Layout.fillWidth: true }
                        Text { text: tab.screeningOn ? "ON" : "OFF"; color: tab.screeningOn ? Theme.accent : Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 10; font.weight: Font.DemiBold }
                    }
                }

                // Active calls
                Rectangle {
                    Layout.fillWidth: true; height: _acCallCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: tab.activeCallCount > 0 ? Qt.rgba(0.239,0.839,1.0,0.30) : Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _acCallCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15; color: Qt.rgba(0.239,0.839,1.0,0.15)
                            Text { anchors.centerIn: parent; text: "✆"; color: Theme.accent; font.pixelSize: 15 }
                        }
                        Text { text: "Active calls"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; Layout.fillWidth: true }
                        Text {
                            text: "" + tab.activeCallCount
                            color: tab.activeCallCount > 0 ? Theme.accent : Theme.textFaint
                            font.family: Theme.fontMono; font.pixelSize: 18; font.weight: Font.Bold
                        }
                    }
                }

                // Agents
                Rectangle {
                    Layout.fillWidth: true; height: _agCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _agCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15; color: Qt.rgba(0.70,0.55,1.0,0.15)
                            Text { anchors.centerIn: parent; text: "🤖"; font.pixelSize: 14 }
                        }
                        ColumnLayout { spacing: 0; Layout.fillWidth: true
                            Text { text: "Agents"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12 }
                            Text { text: tab.onlineCount + " online"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10 }
                        }
                        Text {
                            text: "" + tab.agentCount
                            color: tab.agentCount > 0 ? Theme.text : Theme.textFaint
                            font.family: Theme.fontMono; font.pixelSize: 18; font.weight: Font.Bold
                        }
                    }
                }

                // Daemon connected
                Rectangle {
                    Layout.fillWidth: true; height: _dcCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: bridge.connected ? Qt.rgba(0.22,0.90,0.63,0.35) : Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _dcCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15
                            color: bridge.connected ? Qt.rgba(0.22,0.90,0.63,0.18) : Qt.rgba(1.0,0.42,0.42,0.15)
                            Text { anchors.centerIn: parent; text: bridge.connected ? "◎" : "○"; color: bridge.connected ? Theme.success : Theme.danger; font.pixelSize: 14 }
                        }
                        Text { text: "Daemon"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; Layout.fillWidth: true }
                        Text { text: bridge.connected ? "CONNECTED" : "OFFLINE"; color: bridge.connected ? Theme.success : Theme.danger; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                    }
                }

                // Phone server
                Rectangle {
                    Layout.fillWidth: true; height: _psCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _psCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Rectangle {
                            width: 30; height: 30; radius: 15; color: Qt.rgba(1.0,0.71,0.33,0.15)
                            Text { anchors.centerIn: parent; text: "⛁"; color: Theme.amber; font.pixelSize: 14 }
                        }
                        ColumnLayout { spacing: 0; Layout.fillWidth: true
                            Text { text: "Phone server"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12 }
                            Text { text: tab.twilioOk ? "Responding" : "Check connection"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10 }
                        }
                    }
                }
            }

            // ── activity log ──────────────────────────────────────────────────
            Text {
                text: "ACTIVITY LOG"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
            }
            Rectangle {
                Layout.fillWidth: true; height: Math.min(tab.activityLog.length * 22 + 20, 160)
                color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1; clip: true
                ListView {
                    id: _logList; anchors.fill: parent; anchors.margins: 8
                    model: tab.activityLog; spacing: 2; clip: true
                    delegate: RowLayout {
                        required property var modelData
                        width: _logList.width; spacing: 8
                        Text {
                            text: modelData.ts; color: Theme.textFaint
                            font.family: Theme.fontMono; font.pixelSize: 9; width: 60
                        }
                        Text {
                            text: modelData.msg; Layout.fillWidth: true; elide: Text.ElideRight
                            color: modelData.level === "warn"  ? Theme.amber
                                 : modelData.level === "error" ? Theme.danger : Theme.textMuted
                            font.family: Theme.fontMono; font.pixelSize: 10
                        }
                    }
                    Text {
                        visible: tab.activityLog.length === 0; anchors.centerIn: parent
                        text: "No activity yet — press ↺ to refresh"
                        color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 11
                    }
                }
            }

            // ── red alert ──────────────────────────────────────────────────────
            Text {
                text: "WAR ROOM"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
            }
            Rectangle {
                Layout.fillWidth: true; height: _raCol.implicitHeight + 24
                color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.danger; border.width: 1
                ColumnLayout {
                    id: _raCol
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                    spacing: 8
                    RowLayout {
                        ArcReactor { size: 18; tint: Theme.danger; Layout.alignment: Qt.AlignVCenter }
                        Item { width: 6 }
                        Text {
                            text: "RED ALERT broadcasts to every agent and opens a war-room thread."
                            color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                            wrapMode: Text.WordWrap; Layout.fillWidth: true
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true; spacing: 8
                        TextField {
                            id: _hudAlertField; Layout.fillWidth: true; placeholderText: "Alert message…"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _hudAlertField.activeFocus ? Theme.danger : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                        }
                        Rectangle {
                            height: 32; implicitWidth: _hudAlertLbl.implicitWidth + 20; radius: Theme.radiusXs
                            color: _hudAlertMa.containsMouse ? Theme.danger : Theme.dangerDim
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: _hudAlertLbl; anchors.centerIn: parent; text: "RED ALERT"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                            MouseArea {
                                id: _hudAlertMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    if (!_hudAlertField.text.trim()) return
                                    tab.callTool("red_alert", { message: _hudAlertField.text.trim() }, function(r) {
                                        _hudAlertStatus.text = r.error ? ("Error: " + (r.error.message || "?")) : "Alert broadcast"
                                        tab._log("Red alert: " + _hudAlertField.text.trim(), r.error ? "error" : "warn")
                                    })
                                }
                            }
                        }
                    }
                    Text { id: _hudAlertStatus; text: ""; visible: text.length > 0; color: Theme.amber; font.family: Theme.fontMono; font.pixelSize: 10 }
                }
            }

            Item { height: 20 }
        }
    }
}
