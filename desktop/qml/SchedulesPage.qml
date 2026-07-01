pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// SCHEDULES page: list the daemon's cron jobs (schedule.list), create a new one
// (name + when|cron + prompt + brain/model), and enable / remove each. Fires due
// jobs as session.create+session.send daemon-side; this page only manages them.
// Degrades to a clean empty state when the daemon hasn't shipped schedule.* yet.
Item {
    id: page

    ListModel { id: schedModel }
    property bool composing: false
    property var availableBrains: ({})

    onAvailableBrainsChanged: brainCombo.model = brainOptions()

    function brainOptions() {
        var out = []
        if (page.availableBrains.codex === true) out.push("codex")
        if (page.availableBrains.claude === true) out.push("claude")
        out.push("api")
        return out
    }

    function refresh() { if (bridge.connected) bridge.scheduleList() }
    Component.onCompleted: {
        refresh()
        if (bridge.connected) bridge.loadSettings()
    }

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) { page.refresh(); bridge.loadSettings() } }
        function onSettingsLoaded(s) {
            page.availableBrains = s.available_brains !== undefined ? s.available_brains : ({})
        }
        function onSchedulesListed(schedules) {
            schedModel.clear()
            for (var i = 0; i < schedules.length; i++) {
                var s = schedules[i]
                schedModel.append({
                    "sid": s.id !== undefined ? ("" + s.id) : "",
                    "name": s.name !== undefined ? s.name : "(unnamed)",
                    "cron": s.cron !== undefined ? s.cron : (s.when !== undefined ? s.when : ""),
                    "nextRun": s.next_run !== undefined ? ("" + s.next_run) : "",
                    "lastRun": s.last_run !== undefined ? ("" + s.last_run) : "",
                    "enabled": s.enabled !== undefined ? s.enabled : true
                })
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        RowLayout {
            Layout.fillWidth: true
            PageHeader {
                Layout.fillWidth: true
                title: "Schedules"
                subtitle: "Cron-driven tasks the daemon fires as new sessions. Set a cadence and a prompt."
            }
            Widgets.PillButton {
                label: page.composing ? "Close" : "+ New"
                primary: !page.composing
                Layout.alignment: Qt.AlignTop
                onClicked: page.composing = !page.composing
            }
        }

        // ---- composer -------------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true
            visible: page.composing

            Text {
                text: "// NEW SCHEDULE"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Widgets.StyledField {
                    id: nameField
                    Layout.fillWidth: true
                    placeholder: "Name  (e.g. Morning briefing)"
                }
                Widgets.StyledField {
                    id: cronField
                    Layout.preferredWidth: 180
                    placeholder: "Cron  (0 9 * * *)"
                }
            }

            Widgets.StyledField {
                id: whenField
                Layout.fillWidth: true
                placeholder: "…or natural cadence  (every day 09:00)  — used only if cron is empty"
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 90
                radius: Theme.radiusSm
                color: Theme.surfaceInput
                border.width: 1
                border.color: promptArea.activeFocus ? Theme.accent : Theme.hairlineSoft
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 10
                    clip: true
                    TextArea {
                        id: promptArea
                        placeholderText: "Prompt to run on each fire…"
                        placeholderTextColor: Theme.textFaint
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        wrapMode: TextArea.Wrap
                        selectByMouse: true
                        selectionColor: Theme.accentDim
                        background: null
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12

                ColumnLayout {
                    spacing: 4
                    Text {
                        text: "BRAIN"; color: Theme.textFaint
                        font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: Theme.trackWide
                    }
                    Widgets.StyledCombo {
                        id: brainCombo
                        Layout.preferredWidth: 150
                        model: page.brainOptions()
                    }
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4
                    Text {
                        text: "MODEL (optional)"; color: Theme.textFaint
                        font.family: Theme.fontDisplay; font.pixelSize: 9
                        font.letterSpacing: Theme.trackWide
                    }
                    Widgets.StyledField {
                        id: modelField
                        Layout.fillWidth: true
                        placeholder: "default"
                    }
                }
                Widgets.PillButton {
                    label: "Create"
                    primary: true
                    Layout.alignment: Qt.AlignBottom
                    enabledBtn: bridge.connected
                                && nameField.text.trim().length > 0
                                && promptArea.text.trim().length > 0
                                && (cronField.text.trim().length > 0 || whenField.text.trim().length > 0)
                    onClicked: page.commit()
                }
            }
        }

        // ---- empty state ----------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: schedModel.count === 0 && !page.composing
            ColumnLayout {
                anchors.centerIn: parent
                width: parent.width - 60
                spacing: 12
                ArcReactor { Layout.alignment: Qt.AlignHCenter; size: 84; tint: Theme.accent }
                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "NO SCHEDULES"
                    color: Theme.accentBright
                    font.family: Theme.fontDisplay; font.pixelSize: 15
                    font.weight: Font.DemiBold; font.letterSpacing: Theme.trackMid
                }
                Text {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                    text: "Create a cron job and Jarvis will spin up a session and run your prompt on cadence."
                    color: Theme.textFaint
                    font.family: Theme.fontSans; font.pixelSize: 13; lineHeight: 1.3
                }
            }
        }

        // ---- schedule list --------------------------------------------------
        ListView {
            id: list
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: schedModel.count > 0
            clip: true
            spacing: 9
            model: schedModel
            boundsBehavior: Flickable.StopAtBounds

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
                width: 5
                background: Item {}
                contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
            }

            delegate: Rectangle {
                id: row
                required property int index
                required property string sid
                required property string name
                required property string cron
                required property string nextRun
                required property string lastRun
                required property bool enabled

                width: ListView.view.width
                implicitHeight: rowCol.implicitHeight + 24
                radius: Theme.radius
                color: Theme.panelSoft
                border.color: rowMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                border.width: 1
                opacity: row.enabled ? 1.0 : 0.62
                Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                Rectangle {
                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                    anchors.margins: 1
                    width: 3; radius: 1.5
                    color: row.enabled ? Theme.accent : Theme.textFaint
                    opacity: 0.8
                }

                MouseArea { id: rowMa; anchors.fill: parent; hoverEnabled: true }

                RowLayout {
                    id: rowCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 16
                    anchors.rightMargin: 14
                    spacing: 12

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 5
                        Text {
                            text: row.name
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: 14
                            font.weight: Font.Medium
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                        }
                        RowLayout {
                            spacing: 10
                            Rectangle {
                                radius: 5
                                implicitWidth: cronTxt.implicitWidth + 14
                                implicitHeight: 18
                                color: "transparent"
                                border.width: 1
                                border.color: Theme.accentDim
                                Text {
                                    id: cronTxt
                                    anchors.centerIn: parent
                                    text: row.cron.length ? row.cron : "—"
                                    color: Theme.accent
                                    font.family: Theme.fontMono
                                    font.pixelSize: 10
                                }
                            }
                            Text {
                                text: row.nextRun.length ? ("next " + row.nextRun) : ""
                                visible: row.nextRun.length > 0
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
                            Text {
                                text: row.lastRun.length ? ("last " + row.lastRun) : ""
                                visible: row.lastRun.length > 0
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
                        }
                    }

                    Widgets.PillButton {
                        label: "Run"
                        opacity: rowMa.containsMouse ? 1.0 : 0.6
                        onClicked: bridge.scheduleRunNow(row.sid)
                    }
                    Widgets.StyledSwitch {
                        Layout.alignment: Qt.AlignVCenter
                        checked: row.enabled
                        onToggled: function(v) { bridge.scheduleSetEnabled(row.sid, v) }
                    }
                    Widgets.PillButton {
                        label: "Remove"
                        danger: true
                        opacity: rowMa.containsMouse ? 1.0 : 0.55
                        onClicked: bridge.scheduleRemove(row.sid)
                    }
                }
            }
        }
    }

    function commit() {
        var spec = {
            "name": nameField.text.trim(),
            "prompt": promptArea.text.trim(),
            "brain": brainCombo.currentText,
            "enabled": true
        }
        if (cronField.text.trim().length > 0)
            spec["cron"] = cronField.text.trim()
        else
            spec["when"] = whenField.text.trim()
        if (modelField.text.trim().length > 0)
            spec["model"] = modelField.text.trim()
        bridge.scheduleCreate(spec)
        nameField.text = ""; cronField.text = ""; whenField.text = ""
        promptArea.text = ""; modelField.text = ""
        page.composing = false
    }
}
