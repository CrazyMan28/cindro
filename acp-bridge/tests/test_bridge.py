"""ACP <-> Contract A bridge tests, exercised against a fake Contract A daemon.

Sync test functions wrap ``asyncio.run`` (see harness.run) so they pass in the
engine venv (websockets + pytest, no pytest-asyncio).
"""

import pytest

from harness import Harness, MockDaemon, run


# -- (1) initialize handshake ------------------------------------------------
def test_initialize_handshake():
    async def body():
        mock = await MockDaemon().start()
        async with Harness(mock) as h:
            res = await h.initialize(name="Zed")
            assert res["protocolVersion"] == 1
            caps = res["agentCapabilities"]
            assert caps["loadSession"] is True
            assert caps["promptCapabilities"]["image"] is False
            assert res["authMethods"] == []
            assert res["agentInfo"]["name"] == "jarvis-acp"
            # initialize verified the daemon is reachable via a Contract A ping.
            assert any(m == "ping" for m, _ in mock.calls)
            assert h.bridge.daemon_reachable is True
        await mock.stop()
    run(body())


# -- (2) session/new: session.create THEN session.subscribe (scoping guard) --
def test_session_new_subscribes_immediately_after_create():
    async def body():
        mock = await MockDaemon().start()
        async with Harness(mock) as h:
            await h.initialize()
            sid = await h.new_session()
            assert sid == mock.created_sid

            methods = [m for m, _ in mock.calls]
            assert "session.create" in methods and "session.subscribe" in methods
            assert methods.index("session.create") < methods.index("session.subscribe")

            # The subscribe carried the new session id (client-scoped).
            sub = next(p for m, p in mock.calls if m == "session.subscribe")
            assert sid in sub["session_ids"]
            assert mock.subscribed == [sid]

            # session.create asked for the coworker profile + an ACP title.
            create = next(p for m, p in mock.calls if m == "session.create")
            assert create["profile"] == "coworker"
            assert create["title"].startswith("ACP:")
        await mock.stop()
    run(body())


