"""The ACP <-> Contract A mapping.

``Bridge.handle(method, params, peer)`` is the dispatch surface the stdio
JSON-RPC peer (``acp_bridge.main.AcpPeer``) calls for every inbound ACP request
/ notification. ``peer`` is the object we use to talk *back* to the editor:

    await peer.notify("session/update", {...})           # streamed turn output
    outcome = await peer.request("session/request_permission", {...})

ACP methods handled (client -> agent):
    initialize · authenticate · session/new · session/load · session/prompt ·
    session/cancel

Contract A NormalizedBrainEvent kinds mapped into ACP ``session/update``:
    thinking     -> agent_thought_chunk
    message      -> agent_message_chunk   (role=user is dropped: the editor sent it)
    tool_call    -> tool_call             (status in_progress, rawInput=args)
    tool_result  -> tool_call_update      (status completed|failed, content+rawOutput)
    diff         -> agent_message_chunk   (fenced ```diff for visibility)
    approval     -> session/request_permission (a REQUEST back to the editor)
    final        -> stopReason end_turn   (resolves session/prompt)
    error        -> stopReason refusal    (+ an error message chunk first)
    turn_started / thread_started / usage / driving.state -> ignored
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from acp_bridge import ACP_PROTOCOL_VERSION, __version__
from acp_bridge.control import ControlClient, ControlError

log = logging.getLogger("acp_bridge.bridge")


class MethodNotFound(Exception):
    """Raised for an ACP method we don't implement (-> JSON-RPC -32601)."""


class SessionState:
    """Per ACP-session bridge state."""

    __slots__ = ("sid", "queue", "cancelled")

    def __init__(self, sid: str, queue: Any):
        self.sid = sid
        self.queue = queue
        self.cancelled = False


# A sentinel event pushed into a session queue to wake a blocked prompt turn the
# instant session/cancel arrives (rather than waiting for the daemon's next frame).
_CANCEL_SENTINEL = {"kind": "__acp_cancel__"}


def _tool_kind(name: str) -> str:
    """Map a Jarvis/MCP tool name to an ACP ToolKind (read|edit|delete|move|
    search|execute|think|fetch|other) for the editor's tool-call icon."""
    n = (name or "").lower().rsplit(".", 1)[-1]  # strip a "<server>." prefix

    def has(*subs: str) -> bool:
        return any(s in n for s in subs)

    if has("browser", "navigate", "fetch", "web_search", "http", "download"):
        return "fetch"
    if has("read", "cat", "get_file", "open", "screenshot", "list", "history"):
        return "read"
    if has("write", "edit", "create", "apply_patch", "replace", "insert", "render"):
        return "edit"
    if has("delete", "remove", "rm ", "clear"):
        return "delete"
    if has("move", "rename", "mv "):
        return "move"
    if has("search", "grep", "find", "query", "memory_search"):
        return "search"
    if has("shell", "bash", "exec", "run", "click", "type", "key", "press", "mouse"):
        return "execute"
    if has("think", "plan", "todo", "reason"):
        return "think"
    return "other"


def _tool_title(ev: dict[str, Any]) -> str:
    """A short human title for a tool call: ``<name> <one arg>``."""
    name = str(ev.get("name") or ev.get("tool") or "tool")
    name = name.rsplit(".", 1)[-1]
    args = ev.get("args") or ev.get("params") or {}
    bit = ""
    if isinstance(args, dict):
        for k in ("url", "path", "selector", "ref", "query", "name", "text", "value"):
            v = args.get(k)
            if v:
                bit = str(v)
                break
    if bit:
        if len(bit) > 80:
            bit = bit[:77] + "..."
        return f"{name} {bit}"
    return name


