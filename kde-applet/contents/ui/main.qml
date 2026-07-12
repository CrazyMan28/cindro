/*
 * Cindro plasmoid — Plasma 6 / KF6
 *
 * Compact representation: a glowing cyan/blue "arc reactor" orb (QML Canvas).
 * Full representation: CINDRO popup with buttons that launch the desktop app.
 */
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts

import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import org.kde.plasma.plasma5support as P5Support
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root

    // ---- Jarvis HUD palette -------------------------------------------------
    readonly property color jarvisCyan: "#29E7FF"
    readonly property color jarvisBlue: "#3D8BFF"
    readonly property color jarvisDark: "#05121A"

    // Prefer showing the compact orb; the popup opens on click.
    preferredRepresentation: compactRepresentation

    toolTipMainText: "CINDRO"
    toolTipSubText: "Click to open Cindro controls"

    // ---- Command runner (Plasma 6 executable engine) ------------------------
    P5Support.DataSource {
        id: exec
        engine: "executable"
        connectedSources: []

        onNewData: function(sourceName, data) {
            // Always disconnect a one-shot command so it can be run again.
            exec.disconnectSource(sourceName)
        }
    }

    function run(cmd) {
        // Reconnect cleanly in case the same command is still pending.
        exec.disconnectSource(cmd)
        exec.connectSource(cmd)
    }

    // ========================================================================
    //  COMPACT REPRESENTATION — the arc-reactor orb
    // ========================================================================
    compactRepresentation: Item {
        id: compactRoot

        Layout.minimumWidth: Kirigami.Units.iconSizes.small
        Layout.minimumHeight: Kirigami.Units.iconSizes.small

        readonly property real pulse: pulseAnim.value

        // Subtle breathing pulse that drives the core brightness.
        QtObject {
            id: pulseAnim
            property real value: 0.0
        }
        NumberAnimation {
            target: pulseAnim
            property: "value"
            from: 0.0
            to: 1.0
            duration: 1800
            loops: Animation.Infinite
            easing.type: Easing.InOutSine
            running: true
        }

        Canvas {
            id: reactor
            anchors.fill: parent
            // Repaint whenever the pulse advances.
            property real p: compactRoot.pulse
            onPChanged: requestPaint()
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()

            onPaint: {
                var ctx = getContext("2d")
                ctx.reset()

                var w = width
                var h = height
                var cx = w / 2
                var cy = h / 2
                var r = Math.min(w, h) / 2 - 1
                if (r <= 0)
                    return

                // Pulse 0..1 -> eased brightness factor.
                var pulse = compactRoot.pulse
                var glow = 0.55 + 0.45 * pulse

                // --- Outer halo glow ---
                var halo = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r)
                halo.addColorStop(0.0, Qt.rgba(0.16, 0.55, 1.0, 0.35 * glow))
                halo.addColorStop(0.7, Qt.rgba(0.16, 0.90, 1.0, 0.12 * glow))
                halo.addColorStop(1.0, Qt.rgba(0.0, 0.0, 0.0, 0.0))
                ctx.fillStyle = halo
                ctx.beginPath()
                ctx.arc(cx, cy, r, 0, 2 * Math.PI)
                ctx.fill()

                // --- Dark base disc ---
                ctx.fillStyle = Qt.rgba(0.02, 0.07, 0.10, 0.92)
                ctx.beginPath()
                ctx.arc(cx, cy, r * 0.82, 0, 2 * Math.PI)
                ctx.fill()

                // --- Outer ring ---
                ctx.lineWidth = Math.max(1, r * 0.10)
                ctx.strokeStyle = Qt.rgba(0.24, 0.55, 1.0, 0.85)
                ctx.beginPath()
                ctx.arc(cx, cy, r * 0.80, 0, 2 * Math.PI)
                ctx.stroke()

                // --- Inner ring ---
                ctx.lineWidth = Math.max(1, r * 0.06)
                ctx.strokeStyle = Qt.rgba(0.16, 0.90, 1.0, 0.90 * glow)
                ctx.beginPath()
                ctx.arc(cx, cy, r * 0.55, 0, 2 * Math.PI)
                ctx.stroke()

                // --- Radial "coil" spokes ---
                ctx.lineWidth = Math.max(1, r * 0.05)
                ctx.strokeStyle = Qt.rgba(0.16, 0.90, 1.0, 0.55 * glow)
                var spokes = 8
                for (var i = 0; i < spokes; i++) {
                    var a = (i / spokes) * 2 * Math.PI
                    ctx.beginPath()
                    ctx.moveTo(cx + Math.cos(a) * r * 0.32, cy + Math.sin(a) * r * 0.32)
                    ctx.lineTo(cx + Math.cos(a) * r * 0.52, cy + Math.sin(a) * r * 0.52)
                    ctx.stroke()
                }

                // --- Bright pulsing core ---
                var core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.36)
                core.addColorStop(0.0, Qt.rgba(0.85, 1.0, 1.0, glow))
                core.addColorStop(0.4, Qt.rgba(0.16, 0.90, 1.0, glow))
                core.addColorStop(1.0, Qt.rgba(0.24, 0.55, 1.0, 0.0))
                ctx.fillStyle = core
                ctx.beginPath()
                ctx.arc(cx, cy, r * 0.36, 0, 2 * Math.PI)
                ctx.fill()
            }
        }

        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onClicked: root.expanded = !root.expanded
        }
    }

    // ========================================================================
    //  FULL REPRESENTATION — the CINDRO popup
    // ========================================================================
    fullRepresentation: Item {
        id: fullRoot

        Layout.minimumWidth: Kirigami.Units.gridUnit * 16
        Layout.minimumHeight: Kirigami.Units.gridUnit * 14
        Layout.preferredWidth: Kirigami.Units.gridUnit * 18
        Layout.preferredHeight: Kirigami.Units.gridUnit * 15

        // Dark HUD backdrop.
        Rectangle {
            anchors.fill: parent
            radius: Kirigami.Units.smallSpacing
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#06141C" }
                GradientStop { position: 1.0; color: "#02080C" }
            }
            border.color: Qt.rgba(0.16, 0.90, 1.0, 0.25)
            border.width: 1
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Kirigami.Units.largeSpacing
            spacing: Kirigami.Units.largeSpacing

            // --- Title ---
            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.largeSpacing

                // Mini arc-reactor accent next to the title.
                Rectangle {
                    Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                    Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                    radius: width / 2
                    color: "transparent"
                    border.color: root.jarvisCyan
                    border.width: 2
                    Rectangle {
                        anchors.centerIn: parent
                        width: parent.width * 0.45
                        height: width
                        radius: width / 2
                        color: root.jarvisCyan
                    }
                }

                PlasmaComponents.Label {
                    text: "CINDRO"
                    font.bold: true
                    font.pointSize: Math.round(Kirigami.Theme.defaultFont.pointSize * 1.6)
                    font.letterSpacing: 3
                    color: root.jarvisCyan
                    Layout.fillWidth: true
                }
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: Qt.rgba(0.16, 0.90, 1.0, 0.20)
            }

            // --- Buttons ---
            PlasmaComponents.Button {
                Layout.fillWidth: true
                icon.name: "sidebar-expand-left-symbolic"
                text: i18n("Open / Toggle Sidebar")
                onClicked: {
                    root.run("jarvis-sidebar")
                    root.expanded = false
                }
            }

            PlasmaComponents.Button {
                Layout.fillWidth: true
                icon.name: "audio-input-microphone-symbolic"
                text: i18n("Voice Mode")
                onClicked: {
                    root.run("jarvis-sidebar --voice")
                    root.expanded = false
                }
            }

            Item { Layout.fillHeight: true }

            // --- Status line ---
            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                Rectangle {
                    id: statusDot
                    Layout.preferredWidth: Math.round(Kirigami.Units.iconSizes.small * 0.6)
                    Layout.preferredHeight: Math.round(Kirigami.Units.iconSizes.small * 0.6)
                    radius: width / 2
                    color: "#2ECC71" // ready/green
                    // Soft glow ring.
                    Rectangle {
                        anchors.centerIn: parent
                        width: parent.width * 1.8
                        height: width
                        radius: width / 2
                        color: "transparent"
                        border.color: Qt.rgba(0.18, 0.80, 0.44, 0.45)
                        border.width: 1
                    }
                }

                PlasmaComponents.Label {
                    text: i18n("Cindro")
                    color: Kirigami.Theme.textColor
                    Layout.fillWidth: true
                }

                PlasmaComponents.Label {
                    text: i18n("ready")
                    color: "#2ECC71"
                    opacity: 0.85
                }
            }
        }
    }
}
