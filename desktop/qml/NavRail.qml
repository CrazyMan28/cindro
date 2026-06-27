import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// Vertical HUD nav rail: a small arc-reactor logo at the top, glowing line-icons
// with UPPERCASE tracked labels, an animated neon active-indicator bar that
// glides between items, and a faint vertical circuit line down the rail.
Item {
    id: rail
    implicitWidth: Theme.railWidth

    property int currentIndex: 0
    signal navigate(int index)

    // Grouped into sections so the rail reads as a hierarchy instead of a flat
    // 15-deep list. Chat=0 / Voice=1 stay put (Main.qml + voiceIndex depend on
    // them); the rest are clustered. Keep this order in lock-step with the page
    // switch in AppShell.qml.
    readonly property var items: [
        { key: "home",      label: "HOME",      section: "WORKSPACE" },
        { key: "chat",      label: "CHAT",      section: "WORKSPACE" },
        { key: "voice",     label: "VOICE",     section: "WORKSPACE" },
        { key: "computer",  label: "COMPUTER",  section: "WORKSPACE" },
        { key: "canvas",    label: "CANVAS",    section: "WORKSPACE" },
        { key: "widgets",   label: "WIDGETS",   section: "WORKSPACE" },
        { key: "sessions",  label: "SESSIONS",  section: "WORKSPACE" },
        { key: "memory",    label: "MEMORY",    section: "MIND" },
        { key: "skills",    label: "SKILLS",    section: "MIND" },
        { key: "schedules", label: "SCHEDULES", section: "MIND" },
        { key: "activity",  label: "ACTIVITY",  section: "MIND" },
        { key: "mcp",       label: "MCP",       section: "SYSTEM" },
        { key: "plugins",   label: "PLUGINS",   section: "SYSTEM" },
        { key: "ssh",       label: "SSH",       section: "SYSTEM" },
        { key: "settings",  label: "SETTINGS",  section: "SYSTEM" }
    ]

    // ---- rail background ----------------------------------------------------
    Rectangle {
        anchors.fill: parent
        color: Theme.railFill

        // right neon seam
        Rectangle {
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            gradient: Gradient {
                GradientStop { position: 0.0; color: Theme.accentDim }
                GradientStop { position: 0.5; color: Theme.violet }
                GradientStop { position: 1.0; color: Theme.accentDim }
            }
            opacity: 0.5
        }

        // faint vertical circuit line + nodes
        Canvas {
            anchors.fill: parent
            opacity: 0.18
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.strokeStyle = Theme.accent
                ctx.lineWidth = 1
                var x = 6
                ctx.beginPath(); ctx.moveTo(x, 90); ctx.lineTo(x, height - 20); ctx.stroke()
                // little nodes
                ctx.fillStyle = Theme.accent
                for (var y = 120; y < height - 40; y += 64) {
                    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill()
                    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 7, y); ctx.stroke()
                }
            }
            onHeightChanged: requestPaint()
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.topMargin: 16
        anchors.bottomMargin: 16
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        spacing: 12

        // ---- reactor logo + wordmark ---------------------------------------
        ColumnLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: 4
            ArcReactor {
                size: 40
                Layout.alignment: Qt.AlignHCenter
                tint: Theme.accent
            }
            Text {
                Layout.alignment: Qt.AlignHCenter
                text: "J.A.R.V.I.S"
                color: Theme.accent
                opacity: 0.8
                font.family: Theme.fontDisplay
                font.pixelSize: 10
                font.letterSpacing: 1.8
                font.weight: Font.DemiBold
            }
        }

        // divider
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 6
            Layout.rightMargin: 6
            height: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentDim }
                GradientStop { position: 1.0; color: "transparent" }
            }
        }

        // ---- nav items (grouped into sections) -----------------------------
        // Flickable so the grouped rail still fits on a short screen; the active
        // highlight lives on each row (no fragile index*height math), and a small
        // uppercase header introduces each section.
        Flickable {
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentHeight: navCol.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Column {
                id: navCol
                width: parent.width
                spacing: 3

                Repeater {
                    model: rail.items
                    delegate: Column {
                        id: navItem
                        required property int index
                        required property var modelData
                        width: navCol.width
                        spacing: 3

                        readonly property bool active: rail.currentIndex === index
                        readonly property bool firstInSection:
                            index === 0 ||
                            rail.items[index - 1].section !== modelData.section

                        // section header
                        Text {
                            visible: navItem.firstInSection
                            topPadding: navItem.index === 0 ? 0 : 9
                            leftPadding: 14
                            bottomPadding: 1
                            text: navItem.modelData.section
                            color: Theme.textFaint
                            font.family: Theme.fontDisplay
                            font.pixelSize: 8
                            font.letterSpacing: 2.0
                            font.weight: Font.DemiBold
                        }

                        // the nav row
                        Rectangle {
                            width: navCol.width
                            height: 40
                            radius: Theme.radiusSm
                            color: navItem.active ? Theme.navActive
                                   : (navMa.containsMouse ? Qt.rgba(1, 1, 1, 0.04) : "transparent")
                            border.color: navItem.active ? Theme.accentDim : "transparent"
                            border.width: 1
                            Behavior on color { ColorAnimation { duration: 120 } }

                            // active left indicator bar
                            Rectangle {
                                visible: navItem.active
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.leftMargin: 2
                                width: 3; height: 22; radius: 1.5
                                color: Theme.accent
                            }

                            Row {
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.left: parent.left
                                anchors.leftMargin: 16
                                spacing: 12

                                NavIcon {
                                    anchors.verticalCenter: parent.verticalCenter
                                    glyph: navItem.modelData.key
                                    glow: navItem.active
                                    color: navItem.active ? Theme.accent
                                           : (navMa.containsMouse ? Theme.text : Theme.textMuted)
                                }
                                Text {
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: navItem.modelData.label
                                    color: navItem.active ? Theme.accentBright
                                           : (navMa.containsMouse ? Theme.text : Theme.textMuted)
                                    font.family: Theme.fontDisplay
                                    font.pixelSize: 11
                                    font.weight: navItem.active ? Font.DemiBold : Font.Medium
                                    font.letterSpacing: Theme.trackMid
                                    Behavior on color { ColorAnimation { duration: 120 } }
                                }
                            }

                            MouseArea {
                                id: navMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: rail.navigate(navItem.index)
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- hand-drawn 18x18 line icons (Canvas), optional glow ---------------
    component NavIcon: Item {
        id: ic
        property string glyph: "chat"
        property color color: Theme.textMuted
        property bool glow: false
        width: 18; height: 18

        Canvas {
            id: cv
            anchors.fill: parent
            layer.enabled: ic.glow
            layer.effect: MultiEffect {
                blurEnabled: true
                blur: 0.5
                blurMax: 12
                brightness: 0.15
            }
            onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                ctx.strokeStyle = ic.color
                ctx.fillStyle = ic.color
                ctx.lineWidth = 1.5
                ctx.lineCap = "round"; ctx.lineJoin = "round"
                var w = width, h = height
                switch (ic.glyph) {
                case "home":
                    // a house
                    ctx.beginPath()
                    ctx.moveTo(3, 9); ctx.lineTo(9, 3.5); ctx.lineTo(15, 9); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(4.5, 8); ctx.lineTo(4.5, 15); ctx.lineTo(13.5, 15); ctx.lineTo(13.5, 8); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(7.5, 15); ctx.lineTo(7.5, 11); ctx.lineTo(10.5, 11); ctx.lineTo(10.5, 15); ctx.stroke()
                    break
                case "chat":
                    ctx.beginPath()
                    ctx.moveTo(2, 4); ctx.lineTo(16, 4); ctx.lineTo(16, 12); ctx.lineTo(7, 12)
                    ctx.lineTo(4, 16); ctx.lineTo(4, 12); ctx.lineTo(2, 12); ctx.closePath(); ctx.stroke()
                    break
                case "computer":
                    // monitor with a base + a small agent cursor in the corner
                    ctx.strokeRect(2, 3, 14, 9)
                    ctx.beginPath()
                    ctx.moveTo(7, 12); ctx.lineTo(6.5, 15.5)
                    ctx.lineTo(11.5, 15.5); ctx.lineTo(11, 12); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(5, 15.5); ctx.lineTo(13, 15.5); ctx.stroke()
                    // cursor arrow inside the screen
                    ctx.beginPath()
                    ctx.moveTo(10, 5.5); ctx.lineTo(13.5, 8.5); ctx.lineTo(11.6, 8.7)
                    ctx.lineTo(12.7, 10.6); ctx.lineTo(11.6, 11.1); ctx.lineTo(10.6, 9.1)
                    ctx.lineTo(9.2, 10.2); ctx.closePath(); ctx.stroke()
                    break
                case "voice":
                    // microphone: capsule + stand + base, with a small sound arc
                    ctx.beginPath()
                    ctx.moveTo(6.5, 3.5)
                    ctx.arc(9, 3.5, 2.5, Math.PI, 0)
                    ctx.lineTo(11.5, 8)
                    ctx.arc(9, 8, 2.5, 0, Math.PI)
                    ctx.closePath(); ctx.stroke()
                    // cradle + stand
                    ctx.beginPath()
                    ctx.arc(9, 8.5, 4.5, 0.15 * Math.PI, 0.85 * Math.PI)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(9, 13); ctx.lineTo(9, 15.5)
                    ctx.moveTo(6, 15.5); ctx.lineTo(12, 15.5)
                    ctx.stroke()
                    break
                case "canvas":
                    // a framed canvas with a generative spark inside
                    ctx.strokeRect(2.5, 3, 13, 12)
                    // sparkle
                    ctx.beginPath()
                    ctx.moveTo(9, 6); ctx.lineTo(9, 12)
                    ctx.moveTo(6, 9); ctx.lineTo(12, 9)
                    ctx.moveTo(6.8, 6.8); ctx.lineTo(11.2, 11.2)
                    ctx.moveTo(11.2, 6.8); ctx.lineTo(6.8, 11.2)
                    ctx.stroke()
                    break
                case "memory":
                    // a brain/recall node: a chip outline with a pulse core + leads
                    ctx.strokeRect(4, 4, 10, 10)
                    ctx.beginPath(); ctx.arc(9, 9, 2, 0, Math.PI*2); ctx.stroke()
                    // pins
                    ctx.beginPath()
                    ctx.moveTo(7, 4); ctx.lineTo(7, 1.5)
                    ctx.moveTo(11, 4); ctx.lineTo(11, 1.5)
                    ctx.moveTo(7, 14); ctx.lineTo(7, 16.5)
                    ctx.moveTo(11, 14); ctx.lineTo(11, 16.5)
                    ctx.moveTo(4, 7); ctx.lineTo(1.5, 7)
                    ctx.moveTo(4, 11); ctx.lineTo(1.5, 11)
                    ctx.moveTo(14, 7); ctx.lineTo(16.5, 7)
                    ctx.moveTo(14, 11); ctx.lineTo(16.5, 11)
                    ctx.stroke()
                    break
                case "skills":
                    // a lightning spark glyph
                    ctx.beginPath()
                    ctx.moveTo(10, 1.5); ctx.lineTo(4, 9.5); ctx.lineTo(8.5, 9.5)
                    ctx.lineTo(7.5, 16.5); ctx.lineTo(14, 8); ctx.lineTo(9.5, 8)
                    ctx.closePath(); ctx.stroke()
                    break
                case "browser":
                    // globe: circle + meridian curves + latitude lines
                    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(9, 2); ctx.quadraticCurveTo(3, 9, 9, 16); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(9, 2); ctx.quadraticCurveTo(15, 9, 9, 16); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(2, 9); ctx.lineTo(16, 9)
                    ctx.moveTo(3.2, 5.5); ctx.lineTo(14.8, 5.5)
                    ctx.moveTo(3.2, 12.5); ctx.lineTo(14.8, 12.5); ctx.stroke()
                    break
                case "schedules":
                    // clock face with hands
                    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(9, 9); ctx.lineTo(9, 4.5)
                    ctx.moveTo(9, 9); ctx.lineTo(12.5, 10.5); ctx.stroke()
                    break
                case "activity":
                    // pulse / ECG line
                    ctx.beginPath()
                    ctx.moveTo(1.5, 9); ctx.lineTo(5, 9); ctx.lineTo(7, 3.5)
                    ctx.lineTo(10, 14.5); ctx.lineTo(12, 9); ctx.lineTo(16.5, 9)
                    ctx.stroke()
                    break
                case "ssh":
                    // terminal: window with a prompt chevron + cursor
                    ctx.strokeRect(2, 3, 14, 12)
                    ctx.beginPath()
                    ctx.moveTo(5, 7.5); ctx.lineTo(7.5, 9.5); ctx.lineTo(5, 11.5); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(9, 11.5); ctx.lineTo(12.5, 11.5); ctx.stroke()
                    break
                case "sessions":
                    ctx.strokeRect(2.5, 2.5, 13, 3.5)
                    ctx.strokeRect(2.5, 7.5, 13, 3.5)
                    ctx.strokeRect(2.5, 12.5, 13, 3.5)
                    break
                case "settings":
                    ctx.beginPath(); ctx.arc(w/2, h/2, 3.2, 0, Math.PI*2); ctx.stroke()
                    for (var i = 0; i < 6; i++) {
                        var a = i * Math.PI / 3
                        ctx.beginPath()
                        ctx.moveTo(w/2 + Math.cos(a)*5, h/2 + Math.sin(a)*5)
                        ctx.lineTo(w/2 + Math.cos(a)*7.5, h/2 + Math.sin(a)*7.5)
                        ctx.stroke()
                    }
                    break
                case "mcp":
                    ctx.beginPath(); ctx.arc(w/2, 4, 2, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath(); ctx.arc(4, 14, 2, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath(); ctx.arc(14, 14, 2, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(w/2, 6); ctx.lineTo(5, 12.5)
                    ctx.moveTo(w/2, 6); ctx.lineTo(13, 12.5)
                    ctx.moveTo(6, 14); ctx.lineTo(12, 14); ctx.stroke()
                    break
                case "plugins":
                    ctx.beginPath()
                    ctx.moveTo(3, 5); ctx.lineTo(7, 5); ctx.lineTo(7, 3.5)
                    ctx.lineTo(11, 3.5); ctx.lineTo(11, 5); ctx.lineTo(15, 5)
                    ctx.lineTo(15, 15); ctx.lineTo(3, 15); ctx.closePath(); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(7, 9.5); ctx.lineTo(11, 9.5); ctx.stroke()
                    break
                case "widgets":
                    // 2x2 grid of rounded blocks — reusable widget tiles
                    ctx.strokeRect(2.5, 2.5, 5.5, 5.5)
                    ctx.strokeRect(10, 2.5, 5.5, 5.5)
                    ctx.strokeRect(2.5, 10, 5.5, 5.5)
                    ctx.strokeRect(10, 10, 5.5, 5.5)
                    break
                }
            }
            Connections {
                target: ic
                function onColorChanged() { cv.requestPaint() }
            }
        }
    }
}
