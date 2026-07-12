pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// CALLS tab — full-feature dialer: number display, quick-chips 101-900,
// numeric keypad 1-9 * 0 #, green call circle, backspace, active call card,
// transcript viewer, active calls list, connect card, and PSTN/in-app selector.
Item {
    id: tab
    property var phonePage   // parent PhonePage item (for callerBusy propagation)

    // ---- async helper ---------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    function callTool(tool, args, cb) {
        var id = "dial_" + (++tab._seq)
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
    property string dialBuffer:    "101"
    property bool   busy:          false
    property string activeCallId:  ""
    property string transcriptText: ""
    ListModel { id: activeCalls }

    function refresh() {
        tab.callTool("list_active_calls", {}, function(r) {
            var arr = (r.data instanceof Array) ? r.data : []
            activeCalls.clear()
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i]
                activeCalls.append({
                    "cid":     c.id        !== undefined ? ("" + c.id)          : "",
                    "state":   c.state     !== undefined ? c.state               : "unknown",
                    "from_ext": c.from_extension !== undefined ? ("" + c.from_extension) : "—",
                    "to_ext":   c.to_extension   !== undefined ? ("" + c.to_extension)   : "—",
                    "reason":  c.reason    !== undefined ? c.reason              : ""
                })
            }
        })
    }

    function dialExtension(ext) {
        if (tab.busy) return
        tab.busy = true
        if (tab.phonePage) tab.phonePage.callerBusy = true
        callStatus.text = "Ringing " + ext + "…"
        tab.callTool("call_extension", { from_extension: "100", extension: ext }, function(r) {
            tab.busy = false
            if (tab.phonePage) tab.phonePage.callerBusy = false
            if (r.error) { callStatus.text = "Error: " + (r.error.message || "failed"); return }
            var d = r.data || {}
            tab.activeCallId = d.call_id ? ("" + d.call_id) : (d.id ? ("" + d.id) : "")
            callStatus.text = "Connected to " + ext
            tab.refresh()
        })
    }

    function dialUser(reason) {
        if (tab.busy) return
        tab.busy = true
        if (tab.phonePage) tab.phonePage.callerBusy = true
        callStatus.text = "Calling user…"
        tab.callTool("call_user", { reason: reason || "Desktop call" }, function(r) {
            tab.busy = false
            if (tab.phonePage) tab.phonePage.callerBusy = false
            if (r.error) { callStatus.text = "Error: " + (r.error.message || "failed"); return }
            var d = r.data || {}
            tab.activeCallId = d.call_id ? ("" + d.call_id) : (d.id ? ("" + d.id) : "")
            callStatus.text = "In-app call placed"
            tab.refresh()
        })
    }

    function endCall(callId) {
        tab.callTool("end_call", { call_id: callId }, function(r) {
            if (tab.activeCallId === callId) { tab.activeCallId = ""; tab.transcriptText = "" }
            callStatus.text = "Call ended"
            tab.refresh()
        })
    }

    function loadTranscript(callId) {
        tab.transcriptText = "Loading…"
        tab.callTool("get_call_transcript", { call_id: callId }, function(r) {
            if (r.error) { tab.transcriptText = "Error: " + (r.error.message || "?"); return }
            var d = r.data || {}
            var msgs = d.messages instanceof Array ? d.messages : []
            var lines = []
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i]
                var who = m.from_extension !== undefined ? ("ext " + m.from_extension) : "agent"
                lines.push("[" + who + "] " + (m.content || m.text || ""))
            }
            tab.transcriptText = lines.length > 0 ? lines.join("\n") : "(no messages yet)"
        })
    }

    // ---- UI -------------------------------------------------------------------
    Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: mainCol.implicitHeight + 24
        clip: true
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        ColumnLayout {
            id: mainCol
            width: parent.width
            spacing: 16

            // ── dial display ─────────────────────────────────────────────────
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 4

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: tab.dialBuffer.length > 0 ? tab.dialBuffer : "•"
                    color: Theme.text
                    font.family: Theme.fontMono
                    font.pixelSize: 44
                    font.weight: Font.Light
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: tab.busy ? "Calling…"
                        : bridge.connected ? "Ready to dial." : "Tap Connect to bring the line up."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 11
                }
            }

            // ── quick chips ──────────────────────────────────────────────────
            Row {
                Layout.fillWidth: true
                spacing: 8
                Repeater {
                    model: ["101","102","103","104","105","900"]
                    delegate: Rectangle {
                        required property string modelData
                        property string _ext: modelData
                        height: 30; implicitWidth: _cLbl.implicitWidth + 24; radius: 15
                        color: _cMa.containsMouse ? Theme.accentDim : Theme.surfaceStrong
                        border.color: Theme.hairlineSoft; border.width: 1
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text {
                            id: _cLbl; anchors.centerIn: parent; text: parent._ext
                            color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11
                        }
                        MouseArea {
                            id: _cMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: tab.dialBuffer = parent._ext
                        }
                    }
                }
            }

            // ── numeric keypad ───────────────────────────────────────────────
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 10

                // rows 1-9 then * 0 #
                Repeater {
                    model: [["1","2","3"],["4","5","6"],["7","8","9"],["*","0","#"]]
                    delegate: RowLayout {
                        required property var modelData
                        Layout.fillWidth: true; spacing: 10
                        Repeater {
                            model: modelData
                            delegate: Rectangle {
                                required property string modelData
                                property string _d: modelData
                                Layout.fillWidth: true; height: 62; radius: Theme.radiusSm
                                color: _kma.containsMouse ? Theme.surfaceStrong : Theme.surface
                                border.color: Theme.hairlineSoft; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Text {
                                    anchors.centerIn: parent; text: parent._d
                                    color: Theme.text; font.family: Theme.fontDisplay
                                    font.pixelSize: 22; font.weight: Font.Medium
                                }
                                MouseArea {
                                    id: _kma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    onClicked: { if (tab.dialBuffer.length < 15) tab.dialBuffer += parent._d }
                                }
                            }
                        }
                    }
                }

                // bottom row: spacer | call button | backspace
                RowLayout {
                    Layout.fillWidth: true; spacing: 10
                    Item { Layout.fillWidth: true }

                    Rectangle {
                        width: 68; height: 68; radius: 34
                        color: tab.busy ? Theme.accentDim
                             : (callMa.containsMouse ? Qt.lighter(Theme.accent, 1.15) : Theme.accent)
                        opacity: (tab.dialBuffer.length === 0 || !bridge.connected || tab.busy) ? 0.45 : 1.0
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        // pulsing ring while ringing
                        Rectangle {
                            anchors.centerIn: parent
                            width: parent.width + 14; height: width; radius: width / 2
                            color: "transparent"
                            border.color: Theme.accent; border.width: 2
                            opacity: 0
                            SequentialAnimation on opacity {
                                running: tab.busy; loops: Animation.Infinite
                                NumberAnimation { to: 0.5; duration: 600 }
                                NumberAnimation { to: 0.0; duration: 600 }
                            }
                        }
                        Text {
                            anchors.centerIn: parent; text: "✆"
                            color: Theme.inkOnAccent; font.pixelSize: 26
                        }
                        MouseArea {
                            id: callMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            enabled: !tab.busy && tab.dialBuffer.length > 0 && bridge.connected
                            onClicked: {
                                var target = tab.dialBuffer.trim()
                                if (!target) return
                                // Numeric-only → extension dial; otherwise in-app user call
                                if (/^\d{1,6}$/.test(target))
                                    tab.dialExtension(target)
                                else
                                    tab.dialUser("Desktop call to " + target)
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true; height: 62; radius: Theme.radiusSm
                        color: _bsMa.containsMouse ? Theme.surfaceStrong : "transparent"
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text {
                            anchors.centerIn: parent; text: "⌫"
                            color: Theme.textMuted; font.pixelSize: 24
                        }
                        MouseArea {
                            id: _bsMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: tab.dialBuffer = tab.dialBuffer.slice(0, -1)
                        }
                    }
                }
            }

            // ── call status line ─────────────────────────────────────────────
            Text {
                id: callStatus; text: ""; visible: text.length > 0
                color: Theme.amber; font.family: Theme.fontMono; font.pixelSize: 11
                Layout.fillWidth: true
            }

            // ── active call card ─────────────────────────────────────────────
            Rectangle {
                Layout.fillWidth: true
                height: _acRow.implicitHeight + 20
                visible: tab.activeCallId.length > 0
                color: Theme.accentDim; radius: Theme.radiusSm
                border.color: Theme.accent; border.width: 1
                RowLayout {
                    id: _acRow
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
                    spacing: 10
                    Rectangle {
                        width: 36; height: 36; radius: 18; color: Qt.rgba(0.24, 0.84, 1.0, 0.22)
                        Text { anchors.centerIn: parent; text: "✆"; color: Theme.accent; font.pixelSize: 18 }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true; spacing: 0
                        Text {
                            text: "Active call · " + tab.activeCallId
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; font.weight: Font.Medium
                        }
                        Text { text: "Call in progress"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10 }
                    }
                    Rectangle {
                        height: 26; implicitWidth: _trLbl.implicitWidth + 14; radius: Theme.radiusXs
                        color: _trBMa.containsMouse ? Theme.accentDim : "transparent"
                        border.color: Theme.accentDim; border.width: 1
                        Text { id: _trLbl; anchors.centerIn: parent; text: "TRANSCRIPT"; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 0.8 }
                        MouseArea { id: _trBMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.loadTranscript(tab.activeCallId) }
                    }
                    Rectangle {
                        height: 26; implicitWidth: _endBLbl.implicitWidth + 14; radius: Theme.radiusXs
                        color: _endBMa.containsMouse ? Theme.dangerDim : "transparent"
                        border.color: Theme.danger; border.width: 1
                        Text { id: _endBLbl; anchors.centerIn: parent; text: "END"; color: Theme.danger; font.family: Theme.fontDisplay; font.pixelSize: 9; font.weight: Font.DemiBold }
                        MouseArea {
                            id: _endBMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            property string cid: tab.activeCallId
                            onClicked: tab.endCall(cid)
                        }
                    }
                }
            }

            // ── transcript viewer ─────────────────────────────────────────────
            Rectangle {
                Layout.fillWidth: true; height: 82
                visible: tab.transcriptText.length > 0
                color: Theme.surface; radius: Theme.radiusSm
                border.color: Theme.hairlineSoft; border.width: 1; clip: true
                Flickable {
                    anchors.fill: parent; anchors.margins: 8
                    contentWidth: width; contentHeight: _trTxt.implicitHeight; clip: true
                    Text {
                        id: _trTxt; width: parent.width; text: tab.transcriptText
                        color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 10
                        wrapMode: Text.WrapAnywhere
                    }
                }
            }

            // ── active calls list ─────────────────────────────────────────────
            Text {
                text: "ACTIVE CALLS"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                visible: activeCalls.count > 0
            }
            Rectangle {
                Layout.fillWidth: true
                height: Math.min(activeCalls.count * 54 + 16, 200)
                visible: activeCalls.count > 0
                color: Theme.surface; radius: Theme.radiusSm
                border.color: Theme.hairlineSoft; border.width: 1; clip: true
                ListView {
                    id: _cList; anchors.fill: parent; anchors.margins: 8
                    model: activeCalls; spacing: 4; clip: true
                    delegate: Rectangle {
                        id: _cRow
                        required property string cid
                        required property string state
                        required property string from_ext
                        required property string to_ext
                        required property string reason
                        width: _cList.width; height: 46; radius: Theme.radiusXs
                        color: _cRow.cid === tab.activeCallId ? Theme.accentDim : Theme.surfaceStrong
                        border.color: _cRow.cid === tab.activeCallId ? Theme.accent : Theme.hairlineSoft; border.width: 1
                        RowLayout {
                            anchors.fill: parent; anchors.margins: 8; spacing: 8
                            Rectangle {
                                width: 8; height: 8; radius: 4
                                color: _cRow.state === "active"   ? Theme.success
                                     : _cRow.state === "ringing"  ? Theme.amber
                                     : _cRow.state === "speaking" ? Theme.accent : Theme.textFaint
                                SequentialAnimation on opacity {
                                    running: _cRow.state === "ringing" || _cRow.state === "speaking"
                                    loops: Animation.Infinite
                                    NumberAnimation { to: 0.3; duration: 600 }
                                    NumberAnimation { to: 1.0; duration: 600 }
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true; spacing: 0
                                Text {
                                    text: _cRow.reason.length > 0 ? _cRow.reason : ("Call " + _cRow.cid)
                                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 11
                                    elide: Text.ElideRight; Layout.fillWidth: true
                                }
                                Text {
                                    text: _cRow.from_ext + " → " + _cRow.to_ext + "  [" + _cRow.state + "]"
                                    color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 9
                                }
                            }
                            Rectangle {
                                height: 22; implicitWidth: _clTrLbl.implicitWidth + 12; radius: 4
                                color: _clTrMa.containsMouse ? Theme.accentDim : "transparent"
                                border.color: Theme.accentDim; border.width: 1
                                Text { id: _clTrLbl; anchors.centerIn: parent; text: "TRANSCRIPT"; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 0.6 }
                                MouseArea {
                                    id: _clTrMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    property string _cid: _cRow.cid
                                    onClicked: { tab.activeCallId = _cid; tab.loadTranscript(_cid) }
                                }
                            }
                            Rectangle {
                                height: 22; implicitWidth: _clEndLbl.implicitWidth + 12; radius: 4
                                color: _clEndMa.containsMouse ? Theme.dangerDim : "transparent"
                                border.color: Theme.danger; border.width: 1
                                Text { id: _clEndLbl; anchors.centerIn: parent; text: "END"; color: Theme.danger; font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.8 }
                                MouseArea {
                                    id: _clEndMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    property string _cid: _cRow.cid
                                    onClicked: tab.endCall(_cid)
                                }
                            }
                        }
                    }
                }
            }

            // ── PSTN / in-app extended dialer ─────────────────────────────────
            Text {
                text: "EXTENDED DIALER"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
            }
            Rectangle {
                Layout.fillWidth: true; height: _extDialCol.implicitHeight + 24
                color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                ColumnLayout {
                    id: _extDialCol
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                    spacing: 8
                    // type selector
                    RowLayout {
                        spacing: 8
                        Repeater {
                            model: [{lbl:"IN-APP", val:0},{lbl:"PSTN",val:1}]
                            delegate: Rectangle {
                                required property var modelData
                                height: 24; implicitWidth: _dtLbl.implicitWidth + 18; radius: Theme.radiusXs
                                color: _dialType.value === modelData.val ? Theme.accentDim : (_dtMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                                border.color: _dialType.value === modelData.val ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                Text { id: _dtLbl; anchors.centerIn: parent; text: parent.modelData.lbl; color: _dialType.value === parent.modelData.val ? Theme.accentBright : Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                                MouseArea { id: _dtMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: _dialType.value = parent.modelData.val }
                            }
                        }
                        QtObject { id: _dialType; property int value: 0 }
                    }
                    TextField {
                        id: _pstnField; Layout.fillWidth: true; visible: _dialType.value === 1
                        placeholderText: "Phone number  +1XXXXXXXXXX"
                        background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _pstnField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; rightPadding: 10; height: 32
                    }
                    TextField {
                        id: _reasonField; Layout.fillWidth: true
                        placeholderText: "Reason  (e.g. Approval needed)"
                        background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _reasonField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; rightPadding: 10; height: 32
                    }
                    TextField {
                        id: _sayField; Layout.fillWidth: true; visible: _dialType.value === 1
                        placeholderText: "Say (TTS spoken on PSTN call)"
                        background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _sayField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; rightPadding: 10; height: 32
                    }
                    Rectangle {
                        height: 32; implicitWidth: _doDialLbl.implicitWidth + 32; radius: Theme.radiusXs
                        color: _doDialMa.containsMouse ? Theme.accent : Theme.accentDim; opacity: tab.busy ? 0.5 : 1.0
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _doDialLbl; anchors.centerIn: parent; text: tab.busy ? "Calling…" : (_dialType.value === 0 ? "CALL USER" : "PLACE PSTN CALL"); color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 11; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                        MouseArea {
                            id: _doDialMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; enabled: !tab.busy
                            onClicked: {
                                if (_dialType.value === 0) {
                                    tab.dialUser(_reasonField.text || "Calling from desktop")
                                } else {
                                    if (!_pstnField.text.trim()) return
                                    tab.busy = true
                                    if (tab.phonePage) tab.phonePage.callerBusy = true
                                    tab.callTool("twilio_call_and_wait",
                                        { to_number: _pstnField.text.trim(), reason: _reasonField.text || "Desktop call", say: _sayField.text },
                                        function(r) {
                                            tab.busy = false
                                            if (tab.phonePage) tab.phonePage.callerBusy = false
                                            callStatus.text = r.error ? ("PSTN Error: " + (r.error.message || "failed")) : "PSTN call placed"
                                            tab.refresh()
                                        })
                                }
                            }
                        }
                    }
                }
            }

            // ── connect card (offline) ────────────────────────────────────────
            Rectangle {
                Layout.fillWidth: true; height: _connCol.implicitHeight + 20
                visible: !bridge.connected
                color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                ColumnLayout {
                    id: _connCol
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                    spacing: 8
                    Text { text: "CONNECT REQUIRED"; color: Theme.amber; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                    Text { text: "Connect to the Cindro daemon to enable calling."; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    RowLayout {
                        spacing: 8
                        Rectangle {
                            height: 30; implicitWidth: _cnLbl.implicitWidth + 22; radius: Theme.radiusXs
                            color: _cnMa.containsMouse ? Theme.accent : Theme.accentDim
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: _cnLbl; anchors.centerIn: parent; text: "CONNECT"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                            MouseArea { id: _cnMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bridge.connectToDaemon() }
                        }
                        Rectangle {
                            height: 30; implicitWidth: _rcLbl.implicitWidth + 22; radius: Theme.radiusXs
                            color: _rcMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"; border.color: Theme.hairlineSoft; border.width: 1
                            Text { id: _rcLbl; anchors.centerIn: parent; text: "RECONNECT"; color: Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid }
                            MouseArea { id: _rcMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bridge.connectToDaemon() }
                        }
                    }
                }
            }

            Item { height: 20 }
        }
    }
}
