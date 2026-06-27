pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Effects
import JarvisSidebar

// AgentPeek — a compact LIVE view of what Jarvis is doing on its own nested desktop
// (or a Chrome tab). Reused on the Home dashboard's "working" card and in the chat
// peek panel. Self-manages the frame poll: starts it while visible + an agent is
// active, stops it when hidden. When there's no live frame it shows a TEXTURED
// preview (diagonal scanlines + a drifting cyan glow + the spinning reactor) so the
// card always reads as "the agent's screen lives here", never a flat empty box.
Rectangle {
    id: peek
    radius: 12
    color: "#05080D"
    border.width: 1
    border.color: peek.active ? Theme.accentDim : Theme.hairline
    clip: true

    Behavior on border.color { ColorAnimation { duration: Theme.durMid } }

    // Is there an agent desktop to watch (a co-worker session or a live take-over)?
    readonly property bool active: bridge.driving || bridge.coworkerSessionId.length > 0
    property bool poll: visible && active

    onPollChanged: poll ? bridge.mirrorStart() : bridge.mirrorStop()
    Component.onCompleted: if (poll) bridge.mirrorStart()
    Component.onDestruction: bridge.mirrorStop()

    // ---- Texture: diagonal scanlines (painted once) ------------------------
    Canvas {
        id: hatch
        anchors.fill: parent
        opacity: frame.visible ? 0.0 : 1.0
        Behavior on opacity { NumberAnimation { duration: Theme.durMid } }
        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)
            ctx.strokeStyle = Qt.rgba(0.239, 0.839, 1.0, 0.06)
            ctx.lineWidth = 1
            var step = 11
            for (var x = -height; x < width; x += step) {
                ctx.beginPath()
                ctx.moveTo(x, 0)
                ctx.lineTo(x + height, height)
                ctx.stroke()
            }
        }
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
    }

    // ---- Texture: a soft cyan glow that drifts + breathes ------------------
    Rectangle {
        id: glow
        visible: !frame.visible
        width: Math.min(parent.width, parent.height) * 0.55
        height: width
        radius: width / 2
        color: peek.active ? Theme.accent : Qt.rgba(0.357, 0.549, 1.0, 1.0) // blue when idle, cyan when live
        opacity: 0.22
        x: parent.width * 0.30
        y: parent.height * 0.28
        layer.enabled: true
        layer.effect: MultiEffect { blurEnabled: true; blur: 1.0; blurMax: 40 }

        // Drift + breathe only while the card is actually on screen (battery).
        SequentialAnimation on x {
            running: peek.visible; loops: Animation.Infinite
            NumberAnimation { from: peek.width * 0.22; to: peek.width * 0.42; duration: 5200; easing.type: Easing.InOutSine }
            NumberAnimation { from: peek.width * 0.42; to: peek.width * 0.22; duration: 5200; easing.type: Easing.InOutSine }
        }
        SequentialAnimation on opacity {
            running: peek.visible; loops: Animation.Infinite
            NumberAnimation { from: 0.16; to: 0.30; duration: 2600; easing.type: Easing.InOutSine }
            NumberAnimation { from: 0.30; to: 0.16; duration: 2600; easing.type: Easing.InOutSine }
        }
    }

    // ---- Live frame (when mirroring delivers one) -------------------------
    Image {
        id: frame
        anchors.fill: parent
        fillMode: Image.PreserveAspectFit
        cache: false
        asynchronous: true
        source: ""
        visible: bridge.frameSeq > 0
        Connections {
            target: bridge
            function onFrameReady() {
                frame.source = "image://jarvisframe/agent?" + bridge.frameSeq
            }
        }
    }

    // ---- Idle / waiting placeholder: the spinning reactor + a label -------
    Column {
        anchors.centerIn: parent
        spacing: 9
        visible: !frame.visible
        ArcReactor {
            anchors.horizontalCenter: parent.horizontalCenter
            size: Math.max(30, Math.min(46, peek.height * 0.34))
            tint: bridge.driving ? Theme.danger : Theme.accent
            thinking: peek.active
            spinning: true
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: peek.active ? "WAITING FOR THE AGENT…" : "AGENT SCREEN PREVIEW"
            color: peek.active ? Theme.accent : Theme.textFaint
            font.family: Theme.fontDisplay
            font.pixelSize: 9
            font.letterSpacing: 1.4
            font.weight: Font.DemiBold
        }
    }

    // ---- corner chip (resolution / label) ---------------------------------
    Rectangle {
        anchors.left: parent.left; anchors.bottom: parent.bottom; anchors.margins: 8
        visible: !frame.visible
        radius: 6
        width: chipT.implicitWidth + 14; height: 18
        color: Qt.rgba(0.027, 0.043, 0.071, 0.8)
        Text {
            id: chipT; anchors.centerIn: parent
            text: "⚡ agent desktop"
            color: Theme.accent; font.family: Theme.fontDisplay
            font.pixelSize: 8; font.letterSpacing: 1; font.weight: Font.DemiBold
        }
    }

    // ---- LIVE badge -------------------------------------------------------
    Rectangle {
        visible: bridge.mirroring
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.margins: 8
        radius: 9
        width: liveRow.implicitWidth + 14
        height: 18
        color: Qt.rgba(0.22, 0.90, 0.63, 0.16)
        border.width: 1
        border.color: Qt.rgba(0.22, 0.90, 0.63, 0.35)
        Row {
            id: liveRow
            anchors.centerIn: parent
            spacing: 5
            Rectangle {
                id: liveDot
                anchors.verticalCenter: parent.verticalCenter
                width: 6; height: 6; radius: 3; color: Theme.success
                SequentialAnimation on opacity {
                    running: parent.parent.parent.visible; loops: Animation.Infinite
                    NumberAnimation { from: 1.0; to: 0.25; duration: 700; easing.type: Easing.InOutSine }
                    NumberAnimation { from: 0.25; to: 1.0; duration: 700; easing.type: Easing.InOutSine }
                }
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "LIVE"
                color: Theme.success
                font.family: Theme.fontDisplay
                font.pixelSize: 8
                font.letterSpacing: 1.4
                font.weight: Font.DemiBold
            }
        }
    }
}
