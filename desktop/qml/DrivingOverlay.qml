import QtQuick
import QtQuick.Effects
import JarvisSidebar

// DrivingOverlay — the content of the click-through, full-screen wlr-layer-shell
// OVERLAY surface (role installed in C++ by WindowController.configureOverlay).
//
// While a REAL-screen take-over is active (bridge.driving), this:
//   * draws a DISTINCT neon cursor sprite at the agent's pointer position
//     (read from bridge.agentPointer, screen-normalized in [0,1]),
//   * shows a pulsing "⚡ JARVIS IS DRIVING" banner at the top.
//
// It must NOT steal input — the surface's input region is empty (set in C++) and
// every item here is purely visual (no MouseArea anywhere). The background is
// fully transparent so the user's real desktop shows through.
Item {
    id: overlay
    anchors.fill: parent

    // last agent pointer, normalized [0,1] -> pixel position on this surface
    property real px: 0.5
    property real py: 0.5
    property string lastAction: "move"
    property bool clickPulse: false

    Connections {
        target: bridge
        function onAgentPointer(nx, ny, action, button) {
            overlay.px = Math.max(0, Math.min(1, nx))
            overlay.py = Math.max(0, Math.min(1, ny))
            overlay.lastAction = action
            if (action === "click" || action === "drag") {
                overlay.clickPulse = false
                overlay.clickPulse = true
                clickRing.restart()
            }
        }
    }

    // ===== "JARVIS IS DRIVING" banner =======================================
    Item {
        id: banner
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: 14
        width: bannerBg.width
        height: bannerBg.height

        Rectangle {
            id: bannerBg
            width: bannerRow.implicitWidth + 36
            height: 40
            radius: 20
            color: Qt.rgba(0.02, 0.05, 0.09, 0.88)
            border.width: 1.5
            border.color: Theme.danger

            // pulsing danger glow halo
            layer.enabled: true
            layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 22; brightness: 0.15 }

            SequentialAnimation on border.color {
                loops: Animation.Infinite
                ColorAnimation { from: Theme.danger; to: Theme.amber; duration: 900; easing.type: Easing.InOutSine }
                ColorAnimation { from: Theme.amber; to: Theme.danger; duration: 900; easing.type: Easing.InOutSine }
            }

            Row {
                id: bannerRow
                anchors.centerIn: parent
                spacing: 10

                // lightning bolt mark
                Canvas {
                    width: 16; height: 20
                    anchors.verticalCenter: parent.verticalCenter
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.fillStyle = Theme.amber
                        ctx.beginPath()
                        ctx.moveTo(10, 1); ctx.lineTo(2, 11); ctx.lineTo(7, 11)
                        ctx.lineTo(6, 19); ctx.lineTo(14, 8); ctx.lineTo(9, 8)
                        ctx.closePath(); ctx.fill()
                    }
                }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "JARVIS IS DRIVING"
                    color: Theme.text
                    font.family: Theme.fontDisplay
                    font.pixelSize: 14
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackWide
                }
                // live dot
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 8; height: 8; radius: 4
                    color: Theme.danger
                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        NumberAnimation { from: 1.0; to: 0.2; duration: 600 }
                        NumberAnimation { from: 0.2; to: 1.0; duration: 600 }
                    }
                }
            }
        }
    }

    // ===== DISTINCT agent cursor sprite =====================================
    Item {
        id: cursor
        width: 46
        height: 46
        // place the hotspot (cursor tip) at the agent pointer position
        x: overlay.px * overlay.width - 6
        y: overlay.py * overlay.height - 4
        Behavior on x { NumberAnimation { duration: 60; easing.type: Easing.OutQuad } }
        Behavior on y { NumberAnimation { duration: 60; easing.type: Easing.OutQuad } }

        // soft neon halo so the agent cursor is unmistakable over any wallpaper
        Rectangle {
            anchors.centerIn: cursorArrow
            width: 30; height: 30; radius: 15
            color: Theme.accent
            opacity: 0.28
            layer.enabled: true
            layer.effect: MultiEffect { blurEnabled: true; blur: 1.0; blurMax: 28; brightness: 0.2 }
        }

        // the arrow itself — a bold magenta/cyan sprite, clearly not the OS cursor
        Canvas {
            id: cursorArrow
            x: 4; y: 2
            width: 26; height: 30
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                // filled arrow
                ctx.beginPath()
                ctx.moveTo(1, 1)
                ctx.lineTo(1, 21)
                ctx.lineTo(6.5, 16)
                ctx.lineTo(10, 24)
                ctx.lineTo(14, 22)
                ctx.lineTo(10.5, 14.5)
                ctx.lineTo(18, 14)
                ctx.closePath()
                ctx.fillStyle = Theme.magenta
                ctx.fill()
                ctx.lineWidth = 1.4
                ctx.lineJoin = "round"
                ctx.strokeStyle = Theme.accentBright
                ctx.stroke()
            }
        }

        // small "J" tag riding with the cursor
        Rectangle {
            anchors.left: cursorArrow.right
            anchors.top: cursorArrow.top
            anchors.leftMargin: 1
            width: jTag.implicitWidth + 8
            height: 14
            radius: 4
            color: Qt.rgba(0.02, 0.05, 0.09, 0.85)
            border.width: 1
            border.color: Theme.accent
            Text {
                id: jTag
                anchors.centerIn: parent
                text: "JARVIS"
                color: Theme.accentBright
                font.family: Theme.fontDisplay
                font.pixelSize: 7
                font.letterSpacing: 1.0
                font.weight: Font.DemiBold
            }
        }
    }

    // ===== click / drag ripple at the cursor ================================
    Rectangle {
        id: clickRingRect
        width: 12; height: 12; radius: 6
        color: "transparent"
        border.width: 2
        border.color: overlay.lastAction === "drag" ? Theme.amber : Theme.accentBright
        x: overlay.px * overlay.width - width / 2
        y: overlay.py * overlay.height - height / 2
        visible: clickRing.running
        SequentialAnimation {
            id: clickRing
            ParallelAnimation {
                NumberAnimation { target: clickRingRect; property: "scale"; from: 0.5; to: 3.2; duration: 420; easing.type: Easing.OutCubic }
                NumberAnimation { target: clickRingRect; property: "opacity"; from: 0.9; to: 0.0; duration: 420; easing.type: Easing.OutCubic }
            }
        }
    }

    // faint vignette pulse on the screen edges to reinforce "agent in control"
    Rectangle {
        anchors.fill: parent
        color: "transparent"
        border.width: 2
        border.color: Theme.danger
        opacity: 0.0
        SequentialAnimation on opacity {
            loops: Animation.Infinite
            NumberAnimation { from: 0.0; to: 0.16; duration: 1100; easing.type: Easing.InOutSine }
            NumberAnimation { from: 0.16; to: 0.0; duration: 1100; easing.type: Easing.InOutSine }
        }
    }
}
