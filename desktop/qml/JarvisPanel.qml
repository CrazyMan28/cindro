import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// The full Jarvis content panel: model picker + chat transcript + composer.
// Instantiated ONCE in Main.qml and reparented between the floating window and
// the docked layer-shell surface, so chat state is preserved across mode toggles.
// All Bridge (Contract A) calls and Contract B event rendering live here.
Item {
    id: panel

    // chat transcript model fed from bridge.sessionEvent
    ListModel { id: chatModel }

    property bool thinking: false
    // Default model is gpt-5.5 (gpt-5-codex is rejected HTTP 400 by this codex login).
    property var modelOptions: ["gpt-5.5", "gpt-5", "o4-mini", "claude-sonnet-4.5", "claude-opus-4.5"]
    property string selectedModel: modelOptions.length > 0 ? modelOptions[0] : ""

    // Design preview: set JARVIS_DEMO=1 to seed sample transcript content so the
    // bubbles / chips / diff / approval styling can be reviewed without a daemon.
    // No effect in normal runs.
    Component.onCompleted: {
        if (Qt.application.arguments.indexOf("--demo") !== -1)
            seedDemo()
    }
    function seedDemo() {
        chatModel.append({ "kind":"message","role":"user","text":"Refactor the auth module and add tests.","callId":"","toolName":"","approvalId":"","risk":"","ok":true })
        chatModel.append({ "kind":"message","role":"assistant","text":"On it. I'll inspect the current auth flow, extract the token logic into a service, then add coverage. Starting with a quick scan.","callId":"","toolName":"","approvalId":"","risk":"","ok":true })
        chatModel.append({ "kind":"tool_call","role":"tool","text":"{\"cmd\":\"rg -n 'token' src/auth\"}","callId":"c1","toolName":"shell","approvalId":"","risk":"","ok":true })
        chatModel.append({ "kind":"tool_result","role":"tool","text":"src/auth/login.ts:42  const token = sign(user)\nsrc/auth/mw.ts:11   verify(token)","callId":"c1","toolName":"","approvalId":"","risk":"","ok":true })
        chatModel.append({ "kind":"diff","role":"tool","text":"--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n+export function sign(user) {\n+  return jwt(user, KEY)\n-  // old inline impl\n }","callId":"","toolName":"src/auth/token.ts","approvalId":"","risk":"","ok":true })
        chatModel.append({ "kind":"approval","role":"system","text":"Run the test suite with network access enabled?","callId":"","toolName":"","approvalId":"a1","risk":"medium","ok":true })
    }

    // Append a normalized brain event (Contract B) to the transcript. Shared by
    // live session events and replayed history.
    function appendEvent(ev) {
        var kind = ev.kind !== undefined ? ev.kind : ""
        switch (kind) {
        case "thinking":
            panel.thinking = true
            break
        case "message":
            panel.thinking = false
            chatModel.append({
                "kind": "message",
                "role": ev.role !== undefined ? ev.role : "assistant",
                "text": ev.text !== undefined ? ev.text : "",
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true
            })
            break
        case "tool_call":
            panel.thinking = false
            chatModel.append({
                "kind": "tool_call", "role": "tool",
                "text": ev.args !== undefined ? JSON.stringify(ev.args) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": ev.name !== undefined ? ev.name : "tool",
                "approvalId": "", "risk": "", "ok": true
            })
            break
        case "tool_result":
            chatModel.append({
                "kind": "tool_result", "role": "tool",
                "text": ev.output !== undefined ? ("" + ev.output) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": "", "approvalId": "", "risk": "",
                "ok": ev.ok !== false
            })
            break
        case "approval":
            panel.thinking = false
            chatModel.append({
                "kind": "approval", "role": "system",
                "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                "callId": "", "toolName": "",
                "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                "risk": ev.risk !== undefined ? ("" + ev.risk) : "", "ok": true
            })
            break
        case "diff":
            chatModel.append({
                "kind": "diff", "role": "tool",
                "text": ev.patch !== undefined ? ev.patch : "",
                "callId": "", "toolName": ev.path !== undefined ? ev.path : "diff",
                "approvalId": "", "risk": "", "ok": true
            })
            break
        case "error":
            panel.thinking = false
            chatModel.append({
                "kind": "error", "role": "system",
                "text": ev.message !== undefined ? ev.message : "error",
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true
            })
            break
        case "final":
            panel.thinking = false
            break
        default:
            break
        }
    }

    // ---- Bridge wiring (Contract A client + Contract B rendering) ----------
    Connections {
        target: bridge

        function onModelsListed(brain, models) {
            if (models && models.length > 0) {
                panel.modelOptions = models
                panel.selectedModel = models[0]
            }
        }

        // Opening a stored session from the Sessions page: clear + replay.
        function onSessionOpened(sessionId) {
            chatModel.clear()
            panel.thinking = false
        }
        function onSessionHistory(sessionId, events) {
            chatModel.clear()
            for (var i = 0; i < events.length; i++)
                panel.appendEvent(events[i])
            chatView.positionViewAtEnd()
        }

        function onErrorOccurred(message) {
            chatModel.append({
                "kind": "error", "role": "system", "text": message,
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true
            })
            chatView.positionViewAtEnd()
        }

        function onSessionEvent(ev) {
            panel.appendEvent(ev)
            chatView.positionViewAtEnd()
            // optional TTS read-back of the assistant's final message
            if (panel.ttsReadback && ev.kind === "message"
                && (ev.role === undefined || ev.role === "assistant")
                && ev.text !== undefined && ("" + ev.text).trim().length > 0)
                bridge.voiceSpeak(ev.text)
        }

        // voice dictation: drop the transcript into the input (don't auto-send).
        function onVoiceTranscribed(text) {
            if (text && text.length > 0) {
                if (inputArea.text.trim().length > 0)
                    inputArea.text = inputArea.text + " " + text
                else
                    inputArea.text = text
                inputArea.cursorPosition = inputArea.text.length
                inputArea.forceActiveFocus()
            }
        }
    }

    // TTS read-back toggle (Mistral voice.tts on assistant finals).
    property bool ttsReadback: false

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 16
        anchors.rightMargin: 16
        anchors.topMargin: 6
        anchors.bottomMargin: 16
        spacing: 12

        // ===== Sub-header: status line + model picker ========================
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            // status pill
            Rectangle {
                Layout.alignment: Qt.AlignVCenter
                radius: Theme.radiusXs
                implicitWidth: statusRow.implicitWidth + 18
                implicitHeight: 26
                color: Theme.surfaceDeep
                border.width: 1
                border.color: bridge.connected ? Theme.accentDim : Theme.hairlineSoft
                Row {
                    id: statusRow
                    anchors.centerIn: parent
                    spacing: 7
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6; height: 6; radius: 3
                        color: bridge.connected ? Theme.success : Theme.amber
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: bridge.connected
                              ? (bridge.sessionId.length > 0 ? "SESSION ACTIVE" : "ONLINE // READY")
                              : "CONNECTING…"
                        color: bridge.connected ? Theme.textMuted : Theme.textFaint
                        font.family: Theme.fontDisplay
                        font.pixelSize: 9
                        font.letterSpacing: Theme.trackMid
                    }
                }
            }

            Item { Layout.fillWidth: true }

            // TTS read-back toggle (speaker icon)
            Item {
                Layout.alignment: Qt.AlignVCenter
                width: 30; height: 26
                Rectangle {
                    anchors.fill: parent
                    radius: Theme.radiusXs
                    color: panel.ttsReadback ? Theme.accentFaint : "transparent"
                    border.width: 1
                    border.color: panel.ttsReadback ? Theme.accentDim
                                  : (ttsMa.containsMouse ? Theme.hairlineSoft : "transparent")
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                }
                Canvas {
                    anchors.centerIn: parent
                    width: 16; height: 16
                    property color ink: panel.ttsReadback ? Theme.accent : Theme.textMuted
                    onInkChanged: requestPaint()
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.strokeStyle = ink; ctx.fillStyle = ink
                        ctx.lineWidth = 1.3; ctx.lineCap = "round"; ctx.lineJoin = "round"
                        // speaker body
                        ctx.beginPath()
                        ctx.moveTo(3, 6); ctx.lineTo(6, 6); ctx.lineTo(9, 3)
                        ctx.lineTo(9, 13); ctx.lineTo(6, 10); ctx.lineTo(3, 10); ctx.closePath()
                        ctx.fill()
                        // waves only when on
                        if (panel.ttsReadback) {
                            ctx.beginPath(); ctx.arc(9, 8, 3.4, -0.9, 0.9); ctx.stroke()
                            ctx.beginPath(); ctx.arc(9, 8, 5.6, -0.8, 0.8); ctx.stroke()
                        }
                    }
                }
                MouseArea {
                    id: ttsMa
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: panel.ttsReadback = !panel.ttsReadback
                }
            }

            Text {
                text: "MODEL"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }

            // model picker — fully restyled ComboBox (no default Qt look)
            ComboBox {
                id: modelPicker
                Layout.preferredWidth: 188
                Layout.preferredHeight: 32
                model: panel.modelOptions
                onActivated: panel.selectedModel = currentText

                background: Rectangle {
                    radius: Theme.radiusSm
                    color: modelPicker.pressed ? Theme.surfaceStrong : Theme.surfaceInput
                    border.color: modelPicker.activeFocus || modelPicker.hovered
                                  ? Theme.accent : Theme.hairlineSoft
                    border.width: 1
                    Behavior on border.color { ColorAnimation { duration: 120 } }
                }
                contentItem: Text {
                    leftPadding: 12
                    rightPadding: 28
                    text: modelPicker.displayText
                    color: Theme.text
                    font.pixelSize: 12
                    font.family: Theme.fontSans
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
                indicator: Canvas {
                    x: modelPicker.width - 20
                    y: (modelPicker.height - 6) / 2
                    width: 10; height: 6
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.reset()
                        ctx.strokeStyle = Theme.accent
                        ctx.lineWidth = 1.4
                        ctx.lineCap = "round"; ctx.lineJoin = "round"
                        ctx.beginPath(); ctx.moveTo(1,1); ctx.lineTo(5,5); ctx.lineTo(9,1); ctx.stroke()
                    }
                }
                popup: Popup {
                    y: modelPicker.height + 6
                    width: modelPicker.width
                    implicitHeight: Math.min(contentItem.implicitHeight + 10, 300)
                    padding: 5
                    background: Rectangle {
                        radius: Theme.radiusSm
                        color: Qt.rgba(0.039, 0.071, 0.110, 0.97)
                        border.color: Theme.accentDim
                        border.width: 1
                    }
                    contentItem: ListView {
                        clip: true
                        implicitHeight: contentHeight
                        model: modelPicker.popup.visible ? modelPicker.delegateModel : null
                        spacing: 2
                        ScrollIndicator.vertical: ScrollIndicator {}
                    }
                }
                delegate: ItemDelegate {
                    required property var modelData
                    required property int index
                    width: modelPicker.width - 10
                    height: 30
                    contentItem: Text {
                        text: modelData
                        color: highlighted ? Theme.accentBright : Theme.text
                        font.pixelSize: 12
                        font.family: Theme.fontSans
                        verticalAlignment: Text.AlignVCenter
                        leftPadding: 6
                    }
                    highlighted: modelPicker.highlightedIndex === index
                    background: Rectangle {
                        radius: Theme.radiusXs
                        color: highlighted ? Theme.accentFaint : "transparent"
                    }
                }
            }
        }

        // ===== Chat transcript (HUD framed) ==================================
        HudFrame {
            Layout.fillWidth: true
            Layout.fillHeight: true
            fill: Theme.panel
            active: bridge.connected
            sweep: panel.thinking

            ListView {
                id: chatView
                anchors.fill: parent
                anchors.margins: 14
                clip: true
                spacing: 12
                model: chatModel
                cacheBuffer: 800
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

                // empty-state hint — the large arc reactor centerpiece
                Item {
                    anchors.fill: parent
                    visible: chatModel.count === 0
                    ColumnLayout {
                        anchors.centerIn: parent
                        width: parent.width - 50
                        spacing: 20

                        ArcReactor {
                            Layout.alignment: Qt.AlignHCenter
                            size: 132
                            tint: Theme.accent
                            thinking: !bridge.connected
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            text: bridge.connected ? "HOW CAN I HELP?" : "LINKING TO JARVISD"
                            color: Theme.accentBright
                            font.family: Theme.fontDisplay
                            font.pixelSize: 17
                            font.weight: Font.DemiBold
                            font.letterSpacing: Theme.trackMid
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            text: bridge.connected
                                  ? "Select a model and transmit a message to spin up a session."
                                  : "Status: " + bridge.status
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            lineHeight: 1.35
                        }

                        // TODAY // BRIEFING — skills.today digest, refreshed on connect.
                        TodayBriefing {
                            Layout.fillWidth: true
                            Layout.topMargin: 6
                            visible: bridge.connected
                        }
                    }
                }

                delegate: ChatDelegate {
                    width: chatView.width
                    onAllow: function(approvalId) { bridge.respondApproval(approvalId, "allow") }
                    onDeny:  function(approvalId) { bridge.respondApproval(approvalId, "deny") }
                    onAlways: function(approvalId) { bridge.respondApproval(approvalId, "always") }
                }

                // thinking row (footer): mini reactor with orbiting dots + label
                footer: Item {
                    width: chatView.width
                    height: panel.thinking ? 34 : 0
                    visible: panel.thinking
                    Behavior on height { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                    Row {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 10
                        ArcReactor {
                            anchors.verticalCenter: parent.verticalCenter
                            size: 24
                            thinking: panel.thinking
                            tint: Theme.accent
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "PROCESSING…"
                            color: Theme.accent
                            opacity: 0.8
                            font.family: Theme.fontDisplay
                            font.pixelSize: 10
                            font.letterSpacing: Theme.trackMid
                        }
                    }
                }
            }
        }

        // ===== Composer ======================================================
        Rectangle {
            id: composer
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(Math.max(56, inputArea.implicitHeight + 22), 168)
            radius: Theme.radius
            color: Theme.surfaceInput
            border.color: inputArea.activeFocus ? Theme.accent : Theme.hairlineSoft
            border.width: 1
            Behavior on border.color { ColorAnimation { duration: 140 } }

            // focus neon underline
            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: Theme.radius; anchors.rightMargin: Theme.radius
                anchors.bottomMargin: 1
                height: 1
                color: Theme.accent
                opacity: inputArea.activeFocus ? 0.7 : 0.0
                Behavior on opacity { NumberAnimation { duration: 140 } }
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 10
                anchors.topMargin: 6
                anchors.bottomMargin: 6
                spacing: 10

                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    TextArea {
                        id: inputArea
                        placeholderText: bridge.sessionId.length > 0
                                         ? "Message Jarvis…"
                                         : "Type to start a session…"
                        placeholderTextColor: Theme.textFaint
                        color: Theme.text
                        font.pixelSize: 14
                        font.family: Theme.fontSans
                        wrapMode: TextArea.Wrap
                        selectByMouse: true
                        selectionColor: Theme.accentDim
                        background: null
                        verticalAlignment: TextArea.AlignVCenter

                        Keys.onReturnPressed: function(event) {
                            if (event.modifiers & Qt.ShiftModifier) {
                                event.accepted = false  // newline
                            } else {
                                event.accepted = true
                                panel.submit()
                            }
                        }
                    }
                }

                // mic button (push-to-dictate; ~6s capture via pw-record -> voice.stt)
                Item {
                    id: micWrap
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: 2
                    width: 38; height: 38
                    readonly property bool recording: bridge.recordingState === "recording"
                    readonly property bool transcribing: bridge.recordingState === "transcribing"
                    visible: bridge.voiceAvailable()

                    // recording pulse halo
                    Rectangle {
                        anchors.centerIn: parent
                        width: 44; height: 44; radius: 22
                        color: "transparent"
                        border.color: Theme.danger
                        border.width: 2
                        opacity: micWrap.recording ? 0.6 : 0.0
                        SequentialAnimation on scale {
                            running: micWrap.recording
                            loops: Animation.Infinite
                            NumberAnimation { from: 0.9; to: 1.15; duration: 700; easing.type: Easing.InOutSine }
                            NumberAnimation { from: 1.15; to: 0.9; duration: 700; easing.type: Easing.InOutSine }
                        }
                    }
                    Rectangle {
                        anchors.fill: parent
                        radius: 19
                        color: micWrap.recording ? Theme.dangerDim
                               : (micMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
                        border.width: 1
                        border.color: micWrap.recording ? Theme.danger
                                      : micWrap.transcribing ? Theme.accent
                                      : (micMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        // transcribing spinner ring
                        Rectangle {
                            anchors.centerIn: parent
                            width: 22; height: 22; radius: 11
                            visible: micWrap.transcribing
                            color: "transparent"
                            border.width: 2
                            border.color: Theme.accent
                            opacity: 0.4
                            RotationAnimation on rotation {
                                running: micWrap.transcribing
                                loops: Animation.Infinite
                                from: 0; to: 360; duration: 900
                            }
                        }

                        Canvas {
                            anchors.centerIn: parent
                            width: 16; height: 16
                            property color ink: micWrap.recording ? Theme.danger
                                                : micWrap.transcribing ? Theme.accent
                                                : Theme.textMuted
                            onInkChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d"); ctx.reset()
                                ctx.strokeStyle = ink; ctx.fillStyle = ink
                                ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round"
                                // mic capsule (rounded top + bottom)
                                ctx.beginPath()
                                ctx.moveTo(6, 4); ctx.arc(8, 4, 2, Math.PI, 0)
                                ctx.lineTo(10, 8); ctx.arc(8, 8, 2, 0, Math.PI)
                                ctx.closePath(); ctx.stroke()
                                // stand
                                ctx.beginPath(); ctx.arc(8, 9, 4, 0.2, Math.PI - 0.2); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(8, 13); ctx.lineTo(8, 15); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(5.5, 15); ctx.lineTo(10.5, 15); ctx.stroke()
                            }
                        }
                        MouseArea {
                            id: micMa
                            anchors.fill: parent
                            hoverEnabled: true
                            enabled: bridge.connected && !micWrap.transcribing
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (micWrap.recording) bridge.voiceDictateStop()
                                else bridge.voiceDictate(6)
                            }
                        }
                    }
                }

                // glowing circular send button
                Item {
                    id: sendWrap
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: 2
                    width: 40; height: 40
                    property bool ready: bridge.connected && inputArea.text.trim().length > 0

                    Rectangle {  // glow halo
                        anchors.centerIn: parent
                        width: 48; height: 48; radius: 24
                        color: "transparent"
                        border.color: Theme.accentGlow
                        border.width: 2
                        opacity: sendWrap.ready ? 0.55 : 0.0
                        Behavior on opacity { NumberAnimation { duration: 160 } }
                    }
                    Rectangle {
                        id: sendCircle
                        anchors.fill: parent
                        radius: 20
                        color: sendWrap.ready ? Theme.accent : Theme.surfaceStrong
                        border.color: sendWrap.ready ? Theme.accentBright : Theme.hairlineSoft
                        border.width: 1
                        scale: sendMa.pressed && sendWrap.ready ? 0.92 : 1.0
                        Behavior on scale { NumberAnimation { duration: 90 } }
                        Behavior on color { ColorAnimation { duration: 140 } }
                        layer.enabled: sendWrap.ready
                        layer.effect: MultiEffect { blurEnabled: true; blur: 0.5; blurMax: 14; brightness: 0.15 }

                        Canvas {  // paper-plane / send arrow
                            anchors.centerIn: parent
                            width: 18; height: 18
                            property color ink: sendWrap.ready ? Theme.inkOnAccent : Theme.textFaint
                            onInkChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d")
                                ctx.reset()
                                ctx.fillStyle = ink
                                ctx.beginPath()
                                ctx.moveTo(2, 9)
                                ctx.lineTo(16, 2)
                                ctx.lineTo(11, 9)
                                ctx.lineTo(16, 16)
                                ctx.closePath()
                                ctx.fill()
                            }
                        }
                        MouseArea {
                            id: sendMa
                            anchors.fill: parent
                            enabled: sendWrap.ready
                            cursorShape: sendWrap.ready ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: panel.submit()
                        }
                    }
                }
            }
        }
    }

    // Inject a rendered skill (from the Skills page /invoke) into the transcript
    // as a user turn and send it. Creates a session first if none is active, just
    // like submit(). The skill text becomes the next model input.
    function injectSkill(name, message) {
        var t = ("" + message).trim()
        if (t.length === 0 || !bridge.connected)
            return
        if (bridge.sessionId.length === 0)
            bridge.createSession("coder", "codex", panel.selectedModel)
        chatModel.append({
            "kind": "message", "role": "user",
            "text": "/" + name + (t.length ? "\n\n" + t : ""),
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true
        })
        bridge.sendMessage(t)
        chatView.positionViewAtEnd()
    }

    // ---- Actions -----------------------------------------------------------
    function submit() {
        var t = inputArea.text.trim()
        if (t.length === 0 || !bridge.connected)
            return

        // First message creates a session (default coder/codex with picked model).
        if (bridge.sessionId.length === 0)
            bridge.createSession("coder", "codex", panel.selectedModel)

        chatModel.append({
            "kind": "message", "role": "user", "text": t,
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true
        })
        bridge.sendMessage(t)
        inputArea.text = ""
        chatView.positionViewAtEnd()
    }
}
