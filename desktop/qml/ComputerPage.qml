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
    // ANY session with a nested agent desktop is watchable here (auto computer-use
    // chats too, not just explicit co-work) — this is what the "Full" button needs.
    readonly property bool hasLiveDesktop: bridge.coworkerSessionId.length > 0 || bridge.hasAgentDesktop

    // AppShell binds this true while the Computer page is the current page. We only
    // poll the mirror while it's actually on screen (battery), and START it on
    // arrival (the chat peek stops it when the chat page hides).
    property bool pageVisible: false
    readonly property bool wantMirror: pageVisible && hasLiveDesktop
    onWantMirrorChanged: wantMirror ? bridge.mirrorStart() : bridge.mirrorStop()

    Component.onCompleted: {
        if (bridge.connected) bridge.listModels(page.selectedBrain)
        if (wantMirror) bridge.mirrorStart()
    }

    // ---- transcript helpers (mirror JarvisPanel.appendEvent, agent session) ----
    function appendEvent(ev) {
        var kind = ev.kind !== undefined ? ev.kind : ""
        switch (kind) {
        case "thinking":
            page.thinking = true; break
        case "message":
            page.thinking = false
            txModel.append({ "kind":"message", "role": ev.role !== undefined ? ev.role : "assistant",
                "text": ev.text !== undefined ? ev.text : "", "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "tool_call":
            page.thinking = false
            txModel.append({ "kind":"tool_call", "role":"tool",
                "text": ev.args !== undefined ? JSON.stringify(ev.args) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": ev.name !== undefined ? ev.name : "tool",
                "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "tool_result":
            txModel.append({ "kind":"tool_result", "role":"tool",
                "text": ev.output !== undefined ? ("" + ev.output) : "",
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName":"", "approvalId":"", "risk":"", "ok": ev.ok !== false, "streaming":false })
            break
        case "approval":
            page.thinking = false
            txModel.append({ "kind":"approval", "role":"system",
                "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                "callId":"", "toolName":"",
                "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                "risk": ev.risk !== undefined ? ("" + ev.risk) : "", "ok":true, "streaming":false })
            break
        case "diff":
            txModel.append({ "kind":"diff", "role":"tool",
                "text": ev.patch !== undefined ? ev.patch : "",
                "callId":"", "toolName": ev.path !== undefined ? ev.path : "diff",
                "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "error":
            page.thinking = false
            txModel.append({ "kind":"error", "role":"system",
                "text": ev.message !== undefined ? ev.message : "error",
                "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true, "streaming":false })
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
        // The co-worker session ended / was cleared (stopped, deleted, or replaced):
        // wipe its transcript so a finished agent conversation can never linger on
        // this page under "no active session". Mirrors the chat page's reconciler.
        function onCoworkerSessionIdChanged() {
            if (bridge.coworkerSessionId.length === 0) {
                txModel.clear()
                page.thinking = false
            }
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
                subtitle: "Let Cindro drive a nested desktop, or take over your real screen."
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
                active: page.hasLiveDesktop
                sweep: bridge.mirroring && page.hasLiveDesktop

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

                        // live frame. Synchronous decode (the frame is already a
                        // decoded QImage in the C++ provider) so the image never
                        // blanks between frames → no flicker.
                        Image {
                            id: liveFrame
                            anchors.fill: parent
                            anchors.margins: 1
                            fillMode: Image.PreserveAspectFit
                            cache: false
                            asynchronous: false
                            smooth: true
                            visible: page.hasLiveDesktop && bridge.frameSeq > 0
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
                                thinking: page.hasLiveDesktop && !(bridge.frameSeq > 0)
                            }
                            Text {
                                Layout.fillWidth: true
                                horizontalAlignment: Text.AlignHCenter
                                text: page.hasLiveDesktop ? "CONNECTING TO AGENT DESKTOP…" : "NO ACTIVE SESSION"
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
                                text: page.hasLiveDesktop
                                      ? "Streaming the nested desktop. Cindro is driving a distinct cursor here, not your screen."
                                      : "Open a chat and have Cindro use its computer, or start a co-worker session, to watch it work here."
                                color: Theme.textFaint
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                lineHeight: 1.35
                            }
                        }

                        // ---- GLOWING AGENT CURSOR over the live frame --------
                        // Jarvis drives a distinct cursor on its nested desktop;
                        // show it BIG + blue so the user can watch it act (this is
                        // where Chrome etc. run in the agent desktop). Positioned
                        // from the agent-pointer bus (raw nested pixels) mapped onto
                        // the letterboxed frame via sourceSize/paintedWidth.
                        Item {
                            id: agentGlowLayer
                            anchors.fill: parent
                            visible: liveFrame.visible
                            property real gx: -1
                            property real gy: -1
                            readonly property real sw: liveFrame.sourceSize.width > 0 ? liveFrame.sourceSize.width : 1
                            readonly property real sh: liveFrame.sourceSize.height > 0 ? liveFrame.sourceSize.height : 1
                            readonly property real ox: liveFrame.x + (liveFrame.width - liveFrame.paintedWidth) / 2
                            readonly property real oy: liveFrame.y + (liveFrame.height - liveFrame.paintedHeight) / 2

                            Connections {
                                target: bridge
                                function onAgentPointerGlobal(gx, gy, action, button) {
                                    agentGlowLayer.gx = gx
                                    agentGlowLayer.gy = gy
                                    if (action === "click" || action === "drag" || action === "down")
                                        agentGlow.flash(action)
                                }
                            }

                            GlowCursor {
                                id: agentGlow
                                diameter: 84
                                active: agentGlowLayer.gx >= 0 && page.hasLiveDesktop
                                // center the hotspot on the mapped pointer position
                                x: agentGlowLayer.ox + (agentGlowLayer.gx / agentGlowLayer.sw) * liveFrame.paintedWidth - width / 2
                                y: agentGlowLayer.oy + (agentGlowLayer.gy / agentGlowLayer.sh) * liveFrame.paintedHeight - height / 2
                            }
                        }

                        // ---- "JARVIS IS USING THIS DESKTOP" banner -----------
                        Rectangle {
                            visible: liveFrame.visible && bridge.mirroring
                            anchors.horizontalCenter: parent.horizontalCenter
                            anchors.top: parent.top
                            anchors.topMargin: 12
                            width: bannerRow.implicitWidth + 32
                            height: 36
                            radius: height / 2
                            color: Qt.rgba(0.039, 0.055, 0.086, 0.92)
                            border.width: 1
                            border.color: Theme.accent
                            Row {
                                id: bannerRow
                                anchors.centerIn: parent
                                spacing: 8
                                Text {
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "⚡"
                                    color: Theme.accentBright
                                    font.pixelSize: 14
                                }
                                Text {
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "Cindro is using this desktop"
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 13
                                    font.weight: Font.Medium
                                }
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
                        cacheBuffer: 300
                        reuseItems: true
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
                    text: "Cindro will drive your ACTUAL desktop with a distinct cursor and a "
                          + "“CINDRO IS DRIVING” overlay. This requires biometric approval on a "
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
