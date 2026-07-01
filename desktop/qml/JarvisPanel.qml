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

    // recent sessions for the in-chat "Switch" picker (bridge.sessionsListed)
    ListModel { id: sessionModel }

    property bool thinking: false
    // True while the model's turn is in flight (between a sent message / first live
    // event and the turn's "final"/"error"). Drives the composer's Stop button.
    property bool busy: false

    // In-chat right-side panel: the model's PLAN/checklist (top) stacked ON TOP of
    // a live view of the nested agent desktop / chrome tab (below). It auto-opens
    // ONLY when there's something to show — a TODO/plan was created, OR an agent
    // desktop is actually in use (real-screen take-over / an explicit co-work) —
    // NOT merely because a session lazily provisioned a desktop (that fired on the
    // first message, which the user found too eager). The manual "▣ Watch" button
    // still opens it anytime to watch the desktop.
    readonly property bool agentDeskActive: bridge.driving || bridge.coworkerSessionId.length > 0
    // Whether the live agent-desktop view should render at all (a desktop exists).
    readonly property bool showDesktop: bridge.hasAgentDesktop || bridge.driving
                                        || bridge.coworkerSessionId.length > 0
    property bool peekOpen: false
    property real peekWidth: 320      // user-resizable (drag the left edge)
    property bool peekResizing: false
    property bool chatSearchOpen: false
    // The model's live plan/checklist (todo_write). Routed to the right-side panel
    // (PLAN card on top of the desktop view) instead of cluttering the transcript.
    property string todoSpec: ""
    property bool todoOpen: true
    readonly property bool hasPlan: panel.todoSpec.length > 0
    // Live subagents (child sessions of THIS chat) — filled from the sub-agent tree.
    // Each: {id,title,agent,status}. Click one to open it + watch its tool calls.
    property var subagents: []
    readonly property bool hasSubagents: panel.subagents.length > 0
    // If the CURRENT session is itself a subagent (has a parent), this holds the
    // parent id so we can show a "← Main agent" button to jump back.
    property string currentParentId: ""
    // Auto-open the panel on a new plan, a dispatched subagent, or an active
    // desktop — but an explicit dismissal (✕ / "▣ Hide") STICKS for that session
    // until the user reopens it ("▣ Watch"). Auto-opening from level signals with
    // no snooze is what made the panel pop back open endlessly (jarvis#72).
    // hasSubagents deliberately does NOT auto-open: it flickers false→true on
    // every session switch (subagents=[] then reload), which re-popped the panel.
    property string peekSnoozedSession: "__none__"
    function autoOpenPeek() {
        if (("" + bridge.sessionId) !== peekSnoozedSession)
            peekOpen = true
    }
    onHasPlanChanged: if (hasPlan) autoOpenPeek()
    onAgentDeskActiveChanged: if (agentDeskActive) autoOpenPeek()
    function refreshSubagents() { if (bridge.connected) bridge.loadSubAgentTree() }
    signal requestComputerPage()   // peek "Full" -> Computer page (AppShell wires it)
    // Slash-command navigation requests (AppShell wires these to page switches).
    signal requestVoice()
    signal requestAgents()
    signal requestSkills()

    property var searchMatches: []
    property int searchIndex: 0
    function runChatSearch(q) {
        var ql = ("" + q).toLowerCase().trim()
        var m = []
        if (ql.length >= 2)
            for (var i = 0; i < chatModel.count; i++)
                if (("" + chatModel.get(i).text).toLowerCase().indexOf(ql) >= 0) m.push(i)
        panel.searchMatches = m
        panel.searchIndex = 0
        if (m.length > 0) chatView.positionViewAtIndex(m[0], ListView.Center)
    }
    function chatSearchNext() {
        if (panel.searchMatches.length === 0) return
        panel.searchIndex = (panel.searchIndex + 1) % panel.searchMatches.length
        chatView.positionViewAtIndex(panel.searchMatches[panel.searchIndex], ListView.Center)
    }
    function closeChatSearch() { panel.chatSearchOpen = false; panel.searchMatches = []; panel.searchIndex = 0 }

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
        "Conquering the world", "Just chillin", "Pondering the universe", "Cooking", "Summoning electrons",
        "Reticulating splines", "Bending spacetime", "Consulting the oracle", "Doing crimes (legal ones)", "Vibing",
        "Untangling the matrix", "Herding photons", "Caffeinating neurons", "Computing the meaning of life", "Manifesting",
        "Hacking the mainframe", "Plotting world domination", "Aligning the stars", "Overthinking it", "Galaxy-braining",
        "Locking in", "Spinning up the hamster wheel", "Bribing the compiler", "Negotiating with the GPU", "Untangling spaghetti code",
        "Counting to infinity (twice)", "Dividing by almost-zero", "Asking the rubber duck", "Polishing the pixels", "Warming up the flux capacitor",
        "Rerouting the neutrinos", "Feeding the neural net", "Petting the algorithm", "Convincing the linter", "Wrangling tensors",
        "Buffering enthusiasm", "Defragmenting thoughts", "Compiling brilliance", "Loading the vibes", "Tuning the antennae",
        "Charging the arc reactor", "Greasing the gears", "Whispering to the kernel", "Consulting ancient scrolls", "Brewing more coffee",
        "Sharpening the pencils", "Rolling for initiative", "Aligning the chakras", "Untwisting the logic", "Counting electrons",
        "Stretching before the sprint", "Booting the brain cells", "Summoning the muse", "Crunching the numbers", "Cross-referencing the cosmos",
        "Tickling the transistors", "Asking nicely", "Reading the fine print", "Triangulating the answer", "Synthesizing wisdom",
        "Doing the math (carrying the one)", "Politely arguing with physics", "Folding the proteins", "Dusting off the manual", "Calibrating the vibes",
        "Reverse-engineering reality", "Threading the needle", "Untangling the headphones", "Chasing the bug", "Following the breadcrumbs",
        "Connecting the dots", "Spinning plates", "Juggling chainsaws (safely)", "Pondering orbs", "Decrypting the universe",
        "Loading the enthusiasm", "Looking busy", "Pretending to think", "Actually thinking", "Thinking very hard",
        "Doing a little dance", "Consulting the spreadsheet", "Counting sheep (the smart ones)", "Rebooting the imagination", "Stacking the bytes",
        "Optimizing the optimizer", "Refactoring the cosmos", "Untangling causality", "Negotiating with entropy", "Bargaining with the deadline",
        "Warming the tubes", "Spooling up", "Engaging warp drive", "Plotting a course", "Scanning the horizon",
        "Reading the room", "Doing recon", "Gathering intel", "Assembling the squad", "Sharpening the axe",
        "Filing the paperwork", "Stamping the forms", "Convincing myself", "Double-checking twice", "Triple-checking once",
        "Measuring twice, cutting once", "Untying the Gordian knot", "Solving for x", "Carrying the remainder", "Rounding up the usual suspects",
        "Herding cats", "Counting the cats", "Naming the cats", "Befriending the firewall", "Sweet-talking the database",
        "Coaxing the cache", "Flattering the framework", "Whittling the wood", "Sketching the blueprint", "Drafting the masterplan",
        "Consulting my notes", "Remembering where I put it", "Finding the thing", "Locating the other thing", "Cross-stitching the logic",
        "Knitting the threads", "Weaving the tapestry", "Tightening the bolts", "Oiling the joints", "Spinning the dials",
        "Flipping the switches", "Pulling the levers", "Pressing the big red button (carefully)", "Reading the tea leaves", "Shaking the magic 8-ball",
        "Rolling the dice", "Drawing the cards", "Casting the runes", "Channeling the energy", "Focusing the beam",
        "Adjusting the dials", "Fine-tuning the model", "Annealing the network", "Backpropagating vibes", "Gradient-descending",
        "Climbing the loss landscape", "Escaping a local minimum", "Avoiding the saddle point", "Embedding the meaning", "Tokenizing the thoughts",
        "Attention is all I need", "Sampling the distribution", "Lowering the temperature", "Raising the stakes", "Doubling down",
        "Hedging my bets", "Reading ahead", "Skipping to the good part", "Saving the best for last", "Connecting to the hive mind",
        "Pinging the satellites", "Bouncing off the moon", "Phoning a friend", "Asking the audience", "Going with my gut",
        "Trusting the process", "Embracing the chaos", "Taming the chaos", "Befriending the chaos", "Surfing the data stream",
        "Riding the wave", "Catching the current", "Sailing the seven C's", "Charting the unknown", "Mapping the territory",
        "Drawing the map", "Folding the map", "Reading the compass", "Finding true north", "Recalculating the route",
        "Taking the scenic path", "Avoiding the traffic", "Beating the rush", "Catching the train of thought", "Boarding the idea express",
        "Connecting the flights", "Packing light", "Checking the luggage", "Going through customs", "Stamping the passport",
        "Touching grass (virtually)", "Stretching the legs", "Taking a deep breath", "Centering myself", "Finding my zen",
        "Channeling my inner genius", "Unleashing the kraken", "Releasing the hounds", "Wrapping it up", "Sprinkling in some magic"
    ]
    property string thinkingPhrase: thinkingPhrases[0]
    // A RANDOM interval each time (not a fixed beat) so the quips drift in
    // organically — feels alive, like Claude Code / Codex.
    function randPhraseMs() { return 5000 + Math.floor(Math.random() * 9000) }
    Timer {
        id: thinkRoll
        interval: 7000; repeat: true; running: panel.busy
        onRunningChanged: if (running) { interval = panel.randPhraseMs(); thinkRoll.triggered() }
        onTriggered: {
            panel.thinkingPhrase =
                panel.thinkingPhrases[Math.floor(Math.random() * panel.thinkingPhrases.length)]
            interval = panel.randPhraseMs()   // reschedule the NEXT change at a random time
        }
    }
    // Poll the sub-agent tree while the right panel is open so dispatched subagents
    // (and their status) stay live in the pop-out. Cheap (session.list). Runs while
    // a turn is in flight too, so a subagent the MODEL dispatches (agent_start, via
    // MCP — the desktop never sees that call) is detected and auto-opens the panel.
    Timer {
        interval: 2500; repeat: true
        running: bridge.connected && (panel.busy || panel.peekOpen || panel.hasSubagents)
        onTriggered: panel.refreshSubagents()
        // Kick an immediate refresh whenever it starts (e.g. a turn begins).
        onRunningChanged: if (running) panel.refreshSubagents()
    }
    // Model list is populated dynamically from the daemon (onModelsListed). The empty
    // initializer is replaced as soon as the bridge responds to bridge.listModels().
    property var modelOptions: []
    property string selectedModel: modelOptions.length > 0 ? modelOptions[0] : ""

    // Which brain (engine) backs the next session: "codex" (default) or "claude".
    // Changing it re-queries model.list so the model picker shows THAT brain's
    // models. The session.create call passes this as the `brain` param.
    //
    // _availableBrains is populated from settings.get (onSettingsLoaded below).
    // brainOptions is a reactive binding so the brain picker auto-updates.
    property var _availableBrains: ({})
    readonly property var brainOptions: {
        var out = []
        if (_availableBrains.codex === true) out.push("codex")
        if (_availableBrains.claude === true) out.push("claude")
        out.push("api")
        return out.length > 1 ? out : ["codex", "claude", "api"]
    }
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

    // On startup (and reconnect) fetch settings (brain preference + availability)
    // and the default brain's model list.
    Component.onCompleted: {
        if (Qt.application.arguments.indexOf("--demo") !== -1)
            seedDemo()
        if (bridge.connected) {
            bridge.loadSettings()
            bridge.listModels(panel.selectedBrain)
        }
        if (typeof startPeek !== "undefined" && startPeek)
            panel.peekOpen = true
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

        // Sub-agent tree arrived: keep only the children of THIS chat as the live
        // subagents shown in the right-side pop-out.
        function onSubAgentTree(rows) {
            var kids = []
            var pid = ""
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i]
                var rid = "" + (r.id !== undefined ? r.id : "")
                var rparent = "" + (r.parent !== undefined ? r.parent : "")
                // A child needs a REAL parent match. Without the length guard, a
                // fresh chat (sessionId "") matched every root session ("" == "")
                // and listed ALL chats as subagents (jarvis#72).
                if (rparent.length > 0 && rparent === ("" + bridge.sessionId)) {
                    var rstatus = "" + (r.status !== undefined ? r.status : "")
                    // Subagents DISAPPEAR when done: only live (or failed) children
                    // stay in the pop-out. A finished run already reported back into
                    // this transcript as a [SUBAGENT DONE] summary turn (jarvis#72).
                    if (rstatus === "running" || rstatus === "starting" || rstatus === "error")
                        kids.push({
                            "id": rid,
                            "title": "" + (r.title !== undefined ? r.title : ""),
                            "agent": "" + (r.agent !== undefined ? r.agent : (r.brain !== undefined ? r.brain : "")),
                            "status": rstatus
                        })
                }
                // Is the CURRENT session itself a child? remember its parent.
                if (rid === ("" + bridge.sessionId) && rparent.length > 0)
                    pid = rparent
            }
            panel.subagents = kids
            panel.currentParentId = pid
        }
        // A subagent was dispatched (by the user via the palette OR by the model):
        // open the panel (unless the user dismissed it for this session) + refresh
        // the list so it shows up immediately.
        function onAgentDispatched(sessionId, agent) {
            panel.autoOpenPeek()
            panel.refreshSubagents()
        }

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

        // When the daemon connects after the panel loaded, fetch settings (to pick
        // up default_brain / available_brains) then fetch that brain's model list.
        function onConnectedChanged() {
            if (bridge.connected) {
                bridge.loadSettings()
                bridge.listModels(panel.selectedBrain)
            }
        }

        // settings.get response: update available brains and honour stored default.
        function onSettingsLoaded(s) {
            panel._availableBrains = s.available_brains !== undefined ? s.available_brains : ({})
            var db = s.default_brain !== undefined ? ("" + s.default_brain) : ""
            if (db.length > 0 && db !== panel.selectedBrain)
                panel.selectBrain(db)   // updates selectedBrain + re-queries model list
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
            // Drop the old session's subagents + reload this session's children.
            panel.subagents = []
            panel.refreshSubagents()
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
        // Fill the in-chat session switcher's list (bridge.listSessions()).
        function onSessionsListed(list) {
            sessionModel.clear()
            for (var i = 0; i < list.length && i < 40; i++) {
                var s = list[i]
                sessionModel.append({
                    "sid":   s.id !== undefined ? "" + s.id : "",
                    "title": (s.title !== undefined && ("" + s.title).length > 0)
                             ? "" + s.title : "Untitled session",
                    "brain": s.brain !== undefined ? "" + s.brain : ""
                })
            }
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
            // The model's plan/checklist (id "__todo__:<session>") goes to the
            // dedicated PLAN panel, NOT the transcript — scoped to this session.
            var twid = (w.id !== undefined) ? ("" + w.id) : ""
            if (twid.indexOf("__todo__") === 0) {
                var tsid = (w.session_id !== undefined) ? ("" + w.session_id) : ""
                if (tsid.length > 0 && tsid !== bridge.sessionId) return
                panel.todoSpec = JSON.stringify(w.spec)
                panel.todoOpen = true
                return
            }
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
            if (("" + id).indexOf("__todo__") === 0) { panel.todoSpec = ""; return }
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
        id: chatColumn
        anchors.fill: parent
        anchors.leftMargin: 16
        // Shrink to make room for the agent peek panel (a root-level sibling overlay
        // anchored to the right). Reliable here at the root, unlike inside HudFrame.
        anchors.rightMargin: 16 + (panel.peekOpen ? panel.peekWidth + 22 : 0)
        Behavior on anchors.rightMargin { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
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

            // Switch session — pick a recent conversation WITHOUT leaving the chat
            // (the old flow forced a trip to the Sessions page and back).
            Item {
                id: switchAnchor
                Layout.alignment: Qt.AlignVCenter
                implicitWidth: switchBtn.implicitWidth
                implicitHeight: switchBtn.implicitHeight

                Widgets.PillButton {
                    id: switchBtn
                    label: "⌄ Switch"
                    onClicked: {
                        if (sessionPicker.opened) { sessionPicker.close(); return }
                        bridge.listSessions()
                        sessionPicker.open()
                    }
                }

                Popup {
                    id: sessionPicker
                    y: switchBtn.height + 8
                    x: 0
                    width: 300
                    padding: 6
                    modal: false
                    background: Rectangle {
                        color: Theme.panel
                        radius: Theme.radiusSm
                        border.width: 1
                        border.color: Theme.accentDim
                    }
                    contentItem: ColumnLayout {
                        spacing: 4
                        Text {
                            Layout.leftMargin: 6
                            Layout.topMargin: 2
                            text: "SWITCH SESSION"
                            color: Theme.textFaint
                            font.family: Theme.fontDisplay
                            font.pixelSize: 8
                            font.letterSpacing: 1.8
                            font.weight: Font.DemiBold
                        }
                        ListView {
                            id: sessList
                            Layout.preferredWidth: 288
                            Layout.preferredHeight: Math.min(340, Math.max(40, contentHeight))
                            clip: true
                            model: sessionModel
                            delegate: Rectangle {
                                required property int index
                                required property var model
                                width: ListView.view.width
                                height: 42
                                radius: Theme.radiusXs
                                readonly property bool current: model.sid === bridge.sessionId
                                color: current ? Theme.accentFaint
                                       : (rowMa.containsMouse ? Theme.surfaceInput : "transparent")
                                Column {
                                    anchors.verticalCenter: parent.verticalCenter
                                    anchors.left: parent.left
                                    anchors.right: parent.right
                                    anchors.leftMargin: 10
                                    anchors.rightMargin: 10
                                    spacing: 1
                                    Text {
                                        width: parent.width
                                        text: model.title
                                        color: current ? Theme.accentBright : Theme.text
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 12
                                        font.weight: current ? Font.DemiBold : Font.Medium
                                        elide: Text.ElideRight
                                    }
                                    Text {
                                        text: (model.brain || "").toUpperCase()
                                        color: Theme.textFaint
                                        font.family: Theme.fontDisplay
                                        font.pixelSize: 8
                                        font.letterSpacing: 1.2
                                    }
                                }
                                MouseArea {
                                    id: rowMa
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (model.sid.length > 0 && model.sid !== bridge.sessionId)
                                            bridge.openSession(model.sid)
                                        sessionPicker.close()
                                    }
                                }
                            }
                        }
                        Text {
                            visible: sessionModel.count === 0
                            Layout.leftMargin: 6
                            Layout.bottomMargin: 4
                            text: "No other sessions yet."
                            color: Theme.textFaint
                            font.family: Theme.fontDisplay
                            font.pixelSize: 10
                        }
                    }
                }
            }

            // Search this chat (pops the search bar above the transcript).
            Widgets.PillButton {
                label: "⌕"
                Layout.alignment: Qt.AlignVCenter
                onClicked: panel.chatSearchOpen = !panel.chatSearchOpen
            }

            // Watch the agent's desktop / chrome tab inline (the peek panel).
            // Opening by hand clears the snooze; hiding snoozes this session.
            Widgets.PillButton {
                label: panel.peekOpen ? "▣ Hide" : "▣ Watch"
                Layout.alignment: Qt.AlignVCenter
                onClicked: {
                    if (panel.peekOpen) {
                        panel.peekOpen = false
                        panel.peekSnoozedSession = "" + bridge.sessionId
                    } else {
                        panel.peekSnoozedSession = "__none__"
                        panel.peekOpen = true
                    }
                }
            }

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

        // ===== Transcript search (slides down above the transcript) ==========
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: panel.chatSearchOpen ? 38 : 0
            visible: Layout.preferredHeight > 1
            clip: true
            radius: Theme.radiusSm
            color: Theme.surfaceDeep
            border.width: 1
            border.color: Theme.accentDim
            Behavior on Layout.preferredHeight { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
            onVisibleChanged: if (visible) searchField.forceActiveFocus()
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 8
                spacing: 8
                Text { text: "⌕"; color: Theme.accent; font.pixelSize: 15 }
                TextField {
                    id: searchField
                    Layout.fillWidth: true
                    placeholderText: "Search this chat…  (Enter = next, Esc = close)"
                    color: Theme.text
                    font.pixelSize: 13
                    background: Item {}
                    onTextChanged: panel.runChatSearch(text)
                    Keys.onEscapePressed: { text = ""; panel.closeChatSearch() }
                    Keys.onReturnPressed: panel.chatSearchNext()
                }
                Text { visible: panel.searchMatches.length > 0
                    text: (panel.searchIndex + 1) + "/" + panel.searchMatches.length
                    color: Theme.textMuted; font.pixelSize: 11 }
                Text { text: "✕"; color: Theme.textMuted; font.pixelSize: 13
                    MouseArea { anchors.fill: parent; anchors.margins: -6
                        cursorShape: Qt.PointingHandCursor
                        onClicked: { searchField.text = ""; panel.closeChatSearch() } } }
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
                // Animated session switch: fade + slide the transcript in when the
                // session changes (e.g. opening a subagent or jumping back).
                transform: Translate { id: chatSlide; y: 0 }
                Connections {
                    target: bridge
                    function onSessionIdChanged() { chatSwitchAnim.restart() }
                }
                SequentialAnimation {
                    id: chatSwitchAnim
                    ParallelAnimation {
                        NumberAnimation { target: chatView; property: "opacity"; from: 0.0; to: 1.0; duration: 240; easing.type: Easing.OutCubic }
                        NumberAnimation { target: chatSlide; property: "y"; from: 14; to: 0; duration: 260; easing.type: Easing.OutCubic }
                    }
                }
                // Keep a smaller off-screen buffer so a long transcript doesn't keep
                // dozens of heavy chat delegates (tool output, diffs) alive at once —
                // the main cause of lag past ~95 messages. ~2 screens is plenty.
                cacheBuffer: 300
                reuseItems: true
                boundsBehavior: Flickable.StopAtBounds

                // Fast mouse-wheel scrolling (the default Flickable step is a sliver).
                WheelHandler {
                    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                    onWheel: function(ev) {
                        var maxY = Math.max(0, chatView.contentHeight - chatView.height)
                        chatView.contentY = Math.max(0, Math.min(maxY, chatView.contentY - ev.angleDelta.y * 2.0))
                        ev.accepted = true
                    }
                }

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

            // ---- "/" command palette (rises above the composer) -------------
            SlashPalette {
                id: slashPalette
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.top
                anchors.bottomMargin: 8
                height: Math.min(340, panel.height - 120)
                cardWidth: width
                onPick: function(item) { panel.onSlashPick(item) }
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

                        onTextChanged: panel.updateSlash()

                        // While the "/" palette is open, Up/Down move the selection,
                        // Tab/Enter accept it, Esc closes it — handled here so the
                        // TextArea keeps focus (and keeps filtering as you type). We
                        // only accept the keys we use, so normal editing is intact
                        // when the palette is closed.
                        Keys.onPressed: function(event) {
                            if (!slashPalette.open)
                                return
                            if (event.key === Qt.Key_Down) { slashPalette.moveDown(); event.accepted = true }
                            else if (event.key === Qt.Key_Up) { slashPalette.moveUp(); event.accepted = true }
                            else if (event.key === Qt.Key_Tab) { slashPalette.accept(); event.accepted = true }
                            else if (event.key === Qt.Key_Escape) { slashPalette.hide(); event.accepted = true }
                        }

                        Keys.onReturnPressed: function(event) {
                            if (event.modifiers & Qt.ShiftModifier) {
                                event.accepted = false  // newline
                            } else if (slashPalette.open && slashPalette.resultList.length > 0) {
                                event.accepted = true
                                slashPalette.accept()   // pick the highlighted entry
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

    // ---- "← Main agent" pill: shown when viewing a SUBAGENT's session, jumps back
    // to the parent (main agent) chat. Floats at the top-left of the transcript.
    Rectangle {
        id: backToParentPill
        visible: panel.currentParentId.length > 0
        anchors.left: parent.left; anchors.top: parent.top
        anchors.leftMargin: 18; anchors.topMargin: 10
        z: 60
        implicitWidth: backRow.implicitWidth + 22
        height: 28; radius: 14
        color: backMa.containsMouse ? Theme.surfaceStrong : Theme.surface
        border.width: 1; border.color: Qt.rgba(0.694, 0.294, 1.0, 0.45)
        Behavior on color { ColorAnimation { duration: Theme.durFast } }
        // entrance
        opacity: visible ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 180 } }
        Row {
            id: backRow; anchors.centerIn: parent; spacing: 6
            Text { anchors.verticalCenter: parent.verticalCenter; text: "←"; color: Theme.violet; font.pixelSize: 13 }
            Text { anchors.verticalCenter: parent.verticalCenter; text: "MAIN AGENT"
                color: Theme.violet; font.family: Theme.fontDisplay; font.pixelSize: 9
                font.letterSpacing: 1.4; font.weight: Font.DemiBold }
        }
        MouseArea {
            id: backMa; anchors.fill: parent; hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: if (panel.currentParentId.length > 0) bridge.openSession(panel.currentParentId)
        }
    }

    // ---- agent peek panel (live view of the nested desktop / chrome tab) -------
    // A root-level sibling anchored to the right; the chat column shrinks to make
    // room. Slides in when Jarvis is driving (or you tap Watch). Replaces Browser.
    Rectangle {
        id: peekPanel
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: 6
        anchors.bottomMargin: 16
        anchors.rightMargin: 16
        width: panel.peekOpen ? panel.peekWidth : 0
        visible: width > 4
        clip: false
        color: "transparent"
        // Don't animate width while the user is dragging the edge (instant follow).
        Behavior on width { enabled: !panel.peekResizing; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }

        // ---- drag-to-resize handle (left edge) ----------------------------
        Rectangle {
            anchors.left: parent.left
            anchors.leftMargin: -10
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 8
            radius: 4
            visible: panel.peekOpen
            color: (rsMa.containsMouse || rsMa.pressed) ? Theme.accentDim : "transparent"
            Behavior on color { ColorAnimation { duration: 120 } }
            // grip dots
            Column {
                anchors.centerIn: parent
                spacing: 3
                visible: rsMa.containsMouse || rsMa.pressed
                Repeater { model: 3; delegate: Rectangle { width: 2; height: 2; radius: 1; color: Theme.accent } }
            }
            MouseArea {
                id: rsMa
                anchors.fill: parent
                anchors.margins: -4
                hoverEnabled: true
                cursorShape: Qt.SizeHorCursor
                property real lastX: 0
                // Track the cursor in SCENE coords (mapToItem(null,…)) so the handle
                // moving as the panel resizes doesn't feed back into the delta.
                onPressed: function(m) { panel.peekResizing = true; lastX = mapToItem(null, m.x, m.y).x }
                onReleased: panel.peekResizing = false
                onCanceled: panel.peekResizing = false
                onPositionChanged: function(m) {
                    if (!pressed) return
                    var px = mapToItem(null, m.x, m.y).x
                    var dx = lastX - px          // drag LEFT → wider
                    panel.peekWidth = Math.max(240, Math.min(panel.width - 360, panel.peekWidth + dx))
                    lastX = px
                }
            }
        }

        ColumnLayout {
            anchors.fill: parent
            spacing: 9
            RowLayout {
                Layout.fillWidth: true
                spacing: 7
                Rectangle { Layout.alignment: Qt.AlignVCenter; width: 6; height: 6; radius: 3
                    color: bridge.driving ? Theme.danger
                           : (panel.showDesktop ? Theme.success : Theme.accent) }
                Text { text: bridge.driving ? "Jarvis is driving"
                             : (panel.showDesktop ? "Agent desktop"
                                : (panel.hasSubagents && !panel.hasPlan ? "Subagents" : "Plan"))
                    color: Theme.text; font.family: Theme.fontDisplay; font.pixelSize: 11; font.weight: Font.DemiBold }
                Item { Layout.fillWidth: true }
                Text { text: "✕"; color: Theme.textMuted; font.pixelSize: 13
                    MouseArea { anchors.fill: parent; anchors.margins: -6
                        cursorShape: Qt.PointingHandCursor
                        // Dismissal sticks: snooze auto-open for this session (jarvis#72).
                        onClicked: {
                            panel.peekOpen = false
                            panel.peekSnoozedSession = "" + bridge.sessionId
                        } } }
            }

            // ---- PLAN card (the model's live todo/checklist) — ON TOP --------
            Rectangle {
                id: planCard
                Layout.fillWidth: true
                visible: panel.hasPlan
                implicitHeight: panel.todoOpen ? (planCol.implicitHeight + 18) : 32
                radius: Theme.radius
                color: Theme.surface
                border.width: 1; border.color: Theme.accentDim
                clip: true
                Behavior on implicitHeight { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }
                ColumnLayout {
                    id: planCol
                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                    anchors.margins: 9
                    spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        Text { text: "📋  PLAN"; color: Theme.accentBright; font.family: Theme.fontDisplay
                            font.pixelSize: 10; font.letterSpacing: 1.4; font.weight: Font.DemiBold }
                        Item { Layout.fillWidth: true }
                        // collapse / expand the checklist (keeps the card header)
                        Text { text: "▸"; color: Theme.textMuted; font.pixelSize: 13
                            rotation: panel.todoOpen ? 90 : 0
                            Behavior on rotation { NumberAnimation { duration: 150 } }
                            MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                                onClicked: panel.todoOpen = !panel.todoOpen } }
                        Text { text: "✕"; color: Theme.textMuted; font.pixelSize: 12; Layout.leftMargin: 8
                            MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
                                onClicked: panel.todoSpec = "" } }       // dismiss the plan
                    }
                    WidgetRenderer {
                        Layout.fillWidth: true
                        visible: panel.todoOpen
                        node: { try { return JSON.parse(panel.todoSpec) } catch (e) { return ({}) } }
                    }
                }
            }

            // ---- SUBAGENTS card (live child sessions) — click to watch one ----
            Rectangle {
                Layout.fillWidth: true
                visible: panel.hasSubagents
                implicitHeight: subCol.implicitHeight + 16
                radius: Theme.radius
                color: Theme.surface
                border.width: 1; border.color: Qt.rgba(0.694, 0.294, 1.0, 0.30)
                clip: true
                ColumnLayout {
                    id: subCol
                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                    anchors.margins: 9
                    spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        Text { text: "✦  SUBAGENTS"; color: Theme.violet; font.family: Theme.fontDisplay
                            font.pixelSize: 10; font.letterSpacing: 1.4; font.weight: Font.DemiBold }
                        Item { Layout.fillWidth: true }
                        Rectangle { radius: 5; implicitWidth: subN.implicitWidth + 12; implicitHeight: 16
                            color: Qt.rgba(0.694, 0.294, 1.0, 0.14)
                            Text { id: subN; anchors.centerIn: parent; text: "" + panel.subagents.length
                                color: Theme.violet; font.family: Theme.fontDisplay; font.pixelSize: 9 } }
                    }
                    Repeater {
                        model: panel.subagents
                        delegate: Rectangle {
                            required property var modelData
                            Layout.fillWidth: true
                            implicitHeight: 34
                            radius: Theme.radiusSm
                            color: subMa.containsMouse ? Theme.navActive : "transparent"
                            border.width: 1
                            border.color: subMa.containsMouse ? Theme.accentDim : Theme.hairlineSoft
                            Behavior on color { ColorAnimation { duration: Theme.durFast } }
                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 9; anchors.rightMargin: 9
                                spacing: 8
                                // status dot: pulse while running
                                Rectangle {
                                    Layout.alignment: Qt.AlignVCenter
                                    width: 7; height: 7; radius: 3.5
                                    readonly property bool running: modelData.status === "running" || modelData.status === "starting"
                                    color: running ? Theme.success : (modelData.status === "error" ? Theme.danger : Theme.textFaint)
                                    SequentialAnimation on opacity {
                                        running: parent.running; loops: Animation.Infinite
                                        NumberAnimation { from: 1.0; to: 0.35; duration: 700; easing.type: Easing.InOutSine }
                                        NumberAnimation { from: 0.35; to: 1.0; duration: 700; easing.type: Easing.InOutSine }
                                    }
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: (modelData.agent && modelData.agent.length ? modelData.agent + " · " : "") +
                                          (modelData.title && modelData.title.length ? modelData.title : modelData.id)
                                    color: Theme.text
                                    font.family: Theme.fontSans; font.pixelSize: 12
                                    elide: Text.ElideRight
                                }
                                // Status badge: RUNNING (pulsing) while the turn is in
                                // flight, DONE once it posts its summary (state→idle),
                                // ERROR on failure. This is what "shows as done" means.
                                Rectangle {
                                    readonly property bool isRunning: modelData.status === "running" || modelData.status === "starting"
                                    readonly property bool isError: modelData.status === "error"
                                    Layout.alignment: Qt.AlignVCenter
                                    radius: 4
                                    implicitWidth: badge.implicitWidth + 12
                                    implicitHeight: 16
                                    color: isError ? Qt.rgba(1.0, 0.30, 0.30, 0.16)
                                           : isRunning ? Qt.rgba(0.694, 0.294, 1.0, 0.16)
                                           : Qt.rgba(0.30, 0.85, 0.45, 0.16)
                                    Text {
                                        id: badge
                                        anchors.centerIn: parent
                                        text: parent.isError ? "ERROR" : parent.isRunning ? "RUNNING" : "DONE"
                                        color: parent.isError ? Theme.danger
                                               : parent.isRunning ? Theme.violet : Theme.success
                                        font.family: Theme.fontDisplay; font.pixelSize: 8
                                        font.letterSpacing: 1.0; font.weight: Font.DemiBold
                                    }
                                }
                                Text { text: "↗"; color: Theme.accent; font.pixelSize: 12 }
                            }
                            MouseArea {
                                id: subMa
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                // Open the subagent's session -> its full transcript (tool calls + all).
                                onClicked: bridge.openSession(modelData.id)
                            }
                        }
                    }
                }
            }

            // ---- live agent-desktop view (BELOW the plan/subagents) ---------
            AgentPeek {
                Layout.fillWidth: true; Layout.fillHeight: true
                visible: panel.showDesktop
            }
            // When there's no desktop (plan-only), keep the plan pinned to the top.
            Item { Layout.fillWidth: true; Layout.fillHeight: true; visible: !panel.showDesktop }

            RowLayout {
                spacing: 8
                visible: panel.showDesktop
                Widgets.PillButton { label: "⛶ Full"; onClicked: panel.requestComputerPage() }
                Widgets.PillButton { visible: bridge.driving; label: "■ Stop"
                    onClicked: bridge.takeOverCancel() }
            }
        }
    }

    // (The PLAN card now lives INSIDE the right-side peek panel, stacked on top of
    // the agent-desktop view — see peekPanel above.)

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
            // Send "/skill" into chat; the model loads it via skill_load.
            panel.sendSkillCommand(action.skill +
                ((typeof action.args === "string" && action.args.length > 0) ? " " + action.args : ""))
    }

    // Inject a rendered skill (from the Skills page /invoke) into the transcript
    // as a user turn and send it. Creates a session first if none is active, just
    // like submit(). The skill text becomes the next model input.
    // Invoking a skill = sending the user turn "/skill-name" (that's all that shows
    // in chat). The MODEL then calls the skill_load tool itself (per the system
    // prompt) to load + apply it — we do NOT dump the skill body or fake a tool call.
    function sendSkillCommand(name) {
        if (!bridge.connected)
            return
        var cmd = "/" + ("" + name).replace(/^\/+/, "")
        if (bridge.sessionId.length === 0) {
            panel.pendingNewSession = true
            bridge.createSession("coder", panel.selectedBrain, panel.selectedModel)
        }
        chatModel.append({
            "kind": "message", "role": "user", "text": cmd,
            "callId": "", "toolName": "", "approvalId": "", "risk": "", "ok": true,
            "streaming": false
        })
        panel.busy = true
        bridge.sendMessage(cmd)
        chatView.positionViewAtEnd()
    }

    // ---- Slash commands ("/" palette) --------------------------------------
    // Recompute the palette state as the user types. Open it only while typing a
    // command WORD (text starts with "/" and has no space yet); a space means the
    // user moved on to args, so close it.
    function updateSlash() {
        var t = inputArea.text
        if (t.length > 0 && t.charAt(0) === "/" && t.indexOf(" ") === -1) {
            if (!slashPalette.open) slashPalette.refresh()
            slashPalette.query = t.substring(1)
            slashPalette.open = true
        } else {
            slashPalette.open = false
        }
    }

    // The palette emitted pick(item): a command runs; a skill RUNS now; an agent
    // fills the input (it needs a task typed after it).
    function onSlashPick(item) {
        if (!item) return
        if (item.kind === "command") {
            panel.runSlashCommand(item.value)
        } else if (item.kind === "skill") {
            // Send "/skill-name" as the user turn — the model loads it via the
            // skill_load tool. To pass args, type "/<name> args" and press Enter.
            inputArea.text = ""
            slashPalette.open = false
            panel.sendSkillCommand(item.name)
        } else {
            // agent -> "/dispatch <name> " — the user types the task, then Enter.
            inputArea.text = item.value
            inputArea.cursorPosition = inputArea.text.length
            inputArea.forceActiveFocus()
            slashPalette.open = false
        }
    }

    // A built-in command picked from the palette: immediate ones run now; ones that
    // take an argument get their prefix dropped into the input for the user.
    function runSlashCommand(value) {
        var v = ("" + value).trim()
        var cmd = v.split(/\s+/)[0]
        if (cmd === "/new" || cmd === "/clear") { panel.startNewChat(); slashPalette.open = false; return }
        if (cmd === "/voice")  { panel.requestVoice();  inputArea.text = ""; slashPalette.open = false; return }
        if (cmd === "/agents") { panel.requestAgents(); inputArea.text = ""; slashPalette.open = false; return }
        if (cmd === "/skills") { panel.requestSkills(); inputArea.text = ""; slashPalette.open = false; return }
        if (cmd === "/help")   { inputArea.text = "/"; inputArea.cursorPosition = 1; slashPalette.refresh(); slashPalette.query = ""; slashPalette.open = true; return }
        // /model /brain /dispatch /agent /resume — need an argument: prefill prefix.
        inputArea.text = cmd + " "
        inputArea.cursorPosition = inputArea.text.length
        inputArea.forceActiveFocus()
        slashPalette.open = false
    }

    // Handle a submitted "/..." line. Returns true if it was a slash command (so
    // submit() doesn't also send it as chat text). Unknown "/word" => invoke a skill.
    function handleSlashSubmit(t) {
        var parts = t.split(/\s+/)
        var cmd = parts[0]
        var rest = t.substring(cmd.length).trim()
        switch (cmd) {
        case "/new": case "/clear": panel.startNewChat(); return true
        case "/voice":  panel.requestVoice();  return true
        case "/agents": panel.requestAgents(); return true
        case "/skills": panel.requestSkills(); return true
        case "/help":   inputArea.text = "/"; slashPalette.refresh(); slashPalette.query = ""; slashPalette.open = true; return true
        case "/model":  if (rest.length > 0) panel.selectedModel = rest; return true
        case "/brain":  if (rest.length > 0) panel.selectBrain(rest); return true
        case "/resume": if (rest.length > 0) bridge.openSession(rest); return true
        case "/agent":
            if (parts.length > 1 && parts[1].length > 0) {
                panel.pendingNewSession = true
                bridge.startAgentChat(parts[1])
            }
            return true
        case "/dispatch": {
            var a = parts.length > 1 ? parts[1] : ""
            var task = rest.substring(a.length).trim()
            if (a.length > 0 && task.length > 0)
                bridge.agentDispatch(a, task)
            return true
        }
        default:
            // Not a builtin -> a skill invocation. Let it go through as a NORMAL
            // user message ("/skill-name args"): the model loads it via skill_load.
            // (return false so submit() sends the text as-is, showing just "/name".)
            return false
        }
    }

    // ---- Actions -----------------------------------------------------------
    function submit() {
        var t = inputArea.text.trim()
        if (t.length === 0 || !bridge.connected)
            return

        // Slash command? Consume it (run / navigate / invoke skill) and stop.
        if (t.charAt(0) === "/" && panel.handleSlashSubmit(t)) {
            inputArea.text = ""
            slashPalette.open = false
            return
        }

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
