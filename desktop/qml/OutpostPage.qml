pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// Outpost page: pair remote Windows/Linux/macOS machines with a one-shot
// install command (outpost.pair_start / pair_status), list paired machines
// (outpost.list) with a Revoke action (outpost.revoke), and run gated exec +
// screenshot on a selected machine (outpost.exec / outpost.screenshot).
// Replaces the old SSH allow-list page — outpost.* verbs already exist and
// respond normally daemon-side, so (unlike the old ssh.* page) there's no
// unknown_method degradation to handle here.
//
// Proxmox Workload Manager (per-machine, opt-in): "Install Workload Mgr"
// (outpost.install_workload) provisions it on a paired Proxmox host; once
// installed, proxmox.status/report/restart_vm/set_blocklist drive the VM
// table + decision-log for the SELECTED machine only. restart_vm is the
// only call that actually bounces a VM, so it's always behind restartConfirm.
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

    // ---- Proxmox Workload Manager state -------------------------------------
    property string installingMachine: ""   // machine with an install in flight

    ListModel { id: vmModel }               // {vmid,vname,vstatus,vcores,vmemMb,vcpuPct,vmemPct,vblocklisted,vpendingRestart,vlastAction,vlastActionAt}
    property string vmMachine: ""           // machine the LAST proxmox.status reply covered
    property string vmError: ""             // human message when that reply failed
    property bool vmBusy: false

    ListModel { id: reportModel }           // {rtext,rtags,rcreated}
    property string reportMachine: ""       // machine the LAST proxmox.report reply covered
    property string reportError: ""
    property bool reportBusy: false

    function refresh() { if (bridge.connected) bridge.outpostList() }
    Component.onCompleted: refresh()

    // Selecting a machine drops any stale VM/report view and (best-effort)
    // re-probes proxmox.status; machines without the workload manager just
    // answer not_a_proxmox_host and the section stays hidden.
    onSelectedMachineChanged: {
        vmModel.clear()
        vmMachine = ""
        vmError = ""
        reportModel.clear()
        reportMachine = ""
        reportError = ""
        if (page.selectedMachine.length > 0) {
            page.vmBusy = true
            bridge.proxmoxStatus(page.selectedMachine)
        }
    }

    function installWorkload(machine) {
        if (machine.length === 0) return
        page.installingMachine = machine
        bridge.outpostInstallWorkload(machine)
    }

    function refreshVmStatus() {
        if (page.selectedMachine.length === 0) return
        page.vmBusy = true
        bridge.proxmoxStatus(page.selectedMachine)
    }

    function getReport() {
        if (page.selectedMachine.length === 0) return
        page.reportBusy = true
        bridge.proxmoxReport(page.selectedMachine)
    }

    // Blocklist is a REPLACE-whole-list call — read the current flags out of
    // vmModel, flip the one row, and send the full resulting vmid list back.
    function toggleBlocklist(vmid) {
        var ids = []
        for (var i = 0; i < vmModel.count; i++) {
            var row = vmModel.get(i)
            var blocked = row.vmid === vmid ? !row.vblocklisted : row.vblocklisted
            if (blocked) ids.push(row.vmid)
        }
        bridge.proxmoxSetBlocklist(page.selectedMachine, ids)
    }

    // created/updated may be epoch seconds or millis; normalize to millis.
    function relTime(ts) {
        if (!ts || ts <= 0) return "—"
        var t = ts < 1e12 ? ts * 1000 : ts
        var diff = Date.now() - t
        if (diff < 0) return "just now"
        if (diff < 60000) return "just now"
        if (diff < 3600000) return Math.floor(diff / 60000) + "m ago"
        if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago"
        return Math.floor(diff / 86400000) + "d ago"
    }

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

        function onOutpostWorkloadInstalled(machine, ok, note, code) {
            if (page.installingMachine === machine)
                page.installingMachine = ""
            // Reuse the exec console as the result toast — it already renders
            // per-machine ok/fail lines with the same color coding.
            consoleModel.append({
                "cmachine": machine,
                "cmd": "install_workload",
                "output": ok ? (note.length ? note : "Installed ✓")
                             : ("[" + (code.length ? code : "error") + "] "
                                + (note.length ? note : "install failed")),
                "ok": ok
            })
            consoleView.positionViewAtEnd()
            if (ok && machine === page.selectedMachine)
                page.refreshVmStatus()   // it's freshly installed — pull its VM table
        }

        function onProxmoxStatusResult(machine, ok, vms, error) {
            if (machine !== page.selectedMachine) return   // stale reply, ignore
            page.vmBusy = false
            page.vmMachine = machine
            page.vmError = ok ? "" : error
            vmModel.clear()
            if (ok) {
                for (var i = 0; i < vms.length; i++) {
                    var v = vms[i]
                    vmModel.append({
                        "vmid": v.vmid !== undefined ? v.vmid : 0,
                        "vname": v.name !== undefined ? v.name : "",
                        "vstatus": v.status !== undefined ? v.status : "",
                        "vcores": v.cores !== undefined ? v.cores : 0,
                        "vmemMb": v.memory_mb !== undefined ? v.memory_mb : 0,
                        "vcpuPct": v.cpu_pct !== undefined ? v.cpu_pct : 0,
                        "vmemPct": v.mem_pct !== undefined ? v.mem_pct : 0,
                        "vblocklisted": v.blocklisted === true,
                        "vpendingRestart": v.pending_restart === true,
                        "vlastAction": v.last_action !== undefined ? v.last_action : "",
                        "vlastActionAt": (v.last_action_at !== undefined && v.last_action_at !== null)
                                         ? v.last_action_at : 0
                    })
                }
            }
        }

        function onProxmoxReportResult(machine, ok, memories, error) {
            if (machine !== page.selectedMachine) return
            page.reportBusy = false
            page.reportMachine = machine
            page.reportError = ok ? "" : error
            reportModel.clear()
            if (ok) {
                for (var j = 0; j < memories.length; j++) {
                    var mrec = memories[j]
                    reportModel.append({
                        "rtext": mrec.text !== undefined ? mrec.text : "",
                        "rtags": (mrec.tags !== undefined && mrec.tags.length > 0)
                                 ? mrec.tags.join(", ") : "",
                        "rcreated": mrec.created !== undefined ? mrec.created : 0
                    })
                }
            }
        }

        function onProxmoxVmRestarted(machine, vmid, ok, error) {
            consoleModel.append({
                "cmachine": machine,
                "cmd": "restart_vm " + vmid,
                "output": ok ? "Restart requested ✓" : ("(failed) " + error),
                "ok": ok
            })
            consoleView.positionViewAtEnd()
            if (ok && machine === page.selectedMachine)
                page.refreshVmStatus()   // pick up the new status/pending_restart flag
        }

        function onProxmoxBlocklistSet(machine, ok, vmids, error) {
            if (!ok) {
                consoleModel.append({
                    "cmachine": machine,
                    "cmd": "set_blocklist",
                    "output": "(failed) " + error,
                    "ok": false
                })
                consoleView.positionViewAtEnd()
                return
            }
            if (machine === page.selectedMachine)
                page.refreshVmStatus()   // vmModel's blocklisted flags come from the daemon, not us
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

                            RowLayout {
                                id: actionsRow
                                spacing: 8

                                Widgets.PillButton {
                                    label: page.installingMachine === mrow.mid ? "Installing…" : "Install Proxmox Workload Manager"
                                    busy: page.installingMachine === mrow.mid
                                    enabledBtn: bridge.connected && page.installingMachine !== mrow.mid
                                    onClicked: page.installWorkload(mrow.mid)
                                }
                                Widgets.PillButton {
                                    label: "Revoke"
                                    danger: true
                                    onClicked: bridge.outpostRevoke(mrow.mid)
                                }
                            }
                        }

                        MouseArea {
                            anchors.left: parent.left
                            anchors.top: parent.top
                            anchors.bottom: parent.bottom
                            anchors.right: actionsRow.left
                            anchors.rightMargin: 8
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.selectedMachine = mrow.mid
                        }
                    }
                }
            }
        }

        // ---- Proxmox Workload Manager -------------------------------------------
        Widgets.SectionCard {
            Layout.fillWidth: true
            visible: page.vmMachine === page.selectedMachine && page.selectedMachine.length > 0

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    text: "// PROXMOX WORKLOAD MANAGER"
                    color: Theme.violet
                    font.family: Theme.fontDisplay
                    font.pixelSize: 11
                    font.letterSpacing: Theme.trackMid
                    font.weight: Font.DemiBold
                }
                Text {
                    Layout.fillWidth: true
                    text: page.selectedMachine.length ? ("→ " + page.selectedName()) : ""
                    color: Theme.textFaint
                    font.family: Theme.fontMono
                    font.pixelSize: 11
                }
                Widgets.PillButton {
                    label: page.vmBusy ? "…" : "Refresh"
                    enabledBtn: bridge.connected && !page.vmBusy
                    onClicked: page.refreshVmStatus()
                }
                Widgets.PillButton {
                    label: page.reportBusy ? "…" : "Get report"
                    enabledBtn: bridge.connected && !page.reportBusy
                    onClicked: page.getReport()
                }
            }

            Text {
                visible: vmModel.count === 0 && page.vmError.length > 0
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                text: "Not available: " + page.vmError
                color: Theme.danger
                font.family: Theme.fontSans
                font.pixelSize: 12
            }

            Text {
                visible: vmModel.count === 0 && page.vmError.length === 0
                text: "No VMs reported."
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: 12
            }

            // ---- VM table --------------------------------------------------------
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 6
                visible: vmModel.count > 0

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Text { Layout.preferredWidth: 40;  text: "VMID"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.fillWidth: true;      text: "NAME"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 70;  text: "STATUS"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 46;  text: "CORES"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 66;  text: "MEM MB"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 50;  text: "CPU%"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 50;  text: "MEM%"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Text { Layout.preferredWidth: 70;  text: "BLOCKED"; color: Theme.textFaint; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: Theme.trackWide }
                    Item { Layout.preferredWidth: 74 }
                }

                Repeater {
                    model: vmModel
                    delegate: Rectangle {
                        id: vrow
                        required property int index
                        required property int vmid
                        required property string vname
                        required property string vstatus
                        required property int vcores
                        required property int vmemMb
                        required property real vcpuPct
                        required property real vmemPct
                        required property bool vblocklisted
                        required property bool vpendingRestart
                        required property string vlastAction
                        required property var vlastActionAt

                        Layout.fillWidth: true
                        radius: Theme.radiusSm
                        implicitHeight: vrowContent.implicitHeight + 16
                        color: Theme.surface
                        border.width: 1
                        border.color: vrow.vpendingRestart ? Theme.amberDim : Theme.hairlineSoft

                        ColumnLayout {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: 8
                            spacing: 2

                            RowLayout {
                                id: vrowContent
                                Layout.fillWidth: true
                                spacing: 8

                                Text { Layout.preferredWidth: 40; text: "" + vrow.vmid; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                                Text { Layout.fillWidth: true; text: vrow.vname; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; elide: Text.ElideRight }
                                Text {
                                    Layout.preferredWidth: 70
                                    text: vrow.vstatus
                                    color: vrow.vstatus === "running" ? Theme.success : Theme.textFaint
                                    font.family: Theme.fontMono
                                    font.pixelSize: 12
                                }
                                Text { Layout.preferredWidth: 46; text: "" + vrow.vcores; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                                Text { Layout.preferredWidth: 66; text: "" + vrow.vmemMb; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                                Text { Layout.preferredWidth: 50; text: vrow.vcpuPct.toFixed(0) + "%"; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                                Text { Layout.preferredWidth: 50; text: vrow.vmemPct.toFixed(0) + "%"; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 12 }
                                Item {
                                    Layout.preferredWidth: 70
                                    Layout.fillHeight: true
                                    Widgets.StyledSwitch {
                                        anchors.verticalCenter: parent.verticalCenter
                                        checked: vrow.vblocklisted
                                        onToggled: page.toggleBlocklist(vrow.vmid)
                                    }
                                }
                                Widgets.PillButton {
                                    Layout.preferredWidth: 74
                                    label: "Restart"
                                    danger: true
                                    onClicked: restartConfirm.openFor(page.selectedMachine, vrow.vmid, vrow.vname)
                                }
                            }

                            Text {
                                visible: vrow.vpendingRestart
                                text: "⚠ pending restart"
                                        + (vrow.vlastAction.length ? (" · last action: " + vrow.vlastAction) : "")
                                        + (vrow.vlastActionAt ? (" · " + page.relTime(vrow.vlastActionAt)) : "")
                                color: Theme.amber
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
                        }
                    }
                }
            }

            // ---- decision-history report (proxmox.report) ------------------------
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 6
                visible: page.reportMachine === page.selectedMachine

                Text {
                    text: "DECISION LOG"
                    color: Theme.textFaint
                    font.family: Theme.fontDisplay
                    font.pixelSize: 10
                    font.letterSpacing: Theme.trackMid
                }

                Text {
                    visible: reportModel.count === 0 && page.reportError.length > 0
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    text: page.reportError
                    color: Theme.danger
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }
                Text {
                    visible: reportModel.count === 0 && page.reportError.length === 0
                    text: "No entries yet."
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: 12
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(reportList.contentHeight + 16, 220)
                    visible: reportModel.count > 0
                    radius: Theme.radiusSm
                    color: Theme.surfaceDeep
                    border.width: 1
                    border.color: Theme.hairlineSoft
                    clip: true

                    ListView {
                        id: reportList
                        anchors.fill: parent
                        anchors.margins: 10
                        clip: true
                        spacing: 8
                        model: reportModel
                        boundsBehavior: Flickable.StopAtBounds
                        ScrollBar.vertical: ScrollBar {
                            policy: ScrollBar.AsNeeded; width: 5
                            background: Item {}
                            contentItem: Rectangle { implicitWidth: 4; radius: 2; color: Theme.hairline; opacity: 0.5 }
                        }
                        delegate: ColumnLayout {
                            required property int index
                            required property string rtext
                            required property string rtags
                            required property real rcreated
                            width: ListView.view.width
                            spacing: 2
                            Text {
                                Layout.fillWidth: true
                                text: rtext
                                color: Theme.text
                                font.family: Theme.fontSans
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                lineHeight: 1.3
                            }
                            Text {
                                text: (rtags.length ? (rtags + " · ") : "") + page.relTime(rcreated)
                                color: Theme.textFaint
                                font.family: Theme.fontMono
                                font.pixelSize: 10
                            }
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

    // ===== RESTART VM confirm dialog (mirrors ComputerPage's take-over confirm) =====
    // proxmox.restart_vm is the ONLY call that bounces a VM — never fire it without
    // this gate, and never as a side effect of a status refresh.
    Popup {
        id: restartConfirm
        anchors.centerIn: Overlay.overlay
        width: Math.min(page.width - 60, 420)
        modal: true
        focus: true
        padding: 0
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        property string machine: ""
        property int vmid: 0
        property string vmName: ""
        function openFor(machine_, vmid_, name_) { machine = machine_; vmid = vmid_; vmName = name_; open() }

        background: Rectangle {
            radius: Theme.radius
            color: Qt.rgba(0.039, 0.071, 0.110, 0.98)
            border.color: Theme.amberDim
            border.width: 1
            Rectangle {
                anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: 16; anchors.rightMargin: 16; anchors.topMargin: 1
                height: 2; radius: 1
                color: Theme.amber
                layer.enabled: true
                layer.effect: MultiEffect { blurEnabled: true; blur: 0.6; blurMax: 12; brightness: 0.2 }
            }
        }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.6) }

        contentItem: ColumnLayout {
            spacing: 0
            ColumnLayout {
                Layout.fillWidth: true
                Layout.margins: 22
                spacing: 14

                RowLayout {
                    spacing: 10
                    Text { text: "⚠"; color: Theme.amber; font.pixelSize: 20 }
                    Text {
                        text: "RESTART VM"
                        color: Theme.amber
                        font.family: Theme.fontDisplay
                        font.pixelSize: 15
                        font.weight: Font.DemiBold
                        font.letterSpacing: Theme.trackMid
                    }
                }
                Text {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    text: "This restarts VM " + restartConfirm.vmid + " (" + restartConfirm.vmName + ") on "
                          + restartConfirm.machine + " right now. Anything running on it drops immediately."
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 13
                    lineHeight: 1.4
                }
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 4
                    spacing: 10
                    Item { Layout.fillWidth: true }
                    Widgets.PillButton { label: "Cancel"; onClicked: restartConfirm.close() }
                    Widgets.PillButton {
                        label: "Restart VM"
                        primary: true
                        onClicked: {
                            bridge.proxmoxRestartVm(restartConfirm.machine, restartConfirm.vmid)
                            restartConfirm.close()
                        }
                    }
                }
            }
        }
    }
}
