import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import JarvisSidebar

// The full Jarvis content panel: model picker + chat transcript + composer.
// Instantiated ONCE in Main.qml and reparented between the floating window and
// the docked layer-shell surface, so chat state is preserved across mode toggles.
// All Bridge (Contract A) calls and Contract B event rendering live here.
Item {
    id: panel

    // chat transcript model fed from bridge.sessionEvent
    ListModel { id: chatModel }

    property bool thinking: false
    // True while the model's turn is in flight (between a sent message / first live
    // event and the turn's "final"/"error"). Drives the composer's Stop button.
    property bool busy: false

    // The session id the transcript currently represents. The chat transcript is a
    // STRICT FUNCTION of this: the reconciler (onSessionIdChanged) wipes the
    // transcript whenever bridge.sessionId changes to anything else — + New, opening
    // another session, deleting the current one, a coworker/voice session taking
    // over, or the daemon assigning a fresh id. This is the single source of truth
    // that previously kept drifting (old/Chrome content lingering under a different
    // or empty session, "+ New" not clearing). Handlers that legitimately (re)load a
    // session set this themselves right after wiping.
    property string chatSessionId: ""

    // Set true between "user sent the first message of a fresh chat" and the daemon
    // assigning that new session its id. In that window the transcript already holds
    // the user's just-typed message FOR the session being born, so the reconciler
    // must ADOPT the incoming id rather than wipe (else the user's own message
    // vanishes the instant the session.create reply lands — the "it removes what I
    // said" bug). Any OTHER session change still wipes.
    property bool pendingNewSession: false

    // Whimsical "working" status — a spinning mark + a rotating funny phrase shown
    // while busy (Claude-Code flavored). Pure cosmetics.
    property var thinkingPhrases: [
        "Conquering the world", "Just chillin", "Pondering the universe",
        "Cooking", "Summoning electrons", "Reticulating splines",
        "Bending spacetime", "Consulting the oracle", "Doing crimes (legal ones)",
        "Vibing", "Untangling the matrix", "Herding photons",
        "Caffeinating neurons", "Computing the meaning of life", "Manifesting",
        "Hacking the mainframe", "Plotting world domination", "Aligning the stars",
        "Overthinking it", "Galaxy-braining", "Locking in"
    ]
    property string thinkingPhrase: thinkingPhrases[0]
    Timer {
        interval: 2400; repeat: true; running: panel.busy
        onRunningChanged: if (running) thinkRoll.triggered()
        id: thinkRoll
        onTriggered: panel.thinkingPhrase =
            panel.thinkingPhrases[Math.floor(Math.random() * panel.thinkingPhrases.length)]
    }
    // Default model is gpt-5.5 (gpt-5-codex is rejected HTTP 400 by this codex login).
    property var modelOptions: ["gpt-5.5", "gpt-5", "o4-mini", "claude-sonnet-4.5", "claude-opus-4.5"]
    property string selectedModel: modelOptions.length > 0 ? modelOptions[0] : ""

    // Which brain (engine) backs the next session: "codex" (default) or "claude".
    // Changing it re-queries model.list so the model picker shows THAT brain's
    // models. The session.create call passes this as the `brain` param.
    property var brainOptions: ["codex", "claude"]
    property string selectedBrain: "codex"

    // Repopulate the model list for the chosen brain. onModelsListed only adopts a
    // reply whose brain matches selectedBrain, so stale replies from a quick
    // switch are ignored.
    function selectBrain(brain) {
        if (brain === panel.selectedBrain)
            return
        panel.selectedBrain = brain
        if (bridge.connected)
            bridge.listModels(brain)
    }

    // On startup (and reconnect) fetch the default brain's models.
    Component.onCompleted: {
        if (Qt.application.arguments.indexOf("--demo") !== -1)
            seedDemo()
        if (bridge.connected)
            bridge.listModels(panel.selectedBrain)
    }

    // Design preview: set JARVIS_DEMO=1 to seed sample transcript content so the
    // bubbles / chips / diff / approval styling can be reviewed without a daemon.
    // No effect in normal runs. (See Component.onCompleted above.)
    function seedDemo() {
        chatModel.append({ "kind":"message","role":"user","text":"Refactor the auth module and add tests.","callId":"","toolName":"","approvalId":"","risk":"","ok":true,"streaming":false })
        chatModel.append({ "kind":"message","role":"assistant","text":"On it. I'll inspect the current auth flow, extract the token logic into a service, then add coverage. Starting with a quick scan.","callId":"","toolName":"","approvalId":"","risk":"","ok":true,"streaming":false })
        chatModel.append({ "kind":"tool_call","role":"tool","text":"{\"cmd\":\"rg -n 'token' src/auth\"}","callId":"c1","toolName":"shell","approvalId":"","risk":"","ok":true,"streaming":false })
        chatModel.append({ "kind":"tool_result","role":"tool","text":"src/auth/login.ts:42  const token = sign(user)\nsrc/auth/mw.ts:11   verify(token)","callId":"c1","toolName":"","approvalId":"","risk":"","ok":true,"streaming":false })
        chatModel.append({ "kind":"diff","role":"tool","text":"--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n+export function sign(user) {\n+  return jwt(user, KEY)\n-  // old inline impl\n }","callId":"","toolName":"src/auth/token.ts","approvalId":"","risk":"","ok":true,"streaming":false })
        chatModel.append({ "kind":"approval","role":"system","text":"Run the test suite with network access enabled?","callId":"","toolName":"","approvalId":"a1","risk":"medium","ok":true,"streaming":false })
    }

    // Append a normalized brain event (Contract B) to the transcript. Shared by
    // live session events and replayed history. `live` distinguishes the two: live
    // assistant messages stream in character-by-character (typewriter), while history
    // replay shows full text at once. `live` also drives the turn-in-flight `busy`
    // flag (Stop button) — only real-time events start/clear it.
    function appendEvent(ev, live) {
        var kind = ev.kind !== undefined ? ev.kind : ""
        // Any live event other than the turn terminators means the model is working.
        if (live && kind !== "final" && kind !== "error")
            panel.busy = true
        switch (kind) {
        case "thinking":
            panel.thinking = true
            break
        case "message":
            panel.thinking = false
            var msgRole = ev.role !== undefined ? ev.role : "assistant"
            chatModel.append({
                "kind": "message",
                "role": msgRole,
                "text": ev.text !== undefined ? ev.text : "",
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
                // Stream (typewriter reveal) ONLY for live assistant messages — not
                // history replay, not user echoes.
                "streaming": (live === true && msgRole === "assistant")
            })
            break
        case "tool_call":
            panel.thinking = false
            // ONE unified "tool" row per call. `text` carries a JSON envelope
            // {i:input, o:output, d:done, s:server} so the delegate can show a
            // collapsed card (spinner while running) that expands to input+output —
            // no new model roles needed. The matching tool_result merges in below.
            chatModel.append({
                "kind": "tool", "role": "tool",
                "text": JSON.stringify({
                    i: ev.args !== undefined ? JSON.stringify(ev.args, null, 2) : "",
                    o: "", d: false, s: ev.server !== undefined ? ("" + ev.server) : ""
                }),
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": ev.name !== undefined ? ev.name : "tool",
                "approvalId": "", "risk": "", "ok": true, "streaming": false
            })
            break
        case "tool_result": {
            var cid = ev.call_id !== undefined ? ev.call_id : ""
            var outp = ev.output !== undefined ? ("" + ev.output) : ""
            var okv = ev.ok !== false
            // The result may ALSO carry the call's input/name/server (codex reports a
            // completed call as one item), so the card can show input + name + output.
            var inp = ev.args !== undefined ? JSON.stringify(ev.args, null, 2) : ""
            var nm = (ev.name !== undefined && ("" + ev.name).length > 0) ? ("" + ev.name) : ""
            var srv = ev.server !== undefined ? ("" + ev.server) : ""
            var merged = false
            if (cid.length > 0) {
                for (var ti = chatModel.count - 1; ti >= 0; ti--) {
                    var row = chatModel.get(ti)
                    if (row.kind === "tool" && row.callId === cid) {
                        var d = { i: "", o: "", d: false, s: "" }
                        try { d = JSON.parse(row.text) } catch (e) {}
                        d.o = outp; d.d = true
                        if ((!d.i || d.i.length === 0) && inp.length > 0) d.i = inp
                        if ((!d.s || d.s.length === 0) && srv.length > 0) d.s = srv
                        chatModel.setProperty(ti, "text", JSON.stringify(d))
                        chatModel.setProperty(ti, "ok", okv)
                        if (nm.length > 0 && (row.toolName === "" || row.toolName === "tool"))
                            chatModel.setProperty(ti, "toolName", nm)
                        merged = true
                        break
                    }
                }
            }
            if (!merged) {
                chatModel.append({
                    "kind": "tool", "role": "tool",
                    "text": JSON.stringify({ i: inp, o: outp, d: true, s: srv }),
                    "callId": cid, "toolName": nm.length > 0 ? nm : "result",
                    "approvalId": "", "risk": "", "ok": okv, "streaming": false
                })
            }
            break
        }
        case "approval":
            panel.thinking = false
            chatModel.append({
                "kind": "approval", "role": "system",
                "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                "callId": "", "toolName": "",
                "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                "risk": ev.risk !== undefined ? ("" + ev.risk) : "", "ok": true,
                "streaming": false
            })
            break
        case "diff":
            chatModel.append({
                "kind": "diff", "role": "tool",
                "text": ev.patch !== undefined ? ev.patch : "",
                "callId": "", "toolName": ev.path !== undefined ? ev.path : "diff",
                "approvalId": "", "risk": "", "ok": true, "streaming": false
            })
            break
        case "error":
            panel.thinking = false
            panel.busy = false
            chatModel.append({
                "kind": "error", "role": "system",
                "text": ev.message !== undefined ? ev.message : "error",
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
                "streaming": false
            })
            break
        case "final":
            panel.thinking = false
            panel.busy = false
            break
        default:
            break
        }
    }

    // ---- Bridge wiring (Contract A client + Contract B rendering) ----------
    Connections {
        target: bridge

        function onModelsListed(brain, models) {
            // Ignore replies for a brain the user is no longer on (e.g. a stale
            // reply after a quick codex<->claude switch). Empty brain = legacy
            // reply with no brain field; accept it for the current selection.
            if (brain && brain.length > 0 && brain !== panel.selectedBrain)
                return
            if (models && models.length > 0) {
                panel.modelOptions = models
                panel.selectedModel = models[0]
            }
        }

        // When the daemon connects after the panel loaded, fetch the brain's models.
        function onConnectedChanged() {
            if (bridge.connected)
                bridge.listModels(panel.selectedBrain)
        }

        // Launch / toggle-to-visible: land in a FRESH chat, never an old/Chrome
        // session. Skipped only if a turn is actively generating (don't kill it).
        function onNewChatRequested() {
            if (!panel.busy)
                panel.startNewChat()
        }

        // THE reconciler. The transcript belongs to exactly ONE session
        // (panel.chatSessionId). The moment the live session changes out from under
        // it — via ANY path (+ New clears it, opening another session, deleting the
        // current one, a coworker/voice session, the daemon minting a fresh id) — wipe
        // the transcript so content from the old session can never linger under a
        // different (or empty) session. Every m_sessionId transition emits
        // sessionIdChanged, so this one handler closes all the leaks the per-path
        // fixes kept missing. onSessionHistory/onSessionEvent re-stamp chatSessionId
        // when they legitimately (re)populate the transcript.
        function onSessionIdChanged() {
            if (bridge.sessionId === panel.chatSessionId)
                return
            // Our own fresh chat just got its daemon id: the transcript already holds
            // the user's first message for THIS session — adopt, don't wipe.
            if (panel.pendingNewSession && bridge.sessionId.length > 0) {
                panel.pendingNewSession = false
                panel.chatSessionId = bridge.sessionId
                return
            }
            // Genuine switch (open another / delete current / + New / coworker /
            // voice / cleared): the transcript no longer belongs here — wipe it.
            chatModel.clear()
            panel.thinking = false
            panel.busy = false
            panel.pendingNewSession = false
            panel.chatSessionId = bridge.sessionId
        }

        // Opening a stored session from the Sessions page: clear + replay.
        function onSessionOpened(sessionId) {
            chatModel.clear()
            panel.thinking = false
            panel.busy = false
        }
        function onSessionHistory(sessionId, events) {
            // Guard against a stale async reply: if + New (or opening another
            // session) changed the current session while this history fetch was
            // in flight, replaying it would paint the old session's content into
            // a chat that no longer owns it. Only replay for the CURRENT session.
            if (sessionId !== bridge.sessionId)
                return
            chatModel.clear()
            panel.busy = false
            panel.chatSessionId = sessionId   // the transcript now represents this session
            // History replay: full text immediately (live=false => no typewriter).
            for (var i = 0; i < events.length; i++)
                panel.appendEvent(events[i], false)
            // Restore the widgets THIS session rendered (they live on a separate bus,
            // not in the event history) so reopening a session brings them back.
            bridge.replaySessionWidgets(sessionId)
            chatView.positionViewAtEnd()
        }

        function onErrorOccurred(message) {
            panel.busy = false
            chatModel.append({
                "kind": "error", "role": "system", "text": message,
                "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
                "streaming": false
            })
            chatView.positionViewAtEnd()
        }

        // The model called ask_user: show a tappable question card in the chat.
        // The question + options are packed as a JSON envelope in `text`; the
        // delegate parses it and answerQuestion() sends the choice back.
        function onAgentQuestion(id, question, options) {
            chatModel.append({
                "kind": "question", "role": "system",
                "text": JSON.stringify({ "q": question, "options": options || [] }),
                "callId": "", "toolName": "", "approvalId": id, "risk": "", "ok": true,
                "streaming": false
            })
            chatView.positionViewAtEnd()
        }

        // The model rendered a widget (render_widget). It now lands INLINE in the
        // transcript — right where the model produced it, reading like a tool
        // result — instead of floating on top of the chat. The model still owns
        // WHEN (it calls render_widget); this only fixes WHERE it shows. The spec
        // is stored as a JSON STRING (a ListModel var role mangles nested
        // children/ops arrays so the renderer would draw only the title). Re-render
        // with the same id updates that row in place; a new id appends a new card.
        function onWidgetRendered(w) {
            if (!w || w.spec === undefined)
                return
            // GATING: a widget only enters the chat transcript when the model asked
            // for it there (target "chat"/"both"). "canvas" (default) stays on the
            // Canvas tab; "voice" pops near the orb. Keeps the chat uncluttered.
            var target = (w.target !== undefined) ? ("" + w.target) : "canvas"
            if (target !== "chat" && target !== "both")
                return
            // Scope to THIS session: a widget another session rendered must not leak
            // into the chat being viewed (empty session_id = legacy/global -> allow).
            var sid = (w.session_id !== undefined) ? ("" + w.session_id) : ""
            if (sid.length > 0 && sid !== bridge.sessionId)
                return
            var wid = (w.id !== undefined && ("" + w.id).length > 0) ? ("" + w.id) : ""
            var title = (w.title !== undefined) ? ("" + w.title) : ""
            var specStr = JSON.stringify(w.spec)
            if (wid.length > 0) {
                for (var i = chatModel.count - 1; i >= 0; i--) {
                    var row = chatModel.get(i)
                    if (row.kind === "widget" && row.callId === wid) {
                        chatModel.setProperty(i, "text", specStr)
                        chatModel.setProperty(i, "toolName", title)
                        return
                    }
                }
            }
            chatModel.append({
                "kind": "widget", "role": "tool", "text": specStr,
                "callId": wid, "toolName": title,
                "approvalId": "", "risk": "", "ok": true, "streaming": false
            })
            chatView.positionViewAtEnd()
        }

        // A canvas was deleted / all cleared — drop any inline copy in the chat too.
        function onWidgetRemoved(id) {
            for (var i = chatModel.count - 1; i >= 0; i--) {
                var row = chatModel.get(i)
                if (row.kind === "widget" && row.callId === id) { chatModel.remove(i); break }
            }
        }
        function onWidgetsCleared() {
            for (var i = chatModel.count - 1; i >= 0; i--)
                if (chatModel.get(i).kind === "widget") chatModel.remove(i)
        }

        function onSessionEvent(ev) {
            // Belt-and-suspenders with the Bridge-side filter: ONLY render events for
            // this chat's current session. A Chrome/phone session (different id) must
            // never leak into the chat the user is looking at.
            if (ev.session_id !== undefined && ev.session_id !== bridge.sessionId)
                return
            // This live turn belongs to the current session; the transcript now
            // represents it (covers the type-on-fresh-chat create-then-stream path).
            panel.chatSessionId = bridge.sessionId
            // Live event from the ongoing turn -> stream assistant text + track busy.
            panel.appendEvent(ev, true)
            chatView.positionViewAtEnd()
            // optional TTS read-back of the assistant's final message
            if (panel.ttsReadback && ev.kind === "message"
                && (ev.role === undefined || ev.role === "assistant")
                && ev.text !== undefined && ("" + ev.text).trim().length > 0)
                bridge.voiceSpeak(ev.text)
        }

        // voice dictation: drop the transcript into the input (don't auto-send).
        function onVoiceTranscribed(text) {
            if (text && text.length > 0) {
                if (inputArea.text.trim().length > 0)
                    inputArea.text = inputArea.text + " " + text
                else
                    inputArea.text = text
                inputArea.cursorPosition = inputArea.text.length
                inputArea.forceActiveFocus()
            }
        }
    }

    // TTS read-back toggle (Mistral voice.tts on assistant finals).
    property bool ttsReadback: false

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 16
        anchors.rightMargin: 16
        anchors.topMargin: 6
        anchors.bottomMargin: 16
        spacing: 12

        // ===== Sub-header: status line + model picker ========================
        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            // status pill
            Rectangle {
                Layout.alignment: Qt.AlignVCenter
                radius: Theme.radiusXs
                implicitWidth: statusRow.implicitWidth + 18
                implicitHeight: 26
                color: Theme.surfaceDeep
                border.width: 1
                border.color: bridge.connected ? Theme.accentDim : Theme.hairlineSoft
                Row {
                    id: statusRow
                    anchors.centerIn: parent
                    spacing: 7
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6; height: 6; radius: 3
                        color: bridge.connected ? Theme.success : Theme.amber
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: bridge.connected
                              ? (bridge.sessionId.length > 0 ? "SESSION ACTIVE" : "ONLINE // READY")
                              : "CONNECTING…"
                        color: bridge.connected ? Theme.textMuted : Theme.textFaint
                        font.family: Theme.fontDisplay
                        font.pixelSize: 9
                        font.letterSpacing: Theme.trackMid
                    }
                }
            }

            // (The "working" indicator — spinning Jarvis orb + rotating funny phrase —
            // now lives in the chat transcript footer, beside where the reply appears.)

            Item { Layout.fillWidth: true }

            // + New chat — wipe the transcript and drop the current session so the
            // next message spins up a fresh one (same path AppShell uses for the
            // Sessions-page "New chat").
            Widgets.PillButton {
                label: "+ New"
                Layout.alignment: Qt.AlignVCenter
                onClicked: panel.startNewChat()
            }

            // TTS read-back toggle (speaker icon)
            Item {
                Layout.alignment: Qt.AlignVCenter
                width: 30; height: 26
                Rectangle {
                    anchors.fill: parent
                    radius: Theme.radiusXs
                    color: panel.ttsReadback ? Theme.accentFaint : "transparent"
                    border.width: 1
                    border.color: panel.ttsReadback ? Theme.accentDim
                                  : (ttsMa.containsMouse ? Theme.hairlineSoft : "transparent")
                    Behavior on border.color { ColorAnimation { duration: Theme.durFast } }
                }
                Canvas {
                    anchors.centerIn: parent
                    width: 16; height: 16
                    property color ink: panel.ttsReadback ? Theme.accent : Theme.textMuted
                    onInkChanged: requestPaint()
                    onPaint: {
                        var ctx = getContext("2d"); ctx.reset()
                        ctx.strokeStyle = ink; ctx.fillStyle = ink
                        ctx.lineWidth = 1.3; ctx.lineCap = "round"; ctx.lineJoin = "round"
                        // speaker body
                        ctx.beginPath()
                        ctx.moveTo(3, 6); ctx.lineTo(6, 6); ctx.lineTo(9, 3)
                        ctx.lineTo(9, 13); ctx.lineTo(6, 10); ctx.lineTo(3, 10); ctx.closePath()
                        ctx.fill()
                        // waves only when on
                        if (panel.ttsReadback) {
                            ctx.beginPath(); ctx.arc(9, 8, 3.4, -0.9, 0.9); ctx.stroke()
                            ctx.beginPath(); ctx.arc(9, 8, 5.6, -0.8, 0.8); ctx.stroke()
                        }
                    }
                }
                MouseArea {
                    id: ttsMa
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: panel.ttsReadback = !panel.ttsReadback
                }
            }

            Text {
                text: "BRAIN"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }

            // brain picker — codex / claude. Changing it re-queries model.list so
            // the model picker repopulates with that brain's models.
            ComboBox {
                id: brainPicker
                Layout.preferredWidth: 108
                Layout.preferredHeight: 32
                model: panel.brainOptions
                currentIndex: Math.max(0, panel.brainOptions.indexOf(panel.selectedBrain))
                onActivated: panel.selectBrain(currentText)

                background: Rectangle {
                    radius: Theme.radiusSm
                    color: brainPicker.pressed ? Theme.surfaceStrong : Theme.surfaceInput
                    border.color: brainPicker.activeFocus || brainPicker.hovered
                                  ? Theme.accent : Theme.hairlineSoft
                    border.width: 1
                    Behavior on border.color { ColorAnimation { duration: 120 } }
                }
                contentItem: Text {
                    leftPadding: 12
                    rightPadding: 28
                    text: brainPicker.displayText
                    color: Theme.text
                    font.pixelSize: 12
                    font.family: Theme.fontSans
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
                indicator: Canvas {
                    x: brainPicker.width - 20
                    y: (brainPicker.height - 6) / 2
                    width: 10; height: 6
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.reset()
                        ctx.strokeStyle = Theme.accent
                        ctx.lineWidth = 1.4
                        ctx.lineCap = "round"; ctx.lineJoin = "round"
                        ctx.beginPath(); ctx.moveTo(1,1); ctx.lineTo(5,5); ctx.lineTo(9,1); ctx.stroke()
                    }
                }
                popup: Popup {
                    y: brainPicker.height + 6
                    width: brainPicker.width
                    implicitHeight: Math.min(contentItem.implicitHeight + 10, 300)
                    padding: 5
                    background: Rectangle {
                        radius: Theme.radiusSm
                        color: Qt.rgba(0.039, 0.071, 0.110, 0.97)
                        border.color: Theme.accentDim
                        border.width: 1
                    }
                    contentItem: ListView {
                        clip: true
                        implicitHeight: contentHeight
                        model: brainPicker.popup.visible ? brainPicker.delegateModel : null
                        spacing: 2
                        ScrollIndicator.vertical: ScrollIndicator {}
                    }
                }
                delegate: ItemDelegate {
                    required property var modelData
                    required property int index
                    width: brainPicker.width - 10
                    height: 30
                    contentItem: Text {
                        text: modelData
                        color: highlighted ? Theme.accentBright : Theme.text
                        font.pixelSize: 12
                        font.family: Theme.fontSans
                        verticalAlignment: Text.AlignVCenter
                        leftPadding: 6
                    }
                    highlighted: brainPicker.highlightedIndex === index
                    background: Rectangle {
                        radius: Theme.radiusXs
                        color: highlighted ? Theme.accentFaint : "transparent"
                    }
                }
            }

            Text {
                text: "MODEL"
                color: Theme.textFaint
                font.family: Theme.fontDisplay
                font.pixelSize: 9
                font.letterSpacing: Theme.trackWide
                Layout.alignment: Qt.AlignVCenter
            }

            // model picker — fully restyled ComboBox (no default Qt look)
            ComboBox {
                id: modelPicker
                Layout.preferredWidth: 188
                Layout.preferredHeight: 32
                model: panel.modelOptions
                onActivated: panel.selectedModel = currentText

                background: Rectangle {
                    radius: Theme.radiusSm
                    color: modelPicker.pressed ? Theme.surfaceStrong : Theme.surfaceInput
                    border.color: modelPicker.activeFocus || modelPicker.hovered
                                  ? Theme.accent : Theme.hairlineSoft
                    border.width: 1
                    Behavior on border.color { ColorAnimation { duration: 120 } }
                }
                contentItem: Text {
                    leftPadding: 12
                    rightPadding: 28
                    text: modelPicker.displayText
                    color: Theme.text
                    font.pixelSize: 12
                    font.family: Theme.fontSans
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                }
                indicator: Canvas {
                    x: modelPicker.width - 20
                    y: (modelPicker.height - 6) / 2
                    width: 10; height: 6
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.reset()
                        ctx.strokeStyle = Theme.accent
                        ctx.lineWidth = 1.4
                        ctx.lineCap = "round"; ctx.lineJoin = "round"
                        ctx.beginPath(); ctx.moveTo(1,1); ctx.lineTo(5,5); ctx.lineTo(9,1); ctx.stroke()
                    }
                }
                popup: Popup {
                    y: modelPicker.height + 6
                    width: modelPicker.width
                    implicitHeight: Math.min(contentItem.implicitHeight + 10, 300)
                    padding: 5
                    background: Rectangle {
                        radius: Theme.radiusSm
                        color: Qt.rgba(0.039, 0.071, 0.110, 0.97)
                        border.color: Theme.accentDim
                        border.width: 1
                    }
                    contentItem: ListView {
                        clip: true
                        implicitHeight: contentHeight
                        model: modelPicker.popup.visible ? modelPicker.delegateModel : null
                        spacing: 2
                        ScrollIndicator.vertical: ScrollIndicator {}
                    }
                }
                delegate: ItemDelegate {
                    required property var modelData
                    required property int index
                    width: modelPicker.width - 10
                    height: 30
                    contentItem: Text {
                        text: modelData
                        color: highlighted ? Theme.accentBright : Theme.text
                        font.pixelSize: 12
                        font.family: Theme.fontSans
                        verticalAlignment: Text.AlignVCenter
                        leftPadding: 6
                    }
                    highlighted: modelPicker.highlightedIndex === index
                    background: Rectangle {
                        radius: Theme.radiusXs
                        color: highlighted ? Theme.accentFaint : "transparent"
                    }
                }
            }
        }

        // ===== Chat transcript (HUD framed) ==================================
        HudFrame {
            Layout.fillWidth: true
            Layout.fillHeight: true
            fill: Theme.panel
            active: bridge.connected
            sweep: panel.thinking

            ListView {
                id: chatView
                anchors.fill: parent
                anchors.margins: 14
                clip: true
                spacing: 12
                model: chatModel
                cacheBuffer: 800
                boundsBehavior: Flickable.StopAtBounds

                ScrollBar.vertical: ScrollBar {
                    policy: ScrollBar.AsNeeded
                    width: 5
                    background: Item {}
                    contentItem: Rectangle {
                        implicitWidth: 4; radius: 2
                        color: Theme.hairline
                        opacity: parent.pressed ? 0.9 : 0.5
                    }
                }

                // empty-state hint — the large arc reactor centerpiece
                Item {
                    anchors.fill: parent
                    visible: chatModel.count === 0
                    ColumnLayout {
                        anchors.centerIn: parent
                        width: parent.width - 50
                        spacing: 20

                        ArcReactor {
                            Layout.alignment: Qt.AlignHCenter
                            size: 132
                            tint: Theme.accent
                            thinking: !bridge.connected
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            text: bridge.connected ? "HOW CAN I HELP?" : "LINKING TO JARVISD"
                            color: Theme.accentBright
                            font.family: Theme.fontDisplay
                            font.pixelSize: 17
                            font.weight: Font.DemiBold
                            font.letterSpacing: Theme.trackMid
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            text: bridge.connected
                                  ? "Select a model and transmit a message to spin up a session."
                                  : "Status: " + bridge.status
                            color: Theme.textFaint
                            font.family: Theme.fontSans
                            font.pixelSize: 13
                            lineHeight: 1.35
                        }

                        // TODAY // BRIEFING — skills.today digest, refreshed on connect.
                        TodayBriefing {
                            Layout.fillWidth: true
                            Layout.topMargin: 6
                            visible: bridge.connected
                        }
                    }
                }

                delegate: ChatDelegate {
                    width: chatView.width
                    onAllow: function(approvalId) { bridge.respondApproval(approvalId, "allow") }
                    onDeny:  function(approvalId) { bridge.respondApproval(approvalId, "deny") }
                    onAlways: function(approvalId) { bridge.respondApproval(approvalId, "always") }
                    // A button inside an inline render_widget fired its action.
                    onWidgetAction: function(action) { panel.handleWidgetAction(action) }
                    // Keep the transcript pinned to the bottom while a streaming
                    // assistant message types itself in (only if already at/near end).
                    onGrew: {
                        if (chatView.atYEnd
                            || chatView.contentHeight <= chatView.height)
                            chatView.positionViewAtEnd()
                    }
                }

                // thinking indicator (footer): the spinning Jarvis orb with a rotating
                // funny phrase right beside it, shown as the pending reply at the BOTTOM
                // of the conversation while the model works — where the answer appears,
                // not pinned to the composer. Visible the whole turn (busy), giving way
                // to the streamed reply when it arrives.
                footer: Item {
                    width: chatView.width
                    height: panel.busy ? 58 : 0
                    visible: panel.busy
                    Behavior on height { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 2
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 13
                        ArcReactor {
                            anchors.verticalCenter: parent.verticalCenter
                            size: 46
                            spinning: true
                            thinking: true
                            tint: Theme.accent
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: panel.thinkingPhrase + "…"
                            color: Theme.accent
                            opacity: 0.92
                            font.family: Theme.fontDisplay
                            font.pixelSize: 13
                            font.letterSpacing: Theme.trackMid
                        }
                    }
                }
            }
        }

        // ===== Composer ======================================================
        Rectangle {
            id: composer
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(Math.max(56, inputArea.implicitHeight + 22), 168)
            radius: Theme.radius
            color: Theme.surfaceInput
            border.color: inputArea.activeFocus ? Theme.accent : Theme.hairlineSoft
            border.width: 1
            Behavior on border.color { ColorAnimation { duration: 140 } }

            // focus neon underline
            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left; anchors.right: parent.right
                anchors.leftMargin: Theme.radius; anchors.rightMargin: Theme.radius
                anchors.bottomMargin: 1
                height: 1
                color: Theme.accent
                opacity: inputArea.activeFocus ? 0.7 : 0.0
                Behavior on opacity { NumberAnimation { duration: 140 } }
            }

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 10
                anchors.topMargin: 6
                anchors.bottomMargin: 6
                spacing: 10

                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    TextArea {
                        id: inputArea
                        placeholderText: bridge.sessionId.length > 0
                                         ? "Message Jarvis…"
                                         : "Type to start a session…"
                        placeholderTextColor: Theme.textFaint
                        color: Theme.text
                        font.pixelSize: 14
                        font.family: Theme.fontSans
                        wrapMode: TextArea.Wrap
                        selectByMouse: true
                        selectionColor: Theme.accentDim
                        background: null
                        verticalAlignment: TextArea.AlignVCenter

                        Keys.onReturnPressed: function(event) {
                            if (event.modifiers & Qt.ShiftModifier) {
                                event.accepted = false  // newline
                            } else {
                                event.accepted = true
                                panel.submit()
                            }
                        }
                    }
                }

                // mic button (push-to-dictate; ~6s capture via pw-record -> voice.stt)
                Item {
                    id: micWrap
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: 2
                    width: 38; height: 38
                    readonly property bool recording: bridge.recordingState === "recording"
                    readonly property bool transcribing: bridge.recordingState === "transcribing"
                    visible: bridge.voiceAvailable()

                    // recording pulse halo
                    Rectangle {
                        anchors.centerIn: parent
                        width: 44; height: 44; radius: 22
                        color: "transparent"
                        border.color: Theme.danger
                        border.width: 2
                        opacity: micWrap.recording ? 0.6 : 0.0
                        SequentialAnimation on scale {
                            running: micWrap.recording
                            loops: Animation.Infinite
                            NumberAnimation { from: 0.9; to: 1.15; duration: 700; easing.type: Easing.InOutSine }
                            NumberAnimation { from: 1.15; to: 0.9; duration: 700; easing.type: Easing.InOutSine }
                        }
                    }
                    Rectangle {
                        anchors.fill: parent
                        radius: 19
                        color: micWrap.recording ? Theme.dangerDim
                               : (micMa.containsMouse ? Theme.surfaceStrong : Theme.surface)
                        border.width: 1
                        border.color: micWrap.recording ? Theme.danger
                                      : micWrap.transcribing ? Theme.accent
                                      : (micMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft)
                        Behavior on border.color { ColorAnimation { duration: Theme.durFast } }

                        // transcribing spinner ring
                        Rectangle {
                            anchors.centerIn: parent
                            width: 22; height: 22; radius: 11
                            visible: micWrap.transcribing
                            color: "transparent"
                            border.width: 2
                            border.color: Theme.accent
                            opacity: 0.4
                            RotationAnimation on rotation {
                                running: micWrap.transcribing
                                loops: Animation.Infinite
                                from: 0; to: 360; duration: 900
                            }
                        }

                        Canvas {
                            anchors.centerIn: parent
                            width: 16; height: 16
                            property color ink: micWrap.recording ? Theme.danger
                                                : micWrap.transcribing ? Theme.accent
                                                : Theme.textMuted
                            onInkChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d"); ctx.reset()
                                ctx.strokeStyle = ink; ctx.fillStyle = ink
                                ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round"
                                // mic capsule (rounded top + bottom)
                                ctx.beginPath()
                                ctx.moveTo(6, 4); ctx.arc(8, 4, 2, Math.PI, 0)
                                ctx.lineTo(10, 8); ctx.arc(8, 8, 2, 0, Math.PI)
                                ctx.closePath(); ctx.stroke()
                                // stand
                                ctx.beginPath(); ctx.arc(8, 9, 4, 0.2, Math.PI - 0.2); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(8, 13); ctx.lineTo(8, 15); ctx.stroke()
                                ctx.beginPath(); ctx.moveTo(5.5, 15); ctx.lineTo(10.5, 15); ctx.stroke()
                            }
                        }
                        MouseArea {
                            id: micMa
                            anchors.fill: parent
                            hoverEnabled: true
                            enabled: bridge.connected && !micWrap.transcribing
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (micWrap.recording) bridge.voiceDictateStop()
                                else bridge.voiceDictate(6)
                            }
                        }
                    }
                }

                // glowing circular send button — becomes a red STOP button while the
                // model's turn is in flight (panel.busy), so the user can cancel.
                Item {
                    id: sendWrap
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: 2
                    width: 40; height: 40
                    // When busy, the button cancels the turn; otherwise it sends.
                    readonly property bool stop: panel.busy
                    property bool ready: stop || (bridge.connected && inputArea.text.trim().length > 0)

                    Rectangle {  // glow halo
                        anchors.centerIn: parent
                        width: 48; height: 48; radius: 24
                        color: "transparent"
                        border.color: sendWrap.stop ? Theme.danger : Theme.accentGlow
                        border.width: 2
                        opacity: sendWrap.ready ? 0.55 : 0.0
                        Behavior on opacity { NumberAnimation { duration: 160 } }
                        // pulse the halo while stopping is available, to read as "live"
                        SequentialAnimation on scale {
                            running: sendWrap.stop
                            loops: Animation.Infinite
                            NumberAnimation { from: 0.9; to: 1.1; duration: 700; easing.type: Easing.InOutSine }
                            NumberAnimation { from: 1.1; to: 0.9; duration: 700; easing.type: Easing.InOutSine }
                        }
                    }
                    Rectangle {
                        id: sendCircle
                        anchors.fill: parent
                        radius: 20
                        color: sendWrap.stop ? Theme.danger
                               : (sendWrap.ready ? Theme.accent : Theme.surfaceStrong)
                        border.color: sendWrap.stop ? Theme.danger
                                      : (sendWrap.ready ? Theme.accentBright : Theme.hairlineSoft)
                        border.width: 1
                        scale: sendMa.pressed && sendWrap.ready ? 0.92 : 1.0
                        Behavior on scale { NumberAnimation { duration: 90 } }
                        Behavior on color { ColorAnimation { duration: 140 } }
                        layer.enabled: sendWrap.ready
                        layer.effect: MultiEffect { blurEnabled: true; blur: 0.5; blurMax: 14; brightness: 0.15 }

                        // STOP square (shown while busy)
                        Rectangle {
                            anchors.centerIn: parent
                            width: 13; height: 13; radius: 2
                            color: Theme.inkOnAccent
                            visible: sendWrap.stop
                        }

                        Canvas {  // paper-plane / send arrow (hidden while busy)
                            anchors.centerIn: parent
                            width: 18; height: 18
                            visible: !sendWrap.stop
                            property color ink: sendWrap.ready ? Theme.inkOnAccent : Theme.textFaint
                            onInkChanged: requestPaint()
                            onPaint: {
                                var ctx = getContext("2d")
                                ctx.reset()
                                ctx.fillStyle = ink
                                ctx.beginPath()
                                ctx.moveTo(2, 9)
                                ctx.lineTo(16, 2)
                                ctx.lineTo(11, 9)
                                ctx.lineTo(16, 16)
                                ctx.closePath()
                                ctx.fill()
                            }
                        }
                        MouseArea {
                            id: sendMa
                            anchors.fill: parent
                            enabled: sendWrap.ready
                            cursorShape: sendWrap.ready ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: {
                                if (sendWrap.stop) panel.stopTurn()
                                else panel.submit()
                            }
                        }
                    }
                }
            }
        }
    }

    // Inject a plain user message into the transcript and send it (e.g. a CANVAS
    // widget `button` whose action is {"send":"…"}). Creates a session first if
    // none is active, just like submit(). The text becomes the next model input.
    function injectUser(message) {
        var t = ("" + message).trim()
        if (t.length === 0 || !bridge.connected)
            return
        if (bridge.sessionId.length === 0) {
            panel.pendingNewSession = true
            bridge.createSession("coder", panel.selectedBrain, panel.selectedModel)
        }
        chatModel.append({
            "kind": "message", "role": "user", "text": t,
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
            "streaming": false
        })
        panel.busy = true
        bridge.sendMessage(t)
        chatView.positionViewAtEnd()
    }

    // A button inside an inline widget (render_widget) fired an action. Same fixed
    // allow-set as CanvasPage.handleAction: send -> inject a user turn; skill ->
    // invoke a skill. Unknown keys do nothing; nothing is ever eval'd.
    function handleWidgetAction(action) {
        if (!action || typeof action !== "object")
            return
        if (typeof action.send === "string" && action.send.length > 0)
            panel.injectUser(action.send)
        else if (typeof action.skill === "string" && action.skill.length > 0)
            bridge.skillInvoke(action.skill,
                               (typeof action.args === "string") ? action.args : "")
    }

    // Inject a rendered skill (from the Skills page /invoke) into the transcript
    // as a user turn and send it. Creates a session first if none is active, just
    // like submit(). The skill text becomes the next model input.
    function injectSkill(name, message) {
        var t = ("" + message).trim()
        if (t.length === 0 || !bridge.connected)
            return
        if (bridge.sessionId.length === 0) {
            panel.pendingNewSession = true
            bridge.createSession("coder", panel.selectedBrain, panel.selectedModel)
        }
        chatModel.append({
            "kind": "message", "role": "user",
            "text": "/" + name + (t.length ? "\n\n" + t : ""),
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
            "streaming": false
        })
        panel.busy = true
        bridge.sendMessage(t)
        chatView.positionViewAtEnd()
    }

    // ---- Actions -----------------------------------------------------------
    function submit() {
        var t = inputArea.text.trim()
        if (t.length === 0 || !bridge.connected)
            return

        // First message creates a session (coder profile, selected brain + model).
        // Flag the create so the reconciler ADOPTS the new id instead of wiping the
        // user message we're about to echo.
        if (bridge.sessionId.length === 0) {
            panel.pendingNewSession = true
            bridge.createSession("coder", panel.selectedBrain, panel.selectedModel)
        }

        chatModel.append({
            "kind": "message", "role": "user", "text": t,
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
            "streaming": false
        })
        // Mark the turn in flight so the composer shows Stop until the model's
        // "final"/"error" event clears it.
        panel.busy = true
        bridge.sendMessage(t)
        inputArea.text = ""
        chatView.positionViewAtEnd()
    }

    // Cancel the model mid-turn (Stop button). Sends session.cancel and clears the
    // in-flight state locally so the composer flips back to the send arrow at once.
    function stopTurn() {
        bridge.cancelSession()
        panel.busy = false
        panel.thinking = false
    }

    // Start a fresh conversation: wipe the transcript and DROP the current session
    // so the next send (submit()) creates a brand-new session via createSession().
    // bridge.newSession() clears Bridge::m_sessionId without a daemon round-trip,
    // reproducing the "no current session yet" state the composer relies on.
    function startNewChat() {
        // Drop any half-started create and forget which session the transcript held,
        // so the reconciler can't later "adopt" into this wipe. newSession() emits
        // sessionIdChanged only when a session was actually set; clear explicitly too
        // so a fresh-on-fresh + New still resets everything.
        panel.pendingNewSession = false
        panel.chatSessionId = ""
        bridge.newSession()
        chatModel.clear()
        panel.busy = false
        panel.thinking = false
        inputArea.text = ""
        inputArea.forceActiveFocus()
    }
}
