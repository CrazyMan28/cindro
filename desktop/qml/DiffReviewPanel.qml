pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// DIFF-REVIEW: a reviewable per-file diff panel rendered for chat `diff` events.
// Per-line +/- tinting (with line numbers + a hunk header), collapse/expand, and
// Stage / Commit / Revert / Open-PR actions wired to the Bridge (best-effort;
// the daemon/brain may answer unknown_method, which surfaces a quiet status).
// Destructive actions (Revert) pass through an inline approval gate first.
Rectangle {
    id: panel

    property string path: "diff"
    property string patch: ""

    anchors.left: parent ? parent.left : undefined
    anchors.right: parent ? parent.right : undefined
    radius: Theme.radiusSm
    implicitHeight: col.implicitHeight + 22
    color: Qt.rgba(0, 0, 0, 0.24)
    border.color: Theme.hairline
    border.width: 1
    clip: true

    property bool expanded: true
    property bool confirmRevert: false
    property string actionStatus: ""        // last action result line
    property string actionState: ""         // "ok" | "fail" | ""

    // line stats
    readonly property var lines: patch.length ? patch.split("\n") : []
    property int added: 0
    property int removed: 0
    Component.onCompleted: panel.computeStats()
    onPatchChanged: panel.computeStats()
    function computeStats() {
        var a = 0, r = 0
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i]
            if (l.startsWith("+") && !l.startsWith("+++")) a++
            else if (l.startsWith("-") && !l.startsWith("---")) r++
        }
        panel.added = a
        panel.removed = r
    }

    Connections {
        target: bridge
        function onDiffActionResult(action, p, ok, message) {
            // only react to results for this file (or global commit/PR)
            if (p.length && p !== panel.path
                && action !== "commit" && action !== "open_pr")
                return
            panel.actionState = ok ? "ok" : "fail"
            var verb = action === "open_pr" ? "PR" : action
            panel.actionStatus = (ok ? "✓ " : "✕ ") + verb
                                 + (message.length ? "  " + message : "")
            statusClear.restart()
        }
    }
    Timer { id: statusClear; interval: 6000; onTriggered: panel.actionStatus = "" }

    ColumnLayout {
        id: col
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 11
        spacing: 8

        // ---- header: file path + stat counts + collapse -------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Canvas {
                width: 12; height: 12
                Layout.alignment: Qt.AlignVCenter
                onPaint: {
                    var ctx = getContext("2d"); ctx.reset()
                    ctx.strokeStyle = Theme.accent; ctx.lineWidth = 1.3
                    ctx.lineCap = "round"; ctx.lineJoin = "round"
                    ctx.strokeRect(2.5, 1.5, 7, 9)
                    ctx.beginPath(); ctx.moveTo(4.5, 4); ctx.lineTo(7.5, 4)
                    ctx.moveTo(4.5, 6.5); ctx.lineTo(7.5, 6.5); ctx.stroke()
                }
            }
            Text {
                text: panel.path
                color: Theme.text
                font.weight: Font.Medium
                font.pixelSize: 12
                font.family: Theme.fontMono
                elide: Text.ElideMiddle
                Layout.fillWidth: true
            }
            // +N / -N stat chips
            Text {
                visible: panel.added > 0
                text: "+" + panel.added
                color: Theme.ok
                font.family: Theme.fontMono
                font.pixelSize: 11
            }
            Text {
                visible: panel.removed > 0
                text: "−" + panel.removed
                color: Theme.danger
                font.family: Theme.fontMono
                font.pixelSize: 11
            }
            Text {
                text: panel.expanded ? "▾" : "▸"
                color: Theme.textMuted
                font.pixelSize: 11
                MouseArea {
                    anchors.fill: parent
                    anchors.margins: -6
                    cursorShape: Qt.PointingHandCursor
                    onClicked: panel.expanded = !panel.expanded
                }
            }
        }

        // ---- diff body with per-line tinting + line numbers ----------------
        Rectangle {
            Layout.fillWidth: true
            visible: panel.expanded
            radius: Theme.radiusXs
            color: Theme.surfaceDeep
            border.width: 1
            border.color: Theme.hairlineFaint
            implicitHeight: body.implicitHeight + 12

            Column {
                id: body
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 6
                spacing: 0

                Repeater {
                    model: panel.lines.slice(0, 60)
                    delegate: Row {
                        required property string modelData
                        width: body.width
                        readonly property bool isAdd: modelData.startsWith("+") && !modelData.startsWith("+++")
                        readonly property bool isDel: modelData.startsWith("-") && !modelData.startsWith("---")
                        readonly property bool isHunk: modelData.startsWith("@@")
                        readonly property bool isHdr: modelData.startsWith("+++") || modelData.startsWith("---")
                                                      || modelData.startsWith("diff ")

                        Rectangle {
                            width: parent.width
                            height: lineTxt.implicitHeight
                            color: isAdd ? Qt.rgba(0.24, 1.0, 0.62, 0.08)
                                   : isDel ? Qt.rgba(1.0, 0.30, 0.37, 0.08)
                                   : isHunk ? Qt.rgba(0.45, 0.29, 1.0, 0.08)
                                   : "transparent"

                            Row {
                                anchors.fill: parent
                                // gutter sign
                                Rectangle {
                                    width: 3
                                    height: parent.height
                                    color: isAdd ? Theme.ok : isDel ? Theme.danger : "transparent"
                                    opacity: 0.8
                                }
                                Text {
                                    id: lineTxt
                                    leftPadding: 8
                                    width: parent.width - 11
                                    text: modelData.length ? modelData : " "
                                    color: isAdd ? Theme.ok
                                           : isDel ? Theme.danger
                                           : isHunk ? Theme.violet
                                           : isHdr ? Theme.textMuted
                                           : Theme.textMuted
                                    wrapMode: Text.NoWrap
                                    elide: Text.ElideRight
                                    font.pixelSize: 11
                                    font.family: Theme.fontMono
                                    textFormat: Text.PlainText
                                }
                            }
                        }
                    }
                }
                Text {
                    visible: panel.lines.length > 60
                    text: "… " + (panel.lines.length - 60) + " more lines"
                    color: Theme.textFaint
                    font.pixelSize: 10
                    font.family: Theme.fontMono
                    leftPadding: 11
                    topPadding: 3
                }
            }
        }

        // ---- action status line --------------------------------------------
        Text {
            visible: panel.actionStatus.length > 0
            Layout.fillWidth: true
            text: panel.actionStatus
            color: panel.actionState === "fail" ? Theme.danger : Theme.success
            font.family: Theme.fontMono
            font.pixelSize: 11
            wrapMode: Text.Wrap
        }

        // ---- revert approval gate ------------------------------------------
        Rectangle {
            visible: panel.confirmRevert
            Layout.fillWidth: true
            radius: Theme.radiusXs
            implicitHeight: revRow.implicitHeight + 16
            color: Qt.rgba(1.0, 0.30, 0.37, 0.07)
            border.width: 1
            border.color: Theme.dangerDim
            RowLayout {
                id: revRow
                anchors.fill: parent
                anchors.margins: 8
                spacing: 8
                Text {
                    Layout.fillWidth: true
                    text: "Revert all changes to this file?"
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }
                Widgets.PillButton {
                    label: "Revert"
                    danger: true
                    onClicked: { bridge.diffRevert(panel.path); panel.confirmRevert = false }
                }
                Widgets.PillButton {
                    label: "Cancel"
                    onClicked: panel.confirmRevert = false
                }
            }
        }

        // ---- actions: Stage / Commit / Revert / Open-PR --------------------
        RowLayout {
            Layout.fillWidth: true
            visible: panel.expanded
            spacing: 8

            Widgets.PillButton {
                label: "Stage"
                enabledBtn: bridge.connected
                onClicked: bridge.diffStage(panel.path)
            }
            Widgets.PillButton {
                label: "Commit"
                primary: true
                enabledBtn: bridge.connected
                onClicked: bridge.diffCommit("")   // daemon/brain crafts the message
            }
            Widgets.PillButton {
                label: "Open PR"
                enabledBtn: bridge.connected
                onClicked: bridge.diffOpenPr("")
            }
            Item { Layout.fillWidth: true }
            Widgets.PillButton {
                label: "Revert"
                danger: true
                enabledBtn: bridge.connected
                onClicked: panel.confirmRevert = true   // approval gate before acting
            }
        }
    }
}
