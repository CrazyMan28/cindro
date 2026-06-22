import QtQuick
import QtQuick.Window
import QtQuick.Controls.Basic
import QtQuick.Layouts

Window {
    id: root
    width: 460
    height: 1080
    // Stay hidden until C++ has installed the wlr-layer-shell role on the
    // QWindow (see desktop/src/main.cpp). main.cpp calls show() once the surface
    // is configured as a layer surface; mapping it earlier yields a floating
    // xdg-toplevel instead of an anchored sidebar.
    visible: false
    color: "transparent"
    title: "JARVIS"

    // ---- Theme (cyberpunk neon-on-dark) ----------------------------------
    readonly property color bgDeep:   "#070912"
    readonly property color bgPanel:  "#0c1020"
    readonly property color bgRaised: "#121831"
    readonly property color neon:     "#22e0ff"
    readonly property color neon2:    "#b14bff"
    readonly property color accent:   "#ff2d95"
    readonly property color ok:       "#2dffb0"
    readonly property color danger:   "#ff4d4d"
    readonly property color textMain: "#e8f4ff"
    readonly property color textDim:  "#6f7ea6"
    readonly property color line:     "#1d2745"

    // chat model fed from bridge.sessionEvent
    ListModel { id: chatModel }

    property bool thinking: false
    property var modelOptions: ["gpt-5-codex", "gpt-5", "o4-mini", "claude-sonnet-4.5", "claude-opus-4.5"]
    property string selectedModel: modelOptions.length > 0 ? modelOptions[0] : ""

    // ---- Bridge wiring ----------------------------------------------------
    Connections {
        target: bridge

        function onModelsListed(brain, models) {
            if (models && models.length > 0) {
                root.modelOptions = models
                root.selectedModel = models[0]
            }
        }

        function onErrorOccurred(message) {
            chatModel.append({
                "kind": "error", "role": "system", "text": message,
                "callId": "", "toolName": "", "approvalId": "", "risk": ""
            })
            chatView.positionViewAtEnd()
        }

        function onSessionEvent(ev) {
            var kind = ev.kind !== undefined ? ev.kind : ""
            switch (kind) {
            case "thinking":
                root.thinking = true
                break
            case "message":
                root.thinking = false
                chatModel.append({
                    "kind": "message",
                    "role": ev.role !== undefined ? ev.role : "assistant",
                    "text": ev.text !== undefined ? ev.text : "",
                    "callId": "", "toolName": "", "approvalId": "", "risk": ""
                })
                break
            case "tool_call":
                root.thinking = false
                chatModel.append({
                    "kind": "tool_call", "role": "tool",
                    "text": ev.args !== undefined ? JSON.stringify(ev.args) : "",
                    "callId": ev.call_id !== undefined ? ev.call_id : "",
                    "toolName": ev.name !== undefined ? ev.name : "tool",
                    "approvalId": "", "risk": ""
                })
                break
            case "tool_result":
                chatModel.append({
                    "kind": "tool_result", "role": "tool",
                    "text": ev.output !== undefined ? ("" + ev.output) : "",
                    "callId": ev.call_id !== undefined ? ev.call_id : "",
                    "toolName": (ev.ok === false ? "error" : "ok"),
                    "approvalId": "", "risk": ""
                })
                break
            case "approval":
                root.thinking = false
                chatModel.append({
                    "kind": "approval", "role": "system",
                    "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                    "callId": "", "toolName": "",
                    "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                    "risk": ev.risk !== undefined ? ("" + ev.risk) : ""
                })
                break
            case "diff":
                chatModel.append({
                    "kind": "diff", "role": "tool",
                    "text": ev.patch !== undefined ? ev.patch : "",
                    "callId": "", "toolName": ev.path !== undefined ? ev.path : "diff",
                    "approvalId": "", "risk": ""
                })
                break
            case "error":
                root.thinking = false
                chatModel.append({
                    "kind": "error", "role": "system",
                    "text": ev.message !== undefined ? ev.message : "error",
                    "callId": "", "toolName": "", "approvalId": "", "risk": ""
                })
                break
            case "final":
                root.thinking = false
                break
            default:
                break
            }
            chatView.positionViewAtEnd()
        }
    }

    // ---- Root frame (rounded, neon edge) ----------------------------------
    Rectangle {
        id: frame
        anchors.fill: parent
        radius: 18
        color: root.bgDeep
        border.color: root.line
        border.width: 1

        // subtle vertical neon gradient wash
        Rectangle {
            anchors.fill: parent
            radius: parent.radius
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#0a0e1c" }
                GradientStop { position: 1.0; color: "#05060d" }
            }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 14
            spacing: 12

            // ===== Header =====================================================
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                Rectangle {
                    width: 10; height: 10; radius: 5
                    color: bridge.connected ? root.ok : root.textDim
                    Layout.alignment: Qt.AlignVCenter
                    SequentialAnimation on opacity {
                        running: bridge.connected
                        loops: Animation.Infinite
                        NumberAnimation { from: 1.0; to: 0.35; duration: 900 }
                        NumberAnimation { from: 0.35; to: 1.0; duration: 900 }
                    }
                }

                Text {
                    text: "JARVIS"
                    font.family: "monospace"
                    font.pixelSize: 22
                    font.bold: true
                    font.letterSpacing: 4
                    color: root.neon
                    Layout.alignment: Qt.AlignVCenter
                }

                Item { Layout.fillWidth: true }

                ComboBox {
                    id: modelPicker
                    Layout.preferredWidth: 180
                    model: root.modelOptions
                    onActivated: root.selectedModel = currentText

                    background: Rectangle {
                        radius: 10
                        color: root.bgRaised
                        border.color: root.neon2
                        border.width: 1
                    }
                    contentItem: Text {
                        leftPadding: 10
                        text: modelPicker.displayText
                        color: root.textMain
                        font.pixelSize: 12
                        font.family: "monospace"
                        verticalAlignment: Text.AlignVCenter
                        elide: Text.ElideRight
                    }
                    indicator: Text {
                        x: modelPicker.width - width - 10
                        y: (modelPicker.height - height) / 2
                        text: "▾"
                        color: root.neon2
                    }
                    popup: Popup {
                        y: modelPicker.height + 4
                        width: modelPicker.width
                        implicitHeight: Math.min(contentItem.implicitHeight + 8, 280)
                        padding: 4
                        background: Rectangle {
                            radius: 10
                            color: root.bgPanel
                            border.color: root.neon2
                            border.width: 1
                        }
                        contentItem: ListView {
                            clip: true
                            implicitHeight: contentHeight
                            model: modelPicker.popup.visible ? modelPicker.delegateModel : null
                            ScrollIndicator.vertical: ScrollIndicator {}
                        }
                    }
                    delegate: ItemDelegate {
                        required property var modelData
                        required property int index
                        width: modelPicker.width - 8
                        contentItem: Text {
                            text: modelData
                            color: root.textMain
                            font.pixelSize: 12
                            font.family: "monospace"
                        }
                        highlighted: modelPicker.highlightedIndex === index
                        background: Rectangle {
                            radius: 6
                            color: highlighted ? root.bgRaised : "transparent"
                        }
                    }
                }
            }

            Rectangle { Layout.fillWidth: true; height: 1; color: root.line }

            // ===== Chat list ==================================================
            ListView {
                id: chatView
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: 10
                model: chatModel
                cacheBuffer: 600

                ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                // empty-state hint
                Item {
                    anchors.fill: parent
                    visible: chatModel.count === 0
                    ColumnLayout {
                        anchors.centerIn: parent
                        width: parent.width - 60
                        spacing: 10
                        Text {
                            Layout.alignment: Qt.AlignHCenter
                            text: "◈"
                            color: root.neon2
                            font.pixelSize: 40
                            opacity: 0.6
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            text: bridge.connected
                                  ? "No session yet.\nPick a model and send a message to begin."
                                  : "Connecting to jarvisd…\nStatus: " + bridge.status
                            color: root.textDim
                            font.pixelSize: 13
                            font.family: "monospace"
                            lineHeight: 1.3
                        }
                    }
                }

                delegate: ChatDelegate {
                    width: chatView.width
                    neon: root.neon
                    neon2: root.neon2
                    accent: root.accent
                    okColor: root.ok
                    danger: root.danger
                    textMain: root.textMain
                    textDim: root.textDim
                    bgRaised: root.bgRaised
                    bgPanel: root.bgPanel
                    line: root.line
                    onAllow: function(approvalId) { bridge.respondApproval(approvalId, "allow") }
                    onDeny:  function(approvalId) { bridge.respondApproval(approvalId, "deny") }
                    onAlways: function(approvalId) { bridge.respondApproval(approvalId, "always") }
                }

                // thinking shimmer row pinned at the bottom (footer)
                footer: Item {
                    width: chatView.width
                    height: root.thinking ? 38 : 0
                    visible: root.thinking
                    RowLayout {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 8
                        Repeater {
                            model: 3
                            Rectangle {
                                required property int index
                                width: 8; height: 8; radius: 4
                                color: root.neon
                                SequentialAnimation on opacity {
                                    running: root.thinking
                                    loops: Animation.Infinite
                                    PauseAnimation { duration: index * 160 }
                                    NumberAnimation { from: 1.0; to: 0.2; duration: 400 }
                                    NumberAnimation { from: 0.2; to: 1.0; duration: 400 }
                                    PauseAnimation { duration: (2 - index) * 160 }
                                }
                            }
                        }
                        Text {
                            text: "thinking"
                            color: root.textDim
                            font.italic: true
                            font.pixelSize: 12
                            font.family: "monospace"
                        }
                    }
                }
            }

            Rectangle { Layout.fillWidth: true; height: 1; color: root.line }

            // ===== Composer ===================================================
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(Math.max(54, inputArea.implicitHeight + 18), 160)
                radius: 12
                color: root.bgPanel
                border.color: inputArea.activeFocus ? root.neon : root.line
                border.width: 1

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 8

                    ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        TextArea {
                            id: inputArea
                            placeholderText: bridge.sessionId.length > 0
                                             ? "Message Jarvis…"
                                             : "Type to start a session…"
                            placeholderTextColor: root.textDim
                            color: root.textMain
                            font.pixelSize: 13
                            font.family: "monospace"
                            wrapMode: TextArea.Wrap
                            selectByMouse: true
                            background: null

                            Keys.onReturnPressed: function(event) {
                                if (event.modifiers & Qt.ShiftModifier) {
                                    event.accepted = false  // newline
                                } else {
                                    event.accepted = true
                                    root.submit()
                                }
                            }
                        }
                    }

                    Button {
                        id: sendButton
                        text: "SEND"
                        Layout.alignment: Qt.AlignBottom
                        Layout.preferredHeight: 36
                        enabled: bridge.connected && inputArea.text.trim().length > 0
                        onClicked: root.submit()

                        contentItem: Text {
                            text: sendButton.text
                            font.pixelSize: 12
                            font.bold: true
                            font.letterSpacing: 2
                            font.family: "monospace"
                            color: sendButton.enabled ? root.bgDeep : root.textDim
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                        }
                        background: Rectangle {
                            radius: 10
                            implicitWidth: 72
                            color: sendButton.enabled
                                   ? (sendButton.down ? root.neon2 : root.neon)
                                   : root.bgRaised
                            border.color: sendButton.enabled ? root.neon : root.line
                            border.width: 1
                        }
                    }
                }
            }
        }
    }

    // ---- Actions ----------------------------------------------------------
    function submit() {
        var t = inputArea.text.trim()
        if (t.length === 0 || !bridge.connected)
            return

        // First message creates a session (default coder/codex with picked model).
        if (bridge.sessionId.length === 0)
            bridge.createSession("coder", "codex", root.selectedModel)

        chatModel.append({
            "kind": "message", "role": "user", "text": t,
            "callId": "", "toolName": "", "approvalId": "", "risk": ""
        })
        bridge.sendMessage(t)
        inputArea.text = ""
        chatView.positionViewAtEnd()
    }
}
