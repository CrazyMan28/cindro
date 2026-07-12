import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import CindroSidebar

// TODAY // BRIEFING — a compact HUD panel summarizing "what I'm working on today"
// from skills.today (project-tracker + recent sessions/memories). Refreshes on
// connect. Renders nothing useful until a digest arrives; a placeholder line
// keeps the HUD frame coherent while linking / when the daemon has no digest yet.
Item {
    id: brief
    implicitHeight: shell.implicitHeight

    property string digest: ""
    property bool loading: false

    function refresh() {
        if (!bridge.connected) return
        brief.loading = true
        bridge.skillsToday()
    }
    Component.onCompleted: if (bridge.connected) refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) brief.refresh() }
        function onTodayDigest(d) {
            brief.loading = false
            brief.digest = d
        }
    }

    Rectangle {
        id: shell
        anchors.left: parent.left
        anchors.right: parent.right
        implicitHeight: col.implicitHeight + 28
        radius: Theme.radius
        color: Theme.panelSoft
        border.width: 1
        border.color: Theme.accentDim

        // top neon seam
        Rectangle {
            anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
            anchors.leftMargin: Theme.radius; anchors.rightMargin: Theme.radius; anchors.topMargin: 1
            height: 2; radius: 1
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: Theme.accentGlow }
                GradientStop { position: 1.0; color: "transparent" }
            }
            opacity: 0.9
        }

        ColumnLayout {
            id: col
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            anchors.topMargin: 14
            spacing: 10

            // header strip
            RowLayout {
                Layout.fillWidth: true
                spacing: 9

                // pulsing reactor dot
                Rectangle {
                    Layout.alignment: Qt.AlignVCenter
                    width: 8; height: 8; radius: 4
                    color: Theme.accent
                    layer.enabled: true
                    layer.effect: MultiEffect { blurEnabled: true; blur: 0.7; blurMax: 12; brightness: 0.3 }
                    SequentialAnimation on opacity {
                        running: true; loops: Animation.Infinite
                        NumberAnimation { from: 0.45; to: 1.0; duration: 1100; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 1.0; to: 0.45; duration: 1100; easing.type: Easing.InOutSine }
                    }
                }

                Text {
                    text: "TODAY // BRIEFING"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay
                    font.pixelSize: 12
                    font.weight: Font.DemiBold
                    font.letterSpacing: Theme.trackWide
                }

                Item { Layout.fillWidth: true }

                // refresh affordance
                Text {
                    text: brief.loading ? "SYNCING…" : "↻"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay
                    font.pixelSize: brief.loading ? 9 : 14
                    font.letterSpacing: brief.loading ? Theme.trackMid : 0
                    MouseArea {
                        anchors.fill: parent
                        anchors.margins: -6
                        cursorShape: Qt.PointingHandCursor
                        onClicked: brief.refresh()
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true; height: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Theme.accentDim }
                    GradientStop { position: 1.0; color: "transparent" }
                }
            }

            // digest body — HARD-BOUNDED so an oversized digest (e.g. a memory
            // that captured a big pasted blob) can never overflow the empty-state
            // column and shove the rest of the chat off-screen. Capped to a sane
            // number of lines and elided; the daemon also previews memory rows.
            Text {
                Layout.fillWidth: true
                text: brief.digest.length > 0
                      ? brief.digest
                      : (brief.loading
                         ? "Compiling today's briefing…"
                         : "No briefing yet — project status, recent sessions, and fresh memories will summarize here.")
                color: brief.digest.length > 0 ? Theme.text : Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: 13
                lineHeight: 1.4
                wrapMode: Text.WordWrap
                maximumLineCount: 16
                elide: Text.ElideRight
            }
        }
    }
}