# -- (3) session/prompt streams message chunks then stops on final -----------
def test_prompt_streams_message_then_end_turn():
    async def body():
        mock = await MockDaemon().start()

        async def on_send(d, ws, params):
            sid = params["session_id"]
            await d.emit(ws, sid, {"kind": "thinking", "text": "considering"})
            await d.emit(ws, sid, {"kind": "message", "role": "assistant",
                                   "text": "Hello from Jarvis"})
            await d.emit(ws, sid, {"kind": "final"})
        mock.on_send = on_send

        async with Harness(mock) as h:
            await h.initialize()
            sid = await h.new_session()
            res = await h.client.request(
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": "hi there"}]})
            assert res["stopReason"] == "end_turn"

            # The user text reached the daemon as session.send.
            send = next(p for m, p in mock.calls if m == "session.send")
            assert send["text"] == "hi there"

            # message -> agent_message_chunk, thinking -> agent_thought_chunk.
            assert "Hello from Jarvis" in " ".join(h.client.message_texts())
            thoughts = h.client.updates_of_kind("agent_thought_chunk")
            assert any("considering" in u["update"]["content"]["text"] for u in thoughts)
        await mock.stop()
    run(body())


# -- (3b) tool_call / tool_result map to ACP tool-call updates ---------------
def test_prompt_streams_tool_call_and_result():
    async def body():
        mock = await MockDaemon().start()

        async def on_send(d, ws, params):
            sid = params["session_id"]
            await d.emit(ws, sid, {"kind": "tool_call", "call_id": "c1",
                                   "name": "real_screen.browser_click",
                                   "args": {"selector": "#go"}})
            await d.emit(ws, sid, {"kind": "tool_result", "call_id": "c1",
                                   "ok": True, "output": "clicked"})
            await d.emit(ws, sid, {"kind": "final"})
        mock.on_send = on_send

        async with Harness(mock) as h:
            await h.initialize()
            sid = await h.new_session()
            res = await h.client.request(
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": "click"}]})
            assert res["stopReason"] == "end_turn"

            tc = h.client.updates_of_kind("tool_call")
            assert tc and tc[0]["update"]["toolCallId"] == "c1"
            assert tc[0]["update"]["status"] == "in_progress"
            assert tc[0]["update"]["rawInput"] == {"selector": "#go"}

            tu = h.client.updates_of_kind("tool_call_update")
            assert tu and tu[0]["update"]["toolCallId"] == "c1"
            assert tu[0]["update"]["status"] == "completed"
        await mock.stop()
    run(body())


# -- (4) approval -> request_permission -> approval.respond decision mapping --
@pytest.mark.parametrize("choice,expected", [
    ("allow_once", "allow"),
    ("allow_always", "always"),
    ("reject_once", "deny"),
    (None, "deny"),            # None -> client cancels the permission request
])
def test_approval_permission_and_decision_mapping(choice, expected):
    async def body():
        mock = await MockDaemon().start()

        async def on_send(d, ws, params):
            sid = params["session_id"]
            # No final here: the daemon emits final only after approval.respond.
            await d.emit(ws, sid, {"kind": "approval", "approval_id": "appr-1",
                                   "summary": "Run rm -rf /tmp/x?", "risk": "high"})
        mock.on_send = on_send

        async with Harness(mock) as h:
            h.client.permission_choice = choice
            await h.initialize()
            sid = await h.new_session()
            res = await h.client.request(
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": "go"}]})
            assert res["stopReason"] == "end_turn"

            # A permission request was surfaced to the editor with the summary +
            # the three option kinds.
            assert len(h.client.permission_requests) == 1
            pr = h.client.permission_requests[0]
            assert pr["sessionId"] == sid
            assert pr["toolCall"]["title"].startswith("Run rm -rf /tmp/x?")
            kinds = {o["kind"] for o in pr["options"]}
            assert {"allow_once", "allow_always", "reject_once"} <= kinds

            # The decision reached the daemon with the right mapping.
            assert len(mock.approvals) == 1
            assert mock.approvals[0]["approval_id"] == "appr-1"
            assert mock.approvals[0]["decision"] == expected
        await mock.stop()
    run(body())


# -- (5) events for OTHER session ids are NOT surfaced (scoping) --------------
def test_foreign_session_events_are_not_surfaced():
    async def body():
        mock = await MockDaemon().start()

        async def on_send(d, ws, params):
            sid = params["session_id"]
            # A different session's event must never reach this ACP session.
            await d.emit(ws, "sess_OTHER", {"kind": "message", "role": "assistant",
                                            "text": "FOREIGN-LEAK"})
            await d.emit(ws, sid, {"kind": "message", "role": "assistant",
                                   "text": "REAL-REPLY"})
            await d.emit(ws, sid, {"kind": "final"})
        mock.on_send = on_send

        async with Harness(mock) as h:
            await h.initialize()
            sid = await h.new_session()
            res = await h.client.request(
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": "hi"}]})
            assert res["stopReason"] == "end_turn"

            texts = h.client.message_texts()
            assert any("REAL-REPLY" in t for t in texts)
            assert all("FOREIGN-LEAK" not in t for t in texts)
        await mock.stop()
    run(body())


# -- (6) session/cancel stops the turn with stopReason cancelled -------------
def test_cancel_stops_turn():
    async def body():
        mock = await MockDaemon().start()

        async def on_send(d, ws, params):
            # Never emit final: the turn only ends because the client cancels.
            return
        mock.on_send = on_send

        async with Harness(mock) as h:
            await h.initialize()
            sid = await h.new_session()

            import asyncio
            prompt = asyncio.ensure_future(h.client.request(
                "session/prompt",
                {"sessionId": sid, "prompt": [{"type": "text", "text": "loop"}]}))
            await asyncio.sleep(0.1)  # let the turn start & block on the queue
            await h.client.notify("session/cancel", {"sessionId": sid})
            res = await asyncio.wait_for(prompt, timeout=5)
            assert res["stopReason"] == "cancelled"
            assert any(m == "session.cancel" for m, _ in mock.calls)
        await mock.stop()
    run(body())
