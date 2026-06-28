import { z } from "zod";

export const AuthEventSchema = z.object({
  type: z.literal("auth"),
  token: z.string().optional(),
  extension: z.string().regex(/^\d{2,8}$/),
  clientType: z.enum(["device", "agent", "admin"]).default("device"),
  agentId: z.string().optional(),
  name: z.string().optional()
});

export const AgentHelloSchema = z.object({
  type: z.literal("agent_hello"),
  token: z.string().optional(),
  agentId: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  name: z.string().optional(),
  adapterType: z.string().optional(),
  adapter_type: z.string().optional(),
  extension: z.string().regex(/^\d{2,8}$/).optional(),
  capabilities: z.array(z.string()).default([]),
  currentTask: z.string().optional(),
  current_task: z.string().optional(),
  sessionId: z.string().optional(),
  session_id: z.string().optional()
}).transform((value) => ({
  type: value.type,
  token: value.token,
  agentId: value.agentId ?? value.agent_id ?? "",
  name: value.name,
  adapterType: value.adapterType ?? value.adapter_type,
  extension: value.extension,
  capabilities: value.capabilities,
  currentTask: value.currentTask ?? value.current_task,
  sessionId: value.sessionId ?? value.session_id
})).refine((value) => value.agentId.length > 0, { message: "agent_id is required" });

export const DialEventSchema = z.object({
  type: z.literal("dial"),
  fromExtension: z.string().regex(/^\d{2,8}$/),
  toExtension: z.string().regex(/^\d{2,8}$/),
  reason: z.string().optional(),
  urgency: z.string().default("normal"),
  sessionId: z.string().optional()
});

export const CallIdEventSchema = z.object({
  type: z.string(),
  callId: z.string(),
  extension: z.string().regex(/^\d{2,8}$/).optional(),
  fromExtension: z.string().regex(/^\d{2,8}$/).optional(),
  reason: z.string().optional()
});

export const CallMessageEventSchema = z.object({
  type: z.literal("call_message"),
  callId: z.string(),
  fromExtension: z.string().regex(/^\d{2,8}$/),
  toExtension: z.string().regex(/^\d{2,8}$/).optional(),
  content: z.string().min(1),
  synthesize: z.boolean().default(true)
});

export const AudioStartEventSchema = z.object({
  type: z.literal("audio_start"),
  callId: z.string(),
  fromExtension: z.string().regex(/^\d{2,8}$/),
  toExtension: z.string().regex(/^\d{2,8}$/).optional(),
  audioFormat: z.string().optional(),
  codec: z.string().optional(),
  sampleRate: z.coerce.number().int().positive().default(16_000),
  channels: z.coerce.number().int().positive().default(1)
}).transform((value) => ({
  type: value.type,
  callId: value.callId,
  fromExtension: value.fromExtension,
  toExtension: value.toExtension,
  audioFormat: value.audioFormat ?? value.codec ?? "pcm_s16le",
  sampleRate: value.sampleRate,
  channels: value.channels
}));

export const AudioChunkEventSchema = z.object({
  type: z.literal("audio_chunk"),
  callId: z.string(),
  fromExtension: z.string().regex(/^\d{2,8}$/),
  audioBase64: z.string()
});

export const PresenceUpdateSchema = z.object({
  type: z.literal("presence_update"),
  extension: z.string().regex(/^\d{2,8}$/),
  online: z.boolean().default(true),
  currentSessionId: z.string().nullable().optional(),
  status: z.string().optional(),
  currentTask: z.string().optional()
});

export function parseJsonMessage(data: unknown) {
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  if (typeof data === "string") return JSON.parse(data) as Record<string, unknown>;
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>;
  return JSON.parse(String(data)) as Record<string, unknown>;
}
