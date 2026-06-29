"""Phone MCP tools — exposed ON the computer-use engine.

The native phone subsystem runs its own MCP gateway (phone/server on :8801), but
codex/claude only ever see the ISOLATED computer-use MCP server (per AGENTS.md the
brain runs --ignore-user-config / --strict-mcp-config). The separate `phone` HTTP
server therefore never reaches the brain. So we surface the phone tools HERE, on
the same engine the brain already drives, by proxying each call through jarvisd's
`phone.mcp` method (which holds the phone bearer). This keeps codex's own CLI MCP
servers off-by-default while still letting Jarvis call/text the user.

Every tool forwards to `phone.mcp {name, arguments}`; failures return {"error": …}.
There is also a generic `phone_tool` escape hatch so ANY of the ~56 phone tools is
reachable by name even if it has no explicit wrapper here.
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from computer_use_mcp import daemon_client


def _call(name: str, arguments: dict | None = None) -> str:
    """Proxy a single phone-server MCP tool through jarvisd's phone.mcp method."""
    try:
        args = {k: v for k, v in (arguments or {}).items() if v is not None}
        res = daemon_client.call("phone.mcp", {"name": name, "arguments": args}, timeout=240)
        return json.dumps(res)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"error": str(exc)})


def register(mcp: FastMCP) -> None:
    # ---- reach the user: call -------------------------------------------------
    @mcp.tool()
    def call_user(reason: str, urgency: str = "normal") -> str:
        """Call the primary user (ext 100) in-app for help/approval/incident.
        urgency: low|normal|high. Rings the user's Jarvis app."""
        return _call("call_user", {"reason": reason, "urgency": urgency})

    @mcp.tool()
    def call_user_and_wait(reason: str, say: str, fallback_to_text: bool = True) -> str:
        """Call the user, SPEAK `say` via TTS, wait for their spoken answer, and
        return the transcript. Falls back to an urgent in-app text if missed."""
        return _call("call_user_and_wait", {"reason": reason, "say": say,
                                            "fallback_to_text": fallback_to_text})

    @mcp.tool()
    def twilio_call_and_wait(say: str, to_number: str = "", reason: str = "") -> str:
        """Place a REAL PSTN phone call (Twilio), speak `say`, and return what the
        user said back. to_number defaults to the configured user number."""
        return _call("twilio_call_and_wait", {"say": say, "to_number": to_number, "reason": reason})

    @mcp.tool()
    def ask_on_call_and_wait(call_id: str, say: str) -> str:
        """Ask another question on an already-active call without hanging up."""
        return _call("ask_on_call_and_wait", {"call_id": call_id, "say": say})

    # ---- reach the user: text -------------------------------------------------
    @mcp.tool()
    def notify_user(message: str, title: str = "Jarvis", priority: str = "normal") -> str:
        """Send the user a text/notification into their Jarvis inbox (phone+desktop)."""
        return _call("notify_user", {"message": message, "title": title, "priority": priority})

    @mcp.tool()
    def notify_user_and_wait(message: str, title: str = "Jarvis") -> str:
        """Text the user and WAIT for their reply, returning it."""
        return _call("notify_user_and_wait", {"message": message, "title": title})

    @mcp.tool()
    def device_sms(phone_number: str, message: str) -> str:
        """Send a FREE SMS from the user's OWN phone SIM (needs the Android app
        online). Preferred for texting a real phone number."""
        return _call("device_sms", {"phone_number": phone_number, "message": message})

    @mcp.tool()
    def twilio_sms(message: str, to_number: str = "") -> str:
        """Send a PSTN SMS via Twilio (blocked until toll-free verification —
        prefer device_sms). to_number defaults to the user number."""
        return _call("twilio_sms", {"message": message, "to_number": to_number})

    @mcp.tool()
    def request_approval_by_phone(reason: str, say: str = "") -> str:
        """Ask the user to APPROVE an action by phone; returns their decision."""
        return _call("request_approval_by_phone", {"reason": reason, "say": say})

    @mcp.tool()
    def red_alert(message: str) -> str:
        """War room: broadcast an urgent alert to every agent + open a war-room thread."""
        return _call("red_alert", {"message": message})

    # ---- calls: manage --------------------------------------------------------
    @mcp.tool()
    def list_active_calls() -> str:
        """List all ringing/active calls with their state-machine state."""
        return _call("list_active_calls", {})

    @mcp.tool()
    def end_call(call_id: str, reason: str = "") -> str:
        """End an active call."""
        return _call("end_call", {"call_id": call_id, "reason": reason})

    @mcp.tool()
    def send_call_message(call_id: str, text: str) -> str:
        """Drop a text into a live call (synthesized to speech for a user/device)."""
        return _call("send_call_message", {"call_id": call_id, "text": text})

    @mcp.tool()
    def get_call_summary(call_id: str) -> str:
        """Get the stored summary for a call."""
        return _call("get_call_summary", {"call_id": call_id})

    @mcp.tool()
    def get_call_transcript(call_id: str) -> str:
        """Get the full STT/agent transcript for a call."""
        return _call("get_call_transcript", {"call_id": call_id})

    @mcp.tool()
    def call_extension(extension: str, from_extension: str = "101") -> str:
        """Call another internal extension/agent."""
        return _call("call_extension", {"extension": extension, "from_extension": from_extension})

    # ---- agents / extensions / screening -------------------------------------
    @mcp.tool()
    def list_extensions() -> str:
        """List all reachable extensions (100 user, 101 Jarvis, 102 Codex, …)."""
        return _call("list_extensions", {})

    @mcp.tool()
    def list_agents() -> str:
        """List the configured phone agents."""
        return _call("list_agents", {})

    @mcp.tool()
    def twilio_register_inbound_agent(extension: str) -> str:
        """Set which agent extension answers when the user dials the Twilio number."""
        return _call("twilio_register_inbound_agent", {"extension": extension})

    @mcp.tool()
    def twilio_screening_enable() -> str:
        """Enable AI call screening for unknown callers."""
        return _call("twilio_screening_enable", {})

    @mcp.tool()
    def twilio_screening_disable() -> str:
        """Disable AI call screening."""
        return _call("twilio_screening_disable", {})

    @mcp.tool()
    def twilio_allowlist_add(phone_number: str, label: str = "") -> str:
        """Allow a phone number for real Twilio calls/SMS (E.164, e.g. +13193898338)."""
        return _call("twilio_allowlist_add", {"phone_number": phone_number, "label": label})

    @mcp.tool()
    def twilio_allowlist_list() -> str:
        """List allow-listed numbers + the default user number."""
        return _call("twilio_allowlist_list", {})

    @mcp.tool()
    def twilio_set_user_number(phone_number: str) -> str:
        """Set the user's default phone number (call/SMS destination)."""
        return _call("twilio_set_user_number", {"phone_number": phone_number})

    @mcp.tool()
    def set_voice_profile(extension: str, voice_id: str = "", speed: float | None = None,
                          name: str = "") -> str:
        """Set an extension's call voice + speaking rate (voice_id = Mistral UUID)."""
        return _call("set_voice_profile", {"extension": extension, "voice_id": voice_id,
                                          "speed": speed, "name": name})

    @mcp.tool()
    def get_voice_profile(extension: str) -> str:
        """Get an extension's voice profile."""
        return _call("get_voice_profile", {"extension": extension})

    # ---- inbox / group / memory ----------------------------------------------
    @mcp.tool()
    def list_inbox(limit: int = 30) -> str:
        """List in-app message threads."""
        return _call("list_inbox", {"limit": limit})

    @mcp.tool()
    def get_thread_messages(thread_id: str) -> str:
        """Get all messages in a thread."""
        return _call("get_thread_messages", {"thread_id": thread_id})

    @mcp.tool()
    def wait_for_message_reply(message_id: str) -> str:
        """Wait for the user's reply to a specific message."""
        return _call("wait_for_message_reply", {"message_id": message_id})

    @mcp.tool()
    def start_group_chat(extensions: list[str], message: str = "", title: str = "") -> str:
        """Start a multi-agent group chat / war room."""
        return _call("start_group_chat", {"extensions": extensions, "message": message, "title": title})

    @mcp.tool()
    def post_group_message(thread_id: str, message: str) -> str:
        """Post a message into a group chat / war room thread."""
        return _call("post_group_message", {"thread_id": thread_id, "message": message})

    @mcp.tool()
    def store_memory(content: str, tags: list[str] | None = None) -> str:
        """Store a phone-subsystem memory (persists across calls + texts)."""
        return _call("store_memory", {"content": content, "tags": tags or []})

    @mcp.tool()
    def search_memory(query: str, limit: int = 10) -> str:
        """Search phone-subsystem memory."""
        return _call("search_memory", {"query": query, "limit": limit})

    # ---- generic escape hatch: ANY phone tool by name ------------------------
    @mcp.tool()
    def phone_tool(tool: str, arguments_json: str = "{}") -> str:
        """Call ANY phone-subsystem MCP tool by name (escape hatch for tools without
        an explicit wrapper above). `tool` is the tool name (see the /phone skill /
        internal_docs for the full ~56-tool list); `arguments_json` is a JSON object
        string of its arguments. Example:
          phone_tool("summarize_call", '{"call_id":"call_123"}')."""
        try:
            args = json.loads(arguments_json or "{}")
            if not isinstance(args, dict):
                return json.dumps({"error": "arguments_json must be a JSON object"})
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": f"bad arguments_json: {exc}"})
        return _call(tool, args)
