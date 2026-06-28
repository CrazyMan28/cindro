pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// SETTINGS tab — all settings cards from the Android Agent Phone app:
// connection, SMS agent, call screening (transport/auto/who-answers/who-screens/
// carrier-forwarding incl. Verizon *72/*73), Bluetooth relay puck, diagnostics,
// call history, allowlist, add-agent, and war-room Red Alert.
Item {
    id: tab
    property var phonePage

    // ---- async helpers --------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    // phoneMcp path (existing tools: twilio_status, allowlist, red_alert, register…)
    function callTool(tool, args, cb) {
        var id = "settings_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    // phone.http path (REST routes on the phone server)
    function callHttp(method, path, body, cb) {
        var id = "settingsH_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneHttp(id, method, path, body || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
        function onPhoneHttpResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
    }

    // ---- state ----------------------------------------------------------------
    // Twilio / connection
    property bool   twilioConfigured: false
    property string fromNumber:       ""
    property bool   screeningOn:      false
    property string voiceProfile:     "(default)"
    // SMS agent
    property bool   smsEnabled:       false
    property string smsAgentExt:      ""
    // Screening
    property string screenTransport:  "twilio"
    property string inboundExt:       ""
    property string screeningExt:     ""
    // Diagnostics
    property bool   diagHealthOk:     false
    property bool   diagAuthOk:       false
    property bool   diagWsOk:         false
    property bool   diagMistralOk:    false
    property string diagError:        ""
    // Call history
    property bool   historyLoading:   false
    ListModel { id: callHistoryModel }
    // Allowlist
    ListModel { id: allowlistModel }
    // Agents (for picker cards)
    ListModel { id: agentsModel }

    // active sub-screen: "" | "history" | "diagnostics"
    property string subScreen: ""

    // ---- functions ------------------------------------------------------------
    function refresh() {
        tab.callTool("twilio_status", {}, function(r) {
            if (!r.error) {
                var d = r.data || {}
                tab.twilioConfigured = d.configured === true
                tab.fromNumber       = d.from_number || ""
                tab.screeningOn      = d.screening_enabled === true
            }
        })
        tab.callTool("twilio_allowlist_list", {}, function(r) {
            if (!r.error) {
                var nums = (r.data && r.data.numbers instanceof Array) ? r.data.numbers
                         : (r.data instanceof Array ? r.data : [])
                allowlistModel.clear()
                for (var i = 0; i < nums.length; i++) {
                    var n = nums[i]
                    allowlistModel.append({ "num": (typeof n === "string") ? n : (n.phone_number || ""), "lbl": (typeof n === "object" && n.label) ? n.label : "" })
                }
            }
        })
        tab.callTool("get_voice_profile", { extension: 100 }, function(r) {
            if (!r.error) {
                var d = r.data || {}; var vp = d.voice || d
                tab.voiceProfile = vp.voice_id || vp.voice_name || vp.name || "(default)"
            }
        })
        // Screening + SMS config — GET /api/screening
        tab.callHttp("GET", "/api/screening", {}, function(r) {
            if (!r.error && r.data) {
                var d = r.data || {}
                tab.screeningOn     = d.enabled === true
                tab.screenTransport = d.transport || "twilio"
                tab.inboundExt      = "" + (d.inbound_extension  || "")
                tab.screeningExt    = "" + (d.screening_extension || "")
            }
        })
        // SMS agent — GET /api/sms-agent
        tab.callHttp("GET", "/api/sms-agent", {}, function(r) {
            if (!r.error && r.data) {
                var d = r.data || {}
                tab.smsEnabled  = d.enabled === true
                tab.smsAgentExt = "" + (d.extension || "")
            }
        })
        // agents for picker
        tab.callTool("list_extensions", {}, function(r) {
            if (!r.error && r.data instanceof Array) {
                agentsModel.clear()
                for (var i = 0; i < r.data.length; i++) {
                    var a = r.data[i]
                    agentsModel.append({ "ext": ("" + (a.extension || a.ext || "")), "aname": (a.name || "Agent") })
                }
            }
        })
    }

    function runDiagnostics() {
        tab.diagError = ""
        tab.callTool("twilio_status", {}, function(r) {
            tab.diagHealthOk = !r.error && r.data && r.data.configured === true
            tab.diagAuthOk   = !r.error
            tab.diagError    = r.error ? (r.error.message || "Twilio error") : ""
        })
        // WebSocket test: if bridge is connected, WS is up
        tab.diagWsOk = bridge.connected
        // Setup/health — GET /api/setup/status
        tab.callHttp("GET", "/api/setup/status", {}, function(r) {
            if (!r.error && r.data) {
                var d = r.data || {}
                tab.diagMistralOk = d.mistral_configured === true || d.mistral_ok === true
            }
        })
    }

    function loadHistory() {
        tab.historyLoading = true
        callHistoryModel.clear()
        // GET /api/calls (returns array or {calls:[...]})
        tab.callHttp("GET", "/api/calls", {}, function(r) {
            tab.historyLoading = false
            if (r.error) return
            var arr = r.data instanceof Array ? r.data
                    : (r.data && r.data.calls instanceof Array ? r.data.calls : [])
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i]
                callHistoryModel.append({
                    "cfrom":  c.from_extension || c.from || "—",
                    "cto":    c.to_extension   || c.to   || "—",
                    "cstate": c.state          || "",
                    "creason":c.reason         || "",
                    "cts":    c.created_at     || c.timestamp || "",
                    "missed": c.missed === true
                })
            }
        })
    }

    function addAllowNumber(num, lbl) {
        tab.callTool("twilio_allowlist_add", { phone_number: num, label: lbl }, function(r) { tab.refresh() })
    }
    function removeAllowNumber(num) {
        tab.callTool("twilio_allowlist_remove", { phone_number: num }, function(r) { tab.refresh() })
    }
    function setUserNumber(num) {
        tab.callTool("twilio_set_user_number", { phone_number: num }, function(r) { if (!r.error) tab.refresh() })
    }
    function setScreening(enable) {
        tab.callTool(enable ? "twilio_screening_enable" : "twilio_screening_disable", {}, function(r) { tab.screeningOn = enable })
    }
    function setTransport(t) {
        var prev = tab.screenTransport; tab.screenTransport = t
        // POST /api/screening {transport: t}
        tab.callHttp("POST", "/api/screening", { transport: t }, function(r) { if (r.error) tab.screenTransport = prev })
    }
    function setSmsEnabled(want) {
        // POST /api/sms-agent {enabled: bool}
        tab.callHttp("POST", "/api/sms-agent", { enabled: want }, function(r) { if (!r.error) tab.smsEnabled = want })
    }
    function setSmsAgent(ext) {
        var prev = tab.smsAgentExt; tab.smsAgentExt = ext
        // POST /api/sms-agent {extension: str}
        tab.callHttp("POST", "/api/sms-agent", { extension: ext }, function(r) { if (r.error) tab.smsAgentExt = prev })
    }
    function setInboundAgent(ext) {
        var prev = tab.inboundExt; tab.inboundExt = ext
        // POST /api/screening {inbound_extension: str}
        tab.callHttp("POST", "/api/screening", { inbound_extension: ext }, function(r) { if (r.error) tab.inboundExt = prev })
    }
    function setScreeningAgent(ext) {
        var prev = tab.screeningExt; tab.screeningExt = ext
        // POST /api/screening {screening_extension: str}
        tab.callHttp("POST", "/api/screening", { screening_extension: ext }, function(r) { if (r.error) tab.screeningExt = prev })
    }
    function redAlert(msg) {
        tab.callTool("red_alert", { message: msg }, function(r) {
            _alertStatus.text = r.error ? ("Error: " + (r.error.message || "?")) : "Alert broadcast"
        })
    }
    function registerAgent(ext, aname, token) {
        tab.callTool("register_inbound_agent", { extension: ext, name: aname, token: token }, function(r) {
            _enrollStatus.text = r.error ? ("Error: " + (r.error.message || "?")) : "Agent registered — ext " + ext
            if (!r.error) tab.refresh()
        })
    }

    // ---- helper: section label -----------------------------------------------
    // (inline Text used directly — keeps QML concise)

    // ---- UI -------------------------------------------------------------------
    Item {
        anchors.fill: parent

        // ════════════════════════════════════════════════════════════════════
        // HISTORY sub-screen
        // ════════════════════════════════════════════════════════════════════
        ColumnLayout {
            anchors.fill: parent
            spacing: 10
            visible: tab.subScreen === "history"

            RowLayout {
                Layout.fillWidth: true; spacing: 8
                Rectangle {
                    width: 28; height: 28; radius: Theme.radiusXs
                    color: _histBackMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                    border.color: Theme.hairlineSoft; border.width: 1
                    Text { anchors.centerIn: parent; text: "←"; color: Theme.textMuted; font.pixelSize: 14 }
                    MouseArea { id: _histBackMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.subScreen = "" }
                }
                Text { text: "CALL HISTORY"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.DemiBold; Layout.fillWidth: true }
                Rectangle {
                    width: 26; height: 26; radius: Theme.radiusXs
                    color: _histRefMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                    border.color: Theme.hairlineSoft; border.width: 1
                    Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 13 }
                    MouseArea { id: _histRefMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.loadHistory() }
                }
            }

            Text { visible: tab.historyLoading; text: "Loading…"; color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 11 }
            Text { visible: callHistoryModel.count === 0 && !tab.historyLoading; text: "No call history yet."; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 12 }

            ListView {
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: callHistoryModel.count > 0
                model: callHistoryModel; spacing: 8; clip: true
                delegate: Rectangle {
                    id: _hRow
                    required property string cfrom
                    required property string cto
                    required property string cstate
                    required property string creason
                    required property string cts
                    required property bool   missed
                    width: ListView.view.width; height: _hRowContent.implicitHeight + 18
                    radius: Theme.radiusXs
                    color: Theme.surface; border.color: Theme.hairlineSoft; border.width: 1
                    RowLayout {
                        id: _hRowContent
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
                        spacing: 10
                        ColumnLayout {
                            Layout.fillWidth: true; spacing: 2
                            Text {
                                text: _hRow.cfrom + " → " + _hRow.cto
                                color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11
                            }
                            Text {
                                text: [_hRow.cstate, _hRow.creason].filter(function(s){ return s.length > 0 }).join(" · ")
                                color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                            }
                        }
                        Text {
                            text: _hRow.cts.length > 5 ? _hRow.cts.slice(-8).slice(0,5) : _hRow.cts
                            color: _hRow.missed ? Theme.danger : Theme.success
                            font.family: Theme.fontMono; font.pixelSize: 10
                        }
                    }
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // DIAGNOSTICS sub-screen
        // ════════════════════════════════════════════════════════════════════
        Flickable {
            anchors.fill: parent
            contentWidth: width; contentHeight: _diagCol.implicitHeight + 24; clip: true
            visible: tab.subScreen === "diagnostics"
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            ColumnLayout {
                id: _diagCol; width: parent.width; spacing: 10

                RowLayout {
                    Layout.fillWidth: true; spacing: 8
                    Rectangle {
                        width: 28; height: 28; radius: Theme.radiusXs
                        color: _diagBackMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                        border.color: Theme.hairlineSoft; border.width: 1
                        Text { anchors.centerIn: parent; text: "←"; color: Theme.textMuted; font.pixelSize: 14 }
                        MouseArea { id: _diagBackMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.subScreen = "" }
                    }
                    Text { text: "DIAGNOSTICS"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 13; font.weight: Font.DemiBold; Layout.fillWidth: true }
                    Rectangle {
                        height: 28; implicitWidth: _diagRunLbl.implicitWidth + 16; radius: Theme.radiusXs
                        color: _diagRunMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _diagRunLbl; anchors.centerIn: parent; text: "RUN"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                        MouseArea { id: _diagRunMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.runDiagnostics() }
                    }
                }

                // check cards
                Repeater {
                    model: [
                        { label: "Twilio configured",  ok: tab.diagHealthOk, detail: "GET /twilio_status" },
                        { label: "Auth token",         ok: tab.diagAuthOk,   detail: "Tool response OK" },
                        { label: "WebSocket / daemon", ok: tab.diagWsOk,     detail: "bridge.connected" },
                        { label: "Mistral API key",    ok: tab.diagMistralOk,detail: "From server health" }
                    ]
                    delegate: Rectangle {
                        required property var modelData
                        Layout.fillWidth: true; height: _ckRow.implicitHeight + 18
                        color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                        RowLayout {
                            id: _ckRow
                            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                            spacing: 10
                            Rectangle {
                                width: 30; height: 30; radius: 15
                                color: parent.parent.modelData.ok === true  ? Qt.rgba(0.22,0.90,0.63,0.18)
                                     : parent.parent.modelData.ok === false ? Qt.rgba(1.0,0.42,0.42,0.15)
                                     : Qt.rgba(0.36,0.49,0.58,0.14)
                                Text {
                                    anchors.centerIn: parent
                                    text: parent.parent.modelData.ok === true ? "✓" : parent.parent.modelData.ok === false ? "✗" : "?"
                                    color: parent.parent.modelData.ok === true ? Theme.success : parent.parent.modelData.ok === false ? Theme.danger : Theme.textMuted
                                    font.pixelSize: 14
                                }
                            }
                            ColumnLayout { Layout.fillWidth: true; spacing: 0
                                Text { text: parent.parent.modelData.label; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12 }
                                Text { text: parent.parent.modelData.detail; color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 9 }
                            }
                            Text {
                                text: parent.parent.modelData.ok === true ? "OK" : parent.parent.modelData.ok === false ? "FAIL" : "—"
                                color: parent.parent.modelData.ok === true ? Theme.success : parent.parent.modelData.ok === false ? Theme.danger : Theme.textFaint
                                font.family: Theme.fontDisplay; font.pixelSize: 10; font.weight: Font.DemiBold
                            }
                        }
                    }
                }

                // error detail
                Rectangle {
                    Layout.fillWidth: true; height: _diagErrCol.implicitHeight + 18
                    visible: tab.diagError.length > 0
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.danger; border.width: 1
                    ColumnLayout {
                        id: _diagErrCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 4
                        Text { text: "Last error"; color: Theme.danger; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium }
                        Text { text: tab.diagError; color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 10; wrapMode: Text.WrapAnywhere; Layout.fillWidth: true }
                    }
                }

                Item { height: 20 }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // MAIN SETTINGS (scrollable)
        // ════════════════════════════════════════════════════════════════════
        Flickable {
            anchors.fill: parent
            contentWidth: width; contentHeight: _settingsCol.implicitHeight + 24; clip: true
            visible: tab.subScreen === ""
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            ColumnLayout {
                id: _settingsCol; width: parent.width; spacing: 14

                // ── Action tiles ──────────────────────────────────────────────
                Repeater {
                    model: [
                        { icon: "⚡", label: "Diagnostics",   desc: "Inspect connection, auth, and service health.",     screen: "diagnostics" },
                        { icon: "📋", label: "Call history",  desc: "Recent calls and missed calls.",                    screen: "history" }
                    ]
                    delegate: Rectangle {
                        required property var modelData
                        Layout.fillWidth: true; height: _atRow.implicitHeight + 18
                        radius: Theme.radiusSm; color: _atMa.containsMouse ? Theme.surfaceStrong : Theme.surface
                        border.color: Theme.hairlineSoft; border.width: 1
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        RowLayout {
                            id: _atRow
                            anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                            spacing: 12
                            Rectangle {
                                width: 36; height: 36; radius: 18; color: Qt.rgba(0.239,0.839,1.0,0.18)
                                Text { anchors.centerIn: parent; text: parent.parent.parent.modelData.icon; font.pixelSize: 16 }
                            }
                            ColumnLayout { Layout.fillWidth: true; spacing: 2
                                Text { text: parent.parent.parent.modelData.label; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 13; font.weight: Font.Medium }
                                Text { text: parent.parent.parent.modelData.desc; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            }
                            Text { text: "›"; color: Theme.textFaint; font.pixelSize: 18 }
                        }
                        MouseArea {
                            id: _atMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            property string _scr: parent.modelData.screen
                            onClicked: {
                                tab.subScreen = _scr
                                if (_scr === "history") tab.loadHistory()
                                else if (_scr === "diagnostics") tab.runDiagnostics()
                            }
                        }
                    }
                }

                // ── Twilio status card ────────────────────────────────────────
                Text { text: "TWILIO STATUS"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: _twCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _twCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 6
                        RowLayout {
                            spacing: 8
                            Text { text: "Status:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                            Text { text: tab.twilioConfigured ? "Configured" : "Not configured"; color: tab.twilioConfigured ? Theme.success : Theme.danger; font.family: Theme.fontMono; font.pixelSize: 11 }
                        }
                        RowLayout {
                            spacing: 8
                            Text { text: "Number:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                            Text { text: tab.fromNumber || "—"; color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11 }
                        }
                        RowLayout {
                            spacing: 8
                            Text { text: "Voice:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                            Text { text: tab.voiceProfile; color: Theme.violet; font.family: Theme.fontMono; font.pixelSize: 11 }
                        }
                        // Screening toggle row
                        RowLayout {
                            spacing: 8
                            Text { text: "Screening:"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                            Rectangle {
                                width: 42; height: 22; radius: 11
                                color: tab.screeningOn ? Theme.accent : Theme.surfaceStrong
                                border.color: tab.screeningOn ? Theme.accentGlow : Theme.hairline; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durMid } }
                                Rectangle {
                                    width: 16; height: 16; radius: 8; anchors.verticalCenter: parent.verticalCenter
                                    x: tab.screeningOn ? parent.width - width - 3 : 3
                                    color: Theme.text
                                    Behavior on x { NumberAnimation { duration: Theme.durMid; easing.type: Easing.OutCubic } }
                                }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: tab.setScreening(!tab.screeningOn) }
                            }
                            Text { text: tab.screeningOn ? "ON" : "OFF"; color: tab.screeningOn ? Theme.accent : Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 1.0 }
                        }
                    }
                }

                // ── User phone number ─────────────────────────────────────────
                Text { text: "USER PHONE NUMBER"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                RowLayout {
                    Layout.fillWidth: true; spacing: 8
                    TextField {
                        id: _unField; Layout.fillWidth: true; placeholderText: "+1XXXXXXXXXX"
                        background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _unField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                    }
                    Rectangle {
                        height: 32; implicitWidth: _unLbl.implicitWidth + 20; radius: Theme.radiusXs
                        color: _unMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _unLbl; anchors.centerIn: parent; text: "SET"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                        MouseArea { id: _unMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (_unField.text.trim()) tab.setUserNumber(_unField.text.trim()) } }
                    }
                }

                // ── SMS agent card ────────────────────────────────────────────
                Text { text: "TEXT YOUR AGENT (SMS)"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: _smsCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _smsCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 10

                        RowLayout {
                            Layout.fillWidth: true
                            ColumnLayout { Layout.fillWidth: true; spacing: 2
                                Text { text: "Text your agent (SMS)"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; font.weight: Font.Medium }
                                Text {
                                    text: tab.smsEnabled ? "ON — texting your number reaches the agent, which texts you back."
                                                         : "OFF — inbound texts just land in your inbox."
                                    color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }
                            }
                            // toggle
                            Rectangle {
                                width: 42; height: 22; radius: 11
                                color: tab.smsEnabled ? Theme.accent : Theme.surfaceStrong
                                border.color: tab.smsEnabled ? Theme.accentGlow : Theme.hairline; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durMid } }
                                Rectangle {
                                    width: 16; height: 16; radius: 8; anchors.verticalCenter: parent.verticalCenter
                                    x: tab.smsEnabled ? parent.width - width - 3 : 3; color: Theme.text
                                    Behavior on x { NumberAnimation { duration: Theme.durMid; easing.type: Easing.OutCubic } }
                                }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: tab.setSmsEnabled(!tab.smsEnabled) }
                            }
                        }

                        // who answers texts
                        Text { text: "Who answers your texts"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium; visible: agentsModel.count > 0 }
                        Flow {
                            Layout.fillWidth: true; spacing: 8; visible: agentsModel.count > 0
                            Repeater {
                                model: agentsModel
                                delegate: Rectangle {
                                    id: _smsAgCard
                                    required property string ext
                                    required property string aname
                                    property bool _sel: tab.smsAgentExt === ext
                                    height: 28; implicitWidth: _smsAgLbl.implicitWidth + 20; radius: Theme.radiusXs
                                    color: _sel ? Theme.accentDim : (_smsAgMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent")
                                    border.color: _sel ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: _smsAgLbl; anchors.centerIn: parent; text: _smsAgCard.aname; color: _sel ? Theme.accent : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                    MouseArea {
                                        id: _smsAgMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        property string _ext: _smsAgCard.ext
                                        onClicked: tab.setSmsAgent(_ext)
                                    }
                                }
                            }
                        }

                        Text { text: "Your number must be on the Twilio allowlist."; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    }
                }

                // ── Call screening card ───────────────────────────────────────
                Text { text: "CALL SCREENING"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: _scCard.implicitHeight + 20
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _scCard
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 10

                        // transport selector
                        Text { text: "Transport"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium }
                        Text { text: "How a screened call reaches your agent."; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10 }
                        RowLayout {
                            spacing: 8; Layout.fillWidth: true
                            Rectangle {
                                Layout.fillWidth: true; height: 30; radius: Theme.radiusXs
                                color: tab.screenTransport === "twilio" ? Theme.accentDim : (_trTwMa.containsMouse ? Qt.rgba(1,1,1,0.06) : "transparent")
                                border.color: tab.screenTransport === "twilio" ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Text { anchors.centerIn: parent; text: "Twilio (anywhere)"; color: tab.screenTransport === "twilio" ? Theme.accentBright : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                MouseArea { id: _trTwMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.setTransport("twilio") }
                            }
                            Rectangle {
                                Layout.fillWidth: true; height: 30; radius: Theme.radiusXs
                                color: tab.screenTransport === "relay" ? Theme.accentDim : (_trBlMa.containsMouse ? Qt.rgba(1,1,1,0.06) : "transparent")
                                border.color: tab.screenTransport === "relay" ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Text { anchors.centerIn: parent; text: "Bluetooth relay (M507)"; color: tab.screenTransport === "relay" ? Theme.accentBright : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                MouseArea { id: _trBlMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.setTransport("relay") }
                            }
                        }

                        // auto-screen toggle
                        RowLayout {
                            Layout.fillWidth: true; spacing: 8
                            ColumnLayout { Layout.fillWidth: true; spacing: 2
                                Text { text: "Auto-screen calls"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; font.weight: Font.Medium }
                                Text {
                                    text: tab.screeningOn ? "ON — agent answers calls you decline or don't pick up."
                                                          : "OFF — calls are not screened."
                                    color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }
                            }
                            Rectangle {
                                width: 42; height: 22; radius: 11
                                color: tab.screeningOn ? Theme.accent : Theme.surfaceStrong
                                border.color: tab.screeningOn ? Theme.accentGlow : Theme.hairline; border.width: 1
                                Behavior on color { ColorAnimation { duration: Theme.durMid } }
                                Rectangle {
                                    width: 16; height: 16; radius: 8; anchors.verticalCenter: parent.verticalCenter
                                    x: tab.screeningOn ? parent.width - width - 3 : 3; color: Theme.text
                                    Behavior on x { NumberAnimation { duration: Theme.durMid; easing.type: Easing.OutCubic } }
                                }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: tab.setScreening(!tab.screeningOn) }
                            }
                        }

                        // who answers when YOU call in
                        Text { text: "Who answers when YOU call in"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium; visible: agentsModel.count > 0 }
                        Text { text: "When you dial your own number, this agent picks up."; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10; visible: agentsModel.count > 0 }
                        Flow {
                            Layout.fillWidth: true; spacing: 8; visible: agentsModel.count > 0
                            Repeater {
                                model: agentsModel
                                delegate: Rectangle {
                                    id: _ibCard
                                    required property string ext
                                    required property string aname
                                    property bool _sel: tab.inboundExt === ext
                                    height: 28; implicitWidth: _ibLbl.implicitWidth + 20; radius: Theme.radiusXs
                                    color: _sel ? Theme.accentDim : (_ibMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent")
                                    border.color: _sel ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: _ibLbl; anchors.centerIn: parent; text: _ibCard.aname; color: _sel ? Theme.accent : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                    MouseArea {
                                        id: _ibMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        property string _ext: _ibCard.ext
                                        onClicked: tab.setInboundAgent(_ext)
                                    }
                                }
                            }
                        }

                        // who screens unknown callers
                        Text { text: "Who screens unknown callers"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium; visible: agentsModel.count > 0 }
                        Text { text: "Mistral Screener is a fast, tool-free brain for screening."; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10; visible: agentsModel.count > 0 }
                        Flow {
                            Layout.fillWidth: true; spacing: 8; visible: agentsModel.count > 0
                            Repeater {
                                model: agentsModel
                                delegate: Rectangle {
                                    id: _scAgCard
                                    required property string ext
                                    required property string aname
                                    property bool _sel: tab.screeningExt === ext
                                    height: 28; implicitWidth: _scAgLbl.implicitWidth + 20; radius: Theme.radiusXs
                                    color: _sel ? Theme.accentDim : (_scAgMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent")
                                    border.color: _sel ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text { id: _scAgLbl; anchors.centerIn: parent; text: _scAgCard.aname; color: _sel ? Theme.accent : Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11 }
                                    MouseArea {
                                        id: _scAgMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        property string _ext: _scAgCard.ext
                                        onClicked: tab.setScreeningAgent(_ext)
                                    }
                                }
                            }
                        }

                        // carrier forwarding — Twilio transport
                        ColumnLayout {
                            visible: tab.screenTransport === "twilio"
                            Layout.fillWidth: true; spacing: 8

                            Text { text: "Carrier forwarding (one-time setup)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium }
                            Text {
                                text: "Sends declined/missed calls to the agent instead of voicemail. Tap a code to copy it, then dial manually. Undo with ##002#."
                                color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10
                                wrapMode: Text.WordWrap; Layout.fillWidth: true
                            }
                            // GSM codes
                            RowLayout {
                                spacing: 8; Layout.fillWidth: true
                                Repeater {
                                    model: [
                                        { lbl: "Set all",    code: "**004*+15551234567#" },
                                        { lbl: "Check",      code: "*#002#" },
                                        { lbl: "Undo",       code: "##002#" }
                                    ]
                                    delegate: Rectangle {
                                        required property var modelData
                                        Layout.fillWidth: true; height: 30; radius: Theme.radiusXs
                                        color: _gsmMa.containsMouse ? Theme.accentDim : "transparent"
                                        border.color: Theme.accentDim; border.width: 1
                                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                        Text { anchors.centerIn: parent; text: parent.modelData.lbl; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.6 }
                                        MouseArea {
                                            id: _gsmMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                            property string code: parent.modelData.code
                                            onClicked: Qt.openUrlExternally("tel:" + code)
                                        }
                                    }
                                }
                            }
                            RowLayout {
                                spacing: 8; Layout.fillWidth: true
                                Repeater {
                                    model: [
                                        { lbl: "Busy",        code: "**67*+15551234567#" },
                                        { lbl: "No answer",   code: "**61*+15551234567#" },
                                        { lbl: "Unreachable", code: "**62*+15551234567#" }
                                    ]
                                    delegate: Rectangle {
                                        required property var modelData
                                        Layout.fillWidth: true; height: 30; radius: Theme.radiusXs
                                        color: _gsmMa2.containsMouse ? Qt.rgba(1,1,1,0.06) : "transparent"
                                        border.color: Theme.hairlineSoft; border.width: 1
                                        Text { anchors.centerIn: parent; text: parent.modelData.lbl; color: Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.6 }
                                        MouseArea {
                                            id: _gsmMa2; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                            property string code: parent.modelData.code
                                            onClicked: Qt.openUrlExternally("tel:" + code)
                                        }
                                    }
                                }
                            }
                            // Verizon codes
                            Text {
                                text: "Verizon: use Verizon's own codes. Try \"Busy/no-answer\" first (rings you, rolls to agent if you decline/miss). Press call after each."
                                color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10
                                wrapMode: Text.WordWrap; Layout.fillWidth: true
                            }
                            RowLayout {
                                spacing: 8; Layout.fillWidth: true
                                Repeater {
                                    model: [
                                        { lbl: "VZ busy/no-ans", code: "*715551234567" },
                                        { lbl: "VZ all (*72)",   code: "*725551234567" },
                                        { lbl: "VZ off (*73)",   code: "*73" }
                                    ]
                                    delegate: Rectangle {
                                        required property var modelData
                                        Layout.fillWidth: true; height: 30; radius: Theme.radiusXs
                                        color: _vzMa.containsMouse ? Theme.accentDim : "transparent"
                                        border.color: Theme.accentDim; border.width: 1
                                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                        Text { anchors.centerIn: parent; text: parent.modelData.lbl; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.6 }
                                        MouseArea {
                                            id: _vzMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                            property string code: parent.modelData.code
                                            onClicked: Qt.openUrlExternally("tel:" + code)
                                        }
                                    }
                                }
                            }
                        }

                        // Bluetooth relay section
                        ColumnLayout {
                            visible: tab.screenTransport === "relay"
                            Layout.fillWidth: true; spacing: 6
                            Text {
                                text: "Carry the M507 relay puck (paired over Bluetooth). When you let your agent answer, the call is auto-answered and its audio is routed to the puck — no carrier forwarding needed."
                                color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 10
                                wrapMode: Text.WordWrap; Layout.fillWidth: true
                            }
                            Rectangle {
                                Layout.fillWidth: true; height: 28; radius: Theme.radiusXs
                                color: "transparent"; border.color: Theme.amber; border.width: 1
                                Text { anchors.centerIn: parent; text: "M507 Bluetooth relay — pair in system settings"; color: Theme.amber; font.family: Theme.fontSans; font.pixelSize: 10 }
                            }
                        }
                    }
                }

                // ── PSTN allowlist ────────────────────────────────────────────
                Text { text: "PSTN ALLOWLIST"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: Math.min(allowlistModel.count * 38 + 20, 160) + 2
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1; clip: true
                    ListView {
                        id: _alList; anchors.fill: parent; anchors.margins: 8
                        model: allowlistModel; spacing: 4; clip: true
                        delegate: RowLayout {
                            id: _alRow
                            required property string num
                            required property string lbl
                            width: _alList.width; height: 28; spacing: 8
                            Text { text: _alRow.num + (_alRow.lbl.length > 0 ? "  " + _alRow.lbl : ""); color: Theme.text; font.family: Theme.fontMono; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                            Rectangle {
                                width: 28; height: 22; radius: 4
                                color: _alRemMa.containsMouse ? Theme.dangerDim : "transparent"
                                border.color: Theme.danger; border.width: 1
                                Text { anchors.centerIn: parent; text: "✕"; color: Theme.danger; font.pixelSize: 10 }
                                MouseArea {
                                    id: _alRemMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                    property string _num: _alRow.num
                                    onClicked: tab.removeAllowNumber(_num)
                                }
                            }
                        }
                        Text { visible: allowlistModel.count === 0; anchors.centerIn: parent; text: "No numbers allowlisted"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 11 }
                    }
                }
                RowLayout {
                    Layout.fillWidth: true; spacing: 8
                    TextField {
                        id: _addNumField; Layout.fillWidth: true; placeholderText: "+1XXXXXXXXXX  (optional label)"
                        background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _addNumField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                    }
                    Rectangle {
                        height: 32; implicitWidth: _addNumLbl.implicitWidth + 20; radius: Theme.radiusXs
                        color: _addNumMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _addNumLbl; anchors.centerIn: parent; text: "ADD"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                        MouseArea {
                            id: _addNumMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                var parts = _addNumField.text.trim().split(/\s+/)
                                if (parts[0]) { tab.addAllowNumber(parts[0], parts[1] || ""); _addNumField.text = "" }
                            }
                        }
                    }
                }

                // ── Add new agent ─────────────────────────────────────────────
                Text { text: "ADD NEW AGENT"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: _enrollCol.implicitHeight + 24
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
                    ColumnLayout {
                        id: _enrollCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        Text { text: "Mint an extension + token and register an inbound agent."; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        TextField {
                            id: _enrollExt; Layout.fillWidth: true; placeholderText: "Extension (e.g. 106)"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _enrollExt.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                        }
                        TextField {
                            id: _enrollName; Layout.fillWidth: true; placeholderText: "Agent name"
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _enrollName.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                        }
                        TextField {
                            id: _enrollToken; Layout.fillWidth: true; placeholderText: "Token (leave blank to auto-generate)"
                            echoMode: TextInput.Password
                            background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _enrollToken.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                            color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                        }
                        Rectangle {
                            height: 32; implicitWidth: _enrollLbl.implicitWidth + 28; radius: Theme.radiusXs
                            color: _enrollMa.containsMouse ? Theme.accent : Theme.accentDim
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            Text { id: _enrollLbl; anchors.centerIn: parent; text: "REGISTER AGENT"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                            MouseArea {
                                id: _enrollMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: { if (_enrollExt.text.trim() && _enrollName.text.trim()) tab.registerAgent(_enrollExt.text.trim(), _enrollName.text.trim(), _enrollToken.text.trim()) }
                            }
                        }
                        Text { id: _enrollStatus; text: ""; visible: text.length > 0; color: Theme.success; font.family: Theme.fontMono; font.pixelSize: 10 }
                    }
                }

                // ── War Room ──────────────────────────────────────────────────
                Text { text: "WAR ROOM"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold }
                Rectangle {
                    Layout.fillWidth: true; height: _wrCol.implicitHeight + 24
                    color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.danger; border.width: 1
                    ColumnLayout {
                        id: _wrCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8
                        RowLayout {
                            spacing: 8
                            ArcReactor { size: 18; tint: Theme.danger; Layout.alignment: Qt.AlignVCenter }
                            Text { text: "RED ALERT broadcasts to every agent and opens a war-room thread."; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        }
                        RowLayout {
                            Layout.fillWidth: true; spacing: 8
                            TextField {
                                id: _alertMsgField; Layout.fillWidth: true; placeholderText: "Alert message…"
                                background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _alertMsgField.activeFocus ? Theme.danger : Theme.hairlineSoft; border.width: 1 }
                                color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 32
                            }
                            Rectangle {
                                height: 32; implicitWidth: _alertBtnLbl.implicitWidth + 20; radius: Theme.radiusXs
                                color: _alertBtnMa.containsMouse ? Theme.danger : Theme.dangerDim
                                Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                Text { id: _alertBtnLbl; anchors.centerIn: parent; text: "RED ALERT"; color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                                MouseArea { id: _alertBtnMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (_alertMsgField.text.trim()) tab.redAlert(_alertMsgField.text.trim()) } }
                            }
                        }
                        Text { id: _alertStatus; text: ""; visible: text.length > 0; color: Theme.amber; font.family: Theme.fontMono; font.pixelSize: 10 }
                    }
                }

                Item { height: 24 }
            }
        }
    }
}
