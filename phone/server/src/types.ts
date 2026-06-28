export type AuthRole = "admin" | "device" | "agent";

export type AuthContext = {
  role: AuthRole;
  tokenLabel: string;
  extension?: string;
  agentId?: string;
  /**
   * Set when the token is bound to a specific extension (e.g. per-agent tokens
   * issued via enrollment). The WebSocket auth layer rejects attempts to
   * attach to any other extension.
   */
  boundExtension?: string;
};

export type CallState =
  | "created"
  | "ringing"
  | "accepted"
  | "active"
  | "listening"
  | "transcribing"
  | "agent_thinking"
  | "speaking"
  | "waiting_for_user"
  | "ended"
  | "missed"
  | "rejected"
  | "failed"
  | "timeout";

export type ExtensionOwnerType = "user" | "device" | "agent" | "group";

export type JsonObject = Record<string, unknown>;

export type ExtensionRecord = {
  extension: string;
  owner_type: ExtensionOwnerType;
  owner_id: string;
  name: string;
  permissions: string;
  allowed_callers: string;
  online: number;
  busy: number;
  current_session_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

export type CallRecord = {
  id: string;
  from_extension: string;
  to_extension: string;
  state: CallState;
  reason: string | null;
  urgency: string | null;
  session_id: string | null;
  active_participant: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  failure_reason: string | null;
};

export type AgentRecord = {
  id: string;
  extension: string;
  name: string;
  adapter_type: string;
  permissions: string;
  capabilities: string;
  status: string;
  current_task: string | null;
  session_id: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WebSocketEvent = {
  type: string;
  [key: string]: unknown;
};
