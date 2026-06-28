pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// INBOX tab — SMS/agent thread list with priority badges, thread detail view,
// compose notification panel, and new-chat dialog (agent picker + first message
// + optional group/conference).
Item {
    id: tab
    property var phonePage

    // ---- async helper ---------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    function callTool(tool, args, cb) {
        var id = "inbox_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
    }

    // ---- state ----------------------------------------------------------------
    ListModel { id: threadModel }
    property string threadText:    ""
    property string openThreadId:  ""
    property string threadSubject: ""
    property bool   showNewChat:   false

    // ---- functions ------------------------------------------------------------
    function refresh() {
        tab.callTool("list_inbox", { limit: 40 }, function(r) {
            var arr = r.data instanceof Array ? r.data
                    : (r.data && r.data.messages instanceof Array ? r.data.messages : [])
            threadModel.clear()
            for (var i = 0; i < arr.length; i++) {
                var m = arr[i]
                threadModel.append({
                    "tid":     m.thread_id   !== undefined ? ("" + m.thread_id)   : (m.id !== undefined ? ("" + m.id) : ""),
                    "subject": m.subject     !== undefined ? m.subject             : (m.title || "(untitled)"),
                    "preview": m.preview     !== undefined ? m.preview             : (m.message || ""),
                    "priority":m.priority    !== undefined ? m.priority            : "normal",
                    "unread":  m.unread_count !== undefined ? m.unread_count       : 0,
                    "ts":      m.created_at  !== undefined ? ("" + m.created_at)  : ""
                })
            }
        })
    }

    function loadThread(tid, subject) {
        tab.openThreadId  = tid
        tab.threadSubject = subject
        tab.threadText    = "Loading…"
        tab.callTool("get_thread_messages", { thread_id: tid }, function(r) {
            if (r.error) { tab.threadText = "Error: " + (r.error.message || "?"); return }
            var d   = r.data || {}
            var msgs = d.messages instanceof Array ? d.messages : []
            var lines = []
            for (var i = 0; i < msgs.length; i++) {
                var m   = msgs[i]
                var who = m.from_extension !== undefined ? ("ext " + m.from_extension) : "agent"
                lines.push("[" + who + "] " + (m.message || m.content || m.text || ""))
            }
            tab.threadText = lines.length > 0 ? lines.join("\n") : "(empty thread)"
        })
    }

    function sendNotify(title, msg, priority) {
        tab.callTool("notify_user", { title: title, message: msg, priority: priority }, function(r) {
            notifyStatus.text = r.error ? ("Error: " + (r.error.message || "?")) : "Sent"
            if (!r.error) tab.refresh()
        })
    }

    // ---- UI -------------------------------------------------------------------
    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        // header row
        RowLayout {
            Layout.fillWidth: true
            Text {
                text: "CHATS"; color: Theme.textFaint
                font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
                Layout.fillWidth: true
            }
            Rectangle {
                width: 26; height: 26; radius: Theme.radiusXs
                color: _rInboxMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                border.color: Theme.hairlineSoft; border.width: 1
                Text { anchors.centerIn: parent; text: "↺"; color: Theme.textMuted; font.pixelSize: 13 }
                MouseArea { id: _rInboxMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.refresh() }
            }
            Item { width: 6 }
            Rectangle {
                width: 26; height: 26; radius: Theme.radiusXs
                color: _newChatMa.containsMouse ? Theme.accentDim : "transparent"
                border.color: Theme.accentDim; border.width: 1
                Text { anchors.centerIn: parent; text: "+"; color: Theme.accent; font.pixelSize: 16 }
                MouseArea { id: _newChatMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.showNewChat = true }
            }
        }

        // ── thread list ───────────────────────────────────────────────────────
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: tab.threadText.length === 0
            Layout.preferredHeight: tab.threadText.length > 0 ? 200 : -1

            // empty state
            ColumnLayout {
                anchors.centerIn: parent; spacing: 10
                visible: threadModel.count === 0
                Text {
                    Layout.alignment: Qt.AlignHCenter; text: "📥"
                    font.pixelSize: 36; color: Theme.textFaint
                }
                Text {
                    Layout.alignment: Qt.AlignHCenter; text: "No messages yet"
                    color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 12
                }
            }

            ListView {
                anchors.fill: parent
                visible: threadModel.count > 0
                model: threadModel; spacing: 8; clip: true

                delegate: Rectangle {
                    id: _tRow
                    required property string tid
                    required property string subject
                    required property string preview
                    required property string priority
                    required property int    unread
                    required property string ts
                    property color _pColor: _tRow.priority === "critical" ? Theme.danger
                                          : _tRow.priority === "urgent"   ? Theme.amber
                                          : _tRow.priority === "low"      ? Theme.textFaint : Theme.accent

                    width: ListView.view.width; height: _tRowContent.implicitHeight + 20
                    radius: Theme.radiusSm
                    color: _tMa.containsMouse ? Theme.surfaceStrong : Theme.surface
                    border.color: Theme.hairlineSoft; border.width: 1
                    Behavior on color { ColorAnimation { duration: Theme.durFast } }

                    RowLayout {
                        id: _tRowContent
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                        spacing: 12

                        // avatar circle
                        Rectangle {
                            width: 40; height: 40; radius: 20
                            color: Qt.rgba(_tRow._pColor.r, _tRow._pColor.g, _tRow._pColor.b, 0.16)
                            Text {
                                anchors.centerIn: parent; text: _tRow.tid.slice(0,2).toUpperCase()
                                color: _tRow._pColor; font.family: Theme.fontDisplay; font.pixelSize: 12; font.weight: Font.Bold
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true; spacing: 3
                            RowLayout {
                                spacing: 4
                                Text {
                                    text: _tRow.subject; color: Theme.text
                                    font.family: Theme.fontSans; font.pixelSize: 12; font.weight: Font.Medium
                                    elide: Text.ElideRight; Layout.fillWidth: true
                                }
                                Text {
                                    text: _tRow.ts.length > 5 ? _tRow.ts.slice(-8).slice(0,5) : _tRow.ts
                                    color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 9
                                }
                            }
                            Text {
                                text: _tRow.preview; color: Theme.textMuted
                                font.family: Theme.fontSans; font.pixelSize: 10
                                elide: Text.ElideRight; Layout.fillWidth: true
                                maximumLineCount: 2
                            }
                        }

                        // unread badge
                        Rectangle {
                            width: 22; height: 22; radius: 11
                            visible: _tRow.unread > 0
                            color: _tRow._pColor
                            Text {
                                anchors.centerIn: parent
                                text: _tRow.unread > 9 ? "9+" : ("" + _tRow.unread)
                                color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 9; font.weight: Font.Bold
                            }
                        }
                    }

                    MouseArea {
                        id: _tMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        property string _tid:     _tRow.tid
                        property string _subject: _tRow.subject
                        onClicked: tab.loadThread(_tid, _subject)
                    }
                }
            }
        }

        // ── thread detail panel ───────────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            height: _threadPanelCol.implicitHeight + 20
            visible: tab.threadText.length > 0
            color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
            ColumnLayout {
                id: _threadPanelCol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
                spacing: 6
                RowLayout {
                    Layout.fillWidth: true
                    Text { text: tab.threadSubject.length > 0 ? tab.threadSubject : "Thread"; color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium; Layout.fillWidth: true }
                    Rectangle {
                        width: 22; height: 22; radius: 4
                        color: _closeTrMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                        Text { anchors.centerIn: parent; text: "✕"; color: Theme.textMuted; font.pixelSize: 10 }
                        MouseArea { id: _closeTrMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { tab.threadText = ""; tab.openThreadId = "" } }
                    }
                }
                Flickable {
                    Layout.fillWidth: true; height: 90
                    contentWidth: width; contentHeight: _trTxtInbox.implicitHeight; clip: true
                    Text { id: _trTxtInbox; width: parent.width; text: tab.threadText; color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 10; wrapMode: Text.WrapAnywhere }
                }
            }
        }

        // ── compose notification ──────────────────────────────────────────────
        Text {
            text: "COMPOSE NOTIFICATION"; color: Theme.textFaint
            font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 2.0; font.weight: Font.DemiBold
        }
        Rectangle {
            Layout.fillWidth: true; height: _composeCol.implicitHeight + 24
            color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1
            ColumnLayout {
                id: _composeCol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
                spacing: 8
                TextField {
                    id: _nTitle; Layout.fillWidth: true; placeholderText: "Title"
                    background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _nTitle.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; rightPadding: 10; height: 32
                }
                TextField {
                    id: _nMsg; Layout.fillWidth: true; placeholderText: "Message"
                    background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _nMsg.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; rightPadding: 10; height: 32
                }
                RowLayout {
                    spacing: 6
                    Repeater {
                        model: ["low","normal","urgent","critical"]
                        delegate: Rectangle {
                            required property string modelData
                            property string _p: modelData
                            height: 24; implicitWidth: _pLbl.implicitWidth + 16; radius: Theme.radiusXs
                            color: _nPriority.value === _p ? Theme.accentDim : (_pMa.containsMouse ? Qt.rgba(1,1,1,0.05) : "transparent")
                            border.color: _nPriority.value === _p ? Theme.accent : Theme.hairlineSoft; border.width: 1
                            Text { id: _pLbl; anchors.centerIn: parent; text: parent._p.toUpperCase(); color: _nPriority.value === parent._p ? Theme.accentBright : Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.6 }
                            MouseArea { id: _pMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: _nPriority.value = parent._p }
                        }
                    }
                    QtObject { id: _nPriority; property string value: "normal" }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        height: 28; implicitWidth: _sendLbl.implicitWidth + 22; radius: Theme.radiusXs
                        color: _sendMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _sendLbl; anchors.centerIn: parent; text: "SEND"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 10; font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold }
                        MouseArea { id: _sendMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { if (_nTitle.text.trim() || _nMsg.text.trim()) tab.sendNotify(_nTitle.text, _nMsg.text, _nPriority.value) } }
                    }
                }
                Text { id: notifyStatus; text: ""; visible: text.length > 0; color: Theme.success; font.family: Theme.fontMono; font.pixelSize: 10 }
            }
        }

        Item { height: 16 }
    }

    // ── new-chat dialog ────────────────────────────────────────────────────────
    Rectangle {
        anchors.fill: parent
        visible: tab.showNewChat
        color: Qt.rgba(0,0,0,0.6)

        property var  _agents: []
        property var  _selected: []

        Connections {
            target: tab
            function onShowNewChatChanged() {
                if (tab.showNewChat) {
                    parent._agents = []; parent._selected = []
                    _ncMsg.text = ""
                    tab.callTool("list_extensions", {}, function(r) {
                        var arr = r.data instanceof Array ? r.data : []
                        var out = []
                        for (var i = 0; i < arr.length; i++) {
                            var a = arr[i]
                            out.push({ ext: ("" + (a.extension || a.ext || "")), nm: (a.name || "Agent") })
                        }
                        parent._agents = out
                        if (out.length > 0) parent._selected = [out[0].ext]
                    })
                }
            }
        }

        MouseArea { anchors.fill: parent; onClicked: tab.showNewChat = false }

        Rectangle {
            anchors.centerIn: parent; width: Math.min(parent.width - 60, 400)
            height: _ncCol.implicitHeight + 40; radius: Theme.radiusSm
            color: Theme.surfaceStrong; border.color: Theme.hairlineSoft; border.width: 1

            MouseArea { anchors.fill: parent } // block click-through

            ColumnLayout {
                id: _ncCol
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 20 }
                spacing: 10

                Text {
                    text: parent.parent.parent._selected.length > 1
                        ? "New group chat · " + parent.parent.parent._selected.length : "New chat"
                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 14; font.weight: Font.Medium
                }

                Text { text: "Tap one or more agents"; color: Theme.textFaint; font.family: Theme.fontSans; font.pixelSize: 11 }

                Repeater {
                    model: parent.parent.parent._agents
                    delegate: Rectangle {
                        required property var modelData
                        property string _ext: modelData.ext
                        property string _nm:  modelData.nm
                        property bool   _sel: parent.parent.parent._selected.indexOf(_ext) >= 0
                        Layout.fillWidth: true; height: 38; radius: Theme.radiusXs
                        color: _sel ? Qt.rgba(0.239,0.839,1.0,0.18) : (_ncAgMa.containsMouse ? Qt.rgba(1,1,1,0.06) : Theme.surface)
                        border.color: _sel ? Theme.accent : Theme.hairlineSoft; border.width: 1
                        RowLayout {
                            anchors { fill: parent; margins: 10 }
                            Text { text: _sel ? "✓" : "○"; color: _sel ? Theme.accent : Theme.textFaint; font.pixelSize: 14 }
                            Text { text: parent.parent._nm + "  ·  " + parent.parent._ext; color: _sel ? Theme.accent : Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; Layout.fillWidth: true }
                        }
                        MouseArea {
                            id: _ncAgMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                var sel = parent.parent.parent._selected.slice()
                                var idx = sel.indexOf(parent._ext)
                                if (idx >= 0) sel.splice(idx, 1); else sel.push(parent._ext)
                                parent.parent.parent._selected = sel
                            }
                        }
                    }
                }

                TextField {
                    id: _ncMsg; Layout.fillWidth: true
                    placeholderText: "First message…"
                    background: Rectangle { color: Theme.surfaceInput; radius: Theme.radiusXs; border.color: _ncMsg.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1 }
                    color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 12; leftPadding: 10; height: 34
                }

                RowLayout {
                    spacing: 8
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        height: 30; implicitWidth: _ncCancelLbl.implicitWidth + 20; radius: Theme.radiusXs
                        color: _ncCancelMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"; border.color: Theme.hairlineSoft; border.width: 1
                        Text { id: _ncCancelLbl; anchors.centerIn: parent; text: "CANCEL"; color: Theme.textMuted; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                        MouseArea { id: _ncCancelMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tab.showNewChat = false }
                    }
                    Rectangle {
                        height: 30; implicitWidth: _ncCallLbl.implicitWidth + 20; radius: Theme.radiusXs
                        color: _ncCallMa.containsMouse ? Theme.accentDim : "transparent"; border.color: Theme.accentDim; border.width: 1
                        Text { id: _ncCallLbl; anchors.centerIn: parent; text: "📞 CALL"; color: Theme.accent; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8 }
                        MouseArea {
                            id: _ncCallMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                var sel = parent.parent.parent.parent._selected
                                if (sel.length === 0) return
                                tab.callTool("call_extension", { extension: sel[0] }, function(r) {})
                                tab.showNewChat = false
                            }
                        }
                    }
                    Rectangle {
                        height: 30; implicitWidth: _ncSendLbl.implicitWidth + 20; radius: Theme.radiusXs
                        color: _ncSendMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text { id: _ncSendLbl; anchors.centerIn: parent; text: "START"; color: Theme.inkOnAccent; font.family: Theme.fontDisplay; font.pixelSize: 9; font.letterSpacing: 0.8; font.weight: Font.DemiBold }
                        MouseArea {
                            id: _ncSendMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                var sel   = parent.parent.parent.parent._selected
                                var msg   = _ncMsg.text.trim()
                                if (sel.length === 0 || !msg) return
                                // Text the selected agent(s): notify_user_and_wait
                                // routes a message to an extension's inbox + awaits a reply.
                                for (var i = 0; i < sel.length; i++) {
                                    tab.callTool("notify_user_and_wait",
                                        { to_extension: sel[i], message: msg, title: "Message" },
                                        function(r) { tab.refresh() })
                                }
                                tab.showNewChat = false
                            }
                        }
                    }
                }
            }
        }
    }
}
