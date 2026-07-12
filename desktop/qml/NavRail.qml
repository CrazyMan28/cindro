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

    // Bound by AppShell: true while a live agent desktop exists or the Computer
    // page is the current page. Gates the COMPUTER item so it's discoverable the
    // moment it has content, and NEVER a hidden page the user can be teleported
    // to (the chat peek's "⛶ Full" used to land on a rail with no visible/active
    // item — an "invisible" place).
    property bool computerAvailable: false

    // Grouped into sections so the rail reads as a hierarchy instead of a flat
    // 15-deep list. Chat=0 / Voice=1 stay put (Main.qml + voiceIndex depend on
    // them); the rest are clustered. Keep this order in lock-step with the page
    // switch in AppShell.qml.
    readonly property var items: [
        { key: "home",      label: "HOME",      section: "WORKSPACE" },
        { key: "chat",      label: "CHAT",      section: "WORKSPACE" },
        { key: "voice",     label: "VOICE",     section: "WORKSPACE" },
        // Computer appears when there's a live agent desktop to show (or the user
        // is already on the page) — see `computerAvailable` + the delegate.
        { key: "computer",  label: "COMPUTER",  section: "WORKSPACE", gated: "computer" },
        // Live preview + control of the agent's co-worker browser tab. Placed next
        // to COMPUTER since both surface the same live agent desktop/session.
        { key: "browser",   label: "BROWSER",   section: "WORKSPACE" },
        { key: "canvas",    label: "CANVAS",    section: "WORKSPACE" },
        { key: "widgets",   label: "WIDGETS",   section: "WORKSPACE" },
        { key: "sessions",  label: "SESSIONS",  section: "WORKSPACE" },
        { key: "memory",    label: "MEMORY",    section: "MIND" },
        { key: "skills",    label: "SKILLS",    section: "MIND" },
        { key: "agents",    label: "AGENTS",    section: "MIND" },
        { key: "schedules", label: "SCHEDULES", section: "MIND" },
        { key: "activity",  label: "ACTIVITY",  section: "MIND" },
        { key: "memgraph",  label: "GRAPH",     section: "MIND" },
        { key: "replay",    label: "REPLAY",    section: "MIND" },
        { key: "mcp",       label: "MCP",       section: "SYSTEM" },
        { key: "plugins",   label: "PLUGINS",   section: "SYSTEM" },
        { key: "outpost",   label: "OUTPOST",   section: "SYSTEM" },
        { key: "phone",     label: "PHONE",     section: "SYSTEM" },
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
        anchors.bottomMargin: 14
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        spacing: 10

        // ---- reactor logo + wordmark (HORIZONTAL, like the mockup) ---------
        RowLayout {
            Layout.fillWidth: true
            Layout.leftMargin: 4
            spacing: 9
            ArcReactor {
                size: 30
                Layout.alignment: Qt.AlignVCenter
                tint: Theme.accent
            }
            Text {
                Layout.alignment: Qt.AlignVCenter
                Layout.fillWidth: true
                text: "CINDRO"
                color: Theme.text
                font.family: Theme.fontDisplay
                font.pixelSize: 12
                font.letterSpacing: 2.0
                font.weight: Font.Bold
            }
        }

        // divider
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 4
            Layout.rightMargin: 4
            Layout.topMargin: 2
            height: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentDim }
                GradientStop { position: 1.0; color: "transparent" }
            }
        }

        // ---- nav items: a ListView gives a smooth GLIDING active highlight
        // that animates between rows, plus grouped section headers. Settings is
        // pinned at the bottom (mockup), so the list is everything-but-settings.
        ListView {
            id: navList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            interactive: contentHeight > height
            boundsBehavior: Flickable.StopAtBounds
            spacing: 3
            // all items except the trailing "settings" (index 14), which is pinned
            model: rail.items.slice(0, rail.items.length - 1)
            currentIndex: rail.currentIndex < model.length ? rail.currentIndex : -1
            highlightMoveDuration: 220
            highlightResizeDuration: 0
            highlightFollowsCurrentItem: true
            preferredHighlightBegin: 0
            preferredHighlightEnd: height
            highlightRangeMode: ListView.NoHighlightRange

            // the gliding neon pill
            highlight: Item {
                z: 2
                Rectangle {
                    anchors.fill: parent
                    anchors.rightMargin: 1
                    radius: Theme.radiusSm
                    color: Theme.navActive
                    border.color: Theme.accentDim
                    border.width: 1
                    Rectangle {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.leftMargin: 2
                        width: 3; height: 22; radius: 1.5
                        color: Theme.accent
                        layer.enabled: true
                        layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 10 }
                    }
                }
            }

            section.property: "section"
            section.criteria: ViewSection.FullString
            section.delegate: Text {
                required property string section
                width: navList.width
                topPadding: 9; bottomPadding: 2; leftPadding: 14
                text: section
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 8
                font.letterSpacing: 2.0
                font.weight: Font.DemiBold
            }

            delegate: Item {
                id: navItem
                required property int index
                required property var modelData
                readonly property bool hidden: modelData.gated === "computer" ? !rail.computerAvailable
                                             : modelData.hidden === true
                width: navList.width
                height: hidden ? 0 : 40
                visible: !hidden
                enabled: !hidden
                Behavior on height { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
                readonly property bool active: rail.currentIndex === index

                // entrance: stagger each row in from the left on first paint
                opacity: 0
                Component.onCompleted: navEntrance.start()
                SequentialAnimation {
                    id: navEntrance
                    PauseAnimation { duration: navItem.index * 26 }
                    ParallelAnimation {
                        NumberAnimation { target: navItem; property: "opacity"; from: 0; to: 1; duration: 240; easing.type: Easing.OutCubic }
                        NumberAnimation { target: rowInner; property: "x"; from: -12; to: 16; duration: 300; easing.type: Easing.OutCubic }
                    }
                }

                // hover wash (active rows are covered by the gliding highlight)
                Rectangle {
                    anchors.fill: parent
                    radius: Theme.radiusSm
                    color: Qt.rgba(1, 1, 1, 0.045)
                    opacity: (navMa.containsMouse && !navItem.active) ? 1 : 0
                    Behavior on opacity { NumberAnimation { duration: 120 } }
                }

                Row {
                    id: rowInner
                    anchors.verticalCenter: parent.verticalCenter
                    x: 16
                    spacing: 12
                    // a touch of travel on hover for life
                    Behavior on x { NumberAnimation { duration: 130; easing.type: Easing.OutCubic } }

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
                    onContainsMouseChanged: rowInner.x = containsMouse ? 19 : 16
                }
            }
        }

        // ---- Settings, pinned at the bottom (mockup) -----------------------
        Rectangle {
            Layout.fillWidth: true
            height: 40
            radius: Theme.radiusSm
            readonly property bool active: rail.currentIndex === rail.items.length - 1
            color: active ? Theme.navActive : (setMa.containsMouse ? Qt.rgba(1,1,1,0.045) : "transparent")
            border.color: active ? Theme.accentDim : "transparent"
            border.width: 1
            Behavior on color { ColorAnimation { duration: 120 } }
            Rectangle {
                visible: parent.active
                anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 2; width: 3; height: 22; radius: 1.5; color: Theme.accent
            }
            Row {
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left; anchors.leftMargin: 16
                spacing: 12
                NavIcon {
                    anchors.verticalCenter: parent.verticalCenter
                    glyph: "settings"; glow: parent.parent.active
                    color: parent.parent.active ? Theme.accent : (setMa.containsMouse ? Theme.text : Theme.textMuted)
                }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "SETTINGS"
                    color: parent.parent.active ? Theme.accentBright : (setMa.containsMouse ? Theme.text : Theme.textMuted)
                    font.family: Theme.fontDisplay; font.pixelSize: 11
                    font.weight: parent.parent.active ? Font.DemiBold : Font.Medium
                    font.letterSpacing: Theme.trackMid
                    Behavior on color { ColorAnimation { duration: 120 } }
                }
            }
            MouseArea {
                id: setMa
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: rail.navigate(rail.items.length - 1)
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
                case "agents":
                    // a head/bot with a spark: a circle (head) + shoulders + antenna
                    ctx.beginPath(); ctx.arc(9, 7, 3.4, 0, Math.PI * 2); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(3.5, 16); ctx.quadraticCurveTo(9, 10, 14.5, 16); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(9, 3.6); ctx.lineTo(9, 1.5); ctx.stroke()
                    ctx.beginPath(); ctx.arc(9, 1.2, 0.9, 0, Math.PI * 2); ctx.fill()
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
                case "memgraph":
                    // three linked nodes: the knowledge-graph glyph
                    ctx.beginPath()
                    ctx.moveTo(9, 4); ctx.lineTo(4, 13.5)
                    ctx.moveTo(9, 4); ctx.lineTo(14, 13.5)
                    ctx.moveTo(4, 13.5); ctx.lineTo(14, 13.5)
                    ctx.stroke()
                    ctx.beginPath(); ctx.arc(9, 4, 2, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath(); ctx.arc(4, 13.5, 2, 0, Math.PI*2); ctx.stroke()
                    ctx.beginPath(); ctx.arc(14, 13.5, 2, 0, Math.PI*2); ctx.stroke()
                    break
                case "outpost":
                    // mast + base
                    ctx.beginPath(); ctx.moveTo(9, 6); ctx.lineTo(9, 15.5); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(6, 15.5); ctx.lineTo(12, 15.5); ctx.stroke()
                    // beacon node
                    ctx.beginPath(); ctx.arc(9, 5, 1.6, 0, Math.PI*2); ctx.stroke()
                    // signal arcs
                    ctx.beginPath(); ctx.arc(9, 5, 3.8, Math.PI*1.15, Math.PI*1.85); ctx.stroke()
                    ctx.beginPath(); ctx.arc(9, 5, 6.2, Math.PI*1.15, Math.PI*1.85); ctx.stroke()
                    break
                case "sessions":
                    ctx.strokeRect(2.5, 2.5, 13, 3.5)
                    ctx.strokeRect(2.5, 7.5, 13, 3.5)
                    ctx.strokeRect(2.5, 12.5, 13, 3.5)
                    break
                case "replay":
                    // play triangle inside a circle (scrub/replay)
                    ctx.beginPath(); ctx.arc(9, 9, 7, 0, Math.PI * 2); ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(7, 5.5); ctx.lineTo(13, 9); ctx.lineTo(7, 12.5)
                    ctx.closePath(); ctx.stroke()
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
                case "phone":
                    // classic handset: earpiece arc (top-left) + mouthpiece arc (bottom-right)
                    // connected by a diagonal handle
                    ctx.beginPath()
                    ctx.arc(5, 5, 2.5, Math.PI * 0.55, Math.PI * 1.45)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.arc(13, 13, 2.5, Math.PI * 1.55, Math.PI * 0.45)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(3.3, 7.0)
                    ctx.lineTo(11.0, 14.7)
                    ctx.stroke()
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
