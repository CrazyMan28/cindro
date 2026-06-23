pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// SSH page: manage the daemon's allow-list (ssh.allow_list / allow_add /
// allow_remove) and run gated commands (ssh.exec). The daemon enforces the
// allow-list (error 'host_not_allowed') and a biometric tier — this page only
// surfaces hosts + a small console. Degrades cleanly when ssh.* is unshipped.
Item {
    id: page

    ListModel { id: hostsModel }
    ListModel { id: consoleModel }   // {host, cmd, output, ok}
    property string selectedHost: ""

    function refresh() { if (bridge.connected) bridge.sshAllowList() }
    Component.onCompleted: refresh()

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }
        function onSshHostsListed(hosts) {
            hostsModel.clear()
            for (var i = 0; i < hosts.length; i++)
                hostsModel.append({ "host": hosts[i] })
            if (page.selectedHost.length === 0 && hosts.length > 0)
                page.selectedHost = hosts[0]
            // if the selected host was removed, fall back to the first
            var still = false
            for (var j = 0; j < hosts.length; j++)
                if (hosts[j] === page.selectedHost) still = true
            if (!still)
                page.selectedHost = hosts.length > 0 ? hosts[0] : ""
        }
        function onSshExecResult(host, ok, output) {
            consoleModel.append({
                "host": host,
                "cmd": page.pendingCmd,
                "output": output.length ? output : (ok ? "(no output)" : "(failed)"),
                "ok": ok
            })
            page.pendingCmd = ""
            page.running = false
            consoleView.positionViewAtEnd()
        }
    }

    property string pendingCmd: ""
    property bool running: false

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "SSH"
            subtitle: "Allow-listed hosts Jarvis may reach. Exec is gated by the daemon's allow-list + biometric tier."
        }

        // ---- allow-list -----------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true

            Text {
                text: "// ALLOW-LIST"
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
                    id: addHostField
                    Layout.fillWidth: true
                    placeholder: "host  (user@host or host alias)"
                    onAccepted: page.addHost()
                }
                Widgets.PillButton {
                    label: "+ Allow"
                    primary: true
                    enabledBtn: bridge.connected && addHostField.text.trim().length > 0
                    onClicked: page.addHost()
                }
            }

            Flow {
                Layout.fillWidth: true
                spacing: 8
                visible: hostsModel.count > 0
                Repeater {
                    model: hostsModel
                    delegate: Rectangle {
                        id: chip
                        required property int index
                        required property string host
                        radius: Theme.radiusSm
                        implicitWidth: chipRow.implicitWidth + 18
                        implicitHeight: 30
                        color: chip.host === page.selectedHost ? Theme.accentFaint : Theme.surface
                        border.width: 1
                        border.color: chip.host === page.selectedHost ? Theme.accent : Theme.hairlineSoft
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        Row {
                            id: chipRow
                            anchors.centerIn: parent
                            spacing: 8
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 6; height: 6; radius: 3
                                color: Theme.success
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: chip.host
                                color: Theme.text
                                font.family: Theme.fontMono
                                font.pixelSize: 12
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: "✕"
                                color: removeMa.containsMouse ? Theme.danger : Theme.textFaint
                                font.pixelSize: 11
                                MouseArea {
                                    id: removeMa
                                    anchors.fill: parent
                                    anchors.margins: -4
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: bridge.sshAllowRemove(chip.host)
                                }
                            }
                        }
                        MouseArea {
                            anchors.fill: parent
                            anchors.rightMargin: 22
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.selectedHost = chip.host
                        }
                    }
                }
            }
            Text {
                visible: hostsModel.count === 0
                text: "No allow-listed hosts. Add one above to enable gated exec."
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: 12
            }
        }

        // ---- gated exec console --------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true
            Layout.fillHeight: true

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    text: "// GATED EXEC"
                    color: Theme.amber
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: page.selectedHost.length ? ("→ " + page.selectedHost) : "select a host"
                    color: page.selectedHost.length ? Theme.accent : Theme.textFaint
                    font.family: Theme.fontMono
                    font.pixelSize: 11
                }
            }

            // output transcript
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.minimumHeight: 120
                radius: Theme.radiusSm
                color: Theme.surfaceDeep
                border.width: 1
                border.color: Theme.hairlineSoft
                clip: true

                ListView {
                    id: consoleView
                    anchors.fill: parent
                    anchors.margins: 10
                    clip: true
                    spacing: 8
                    model: consoleModel
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar {
                        policy: ScrollBar.AsNeeded; width: 5
                        background: Item {}
                        contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
                    }
                    delegate: ColumnLayout {
                        required property int index
                        required property string host
                        required property string cmd
                        required property string output
                        required property bool ok
                        width: ListView.view.width
                        spacing: 2
                        Text {
                            text: "$ " + cmd
                            color: Theme.accentBright
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            text: output
                            color: ok ? Theme.textMuted : Theme.danger
                            font.family: Theme.fontMono
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            lineHeight: 1.3
                            Layout.fillWidth: true
                        }
                    }
                    Text {
                        anchors.centerIn: parent
                        visible: consoleModel.count === 0
                        text: "Output appears here."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Widgets.StyledField {
                    id: cmdField
                    Layout.fillWidth: true
                    placeholder: page.selectedHost.length ? ("Command on " + page.selectedHost + "…") : "Select a host first…"
                    onAccepted: page.runCmd()
                }
                Widgets.PillButton {
                    label: page.running ? "Running…" : "Run"
                    primary: true
                    busy: page.running
                    enabledBtn: bridge.connected && page.selectedHost.length > 0
                                && cmdField.text.trim().length > 0 && !page.running
                    onClicked: page.runCmd()
                }
            }
        }
    }

    function addHost() {
        var h = addHostField.text.trim()
        if (h.length === 0) return
        bridge.sshAllowAdd(h)
        addHostField.text = ""
    }

    function runCmd() {
        var c = cmdField.text.trim()
        if (c.length === 0 || page.selectedHost.length === 0) return
        page.pendingCmd = c
        page.running = true
        bridge.sshExec(page.selectedHost, c)
        cmdField.text = ""
    }
}
