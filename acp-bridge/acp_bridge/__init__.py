"""jarvis-acp — an Agent Client Protocol (ACP) bridge for Jarvis.

ACP (https://agentclientprotocol.com) is the protocol Zed and JetBrains use to
drive external AI agents: newline-delimited JSON-RPC 2.0 over stdio, where the
editor spawns the agent process. This package makes Jarvis one of those agents
by translating ACP to/from the jarvisd Contract A control WebSocket.

- ``acp_bridge.control``  — async Contract A client (streaming, per-session queues).
- ``acp_bridge.bridge``   — the ACP <-> Contract A mapping.
- ``acp_bridge.main``     — the stdio JSON-RPC peer + entry point.
"""

__version__ = "0.1.0"

# The ACP protocol version this bridge speaks (schema/v1: an integer, currently 1).
ACP_PROTOCOL_VERSION = 1
