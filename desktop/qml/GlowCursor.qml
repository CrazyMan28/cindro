import QtQuick
import QtQuick.Effects
import JarvisSidebar

// GlowCursor — a big, unmistakable cyan glowing pointer used wherever Jarvis is
// driving: the real-screen take-over overlay, the nested agent-desktop video on
// the Computer page, etc. It is purely visual (no input). Position it by setting
// x/y to the desired HOTSPOT (the arrow tip); the halo centers on that point.
//
//   GlowCursor { x: tipX; y: tipY; active: bridge.driving }
//
// `pulse` drives the breathing halo. Call clickRing.restart() (exposed via
// flash()) to fire the click ripple.
Item {
    id: root
    // Bigger than the OS cursor on purpose — the user must SEE Jarvis acting.
    property real diameter: 84
    property bool active: true
    property string lastAction: "move"
    // Codex-style soft AZURE-BLUE glow (not the HUD cyan) — this is the "Jarvis is
    // driving" cursor the user asked to match. glow = halo, core = bright center.
    property color glow: "#3D8BFF"
    property color core: "#AFD2FF"
    width: diameter
    height: diameter
    visible: active
    // The arrow TIP sits at the item's center, so callers place center = hotspot.
    transformOrigin: Item.Center

    function flash(action) {
        root.lastAction = action || "click"
        clickRing.restart()
    }

    // soft cyan radial GLOW halo, pulsing
    Rectangle {
        id: halo
        anchors.centerIn: parent
        width: root.diameter * 0.78
        height: width
        radius: width / 2
        color: root.glow
        opacity: 0.6
        layer.enabled: true
        layer.effect: MultiEffect {
            blurEnabled: true
            blur: 1.0
            blurMax: 64
            brightness: 0.4
        }
        SequentialAnimation on scale {
            running: root.active
            loops: Animation.Infinite
            NumberAnimation { from: 0.82; to: 1.2; duration: 900; easing.type: Easing.InOutSine }
            NumberAnimation { from: 1.2; to: 0.82; duration: 900; easing.type: Easing.InOutSine }
        }
    }

    // bright inner core dot so the hotspot is obvious even on busy backgrounds
    Rectangle {
        anchors.centerIn: parent
        width: root.diameter * 0.13
        height: width
        radius: width / 2
        color: root.core
        opacity: 0.9
    }

    // the crisp Jarvis arrow — clearly NOT the OS cursor; tip at the halo center
    Canvas {
        id: arrow
        x: parent.width / 2
        y: parent.height / 2
        width: root.diameter * 0.5
        height: root.diameter * 0.56
        onPaint: {
            var s = width / 26
            var ctx = getContext("2d"); ctx.reset()
            ctx.scale(s, s)
            ctx.beginPath()
            ctx.moveTo(0, 0); ctx.lineTo(0, 20); ctx.lineTo(5.5, 15)
            ctx.lineTo(9, 23); ctx.lineTo(13, 21); ctx.lineTo(9.5, 13.5)
            ctx.lineTo(17, 13); ctx.closePath()
            ctx.fillStyle = root.glow
            ctx.fill()
            ctx.lineWidth = 1.4
            ctx.lineJoin = "round"
            ctx.strokeStyle = root.core
            ctx.stroke()
        }
        layer.enabled: true
        layer.effect: MultiEffect {
            shadowEnabled: true
            shadowColor: Qt.rgba(0, 0, 0, 0.6)
            shadowBlur: 0.7
            shadowVerticalOffset: 1
            shadowHorizontalOffset: 1
        }
    }

    // click / drag ripple
    Rectangle {
        id: clickRingRect
        anchors.centerIn: parent
        width: root.diameter * 0.24; height: width; radius: width / 2
        color: "transparent"
        border.width: 2
        border.color: root.lastAction === "drag" ? Theme.amber : root.core
        visible: clickRing.running
        SequentialAnimation {
            id: clickRing
            ParallelAnimation {
                NumberAnimation { target: clickRingRect; property: "scale"; from: 0.5; to: 3.6; duration: 460; easing.type: Easing.OutCubic }
                NumberAnimation { target: clickRingRect; property: "opacity"; from: 0.9; to: 0.0; duration: 460; easing.type: Easing.OutCubic }
            }
        }
    }
}
