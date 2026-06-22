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
    // id -> { state: "idle"|"testing"|"ok"|"fail", tools: int, error: "" }
    property var testState: ({})

    function refresh() { bridge.listMcp() }
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

        function openFresh() {
            nameField.text = ""
            endpointField.text = ""
            tokenField.text = ""
            addDialog.transport = "http"
            open()
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
