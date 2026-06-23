pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// SUB-AGENT TREE: visualizes child / sub-agent sessions as an indented tree.
// Built from session.list parent links (parent_session_id) by the Bridge, which
// emits subAgentTree([{id,title,brain,profile,status,depth,parent}]). Clicking a
// node opens that session in Chat. Collapses to a compact header when empty.
Item {
    id: tree
    implicitHeight: treeCol.implicitHeight

    // emitted when a node is activated; the host page routes to Chat.
    signal openSession(string sessionId)

    ListModel { id: treeModel }
    property int nodeCount: 0

    function refresh() { if (bridge.connected) bridge.loadSubAgentTree() }
    Component.onCompleted: refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) tree.refresh() }
        function onSubAgentTree(rows) {
            treeModel.clear()
            tree.nodeCount = rows.length
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i]
                // only show nodes that are part of a parent/child relationship, OR
                // every node when at least one has children — otherwise it's just a
                // flat session list (already on the Sessions page below).
                treeModel.append({
                    "sid": r.id !== undefined ? r.id : "",
                    "title": (r.title && r.title.length) ? r.title : "Untitled",
                    "brain": r.brain !== undefined ? r.brain : "",
                    "profile": r.profile !== undefined ? r.profile : "",
                    "status": r.status !== undefined ? r.status : "",
                    "depth": r.depth !== undefined ? r.depth : 0,
                    "isChild": (r.depth !== undefined ? r.depth : 0) > 0
                })
            }
        }
        // a fresh sub-agent session likely changed the tree
        function onCoworkerStarted(sessionId) { tree.refresh() }
        function onSessionsListed(sessions) { tree.refresh() }
    }

    function statusColor(st) {
        if (st === "running") return Theme.accent
        if (st === "error") return Theme.danger
        if (st === "done") return Theme.success
        return Theme.textFaint
    }

    ColumnLayout {
        id: treeCol
        width: parent.width
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Text {
                text: "// SUB-AGENT TREE"
                color: Theme.violet
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
            }
            Rectangle {
                radius: 5
                implicitWidth: cntTxt.implicitWidth + 12
                implicitHeight: 16
                color: "transparent"
                border.width: 1
                border.color: Qt.rgba(0.694, 0.294, 1.0, 0.45)
                Text {
                    id: cntTxt
                    anchors.centerIn: parent
                    text: "" + tree.nodeCount
                    color: Theme.violet
                    font.family: Theme.fontMono
                    font.pixelSize: 10
                }
            }
            Item { Layout.fillWidth: true }
            Text {
                text: "refresh"
                color: refreshMa.containsMouse ? Theme.accent : Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackMid
                MouseArea {
                    id: refreshMa
                    anchors.fill: parent
                    anchors.margins: -6
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: tree.refresh()
                }
            }
        }

        Text {
            visible: treeModel.count === 0
            Layout.fillWidth: true
            text: "No sub-agents. Spawned child sessions appear here as an indented tree."
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: 12
            wrapMode: Text.WordWrap
        }

        // indented tree rows
        Column {
            Layout.fillWidth: true
            spacing: 4
            Repeater {
                model: treeModel
                delegate: Item {
                    id: node
                    required property int index
                    required property string sid
                    required property string title
                    required property string brain
                    required property string profile
                    required property string status
                    required property int depth
                    required property bool isChild
                    width: parent.width
                    height: 34

                    // connector glyph for child rows
                    Canvas {
                        visible: node.isChild
                        x: node.depth * 18 - 12
                        width: 14; height: node.height
                        onPaint: {
                            var ctx = getContext("2d"); ctx.reset()
                            ctx.strokeStyle = Theme.violet
                            ctx.globalAlpha = 0.5
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(2, 0); ctx.lineTo(2, height / 2)
                            ctx.lineTo(12, height / 2); ctx.stroke()
                        }
                    }

                    Rectangle {
                        anchors.left: parent.left
                        anchors.leftMargin: node.depth * 18
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        height: 30
                        radius: Theme.radiusXs
                        color: nodeMa.containsMouse ? Theme.surfaceStrong : Theme.surface
                        border.width: 1
                        border.color: nodeMa.containsMouse ? Theme.accentDim : Theme.hairlineFaint
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 10
                            anchors.rightMargin: 10
                            spacing: 8

                            Rectangle {
                                width: 7; height: 7; radius: 3.5
                                Layout.alignment: Qt.AlignVCenter
                                color: tree.statusColor(node.status)
                                SequentialAnimation on opacity {
                                    running: node.status === "running"
                                    loops: Animation.Infinite
                                    NumberAnimation { from: 1; to: 0.3; duration: 700 }
                                    NumberAnimation { from: 0.3; to: 1; duration: 700 }
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                text: node.title
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                elide: Text.ElideRight
                            }
                            Text {
                                text: node.brain + (node.profile.length ? " · " + node.profile : "")
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
                        }
                        MouseArea {
                            id: nodeMa
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                bridge.openSession(node.sid)
                                tree.openSession(node.sid)
                            }
                        }
                    }
                }
            }
        }
    }
}
