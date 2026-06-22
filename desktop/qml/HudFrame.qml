import QtQuick
import JarvisSidebar

// HudFrame — a reusable framed panel surface with:
//   * glassy translucent fill + hairline border
//   * HUD corner brackets ([  ]) at all four corners
//   * an optional animated gradient-sweep border when `active`
// Content goes inside via the default property (children land in `body`).
Item {
    id: frame
    property color fill: Theme.panel
    property color stroke: Theme.hairline
    property color bracket: Theme.accent
    property bool active: false
    property bool sweep: false          // animated sweep along the top edge
    property int radius: Theme.radius
    property real bracketLen: 14
    default property alias content: body.data

    // ---- fill + border ------------------------------------------------------
    Rectangle {
        id: bg
        anchors.fill: parent
        radius: frame.radius
        color: frame.fill
        border.width: 1
        border.color: frame.active ? Theme.accentDim : frame.stroke
        Behavior on border.color { ColorAnimation { duration: Theme.durMid } }

        // top inner sheen — lit-from-above feel
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
            anchors.topMargin: 1; anchors.leftMargin: frame.radius; anchors.rightMargin: frame.radius
            height: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentDim }
                GradientStop { position: 1.0; color: "transparent" }
            }
        }
    }

    // ---- animated gradient sweep along the top border (active panel) -------
    Item {
        anchors.fill: parent
        clip: true
        visible: frame.sweep
        Rectangle {
            id: sweepBar
            width: parent.width * 0.4
            height: 2
            y: 0
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentBright }
                GradientStop { position: 1.0; color: "transparent" }
            }
            NumberAnimation on x {
                running: frame.sweep
                loops: Animation.Infinite
                from: -sweepBar.width; to: frame.width
                duration: 2600
            }
        }
    }

    // ---- corner brackets ----------------------------------------------------
    Repeater {
        model: 4
        Canvas {
            required property int index
            width: frame.bracketLen + 4
            height: frame.bracketLen + 4
            // 0 TL, 1 TR, 2 BR, 3 BL
            anchors.left: (index === 0 || index === 3) ? parent.left : undefined
            anchors.right: (index === 1 || index === 2) ? parent.right : undefined
            anchors.top: (index === 0 || index === 1) ? parent.top : undefined
            anchors.bottom: (index === 2 || index === 3) ? parent.bottom : undefined
            anchors.margins: 3
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.strokeStyle = Qt.rgba(frame.bracket.r, frame.bracket.g, frame.bracket.b,
                                          frame.active ? 0.95 : 0.55)
                ctx.lineWidth = 1.5
                ctx.lineCap = "round"
                var L = frame.bracketLen
                ctx.beginPath()
                switch (index) {
                case 0: ctx.moveTo(0, L); ctx.lineTo(0, 0); ctx.lineTo(L, 0); break
                case 1: ctx.moveTo(width - L, 0); ctx.lineTo(width, 0); ctx.lineTo(width, L); break
                case 2: ctx.moveTo(width, height - L); ctx.lineTo(width, height); ctx.lineTo(width - L, height); break
                case 3: ctx.moveTo(L, height); ctx.lineTo(0, height); ctx.lineTo(0, height - L); break
                }
                ctx.stroke()
            }
            Connections {
                target: frame
                function onActiveChanged() { requestPaint() }
            }
        }
    }

    // ---- content host -------------------------------------------------------
    Item {
        id: body
        anchors.fill: parent
    }
}
