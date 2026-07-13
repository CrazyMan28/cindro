pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import CindroSidebar

// PERMISSIONS tab — "what Cindro may do over the phone" (PhonePolicyStore).
// One card per capability; the capability's choices render as selectable chips.
// Each card carries an honest ENFORCED vs GUIDANCE badge: outbound tool actions
// (send SMS / calls / spend / memory) are HARD-gated at the daemon phone.mcp
// choke point + the engine gate; answer-policy is enforced via call screening;
// the inbound-agent capabilities (computer_use_on_call / access_files) are
// GUIDANCE only because the vendored phone server has no daemon choke point.
// Wired to bridge.phonePolicyList/Set/Reset -> phonePolicyResult(callId,result).
Item {
    id: tab
    property var phonePage

    // ---- async helpers --------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0
    property bool loading: false
    property string statusLine: ""

    ListModel { id: capsModel }   // {cid,label,value,enforcement,note,choices,labels}

    function _tag(cb) {
        var id = "perm_" + (++tab._seq)
        tab._pending[id] = cb || null
        return id
    }

    Connections {
        target: bridge
        function onPhonePolicyResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
    }

    function refresh() {
        if (!bridge.connected) return
        tab.loading = true; tab.statusLine = ""
        bridge.phonePolicyList(tab._tag(function(r) { tab.loading = false; tab._apply(r) }))
    }
    function setCap(id, value) {
        tab.statusLine = "Saving…"
        bridge.phonePolicySet(tab._tag(function(r) { tab._apply(r) }), id, value)
    }
    function resetAll() {
        tab.statusLine = "Resetting…"
        bridge.phonePolicyReset(tab._tag(function(r) { tab._apply(r) }))
    }

    function _apply(r) {
        if (r && r.error) {
            tab.statusLine = "Error: " + (r.error.message || r.error.code || "unknown")
            return
        }
        tab.statusLine = ""
        var caps = (r && r.capabilities) ? r.capabilities : []
        capsModel.clear()
        for (var i = 0; i < caps.length; i++) {
            var c = caps[i]
            capsModel.append({
                "cid":         c.id    || "",
                "label":       c.label || c.id || "",
                "value":       c.value || "",
                "enforcement": c.enforcement || "soft",
                "note":        c.note  || "",
                "choices":     JSON.stringify(c.choices || []),
                "labels":      JSON.stringify(c.choiceLabels || [])
            })
        }
    }

    // ---- UI -------------------------------------------------------------------
    Flickable {
        anchors.fill: parent
        contentWidth: width; contentHeight: _col.implicitHeight + 24; clip: true
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        ColumnLayout {
            id: _col
            width: parent.width; spacing: 14

            // header row
            RowLayout {
                Layout.fillWidth: true; spacing: 8
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 2
                    Text {
                        text: "WHAT CINDRO MAY DO OVER THE PHONE"
                        color: Theme.textFaint; font.family: Theme.fontDisplay
                        font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                    }
                    Text {
                        text: "Deny blocks the action; Ask requires your approval first."
                        color: Theme.textMuted; font.family: Theme.fontSans; font.pixelSize: 10
                    }
                }
                Rectangle {
                    height: 28; implicitWidth: _resetLbl.implicitWidth + 16; radius: Theme.radiusXs
                    color: _resetMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                    border.color: Theme.hairlineSoft; border.width: 1
                    Text { id: _resetLbl; anchors.centerIn: parent; text: "RESET"; color: Theme.textMuted
                           font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                    MouseArea { id: _resetMa; anchors.fill: parent; hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor; onClicked: tab.resetAll() }
                }
            }

            // status / feedback line
            Text {
                visible: tab.statusLine.length > 0
                text: tab.statusLine
                color: tab.statusLine.indexOf("Error") >= 0 ? Theme.danger : Theme.accent
                font.family: Theme.fontMono; font.pixelSize: 10; Layout.fillWidth: true
            }

            // loading / empty — only when there are no cards yet, so a re-refresh
            // over already-loaded capabilities doesn't flash the spinner on top.
            Item {
                Layout.fillWidth: true; Layout.preferredHeight: 80
                visible: capsModel.count === 0
                ColumnLayout {
                    anchors.centerIn: parent; spacing: 8
                    ArcReactor { size: 44; tint: Theme.textFaint; spinning: tab.loading
                                 Layout.alignment: Qt.AlignHCenter }
                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: tab.loading ? "Loading permissions…" : "No phone permissions loaded."
                        color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 12
                    }
                }
            }

            // capability cards
            Repeater {
                model: capsModel
                delegate: Rectangle {
                    id: _card
                    required property string cid
                    required property string label
                    required property string value
                    required property string enforcement
                    required property string note
                    required property string choices
                    required property string labels

                    property var _choices: JSON.parse(choices)
                    property var _labels:  JSON.parse(labels)
                    function _labelFor(v) {
                        for (var i = 0; i < _labels.length; i++)
                            if (_labels[i].value === v) return _labels[i].label
                        return v
                    }
                    property bool _hard: enforcement === "hard" || enforcement === "config"

                    Layout.fillWidth: true
                    height: _cardCol.implicitHeight + 24
                    color: Theme.surface; radius: Theme.radiusSm
                    border.color: Theme.hairlineSoft; border.width: 1

                    ColumnLayout {
                        id: _cardCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 8

                        // title row + enforcement badge
                        RowLayout {
                            Layout.fillWidth: true; spacing: 8
                            Text {
                                text: _card.label; color: Theme.text
                                font.family: Theme.fontSans; font.pixelSize: 13; font.weight: Font.Medium
                                Layout.fillWidth: true; elide: Text.ElideRight
                            }
                            Rectangle {
                                height: 16; implicitWidth: _badgeLbl.implicitWidth + 12; radius: 8
                                color: _card._hard ? Qt.rgba(0.22,0.90,0.63,0.18) : Qt.rgba(0.98,0.75,0.30,0.16)
                                Text {
                                    id: _badgeLbl; anchors.centerIn: parent
                                    text: _card._hard ? "ENFORCED" : "GUIDANCE"
                                    color: _card._hard ? Theme.success : Theme.warn
                                    font.family: Theme.fontDisplay; font.pixelSize: 7; font.letterSpacing: 0.8
                                }
                            }
                        }

                        // note
                        Text {
                            visible: _card.note.length > 0
                            text: _card.note; color: Theme.textMuted
                            font.family: Theme.fontSans; font.pixelSize: 10
                            wrapMode: Text.WordWrap; Layout.fillWidth: true
                        }

                        // choice chips
                        Flow {
                            Layout.fillWidth: true; spacing: 6
                            Repeater {
                                model: _card._choices
                                delegate: Rectangle {
                                    required property var modelData
                                    property string _v: modelData
                                    property bool _sel: _card.value === _v
                                    height: 28; implicitWidth: _chipLbl.implicitWidth + 20; radius: Theme.radiusXs
                                    color: _sel ? Qt.rgba(0.239,0.839,1.0,0.20)
                                               : (_chipMa.containsMouse ? Qt.rgba(1,1,1,0.08) : Theme.surfaceStrong)
                                    border.color: _sel ? Theme.accent : Theme.hairlineSoft; border.width: 1
                                    Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                    Text {
                                        id: _chipLbl; anchors.centerIn: parent; text: _card._labelFor(parent._v)
                                        color: parent._sel ? Theme.accent : Theme.textMuted
                                        font.family: Theme.fontSans; font.pixelSize: 11
                                    }
                                    MouseArea {
                                        id: _chipMa; anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        property string vv: parent._v
                                        onClicked: if (!parent._sel) tab.setCap(_card.cid, vv)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Item { Layout.preferredHeight: 12 }
        }
    }
}
