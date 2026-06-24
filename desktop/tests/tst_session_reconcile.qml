import QtQuick
import QtTest

// Regression test for the chat-transcript / session desync bugs:
//   - "+ New doesn't clear" / launch shows old chat
//   - desktop "mirrors" the Chrome co-work session
//   - opening a session shows the PREVIOUS session's content
//   - the user's own first message vanishes the instant the session is created
//   - a stale session.history reply replays into the wrong/empty session
//
// It exercises the EXACT state machine wired into JarvisPanel.qml (the
// onSessionIdChanged reconciler + submit()/startNewChat() + the live/history
// guards) against a mock bridge whose `sessionId` is a NOTIFYing property — so
// the same sessionIdChanged signal path fires. The reconciler logic here is a
// faithful copy of JarvisPanel.qml; gui_selftest covers that the real panel
// compiles/binds, this covers that the algorithm is correct across transitions.
Item {
    width: 50; height: 50

    // ---- Mock bridge: mirrors Bridge's sessionId property + the methods the
    // panel calls. createSession() is async (id arrives later via deliverCreate),
    // exactly like the real session.create round-trip.
    QtObject {
        id: bridge
        property string sessionId: ""
        function createSession() { /* async: id arrives via deliverCreate() */ }
        function deliverCreate(id) { sessionId = id }   // == session.create reply
        function openSession(id) { sessionId = id }     // == Bridge::openSession
        function newSession() { sessionId = "" }        // == Bridge::newSession
    }

    ListModel { id: chatModel }

    // ---- Panel under test: a faithful copy of JarvisPanel's session logic.
    Item {
        id: panel
        property string chatSessionId: ""
        property bool pendingNewSession: false
        property bool busy: false

        function submit(t) {
            if (bridge.sessionId.length === 0) {
                panel.pendingNewSession = true
                bridge.createSession()
            }
            chatModel.append({ "role": "user", "text": t })
            panel.busy = true
        }
        function startNewChat() {
            panel.pendingNewSession = false
            panel.chatSessionId = ""
            bridge.newSession()
            chatModel.clear()
            panel.busy = false
        }
        // == onSessionEvent live-append guard
        function liveEvent(sid, role, text) {
            if (sid !== bridge.sessionId) return
            panel.chatSessionId = bridge.sessionId
            chatModel.append({ "role": role, "text": text })
        }
        // == onSessionHistory replay guard
        function replayHistory(sid, rows) {
            if (sid !== bridge.sessionId) return
            chatModel.clear()
            panel.chatSessionId = sid
            for (var i = 0; i < rows.length; i++) chatModel.append(rows[i])
        }

        Connections {
            target: bridge
            function onSessionIdChanged() {
                if (bridge.sessionId === panel.chatSessionId) return
                if (panel.pendingNewSession && bridge.sessionId.length > 0) {
                    panel.pendingNewSession = false
                    panel.chatSessionId = bridge.sessionId
                    return
                }
                chatModel.clear()
                panel.busy = false
                panel.pendingNewSession = false
                panel.chatSessionId = bridge.sessionId
            }
        }
    }

    TestCase {
        name: "SessionReconcile"
        function init() {
            bridge.sessionId = ""
            panel.chatSessionId = ""
            panel.pendingNewSession = false
            panel.busy = false
            chatModel.clear()
        }

        // The "it removes what I said" bug: first message on a fresh chat must
        // survive the async session.create reply.
        function test_first_message_survives_create() {
            panel.submit("hello jarvis")
            compare(chatModel.count, 1)                 // optimistic echo present
            bridge.deliverCreate("sess_new")            // session.create reply lands
            compare(chatModel.count, 1, "user message must survive session.create")
            compare(chatModel.get(0).text, "hello jarvis")
            compare(panel.chatSessionId, "sess_new")
            verify(!panel.pendingNewSession)
        }

        // "+ New doesn't clear": must wipe the transcript and drop the session.
        function test_new_chat_clears() {
            bridge.sessionId = "sess_A"; panel.chatSessionId = "sess_A"
            chatModel.append({ "role": "assistant", "text": "old content" })
            panel.startNewChat()
            compare(chatModel.count, 0, "+ New must clear the transcript")
            compare(bridge.sessionId, "")
            compare(panel.chatSessionId, "")
        }

        // Stale session.history race: a late reply for a session that is no longer
        // current must NOT replay (the screenshot: content under empty session).
        function test_stale_history_dropped() {
            bridge.sessionId = ""; panel.chatSessionId = ""
            panel.replayHistory("sess_OLD", [{ "role": "user", "text": "old" }])
            compare(chatModel.count, 0, "history for a non-current session must not render")
        }

        // Chrome co-work leak: a foreign session's live event must never append.
        function test_foreign_live_event_dropped() {
            bridge.sessionId = "sess_MINE"; panel.chatSessionId = "sess_MINE"
            panel.liveEvent("sess_CHROME", "assistant", "chrome textbook content")
            compare(chatModel.count, 0, "foreign session event must be dropped")
        }

        // "open a session and it has the OLD chat content": switching sessions must
        // wipe first, then replay only the opened session.
        function test_open_other_session_wipes_then_replays() {
            bridge.sessionId = "sess_A"; panel.chatSessionId = "sess_A"
            chatModel.append({ "role": "assistant", "text": "A content" })
            bridge.openSession("sess_B")                // reconciler wipes A
            compare(chatModel.count, 0, "switching sessions must wipe old content")
            panel.replayHistory("sess_B", [{ "role": "user", "text": "B1" },
                                           { "role": "assistant", "text": "B2" }])
            compare(chatModel.count, 2)
            compare(panel.chatSessionId, "sess_B")
        }

        // Deleting the CURRENT session (Bridge::deleteSession -> newSession) must
        // clear the chat rather than leave it dangling under no session.
        function test_delete_current_clears() {
            bridge.sessionId = "sess_A"; panel.chatSessionId = "sess_A"
            chatModel.append({ "role": "assistant", "text": "A content" })
            bridge.newSession()                         // == deleteSession(current)
            compare(chatModel.count, 0, "deleting the current session must clear the chat")
            compare(panel.chatSessionId, "")
        }

        // Type a fresh chat AFTER a + New (chatSessionId already "") — the new id
        // must still be adopted (not wiped) so the message survives.
        function test_new_then_type_survives() {
            bridge.sessionId = "sess_A"; panel.chatSessionId = "sess_A"
            chatModel.append({ "role": "assistant", "text": "A content" })
            panel.startNewChat()
            compare(chatModel.count, 0)
            panel.submit("second chat msg")
            bridge.deliverCreate("sess_C")
            compare(chatModel.count, 1, "message after + New must survive create")
            compare(chatModel.get(0).text, "second chat msg")
            compare(panel.chatSessionId, "sess_C")
        }
    }
}
