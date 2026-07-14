pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Effects
import CindroSidebar

// MISSION CONTROL REPLAY (jarvis#66) — scrub a past session like a video.
//
// Loads ANY session's full normalized event timeline (bridge.loadReplay ->
// replayLoaded, ungated + with per-event ts) and lets the user step/scrub/play
// through it: the transcript rebuilds up to the scrub index using the SAME
// ChatDelegate as the live chat, so tool calls, screenshots, diffs, thoughts
// and messages all appear exactly as they did — synced to a timeline with
// play/pause, step, and speed. Read-only: no sending, no approvals.
Item {
    id: page

    // The session being replayed (set by AppShell when opened from Sessions).
    property string replaySessionId: ""
    property var events: []            // raw [{seq,ts,kind,...}]
    property var meta: ({})            // session metadata
    property int cursor: 0             // how many events are currently shown
    property bool playing: false
    property real speed: 1.0
    readonly property int total: events.length
    // Mirrors JarvisPanel.thinkingRowId: the callId (generated here, since raw
    // "thinking" events carry no call_id of their own) of the reasoning row
    // currently accumulating chunks for the turn segment being rendered up to
    // page.cursor. Reset at the top of every renderTo() since it rebuilds from
    // scratch each time.
    property string thinkingRowId: ""

    function load(sid) {
        page.replaySessionId = sid
        page.events = []
        page.meta = ({})
        page.cursor = 0
        page.playing = false
        txModel.clear()
        if (sid.length > 0 && bridge.connected)
            bridge.loadReplay(sid)
    }

    // Rebuild the transcript to exactly `n` events (idempotent, cheap for the
    // small event counts a session holds; keeps scrubbing dead simple).
    function renderTo(n) {
        n = Math.max(0, Math.min(n, page.total))
        page.cursor = n
        txModel.clear()
        page.thinkingRowId = ""   // full rebuild -> any prior ref is stale
        for (var i = 0; i < n; i++)
            appendEvent(page.events[i])
        txView.positionViewAtEnd()
    }

    function stepBy(d) { page.playing = false; renderTo(page.cursor + d) }

    // Freeze the in-flight "thinking" row (if any): stamp its end timestamp and
    // clear the ref, mirroring JarvisPanel.freezeThinkingRow(). `endTs` is the
    // REAL recorded ts of the terminating event (this is a recording, not a live
    // stream, so we always have one — no Date.now() fallback needed here).
    function freezeThinkingRow(endTs) {
        if (page.thinkingRowId === "")
            return
        for (var fi = txModel.count - 1; fi >= 0; fi--) {
            var frow = txModel.get(fi)
            if (frow.kind === "thinking" && frow.callId === page.thinkingRowId) {
                var fd = { t: "", s: 0, e: 0 }
                try { fd = JSON.parse(frow.text) } catch (e) {}
                fd.e = endTs
                txModel.setProperty(fi, "text", JSON.stringify(fd))
                break
            }
        }
        page.thinkingRowId = ""
    }

    // A compact mirror of JarvisPanel.appendEvent (history/non-live variant):
    // folds tool_call+tool_result into one card, renders message/thinking/diff/
    // approval/error. No busy/streaming state — this is a recording.
    function appendEvent(ev) {
        var kind = ev.kind !== undefined ? ev.kind : ""
        // Real per-event ts (unix ms) recorded by the daemon — loadReplay/
        // session.history keeps it (unlike the gated live path), so the
        // thinking row's {s,e} envelope can use the ACTUAL recorded times
        // instead of Date.now() (which would be "whenever this scrub ran").
        var evTs = ev.ts !== undefined ? ev.ts : 0
        switch (kind) {
        case "thinking": {
            var thinkChunk = ev.text !== undefined ? ("" + ev.text) : ""
            if (page.thinkingRowId === "") {
                // Generated id (raw thinking events carry no call_id) — same
                // JSON-envelope-in-text + merge-by-callId idiom as tool_call/
                // tool_result below, keyed by the event's own seq for a stable,
                // collision-free id.
                var tid = "think-" + (ev.seq !== undefined ? ev.seq : txModel.count)
                page.thinkingRowId = tid
                txModel.append({ "kind":"thinking", "role":"tool",
                    "text": JSON.stringify({ t: thinkChunk, s: evTs, e: 0 }),
                    "callId": tid, "toolName":"", "approvalId":"", "risk":"", "ok":true, "streaming":false })
            } else {
                for (var thi = txModel.count - 1; thi >= 0; thi--) {
                    var thRow = txModel.get(thi)
                    if (thRow.kind === "thinking" && thRow.callId === page.thinkingRowId) {
                        var thd = { t: "", s: evTs, e: 0 }
                        try { thd = JSON.parse(thRow.text) } catch (e) {}
                        thd.t = ("" + thd.t) + thinkChunk
                        txModel.setProperty(thi, "text", JSON.stringify(thd))
                        break
                    }
                }
            }
            break
        }
        case "message":
            page.freezeThinkingRow(evTs)
            txModel.append({ "kind":"message", "role": ev.role !== undefined ? ev.role : "assistant",
                "text": ev.text !== undefined ? ev.text : "",
                "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "tool_call":
            page.freezeThinkingRow(evTs)
            txModel.append({ "kind":"tool", "role":"tool",
                "text": JSON.stringify({ i: ev.args !== undefined ? JSON.stringify(ev.args, null, 2) : "",
                                         o: "", d: false, s: ev.server !== undefined ? ("" + ev.server) : "" }),
                "callId": ev.call_id !== undefined ? ev.call_id : "",
                "toolName": ev.name !== undefined ? ev.name : "tool",
                "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "tool_result": {
            var cid = ev.call_id !== undefined ? ev.call_id : ""
            var outp = ev.output !== undefined ? ("" + ev.output) : ""
            var inp = ev.args !== undefined ? JSON.stringify(ev.args, null, 2) : ""
            var nm = (ev.name !== undefined && ("" + ev.name).length > 0) ? ("" + ev.name) : ""
            var srv = ev.server !== undefined ? ("" + ev.server) : ""
            var merged = false
            if (cid.length > 0) {
                for (var ti = txModel.count - 1; ti >= 0; ti--) {
                    var row = txModel.get(ti)
                    if (row.kind === "tool" && row.callId === cid) {
                        var d = { i:"", o:"", d:false, s:"" }
                        try { d = JSON.parse(row.text) } catch (e) {}
                        d.o = outp; d.d = true
                        if ((!d.i || d.i.length === 0) && inp.length > 0) d.i = inp
                        if ((!d.s || d.s.length === 0) && srv.length > 0) d.s = srv
                        txModel.setProperty(ti, "text", JSON.stringify(d))
                        txModel.setProperty(ti, "ok", ev.ok !== false)
                        if (nm.length > 0 && (row.toolName === "" || row.toolName === "tool"))
                            txModel.setProperty(ti, "toolName", nm)
                        merged = true; break
                    }
                }
            }
            if (!merged)
                txModel.append({ "kind":"tool", "role":"tool",
                    "text": JSON.stringify({ i: inp, o: outp, d: true, s: srv }),
                    "callId": cid, "toolName": nm.length > 0 ? nm : "result",
                    "approvalId":"", "risk":"", "ok": ev.ok !== false, "streaming":false })
            break
        }
        case "approval":
            page.freezeThinkingRow(evTs)
            txModel.append({ "kind":"approval", "role":"system",
                "text": ev.summary !== undefined ? ev.summary : "Approval requested",
                "callId":"", "toolName":"",
                "approvalId": ev.approval_id !== undefined ? ev.approval_id : "",
                "risk": ev.risk !== undefined ? ("" + ev.risk) : "", "ok":true, "streaming":false })
            break
        case "diff":
            page.freezeThinkingRow(evTs)
            txModel.append({ "kind":"diff", "role":"tool",
                "text": ev.patch !== undefined ? ev.patch : "",
                "callId":"", "toolName": ev.path !== undefined ? ev.path : "diff",
                "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "error":
            page.freezeThinkingRow(evTs)
            txModel.append({ "kind":"error", "role":"system",
                "text": ev.message !== undefined ? ev.message : "error",
                "callId":"", "toolName":"", "approvalId":"", "risk":"", "ok":true, "streaming":false })
            break
        case "final":
            // No visible row (matches the prior behavior — final carries no
            // renderable content), but it DOES end a turn segment: freeze any
            // still-open reasoning block so it doesn't read as active forever.
            page.freezeThinkingRow(evTs)
            break
        default: break
        }
    }

    // label of the event at index i (for the scrubber tooltip / step readout)
    function evLabel(i) {
        if (i < 0 || i >= page.total) return ""
        var ev = page.events[i]
        var k = ev.kind !== undefined ? ev.kind : "?"
        if (k === "tool_call" || k === "tool_result")
            return (ev.name !== undefined ? ev.name : "tool")
        if (k === "message") return (ev.role !== undefined ? ev.role : "msg") + " message"
        return k
    }

    ListModel { id: txModel }

    Connections {
        target: bridge
        function onReplayLoaded(session, evs) {
            if (("" + session.id) !== page.replaySessionId) return
            page.meta = session
            page.events = evs
            page.renderTo(evs.length)   // start fully played-out; scrub back to rewind
        }
    }

    // ---- playback clock ----------------------------------------------------
    Timer {
        id: playClock
        interval: Math.max(120, 700 / page.speed)
        repeat: true
        running: page.playing && page.cursor < page.total
        onTriggered: {
            if (page.cursor >= page.total) { page.playing = false; return }
            page.renderTo(page.cursor + 1)
        }
    }
    onPlayingChanged: if (playing && cursor >= total) renderTo(0)  // replay from start

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        PageHeader {
            title: "MISSION CONTROL // REPLAY"
            subtitle: page.replaySessionId.length === 0
                      ? "Open a session's ▶ Replay from the Sessions page"
                      : ((page.meta.title !== undefined && ("" + page.meta.title).length > 0
                          ? ("" + page.meta.title) : page.replaySessionId)
                         + "  ·  " + page.total + " events")
        }

        // ---- transcript (rebuilt up to the cursor) -------------------------
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: Theme.radius
            color: Theme.panelSoft
            border.width: 1
            border.color: Theme.hairlineSoft
            clip: true

            ListView {
                id: txView
                anchors.fill: parent
                anchors.margins: 10
                spacing: 8
                model: txModel
                boundsBehavior: Flickable.StopAtBounds
                delegate: ChatDelegate {}

                // empty state
                ColumnLayout {
                    anchors.centerIn: parent
                    visible: txModel.count === 0
                    spacing: 10
                    ArcReactor { size: 64; Layout.alignment: Qt.AlignHCenter
                        tint: Theme.accent; opacity: 0.7 }
                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: page.replaySessionId.length === 0
                              ? "NO SESSION LOADED" : "REWOUND TO START"
                        color: Theme.textMuted
                        font.family: Theme.fontDisplay
                        font.pixelSize: 12
                        font.letterSpacing: Theme.trackMid
                    }
                }
            }
        }

        // ---- transport bar: step / play / scrub / speed --------------------
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 64
            radius: Theme.radius
            color: Theme.surface
            border.width: 1
            border.color: Theme.accentDim
            enabled: page.total > 0

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                spacing: 12

                Widgets.PillButton { label: "⏮"; onClicked: page.renderTo(0) }
                Widgets.PillButton { label: "◀ Step"; onClicked: page.stepBy(-1) }
                Widgets.PillButton {
                    label: page.playing ? "⏸ Pause" : "▶ Play"
                    primary: !page.playing
                    onClicked: page.playing = !page.playing
                }
                Widgets.PillButton { label: "Step ▶"; onClicked: page.stepBy(1) }
                Widgets.PillButton { label: "⏭"; onClicked: page.renderTo(page.total) }

                // scrubber
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Slider {
                        id: scrub
                        Layout.fillWidth: true
                        from: 0; to: Math.max(1, page.total)
                        value: page.cursor
                        onMoved: { page.playing = false; page.renderTo(Math.round(value)) }
                        background: Rectangle {
                            x: scrub.leftPadding
                            y: scrub.topPadding + scrub.availableHeight / 2 - 2
                            width: scrub.availableWidth; height: 4; radius: 2
                            color: Theme.hairline
                            Rectangle {
                                width: scrub.visualPosition * parent.width
                                height: parent.height; radius: 2; color: Theme.accent
                            }
                        }
                        handle: Rectangle {
                            x: scrub.leftPadding + scrub.visualPosition * (scrub.availableWidth - width)
                            y: scrub.topPadding + scrub.availableHeight / 2 - height / 2
                            width: 14; height: 14; radius: 7
                            color: Theme.accentBright
                            border.color: Theme.accent; border.width: 1
                        }
                    }
                    Text {
                        text: page.cursor + " / " + page.total
                              + (page.cursor > 0 && page.cursor <= page.total
                                 ? "   ·   " + page.evLabel(page.cursor - 1) : "")
                        color: Theme.textMuted
                        font.family: Theme.fontMono
                        font.pixelSize: 10
                    }
                }

                // speed cycle
                Widgets.PillButton {
                    label: page.speed + "×"
                    onClicked: page.speed = (page.speed >= 4 ? 0.5
                                            : (page.speed < 1 ? 1 : page.speed * 2))
                }
            }
        }
    }
}