def _text_content(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


class Bridge:
    def __init__(self, control: ControlClient, *, default_client: str = "ACP client"):
        self.control = control
        self.client_name = default_client
        self.client_version = ""
        self.protocol_version = ACP_PROTOCOL_VERSION
        self.daemon_reachable = False
        self.sessions: dict[str, SessionState] = {}

    # -- dispatch -----------------------------------------------------------
    async def handle(self, method: str, params: dict[str, Any], peer: Any) -> Any:
        if method == "initialize":
            return await self.initialize(params)
        if method == "authenticate":
            # Contract A auth is a loopback token read from disk / env, not an ACP
            # auth method — nothing to do. Accept so a client that calls it anyway
            # proceeds. (We advertise authMethods: [] in initialize.)
            return {}
        if method == "session/new":
            return await self.session_new(params, peer)
        if method == "session/load":
            return await self.session_load(params, peer)
        if method == "session/prompt":
            return await self.session_prompt(params, peer)
        if method == "session/cancel":
            return await self.session_cancel(params)
        raise MethodNotFound(method)

    # -- initialize ---------------------------------------------------------
    async def initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        self.protocol_version = int(params.get("protocolVersion") or ACP_PROTOCOL_VERSION)
        ci = params.get("clientInfo") or {}
        if ci.get("name"):
            self.client_name = str(ci["name"])
        if ci.get("version"):
            self.client_version = str(ci["version"])

        # Verify the daemon is reachable (Contract A ping). We don't hard-fail:
        # the control client reconnects with backoff, so the daemon may come up
        # before the first session/new; we surface unreachability there instead.
        try:
            await self.control.call("ping", {}, timeout=8)
            self.daemon_reachable = True
        except Exception as exc:
            self.daemon_reachable = False
            log.warning("jarvisd not reachable at initialize: %s", exc)

        return {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "agentCapabilities": {
                "loadSession": True,
                "promptCapabilities": {
                    "image": False,
                    "audio": False,
                    "embeddedContext": False,
                },
            },
            "authMethods": [],
            "agentInfo": {"name": "jarvis-acp", "version": __version__},
        }

    # -- session lifecycle --------------------------------------------------
    async def session_new(self, params: dict[str, Any], peer: Any) -> dict[str, Any]:
        title = f"ACP: {self.client_name}"
        try:
            res = await self.control.call(
                "session.create", {"profile": "coworker", "title": title}, timeout=120
            )
        except ControlError as exc:
            raise RuntimeError(f"session.create failed: {exc.message}") from exc
        sid = res.get("session_id") or ""
        if not sid:
            raise RuntimeError("daemon returned no session_id")
        # Subscribe IMMEDIATELY (session-scoping guard) — without it the daemon
        # broadcasts every chat's events to this connection and we'd leak them.
        queue = await self.control.subscribe(sid)
        self.sessions[sid] = SessionState(sid, queue)
        return {"sessionId": sid}

    async def session_load(self, params: dict[str, Any], peer: Any) -> dict[str, Any]:
        sid = params.get("sessionId") or ""
        if not sid:
            raise RuntimeError("session/load requires sessionId")
        queue = await self.control.subscribe(sid)
        self.sessions[sid] = SessionState(sid, queue)
        # Replay the durable transcript as session/update notifications so the
        # editor can rebuild the conversation (ACP session/load contract).
        try:
            hist = await self.control.call(
                "session.history", {"session_id": sid, "limit": 1000}, timeout=30
            )
            for row in hist.get("events") or []:
                ev = row.get("ev") or {}
                await self._emit_event(sid, ev, peer, replay=True)
        except Exception as exc:
            log.warning("session/load replay failed for %s: %s", sid, exc)
        return {}

    async def session_cancel(self, params: dict[str, Any]) -> None:
        # ACP session/cancel is a NOTIFICATION (no response). Flag the session,
        # tell the daemon, and wake any blocked prompt turn immediately.
        sid = params.get("sessionId") or ""
        st = self.sessions.get(sid)
        if st is not None:
            st.cancelled = True
            st.queue.put_nowait(_CANCEL_SENTINEL)
        try:
            await self.control.call("session.cancel", {"session_id": sid}, timeout=20)
        except Exception as exc:
            log.info("session.cancel(%s) failed: %s", sid, exc)
        return None

    # -- the prompt turn ----------------------------------------------------
    async def session_prompt(self, params: dict[str, Any], peer: Any) -> dict[str, Any]:
        sid = params.get("sessionId") or ""
        st = self.sessions.get(sid)
        if st is None:
            # The editor should have created/loaded the session first; adopt it
            # defensively so a stray prompt still works.
            queue = await self.control.subscribe(sid)
            st = SessionState(sid, queue)
            self.sessions[sid] = st

        st.cancelled = False
        # Drain any stale events left from a previous turn so we start clean.
        _drain(st.queue)

        text = self._prompt_text(params.get("prompt") or [])
        try:
            await self.control.call("session.send", {"session_id": sid, "text": text},
                                    timeout=60)
        except ControlError as exc:
            raise RuntimeError(f"session.send failed: {exc.message}") from exc

        return await self._stream_turn(sid, st, peer)

    async def _stream_turn(self, sid: str, st: SessionState, peer: Any) -> dict[str, Any]:
        while True:
            if st.cancelled:
                return {"stopReason": "cancelled"}
            ev = await st.queue.get()
            kind = ev.get("kind") or ev.get("ev")
            if kind == "__acp_cancel__":
                return {"stopReason": "cancelled"}
            if kind == "final":
                return {"stopReason": "end_turn"}
            if kind == "error":
                msg = ev.get("message") or "error"
                await peer.notify("session/update", {
                    "sessionId": sid,
                    "update": {"sessionUpdate": "agent_message_chunk",
                               "content": _text_content(f"[error] {msg}")},
                })
                return {"stopReason": "refusal"}
            if kind == "approval":
                await self._handle_approval(sid, ev, peer)
                continue
            await self._emit_event(sid, ev, peer)

    async def _emit_event(self, sid: str, ev: dict[str, Any], peer: Any,
                          *, replay: bool = False) -> None:
        """Translate ONE non-terminal NormalizedBrainEvent into a session/update
        notification. (final/error/approval are handled by the turn loop; during
        a replay they're skipped.)"""
        kind = ev.get("kind") or ev.get("ev")

        if kind == "message":
            role = ev.get("role") or "assistant"
            if role == "user":
                return  # the editor already has the user's own message
            text = ev.get("text") or ""
            if text.strip():
                await peer.notify("session/update", {
                    "sessionId": sid,
                    "update": {"sessionUpdate": "agent_message_chunk",
                               "content": _text_content(text)},
                })
            return

        if kind == "thinking":
            text = ev.get("text") or ""
            if text.strip():
                await peer.notify("session/update", {
                    "sessionId": sid,
                    "update": {"sessionUpdate": "agent_thought_chunk",
                               "content": _text_content(text)},
                })
            return

        if kind == "tool_call":
            call_id = str(ev.get("call_id") or ev.get("id") or f"tool-{id(ev)}")
            update: dict[str, Any] = {
                "sessionUpdate": "tool_call",
                "toolCallId": call_id,
                "title": _tool_title(ev),
                "kind": _tool_kind(ev.get("name") or ev.get("tool") or ""),
                "status": "in_progress",
            }
            args = ev.get("args") or ev.get("params")
            if args is not None:
                update["rawInput"] = args
            await peer.notify("session/update", {"sessionId": sid, "update": update})
            return

        if kind == "tool_result":
            call_id = str(ev.get("call_id") or ev.get("id") or f"tool-{id(ev)}")
            ok = ev.get("ok", True)
            update = {
                "sessionUpdate": "tool_call_update",
                "toolCallId": call_id,
                "status": "completed" if ok else "failed",
            }
            output = ev.get("output")
            if output:
                update["content"] = [
                    {"type": "content", "content": _text_content(str(output))}
                ]
                update["rawOutput"] = output
            await peer.notify("session/update", {"sessionId": sid, "update": update})
            return

        if kind == "diff":
            path = ev.get("path") or ""
            patch = ev.get("patch") or ""
            body = f"```diff\n{('# ' + path + chr(10)) if path else ''}{patch}\n```"
            await peer.notify("session/update", {
                "sessionId": sid,
                "update": {"sessionUpdate": "agent_message_chunk",
                           "content": _text_content(body)},
            })
            return

        if replay and kind in ("final", "error", "approval"):
            return
        # turn_started / thread_started / usage / driving.state -> ignore.

    async def _handle_approval(self, sid: str, ev: dict[str, Any], peer: Any) -> None:
        """A Contract A ``approval`` event -> an ACP session/request_permission
        REQUEST back to the editor, then relay the decision to the daemon.

        approval_id prefixes 'takeover-' / 'inject-' are daemon-side kinds; we
        surface their ``summary`` text as-is (the option semantics are the same)."""
        approval_id = str(ev.get("approval_id") or "")
        summary = ev.get("summary") or "Cindro requests permission"
        risk = ev.get("risk") or ""

        title = summary
        if risk:
            title = f"{summary}  ({risk} risk)"

        options = [
            {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
            {"optionId": "allow_always", "name": "Always allow", "kind": "allow_always"},
            {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"},
        ]
        tool_call = {
            "toolCallId": approval_id or f"approval-{sid}",
            "title": title,
            "kind": "other",
            "status": "pending",
        }
        try:
            resp = await peer.request("session/request_permission", {
                "sessionId": sid,
                "toolCall": tool_call,
                "options": options,
            })
        except Exception as exc:
            log.warning("request_permission failed (%s); denying", exc)
            resp = {"outcome": {"outcome": "cancelled"}}

        decision = self._map_permission((resp or {}).get("outcome") or {})
        try:
            await self.control.call("approval.respond", {
                "session_id": sid,
                "approval_id": approval_id,
                "decision": decision,
            }, timeout=30)
        except Exception as exc:
            log.warning("approval.respond failed: %s", exc)

    @staticmethod
    def _map_permission(outcome: dict[str, Any]) -> str:
        """ACP permission outcome -> Contract A decision (allow|deny|always)."""
        if outcome.get("outcome") == "cancelled":
            return "deny"
        opt = outcome.get("optionId") or ""
        if opt == "allow_once":
            return "allow"
        if opt == "allow_always":
            return "always"
        # reject_once / reject_always / anything unexpected -> deny.
        return "deny"

    @staticmethod
    def _prompt_text(blocks: list[dict[str, Any]]) -> str:
        """Flatten an ACP prompt (list of ContentBlocks) into plain text."""
        parts: list[str] = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text" and b.get("text"):
                parts.append(str(b["text"]))
            elif t == "resource_link" and b.get("uri"):
                name = b.get("name") or b["uri"]
                parts.append(f"[{name}]({b['uri']})")
            elif t == "resource":
                res = b.get("resource") or {}
                if res.get("text"):
                    parts.append(str(res["text"]))
                elif res.get("uri"):
                    parts.append(str(res["uri"]))
        return "\n\n".join(parts)


def _drain(queue: Any) -> None:
    try:
        while True:
            queue.get_nowait()
    except Exception:
        pass
