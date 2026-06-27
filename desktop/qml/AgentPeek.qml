pragma ComponentBehavior: Bound
import QtQuick
import JarvisSidebar

// AgentPeek — a compact LIVE view of what Jarvis is doing on its own nested desktop
// (or a Chrome tab). Reused on the Home dashboard's "working" card and in the chat
// peek panel. Self-manages the frame poll: starts it while visible + an agent is
// active, stops it when hidden. Degrades to a tidy placeholder when there's no frame.
Rectangle {
    id: peek
    radius: 12
    color: Theme.surfaceDeep
    border.width: 1
    border.color: Theme.hairline
    clip: true

    // Is there an agent desktop to watch (a co-worker session or a live take-over)?
    readonly property bool active: bridge.driving || bridge.coworkerSessionId.length > 0
    property bool poll: visible && active

    onPollChanged: poll ? bridge.mirrorStart() : bridge.mirrorStop()
    Component.onCompleted: if (poll) bridge.mirrorStart()
    Component.onDestruction: bridge.mirrorStop()

    Image {
        id: frame
        anchors.fill: parent
        fillMode: Image.PreserveAspectFit
        cache: false
        asynchronous: true
        source: ""
        visible: bridge.frameSeq > 0
        Connections {
            target: bridge
            function onFrameReady() {
                frame.source = "image://jarvisframe/agent?" + bridge.frameSeq
            }
        }
    }

    // Placeholder: no frame yet (agent thinking / not mirroring).
    Column {
        anchors.centerIn: parent
        spacing: 8
        visible: !frame.visible
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: peek.active ? "◴" : "▣"
            color: Theme.accentDim
            font.pixelSize: 26
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: peek.active ? "waiting for the agent…" : "no agent running"
            color: Theme.textFaint
            font.family: Theme.fontDisplay
            font.pixelSize: 10
            font.letterSpacing: 1
        }
    }

    // LIVE badge.
    Rectangle {
        visible: bridge.mirroring
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.margins: 8
        radius: 9
        width: liveRow.implicitWidth + 14
        height: 18
        color: Qt.rgba(0.22, 0.90, 0.63, 0.16)
        border.width: 1
        border.color: Qt.rgba(0.22, 0.90, 0.63, 0.35)
        Row {
            id: liveRow
            anchors.centerIn: parent
            spacing: 5
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: 6; height: 6; radius: 3; color: Theme.success
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "LIVE"
                color: Theme.success
                font.family: Theme.fontDisplay
                font.pixelSize: 8
                font.letterSpacing: 1.4
                font.weight: Font.DemiBold
            }
        }
    }
}
