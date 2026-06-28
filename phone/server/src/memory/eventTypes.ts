export const AGENT_PHONE_EVENT_TYPES = [
  "message_sent",
  "message_delivered",
  "message_read",
  "message_replied",
  "call_started",
  "call_missed",
  "call_rejected",
  "call_timeout",
  "fallback_sent",
  "fallback_replied",
  "live_log_drop_sent",
  "receipt_sent",
  "approval_requested",
  "approval_result",
  "action_executed"
] as const;

export type AgentPhoneEventType = typeof AGENT_PHONE_EVENT_TYPES[number];

export const AGENT_PHONE_MEMORY_TAGS = [
  "agent-phone",
  "call",
  "text",
  "approval",
  "receipt",
  "fallback",
  "log-drop"
] as const;

export type AgentPhoneMemoryTag = typeof AGENT_PHONE_MEMORY_TAGS[number];
