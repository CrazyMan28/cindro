pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// PHONE HUB — desktop surface for the agent-phone subsystem.
//
// Three tabs: CALLS (active calls + dialer), INBOX (in-app messages), and
// SETTINGS (Twilio config, screening, allowlist, voice profile, war room).
//
// Every action calls bridge.phoneMcp(callId, tool, args) and awaits the reply
// via bridge.phoneResult.  A lightweight JS map (pendingCalls) correlates
// async replies back to their originating UI element.
//
// The daemon exposes phone.mcp which forwards to the phone server and returns
// { tool, data, text, error? }.  On network / phone-server error the Bridge
// emits phoneResult with { error: { code, message } }.
Item {
    id: page

    // ---- async call helper --------------------------------------------------
    property var  pendingCalls: ({})
    property int  _callSeq: 0

    // Issue a phone MCP tool call. cb(result) is called when the reply arrives.
    function callTool(tool, args, cb) {
        var id = "ph_" + (++page._callSeq)
        page.pendingCalls[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = page.pendingCalls[callId]
            if (cb) {
                delete page.pendingCalls[callId]
                cb(result)
            }
        }
        function onConnectedChanged() {
            if (bridge.connected) page.onTabActivated(page.tabIndex)
        }
    }

    // ---- tab state ----------------------------------------------------------
    property int tabIndex: 0   // 0=CALLS  1=INBOX  2=SETTINGS

    function onTabActivated(idx) {
        if (!bridge.connected) return
        if (idx === 0)      refreshCalls()
        else if (idx === 1) refreshInbox()
        else if (idx === 2) refreshTwilioStatus()
    }

    onVisibleChanged: { if (visible && bridge.connected) onTabActivated(tabIndex) }
    Component.onCompleted: { if (bridge.connected) onTabActivated(tabIndex) }

    // ---- CALLS tab data -----------------------------------------------------
    ListModel { id: activeCalls }
    property string activeCallId: ""        // call id we're "on"
    property string transcriptText: ""
    property bool   callerBusy: false       // true while a dialer request is in flight

    function refreshCalls() {
        callTool("list_active_calls", {}, function(r) {
            var arr = (r.data instanceof Array) ? r.data : []
            activeCalls.clear()
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i]
                activeCalls.append({
                    "cid":      c.id   !== undefined ? ("" + c.id)    : "",
                    "state":    c.state !== undefined ? c.state        : "unknown",
                    "reason":   c.reason !== undefined ? c.reason      : "",
                    "from_ext": c.from_extension !== undefined ? ("ext " + c.from_extension) : "—",
                    "to_ext":   c.to_extension !== undefined   ? ("ext " + c.to_extension)   : "—"
                })
            }
        })
    }

    function dialUser(reason, say) {
        if (page.callerBusy) return
        page.callerBusy = true
        callTool("call_user", { reason: reason, urgency: "normal" }, function(r) {
            page.callerBusy = false
            if (r.error) {
                callStatusLabel.text = "Error: " + (r.error.message || "failed")
                return
            }
            var d = r.data || {}
            page.activeCallId = d.id ? ("" + d.id) : ""
            callStatusLabel.text = "Ringing…"
            page.refreshCalls()
        })
    }

    function dialPSTN(toNumber, reason, say) {
        if (page.callerBusy) return
        page.callerBusy = true
        callTool("twilio_call_and_wait",
                 { to_number: toNumber, reason: reason, say: say },
                 function(r) {
            page.callerBusy = false
            if (r.error) {
                callStatusLabel.text = "PSTN Error: " + (r.error.message || "failed")
                return
            }
            var d = r.data || {}
            callStatusLabel.text = d.ok ? "PSTN call placed" : "PSTN failed"
            page.refreshCalls()
        })
    }

    function endCall(callId) {
        callTool("end_call", { call_id: callId }, function(r) {
            callStatusLabel.text = "Call ended"
            if (page.activeCallId === callId) page.activeCallId = ""
            page.refreshCalls()
        })
    }

    function loadTranscript(callId) {
        page.transcriptText = "Loading…"
        callTool("get_call_transcript", { call_id: callId }, function(r) {
            if (r.error) { page.transcriptText = "Error loading transcript"; return }
            var d = r.data || {}
            var msgs = d.messages instanceof Array ? d.messages : []
            var lines = []
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i]
                var speaker = m.from_extension !== undefined ? ("ext " + m.from_extension) : "?"
                lines.push("[" + speaker + "] " + (m.content || m.text || ""))
            }
            page.transcriptText = lines.length > 0 ? lines.join("\n") : "(no messages yet)"
        })
    }

    // ---- INBOX tab data -----------------------------------------------------
    ListModel { id: inboxModel }
    property string threadTitle: ""
    property string threadText:  ""

    function refreshInbox() {
        callTool("list_inbox", { limit: 30 }, function(r) {
            var arr = (r.data !== undefined && r.data.messages instanceof Array)
                      ? r.data.messages
                      : (r.data instanceof Array ? r.data : [])
            inboxModel.clear()
            for (var i = 0; i < arr.length; i++) {
                var m = arr[i]
                inboxModel.append({
                    "mid":      m.id       !== undefined ? ("" + m.id)    : "",
                    "tid":      m.thread_id !== undefined ? ("" + m.thread_id) : "",
                    "title":    m.title    !== undefined ? m.title        : m.subject || "(no title)",
                    "priority": m.priority !== undefined ? m.priority     : "normal",
                    "status":   m.status   !== undefined ? m.status       : "",
                    "ts":       m.created_at !== undefined ? m.created_at : 0
                })
            }
        })
    }

    function loadThread(threadId) {
        page.threadText = "Loading thread…"
        callTool("get_thread_messages", { thread_id: threadId }, function(r) {
            if (r.error) { page.threadText = "Error loading thread"; return }
            var d = r.data || {}
            var msgs = d.messages instanceof Array ? d.messages : []
            var lines = []
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i]
                var who = m.from_extension !== undefined ? ("ext " + m.from_extension) : "agent"
                lines.push("[" + who + "] " + (m.message || m.content || m.text || ""))
            }
            page.threadText = lines.length > 0 ? lines.join("\n") : "(empty thread)"
        })
    }

    function sendNotify(title, msg, priority) {
        callTool("notify_user", { title: title, message: msg, priority: priority }, function(r) {
            if (r.error) {
                notifyStatus.text = "Error: " + (r.error.message || "failed")
            } else {
                notifyStatus.text = "Sent"
                page.refreshInbox()
            }
        })
    }

    // ---- SETTINGS tab data --------------------------------------------------
    property var twilioInfo: ({})
    property bool screeningOn: false
    ListModel { id: allowlistModel }
    property string voiceProfile: ""

    function refreshTwilioStatus() {
        callTool("twilio_status", {}, function(r) {
            if (r.error) return
            var d = r.data || {}
            page.twilioInfo = d
            page.screeningOn = d.screening_enabled === true
            screeningSwitch.checked = page.screeningOn
            fromNumber.text = d.from_number || "(not configured)"
            twilioConfigured.text = d.configured ? "Configured" : "Not configured"
        })
        callTool("twilio_allowlist_list", {}, function(r) {
            if (r.error) return
            var d = r.data || {}
            var nums = d.numbers instanceof Array ? d.numbers : []
            allowlistModel.clear()
            for (var i = 0; i < nums.length; i++) {
                var n = nums[i]
                allowlistModel.append({
                    "num":   (typeof n === "string") ? n : (n.phone_number || ""),
                    "label": (typeof n === "object" && n.label) ? n.label : ""
                })
            }
        })
        callTool("get_voice_profile", { extension: 100 }, function(r) {
            if (r.error) return
            var d = r.data || {}
            var vp = d.voice || {}
            page.voiceProfile = vp.voice_id || vp.name || "(default)"
        })
    }

    function setScreening(enable) {
        var tool = enable ? "twilio_screening_enable" : "twilio_screening_disable"
        callTool(tool, {}, function(r) {
            page.screeningOn = enable
        })
    }

    function addAllowNumber(num, lbl) {
        callTool("twilio_allowlist_add",
                 { phone_number: num, label: lbl },
                 function(r) { page.refreshTwilioStatus() })
    }

    function removeAllowNumber(num) {
        callTool("twilio_allowlist_remove",
                 { phone_number: num },
                 function(r) { page.refreshTwilioStatus() })
    }

    function setUserNumber(num) {
        callTool("twilio_set_user_number", { phone_number: num }, function(r) {
            if (!r.error) page.refreshTwilioStatus()
        })
    }

    function redAlert(msg) {
        callTool("red_alert", { message: msg }, function(r) {
            alertStatus.text = r.error ? ("Error: " + (r.error.message || "?"))
                                       : "Alert broadcast"
        })
    }

    // =========================================================================
    // UI layout
    // =========================================================================
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        // ---- header ---------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            ArcReactor {
                size: 28
                Layout.alignment: Qt.AlignVCenter
                tint: Theme.accent
                thinking: page.callerBusy
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2
                Text {
                    text: "PHONE HUB"
                    color: Theme.accent
                    font.family: Theme.fontDisplay
                    font.pixelSize: 18
                    font.letterSpacing: Theme.trackWide
                    font.weight: Font.Bold
                }
                Text {
                    text: "Agent-phone calls, inbox, and PSTN / Twilio management"
                    color: Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 11
                }
            }
        }

        // ---- tab bar --------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            Repeater {
                model: ["CALLS", "INBOX", "SETTINGS"]
                delegate: Rectangle {
                    required property int index
                    required property string modelData
                    height: 30
                    implicitWidth: tabLbl.implicitWidth + 24
                    radius: Theme.radiusXs
                    color: page.tabIndex === index ? Theme.accentDim
                                                   : (tabMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                    border.color: page.tabIndex === index ? Theme.accent : Theme.hairlineSoft
                    border.width: 1
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }

                    Text {
                        id: tabLbl
                        anchors.centerIn: parent
                        text: modelData
                        color: page.tabIndex === index ? Theme.accentBright : Theme.textMuted
                        font.family: Theme.fontDisplay
                        font.pixelSize: 10
                        font.letterSpacing: Theme.trackMid
                        font.weight: Font.DemiBold
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    }
                    MouseArea {
                        id: tabMa
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            page.tabIndex = parent.index
                            page.onTabActivated(parent.index)
                        }
                    }
                }
            }

            Item { Layout.fillWidth: true }

            // refresh button
            Rectangle {
                width: 30; height: 30; radius: Theme.radiusXs
                color: refreshMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent"
                border.color: Theme.hairlineSoft; border.width: 1
                Text {
                    anchors.centerIn: parent; text: "↺"
                    color: Theme.textMuted; font.pixelSize: 14
                }
                MouseArea {
                    id: refreshMa
                    anchors.fill: parent; hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: page.onTabActivated(page.tabIndex)
                }
            }
        }

        // ---- tab content ----------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            // ----------------------------------------------------------------
            // TAB 0: CALLS
            // ----------------------------------------------------------------
            ColumnLayout {
                anchors.fill: parent
                spacing: 10
                visible: page.tabIndex === 0

                // active calls list
                Text {
                    text: "ACTIVE CALLS"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay
                    font.pixelSize: 9
                    font.letterSpacing: 2.0
                    font.weight: Font.DemiBold
                }

                Rectangle {
                    Layout.fillWidth: true
                    height: 120
                    color: Theme.surface
                    radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1
                    clip: true

                    ListView {
                        id: callsList
                        anchors.fill: parent
                        anchors.margins: 8
                        model: activeCalls
                        spacing: 4
                        clip: true

                        delegate: Rectangle {
                            id: callRow
                            required property int index
                            required property string cid
                            required property string state
                            required property string reason
                            required property string from_ext
                            required property string to_ext
                            width: callsList.width
                            height: 46
                            radius: Theme.radiusXs
                            color: callRow.cid === page.activeCallId
                                   ? Theme.accentDim
                                   : Theme.surfaceStrong
                            border.color: callRow.cid === page.activeCallId
                                          ? Theme.accent
                                          : Theme.hairlineSoft
                            border.width: 1

                            RowLayout {
                                anchors.fill: parent
                                anchors.margins: 8
                                spacing: 8

                                // state dot
                                Rectangle {
                                    width: 8; height: 8; radius: 4
                                    color: callRow.state === "active"     ? Theme.success
                                         : callRow.state === "ringing"    ? Theme.amber
                                         : callRow.state === "speaking"   ? Theme.accent
                                         : Theme.textFaint
                                    SequentialAnimation on opacity {
                                        running: callRow.state === "ringing" || callRow.state === "speaking"
                                        loops: Animation.Infinite
                                        NumberAnimation { to: 0.3; duration: 600 }
                                        NumberAnimation { to: 1.0; duration: 600 }
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 0
                                    Text {
                                        text: callRow.reason || ("Call " + callRow.cid)
                                        color: Theme.text
                                        font.family: Theme.fontSans
                                        font.pixelSize: 11
                                        elide: Text.ElideRight
                                        Layout.fillWidth: true
                                    }
                                    Text {
                                        text: callRow.from_ext + " → " + callRow.to_ext
                                              + "  [" + callRow.state + "]"
                                        color: Theme.textMuted
                                        font.family: Theme.fontMono
                                        font.pixelSize: 9
                                    }
                                }

                                // transcript button
                                Rectangle {
                                    width: 58; height: 22; radius: 4
                                    color: trMa.containsMouse ? Theme.accentDim : "transparent"
                                    border.color: Theme.accentDim; border.width: 1
                                    Text {
                                        anchors.centerIn: parent; text: "TRANSCRIPT"
                                        color: Theme.accent; font.family: Theme.fontDisplay
                                        font.pixelSize: 7; font.letterSpacing: 0.8
                                    }
                                    MouseArea {
                                        id: trMa
                                        anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        property string boundCid: callRow.cid
                                        onClicked: {
                                            page.activeCallId = boundCid
                                            page.loadTranscript(boundCid)
                                        }
                                    }
                                }

                                // end call button
                                Rectangle {
                                    width: 36; height: 22; radius: 4
                                    color: endMa.containsMouse ? Theme.dangerDim : "transparent"
                                    border.color: Theme.danger; border.width: 1
                                    Text {
                                        anchors.centerIn: parent; text: "END"
                                        color: Theme.danger; font.family: Theme.fontDisplay
                                        font.pixelSize: 8; font.letterSpacing: 0.8
                                    }
                                    MouseArea {
                                        id: endMa
                                        anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        property string boundCid: callRow.cid
                                        onClicked: page.endCall(boundCid)
                                    }
                                }
                            }
                        }

                        Text {
                            visible: activeCalls.count === 0
                            anchors.centerIn: parent
                            text: "No active calls"
                            color: Theme.textFaint
                            font.family: Theme.fontSans; font.pixelSize: 12
                        }
                    }
                }

                // call status
                Text {
                    id: callStatusLabel
                    text: ""
                    color: Theme.amber
                    font.family: Theme.fontMono; font.pixelSize: 11
                    visible: text.length > 0
                }

                // ---- transcript viewer ------------------------------------
                Rectangle {
                    Layout.fillWidth: true
                    height: 90
                    visible: page.transcriptText.length > 0
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1
                    clip: true
                    Flickable {
                        anchors.fill: parent; anchors.margins: 8
                        contentWidth: width
                        contentHeight: transcriptTxt.implicitHeight
                        clip: true
                        Text {
                            id: transcriptTxt
                            width: parent.width
                            text: page.transcriptText
                            color: Theme.textMuted
                            font.family: Theme.fontMono; font.pixelSize: 10
                            wrapMode: Text.WrapAnywhere
                        }
                    }
                }

                // ---- dialer -----------------------------------------------
                Text {
                    text: "DIALER"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9
                    font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }

                Rectangle {
                    Layout.fillWidth: true
                    height: dialerCol.implicitHeight + 24
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1

                    ColumnLayout {
                        id: dialerCol
                        anchors {
                            left: parent.left; right: parent.right; top: parent.top
                            margins: 12
                        }
                        spacing: 8

                        // call type selector
                        RowLayout {
                            spacing: 8
                            Repeater {
                                model: [{ lbl: "IN-APP", val: 0 }, { lbl: "PSTN", val: 1 }]
                                delegate: Rectangle {
                                    required property var modelData
                                    height: 24
                                    implicitWidth: ctLbl.implicitWidth + 18
                                    radius: Theme.radiusXs
                                    color: dialerType.value === modelData.val
                                           ? Theme.accentDim
                                           : (ctMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                                    border.color: dialerType.value === modelData.val
                                                  ? Theme.accent : Theme.hairlineSoft
                                    border.width: 1
                                    Text {
                                        id: ctLbl
                                        anchors.centerIn: parent
                                        text: modelData.lbl
                                        color: dialerType.value === modelData.val ? Theme.accentBright : Theme.textMuted
                                        font.family: Theme.fontDisplay; font.pixelSize: 9
                                        font.letterSpacing: 0.8
                                    }
                                    MouseArea {
                                        id: ctMa
                                        anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: dialerType.value = parent.modelData.val
                                    }
                                }
                            }
                            QtObject { id: dialerType; property int value: 0 }
                        }

                        // PSTN number (only when PSTN selected)
                        TextField {
                            id: pstnField
                            Layout.fillWidth: true
                            visible: dialerType.value === 1
                            placeholderText: "Phone number  +1XXXXXXXXXX"
                            background: Rectangle {
                                color: Theme.surfaceInput
                                radius: Theme.radiusXs
                                border.color: pstnField.activeFocus ? Theme.accent : Theme.hairlineSoft
                                border.width: 1
                            }
                            color: Theme.text
                            font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; rightPadding: 10
                            height: 32
                        }

                        // reason + say
                        TextField {
                            id: reasonField
                            Layout.fillWidth: true
                            placeholderText: "Reason  (e.g. Approval needed)"
                            background: Rectangle {
                                color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: reasonField.activeFocus ? Theme.accent : Theme.hairlineSoft
                                border.width: 1
                            }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; rightPadding: 10; height: 32
                        }

                        TextField {
                            id: sayField
                            Layout.fillWidth: true
                            visible: dialerType.value === 1
                            placeholderText: "Say (TTS message for PSTN call)"
                            background: Rectangle {
                                color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: sayField.activeFocus ? Theme.accent : Theme.hairlineSoft
                                border.width: 1
                            }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; rightPadding: 10; height: 32
                        }

                        // dial button
                        Rectangle {
                            height: 32; implicitWidth: dialLbl.implicitWidth + 32
                            radius: Theme.radiusXs
                            color: dialMa.containsMouse ? Theme.accent : Theme.accentDim
                            opacity: page.callerBusy ? 0.5 : 1.0
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text {
                                id: dialLbl
                                anchors.centerIn: parent
                                text: page.callerBusy ? "Calling…"
                                      : (dialerType.value === 0 ? "CALL USER" : "PLACE PSTN CALL")
                                color: dialerType.value === 0 ? Theme.inkOnAccent : Theme.inkOnAccent
                                font.family: Theme.fontDisplay; font.pixelSize: 11
                                font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold
                            }
                            MouseArea {
                                id: dialMa; anchors.fill: parent; hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                enabled: !page.callerBusy
                                onClicked: {
                                    if (dialerType.value === 0)
                                        page.dialUser(reasonField.text || "Calling from desktop", "")
                                    else
                                        page.dialPSTN(pstnField.text.trim(),
                                                      reasonField.text || "Desktop call",
                                                      sayField.text)
                                }
                            }
                        }
                    }
                }
                Item { Layout.fillHeight: true }
            }

            // ----------------------------------------------------------------
            // TAB 1: INBOX
            // ----------------------------------------------------------------
            ColumnLayout {
                anchors.fill: parent
                spacing: 10
                visible: page.tabIndex === 1

                Text {
                    text: "INBOX MESSAGES"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay; font.pixelSize: 9
                    font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }

                // message list
                Rectangle {
                    Layout.fillWidth: true; height: 160
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1; clip: true

                    ListView {
                        id: inboxList
                        anchors.fill: parent; anchors.margins: 8
                        model: inboxModel; spacing: 4; clip: true

                        delegate: Rectangle {
                            id: msgRow
                            required property int index
                            required property string mid
                            required property string tid
                            required property string title
                            required property string priority
                            required property string status
                            width: inboxList.width; height: 38; radius: Theme.radiusXs
                            color: msgRowMa.containsMouse ? Theme.surfaceStrong : Theme.surfaceDeep
                            border.color: msgRow.priority === "critical" ? Theme.danger
                                        : msgRow.priority === "urgent"   ? Theme.amber
                                        : Theme.hairlineSoft
                            border.width: 1

                            RowLayout {
                                anchors.fill: parent; anchors.margins: 8; spacing: 8
                                Rectangle {
                                    width: 6; height: 6; radius: 3
                                    color: msgRow.priority === "critical" ? Theme.danger
                                         : msgRow.priority === "urgent"   ? Theme.amber
                                         : msgRow.priority === "low"      ? Theme.textFaint
                                         : Theme.accent
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: msgRow.title
                                    color: Theme.text
                                    font.family: Theme.fontSans; font.pixelSize: 11
                                    elide: Text.ElideRight
                                }
                                Text {
                                    text: msgRow.status
                                    color: Theme.textFaint
                                    font.family: Theme.fontMono; font.pixelSize: 9
                                }
                                Rectangle {
                                    width: 46; height: 20; radius: 4
                                    color: threadBtnMa.containsMouse ? Theme.accentDim : "transparent"
                                    border.color: Theme.accentDim; border.width: 1
                                    Text {
                                        anchors.centerIn: parent; text: "THREAD"
                                        color: Theme.accent; font.family: Theme.fontDisplay
                                        font.pixelSize: 7; font.letterSpacing: 0.6
                                    }
                                    MouseArea {
                                        id: threadBtnMa
                                        anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        property string boundTid: msgRow.tid
                                        onClicked: { if (boundTid) page.loadThread(boundTid) }
                                    }
                                }
                            }
                            MouseArea {
                                id: msgRowMa; anchors.fill: parent; hoverEnabled: true
                            }
                        }

                        Text {
                            visible: inboxModel.count === 0
                            anchors.centerIn: parent
                            text: "Inbox empty"
                            color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 12
                        }
                    }
                }

                // thread view
                Rectangle {
                    Layout.fillWidth: true; height: 80
                    visible: page.threadText.length > 0
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1; clip: true
                    Flickable {
                        anchors.fill: parent; anchors.margins: 8
                        contentWidth: width; contentHeight: threadTxt.implicitHeight; clip: true
                        Text {
                            id: threadTxt
                            width: parent.width; text: page.threadText
                            color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 10
                            wrapMode: Text.WrapAnywhere
                        }
                    }
                }

                // compose
                Text {
                    text: "COMPOSE NOTIFICATION"
                    color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9
                    font.letterSpacing: 2.0; font.weight: Font.DemiBold
                }

                Rectangle {
                    Layout.fillWidth: true
                    height: composeCol.implicitHeight + 24
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1

                    ColumnLayout {
                        id: composeCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8

                        TextField {
                            id: notifyTitle; Layout.fillWidth: true
                            placeholderText: "Title"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: notifyTitle.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; rightPadding: 10; height: 32
                        }

                        TextField {
                            id: notifyMsg; Layout.fillWidth: true
                            placeholderText: "Message"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: notifyMsg.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; rightPadding: 10; height: 32
                        }

                        RowLayout {
                            spacing: 8
                            Repeater {
                                model: ["low", "normal", "urgent", "critical"]
                                delegate: Rectangle {
                                    required property string modelData
                                    height: 24; implicitWidth: pLbl.implicitWidth + 16
                                    radius: Theme.radiusXs
                                    color: notifyPriority.value === modelData
                                           ? Theme.accentDim
                                           : (pMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                                    border.color: notifyPriority.value === modelData ? Theme.accent : Theme.hairlineSoft
                                    border.width: 1
                                    Text {
                                        id: pLbl; anchors.centerIn: parent; text: modelData.toUpperCase()
                                        color: notifyPriority.value === modelData ? Theme.accentBright : Theme.textMuted
                                        font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.6
                                    }
                                    MouseArea {
                                        id: pMa; anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: notifyPriority.value = parent.modelData
                                    }
                                }
                            }
                            QtObject { id: notifyPriority; property string value: "normal" }
                            Item { Layout.fillWidth: true }
                            Rectangle {
                                height: 28; implicitWidth: sendLbl.implicitWidth + 24
                                radius: Theme.radiusXs
                                color: sendMa.containsMouse ? Theme.accent : Theme.accentDim
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Text {
                                    id: sendLbl; anchors.centerIn: parent; text: "SEND"
                                    color: Theme.inkOnAccent; font.family: Theme.fontDisplay
                                    font.pixelSize: 10; font.letterSpacing: Theme.trackMid
                                    font.weight: Font.DemiBold
                                }
                                MouseArea {
                                    id: sendMa; anchors.fill: parent; hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: page.sendNotify(notifyTitle.text, notifyMsg.text,
                                                               notifyPriority.value)
                                }
                            }
                        }

                        Text {
                            id: notifyStatus
                            text: ""; visible: text.length > 0
                            color: Theme.success; font.family: Theme.fontMono; font.pixelSize: 10
                        }
                    }
                }
                Item { Layout.fillHeight: true }
            }

            // ----------------------------------------------------------------
            // TAB 2: PHONE SETTINGS
            // ----------------------------------------------------------------
            Flickable {
                anchors.fill: parent
                visible: page.tabIndex === 2
                contentWidth: width
                contentHeight: settingsCol.implicitHeight + 20
                clip: true

                ColumnLayout {
                    id: settingsCol
                    width: parent.width
                    spacing: 14

                    // ---- Twilio status ----------------------------------------
                    Text {
                        text: "TWILIO STATUS"
                        color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    }

                    Rectangle {
                        Layout.fillWidth: true; height: twilioStatusRow.implicitHeight + 20
                        color: Theme.surface; radius: Theme.radiusSm
                        border.color: Theme.hairlineSoft; border.width: 1

                        ColumnLayout {
                            id: twilioStatusRow
                            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                            spacing: 6
                            RowLayout {
                                spacing: 8
                                Text { text: "Status:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                Text { id: twilioConfigured; text: "–"; color: Theme.accent; font.family: Theme.fontMono; font.pixelSize: 11 }
                            }
                            RowLayout {
                                spacing: 8
                                Text { text: "Number:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                Text { id: fromNumber; text: "–"; color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11 }
                            }
                            RowLayout {
                                spacing: 8
                                Text { text: "Voice:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                Text {
                                    text: page.voiceProfile || "–"
                                    color: Theme.violet; font.family: Theme.fontMono; font.pixelSize: 11
                                }
                            }
                            // Screening toggle
                            RowLayout {
                                spacing: 8
                                Text { text: "Screening:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                Rectangle {
                                    width: 42; height: 22; radius: 11
                                    color: page.screeningOn ? Theme.accent : Theme.surfaceStrong
                                    border.color: page.screeningOn ? Theme.accentGlow : Theme.hairline; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durMid } }
                                    Rectangle {
                                        width: 16; height: 16; radius: 8
                                        anchors.verticalCenter: parent.verticalCenter
                                        x: page.screeningOn ? parent.width - width - 3 : 3
                                        color: Theme.text
                                        Behavior on x { NumberAnimation { duration: Theme.durMid; easing.type: Easing.OutCubic } }
                                    }
                                    MouseArea {
                                        id: screeningSwitch
                                        property bool checked: page.screeningOn
                                        anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                                        onClicked: page.setScreening(!page.screeningOn)
                                    }
                                }
                                Text {
                                    text: page.screeningOn ? "ON" : "OFF"
                                    color: page.screeningOn ? Theme.accent : Theme.textFaint
                                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1.0
                                }
                            }
                        }
                    }

                    // ---- Set user number ------------------------------------
                    Text {
                        text: "USER PHONE NUMBER"
                        color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    }

                    RowLayout {
                        Layout.fillWidth: true; spacing: 8
                        TextField {
                            id: userNumField; Layout.fillWidth: true
                            placeholderText: "+1XXXXXXXXXX"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: userNumField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; height: 32
                        }
                        Rectangle {
                            height: 32; implicitWidth: setNumLbl.implicitWidth + 20; radius: Theme.radiusXs
                            color: setNumMa.containsMouse ? Theme.accent : Theme.accentDim
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: setNumLbl; anchors.centerIn: parent; text: "SET"
                                color: Theme.inkOnAccent; font.family: Theme.fontDisplay
                                font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                            MouseArea {
                                id: setNumMa; anchors.fill: parent; hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: { if (userNumField.text.trim()) page.setUserNumber(userNumField.text.trim()) }
                            }
                        }
                    }

                    // ---- Allowlist ------------------------------------------
                    Text {
                        text: "PSTN ALLOWLIST"
                        color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    }

                    Rectangle {
                        Layout.fillWidth: true; height: 100
                        color: Theme.surface; radius: Theme.radiusSm
                        border.color: Theme.hairlineSoft; border.width: 1; clip: true
                        ListView {
                            id: allowList
                            anchors.fill: parent; anchors.margins: 8
                            model: allowlistModel; spacing: 4; clip: true
                            delegate: RowLayout {
                                id: alRow
                                required property int index
                                required property string num
                                required property string label
                                width: allowList.width; spacing: 8
                                Text {
                                    Layout.fillWidth: true
                                    text: alRow.num + (alRow.label ? "  " + alRow.label : "")
                                    color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11
                                    elide: Text.ElideRight
                                }
                                Rectangle {
                                    width: 30; height: 20; radius: 4
                                    color: alRemMa.containsMouse ? Theme.dangerDim : "transparent"
                                    border.color: Theme.danger; border.width: 1
                                    Text { anchors.centerIn: parent; text: "✕"; color: Theme.danger; font.pixelSize: 10 }
                                    MouseArea {
                                        id: alRemMa; anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        property string boundNum: alRow.num
                                        onClicked: page.removeAllowNumber(boundNum)
                                    }
                                }
                            }
                            Text {
                                visible: allowlistModel.count === 0; anchors.centerIn: parent
                                text: "No numbers allowlisted"
                                color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 11
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true; spacing: 8
                        TextField {
                            id: addNumField; Layout.fillWidth: true
                            placeholderText: "+1XXXXXXXXXX  (optional label)"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs
                                border.color: addNumField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                            leftPadding: 10; height: 32
                        }
                        Rectangle {
                            height: 32; implicitWidth: addNumLbl.implicitWidth + 20; radius: Theme.radiusXs
                            color: addNumMa.containsMouse ? Theme.accent : Theme.accentDim
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: addNumLbl; anchors.centerIn: parent; text: "ADD"
                                color: Theme.inkOnAccent; font.family: Theme.fontDisplay
                                font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                            MouseArea {
                                id: addNumMa; anchors.fill: parent; hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    var parts = addNumField.text.trim().split(/\s+/, 2)
                                    if (parts[0]) page.addAllowNumber(parts[0], parts[1] || "")
                                }
                            }
                        }
                    }

                    // ---- War Room -------------------------------------------
                    Text {
                        text: "WAR ROOM"
                        color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    }

                    Rectangle {
                        Layout.fillWidth: true; height: warRoomCol.implicitHeight + 24
                        color: Theme.surface; radius: Theme.radiusSm
                        border.color: Theme.danger; border.width: 1

                        ColumnLayout {
                            id: warRoomCol
                            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                            spacing: 8

                            RowLayout {
                                Layout.fillWidth: true
                                ArcReactor {
                                    size: 20; tint: Theme.danger
                                    Layout.alignment: Qt.AlignVCenter
                                }
                                Text {
                                    text: "RED ALERT broadcasts to every agent and opens a war-room thread."
                                    color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true; spacing: 8
                                TextField {
                                    id: alertMsgField; Layout.fillWidth: true
                                    placeholderText: "Alert message…"
                                    background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs
                                        border.color: alertMsgField.activeFocus ? Theme.danger : Theme.hairlineSoft; border.width: 1 }
                                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12
                                    leftPadding: 10; height: 32
                                }
                                Rectangle {
                                    height: 32; implicitWidth: alertLbl.implicitWidth + 20; radius: Theme.radiusXs
                                    color: alertMa.containsMouse ? Theme.danger : Theme.dangerDim
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: alertLbl; anchors.centerIn: parent; text: "RED ALERT"
                                        color: Theme.text; font.family: Theme.fontDisplay
                                        font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                                    MouseArea {
                                        id: alertMa; anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: { if (alertMsgField.text.trim()) page.redAlert(alertMsgField.text.trim()) }
                                    }
                                }
                            }
                            Text {
                                id: alertStatus; text: ""; visible: text.length > 0
                                color: Theme.amber; font.family: Theme.fontMono; font.pixelSize: 10
                            }
                        }
                    }

                    Item { height: 20 }
                }
            }
        }
    }
}
