pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// COMPUTER page — "Jarvis drives your computer".
//
// Two control modes:
//   * Co-worker (default): bridge.startCoworker(profile=coworker, target=agent).
//     jarvisd spawns a NESTED headless desktop + a per-session computer-use
//     engine; the user keeps working while Jarvis drives the nested desktop. A
//     LIVE PREVIEW of that nested desktop is polled from the engine's
//     /video/frame and rendered here (image://jarvisframe/agent?<seq>).
//   * Take over my screen: bridge.takeOver(target=real). This is approval /
//     biometric gated by the daemon; while it is live the distinct-cursor
//     DrivingOverlay (a click-through layer-shell window) tracks the agent
//     pointer over the user's REAL screen.
//
// A session transcript side panel replays the co-worker session's normalized
// brain events (Contract B) using the shared ChatDelegate.
Item {
    id: page

    // co-worker transcript model fed from bridge.sessionEvent for the agent session
    ListModel { id: txModel }
    property bool thinking: false

    property var brainOptions: ["codex", "claude", "api"]
    property string selectedBrain: "codex"
    property var modelOptions: ["gpt-5.5", "gpt-5-codex", "o4-mini"]
    property string selectedModel: modelOptions.length > 0 ? modelOptions[0] : ""

    readonly property bool hasCoworker: bridge.coworkerSessionId.length > 0

    Component.onCompleted: if (bridge.connected) bridge.listModels(page.selectedBrain)

    // ---- transcript helpers (mirror JarvisPanel.appendEvent, agent session) ----
    function appendEvent(ev) {
        var kind = ev.kind !== undefined ? ev.kind : ""
        switch (kind) {
        case "thinking":
            page.thinking = true; break
        case "message":
            page.thinking = false
            txModel.append({ "kind":"message", "role": ev.role !== undefined ? ev.role : "assistant",
                "text": ev.text !== undefined ? ev.text : "", "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true })
            break
        case "tool_call":
            page.thinking = false
            txModel.append({ "kind":"tool_call", "role":"tool",
                "text": ev.args !== undefined ? JSON.stringify(ev.args) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": ev.name !== undefined ? ev.name : "tool",
                "approvalId":"", "risk":"", "ok":true })
            break
        case "tool_result":
            txModel.append({ "kind":"tool_result", "role":"tool",
                "text": ev.output !== undefined ? ("" + ev.output) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName":"", "approvalId":"", "risk":"", "ok": ev.ok !== false })
            break
        case "approval":
            page.thinking = false
            txModel.append({ "kind":"approval", "role":"system",
                "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                "callId":"", "toolName":"",
                "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                "risk": ev.risk !== undefined ? ("" + ev.risk) : "", "ok":true })
            break
        case "diff":
            txModel.append({ "kind":"diff", "role":"tool",
                "text": ev.patch !== undefined ? ev.patch : "",
                "callId":"", "toolName": ev.path !== undefined ? ev.path : "diff",
                "approvalId":"", "risk":"", "ok":true })
            break
        case "error":
            page.thinking = false
            txModel.append({ "kind":"error", "role":"system",
                "text": ev.message !== undefined ? ev.message : "error",
                "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true })
            break
        case "final":
            page.thinking = false; break
        default: break
        }
    }

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) bridge.listModels(page.selectedBrain) }
        function onModelsListed(brain, models) {
            if (brain === page.selectedBrain && models && models.length > 0) {
                page.modelOptions = models
                page.selectedModel = models[0]
            }
        }
        function onCoworkerStarted(sessionId) {
            txModel.clear()
            page.thinking = false
        }
        // Only render events for the co-worker (agent) session on this page.
        function onSessionEvent(ev) {
            if (ev.session_id !== undefined && ev.session_id === bridge.coworkerSessionId) {
                page.appendEvent(ev)
                txView.positionViewAtEnd()
            }
        }
    }

    // ===== layout ===========================================================
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        // ---- header + status ------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            PageHeader {
                Layout.fillWidth: true
                title: "Computer"
                subtitle: "Let Jarvis drive a nested desktop, or take over your real screen."
            }
            // DRIVING state beacon
            Rectangle {
                Layout.alignment: Qt.AlignTop
                visible: bridge.driving
                radius: Theme.radiusXs
                implicitWidth: drvRow.implicitWidth + 18
                implicitHeight: 26
                color: Qt.rgba(1.0, 0.30, 0.369, 0.10)
                border.width: 1
                border.color: Theme.danger
                Row {
                    id: drvRow
                    anchors.centerIn: parent
                    spacing: 7
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 7; height: 7; radius: 3.5
                        color: Theme.danger
                        SequentialAnimation on opacity {
                            loops: Animation.Infinite
                            NumberAnimation { from: 1.0; to: 0.3; duration: 600 }
                            NumberAnimation { from: 0.3; to: 1.0; duration: 600 }
                        }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: "DRIVING REAL SCREEN"
                        color: Theme.danger
                        font.family: Theme.fontDisplay
                        font.pixelSize: 9
                        font.letterSpacing: Theme.trackMid
                        font.weight: Font.DemiBold
                    }
                }
            }
        }

        // ---- control bar ----------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true
            title: ""

            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                // brain picker
                ColumnLayout {
                    spacing: 4
                    Text { text: "BRAIN"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Widgets.StyledCombo {
                        Layout.preferredWidth: 110
                        model: page.brainOptions
                        currentIndex: Math.max(0, page.brainOptions.indexOf(page.selectedBrain))
                        onActivated: {
                            page.selectedBrain = currentText
                            bridge.listModels(page.selectedBrain)
                        }
                    }
                }

                // model picker
                ColumnLayout {
                    spacing: 4
                    Text { text: "MODEL"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Widgets.StyledCombo {
                        Layout.preferredWidth: 170
                        model: page.modelOptions
                        currentIndex: Math.max(0, page.modelOptions.indexOf(page.selectedModel))
                        onActivated: page.selectedModel = currentText
                    }
                }

                Item { Layout.fillWidth: true }

                // Start / Stop co-worker
                Widgets.PillButton {
                    label: page.hasCoworker ? "Stop session" : "Start co-worker session"
                    primary: !page.hasCoworker
                    danger: page.hasCoworker
                    enabledBtn: bridge.connected
                    Layout.alignment: Qt.AlignBottom
                    onClicked: {
                        if (page.hasCoworker)
                            bridge.stopCoworker()
                        else
                            bridge.startCoworker(page.selectedBrain, page.selectedModel)
                    }
                }

                // TAKE OVER MY SCREEN (approval-gated; amber = caution)
                TakeOverButton {
                    Layout.alignment: Qt.AlignBottom
                    enabledBtn: bridge.connected && !bridge.driving
                    driving: bridge.driving
                    onClicked: {
                        if (bridge.driving)
                            bridge.releaseScreen()
                        else
                            takeOverConfirm.open()
                    }
                }
            }
        }

        // ---- preview + transcript ------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 14

            // ===== LIVE PREVIEW of the nested agent desktop ==================
            HudFrame {
                Layout.fillHeight: true
                Layout.preferredWidth: parent.width * 0.62
                Layout.minimumWidth: 260
                fill: Theme.bgDeep
                active: page.hasCoworker
                sweep: bridge.mirroring && page.hasCoworker

                // frame + caption header
                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            text: "NESTED AGENT DESKTOP"
                            color: Theme.accent
                            opacity: 0.85
                            font.family: Theme.fontDisplay
                            font.pixelSize: 10
                            font.letterSpacing: Theme.trackMid
                            font.weight: Font.DemiBold
                        }
                        Item { Layout.fillWidth: true }
                        // mirror/live indicator
                        Row {
                            spacing: 6
                            visible: page.hasCoworker
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 6; height: 6; radius: 3
                                color: bridge.mirroring ? Theme.success : Theme.textFaint
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: bridge.mirroring ? "LIVE" : "PAUSED"
                                color: bridge.mirroring ? Theme.success : Theme.textFaint
                                font.family: Theme.fontDisplay
                                font.pixelSize: 9
                                font.letterSpacing: Theme.trackMid
                            }
                        }
                    }

                    // the framebuffer surface
                    Rectangle {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        radius: Theme.radiusSm
                        color: Qt.rgba(0, 0, 0, 0.35)
                        border.width: 1
                        border.color: Theme.hairlineSoft
                        clip: true

                        // live frame
                        Image {
                            id: liveFrame
                            anchors.fill: parent
                            anchors.margins: 1
                            fillMode: Image.PreserveAspectFit
                            cache: false
                            asynchronous: true
                            smooth: true
                            visible: page.hasCoworker && bridge.frameSeq > 0
                            // bumping the query on frameReady defeats the QML cache
                            source: ""
                        }

                        // empty / connecting state — arc reactor centerpiece
                        ColumnLayout {
                            anchors.centerIn: parent
                            width: parent.width - 40
                            spacing: 16
                            visible: !liveFrame.visible
                            ArcReactor {
                                Layout.alignment: Qt.AlignHCenter
                                size: 96
                                tint: Theme.accent
                                thinking: page.hasCoworker && !(bridge.frameSeq > 0)
                            }
                            Text {
                                Layout.fillWidth: true
                                horizontalAlignment: Text.AlignHCenter
                                text: page.hasCoworker ? "SPAWNING NESTED DESKTOP…" : "NO ACTIVE SESSION"
                                color: Theme.accentBright
                                font.family: Theme.fontDisplay
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                                font.letterSpacing: Theme.trackMid
                            }
                            Text {
                                Layout.fillWidth: true
                                horizontalAlignment: Text.AlignHCenter
                                wrapMode: Text.WordWrap
                                text: page.hasCoworker
                                      ? "Streaming the nested desktop. Jarvis is driving a distinct cursor here, not your screen."
                                      : "Start a co-worker session to watch Jarvis work on a private nested desktop."
                                color: Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                lineHeight: 1.35
                            }
                        }
                    }
                }
            }

            // ===== session transcript side panel =============================
            HudFrame {
                Layout.fillHeight: true
                Layout.fillWidth: true
                Layout.minimumWidth: 200
                fill: Theme.panel
                active: page.hasCoworker
                sweep: page.thinking

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 8

                    Text {
                        text: "SESSION TRANSCRIPT"
                        color: Theme.accent
                        opacity: 0.85
                        font.family: Theme.fontDisplay
                        font.pixelSize: 10
                        font.letterSpacing: Theme.trackMid
                        font.weight: Font.DemiBold
                    }

                    ListView {
                        id: txView
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 10
                        model: txModel
                        cacheBuffer: 600
                        boundsBehavior: Flickable.StopAtBounds

                        ScrollBar.vertical: ScrollBar {
                            policy: ScrollBar.AsNeeded
                            width: 5
                            background: Item {}
                            contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
                        }

                        // empty hint
                        Text {
                            anchors.centerIn: parent
                            width: parent.width - 24
                            visible: txModel.count === 0
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            text: page.hasCoworker ? "Waiting for the agent's first action…"
                                                   : "No session yet."
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 12
                        }

                        delegate: ChatDelegate {
                            width: txView.width
                            onAllow: function(approvalId) { bridge.respondApproval(approvalId, "allow") }
                            onDeny:  function(approvalId) { bridge.respondApproval(approvalId, "deny") }
                            onAlways: function(approvalId) { bridge.respondApproval(approvalId, "always") }
                        }

                        footer: Item {
                            width: txView.width
                            height: page.thinking ? 30 : 0
                            visible: page.thinking
                            Row {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: 9
                                ArcReactor { anchors.verticalCenter: parent.verticalCenter; size: 20; thinking: page.thinking; tint: Theme.accent }
                                Text {
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "WORKING…"
                                    color: Theme.accent; opacity: 0.8
                                    font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackMid
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- frame source bumping ---------------------------------------------
    // The C++ Bridge pushes new JPEGs into the FrameProvider and emits frameReady;
    // we re-point the Image source with the new seq so QML re-fetches it.
    Connections {
        target: bridge
        function onFrameReady(seq) {
            liveFrame.source = "image://jarvisframe/agent?" + seq
        }
        function onMirroringChanged() {
            if (!bridge.mirroring)
                liveFrame.source = ""
        }
    }

    // ===== TAKE OVER confirm dialog (approval-aware) ========================
    Popup {
        id: takeOverConfirm
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 60, 440)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.amberDim
            border.width: 1
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.topMargin: 1
                height: 2; radius: 1
                color: Theme.amber
                layer.enabled: true
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
            }
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.6) }

        contentItem: ColumnLayout {
            spacing: 0
            ColumnLayout {
                Layout.fillWidth: true
                Layout.margins: 22
                spacing: 14

                RowLayout {
                    spacing: 10
                    Text { text: "⚠"; color: Theme.amber; font.pixelSize: 20 }
                    Text {
                        text: "TAKE OVER MY SCREEN"
                        color: Theme.amber
                        font.family: Theme.fontDisplay
                        font.pixelSize: 15
                        font.weight: Font.DemiBold
                        font.letterSpacing: Theme.trackMid
                    }
                }
                Text {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    text: "Jarvis will drive your ACTUAL desktop with a distinct cursor and a "
                          + "“JARVIS IS DRIVING” overlay. This requires biometric approval on a "
                          + "paired device. You can release control at any time."
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.4
                }
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 4
                    spacing: 10
                    Item { Layout.fillWidth: true }
                    Widgets.PillButton { label: "Cancel"; onClicked: takeOverConfirm.close() }
                    Widgets.PillButton {
                        label: "Request take-over"
                        primary: true
                        onClicked: {
                            bridge.takeOver(page.selectedBrain, page.selectedModel)
                            takeOverConfirm.close()
                        }
                    }
                }
            }
        }
    }

    // ---- TAKE OVER button (amber, distinct from the cyan primary) ----------
    component TakeOverButton: Item {
        id: tob
        property bool enabledBtn: true
        property bool driving: false
        signal clicked()
        implicitWidth: tobText.implicitWidth + 38
        implicitHeight: 34
        opacity: enabledBtn || driving ? 1.0 : 0.4

        Rectangle {
            anchors.fill: parent
            anchors.margins: -2
            radius: Theme.radiusSm + 2
            color: "transparent"
            border.color: tob.driving ? Theme.danger : Theme.amber
            border.width: 2
            opacity: (tobMa.containsMouse && (tob.enabledBtn || tob.driving)) ? 0.6 : 0.0
            Behavior on opacity { NumberAnimation { duration: Theme.durFast } }
            layer.enabled: opacity > 0.01
            layer.effect: MultiEffect { blurEnabled: true; blur: 0.8; blurMax: 18 }
        }
        Rectangle {
            anchors.fill: parent
            radius: Theme.radiusSm
            color: tob.driving ? Qt.rgba(1.0, 0.30, 0.369, 0.16)
                               : (tobMa.containsMouse ? Qt.rgba(1.0, 0.706, 0.329, 0.18) : Theme.surface)
            border.width: 1
            border.color: tob.driving ? Theme.danger : Theme.amber
            Behavior on color { ColorAnimation { duration: Theme.durFast } }
            scale: tobMa.pressed && (tob.enabledBtn || tob.driving) ? 0.97 : 1.0
            Behavior on scale { NumberAnimation { duration: 80 } }
            Text {
                id: tobText
                anchors.centerIn: parent
                text: tob.driving ? "RELEASE SCREEN" : "TAKE OVER MY SCREEN"
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.weight: Font.DemiBold
                font.letterSpacing: Theme.trackMid
                color: tob.driving ? Theme.danger : Theme.amber
            }
        }
        MouseArea {
            id: tobMa
            anchors.fill: parent
            enabled: tob.enabledBtn || tob.driving
            hoverEnabled: true
            cursorShape: (tob.enabledBtn || tob.driving) ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: tob.clicked()
        }
    }
}
