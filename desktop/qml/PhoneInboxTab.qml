pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import JarvisSidebar

// INBOX tab — SMS/agent thread list with priority badges, thread detail view
// (incl. response-option buttons, free-text reply bar, mark-read, delete),
// compose notification panel, and new-chat dialog.
Item {
    id: tab
    property var phonePage

    // ---- async helpers --------------------------------------------------------
    property var  _pending: ({})
    property int  _seq: 0

    function callTool(tool, args, cb) {
        var id = "inbox_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneMcp(id, tool, args || {})
    }

    function callHttp(method, path, body, cb) {
        var id = "inboxH_" + (++tab._seq)
        tab._pending[id] = cb || null
        bridge.phoneHttp(id, method, path, body || {})
    }

    Connections {
        target: bridge
        function onPhoneResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
        function onPhoneHttpResult(callId, result) {
            var cb = tab._pending[callId]
            if (cb) { delete tab._pending[callId]; cb(result) }
        }
    }

    // ---- state ----------------------------------------------------------------
    ListModel { id: threadModel }
    ListModel { id: messageModel }
    property string threadText:       ""
    property string openThreadId:     ""
    property string threadSubject:    ""
    property string openThreadRelExt: ""
    property string replyStatus:      ""
    property bool   showNewChat:      false

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
                    "ts":      m.created_at  !== undefined ? ("" + m.created_at)  : "",
                    "relExt":  m.related_extension !== undefined ? ("" + m.related_extension) : ""
                })
            }
        })
    }

    function loadThread(tid, subject, relExt) {
        tab.openThreadId     = tid
        tab.threadSubject    = subject
        tab.openThreadRelExt = (relExt !== undefined && relExt !== null) ? ("" + relExt) : tab.openThreadRelExt
        tab.threadText       = "Loading…"
        tab.replyStatus      = ""
        messageModel.clear()
        tab.callTool("get_thread_messages", { thread_id: tid }, function(r) {
            if (r.error) { tab.threadText = "Error: " + (r.error.message || "?"); return }
            var d    = r.data || {}
            var msgs = d.messages instanceof Array ? d.messages : []
            messageModel.clear()
            var unreadIds = []
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i]
                // Normalise response_options → always store as JSON string "[]" or "[...]"
                var rawOpts = m.response_options
                var optsStr = "[]"
                if (rawOpts instanceof Array)         optsStr = JSON.stringify(rawOpts)
                else if (typeof rawOpts === "string") optsStr = rawOpts.length > 0 ? rawOpts : "[]"
                messageModel.append({
                    "msgId":     m.id !== undefined ? ("" + m.id) : "",
                    "fromExt":   m.from_extension !== undefined ? ("" + m.from_extension) : "",
                    "body":      m.message || m.content || m.text || m.body || "",
                    "replyEcho": m.response_text || m.selected_option || m.reply_text || "",
                    "opts":      optsStr,
                    "replied":   !!(m.response_text || m.selected_option)
                })
                // Collect unread/queued/delivered message IDs for mark-read
                if (m.id && (m.status === "queued" || m.status === "delivered")) {
                    unreadIds.push("" + m.id)
                }
            }
            tab.threadText = msgs.length > 0 ? "" : "(empty thread)"
            // Fire-and-forget mark-read for each unread message
            for (var j = 0; j < unreadIds.length; j++) {
                tab.callHttp("POST", "/api/messages/" + unreadIds[j] + "/read", {}, null)
            }
            if (unreadIds.length > 0) tab.refresh()
        })
    }

    // Reply to a specific message by selecting a response option
    function selectOption(msgId, option) {
        if (!msgId) return
        tab.replyStatus = "Sending…"
        tab.callHttp("POST", "/api/messages/" + msgId + "/reply",
            { selected_option: option }, function(r) {
            if (r.error) {
                tab.replyStatus = "Error: " + (r.error.message || "?")
            } else {
                tab.replyStatus = ""
                tab.loadThread(tab.openThreadId, tab.threadSubject)
            }
        })
    }

    // Send a free-text reply into the open thread
    function sendFreeReply(text) {
        if (!text || !text.trim()) return
        var toExt = tab.openThreadRelExt
        if (!toExt) { tab.replyStatus = "Error: no agent extension for this thread"; return }
        tab.replyStatus = "Sending…"
        tab.callHttp("POST", "/api/messages",
            { to_extension: toExt, from_extension: "101",
              thread_id: tab.openThreadId, body: text.trim() },
            function(r) {
                if (r.error) {
                    tab.replyStatus = "Error: " + (r.error.message || "?")
                } else {
                    tab.replyStatus = ""
                    tab.loadThread(tab.openThreadId, tab.threadSubject)
                }
            })
    }

    // Delete the open thread and return to the list
    function deleteThread() {
        var tid = tab.openThreadId
        if (!tid) return
        tab.callHttp("DELETE", "/api/message-threads/" + tid, {}, function(r) {
            tab.openThreadId     = ""
            tab.threadSubject    = ""
            tab.openThreadRelExt = ""
            tab.threadText       = ""
            tab.replyStatus      = ""
            messageModel.clear()
            tab.refresh()
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
            Layout.fillHeight: tab.openThreadId.length === 0
            Layout.preferredHeight: tab.openThreadId.length > 0 ? 160 : -1

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
                    required property string relExt
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
                                anchors.centerIn: parent
                                text: (_tRow.relExt.length > 0 ? _tRow.relExt.charAt(0) : _tRow.tid.slice(0,2)).toUpperCase()
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
                        property string _relExt:  _tRow.relExt
                        onClicked: tab.loadThread(_tid, _subject, _relExt)
                    }
                }
            }
        }

        // ── thread detail panel ───────────────────────────────────────────────
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: tab.openThreadId.length > 0
            Layout.minimumHeight: tab.openThreadId.length > 0 ? 240 : 0
            visible: tab.openThreadId.length > 0
            color: Theme.surface; radius: Theme.radiusSm; border.color: Theme.hairlineSoft; border.width: 1

            ColumnLayout {
                anchors { fill: parent; margins: 10 }
                spacing: 6

                // ── header row ──────────────────────────────────────────────
                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        text: tab.threadSubject.length > 0 ? tab.threadSubject : "Thread"
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 11; font.weight: Font.Medium
                        Layout.fillWidth: true; elide: Text.ElideRight
                    }
                    // inline status / error text
                    Text {
                        visible: tab.replyStatus.length > 0
                        text: tab.replyStatus
                        color: tab.replyStatus.indexOf("Error") >= 0 ? Theme.danger : Theme.accent
                        font.family: Theme.fontMono; font.pixelSize: 9
                    }
                    Item { width: 4 }
                    // delete-thread button
                    Rectangle {
                        height: 22; implicitWidth: _delLbl.implicitWidth + 14; radius: 4
                        color: _delTrMa.containsMouse ? Qt.rgba(1, 0.18, 0.18, 0.14) : "transparent"
                        border.color: _delTrMa.containsMouse ? Theme.danger : Theme.hairlineSoft; border.width: 1
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text {
                            id: _delLbl; anchors.centerIn: parent; text: "DEL"
                            color: _delTrMa.containsMouse ? Theme.danger : Theme.textFaint
                            font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.6
                        }
                        MouseArea {
                            id: _delTrMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: tab.deleteThread()
                        }
                    }
                    Item { width: 4 }
                    // close button
                    Rectangle {
                        width: 22; height: 22; radius: 4
                        color: _closeTrMa.containsMouse ? Qt.rgba(1,1,1,0.08) : "transparent"
                        Text { anchors.centerIn: parent; text: "✕"; color: Theme.textMuted; font.pixelSize: 10 }
                        MouseArea {
                            id: _closeTrMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                tab.openThreadId     = ""
                                tab.threadSubject    = ""
                                tab.openThreadRelExt = ""
                                tab.threadText       = ""
                                tab.replyStatus      = ""
                                messageModel.clear()
                            }
                        }
                    }
                }

                // loading / error indicator (shown while messageModel is empty)
                Text {
                    visible: messageModel.count === 0 && tab.threadText.length > 0
                    text: tab.threadText
                    color: Theme.textMuted; font.family: Theme.fontMono; font.pixelSize: 10
                    Layout.fillWidth: true; wrapMode: Text.WrapAnywhere
                }

                // ── chat bubble ListView ────────────────────────────────────
                ListView {
                    id: _msgList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    model: messageModel
                    spacing: 6; clip: true
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                    // auto-scroll to latest message on every model change
                    onCountChanged: Qt.callLater(positionViewAtEnd)

                    delegate: Item {
                        id: _bubble
                        required property string msgId
                        required property string fromExt
                        required property string body
                        required property string replyEcho
                        required property string opts     // JSON string e.g. '["approve","deny"]'
                        required property bool   replied

                        property bool _out: _bubble.fromExt === "101"
                        property var  _optsArr: {
                            try { var a = JSON.parse(_bubble.opts); return (a instanceof Array) ? a : [] }
                            catch(e) { return [] }
                        }
                        property bool _showOpts: _bubble._optsArr.length > 0 && !_bubble.replied

                        width: ListView.view.width
                        height: _bRect.height + 4

                        Rectangle {
                            id: _bRect
                            // Wider bubble when it carries option buttons so they all fit
                            width: _bubble._showOpts
                                ? Math.min(parent.width * 0.90, Math.max(180, _bBody.implicitWidth + 24))
                                : Math.min(_bBody.implicitWidth + 24, parent.width * 0.80)
                            height: _bCol.implicitHeight + 16
                            x: _bubble._out ? (parent.width - width) : 0
                            radius: Theme.radiusXs
                            color:        _bubble._out ? Theme.accentDim    : Theme.surfaceStrong
                            border.color: _bubble._out ? Theme.accent        : Theme.hairlineSoft
                            border.width: 1

                            ColumnLayout {
                                id: _bCol
                                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 8 }
                                spacing: 4

                                Text {
                                    id: _bBody
                                    text: _bubble.body
                                    color: _bubble._out ? Theme.accentBright : Theme.text
                                    font.family: Theme.fontSans; font.pixelSize: 10
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }
                                Text {
                                    visible: _bubble.replyEcho.length > 0
                                    text: "↪ " + _bubble.replyEcho
                                    color: Theme.textFaint; font.family: Theme.fontMono; font.pixelSize: 9
                                    wrapMode: Text.WordWrap; Layout.fillWidth: true
                                }

                                // ── response-option buttons ─────────────
                                // _mid is captured here (outer delegate scope) so the
                                // inner Repeater delegates can reach it via parent.parent._mid
                                // without needing to cross a ComponentBehavior boundary.
                                Flow {
                                    visible: _bubble._showOpts
                                    Layout.fillWidth: true
                                    spacing: 4
                                    property string _mid: _bubble.msgId  // captured in outer scope

                                    Repeater {
                                        model: _bubble._optsArr
                                        delegate: Rectangle {
                                            required property string modelData
                                            property string _opt: modelData
                                            height: 22; implicitWidth: _optLbl.implicitWidth + 16; radius: Theme.radiusXs
                                            color: _optMa.containsMouse ? Theme.accent : Theme.accentDim
                                            border.color: Theme.accent; border.width: 1
                                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                                            Text {
                                                id: _optLbl; anchors.centerIn: parent
                                                text: parent._opt.replace(/_/g, " ").toUpperCase()
                                                color: _optMa.containsMouse ? Theme.inkOnAccent : Theme.accentBright
                                                font.family: Theme.fontDisplay; font.pixelSize: 8; font.letterSpacing: 0.6
                                            }
                                            MouseArea {
                                                id: _optMa; anchors.fill: parent
                                                hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                                // parent = option button Rectangle
                                                // parent.parent = Flow (has _mid)
                                                onClicked: tab.selectOption(parent.parent._mid, parent._opt)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // ── free-text reply bar ─────────────────────────────────────
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 6

                    TextField {
                        id: _replyField
                        Layout.fillWidth: true
                        placeholderText: "Reply to thread…"
                        background: Rectangle {
                            color: Theme.surfaceInput; radius: Theme.radiusXs
                            border.color: _replyField.activeFocus ? Theme.accent : Theme.hairlineSoft; border.width: 1
                        }
                        color: Theme.text; font.family: Theme.fontSans; font.pixelSize: 11
                        leftPadding: 10; rightPadding: 10; height: 32
                        onAccepted: {
                            var t = _replyField.text
                            _replyField.text = ""
                            tab.sendFreeReply(t)
                        }
                    }

                    Rectangle {
                        height: 32; implicitWidth: _frSendLbl.implicitWidth + 18; radius: Theme.radiusXs
                        color: _frSendMa.containsMouse ? Theme.accent : Theme.accentDim
                        Behavior on color { ColorAnimation { duration: Theme.durFast } }
                        Text {
                            id: _frSendLbl; anchors.centerIn: parent; text: "SEND"
                            color: Theme.inkOnAccent
                            font.family: Theme.fontDisplay; font.pixelSize: 10
                            font.letterSpacing: Theme.trackMid; font.weight: Font.DemiBold
                        }
                        MouseArea {
                            id: _frSendMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                var t = _replyField.text
                                if (t.trim()) { _replyField.text = ""; tab.sendFreeReply(t) }
                            }
                        }
                    }
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
                    tab.callTool("list_agents", {}, function(r) {
                        var arr = r.data instanceof Array ? r.data : []
                        var out = []
                        for (var i = 0; i < arr.length; i++) {
                            var a = arr[i]
                            out.push({ ext: ("" + (a.extension || "")), nm: (a.name || "Agent") })
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
                                tab.callTool("call_extension", { from_extension: "101", to_extension: sel[0] }, function(r) {})
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
