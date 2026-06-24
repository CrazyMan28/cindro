pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// MCP page: list of registered servers (name, endpoint, enable switch, connected
// dot, tools_count) with Test + Remove; an "Add MCP server" dialog. The built-in
// computer-use row is shown and cannot be removed. Wires mcp.list/add/remove/
// test/set_enabled.
Item {
    id: page

    ListModel { id: mcpModel }
    // CLI-side per-brain MCP servers (claude's ~/.claude.json, codex's config.toml).
    // Grouped under CODEX / CLAUDE subheaders; default OFF (brains run isolated).
    ListModel { id: cliMcpModel }
    // id -> { state: "idle"|"testing"|"ok"|"fail", tools: int, error: "" }
    property var testState: ({})

    function refresh() { bridge.listMcp(); bridge.mcpCliList() }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onMcpListed(servers) {
            mcpModel.clear()
            for (var i = 0; i < servers.length; i++) {
                var s = servers[i]
                var ts = page.testState[s.id]
                mcpModel.append({
                    "sid": s.id !== undefined ? s.id : "",
                    "name": s.name !== undefined ? s.name : "",
                    "transport": s.transport !== undefined ? s.transport : "http",
                    "endpoint": s.endpoint !== undefined ? s.endpoint : "",
                    "srvEnabled": s.enabled === true,
                    "builtin": s.builtin === true,
                    "risk": s.risk !== undefined ? s.risk : "",
                    "connected": (ts !== undefined && ts.state === "ok") ? true : false,
                    "tools": (ts !== undefined ? ts.tools : (s.tools_count !== undefined ? s.tools_count : 0)),
                    "teststate": ts !== undefined ? ts.state : "idle"
                })
            }
        }
        function onMcpTested(id, ok, toolsCount, error) {
            var t = page.testState
            t[id] = { "state": ok ? "ok" : "fail", "tools": toolsCount, "error": error }
            page.testState = t
            // reflect into the row in-place
            for (var i = 0; i < mcpModel.count; i++) {
                if (mcpModel.get(i).sid === id) {
                    mcpModel.set(i, Object.assign({}, mcpModel.get(i), {
                        "connected": ok, "tools": toolsCount, "teststate": ok ? "ok" : "fail"
                    }))
                    break
                }
            }
        }
        // CLI per-brain servers: codex first, then claude, each preceded by a
        // synthetic "header" row the delegate renders as a subheader.
        function onMcpCliListed(servers) {
            cliMcpModel.clear()
            var byBrain = { "codex": [], "claude": [] }
            for (var i = 0; i < servers.length; i++) {
                var s = servers[i]
                var b = s.brain !== undefined ? s.brain : ""
                if (byBrain[b] === undefined) byBrain[b] = []
                byBrain[b].push(s)
            }
            var order = ["codex", "claude"]
            // Include any unexpected brains after the known two, for safety.
            for (var bk in byBrain) if (order.indexOf(bk) < 0) order.push(bk)
            for (var oi = 0; oi < order.length; oi++) {
                var brain = order[oi]
                var rows = byBrain[brain]
                if (rows === undefined || rows.length === 0) continue
                cliMcpModel.append({
                    "isHeader": true, "brain": brain, "cname": "",
                    "transport": "", "endpoint": "", "cliEnabled": false
                })
                for (var r = 0; r < rows.length; r++) {
                    var cs = rows[r]
                    cliMcpModel.append({
                        "isHeader": false,
                        "brain": brain,
                        "cname": cs.name !== undefined ? cs.name : "",
                        "transport": cs.transport !== undefined ? cs.transport : "stdio",
                        "endpoint": cs.endpoint !== undefined ? cs.endpoint : "",
                        "cliEnabled": cs.enabled === true
                    })
                }
            }
        }
        // A toggle changed the registry — re-query the CLI list (and the Jarvis list,
        // since enabling imports a "cli:<brain>:<name>" server into it).
        function onMcpCliChanged() { bridge.mcpCliList(); bridge.listMcp() }
    }

    function riskColor(r) {
        if (r === "high") return Theme.danger
        if (r === "low") return Theme.ok
        return Theme.warn
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "MCP Servers"
                subtitle: "Tool servers the brain can call. computer-use is built in."
            }
            Widgets.PillButton {
                label: "+ Add"
                primary: true
                Layout.alignment: Qt.AlignTop
                onClicked: addDialog.openFresh()
            }
        }

        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 10
            model: mcpModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                width: 5
                background: Item {}
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: row
                required property int index
                required property string sid
                required property string name
                required property string transport
                required property string endpoint
                required property bool srvEnabled
                required property bool builtin
                required property string risk
                required property bool connected
                required property int tools
                required property string teststate

                width: ListView.view.width
                implicitHeight: content.implicitHeight + 26
                radius: Theme.radius
                color: row.builtin ? Theme.surfaceStrong : Theme.panelSoft
                border.color: row.builtin ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1

                // built-in node gets a glowing left seam
                Rectangle {
                    visible: row.builtin
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: Theme.accent
                }

                ColumnLayout {
                    id: content
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: 14
                    spacing: 10

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 12

                        // status ring node — pulses while testing, fills when connected
                        Item {
                            width: 18; height: 18
                            Layout.alignment: Qt.AlignVCenter
                            property color tone: row.connected ? Theme.success
                                   : (row.teststate === "fail" ? Theme.danger : Theme.textFaint)
                            Rectangle {
                                anchors.centerIn: parent
                                width: 16; height: 16; radius: 8
                                color: "transparent"
                                border.width: 1.4
                                border.color: parent.tone
                                opacity: 0.8
                                // connect pulse expanding ring
                                Rectangle {
                                    anchors.centerIn: parent
                                    width: parent.width; height: parent.height; radius: width/2
                                    color: "transparent"
                                    border.width: 1.2
                                    border.color: parent.parent.tone
                                    visible: row.teststate === "testing"
                                    SequentialAnimation on scale {
                                        running: row.teststate === "testing"
                                        loops: Animation.Infinite
                                        NumberAnimation { from: 0.6; to: 2.0; duration: 900; easing.type: Easing.OutCubic }
                                    }
                                    SequentialAnimation on opacity {
                                        running: row.teststate === "testing"
                                        loops: Animation.Infinite
                                        NumberAnimation { from: 0.8; to: 0.0; duration: 900; easing.type: Easing.OutCubic }
                                    }
                                }
                            }
                            Rectangle {
                                anchors.centerIn: parent
                                width: 7; height: 7; radius: 3.5
                                color: parent.tone
                                visible: row.connected || row.teststate === "fail"
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            RowLayout {
                                spacing: 8
                                Text {
                                    text: row.name
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 14
                                    font.weight: Font.Medium
                                }
                                Rectangle {
                                    visible: row.builtin
                                    radius: 5
                                    implicitWidth: biTxt.implicitWidth + 12
                                    implicitHeight: 16
                                    color: Theme.accentFaint
                                    Text {
                                        id: biTxt
                                        anchors.centerIn: parent
                                        text: "built-in"
                                        color: Theme.accent
                                        font.family: Theme.fontSans
                                        font.pixelSize: 9
                                        font.letterSpacing: 0.5
                                    }
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                text: row.endpoint
                                color: Theme.textMuted
                                font.family: Theme.fontMono
                                font.pixelSize: 11
                                elide: Text.ElideMiddle
                            }
                        }

                        Widgets.StyledSwitch {
                            checked: row.srvEnabled
                            Layout.alignment: Qt.AlignVCenter
                            onToggled: function(v) { bridge.setMcpEnabled(row.sid, v) }
                        }
                    }

                    // meta row: transport / risk / tools count
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8

                        MetaPill { label: row.transport; tone: Theme.textMuted }
                        MetaPill {
                            visible: row.risk.length > 0
                            label: "risk: " + row.risk
                            tone: page.riskColor(row.risk)
                        }
                        MetaPill {
                            visible: row.teststate === "ok"
                            label: row.tools + " tools"
                            tone: Theme.ok
                        }
                        Text {
                            visible: row.teststate === "fail"
                            text: "test failed"
                            color: Theme.danger
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                        }

                        Item { Layout.fillWidth: true }

                        Widgets.PillButton {
                            label: row.teststate === "testing" ? "Testing…" : "Test"
                            enabledBtn: row.teststate !== "testing"
                            onClicked: {
                                var t = page.testState
                                t[row.sid] = { "state": "testing", "tools": 0, "error": "" }
                                page.testState = t
                                mcpModel.set(row.index, Object.assign({}, mcpModel.get(row.index), { "teststate": "testing" }))
                                bridge.testMcp(row.sid)
                            }
                        }
                        Widgets.PillButton {
                            visible: !row.builtin
                            label: "Remove"
                            danger: true
                            onClicked: bridge.removeMcp(row.sid)
                        }
                    }
                }
            }
        }

        // ===== CLI servers (per brain) ======================================
        // The codex/claude CLI's OWN MCP servers. Off = isolated (default).
        ColumnLayout {
            Layout.fillWidth: true
            visible: cliMcpModel.count > 0
            spacing: 6

            Text {
                text: "CLI servers (per brain)"
                color: Theme.text
                font.family: Theme.fontDisplay
                font.pixelSize: 14
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackMid
            }
            Text {
                Layout.fillWidth: true
                text: "These are your codex/claude CLI's own MCP servers. Off = isolated (default). Toggle on to let Jarvis use one."
                color: Theme.textMuted
                font.family: Theme.fontSans
                font.pixelSize: 11
                wrapMode: Text.WordWrap
            }

            ListView {
                id: cliList
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(contentHeight, 340)
                clip: true
                interactive: contentHeight > height
                spacing: 6
                model: cliMcpModel
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    width: 5
                    background: Item {}
                    contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
                }

                delegate: Item {
                    id: cliRow
                    required property int index
                    required property bool isHeader
                    required property string brain
                    required property string cname
                    required property string transport
                    required property string endpoint
                    required property bool cliEnabled

                    width: ListView.view.width
                    implicitHeight: cliRow.isHeader ? hdr.implicitHeight + 8
                                                    : cliContent.implicitHeight + 22

                    // brain subheader (CODEX / CLAUDE)
                    Text {
                        id: hdr
                        visible: cliRow.isHeader
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.topMargin: 4
                        text: cliRow.brain.toUpperCase()
                        color: Theme.accentBright
                        font.family: Theme.fontMono
                        font.pixelSize: 11
                        font.letterSpacing: Theme.trackMid
                    }

                    // server row
                    Rectangle {
                        visible: !cliRow.isHeader
                        anchors.fill: parent
                        radius: Theme.radius
                        color: Theme.panelSoft
                        border.color: Theme.hairlineSoft
                        border.width: 1

                        RowLayout {
                            id: cliContent
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: 12
                            spacing: 10

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                Text {
                                    text: cliRow.cname
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 13
                                    font.weight: Font.Medium
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: cliRow.transport + (cliRow.endpoint.length ? " · " + cliRow.endpoint : "")
                                    color: Theme.textMuted
                                    font.family: Theme.fontMono
                                    font.pixelSize: 10
                                    elide: Text.ElideMiddle
                                }
                            }

                            Widgets.StyledSwitch {
                                checked: cliRow.cliEnabled
                                Layout.alignment: Qt.AlignVCenter
                                onToggled: function(v) {
                                    bridge.mcpCliSetEnabled(cliRow.brain, cliRow.cname, v)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    component MetaPill: Rectangle {
        property string label: ""
        property color tone: Theme.textMuted
        visible: true
        radius: 6
        implicitWidth: pillT.implicitWidth + 14
        implicitHeight: 19
        color: "transparent"
        border.width: 1
        border.color: Qt.rgba(tone.r, tone.g, tone.b, 0.45)
        Text {
            id: pillT
            anchors.centerIn: parent
            text: parent.label
            color: parent.tone
            font.family: Theme.fontMono
            font.pixelSize: 11
        }
    }

    // ===== Add MCP server dialog ============================================
    Popup {
        id: addDialog
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 40, 420)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        property string transport: "http"
        property string parseError: ""    // inline message from the JSON importer (empty = ok)
        property bool parseOk: false       // true briefly after a successful import

        function openFresh() {
            nameField.text = ""
            endpointField.text = ""
            tokenField.text = ""
            pasteField.text = ""
            addDialog.transport = "http"
            addDialog.parseError = ""
            addDialog.parseOk = false
            open()
        }

        // Parse a pasted MCP config and fill the dialog's name/transport/endpoint/
        // token fields for review. Accepts:
        //   {"mcpServers": {"<name>": {"url":..,"headers":{"Authorization":"Bearer .."}}}}
        //   {"mcpServers": {"<name>": {"command":"npx","args":[..]}}}
        //   bare single-server: {"url":..,"headers":{..}} / {"command":..,"args":[..]}
        function parseConfig() {
            addDialog.parseError = ""
            addDialog.parseOk = false
            var raw = pasteField.text.trim()
            if (raw.length === 0) { addDialog.parseError = "Paste a config first."; return }

            var obj
            try {
                obj = JSON.parse(raw)
            } catch (e) {
                addDialog.parseError = "Invalid JSON: " + e
                return
            }
            if (!obj || typeof obj !== "object") {
                addDialog.parseError = "Expected a JSON object."
                return
            }

            // Resolve {name, server} from the accepted shapes.
            var name = ""
            var server = null
            if (obj.mcpServers && typeof obj.mcpServers === "object") {
                var keys = Object.keys(obj.mcpServers)
                if (keys.length === 0) {
                    addDialog.parseError = "mcpServers is empty."
                    return
                }
                name = keys[0]
                server = obj.mcpServers[name]
            } else {
                // bare single-server object
                server = obj
                name = (typeof obj.name === "string" && obj.name.length) ? obj.name : ""
            }
            if (!server || typeof server !== "object") {
                addDialog.parseError = "No server definition found."
                return
            }
            if (typeof server.name === "string" && server.name.length)
                name = server.name
            if (name.length === 0) name = "Unnamed"

            // Strip a leading "Bearer " (any case) from an Authorization header value.
            function stripBearer(v) {
                if (typeof v !== "string") return ""
                return v.replace(/^\s*Bearer\s+/i, "").trim()
            }

            if (typeof server.url === "string" && server.url.length) {
                addDialog.transport = "http"
                endpointField.text = server.url.trim()
                var tok = ""
                if (server.headers && typeof server.headers === "object") {
                    // case-insensitive Authorization lookup
                    for (var hk in server.headers) {
                        if (hk.toLowerCase() === "authorization") {
                            tok = stripBearer(server.headers[hk]); break
                        }
                    }
                }
                if (tok.length === 0 && typeof server.token === "string") tok = server.token.trim()
                if (tok.length === 0 && typeof server.bearer === "string") tok = stripBearer(server.bearer)
                tokenField.text = tok
            } else if (typeof server.command === "string" && server.command.length) {
                addDialog.transport = "stdio"
                var args = Array.isArray(server.args) ? server.args : []
                var parts = [server.command.trim()]
                for (var i = 0; i < args.length; i++) parts.push("" + args[i])
                endpointField.text = parts.join(" ").trim()
                tokenField.text = ""
            } else {
                addDialog.parseError = "Config has neither \"url\" nor \"command\"."
                return
            }

            nameField.text = name
            addDialog.parseOk = true
        }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.accentDim
            border.width: 1
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.topMargin: 1
                height: 2; radius: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Theme.magenta }
                    GradientStop { position: 0.5; color: Theme.accent }
                    GradientStop { position: 1.0; color: Theme.violet }
                }
                opacity: 0.8
            }
        }

        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

        contentItem: ColumnLayout {
            spacing: 14
            ColumnLayout {
                Layout.fillWidth: true
                Layout.margins: 20
                spacing: 14

                Text {
                    text: "ADD MCP NODE"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay
                    font.pixelSize: 15
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackMid
                }

                // ---- Paste JSON config (optional importer) -------------------
                // Drop a standard MCP config here and hit Import to fill the fields
                // below for review, then Add as usual.
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    RowLayout {
                        Layout.fillWidth: true
                        Text { text: "Paste config (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12; Layout.fillWidth: true }
                        Text {
                            text: addDialog.parseOk ? "imported ✓" : ""
                            visible: addDialog.parseOk
                            color: Theme.ok
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: 92
                        radius: Theme.radiusSm
                        color: Theme.surfaceInput
                        border.width: 1
                        border.color: pasteField.activeFocus ? Theme.accent
                                      : (addDialog.parseError.length ? Theme.danger : Theme.hairlineSoft)
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        ScrollView {
                            anchors.fill: parent
                            anchors.margins: 8
                            clip: true
                            TextArea {
                                id: pasteField
                                placeholderText: "{ \"mcpServers\": { \"my-server\": { \"url\": \"https://…\", \"headers\": { \"Authorization\": \"Bearer …\" } } } }"
                                placeholderTextColor: Theme.textFaint
                                color: Theme.text
                                font.family: Theme.fontMono
                                font.pixelSize: 11
                                wrapMode: TextArea.Wrap
                                selectByMouse: true
                                selectionColor: Theme.accentDim
                                background: null
                                onTextChanged: { addDialog.parseError = ""; addDialog.parseOk = false }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            Layout.fillWidth: true
                            visible: addDialog.parseError.length > 0
                            text: addDialog.parseError
                            color: Theme.danger
                            font.family: Theme.fontSans
                            font.pixelSize: 11
                            wrapMode: Text.WordWrap
                        }
                        Item { Layout.fillWidth: true; visible: addDialog.parseError.length === 0 }
                        Widgets.PillButton {
                            label: "Import"
                            enabledBtn: pasteField.text.trim().length > 0
                            onClicked: addDialog.parseConfig()
                        }
                    }

                    // subtle divider before the manual fields
                    Rectangle {
                        Layout.fillWidth: true
                        Layout.topMargin: 4
                        height: 1
                        color: Theme.hairlineSoft
                        opacity: 0.6
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    Text { text: "Name"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: nameField; Layout.fillWidth: true; placeholder: "My tool server" }
                }

                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    Text { text: "Transport"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    RowLayout {
                        spacing: 8
                        TransportToggle { label: "http"; active: addDialog.transport === "http"; onPicked: addDialog.transport = "http" }
                        TransportToggle { label: "stdio"; active: addDialog.transport === "stdio"; onPicked: addDialog.transport = "stdio" }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    Text {
                        text: addDialog.transport === "http" ? "Endpoint (URL)" : "Command"
                        color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12
                    }
                    Widgets.StyledField {
                        id: endpointField
                        Layout.fillWidth: true
                        placeholder: addDialog.transport === "http"
                                     ? "http://host:port/mcp" : "npx -y some-mcp-server"
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true; spacing: 5
                    visible: addDialog.transport === "http"
                    Text { text: "Bearer token (optional)"; color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 12 }
                    Widgets.StyledField { id: tokenField; Layout.fillWidth: true; masked: true; placeholder: "token…" }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 4
                    spacing: 10
                    Item { Layout.fillWidth: true }
                    Widgets.PillButton { label: "Cancel"; onClicked: addDialog.close() }
                    Widgets.PillButton {
                        label: "Add server"
                        primary: true
                        enabledBtn: endpointField.text.trim().length > 0
                        onClicked: {
                            bridge.addMcp({
                                "name": nameField.text.trim().length ? nameField.text.trim() : "Unnamed",
                                "transport": addDialog.transport,
                                "endpoint": endpointField.text.trim(),
                                "token": tokenField.text,
                                "enabled": true
                            })
                            addDialog.close()
                        }
                    }
                }
            }
        }

        component TransportToggle: Rectangle {
            property string label: ""
            property bool active: false
            signal picked()
            implicitWidth: ttTxt.implicitWidth + 28
            implicitHeight: 32
            radius: Theme.radiusSm
            color: active ? Theme.accentDim : Theme.surface
            border.width: 1
            border.color: active ? Theme.accent : Theme.hairline
            Behavior on color { ColorAnimation { duration: 110 } }
            Text {
                id: ttTxt
                anchors.centerIn: parent
                text: parent.label
                color: parent.active ? Theme.accent : Theme.textMuted
                font.family: Theme.fontMono
                font.pixelSize: 12
            }
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: parent.picked() }
        }
    }
}
