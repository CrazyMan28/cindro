pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CindroSidebar

// PHONE HUB — desktop surface for the agent-phone subsystem.
//
// Six tabs:  CALLS (real dialer + quick-chips + active calls),
//            AGENTS (live roster + per-agent voice/model config),
//            INBOX (thread list + compose),
//            HUD (ops dashboard + Red Alert),
//            SETTINGS (SMS agent, call screening, carrier forwarding incl.
//                      Verizon *72/*73, allowlist, diagnostics, history,
//                      add-agent),
//            SCREENING (live caller/agent transcript while a carrier call is
//                       being screened by an AI agent).
//
// Every action goes through bridge.phoneMcp(callId, tool, args) and is
// dispatched back via bridge.phoneResult(callId, result).  Each tab owns its
// own pending-call map and callTool() helper so they are fully self-contained.
Item {
    id: page

    // ---- page-level busy indicator (dialer in flight) ----------------------
    property bool callerBusy: false

    // ---- tab state ---------------------------------------------------------
    property int tabIndex: 0   // 0=CALLS 1=AGENTS 2=INBOX 3=HUD 4=SETTINGS 5=SCREENING
    readonly property var _tabLabels: ["CALLS","AGENTS","INBOX","HUD","SETTINGS","SCREENING"]

    function onTabActivated(idx) {
        if (!bridge.connected) return
        switch (idx) {
        case 0: dialerTab.refresh(); break
        case 1: agentsTab.refresh(); break
        case 2: inboxTab.refresh();  break
        case 3: hudTab.refresh();    break
        case 4: settingsTab.refresh(); break
        case 5: screeningTab.refresh(); break
        }
    }

    onVisibleChanged: { if (visible && bridge.connected) onTabActivated(tabIndex) }
    Component.onCompleted: { if (bridge.connected) onTabActivated(tabIndex) }

    Connections {
        target: bridge
        function onConnectedChanged() {
            if (bridge.connected) page.onTabActivated(page.tabIndex)
        }
    }

    // =========================================================================
    // UI layout
    // =========================================================================
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 18
        spacing: 14

        // ---- header ---------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            ArcReactor {
                size: 28; Layout.alignment: Qt.AlignVCenter
                tint: Theme.accent; thinking: page.callerBusy
            }
            ColumnLayout {
                Layout.fillWidth: true; spacing: 2
                Text {
                    text: "PHONE HUB"
                    color: Theme.accent; font.family: Theme.fontDisplay
                    font.pixelSize: 18; font.letterSpacing: Theme.trackWide; font.weight: Font.Bold
                }
                Text {
                    text: "Dialer · Agents · Inbox · Ops HUD · Settings · Screening"
                    color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 11
                }
            }
        }

        // ---- tab bar --------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true; spacing: 6

            Repeater {
                model: page._tabLabels
                delegate: Rectangle {
                    required property int    index
                    required property string modelData
                    height: 30; implicitWidth: _tl.implicitWidth + 24; radius: Theme.radiusXs
                    color: page.tabIndex === index ? Theme.accentDim
                                                   : (_tma.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                    border.color: page.tabIndex === index ? Theme.accent : Theme.hairlineSoft; border.width: 1
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    Text {
                        id: _tl; anchors.centerIn: parent; text: modelData
                        color: page.tabIndex === parent.index ? Theme.accentBright : Theme.textMuted
                        font.family: Theme.fontDisplay; font.pixelSize: 10
                        font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                    }
                    MouseArea {
                        id: _tma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: { page.tabIndex = parent.index; page.onTabActivated(parent.index) }
                    }
                }
            }

            Item { Layout.fillWidth: true }

            // refresh button
            Rectangle {
                width: 30; height: 30; radius: Theme.radiusXs
                color: _rma.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent"
                border.color: Theme.hairlineSoft; border.width: 1
                Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 14 }
                MouseArea {
                    id: _rma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                    onClicked: page.onTabActivated(page.tabIndex)
                }
            }
        }

        // ---- tab content ----------------------------------------------------
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            PhoneDialerTab   { id: dialerTab;    anchors.fill: parent; visible: page.tabIndex === 0; phonePage: page }
            PhoneAgentsTab   { id: agentsTab;    anchors.fill: parent; visible: page.tabIndex === 1; phonePage: page }
            PhoneInboxTab    { id: inboxTab;     anchors.fill: parent; visible: page.tabIndex === 2; phonePage: page }
            PhoneHudTab      { id: hudTab;       anchors.fill: parent; visible: page.tabIndex === 3; phonePage: page }
            PhoneSettingsTab { id: settingsTab;  anchors.fill: parent; visible: page.tabIndex === 4; phonePage: page }
            PhoneScreeningTab { id: screeningTab; anchors.fill: parent; visible: page.tabIndex === 5; phonePage: page }

            // Incoming / active call overlay — sits on top of all tabs.
            // Polls list_active_calls and becomes visible whenever a call is live.
            PhoneCallOverlay { id: callOverlay; anchors.fill: parent }
        }
    }
}
