import QtQuick
import QtQuick.Effects
import JarvisSidebar

// DrivingOverlay — the visual content of the full-screen, click-through
// wlr-layer-shell OVERLAY surface (role + empty pointer input region installed in
// C++ by WindowController.configureOverlay). It MATCHES the Codex take-over look,
// cyan-accented for the Jarvis HUD:
//
//   1) a dark rounded PILL near the top-center reading
//        "⚡ Jarvis is using your computer  ·  Esc to cancel"
//      ("Esc to cancel" dimmed). Esc -> bridge.takeOverCancel() AND hide.
//   2) a GLOWING CURSOR: a soft cyan radial glow halo (~40px) plus a crisp,
//      distinct Jarvis arrow sprite that LERP-animates to follow the agent
//      pointer from bridge.agentPointer (screen-normalized [0,1]), with a subtle
//      pulse on the halo.
//
// The surface NEVER steals pointer input (empty input region set in C++; no
// MouseArea here). It accepts ONLY the Esc key (keyboard interactivity is enabled
// on the surface in C++ ONLY while driving) to cancel the take-over.
Item {
    id: overlay
    anchors.fill: parent
    focus: true

    // Last agent pointer, normalized [0,1] -> pixel position on this surface.
    property real px: 0.5
    property real py: 0.5
    property string lastAction: "move"

    // Cancel the take-over: tell the daemon AND drop the overlay locally so the
    // user is never stuck under a banner. bridge.takeOverCancel() flips driving
    // false, which unmaps this surface via Main.qml's onDrivingChanged.
    function cancel() {
        bridge.takeOverCancel()
    }

    // Esc cancels (the surface is given keyboard focus only while driving).
    Keys.onEscapePressed: overlay.cancel()
    Keys.onPressed: function(e) {
        if (e.key === Qt.Key_Escape) {
            overlay.cancel()
            e.accepted = true
        }
    }

    Connections {
        target: bridge
        function onAgentPointer(nx, ny, action, button) {
            overlay.px = Math.max(0, Math.min(1, nx))
            overlay.py = Math.max(0, Math.min(1, ny))
            overlay.lastAction = action
            if (action === "click" || action === "drag" || action === "down") {
                clickRing.restart()
            }
        }
        // Re-assert keyboard focus whenever the overlay arms, so Esc lands here.
        function onDrivingChanged() {
            if (bridge.driving)
                overlay.forceActiveFocus()
        }
    }

    Component.onCompleted: overlay.forceActiveFocus()

    // ======================================================================
    //  TOP-CENTER PILL  —  "⚡ Jarvis is using your computer · Esc to cancel"
    // ======================================================================
    Item {
        id: pill
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: 18
        width: pillBg.width
        height: pillBg.height

        // soft cyan glow bloom behind the pill (separate item so the blur halo
        // is not clipped by the pill's own rounded rect)
        Rectangle {
            id: pillGlow
            anchors.centerIn: pillBg
            width: pillBg.width
            height: pillBg.height
            radius: pillBg.radius
            color: "transparent"
            border.width: 1
            border.color: Theme.accent
            opacity: 0.55
            layer.enabled: true
            layer.effect: MultiEffect {
                blurEnabled: true
                blur: 1.0
                blurMax: 28
                brightness: 0.18
                colorization: 1.0
                colorizationColor: Theme.accent
            }
            // gentle breathing on the glow so the banner reads as "live"
            SequentialAnimation on opacity {
                loops: Animation.Infinite
                NumberAnimation { from: 0.32; to: 0.62; duration: 1500; easing.type: Easing.InOutSine }
                NumberAnimation { from: 0.62; to: 0.32; duration: 1500; easing.type: Easing.InOutSine }
            }
        }

        Rectangle {
            id: pillBg
            width: pillRow.implicitWidth + 40
            height: 44
            radius: height / 2
            // near-black pill, ~#0A0E16 @ 0.92
            color: Qt.rgba(0.039, 0.055, 0.086, 0.92)
            border.width: 1
            border.color: Theme.accent     // 1px cyan hairline

            Row {
                id: pillRow
                anchors.centerIn: parent
                spacing: 9

                // ⚡ lightning bolt mark (cyan)
                Canvas {
                    width: 14; height: 20
                    anchors.verticalCenter: parent.verticalCenter
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.fillStyle = Theme.accentBright
                        ctx.beginPath()
                        ctx.moveTo(9, 1); ctx.lineTo(1.5, 11); ctx.lineTo(6, 11)
                        ctx.lineTo(5, 19); ctx.lineTo(12.5, 8); ctx.lineTo(8, 8)
                        ctx.closePath(); ctx.fill()
                    }
                }
                // primary label
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Jarvis is using your computer"
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 15
                    font.weight: Font.Medium
                }
                // separator dot
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "·"
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 16
                }
                // dimmed "Esc to cancel"
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Esc to cancel"
                    color: Theme.textMuted
                    opacity: 0.7
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                    font.weight: Font.Normal
                }
            }
        }
    }

    // ======================================================================
    //  GLOWING AGENT CURSOR  —  cyan radial halo + distinct Jarvis arrow
    // ======================================================================
    Item {
        id: cursor
        width: 64
        height: 64
        // hotspot (arrow tip) sits at the agent pointer; the Item is centered on
        // the halo, and the arrow's tip is offset to the halo center.
        x: overlay.px * overlay.width - width / 2
        y: overlay.py * overlay.height - height / 2
        // LERP toward each new agent position so the cursor glides, not jumps.
        Behavior on x { NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }

        // soft cyan radial GLOW halo (~40px, ~40% opacity, blurred), subtly pulsing
        Rectangle {
            id: halo
            anchors.centerIn: parent
            width: 40
            height: 40
            radius: 20
            color: Theme.accent
            opacity: 0.40
            layer.enabled: true
            layer.effect: MultiEffect {
                blurEnabled: true
                blur: 1.0
                blurMax: 40
                brightness: 0.25
            }
            // subtle pulse so the agent cursor is easy to follow
            SequentialAnimation on scale {
                loops: Animation.Infinite
                NumberAnimation { from: 0.82; to: 1.18; duration: 900; easing.type: Easing.InOutSine }
                NumberAnimation { from: 1.18; to: 0.82; duration: 900; easing.type: Easing.InOutSine }
            }
            SequentialAnimation on opacity {
                loops: Animation.Infinite
                NumberAnimation { from: 0.30; to: 0.48; duration: 900; easing.type: Easing.InOutSine }
                NumberAnimation { from: 0.48; to: 0.30; duration: 900; easing.type: Easing.InOutSine }
            }
        }

        // the crisp Jarvis arrow sprite — clearly NOT the OS cursor: a cyan-filled
        // arrow with a bright hot edge, tip centered on the halo.
        Canvas {
            id: cursorArrow
            // place the arrow tip (its 0,0) at the halo center
            x: parent.width / 2
            y: parent.height / 2
            width: 26
            height: 30
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.beginPath()
                ctx.moveTo(0, 0)
                ctx.lineTo(0, 20)
                ctx.lineTo(5.5, 15)
                ctx.lineTo(9, 23)
                ctx.lineTo(13, 21)
                ctx.lineTo(9.5, 13.5)
                ctx.lineTo(17, 13)
                ctx.closePath()
                // cyan body
                ctx.fillStyle = Theme.accent
                ctx.fill()
                // bright hot edge so it pops on any wallpaper
                ctx.lineWidth = 1.4
                ctx.lineJoin = "round"
                ctx.strokeStyle = Theme.accentBright
                ctx.stroke()
            }
            // dark inner contour for contrast on light backgrounds
            layer.enabled: true
            layer.effect: MultiEffect {
                shadowEnabled: true
                shadowColor: Qt.rgba(0, 0, 0, 0.6)
                shadowBlur: 0.6
                shadowVerticalOffset: 1
                shadowHorizontalOffset: 1
            }
        }
    }

    // ======================================================================
    //  CLICK / DRAG RIPPLE  —  fired at the cursor on a click/drag action
    // ======================================================================
    Rectangle {
        id: clickRingRect
        width: 14; height: 14; radius: 7
        color: "transparent"
        border.width: 2
        border.color: overlay.lastAction === "drag" ? Theme.amber : Theme.accentBright
        x: overlay.px * overlay.width - width / 2
        y: overlay.py * overlay.height - height / 2
        visible: clickRing.running
        SequentialAnimation {
            id: clickRing
            ParallelAnimation {
                NumberAnimation { target: clickRingRect; property: "scale"; from: 0.5; to: 3.4; duration: 440; easing.type: Easing.OutCubic }
                NumberAnimation { target: clickRingRect; property: "opacity"; from: 0.9; to: 0.0; duration: 440; easing.type: Easing.OutCubic }
            }
        }
    }
}
