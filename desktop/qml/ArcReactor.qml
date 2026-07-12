import QtQuick
import QtQuick.Shapes
import QtQuick.Effects
import CindroSidebar

// ArcReactor — the brand centerpiece. Concentric rotating rings (opposite
// directions), a pulsing glowing core, faint radial glow. Scales with `size`.
// Used small in the TitleBar / NavRail and large in the Chat empty state.
Item {
    id: reactor
    property real size: 56
    property color tint: Theme.accent
    property bool spinning: true
    property bool thinking: false     // orbiting dots == "thinking"
    property real coreScale: 1.0

    implicitWidth: size
    implicitHeight: size
    width: size
    height: size

    // ---- faint radial glow halo (blurred circle via MultiEffect) -----------
    Item {
        id: glowSrc
        anchors.centerIn: parent
        width: reactor.size * 0.92
        height: width
        visible: false
        Rectangle {
            anchors.fill: parent
            radius: width / 2
            color: reactor.tint
        }
    }
    MultiEffect {
        anchors.centerIn: parent
        width: glowSrc.width * 1.9
        height: width
        source: glowSrc
        blurEnabled: true
        blur: 1.0
        blurMax: 48
        opacity: 0.30
        autoPaddingEnabled: true
    }

    // ---- OUTER ring (ticks) — slow CW --------------------------------------
    Item {
        id: outer
        anchors.fill: parent
        Canvas {
            id: outerCanvas
            anchors.fill: parent
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                var cx = width / 2, cy = height / 2
                var r = Math.min(width, height) / 2 - 1
                ctx.strokeStyle = Qt.rgba(reactor.tint.r, reactor.tint.g, reactor.tint.b, 0.55)
                ctx.lineWidth = Math.max(1, reactor.size * 0.018)
                // tick marks around the rim
                var ticks = 36
                for (var i = 0; i < ticks; i++) {
                    var a = (i / ticks) * Math.PI * 2
                    var long = (i % 3 === 0)
                    var r0 = r * (long ? 0.80 : 0.88)
                    ctx.beginPath()
                    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
                    ctx.lineTo(cx + Math.cos(a) * r * 0.96, cy + Math.sin(a) * r * 0.96)
                    ctx.stroke()
                }
                // thin outer rim arc gaps
                ctx.strokeStyle = Qt.rgba(reactor.tint.r, reactor.tint.g, reactor.tint.b, 0.85)
                ctx.lineWidth = Math.max(1, reactor.size * 0.022)
                ctx.beginPath(); ctx.arc(cx, cy, r, -0.35, 1.15); ctx.stroke()
                ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI - 0.35, Math.PI + 1.15); ctx.stroke()
            }
        }
        RotationAnimator on rotation {
            running: reactor.spinning && reactor.visible
            from: 0; to: 360
            duration: Theme.ringSlow
            loops: Animation.Infinite
        }
    }

    // ---- MIDDLE ring (segments) — fast CCW ---------------------------------
    Item {
        id: mid
        anchors.fill: parent
        Canvas {
            anchors.fill: parent
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                var cx = width / 2, cy = height / 2
                var r = Math.min(width, height) / 2 * 0.66
                ctx.strokeStyle = Qt.rgba(reactor.tint.r, reactor.tint.g, reactor.tint.b, 0.9)
                ctx.lineWidth = Math.max(1.4, reactor.size * 0.03)
                ctx.lineCap = "round"
                var segs = 6
                for (var i = 0; i < segs; i++) {
                    var a0 = (i / segs) * Math.PI * 2 + 0.18
                    var a1 = a0 + (Math.PI * 2 / segs) - 0.55
                    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke()
                }
            }
        }
        RotationAnimator on rotation {
            running: reactor.spinning && reactor.visible
            from: 360; to: 0
            duration: Theme.ringFast
            loops: Animation.Infinite
        }
    }

    // ---- INNER triangle frame (Stark reactor vibe) — slow CW ---------------
    Item {
        id: inner
        anchors.fill: parent
        opacity: 0.8
        Canvas {
            anchors.fill: parent
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                var cx = width / 2, cy = height / 2
                var r = Math.min(width, height) / 2 * 0.42
                ctx.strokeStyle = Qt.rgba(reactor.tint.r, reactor.tint.g, reactor.tint.b, 0.75)
                ctx.lineWidth = Math.max(1, reactor.size * 0.02)
                ctx.lineJoin = "round"
                ctx.beginPath()
                for (var i = 0; i < 3; i++) {
                    var a = (i / 3) * Math.PI * 2 - Math.PI / 2
                    var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
                }
                ctx.closePath(); ctx.stroke()
            }
        }
        RotationAnimator on rotation {
            running: reactor.spinning && reactor.visible
            from: 0; to: 360
            duration: Theme.ringSlow * 1.4
            loops: Animation.Infinite
        }
    }

    // ---- glowing pulsing CORE ----------------------------------------------
    Item {
        id: coreWrap
        anchors.centerIn: parent
        width: reactor.size * 0.3
        height: width
        Rectangle {
            id: core
            anchors.fill: parent
            radius: width / 2
            color: reactor.tint
            scale: reactor.coreScale
            layer.enabled: true
            layer.effect: MultiEffect {
                blurEnabled: true
                blur: 0.6
                blurMax: 24
                brightness: 0.25
            }
            SequentialAnimation on scale {
                running: reactor.visible
                loops: Animation.Infinite
                NumberAnimation { from: 0.82; to: 1.12; duration: Theme.pulse / 2; easing.type: Easing.InOutSine }
                NumberAnimation { from: 1.12; to: 0.82; duration: Theme.pulse / 2; easing.type: Easing.InOutSine }
            }
        }
        // bright hot center dot
        Rectangle {
            anchors.centerIn: parent
            width: parent.width * 0.5
            height: width
            radius: width / 2
            color: Theme.accentBright
        }
    }

    // ---- thinking: dots orbiting the reactor -------------------------------
    Item {
        id: orbit
        anchors.fill: parent
        visible: reactor.thinking
        Repeater {
            model: 3
            Rectangle {
                required property int index
                width: reactor.size * 0.07
                height: width
                radius: width / 2
                color: Theme.accentBright
                x: reactor.width / 2 - width / 2
                y: reactor.height / 2 - width / 2
                transform: [
                    Translate { y: -reactor.size * 0.52 },
                    Rotation {
                        origin.x: width / 2; origin.y: height / 2
                        angle: 0
                        RotationAnimation on angle {
                            running: reactor.thinking
                            loops: Animation.Infinite
                            from: index * 120; to: 360 + index * 120
                            duration: 1400
                        }
                    }
                ]
            }
        }
    }
}
