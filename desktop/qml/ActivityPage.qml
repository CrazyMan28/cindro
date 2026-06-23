pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// ACTIVITY / AUDIT page: every tool/action the daemon logged (audit.list) as
// {ts,tool,ok,risk,summary}, with a risk filter and a desktop-notifications
// toggle. The risk gate (HERMES_FEATURES) flags high-risk actions amber/red.
// Degrades to an empty state when audit.list isn't shipped daemon-side yet.
Item {
    id: page

    ListModel { id: auditModel }
    property string riskFilter: "all"   // all | low | medium | high
    property int total: 0

    function refresh() { if (bridge.connected) bridge.auditList(100) }
    Component.onCompleted: refresh()

    function riskRank(r) {
        return r === "high" ? 3 : r === "medium" ? 2 : r === "low" ? 1 : 0
    }

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onAuditListed(entries) {
            auditModel.clear()
            page.total = entries.length
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i]
                var risk = e.risk !== undefined ? ("" + e.risk) : "low"
                if (page.riskFilter !== "all" && risk !== page.riskFilter)
                    continue
                auditModel.append({
                    "ts": e.ts !== undefined ? ("" + e.ts) : "",
                    "tool": e.tool !== undefined ? e.tool : "(action)",
                    "ok": e.ok !== undefined ? e.ok : true,
                    "risk": risk,
                    "summary": e.summary !== undefined ? e.summary : ""
                })
            }
        }
    }

    function tsLabel(ts) {
        if (!ts || ts.length === 0) return ""
        var n = Number(ts)
        if (!isNaN(n) && n > 0) {
            var ms = n < 1e12 ? n * 1000 : n
            return new Date(ms).toLocaleString(Qt.locale(), "MMM d  hh:mm:ss")
        }
        return ts
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "Activity"
                subtitle: "Audit trail of every tool + action, with the risk gate. High-risk actions need approval."
            }
            Widgets.PillButton {
                label: "Refresh"
                Layout.alignment: Qt.AlignTop
                onClicked: page.refresh()
            }
        }

        // ---- controls: risk filter + notifications toggle ------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Repeater {
                model: ["all", "low", "medium", "high"]
                delegate: Rectangle {
                    id: fchip
                    required property string modelData
                    radius: Theme.radiusSm
                    implicitWidth: ftxt.implicitWidth + 22
                    implicitHeight: 28
                    color: page.riskFilter === fchip.modelData ? Theme.accentFaint : Theme.surface
                    border.width: 1
                    border.color: page.riskFilter === fchip.modelData ? Theme.accent : Theme.hairlineSoft
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                    Text {
                        id: ftxt
                        anchors.centerIn: parent
                        text: fchip.modelData.toUpperCase()
                        color: page.riskFilter === fchip.modelData ? Theme.accentBright : Theme.textMuted
                        font.family: Theme.fontDisplay
                        font.pixelSize: 10
                        font.letterSpacing: Theme.trackMid
                    }
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: { page.riskFilter = fchip.modelData; page.refresh() }
                    }
                }
            }

            Item { Layout.fillWidth: true }

            Text {
                text: "NOTIFY"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }
            Widgets.StyledSwitch {
                Layout.alignment: Qt.AlignVCenter
                checked: bridge.notify
                onToggled: function(v) { bridge.setNotificationsEnabled(v) }
            }
        }

        // ---- empty state ----------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: auditModel.count === 0
            ColumnLayout {
                anchors.centerIn: parent
                width: parent.width - 60
                spacing: 12
                ArcReactor { Layout.alignment: Qt.AlignHCenter; size: 84; tint: Theme.accent }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "NO ACTIVITY"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay; font.pixelSize: 15
                    font.weight: Font.DemiBold; font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: page.riskFilter !== "all"
                          ? "No logged actions at this risk level."
                          : "As Jarvis runs tools, each action is logged here with its risk."
                    color: Theme.textFaint
                    font.family: Theme.fontSans; font.pixelSize: 13; lineHeight: 1.3
                }
            }
        }

        // ---- audit list -----------------------------------------------------
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: auditModel.count > 0
            clip: true
            spacing: 7
            model: auditModel
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded; width: 5
                background: Item {}
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: row
                required property int index
                required property string ts
                required property string tool
                required property bool ok
                required property string risk
                required property string summary

                width: ListView.view.width
                implicitHeight: rowCol.implicitHeight + 18
                radius: Theme.radiusSm
                color: Theme.panelSoft
                border.width: 1
                border.color: row.risk === "high" ? Qt.rgba(1, 0.30, 0.369, 0.4)
                              : row.risk === "medium" ? Theme.amberDim
                              : Theme.hairlineSoft

                // status/risk edge
                Rectangle {
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: !row.ok ? Theme.danger
                           : row.risk === "high" ? Theme.danger
                           : row.risk === "medium" ? Theme.amber
                           : Theme.success
                    opacity: 0.85
                }

                ColumnLayout {
                    id: rowCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.leftMargin: 16
                    anchors.rightMargin: 12
                    anchors.topMargin: 9
                    spacing: 4

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            text: row.tool
                            color: Theme.text
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            font.weight: Font.Medium
                        }
                        // risk badge
                        Rectangle {
                            visible: row.risk.length > 0
                            radius: 5
                            implicitWidth: rt.implicitWidth + 12
                            implicitHeight: 16
                            color: "transparent"
                            border.width: 1
                            border.color: row.risk === "high" ? Theme.danger
                                          : row.risk === "medium" ? Theme.amber : Theme.accentDim
                            Text {
                                id: rt
                                anchors.centerIn: parent
                                text: row.risk
                                color: row.risk === "high" ? Theme.danger
                                       : row.risk === "medium" ? Theme.amber : Theme.accent
                                font.family: Theme.fontSans
                                font.pixelSize: 9
                            }
                        }
                        // ok/fault badge
                        Text {
                            text: row.ok ? "OK" : "FAULT"
                            color: row.ok ? Theme.success : Theme.danger
                            font.family: Theme.fontDisplay
                            font.pixelSize: 9
                            font.letterSpacing: Theme.trackMid
                        }
                        Item { Layout.fillWidth: true }
                        Text {
                            text: page.tsLabel(row.ts)
                            color: Theme.textFaint
                            font.family: Theme.fontMono
                            font.pixelSize: 10
                        }
                    }
                    Text {
                        visible: row.summary.length > 0
                        Layout.fillWidth: true
                        text: row.summary
                        color: Theme.textMuted
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        maximumLineCount: 3
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }
}
