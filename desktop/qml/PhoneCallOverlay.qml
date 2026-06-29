pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// INCOMING + ACTIVE CALL OVERLAY
// Full-bleed overlay shown on top of all PhonePage tabs when a call is
// ringing or active.  Polls list_active_calls every 2 s (and immediately
// on connection/page-show); reacts to state transitions in-band.
//
// States covered:
//   ringing / created  — incoming alert, pulsing amber ring, Accept / Reject
//   accepted / active  — live call, cyan ring, Mute / End, transcript area
//
// Bridge usage:
//   phoneMcp  → list_active_calls, get_call_transcript, end_call
//   phoneHttp → POST /api/calls/:id/accept  { extension:"100" }
//               POST /api/calls/:id/reject  { extension:"100", reason }
Item {
    id: overlay

    // Overlay is only visible when there is a ringing or active call.
    visible: _cv.callId.length > 0

    // -------------------------------------------------------------------------
    // Bridge plumbing (same pattern as every other Phone*Tab)
    // -------------------------------------------------------------------------
    property var  _pending: ({})
    property int  _seq:     0

    function callTool(tool, args, cb) {
        var id = "cov_" + (++overlay._seq)
        overlay._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    function callHttp(method, path, body, cb) {
        var id = "covH_" + (++overlay._seq)
        overlay._pending[id] = cb || null
        bridge.phoneHttp(id, method, path, body || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = overlay._pending[callId]
            if (cb) { delete overlay._pending[callId]; cb(result) }
        }
        function onPhoneHttpResult(callId, result) {
            var cb = overlay._pending[callId]
            if (cb) { delete overlay._pending[callId]; cb(result) }
        }
        function onConnectedChanged() {
            if (bridge.connected) overlay._doPoll()
        }
    }

    // -------------------------------------------------------------------------
    // Shared call state (QtObject avoids exposing lots of top-level properties)
    // -------------------------------------------------------------------------
    QtObject {
        id: _cv
        property string callId:   ""
        property string state:    ""   // ringing | created | accepted | active | …
        property string fromExt:  ""
        property string toExt:    ""
        property string reason:   ""
        property string urgency:  "normal"
    }

    property bool   _muted:        false
    property int    _elapsedSec:   0      // counts up while a call is live
    ListModel { id: _txModel }

    // ---- elapsed-time counter -----------------------------------------------
    Timer {
        id: _elapsedTimer
        interval: 1000; repeat: true
        running: _cv.callId.length > 0
        onTriggered: overlay._elapsedSec++
    }

    // ---- polling loop -------------------------------------------------------
    Timer {
        id: _pollTimer
        interval: 2000; repeat: true
        running: bridge.connected
        onTriggered: overlay._doPoll()
    }

    // Trigger an immediate refresh when the overlay becomes visible (e.g. user
    // navigates to the Phone page while a call is already in flight).
    onVisibleChanged: { if (visible && bridge.connected) overlay._doPoll() }

    // ---- helpers ------------------------------------------------------------
    function _doPoll() {
        callTool("list_active_calls", {}, function(r) {
            var arr = r.data instanceof Array ? r.data : []

            // Prefer ringing/created over accepted/active so the alert always
            // surfaces an unanswered incoming call first.
            var found = null
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i]
                var s = c.state || ""
                if (s === "ringing" || s === "created") { found = c; break }
            }
            if (!found) {
                for (var j = 0; j < arr.length; j++) {
                    var s2 = arr[j].state || ""
                    if (s2 === "active" || s2 === "accepted") { found = arr[j]; break }
                }
            }

            if (!found) {
                // No live call — collapse the overlay.
                _cv.callId  = ""
                _cv.state   = ""
                overlay._muted      = false
                overlay._elapsedSec = 0
                _txModel.clear()
                return
            }

            var newId = found.id ? ("" + found.id) : ""
            var prevId = _cv.callId

            _cv.callId  = newId
            _cv.state   = found.state    || ""
            _cv.fromExt = found.from_extension !== undefined ? ("" + found.from_extension) : ""
            _cv.toExt   = found.to_extension   !== undefined ? ("" + found.to_extension)   : ""
            _cv.reason  = found.reason   || ""
            _cv.urgency = found.urgency  || "normal"

            // Reset per-call counters on a new call id.
            if (prevId !== newId) {
                overlay._muted      = false
                overlay._elapsedSec = 0
                _txModel.clear()
            }

            // Fetch transcript for active calls.
            if (_cv.state === "active" || _cv.state === "accepted") {
                overlay._refreshTranscript(newId)
            }
        })
    }

    function _refreshTranscript(callId) {
        callTool("get_call_transcript", { call_id: callId }, function(r) {
            if (r.error) return
            var d    = r.data || {}
            var txts = d.transcripts instanceof Array ? d.transcripts : []
            var msgs = d.messages   instanceof Array ? d.messages    : []

            _txModel.clear()

            // Transcripts first (STT utterances), then call messages (agent text).
            for (var i = 0; i < txts.length; i++) {
                var t = txts[i]
                _txModel.append({
                    "speaker": t.extension !== undefined ? ("ext " + t.extension) : "caller",
                    "body":    t.text || "",
                    "isAgent": false
                })
            }
            for (var j = 0; j < msgs.length; j++) {
                var m = msgs[j]
                _txModel.append({
                    "speaker": m.from_extension !== undefined ? ("ext " + m.from_extension) : "agent",
                    "body":    m.content || m.text || "",
                    "isAgent": true
                })
            }
        })
    }

    function _accept() {
        callHttp("POST", "/api/calls/" + _cv.callId + "/accept",
                 { extension: "100" },
                 function() { overlay._doPoll() })
    }

    function _reject() {
        callHttp("POST", "/api/calls/" + _cv.callId + "/reject",
                 { extension: "100", reason: "rejected_by_user" },
                 function() {
                     _cv.callId  = ""
                     _cv.state   = ""
                     overlay._elapsedSec = 0
                     _txModel.clear()
                 })
    }

    function _end() {
        callTool("end_call",
                 { call_id: _cv.callId, extension: "100", reason: "user_ended" },
                 function() {
                     _cv.callId  = ""
                     _cv.state   = ""
                     overlay._muted      = false
                     overlay._elapsedSec = 0
                     _txModel.clear()
                 })
    }

    // =========================================================================
    // UI
    // =========================================================================

    // ── dim backdrop (blocks interaction with tabs below) ────────────────────
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.02, 0.04, 0.09, 0.82)
        // Swallow all mouse events so the tab content is unreachable while the
        // overlay is up.
        MouseArea { anchors.fill: parent; hoverEnabled: true }
    }

    // ── call card ─────────────────────────────────────────────────────────────
    Rectangle {
        id: _card
        anchors.centerIn: parent
        width: Math.min(parent.width - 40, 468)
        height: _cardCol.implicitHeight + 32

        color:  Theme.surface
        radius: Theme.radius

        // Border: amber when ringing, cyan when active.
        property bool _isRinging: _cv.state === "ringing" || _cv.state === "created"
        border.color: _card._isRinging ? Theme.amber : Theme.accent
        border.width: 2

        Behavior on border.color { ColorAnimation { duration: Theme.durMid } }

        // Pulsing glow while ringing.
        Rectangle {
            anchors.centerIn: parent
            width:  _card.width  + 18
            height: _card.height + 18
            radius: _card.radius + 9
            color:       "transparent"
            border.color: _card._isRinging ? Theme.amber : Theme.accent
            border.width: 1
            opacity: 0
            SequentialAnimation on opacity {
                running: _card._isRinging
                loops:   Animation.Infinite
                NumberAnimation { to: 0.55; duration: 700; easing.type: Easing.InOutSine }
                NumberAnimation { to: 0.0;  duration: 700; easing.type: Easing.InOutSine }
            }
        }

        // ── enter / exit animation ───────────────────────────────────────────
        scale: overlay.visible ? 1.0 : 0.88
        opacity: overlay.visible ? 1.0 : 0.0
        Behavior on scale   { NumberAnimation { duration: Theme.durMid; easing.type: Easing.OutBack } }
        Behavior on opacity { NumberAnimation { duration: Theme.durMid } }

        ColumnLayout {
            id: _cardCol
            anchors {
                left:   parent.left
                right:  parent.right
                top:    parent.top
                margins: 16
            }
            spacing: 14

            // ── header ────────────────────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true; spacing: 12

                // Animated ring icon.
                Rectangle {
                    width: 48; height: 48; radius: 24
                    color: _card._isRinging ? Theme.amberDim : Theme.accentDim
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }

                    SequentialAnimation on scale {
                        running: _card._isRinging
                        loops:   Animation.Infinite
                        NumberAnimation { to: 1.14; duration: 550; easing.type: Easing.InOutSine }
                        NumberAnimation { to: 1.00; duration: 550; easing.type: Easing.InOutSine }
                    }

                    Text {
                        anchors.centerIn: parent; text: "✆"
                        color: _card._isRinging ? Theme.amber : Theme.accent
                        font.pixelSize: 22
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true; spacing: 3

                    Text {
                        text: _card._isRinging ? "INCOMING CALL" : "ACTIVE CALL"
                        color: _card._isRinging ? Theme.amber : Theme.accentBright
                        font.family: Theme.fontDisplay; font.pixelSize: 14
                        font.letterSpacing: Theme.trackWide; font.weight: Font.Bold
                        Behavior on color { ColorAnimation { duration: Theme.durMid } }
                    }

                    Text {
                        text: "ext " + _cv.fromExt + "  →  " + _cv.toExt
                        color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 10
                    }
                }

                // Elapsed / ringing timer.
                Text {
                    text: {
                        var s = overlay._elapsedSec
                        var m = Math.floor(s / 60)
                        var sec = s % 60
                        return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec
                    }
                    color: _card._isRinging ? Theme.amber : Theme.accent
                    font.family: Theme.fontMono; font.pixelSize: 20; font.weight: Font.DemiBold
                    Behavior on color { ColorAnimation { duration: Theme.durMid } }
                }
            }

            // ── reason / urgency row ──────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true; spacing: 8
                visible: _cv.reason.length > 0 || (_cv.urgency !== "normal" && _cv.urgency.length > 0)

                Text {
                    visible: _cv.reason.length > 0
                    text: _cv.reason
                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                    Layout.fillWidth: true; wrapMode: Text.WordWrap
                }

                Rectangle {
                    visible: _cv.urgency !== "normal" && _cv.urgency.length > 0
                    height: 22; implicitWidth: _urgLbl.implicitWidth + 18; radius: 11
                    color: (_cv.urgency === "high" || _cv.urgency === "critical")
                            ? Theme.dangerDim : Theme.amberDim
                    Text {
                        id: _urgLbl; anchors.centerIn: parent
                        text: _cv.urgency.toUpperCase()
                        color: (_cv.urgency === "high" || _cv.urgency === "critical")
                                ? Theme.danger : Theme.amber
                        font.family: Theme.fontDisplay; font.pixelSize: 8
                        font.letterSpacing: 1.2; font.weight: Font.DemiBold
                    }
                }
            }

            // ── live transcript (active calls only) ───────────────────────────
            Rectangle {
                Layout.fillWidth: true; height: 140
                visible: _cv.state === "active" || _cv.state === "accepted"
                color: Theme.surfaceStrong; radius: Theme.radiusSm
                border.color: Theme.hairlineSoft; border.width: 1; clip: true

                // Empty state.
                ColumnLayout {
                    anchors.centerIn: parent; spacing: 4
                    visible: _txModel.count === 0
                    Text {
                        Layout.alignment: Qt.AlignHCenter; text: "⋯"
                        color: Theme.textFaint; font.pixelSize: 24
                    }
                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: "Awaiting transcript…"
                        color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10
                    }
                }

                ListView {
                    id: _txList
                    anchors { fill: parent; margins: 8 }
                    visible: _txModel.count > 0
                    model: _txModel; spacing: 5; clip: true
                    // Auto-scroll to the newest message.
                    onCountChanged: Qt.callLater(function() { _txList.positionViewAtEnd() })
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                    delegate: Item {
                        id: _txRow
                        required property string speaker
                        required property string body
                        required property bool   isAgent
                        width: _txList.width
                        height: _txBubble.height + 4

                        Rectangle {
                            id: _txBubble
                            width: Math.min(_txBodyText.implicitWidth + 20,
                                            parent.width * 0.84)
                            height: _txBCol.implicitHeight + 12
                            x: _txRow.isAgent ? (parent.width - width) : 0
                            radius: Theme.radiusXs
                            color:        _txRow.isAgent ? Theme.accentDim    : Theme.surfaceDeep
                            border.color: _txRow.isAgent ? Theme.accent        : Theme.hairlineSoft
                            border.width: 1

                            ColumnLayout {
                                id: _txBCol
                                anchors {
                                    left: parent.left; right: parent.right
                                    top:  parent.top; margins: 6
                                }
                                spacing: 1

                                Text {
                                    text: _txRow.speaker.toUpperCase()
                                    color: _txRow.isAgent ? Theme.accent : Theme.amber
                                    font.family: Theme.fontDisplay; font.pixelSize: 7
                                    font.letterSpacing: 0.8
                                }
                                Text {
                                    id: _txBodyText
                                    text: _txRow.body
                                    color: _txRow.isAgent ? Theme.accentBright : Theme.text
                                    font.family: Theme.fontSans; font.pixelSize: 10
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }
                            }
                        }
                    }
                }
            }

            // ── action buttons ────────────────────────────────────────────────
            RowLayout {
                Layout.fillWidth: true; spacing: 10

                // ACCEPT — shown only while ringing.
                Rectangle {
                    visible: _card._isRinging
                    Layout.fillWidth: true; height: 44; radius: 22
                    color: _accMa.containsMouse
                            ? Qt.rgba(0.22, 0.9, 0.63, 0.45)
                            : Qt.rgba(0.22, 0.9, 0.63, 0.16)
                    border.color: Theme.success; border.width: 2
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    Text {
                        anchors.centerIn: parent
                        text: "✔  ACCEPT"
                        color: Theme.success
                        font.family: Theme.fontDisplay; font.pixelSize: 11
                        font.letterSpacing: 1.0; font.weight: Font.Bold
                    }
                    MouseArea {
                        id: _accMa; anchors.fill: parent
                        hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: overlay._accept()
                    }
                }

                // REJECT — shown only while ringing.
                Rectangle {
                    visible: _card._isRinging
                    Layout.fillWidth: true; height: 44; radius: 22
                    color: _rejMa.containsMouse ? Theme.dangerDim : Qt.rgba(1.0, 0.42, 0.42, 0.10)
                    border.color: Theme.danger; border.width: 2
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    Text {
                        anchors.centerIn: parent
                        text: "✖  REJECT"
                        color: Theme.danger
                        font.family: Theme.fontDisplay; font.pixelSize: 11
                        font.letterSpacing: 1.0; font.weight: Font.Bold
                    }
                    MouseArea {
                        id: _rejMa; anchors.fill: parent
                        hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: overlay._reject()
                    }
                }

                // MUTE — shown only while active.  Client-side toggle only.
                Rectangle {
                    visible: !_card._isRinging
                    width: 44; height: 44; radius: 22
                    color: overlay._muted
                            ? Theme.amberDim
                            : (_muteMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent")
                    border.color: overlay._muted ? Theme.amber : Theme.hairlineSoft
                    border.width: 2
                    Behavior on color       { ColorAnimation { duration: Theme.durFast } }
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                    Text {
                        anchors.centerIn: parent
                        text: overlay._muted ? "🔇" : "🔊"
                        font.pixelSize: 20
                    }
                    MouseArea {
                        id: _muteMa; anchors.fill: parent
                        hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: overlay._muted = !overlay._muted
                    }
                }

                // END — shown only while active.
                Rectangle {
                    visible: !_card._isRinging
                    Layout.fillWidth: true; height: 44; radius: 22
                    color: _endMa.containsMouse ? Theme.dangerDim : Qt.rgba(1.0, 0.42, 0.42, 0.10)
                    border.color: Theme.danger; border.width: 2
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    Text {
                        anchors.centerIn: parent
                        text: "END CALL"
                        color: Theme.danger
                        font.family: Theme.fontDisplay; font.pixelSize: 11
                        font.letterSpacing: 1.2; font.weight: Font.Bold
                    }
                    MouseArea {
                        id: _endMa; anchors.fill: parent
                        hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: overlay._end()
                    }
                }
            }

            Item { height: 2 }
        }
    }
}
