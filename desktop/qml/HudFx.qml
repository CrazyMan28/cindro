import QtQuick
import CindroSidebar

// HudFx — app-wide ambient HUD layer that sits BEHIND content:
//   * deep base gradient
//   * faint hex / circuit texture (~0.05 opacity)
//   * slowly drifting horizontal scanlines (~0.04 opacity)
//   * a couple of soft energy glow blooms in the corners
// Purely decorative; never interactive (no MouseArea).
Item {
    id: fx
    property bool dense: true        // hex texture on/off
    property color tint: Theme.accent

    // ---- base gradient ------------------------------------------------------
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.bgTop }
            GradientStop { position: 0.55; color: Theme.bgBottom }
            GradientStop { position: 1.0; color: Theme.bgDeep }
        }
    }

    // ---- corner energy blooms (radial-ish via large soft rects) ------------
    Canvas {
        anchors.fill: parent
        opacity: 0.5
        onPaint: {
            var ctx = getContext("2d"); ctx.reset()
            function bloom(x, y, r, c) {
                var g = ctx.createRadialGradient(x, y, 0, x, y, r)
                g.addColorStop(0, Qt.rgba(c.r, c.g, c.b, 0.16))
                g.addColorStop(1, Qt.rgba(c.r, c.g, c.b, 0.0))
                ctx.fillStyle = g
                ctx.fillRect(0, 0, width, height)
            }
            bloom(width * 0.92, height * 0.08, Math.max(width, height) * 0.5, fx.tint)
            bloom(width * 0.05, height * 0.96, Math.max(width, height) * 0.55, Theme.violet)
        }
        Component.onCompleted: requestPaint()
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
    }

    // ---- hex / circuit texture ---------------------------------------------
    Canvas {
        id: hex
        anchors.fill: parent
        visible: fx.dense
        opacity: 0.05
        onPaint: {
            var ctx = getContext("2d"); ctx.reset()
            ctx.strokeStyle = fx.tint
            ctx.lineWidth = 1
            var s = 34                      // hex radius
            var w = s * Math.sqrt(3)
            var h = s * 1.5
            for (var row = -1; row * h < height + s; row++) {
                for (var col = -1; col * w < width + w; col++) {
                    var cx = col * w + (row % 2 ? w / 2 : 0)
                    var cy = row * h
                    ctx.beginPath()
                    for (var i = 0; i < 6; i++) {
                        var a = Math.PI / 180 * (60 * i - 30)
                        var x = cx + s * Math.cos(a)
                        var y = cy + s * Math.sin(a)
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
                    }
                    ctx.closePath()
                    ctx.stroke()
                }
            }
        }
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        Component.onCompleted: requestPaint()
    }

    // ---- drifting scanlines -------------------------------------------------
    // Two stacked repeating-line tiles translated downward continuously; the
    // pattern wraps so the drift reads as a slow, endless scan.
    Item {
        anchors.fill: parent
        clip: true
        opacity: 0.045
        Column {
            id: scanCol
            width: parent.width
            // tile twice the parent height so the wrap is seamless
            property real tile: parent.height
            Repeater {
                model: 2
                Canvas {
                    width: scanCol.width
                    height: scanCol.tile
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.strokeStyle = "#FFFFFF"
                        ctx.lineWidth = 1
                        for (var y = 0; y < height; y += 3) {
                            ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); ctx.stroke()
                        }
                    }
                    onWidthChanged: requestPaint()
                    onHeightChanged: requestPaint()
                    Component.onCompleted: requestPaint()
                }
            }
            NumberAnimation on y {
                running: true
                loops: Animation.Infinite
                from: -scanCol.tile; to: 0
                duration: 9000
            }
        }
    }
}
