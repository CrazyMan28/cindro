import QtQuick
import QtQuick.Effects
import CindroSidebar

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

    // This overlay's monitor, in GLOBAL virtual-desktop pixels (set by Main.qml
    // from the screen model). Used to map the agent's global pointer into a local
    // position and to CULL events that belong to a different monitor.
    property real screenX: 0
    property real screenY: 0
    property real screenW: width
    property real screenH: height

    // Last agent pointer, normalized [0,1] -> pixel position on THIS surface.
    property real px: 0.5
    property real py: 0.5
    property string lastAction: "move"
    // Codex-style azure blue for the driving HUD (matches the GlowCursor).
    readonly property color driveBlue: "#3D8BFF"
    // The agent cursor is only drawn on the monitor the pointer is currently over
    // (multi-monitor: one overlay per output, but the cursor exists on one).
    property bool onThisScreen: false

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
        // GLOBAL desktop pixels: map into THIS monitor's local space and only show
        // the cursor here when the point actually falls on this output.
        function onAgentPointerGlobal(gx, gy, action, button) {
            var lx = gx - overlay.screenX
            var ly = gy - overlay.screenY
            var here = lx >= 0 && lx < overlay.screenW && ly >= 0 && ly < overlay.screenH
            overlay.onThisScreen = here
            if (!here)
                return
            overlay.px = overlay.screenW > 0 ? lx / overlay.screenW : 0.5
            overlay.py = overlay.screenH > 0 ? ly / overlay.screenH : 0.5
            overlay.lastAction = action
            if (action === "click" || action === "drag" || action === "down") {
                cursor.flash(action)
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
            border.color: overlay.driveBlue
            opacity: 0.55
            layer.enabled: true
            layer.effect: MultiEffect {
                blurEnabled: true
                blur: 1.0
                blurMax: 28
                brightness: 0.18
                colorization: 1.0
                colorizationColor: overlay.driveBlue
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
            border.color: overlay.driveBlue   // 1px azure-blue hairline (matches cursor)

            // The banner is the overlay's ONLY clickable region (C++ masks input to
            // this top band). Clicking it stops the take-over; it also takes
            // keyboard focus so Esc works right after.
            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { overlay.forceActiveFocus(); overlay.cancel() }
            }

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
                        ctx.fillStyle = overlay.driveBlue
                        ctx.beginPath()
                        ctx.moveTo(9, 1); ctx.lineTo(1.5, 11); ctx.lineTo(6, 11)
                        ctx.lineTo(5, 19); ctx.lineTo(12.5, 8); ctx.lineTo(8, 8)
                        ctx.closePath(); ctx.fill()
                    }
                }
                // primary label
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Cindro is using your computer"
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
                // dimmed cancel hint — the banner is the ONLY clickable part of the
                // overlay (rest is click-through); click it (or Esc once it's
                // focused) to stop the take-over.
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "click or Esc to stop"
                    color: Theme.textMuted
                    opacity: 0.85
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                    font.weight: Font.Normal
                }
            }
        }
    }

    // ======================================================================
    //  GLOWING AGENT CURSOR  —  big, unmistakable cyan pointer (shared component).
    //  Shown only on the monitor the agent pointer is currently over.
    // ======================================================================
    GlowCursor {
        id: cursor
        diameter: 44                       // compact: visible but not a screen-covering blob
        glow: overlay.driveBlue
        active: overlay.onThisScreen
        lastAction: overlay.lastAction
        // center the hotspot on the agent pointer
        x: overlay.px * overlay.width - width / 2
        y: overlay.py * overlay.height - height / 2
        // LERP toward each new agent position so the cursor glides, not jumps.
        Behavior on x { NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
        Behavior on y { NumberAnimation { duration: 110; easing.type: Easing.OutCubic } }
    }
}
