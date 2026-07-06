pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// Outpost page: pair remote Windows/Linux/macOS machines with a one-shot
// install command (outpost.pair_start / pair_status), list paired machines
// (outpost.list) with a Revoke action (outpost.revoke), and run gated exec +
// screenshot on a selected machine (outpost.exec / outpost.screenshot).
// Replaces the old SSH allow-list page — outpost.* verbs already exist and
// respond normally daemon-side, so (unlike the old ssh.* page) there's no
// unknown_method degradation to handle here.
Item {
    id: page

    ListModel { id: machinesModel }
    ListModel { id: consoleModel }   // {cmachine, cmd, output, ok}
    property string selectedMachine: ""

    property var pairResult: null   // {pairing_code,bootstrap_id,expires_at,install_cmd_linux,install_cmd_windows}
    property string pairState: ""   // "", "pending", "paired", "expired", "unknown"
    property bool pairing: false
    property bool linuxCopied: false
    property bool windowsCopied: false

    property string pendingCmd: ""
    property bool running: false
    property string shotImage: ""   // data: URL once a screenshot lands
    property bool shotBusy: false

    function refresh() { if (bridge.connected) bridge.outpostList() }
    Component.onCompleted: refresh()

    // periodic re-list so status/last_seen stay fresh without user action
    Timer {
        interval: 15000
        running: true
        repeat: true
        onTriggered: page.refresh()
    }

    // polls pairing status every ~5s until the machine pairs or the code expires
    Timer {
        id: pairPollTimer
        interval: 5000
        repeat: true
        running: false
        onTriggered: {
            if (page.pairResult)
                bridge.outpostPairStatus(page.pairResult.bootstrap_id)
        }
    }

    Timer { id: linuxCopyReset; interval: 1500; onTriggered: page.linuxCopied = false }
    Timer { id: winCopyReset; interval: 1500; onTriggered: page.windowsCopied = false }

    function startPairing() {
        page.pairing = true
        page.pairState = "pending"
        bridge.outpostPairStart()
    }

    function fmtTime(ms) {
        if (!ms) return ""
        try { return new Date(ms).toLocaleString() } catch (e) { return "" }
    }

    function selectedName() {
        for (var i = 0; i < machinesModel.count; i++) {
            var row = machinesModel.get(i)
            if (row.mid === page.selectedMachine) return row.mname
        }
        return page.selectedMachine
    }

    function runCmd() {
        var c = cmdField.text.trim()
        if (c.length === 0 || page.selectedMachine.length === 0) return
        page.pendingCmd = c
        page.running = true
        bridge.outpostExec(page.selectedMachine, c)
        cmdField.text = ""
    }

    function takeScreenshot() {
        if (page.selectedMachine.length === 0) return
        page.shotBusy = true
        page.shotImage = ""
        bridge.outpostScreenshot(page.selectedMachine)
    }

    Connections {
        target: bridge
        function onConnectedChanged() { if (bridge.connected) page.refresh() }

        function onOutpostMachinesListed(machines) {
            machinesModel.clear()
            for (var i = 0; i < machines.length; i++) {
                var m = machines[i]
                machinesModel.append({
                    "mid": m.id !== undefined ? m.id : "",
                    "mname": m.name !== undefined ? m.name : "",
                    "mos": m.os !== undefined ? m.os : "",
                    "mtransport": m.transport !== undefined ? m.transport : "",
                    "mstatus": m.status !== undefined ? m.status : "",
                    "mlastSeen": m.last_seen !== undefined ? m.last_seen : 0
                })
            }
            // if the selection vanished (revoked elsewhere / first load), fall
            // back to the first machine
            var still = false
            for (var j = 0; j < machinesModel.count; j++)
                if (machinesModel.get(j).mid === page.selectedMachine) still = true
            if (!still)
                page.selectedMachine = machinesModel.count > 0 ? machinesModel.get(0).mid : ""
        }

        function onOutpostPairStarted(result) {
            page.pairing = false
            page.pairResult = result
            page.pairState = "pending"
            page.linuxCopied = false
            page.windowsCopied = false
            pairPollTimer.restart()
        }

        function onOutpostPairStatusResult(result) {
            var status = result.status !== undefined ? result.status : ""
            page.pairState = status
            if (status === "paired") {
                pairPollTimer.stop()
                page.pairResult = null
                page.refresh()
            } else if (status === "expired" || status === "unknown") {
                pairPollTimer.stop()
            }
        }

        function onOutpostExecResult(machine, ok, output) {
            consoleModel.append({
                "cmachine": machine,
                "cmd": page.pendingCmd,
                "output": output.length ? output : (ok ? "(no output)" : "(failed)"),
                "ok": ok
            })
            page.pendingCmd = ""
            page.running = false
            consoleView.positionViewAtEnd()
        }

        function onOutpostScreenshotResult(machine, ok, imageBase64, error) {
            page.shotBusy = false
            page.shotImage = (ok && imageBase64.length > 0)
                             ? ("data:image/png;base64," + imageBase64) : ""
        }

        function onOutpostRevoked(machine, ok) {
            // the bridge re-queries outpost.list on success; nothing else to do.
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        PageHeader {
            Layout.fillWidth: true
            title: "Outpost"
            subtitle: "Pair a remote machine with one command, then run gated exec + screenshot on it by name."
        }

        // ---- pair a machine ---------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true

            Text {
                text: "// PAIR A MACHINE"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        text: "Add a Windows / Linux / macOS machine"
                        color: Theme.text
                        font.family: Theme.fontSans
                        font.pixelSize: 13
                        font.weight: Font.Medium
                    }
                    Text {
                        text: "Generates a one-shot install command, valid for 10 minutes."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 11
                    }
                }
                Widgets.PillButton {
                    label: page.pairing ? "Generating…" : (page.pairResult ? "New code" : "Pair a machine")
                    primary: true
                    enabledBtn: bridge.connected && !page.pairing
                    onClicked: page.startPairing()
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                visible: page.pairResult !== null
                spacing: 4

                Text {
                    text: "RUN ON LINUX / macOS"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay
                    font.pixelSize: 10
                    font.letterSpacing: Theme.trackMid
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Rectangle {
                        Layout.fillWidth: true
                        radius: Theme.radiusSm
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: Theme.accentDim
                        implicitHeight: linuxCmdText.implicitHeight + 16
                        Text {
                            id: linuxCmdText
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: 10
                            text: page.pairResult ? page.pairResult.install_cmd_linux : ""
                            color: Theme.accentBright
                            font.family: Theme.fontMono
                            font.pixelSize: 11
                            wrapMode: Text.WrapAnywhere
                        }
                    }
                    Widgets.PillButton {
                        label: page.linuxCopied ? "Copied ✓" : "Copy"
                        onClicked: {
                            bridge.copyToClipboard(page.pairResult.install_cmd_linux)
                            page.linuxCopied = true
                            linuxCopyReset.restart()
                        }
                    }
                }

                Text {
                    Layout.topMargin: 6
                    text: "RUN ON WINDOWS (PowerShell)"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay
                    font.pixelSize: 10
                    font.letterSpacing: Theme.trackMid
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Rectangle {
                        Layout.fillWidth: true
                        radius: Theme.radiusSm
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: Theme.accentDim
                        implicitHeight: winCmdText.implicitHeight + 16
                        Text {
                            id: winCmdText
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: 10
                            text: page.pairResult ? page.pairResult.install_cmd_windows : ""
                            color: Theme.accentBright
                            font.family: Theme.fontMono
                            font.pixelSize: 11
                            wrapMode: Text.WrapAnywhere
                        }
                    }
                    Widgets.PillButton {
                        label: page.windowsCopied ? "Copied ✓" : "Copy"
                        onClicked: {
                            bridge.copyToClipboard(page.pairResult.install_cmd_windows)
                            page.windowsCopied = true
                            winCopyReset.restart()
                        }
                    }
                }

                Text {
                    Layout.topMargin: 4
                    text: page.pairState === "paired" ? "Paired ✓"
                          : (page.pairState === "expired" ? "Code expired — request a new one"
                          : "Waiting for the machine to check in…")
                    color: page.pairState === "paired" ? Theme.success : Theme.textMuted
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }
            }
        }

        // ---- machines -----------------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true

            Text {
                text: "// MACHINES"
                color: Theme.accent
                font.family: Theme.fontDisplay
                font.pixelSize: 11
                font.letterSpacing: Theme.trackMid
                font.weight: Font.DemiBold
            }

            Text {
                visible: machinesModel.count === 0
                text: "No machines paired yet. Pair one above."
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: 12
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                visible: machinesModel.count > 0

                Repeater {
                    model: machinesModel
                    delegate: Rectangle {
                        id: mrow
                        required property int index
                        required property string mid
                        required property string mname
                        required property string mos
                        required property string mtransport
                        required property string mstatus
                        required property var mlastSeen

                        Layout.fillWidth: true
                        radius: Theme.radiusSm
                        implicitHeight: mrowContent.implicitHeight + 20
                        color: mrow.mid === page.selectedMachine ? Theme.accentFaint : Theme.surface
                        border.width: 1
                        border.color: mrow.mid === page.selectedMachine ? Theme.accent : Theme.hairlineSoft
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        RowLayout {
                            id: mrowContent
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: 12
                            spacing: 10

                            Rectangle {
                                Layout.alignment: Qt.AlignVCenter
                                width: 7; height: 7; radius: 3.5
                                color: mrow.mstatus === "online" ? Theme.success : Theme.textFaint
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                Text {
                                    text: mrow.mname
                                    color: Theme.text
                                    font.family: Theme.fontSans
                                    font.pixelSize: 14
                                    font.weight: Font.Medium
                                }
                                Text {
                                    text: (mrow.mos.length ? mrow.mos : "?") + " · " + mrow.mstatus
                                          + (mrow.mlastSeen ? (" · seen " + page.fmtTime(mrow.mlastSeen)) : "")
                                    color: Theme.textFaint
                                    font.family: Theme.fontMono
                                    font.pixelSize: 11
                                }
                            }

                            Widgets.PillButton {
                                label: "Revoke"
                                danger: true
                                onClicked: bridge.outpostRevoke(mrow.mid)
                            }
                        }

                        MouseArea {
                            anchors.left: parent.left
                            anchors.top: parent.top
                            anchors.bottom: parent.bottom
                            width: parent.width - 90
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.selectedMachine = mrow.mid
                        }
                    }
                }
            }
        }

        // ---- exec console -------------------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true
            Layout.fillHeight: true

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    text: "// EXEC"
                    color: Theme.amber
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Item { Layout.fillWidth: true }
                Text {
                    text: page.selectedMachine.length ? ("→ " + page.selectedName()) : "select a machine"
                    color: page.selectedMachine.length ? Theme.accent : Theme.textFaint
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
                        required property string cmachine
                        required property string cmd
                        required property string output
                        required property bool ok
                        width: ListView.view.width
                        spacing: 2
                        Text {
                            text: "[" + cmachine + "] $ " + cmd
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
                        text: "Command output appears here."
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: 12
                    }
                }
            }

            Image {
                Layout.fillWidth: true
                Layout.preferredHeight: (visible && implicitHeight > 0) ? Math.min(implicitHeight, 320) : 0
                visible: page.shotImage.length > 0
                source: page.shotImage
                fillMode: Image.PreserveAspectFit
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                Widgets.StyledField {
                    id: cmdField
                    Layout.fillWidth: true
                    placeholder: page.selectedMachine.length ? ("Command on " + page.selectedName() + "…") : "Select a machine first…"
                    onAccepted: page.runCmd()
                }
                Widgets.PillButton {
                    label: page.running ? "Running…" : "Run"
                    primary: true
                    busy: page.running
                    enabledBtn: bridge.connected && page.selectedMachine.length > 0
                                && cmdField.text.trim().length > 0 && !page.running
                    onClicked: page.runCmd()
                }
                Widgets.PillButton {
                    label: page.shotBusy ? "…" : "Screenshot"
                    enabledBtn: bridge.connected && page.selectedMachine.length > 0 && !page.shotBusy
                    onClicked: page.takeScreenshot()
                }
            }
        }
    }
}
