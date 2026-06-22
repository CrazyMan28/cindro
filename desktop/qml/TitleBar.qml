import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// Custom titlebar that works on KWin. The drag region calls
// Window.startSystemMove() on press; the buttons drive the owning Window and the
// WindowController (dock/undock/hide). Designed to read as part of the HUD, not
// as OS chrome.
Item {
    id: bar
    implicitHeight: 46

    // The Window this bar lives in (for startSystemMove / showMinimized / close).
    required property Window win
    // true when this bar belongs to the docked (layer-shell) surface.
    property bool dockedSurface: false

    signal requestClose()

    // Neon energy hairline under the bar.
    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: 1
        gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0.0; color: Theme.accentDim }
            GradientStop { position: 0.5; color: Theme.accent }
            GradientStop { position: 1.0; color: Theme.violet }
        }
        opacity: 0.5
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 16
        anchors.rightMargin: 10
        spacing: 10

        // ---- Reactor mark + wordmark (also the drag handle) -----------------
        MouseArea {
            id: dragArea
            Layout.fillWidth: true
            Layout.fillHeight: true
            cursorShape: Qt.SizeAllCursor
            // System move only for floating windows; layer surfaces aren't moved.
            enabled: !bar.dockedSurface
            onPressed: if (!bar.dockedSurface) bar.win.startSystemMove()

            RowLayout {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                spacing: 11

                // arc-reactor brand mark (small, live)
                ArcReactor {
                    size: 26
                    Layout.alignment: Qt.AlignVCenter
                    tint: bridge.connected ? Theme.accent : Theme.textFaint
                }

                RowLayout {
                    spacing: 8
                    Text {
                        text: "JARVIS"
                        color: Theme.text
                        font.family: Theme.fontDisplay
                        font.pixelSize: 16
                        font.weight: Font.DemiBold
                        font.letterSpacing: 5
                    }
                    Text {
                        text: "// HUD"
                        color: Theme.accent
                        opacity: 0.6
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                        font.letterSpacing: 1.5
                        Layout.alignment: Qt.AlignVCenter
                    }
                    // connection status dot
                    Rectangle {
                        Layout.alignment: Qt.AlignVCenter
                        width: 7; height: 7; radius: 3.5
                        color: bridge.connected ? Theme.success : Theme.textFaint
                        opacity: bridge.connected ? 1.0 : 0.7
                        SequentialAnimation on opacity {
                            running: bridge.connected
                            loops: Animation.Infinite
                            NumberAnimation { from: 1.0; to: 0.4; duration: 1100; easing.type: Easing.InOutSine }
                            NumberAnimation { from: 0.4; to: 1.0; duration: 1100; easing.type: Easing.InOutSine }
                        }
                    }
                }
            }
        }

        // ---- Window controls -------------------------------------------------
        // Dock / Undock toggle
        TitleButton {
            id: dockBtn
            glyphType: bar.dockedSurface ? "undock" : "dock"
            tip: bar.dockedSurface ? "Undock" : "Dock to edge"
            onClicked: bar.dockedSurface ? WindowController.undock()
                                         : WindowController.dock()
        }

        // Hide (only meaningful while docked — releases the exclusive zone)
        TitleButton {
            visible: bar.dockedSurface
            glyphType: "hide"
            tip: "Hide sidebar"
            onClicked: WindowController.hideDock()
        }

        // Minimize (floating window only)
        TitleButton {
            visible: !bar.dockedSurface
            glyphType: "min"
            tip: "Minimize"
            onClicked: bar.win.showMinimized()
        }

        // Close
        TitleButton {
            glyphType: "close"
            danger: true
            tip: "Close"
            onClicked: bar.requestClose()
        }
    }

    // ---- inline helpers -----------------------------------------------------
    component Glow: Rectangle {
        property Item source
        anchors.centerIn: source
        width: source ? source.width + 10 : 0
        height: source ? source.height + 10 : 0
        radius: width / 2
        color: "transparent"
        border.color: Theme.accentGlow
        border.width: 2
        opacity: 0.5
        z: -1
    }

    component TitleButton: Item {
        id: tb
        property string glyphType: "close"
        property string tip: ""
        property bool danger: false
        signal clicked()
        Layout.alignment: Qt.AlignVCenter
        implicitWidth: 30
        implicitHeight: 30

        Rectangle {
            id: tbBg
            anchors.fill: parent
            radius: Theme.radiusXs
            color: ma.containsMouse
                   ? (tb.danger ? Qt.rgba(1, 0.42, 0.42, 0.16) : Theme.surfaceStrong)
                   : "transparent"
            border.width: 1
            border.color: ma.containsMouse
                          ? (tb.danger ? Qt.rgba(1, 0.42, 0.42, 0.35) : Theme.hairline)
                          : "transparent"
            Behavior on color { ColorAnimation { duration: 110 } }

            // glyphs drawn with Canvas so they look crisp & custom (no OS look)
            Canvas {
                id: cv
                anchors.centerIn: parent
                width: 14; height: 14
                property color stroke: tb.danger && ma.containsMouse ? Theme.danger
                                       : (ma.containsMouse ? Theme.text : Theme.textMuted)
                onStrokeChanged: requestPaint()
                onPaint: {
                    var ctx = getContext("2d")
                    ctx.reset()
                    ctx.strokeStyle = stroke
                    ctx.lineWidth = 1.4
                    ctx.lineCap = "round"
                    ctx.lineJoin = "round"
                    var w = width, h = height
                    switch (tb.glyphType) {
                    case "close":
                        ctx.beginPath(); ctx.moveTo(2,2); ctx.lineTo(w-2,h-2)
                        ctx.moveTo(w-2,2); ctx.lineTo(2,h-2); ctx.stroke(); break
                    case "min":
                        ctx.beginPath(); ctx.moveTo(2,h-3); ctx.lineTo(w-2,h-3); ctx.stroke(); break
                    case "dock":
                        // panel snapping to the right edge
                        ctx.strokeRect(1.5,2.5,w-3,h-5)
                        ctx.beginPath(); ctx.moveTo(w-5,2.5); ctx.lineTo(w-5,h-2.5); ctx.stroke(); break
                    case "undock":
                        // floating window glyph (offset rectangles)
                        ctx.strokeRect(1.5,3.5,w-6,h-6)
                        ctx.strokeRect(4.5,1.5,w-6,h-6); break
                    case "hide":
                        // chevrons pointing right (tuck away)
                        ctx.beginPath(); ctx.moveTo(3,3); ctx.lineTo(w-5,h/2); ctx.lineTo(3,h-3)
                        ctx.moveTo(7,3); ctx.lineTo(w-1,h/2); ctx.lineTo(7,h-3); ctx.stroke(); break
                    }
                }
            }
        }

        MouseArea {
            id: ma
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: tb.clicked()
            ToolTip.text: tb.tip
            ToolTip.visible: containsMouse && tb.tip.length > 0
            ToolTip.delay: 500
        }
    }
}
