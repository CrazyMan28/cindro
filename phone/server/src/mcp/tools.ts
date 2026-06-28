import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { requireHttpAuth } from "../auth/tokens.js";
import { CallService } from "../calls/callService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { AgentService } from "../agents/agentService.js";
import { MemoryService } from "../memory/memoryService.js";
import { ApprovalService } from "../approvals/approvalService.js";
import { MessageService, type MessageRow } from "../messaging/messageService.js";
import { inspectDangerousCommand } from "../security/dangerousCommands.js";
import { VoiceProfileService, clampSpeed } from "../audio/voiceProfiles.js";
import { WarRoomService } from "../messaging/warRoom.js";
import type { TranscriptWaitResult, WebSocketHub } from "../websocket/hub.js";
import type { CallRecord } from "../types.js";
import type { TwilioService } from "../twilio/twilioService.js";
import type { ScreeningService } from "../twilio/screeningService.js";
import { PSTN_EXTENSION, type TwilioBridge } from "../twilio/twilioBridge.js";

type ToolContext = {
  db: AppDatabase;
  calls: CallService;
  extensions: ExtensionService;
  agents: AgentService;
  memory: MemoryService;
  approvals: ApprovalService;
  messages: MessageService;
  wsHub: WebSocketHub;
  twilio?: TwilioService;
  twilioBridge?: TwilioBridge;
  screening?: ScreeningService;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown;
};

const zString = z.string().min(1);
const ExpectedResponseTypeSchema = z.enum(["approval", "instruction", "freeform"]).default("freeform");

export function registerMcpRoutes(app: FastifyInstance, config: AppConfig, db: AppDatabase, wsHub: WebSocketHub, twilio?: TwilioService, twilioBridge?: TwilioBridge, screening?: ScreeningService) {
  const auth = requireHttpAuth(config, db, ["admin", "agent"]);
  const context: ToolContext = {
    db,
    calls: new CallService(db),
    extensions: new ExtensionService(db),
    agents: new AgentService(db),
    memory: new MemoryService(db),
    approvals: new ApprovalService(db),
    messages: wsHub.messages,
    wsHub,
    twilio,
    twilioBridge,
    screening
  };

  app.get("/mcp/tools", { preHandler: auth }, async () => ({ tools: listTools() }));
  app.post("/mcp", { preHandler: auth }, async (request, reply) => {
    const body = z
      .object({
        jsonrpc: z.string().optional(),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string().optional(),
        params: z.unknown().optional(),
        tool: z.string().optional(),
        args: z.record(z.unknown()).optional()
      })
      .parse(request.body);

    if (body.method === "tools/list") {
      return jsonRpc(body.id, { tools: listTools() });
    }

    const callParams = z
      .object({
        name: z.string().optional(),
        arguments: z.record(z.unknown()).default({})
      })
      .parse(body.params ?? {});
    const toolName = body.tool ?? callParams.name;
    const args = body.args ?? callParams.arguments;
    if (!toolName) return reply.code(400).send(jsonRpcError(body.id, "missing_tool_name"));
    try {
      const result = await callTool(toolName, args, context);
      return jsonRpc(body.id, wrapToolResult(result));
    } catch (error) {
      return reply.code(400).send(jsonRpcError(body.id, error instanceof Error ? error.message : "tool_failed"));
    }
  });
}

export function registerMcpLocalRoutes(app: FastifyInstance, config: AppConfig, db: AppDatabase, wsHub: WebSocketHub, twilio?: TwilioService, twilioBridge?: TwilioBridge, screening?: ScreeningService) {
  // Localonly endpoint for Copilot/Claude dev clients that try OAuth discovery.
  // No Authorization required, but only allow loopback addresses for safety.
  const context: ToolContext = {
    db,
    calls: new CallService(db),
    extensions: new ExtensionService(db),
    agents: new AgentService(db),
    memory: new MemoryService(db),
    approvals: new ApprovalService(db),
    messages: wsHub.messages,
    wsHub,
    twilio,
    twilioBridge,
    screening
  };

  app.post("/mcp-local", async (request, reply) => {
    const ip = (request.ip ?? (request.raw && (request.raw.socket as any)?.remoteAddress) ?? "").toString();
    const allowed = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    if (!allowed.has(ip)) return reply.code(403).send({ error: "forbidden" });

    const body = z
      .object({
        jsonrpc: z.string().optional(),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string().optional(),
        params: z.unknown().optional(),
        tool: z.string().optional(),
        args: z.record(z.unknown()).optional()
      })
      .parse(request.body);

    // Handle JSON-RPC methods Copilot/Claude expect
    if (body.method === "initialize") {
      return reply.send({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-phone", version: "0.1.0" }
        }
      });
    }

    if (body.method === "notifications/initialized") {
      // notification - no response required
      return reply.code(204).send();
    }

    if (body.method === "ping") {
      return reply.send(jsonRpc(body.id, { ok: true }));
    }

    if (body.method === "tools/list") {
      return reply.send(jsonRpc(body.id, { tools: listTools() }));
    }

    if (body.method === "tools/call") {
      const callParams = z
        .object({
          name: z.string().optional(),
          arguments: z.record(z.unknown()).default({})
        })
        .parse(body.params ?? {});
      const toolName = body.tool ?? callParams.name;
      const args = body.args ?? callParams.arguments;
      if (!toolName) return reply.code(400).send(jsonRpcError(body.id, "missing_tool_name"));
      try {
        const result = await callTool(toolName, args, context);
      return reply.send(jsonRpc(body.id, wrapToolResult(result)));
      } catch (error) {
        return reply.code(400).send(jsonRpcError(body.id, error instanceof Error ? error.message : "tool_failed"));
      }
    }

    return reply.code(400).send(jsonRpcError(body.id, "unknown_method"));
  });
}

export async function callTool(toolName: string, args: Record<string, unknown>, context: ToolContext) {
  const tool = TOOL_DEFINITIONS.find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`unknown MCP tool ${toolName}`);
  const started = context.db.now();
  try {
    const result = await tool.handler(args, context);
    context.db.sqlite
      .prepare(
        `INSERT INTO mcp_tool_calls (id, session_id, tool_name, args, result, success, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(context.db.id("mcp"), typeof args.session_id === "string" ? args.session_id : null, toolName, context.db.json(args), context.db.json(result), started);
    return result;
  } catch (error) {
    context.db.sqlite
      .prepare(
        `INSERT INTO mcp_tool_calls (id, session_id, tool_name, args, result, success, error, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`
      )
      .run(context.db.id("mcp"), typeof args.session_id === "string" ? args.session_id : null, toolName, context.db.json(args), error instanceof Error ? error.message : "tool_failed", started);
    throw error;
  }
}

export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "call_user",
    description: "Call the primary user at extension 100 for help, approval, or incident handling.",
    inputSchema: schema({ reason: "string", urgency: "string?", session_id: "string?", from_extension: "string?" }),
    handler: (args, { calls, wsHub }) => {
      const parsed = z.object({ reason: zString, urgency: z.string().default("normal"), session_id: z.string().optional(), from_extension: z.string().default("101") }).parse(args);
      const call = calls.dial({ fromExtension: parsed.from_extension, toExtension: "100", reason: parsed.reason, urgency: parsed.urgency, sessionId: parsed.session_id });
      wsHub.notifyIncomingCall(call);
      return call;
    }
  },
  {
    name: "call_user_and_wait",
    description: "Call the user, speak a prompt through TTS, wait for the next spoken answer, and return the STT transcript. If the call is missed/rejected/timed-out and fallback_to_text is true (default), creates an urgent in-app message so the user can respond in the app and returns the reply.",
    inputSchema: schema({
      from_extension: "string",
      to_extension: "string?",
      reason: "string",
      say: "string",
      urgency: "string?",
      session_id: "string?",
      timeout_seconds: "number?",
      expected_response_type: "string?",
      fallback_to_text: "boolean?",
      fallback_timeout_seconds: "number?",
      fallback_options: "string[]?",
      escalate_to_twilio: "boolean?",
      escalate_phone_number: "string?"
    }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          from_extension: zString,
          to_extension: z.string().default("100"),
          reason: zString,
          say: zString,
          urgency: z.string().default("normal"),
          session_id: z.string().optional(),
          timeout_seconds: z.number().int().positive().default(300),
          expected_response_type: ExpectedResponseTypeSchema,
          fallback_to_text: z.boolean().default(true),
          fallback_timeout_seconds: z.number().int().positive().optional(),
          fallback_options: z.array(z.string()).optional(),
          escalate_to_twilio: z.boolean().default(false),
          escalate_phone_number: z.string().optional()
        })
        .parse(args);
      return callAndWaitForUser(parsed, context);
    }
  },
  {
    name: "ask_on_call_and_wait",
    description: "Ask a follow-up question on an active call and return the next user transcript.",
    inputSchema: schema({ call_id: "string", say: "string", timeout_seconds: "number?", expected_response_type: "string?" }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          call_id: zString,
          say: zString,
          timeout_seconds: z.number().int().positive().default(180),
          expected_response_type: ExpectedResponseTypeSchema
        })
        .parse(args);
      const call = context.calls.get(parsed.call_id);
      if (!call) throw new Error("call not found");
      if (!["active", "listening", "transcribing", "agent_thinking", "speaking", "waiting_for_user"].includes(call.state)) {
        throw new Error(`call must be active; current state is ${call.state}`);
      }
      const participants = inferAgentAndUser(call, context.extensions);
      const started = Date.now();
      context.wsHub.setCallState(call.id, "speaking", participants.agentExtension);
      await context.wsHub.synthesizeForCall(call.id, participants.agentExtension, participants.userExtension, parsed.say);
      context.wsHub.setCallState(call.id, "waiting_for_user", participants.agentExtension);
      const transcriptOutcome = await waitForTranscriptOrFailure(context, call.id, participants.userExtension, parsed.timeout_seconds * 1000);
      if (transcriptOutcome.kind === "timeout") {
        context.wsHub.timeoutCall(call.id, "user_response_timeout");
        return { ok: false, call_id: call.id, reason: "timeout", decision: "timeout" };
      }
      if (transcriptOutcome.kind === "failed") {
        return { ok: false, call_id: call.id, reason: transcriptOutcome.reason, decision: "failed" };
      }
      const transcript = transcriptOutcome.transcript;
      context.wsHub.setCallState(call.id, "active", participants.userExtension);
      const decision = classifyResponse(transcript.text, parsed.expected_response_type);
      const memory = storeCallResponse(context, call, transcript.text, decision, transcript.transcriptId, parsed.expected_response_type);
      return {
        ok: true,
        call_id: call.id,
        user_transcript: transcript.text,
        decision,
        duration_seconds: elapsedSeconds(started),
        session_id: call.session_id,
        memory_id: (memory as { id?: string }).id,
        transcript_id: transcript.transcriptId
      };
    }
  },
  {
    name: "call_extension",
    description: "Call an internal private extension.",
    inputSchema: schema({ extension: "string", reason: "string?", urgency: "string?", session_id: "string?", from_extension: "string?" }),
    handler: (args, { calls, wsHub }) => {
      const parsed = z.object({ extension: zString, reason: z.string().optional(), urgency: z.string().default("normal"), session_id: z.string().optional(), from_extension: z.string().default("101") }).parse(args);
      const call = calls.dial({ fromExtension: parsed.from_extension, toExtension: parsed.extension, reason: parsed.reason, urgency: parsed.urgency, sessionId: parsed.session_id });
      wsHub.notifyIncomingCall(call);
      return call;
    }
  },
  {
    name: "end_call",
    description: "End an active call, notify participants, and store a summary.",
    inputSchema: schema({ call_id: "string", extension: "string?", reason: "string?", summary: "string?" }),
    handler: (args, { calls, memory, wsHub }) => {
      const parsed = z.object({ call_id: zString, extension: z.string().default("101"), reason: z.string().optional(), summary: z.string().optional() }).parse(args);
      const call = calls.end(parsed.call_id, parsed.extension, parsed.reason);
      wsHub.sendToCall(call.id, { type: "call_end", call });
      const summary = parsed.summary
        ? memory.storeMemory({ scope: "call", key: `${call.id}:summary`, content: parsed.summary, tags: ["call", "summary"] })
        : memory.summarizeCall(call.id);
      if (call.session_id && parsed.summary) {
        memory.appendSessionEvent(call.session_id, "call_summary", parsed.summary, { callId: call.id });
      }
      return { ok: true, call_id: call.id, state: call.state, summary };
    }
  },
  {
    name: "send_call_message",
    description: "Send a text fallback message into a call and synthesize it to user audio when addressed to a device.",
    inputSchema: schema({ call_id: "string", message: "string", from_extension: "string?", to_extension: "string?" }),
    handler: async (args, { calls, extensions, wsHub }) => {
      const parsed = z.object({ call_id: zString, message: zString, from_extension: z.string().default("101"), to_extension: z.string().optional() }).parse(args);
      const call = calls.get(parsed.call_id);
      if (!call) throw new Error("call not found");
      const to = parsed.to_extension ?? (call.from_extension === parsed.from_extension ? call.to_extension : call.from_extension);
      wsHub.sendToExtension(to, { type: "call_message", callId: parsed.call_id, fromExtension: parsed.from_extension, toExtension: to, content: parsed.message });
      const target = extensions.get(to);
      if (target && ["device", "user"].includes(target.owner_type)) {
        return wsHub.synthesizeForCall(parsed.call_id, parsed.from_extension, to, parsed.message);
      }
      const message = calls.addMessage(parsed.call_id, call.session_id ?? undefined, parsed.from_extension, to, "agent", parsed.message);
      return message;
    }
  },
  {
    name: "list_extensions",
    description: "List internal extensions and online/busy status.",
    inputSchema: schema({}),
    handler: (_args, { extensions }) => extensions.list()
  },
  {
    name: "twilio_call_and_wait",
    description:
      "Place a REAL phone call (Twilio) to an allowlisted number — default: the configured user number — speak the prompt, and wait for the spoken reply. Behaves like call_user_and_wait but over the telephone network; ask_on_call_and_wait / send_call_message / end_call work on the returned call_id. Uses the server Mistral voice (on-device Jarvis can't run on a phone line). Trial account: only verified numbers, and Twilio plays a trial preamble first. Real calls cost balance — prefer the in-app call unless the app is unreachable or the user asked for a real call.",
    inputSchema: schema({
      to_number: "string?",
      reason: "string",
      say: "string",
      from_extension: "string?",
      urgency: "string?",
      session_id: "string?",
      timeout_seconds: "number?",
      expected_response_type: "string?",
      fallback_to_sms: "boolean?"
    }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          to_number: z.string().optional(),
          reason: zString,
          say: zString,
          from_extension: z.string().default("101"),
          urgency: z.string().default("normal"),
          session_id: z.string().optional(),
          timeout_seconds: z.number().int().positive().default(300),
          expected_response_type: ExpectedResponseTypeSchema,
          fallback_to_sms: z.boolean().default(false)
        })
        .parse(args);
      return twilioCallAndWait(parsed, context);
    }
  },
  {
    name: "twilio_sms",
    description:
      "Send a REAL SMS from the Twilio number to an allowlisted phone number (default: the configured user number). Trial caveat: toll-free SMS may be blocked until toll-free verification completes — voice calls are unaffected.",
    inputSchema: schema({ to_number: "string?", body: "string", session_id: "string?" }),
    handler: async (args, context) => {
      const parsed = z.object({ to_number: z.string().optional(), body: zString, session_id: z.string().optional() }).parse(args);
      const twilio = requireTwilio(context);
      const toNumber = resolveTargetNumber(twilio, parsed.to_number);
      const result = await twilio.sendSms({ toNumber, body: parsed.body });
      context.db.event("twilio.sms_sent", { sid: result.sid, to: result.toNumber }, undefined, undefined, parsed.session_id);
      return { ok: true, sid: result.sid, to_number: result.toNumber };
    }
  },
  {
    name: "device_sms",
    description:
      "Send a REAL SMS from the user's OWN phone (their SIM / carrier) — free, instant, no Twilio and no registration. PREFER THIS over twilio_sms for texting real phone numbers. The user's phone must be online and have granted SMS permission in the app.",
    inputSchema: schema({ to_number: "string", body: "string", session_id: "string?" }),
    handler: (args, { wsHub, db }) => {
      const parsed = z.object({ to_number: zString, body: zString, session_id: z.string().optional() }).parse(args);
      if (!wsHub.isExtensionOnline("100")) {
        throw new Error("device_offline: the user's phone is not connected, can't send from the SIM right now");
      }
      wsHub.sendToExtension("100", { type: "send_sms", number: parsed.to_number, body: parsed.body });
      db.event("device.sms_requested", { to: parsed.to_number }, "100", undefined, parsed.session_id);
      return { ok: true, to_number: parsed.to_number, via: "device_sim" };
    }
  },
  {
    name: "twilio_allowlist_add",
    description:
      "Allow a phone number for real Twilio calls/SMS (E.164 like +18449040251, or US 10-digit). Trial accounts ALSO require the number to be verified in the Twilio console.",
    inputSchema: schema({ phone_number: "string", label: "string?" }),
    handler: (args, context) => {
      const parsed = z.object({ phone_number: zString, label: z.string().optional() }).parse(args);
      const row = requireTwilioService(context).allowlistAdd(parsed.phone_number, parsed.label, "mcp");
      return { ok: true, allowlisted: row };
    }
  },
  {
    name: "twilio_allowlist_remove",
    description: "Remove a phone number from the real-call/SMS allowlist.",
    inputSchema: schema({ phone_number: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ phone_number: zString }).parse(args);
      const removed = requireTwilioService(context).allowlistRemove(parsed.phone_number);
      return { ok: true, removed };
    }
  },
  {
    name: "twilio_allowlist_list",
    description: "List phone numbers allowed for real Twilio calls/SMS, plus the default user number and inbound agent.",
    inputSchema: schema({}),
    handler: (_args, context) => {
      const twilio = requireTwilioService(context);
      return {
        numbers: twilio.allowlistList(),
        default_user_number: twilio.getDefaultUserNumber() ?? null,
        inbound_extension: twilio.getInboundExtension()
      };
    }
  },
  {
    name: "twilio_register_inbound_agent",
    description: "Register which agent extension answers when the user dials the Twilio number from their real phone.",
    inputSchema: schema({ extension: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ extension: zString }).parse(args);
      const ext = context.extensions.get(parsed.extension);
      if (!ext || ext.owner_type !== "agent") throw new Error(`${parsed.extension} is not a registered agent extension`);
      requireTwilioService(context).setInboundExtension(parsed.extension);
      return { ok: true, inbound_extension: parsed.extension, agent: ext.name };
    }
  },
  {
    name: "twilio_set_user_number",
    description:
      "Set (and auto-allowlist) the user's real phone number — the default destination for twilio_call_and_wait, twilio_sms, and call escalation.",
    inputSchema: schema({ phone_number: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ phone_number: zString }).parse(args);
      const number = requireTwilioService(context).setDefaultUserNumber(parsed.phone_number);
      return { ok: true, default_user_number: number };
    }
  },
  {
    name: "twilio_status",
    description: "Twilio integration status: configured, from-number, inbound agent, allowlist size, screening state, active PSTN bridge sessions.",
    inputSchema: schema({}),
    handler: (_args, context) => {
      if (!context.twilio) return { configured: false, reason: "twilio_unavailable" };
      return {
        ...context.twilio.summary(),
        bridge: context.twilioBridge?.status() ?? null,
        screening: context.screening?.status() ?? null
      };
    }
  },
  {
    name: "twilio_screening_enable",
    description:
      "Turn ON call screening: unknown (non-allowlisted) callers to the Twilio number are answered by the agent on the user's behalf while the app shows a live transcript with take-over/end buttons.",
    inputSchema: schema({}),
    handler: (_args, context) => {
      requireTwilioService(context).setScreeningEnabled(true);
      return { ok: true, screening_enabled: true };
    }
  },
  {
    name: "twilio_screening_disable",
    description: "Turn OFF call screening: unknown callers to the Twilio number are rejected again.",
    inputSchema: schema({}),
    handler: (_args, context) => {
      requireTwilioService(context).setScreeningEnabled(false);
      return { ok: true, screening_enabled: false };
    }
  },
  {
    name: "twilio_screening_take_over",
    description: "Bridge a screened caller to the user's real phone (rings it) — same as the app's Take over button.",
    inputSchema: schema({ call_id: "string" }),
    handler: async (args, context) => {
      const parsed = z.object({ call_id: zString }).parse(args);
      if (!context.screening) throw new Error("screening_unavailable");
      return context.screening.takeOver(parsed.call_id);
    }
  },
  {
    name: "twilio_screening_end",
    description: "Hang up on a screened caller — same as the app's End button.",
    inputSchema: schema({ call_id: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ call_id: zString }).parse(args);
      if (!context.screening) throw new Error("screening_unavailable");
      return context.screening.end(parsed.call_id);
    }
  },
  {
    name: "list_agents",
    description: "List registered agents.",
    inputSchema: schema({}),
    handler: (_args, { agents }) => agents.list()
  },
  {
    name: "get_agent_status",
    description: "Get one agent status by id.",
    inputSchema: schema({ agent_id: "string" }),
    handler: (args, { agents }) => {
      const parsed = z.object({ agent_id: zString }).parse(args);
      return agents.get(parsed.agent_id);
    }
  },
  {
    name: "update_agent_status",
    description: "Update an agent status, current task, and session id.",
    inputSchema: schema({ agent_id: "string", status: "string", current_task: "string?", session_id: "string?" }),
    handler: (args, { agents, wsHub }) => {
      const parsed = z.object({ agent_id: zString, status: zString, current_task: z.string().optional(), session_id: z.string().optional() }).parse(args);
      const agent = agents.updateStatus(parsed.agent_id, parsed.status, parsed.current_task, parsed.session_id);
      wsHub.sendToExtension("100", { type: "agent_status", agent });
      return agent;
    }
  },
  {
    name: "create_session",
    description: "Create an agent work session.",
    inputSchema: schema({ agent_id: "string?", repo_path: "string?", task: "string?" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ agent_id: z.string().optional(), repo_path: z.string().optional(), task: z.string().optional() }).parse(args);
      return memory.createSession(parsed.agent_id, parsed.repo_path, parsed.task);
    }
  },
  {
    name: "get_session_context",
    description: "Read recent session context events.",
    inputSchema: schema({ session_id: "string", limit: "number?" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ session_id: zString, limit: z.number().default(50) }).parse(args);
      return memory.getSessionContext(parsed.session_id, parsed.limit);
    }
  },
  {
    name: "append_session_event",
    description: "Append an event to session context.",
    inputSchema: schema({ session_id: "string", event_type: "string", content: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ session_id: zString, event_type: zString, content: zString }).parse(args);
      return memory.appendSessionEvent(parsed.session_id, parsed.event_type, parsed.content);
    }
  },
  {
    name: "search_memory",
    description: "Keyword-search memory with vector-ready storage abstraction.",
    inputSchema: schema({ query: "string", limit: "number?" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ query: zString, limit: z.number().default(10) }).parse(args);
      return memory.searchMemory(parsed.query, parsed.limit);
    }
  },
  {
    name: "store_memory",
    description: "Store memory scoped to an agent, repo, task, user, or global key.",
    inputSchema: schema({ scope: "string", key: "string", content: "string", tags: "string[]?" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ scope: zString, key: zString, content: zString, tags: z.array(z.string()).default([]) }).parse(args);
      return memory.storeMemory(parsed);
    }
  },
  {
    name: "request_approval",
    description: "Create an approval request and notify the user.",
    inputSchema: schema({ session_id: "string?", action: "string", risk: "string", command: "string?" }),
    handler: (args, { approvals, wsHub }) => {
      const parsed = z.object({ session_id: z.string().optional(), action: zString, risk: zString, command: z.string().optional() }).parse(args);
      const approval = approvals.request(parsed.session_id, parsed.action, parsed.risk, parsed.command);
      wsHub.sendToExtension("100", { type: "approval_request", approval });
      return approval;
    }
  },
  {
    name: "request_approval_by_phone",
    description: "Call the user by phone, ask for spoken approval, transcribe the response, and resolve the approval when clear.",
    inputSchema: schema({
      from_extension: "string?",
      session_id: "string?",
      action: "string",
      command: "string?",
      risk: "string",
      reason: "string",
      timeout_seconds: "number?"
    }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          from_extension: z.string().default("101"),
          session_id: z.string().optional(),
          action: zString,
          command: z.string().optional(),
          risk: zString,
          reason: zString,
          timeout_seconds: z.number().int().positive().default(300)
        })
        .parse(args);
      const approval = context.approvals.request(parsed.session_id, parsed.action, parsed.risk, parsed.command, parsed.from_extension);
      if (!approval || typeof (approval as { id?: unknown }).id !== "string") {
        throw Object.assign(new Error("approval was not created"), { code: "approval_not_created" });
      }
      const approvalId = (approval as { id: string }).id;
      const say = [
        `Approval requested for ${parsed.action}.`,
        parsed.command ? `Command: ${parsed.command}.` : "",
        `Risk: ${parsed.risk}.`,
        parsed.reason,
        "Please answer yes or no."
      ]
        .filter(Boolean)
        .join(" ");
      const result = await callAndWaitForUser(
        {
          from_extension: parsed.from_extension,
          to_extension: "100",
          reason: parsed.reason,
          say,
          urgency: parsed.risk === "high" ? "high" : "normal",
          session_id: parsed.session_id,
          timeout_seconds: parsed.timeout_seconds,
          expected_response_type: "approval"
        },
        context
      );
      // Honor the missed-call TEXT fallback too: when the call was missed /
      // rejected / timed out, withFallback already sent the urgent text and
      // captured the user's reply — without this, tapping "approve" on the
      // fallback left the approval pending forever while we reported timeout.
      let fallbackDecision: "approved" | "denied" | undefined;
      if (!result.ok) {
        const opt = (result.fallback_selected_option ?? "").toLowerCase();
        if (opt === "approve" || opt === "approved" || opt === "yes") fallbackDecision = "approved";
        else if (opt === "deny" || opt === "denied" || opt === "no") fallbackDecision = "denied";
        else if (result.fallback_reply) {
          const classified = classifyResponse(result.fallback_reply, "approval");
          if (classified === "approved" || classified === "denied") fallbackDecision = classified;
        }
      }
      const approvedViaCall = result.ok && result.decision === "approved";
      const deniedViaCall = result.ok && result.decision === "denied";
      const approved = approvedViaCall || fallbackDecision === "approved";
      const denied = deniedViaCall || fallbackDecision === "denied";
      if (approved) context.approvals.approve(approvalId, result.user_transcript ?? result.fallback_reply ?? "approved");
      else if (denied) context.approvals.deny(approvalId, result.user_transcript ?? result.fallback_reply ?? "denied");
      return {
        ok: result.ok || fallbackDecision != null,
        approved,
        decision: approved ? "approved" : denied ? "denied" : result.decision,
        user_transcript: result.user_transcript ?? result.fallback_reply,
        approval_id: approvalId,
        call_id: result.call_id,
        reason: result.reason,
        via_fallback: !result.ok && fallbackDecision != null
      };
    }
  },
  {
    name: "record_tool_call",
    description: "Record an external agent tool call in the session audit trail.",
    inputSchema: schema({ session_id: "string?", tool_name: "string", args: "object?", result: "object?", success: "boolean" }),
    handler: (args, { db }) => {
      const parsed = z.object({ session_id: z.string().optional(), tool_name: zString, args: z.unknown().default({}), result: z.unknown().optional(), success: z.boolean().default(true) }).parse(args);
      const id = db.id("mcp");
      db.sqlite
        .prepare(
          `INSERT INTO mcp_tool_calls (id, session_id, tool_name, args, result, success, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, parsed.session_id ?? null, parsed.tool_name, db.json(parsed.args), db.json(parsed.result ?? {}), parsed.success ? 1 : 0, db.now());
      db.event("action_executed", { toolCallId: id, toolName: parsed.tool_name, success: parsed.success }, undefined, undefined, parsed.session_id);
      return { id };
    }
  },
  {
    name: "read_recent_terminal",
    description: "Read recent terminal output snapshots for a session.",
    inputSchema: schema({ session_id: "string", lines: "number?" }),
    handler: (args, { db }) => {
      const parsed = z.object({ session_id: zString, lines: z.number().default(100) }).parse(args);
      return db.sqlite.prepare("SELECT * FROM terminal_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(parsed.session_id, parsed.lines);
    }
  },
  {
    name: "send_terminal_input",
    description: "Send terminal input to an adapter. Dangerous commands create approval requests and are not sent.",
    inputSchema: schema({ session_id: "string?", input: "string", adapter_type: "string?" }),
    handler: (args, { db, approvals, wsHub }) => {
      const parsed = z.object({ session_id: z.string().optional(), input: zString, adapter_type: z.string().default("tmux") }).parse(args);
      const dangerous = inspectDangerousCommand(parsed.input);
      if (dangerous.dangerous) {
        const approval = approvals.request(parsed.session_id, "terminal_input", dangerous.reasons.join("; "), parsed.input);
        wsHub.sendToExtension("100", { type: "approval_request", approval });
        return { sent: false, requiresApproval: true, approval, reasons: dangerous.reasons };
      }
      db.sqlite
        .prepare("INSERT INTO terminal_logs (id, session_id, adapter_type, command, output, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(db.id("term"), parsed.session_id ?? null, parsed.adapter_type, parsed.input, "[queued for adapter]", db.now());
      wsHub.sendToExtension("102", { type: "terminal_input", sessionId: parsed.session_id, input: parsed.input });
      db.event("action_executed", { action: "terminal_input", adapterType: parsed.adapter_type }, undefined, undefined, parsed.session_id);
      return { sent: true };
    }
  },
  {
    name: "notify_user",
    description: "Send an in-app text message to the Android/user extension. Creates a thread, persists to agent_messages, pushes message_new if online, queues otherwise. Use for low/normal/urgent updates, status, or task results that do not need a phone call.",
    inputSchema: schema({
      to_extension: "string?",
      title: "string",
      message: "string",
      priority: "string?",
      session_id: "string?",
      call_id: "string?",
      thread_id: "string?",
      from_extension: "string?",
      subject: "string?",
      metadata: "object?"
    }),
    handler: (args, context) => {
      const parsed = z
        .object({
          to_extension: z.string().default("100"),
          title: zString,
          message: zString,
          priority: z.enum(["low", "normal", "urgent", "critical"]).default("normal"),
          session_id: z.string().optional(),
          call_id: z.string().optional(),
          thread_id: z.string().optional(),
          from_extension: z.string().default("101"),
          subject: z.string().optional(),
          metadata: z.record(z.unknown()).optional()
        })
        .parse(args);
      const message = context.messages.createMessage({
        from_extension: parsed.from_extension,
        to_extension: parsed.to_extension,
        from_type: "agent",
        to_type: "device",
        title: parsed.title,
        body: parsed.message,
        priority: parsed.priority,
        requires_response: false,
        response_options: [],
        session_id: parsed.session_id,
        call_id: parsed.call_id,
        // Reply into the same chat thread so a text conversation stays coherent.
        thread_id: parsed.thread_id,
        subject: parsed.subject,
        metadata: { kind: "notify", ...(parsed.metadata ?? {}) }
      });
      const delivered = context.wsHub.notifyNewMessage(message);
      maybeStoreMessageMemory(context, message, ["agent-phone", "text"]);
      return {
        ok: true,
        message_id: message.id,
        thread_id: message.thread_id,
        delivered,
        queued: !delivered,
        status: delivered ? "delivered" : "queued"
      };
    }
  },
  {
    name: "notify_user_and_wait",
    description: "Send an in-app text message that requires a reply and wait for the user to reply in the app (or for the timeout). Use when you need a decision but the situation does not warrant a phone call.",
    inputSchema: schema({
      to_extension: "string?",
      title: "string",
      message: "string",
      priority: "string?",
      options: "string[]?",
      timeout_seconds: "number?",
      session_id: "string?",
      call_id: "string?",
      from_extension: "string?",
      subject: "string?",
      metadata: "object?"
    }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          to_extension: z.string().default("100"),
          title: zString,
          message: zString,
          priority: z.enum(["low", "normal", "urgent", "critical"]).default("normal"),
          options: z.array(z.string()).default([]),
          timeout_seconds: z.number().int().positive().default(300),
          session_id: z.string().optional(),
          call_id: z.string().optional(),
          from_extension: z.string().default("101"),
          subject: z.string().optional(),
          metadata: z.record(z.unknown()).optional()
        })
        .parse(args);
      const message = context.messages.createMessage({
        from_extension: parsed.from_extension,
        to_extension: parsed.to_extension,
        from_type: "agent",
        to_type: "device",
        title: parsed.title,
        body: parsed.message,
        priority: parsed.priority,
        requires_response: true,
        response_options: parsed.options,
        session_id: parsed.session_id,
        call_id: parsed.call_id,
        subject: parsed.subject,
        metadata: { kind: "notify_and_wait", ...(parsed.metadata ?? {}) }
      });
      const delivered = context.wsHub.notifyNewMessage(message);
      const result = await context.wsHub.waitForMessageReply(message.id, parsed.timeout_seconds * 1000);
      maybeStoreMessageMemory(context, result.message ?? message, ["agent-phone", "text", "awaited"]);
      return {
        ok: true,
        message_id: message.id,
        thread_id: message.thread_id,
        delivered,
        queued: !delivered,
        replied: result.replied,
        timeout: result.timeout === true,
        reply_text: result.reply?.body ?? null,
        selected_option: result.message?.selected_option ?? null,
        reply_message_id: result.reply?.id ?? null
      };
    }
  },
  {
    name: "send_missed_call_fallback",
    description: "Send an urgent in-app fallback message after a call is missed/rejected/timed-out so the user can respond in the app instead. Optionally wait for the reply.",
    inputSchema: schema({
      call_id: "string",
      to_extension: "string?",
      reason: "string",
      original_message: "string",
      options: "string[]?",
      wait: "boolean?",
      timeout_seconds: "number?",
      from_extension: "string?",
      session_id: "string?"
    }),
    handler: async (args, context) => {
      const parsed = z
        .object({
          call_id: zString,
          to_extension: z.string().default("100"),
          reason: zString,
          original_message: zString,
          options: z.array(z.string()).default(["call_again", "approve", "deny", "mute_30_min"]),
          wait: z.boolean().default(false),
          timeout_seconds: z.number().int().positive().default(300),
          from_extension: z.string().default("101"),
          session_id: z.string().optional()
        })
        .parse(args);
      const call = context.calls.get(parsed.call_id);
      const sessionId = parsed.session_id ?? call?.session_id ?? undefined;
      const message = context.messages.createMessage({
        from_extension: parsed.from_extension,
        to_extension: parsed.to_extension,
        from_type: "agent",
        to_type: "device",
        title: `Missed call: ${parsed.reason}`,
        body: parsed.original_message,
        priority: "urgent",
        requires_response: true,
        response_options: parsed.options,
        session_id: sessionId,
        call_id: parsed.call_id,
        subject: `call:${parsed.call_id}`,
        metadata: { kind: "missed_call_fallback", reason: parsed.reason, original_message: parsed.original_message }
      });
      const delivered = context.wsHub.notifyMissedCallFallback(message);
      context.db.event("fallback_sent", { messageId: message.id, callId: parsed.call_id, reason: parsed.reason }, parsed.from_extension, parsed.call_id, sessionId ?? undefined);
      maybeStoreMessageMemory(context, message, ["agent-phone", "fallback", "call"]);
      let replyOutcome: { replied: boolean; timeout?: boolean; reply?: MessageRow; message?: MessageRow } | undefined;
      if (parsed.wait) {
        replyOutcome = await context.wsHub.waitForMessageReply(message.id, parsed.timeout_seconds * 1000);
        if (replyOutcome.replied) {
          context.db.event("fallback_replied", { messageId: message.id, callId: parsed.call_id, selectedOption: replyOutcome.message?.selected_option ?? null }, parsed.to_extension, parsed.call_id, sessionId ?? undefined);
        }
      }
      return {
        ok: true,
        message_id: message.id,
        thread_id: message.thread_id,
        delivered,
        queued: !delivered,
        waited: parsed.wait,
        replied: replyOutcome?.replied ?? false,
        timeout: replyOutcome?.timeout === true,
        reply_text: replyOutcome?.reply?.body ?? null,
        selected_option: replyOutcome?.message?.selected_option ?? null,
        reply_message_id: replyOutcome?.reply?.id ?? null
      };
    }
  },
  {
    name: "send_call_receipt",
    description: "After a call, send the user a structured receipt summarizing transcript, decision, tool calls, errors, actions, and next steps. Also stores it as a memory entry tagged 'receipt'.",
    inputSchema: schema({ call_id: "string", to_extension: "string?", from_extension: "string?", next_steps: "string?", priority: "string?" }),
    handler: (args, context) => {
      const parsed = z
        .object({
          call_id: zString,
          to_extension: z.string().default("100"),
          from_extension: z.string().default("101"),
          next_steps: z.string().optional(),
          priority: z.enum(["low", "normal", "urgent", "critical"]).default("normal")
        })
        .parse(args);
      const call = context.calls.get(parsed.call_id);
      if (!call) throw new Error("call not found");
      const summary = context.memory.getCallSummary(parsed.call_id) as { content?: string };
      const toolCalls = call.session_id
        ? (context.db.sqlite
            .prepare(
              `SELECT tool_name, success, error, created_at FROM mcp_tool_calls
               WHERE session_id = ?
               ORDER BY created_at DESC LIMIT 20`
            )
            .all(call.session_id) as Array<{ tool_name: string; success: number; error: string | null; created_at: string }>)
        : [];
      const errors = toolCalls.filter((row) => row.success !== 1);
      const lines: string[] = [];
      lines.push(`Call ${call.id} (${call.from_extension} → ${call.to_extension}) state=${call.state}`);
      if (call.reason) lines.push(`Reason: ${call.reason}`);
      if (summary?.content) lines.push("Summary:", summary.content);
      if (toolCalls.length > 0) {
        lines.push(`Tool calls (${toolCalls.length}): ${toolCalls.map((row) => row.tool_name).slice(0, 10).join(", ")}`);
      }
      if (errors.length > 0) {
        lines.push(`Errors (${errors.length}): ${errors.map((row) => `${row.tool_name}:${row.error ?? "failed"}`).slice(0, 5).join("; ")}`);
      }
      if (parsed.next_steps) lines.push(`Next steps: ${parsed.next_steps}`);
      const body = lines.join("\n").slice(0, 4000);
      const message = context.messages.createMessage({
        from_extension: parsed.from_extension,
        to_extension: parsed.to_extension,
        from_type: "agent",
        to_type: "device",
        title: `Call receipt: ${call.reason ?? call.id}`,
        body,
        priority: parsed.priority,
        requires_response: false,
        response_options: [],
        session_id: call.session_id ?? undefined,
        call_id: call.id,
        subject: `call:${call.id}`,
        metadata: { kind: "receipt", tool_call_count: toolCalls.length, error_count: errors.length }
      });
      const delivered = context.wsHub.notifyNewMessage(message);
      context.memory.storeMemory({
        scope: "call",
        key: `${call.id}:receipt`,
        content: body,
        tags: ["agent-phone", "call", "receipt"]
      });
      context.db.event("receipt_sent", { messageId: message.id, callId: call.id }, parsed.from_extension, call.id, call.session_id ?? undefined);
      return {
        ok: true,
        message_id: message.id,
        thread_id: message.thread_id,
        delivered,
        summary: body,
        tool_call_count: toolCalls.length,
        error_count: errors.length
      };
    }
  },
  {
    name: "get_message",
    description: "Fetch one in-app message by id (includes status, response_text, selected_option, replied_at). Use after notify_user_and_wait times out to check whether Kizek replied late.",
    inputSchema: schema({ message_id: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ message_id: zString }).parse(args);
      const message = context.messages.getMessage(parsed.message_id);
      if (!message) return { ok: false, error: "message_not_found" };
      return { ok: true, message };
    }
  },
  {
    name: "get_thread_messages",
    description: "Read every message in a thread in chronological order. Use to see the full back-and-forth with Kizek for a given thread_id.",
    inputSchema: schema({ thread_id: "string", limit: "number?" }),
    handler: (args, context) => {
      const parsed = z.object({ thread_id: zString, limit: z.number().int().positive().max(500).default(200) }).parse(args);
      const thread = context.messages.getThread(parsed.thread_id);
      if (!thread) return { ok: false, error: "thread_not_found" };
      const messages = context.messages.listMessages({ thread_id: parsed.thread_id, limit: parsed.limit })
        .slice()
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { ok: true, thread, messages };
    }
  },
  {
    name: "list_inbox",
    description: "List recent in-app messages for an extension (defaults to caller's agent extension). Filter by status (queued|delivered|read|replied|expired). Use this when a notify_user_and_wait timed out and you want to check whether the user replied later.",
    inputSchema: schema({ extension: "string?", status: "string?", limit: "number?", since: "string?" }),
    handler: (args, context) => {
      const parsed = z
        .object({
          extension: z.string().default("101"),
          status: z.enum(["queued", "delivered", "read", "replied", "expired"]).optional(),
          limit: z.number().int().positive().max(500).default(50),
          since: z.string().optional()
        })
        .parse(args);
      const messages = context.messages.listMessages({ extension: parsed.extension, status: parsed.status, limit: parsed.limit });
      const filtered = parsed.since ? messages.filter((row) => row.created_at >= parsed.since!) : messages;
      return { ok: true, extension: parsed.extension, count: filtered.length, messages: filtered };
    }
  },
  {
    name: "wait_for_message_reply",
    description: "Block until Kizek replies to a specific message id, or the timeout elapses. Returns the reply text/option and replied flag. Cheaper than re-sending notify_user_and_wait if the original wait already returned.",
    inputSchema: schema({ message_id: "string", timeout_seconds: "number?" }),
    handler: async (args, context) => {
      const parsed = z
        .object({ message_id: zString, timeout_seconds: z.number().int().positive().default(300) })
        .parse(args);
      const existing = context.messages.getMessage(parsed.message_id);
      if (!existing) return { ok: false, error: "message_not_found" };
      if (existing.status === "replied") {
        return { ok: true, replied: true, timeout: false, message_id: existing.id, reply_text: existing.response_text, selected_option: existing.selected_option };
      }
      const result = await context.wsHub.waitForMessageReply(parsed.message_id, parsed.timeout_seconds * 1000);
      const latest = context.messages.getMessage(parsed.message_id);
      return {
        ok: true,
        replied: result.replied,
        timeout: result.timeout === true,
        message_id: parsed.message_id,
        reply_text: result.reply?.body ?? latest?.response_text ?? null,
        selected_option: latest?.selected_option ?? null,
        reply_message_id: result.reply?.id ?? null
      };
    }
  },
  {
    name: "send_live_log_drop",
    description: "Push a live log/output snippet into the in-app inbox (and into the active call surface if the call is still running). Useful for streaming progress during a call without speaking it.",
    inputSchema: schema({
      to_extension: "string?",
      from_extension: "string?",
      call_id: "string?",
      session_id: "string?",
      title: "string",
      log_text: "string",
      source: "string?",
      priority: "string?",
      metadata: "object?"
    }),
    handler: (args, context) => {
      const parsed = z
        .object({
          to_extension: z.string().default("100"),
          from_extension: z.string().default("101"),
          call_id: z.string().optional(),
          session_id: z.string().optional(),
          title: zString,
          log_text: zString,
          source: z.string().optional(),
          priority: z.enum(["low", "normal", "urgent", "critical"]).default("normal"),
          metadata: z.record(z.unknown()).optional()
        })
        .parse(args);
      const message = context.messages.createMessage({
        from_extension: parsed.from_extension,
        to_extension: parsed.to_extension,
        from_type: "agent",
        to_type: "device",
        title: parsed.title,
        body: parsed.log_text.slice(0, 8000),
        priority: parsed.priority,
        requires_response: false,
        response_options: [],
        session_id: parsed.session_id,
        call_id: parsed.call_id,
        subject: parsed.call_id ? `call:${parsed.call_id}` : `log:${parsed.source ?? parsed.title}`,
        metadata: { kind: "log_drop", source: parsed.source ?? null, ...(parsed.metadata ?? {}) }
      });
      const delivered = context.wsHub.notifyNewMessage(message);
      let pushedInCall = false;
      if (parsed.call_id) pushedInCall = context.wsHub.notifyCallLiveLog(parsed.call_id, message);
      context.db.event("live_log_drop_sent", { messageId: message.id, callId: parsed.call_id ?? null, source: parsed.source ?? null }, parsed.from_extension, parsed.call_id ?? undefined, parsed.session_id ?? undefined);
      maybeStoreMessageMemory(context, message, ["agent-phone", "log-drop"]);
      return {
        ok: true,
        message_id: message.id,
        thread_id: message.thread_id,
        delivered,
        pushed_in_call: pushedInCall
      };
    }
  },
  {
    name: "summarize_session",
    description: "Create a deterministic session summary.",
    inputSchema: schema({ session_id: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ session_id: zString }).parse(args);
      return memory.summarizeSession(parsed.session_id);
    }
  },
  {
    name: "summarize_call",
    description: "Create a deterministic call summary.",
    inputSchema: schema({ call_id: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ call_id: zString }).parse(args);
      return memory.summarizeCall(parsed.call_id);
    }
  },
  {
    name: "get_call_summary",
    description: "Read the latest stored call summary, creating one from messages and transcripts if needed.",
    inputSchema: schema({ call_id: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ call_id: zString }).parse(args);
      return memory.getCallSummary(parsed.call_id);
    }
  },
  {
    name: "get_session_calls",
    description: "List calls linked to a session.",
    inputSchema: schema({ session_id: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ session_id: zString }).parse(args);
      return memory.getSessionCalls(parsed.session_id);
    }
  },
  {
    name: "get_latest_agent_context",
    description: "Read the latest session context and calls for an agent.",
    inputSchema: schema({ agent_id: "string" }),
    handler: (args, { memory }) => {
      const parsed = z.object({ agent_id: zString }).parse(args);
      return memory.getLatestAgentContext(parsed.agent_id);
    }
  },
  {
    name: "list_active_calls",
    description: "List ringing and active calls.",
    inputSchema: schema({}),
    handler: (_args, { db }) => db.sqlite.prepare("SELECT * FROM calls WHERE state IN ('ringing', 'accepted', 'active', 'created') ORDER BY created_at DESC").all()
  },
  {
    name: "get_call_transcript",
    description: "Read call transcripts and text messages.",
    inputSchema: schema({ call_id: "string" }),
    handler: (args, { calls, memory }) => {
      const parsed = z.object({ call_id: zString }).parse(args);
      return { transcripts: calls.getTranscripts(parsed.call_id), messages: calls.getMessages(parsed.call_id), summary: memory.summarizeCall(parsed.call_id) };
    }
  },
  {
    name: "set_voice_profile",
    description: "Set an extension's call voice and speaking rate so each agent/person sounds distinct. voice_id is a Mistral voice UUID; speed is 0.5–2.0 (1 = normal). Pass null to clear a field.",
    inputSchema: schema({ extension: "string", voice_id: "string?", speed: "number?", name: "string?" }),
    handler: (args, context) => {
      const parsed = z
        .object({
          extension: zString,
          voice_id: z.string().nullable().optional(),
          speed: z.number().nullable().optional(),
          name: z.string().nullable().optional()
        })
        .parse(args);
      const service = new VoiceProfileService(context.db);
      const profile = service.set(parsed.extension, {
        voiceId: parsed.voice_id,
        speed: parsed.speed == null ? parsed.speed : clampSpeed(parsed.speed),
        name: parsed.name
      });
      if (!profile) throw new Error(`extension ${parsed.extension} is not registered`);
      return { extension: parsed.extension, voice: profile };
    }
  },
  {
    name: "get_voice_profile",
    description: "Read an extension's call voice profile (voice id, speaking rate, label).",
    inputSchema: schema({ extension: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ extension: zString }).parse(args);
      return { extension: parsed.extension, voice: new VoiceProfileService(context.db).get(parsed.extension) };
    }
  },
  {
    name: "red_alert",
    description: "WAR ZONE. Broadcast a red alert to every agent: pulls each one online and drops a critical war-room message so all agents join and help. Use for incidents that need all hands. Returns the roster and a group_id.",
    inputSchema: schema({ message: "string", from_extension: "string?" }),
    handler: (args, context) => {
      const parsed = z.object({ message: zString, from_extension: z.string().default("100") }).parse(args);
      const warRoom = new WarRoomService(context.db, context.messages, context.wsHub);
      return warRoom.triggerRedAlert({ fromExtension: parsed.from_extension, message: parsed.message });
    }
  },
  {
    name: "start_group_chat",
    description: "Start a group chat between the user and several agents. members is a list of extensions. Returns a group_id to post to with post_group_message.",
    inputSchema: schema({ members: "string[]", message: "string?", subject: "string?", from_extension: "string?" }),
    handler: (args, context) => {
      const parsed = z
        .object({ members: z.array(z.string()).min(1), message: z.string().optional(), subject: z.string().optional(), from_extension: z.string().default("100") })
        .parse(args);
      const warRoom = new WarRoomService(context.db, context.messages, context.wsHub);
      return warRoom.createGroupChat({ fromExtension: parsed.from_extension, members: parsed.members, subject: parsed.subject, message: parsed.message });
    }
  },
  {
    name: "post_group_message",
    description: "Post a message into an existing group chat (the shared thread). Provide the group_id (the thread id returned by start_group_chat) and the body; it reaches every member.",
    inputSchema: schema({ group_id: "string", body: "string", from_extension: "string?" }),
    handler: (args, context) => {
      const parsed = z
        .object({ group_id: zString, body: zString, from_extension: z.string().default("100") })
        .parse(args);
      const warRoom = new WarRoomService(context.db, context.messages, context.wsHub);
      return warRoom.postToGroup({ threadId: parsed.group_id, fromExtension: parsed.from_extension, body: parsed.body });
    }
  },
  {
    name: "get_group_chat",
    description: "Read all messages in a group chat / war room by group_id.",
    inputSchema: schema({ group_id: "string" }),
    handler: (args, context) => {
      const parsed = z.object({ group_id: zString }).parse(args);
      const warRoom = new WarRoomService(context.db, context.messages, context.wsHub);
      return { group_id: parsed.group_id, messages: warRoom.groupMessages(parsed.group_id) };
    }
  }
];

type CallAndWaitInput = {
  from_extension: string;
  to_extension: string;
  reason: string;
  say: string;
  urgency: string;
  session_id?: string;
  timeout_seconds: number;
  expected_response_type: "approval" | "instruction" | "freeform";
  fallback_to_text?: boolean;
  fallback_timeout_seconds?: number;
  fallback_options?: string[];
  escalate_to_twilio?: boolean;
  escalate_phone_number?: string;
};

type PhoneWaitResult = {
  ok: boolean;
  answered?: boolean;
  call_answered?: boolean;
  reason?: string;
  decision?: string;
  call_id?: string;
  user_transcript?: string;
  duration_seconds?: number;
  session_id?: string | null;
  memory_id?: string;
  transcript_id?: string;
  fallback_sent?: boolean;
  fallback_message_id?: string;
  fallback_thread_id?: string;
  fallback_reply?: string | null;
  fallback_selected_option?: string | null;
  fallback_timeout?: boolean;
  // Issue #19: distinguishes an infrastructure failure (e.g. TTS synthesis down)
  // from an innocent user non-response. When set, the user likely never heard the
  // call at all, so the agent should escalate the *infra* path, not re-call the user.
  failure_reason?: string;
  error_detail?: string;
  // Twilio/PSTN additions (all additive — older agents can ignore them):
  twilio_call_sid?: string;
  phone_number?: string;
  sms_fallback_sent?: boolean;
  sms_sid?: string;
  escalated?: boolean;
  escalation_of_call_id?: string;
  escalation_call_id?: string;
  escalation_decision?: string;
};

async function callAndWaitForUser(input: CallAndWaitInput, context: ToolContext): Promise<PhoneWaitResult> {
  const started = Date.now();
  const caller = context.extensions.get(input.from_extension);
  if (!caller || caller.owner_type !== "agent") throw new Error(`from_extension ${input.from_extension} is not a registered agent extension`);
  const target = context.extensions.get(input.to_extension);
  if (!target) throw new Error(`to_extension ${input.to_extension} is not registered`);
  if (!context.wsHub.isExtensionOnline(input.to_extension)) {
    return withFallback(context, input, undefined, { ok: false, answered: false, call_answered: false, reason: "user_offline", decision: "user_offline" }, "user_offline");
  }

  const call = context.calls.dial({
    fromExtension: input.from_extension,
    toExtension: input.to_extension,
    reason: input.reason,
    urgency: input.urgency,
    sessionId: input.session_id
  });
  context.wsHub.notifyIncomingCall(call);
  if (call.state === "missed") return withFallback(context, input, call.id, { ok: false, answered: false, call_answered: false, reason: "user_offline", decision: "user_offline", call_id: call.id }, "missed");

  const timeoutMs = input.timeout_seconds * 1000;
  const answer = await context.wsHub.waitForCallState(call.id, ["active", "rejected", "ended", "failed", "timeout"], timeoutMs);
  if (answer.state === "timeout") {
    context.wsHub.timeoutCall(call.id, "answer_timeout");
    return withFallback(context, input, call.id, { ok: false, answered: false, call_answered: false, reason: "timeout", decision: "timeout", call_id: call.id }, "timeout");
  }
  if (answer.state === "rejected") return withFallback(context, input, call.id, { ok: false, answered: false, call_answered: false, decision: "rejected", call_id: call.id }, "rejected");
  if (answer.state !== "active") return withFallback(context, input, call.id, { ok: false, answered: false, call_answered: false, reason: answer.state, decision: answer.state, call_id: call.id }, answer.state);

  try {
    context.wsHub.setCallState(call.id, "speaking", input.from_extension);
    await context.wsHub.synthesizeForCall(call.id, input.from_extension, input.to_extension, input.say);
    context.wsHub.setCallState(call.id, "waiting_for_user", input.from_extension);
  } catch (error) {
    // Issue #19: TTS synthesis failed — the user never heard the call. failCall()
    // clears busy. Rather than throwing an opaque error (which the agent can't tell
    // apart from a user non-response), return a structured result tagged
    // `tts_synthesis_failed` AND drop a text fallback so the agent can escalate the
    // infra path instead of pointlessly re-dialing the user.
    const detail = error instanceof Error ? error.message : "tts_failed";
    context.wsHub.failCall(call.id, detail);
    return withFallback(
      context,
      input,
      call.id,
      { ok: false, answered: false, call_answered: true, reason: "tts_synthesis_failed", decision: "failed", call_id: call.id, failure_reason: "tts_synthesis_failed", error_detail: detail },
      "tts_synthesis_failed"
    );
  }

  // Issue #12: belt-and-suspenders — if anything after the call goes active throws
  // unexpectedly, fail the call so both extensions' busy flags are always cleared.
  // Without this an error here would leave the call stuck `active` and both
  // extensions undiallable until a disconnect or server restart.
  try {
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - started));
    const transcriptOutcome = await waitForTranscriptOrFailure(context, call.id, input.to_extension, remainingMs);
    if (transcriptOutcome.kind === "timeout") {
      context.wsHub.timeoutCall(call.id, "user_response_timeout");
      return withFallback(context, input, call.id, { ok: false, answered: true, call_answered: true, reason: "timeout", decision: "timeout", call_id: call.id }, "user_response_timeout");
    }
    if (transcriptOutcome.kind === "failed") {
      return withFallback(
        context,
        input,
        call.id,
        { ok: false, answered: true, call_answered: true, reason: transcriptOutcome.reason, decision: "failed", call_id: call.id },
        `failed:${transcriptOutcome.reason}`
      );
    }
    const transcript = transcriptOutcome.transcript;

    context.wsHub.setCallState(call.id, "active", input.to_extension);
    const loadedCall = context.calls.get(call.id) ?? call;
    const decision = classifyResponse(transcript.text, input.expected_response_type);
    const memory = storeCallResponse(context, loadedCall, transcript.text, decision, transcript.transcriptId, input.expected_response_type);
    return {
      ok: true,
      answered: true,
      call_id: call.id,
      user_transcript: transcript.text,
      decision,
      duration_seconds: elapsedSeconds(started),
      session_id: loadedCall.session_id,
      memory_id: (memory as { id?: string }).id,
      transcript_id: transcript.transcriptId
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "call_processing_error";
    const current = context.calls.get(call.id);
    if (current && !["ended", "failed", "timeout", "rejected", "missed"].includes(current.state)) {
      context.wsHub.failCall(call.id, detail);
    }
    return withFallback(
      context,
      input,
      call.id,
      { ok: false, answered: true, call_answered: true, reason: "call_processing_error", decision: "failed", call_id: call.id, failure_reason: "call_processing_error", error_detail: detail },
      "call_processing_error"
    );
  }
}

function inferAgentAndUser(call: CallRecord, extensions: ExtensionService) {
  // Decide by extension ownership, not the hardcoded "100 is the user"
  // assumption — an inbound PSTN call is 700 (user's phone) → agent ext.
  const fromIsAgent = extensions.get(call.from_extension)?.owner_type === "agent";
  const toIsAgent = extensions.get(call.to_extension)?.owner_type === "agent";
  if (fromIsAgent && !toIsAgent) return { agentExtension: call.from_extension, userExtension: call.to_extension };
  if (toIsAgent && !fromIsAgent) return { agentExtension: call.to_extension, userExtension: call.from_extension };
  if (call.from_extension === "100") return { agentExtension: call.to_extension, userExtension: call.from_extension };
  if (call.to_extension === "100") return { agentExtension: call.from_extension, userExtension: call.to_extension };
  return { agentExtension: call.from_extension, userExtension: call.to_extension };
}

async function withFallback(
  context: ToolContext,
  input: CallAndWaitInput,
  callId: string | undefined,
  result: PhoneWaitResult,
  reason: string
): Promise<PhoneWaitResult> {
  if (input.fallback_to_text === false) return result;
  try {
    const sessionId = input.session_id;
    const summary = `Call ${callId ?? "(not placed)"} failed (${reason}). Original prompt: ${input.say}`;
    const fallback = context.messages.createMessage({
      from_extension: input.from_extension,
      to_extension: input.to_extension,
      from_type: "agent",
      to_type: "device",
      title: `Missed call: ${input.reason}`,
      body: summary,
      priority: "urgent",
      requires_response: input.expected_response_type !== "freeform",
      response_options: input.fallback_options ?? (input.expected_response_type === "approval" ? ["approve", "deny", "call_again", "mute_30_min"] : []),
      session_id: sessionId,
      call_id: callId,
      subject: callId ? `call:${callId}` : undefined,
      metadata: { kind: "missed_call_fallback", reason, call_decision: result.decision ?? null }
    });
    const delivered = context.wsHub.notifyMissedCallFallback(fallback);
    context.db.event("fallback_sent", { messageId: fallback.id, callId: callId ?? null, reason }, input.from_extension, callId, sessionId);
    maybeStoreMessageMemory(context, fallback, ["agent-phone", "fallback", "call"]);
    const enriched: PhoneWaitResult = {
      ...result,
      fallback_sent: true,
      fallback_message_id: fallback.id,
      fallback_thread_id: fallback.thread_id
    };
    const shouldWait =
      (input.fallback_timeout_seconds ?? 0) > 0 ||
      input.expected_response_type !== "freeform" ||
      input.escalate_to_twilio === true;
    if (!shouldWait) return { ...enriched, fallback_timeout: !delivered ? undefined : false };
    const waitMs = (input.fallback_timeout_seconds ?? input.timeout_seconds ?? 300) * 1000;
    const reply = await context.wsHub.waitForMessageReply(fallback.id, waitMs);
    if (reply.replied) {
      context.db.event("fallback_replied", { messageId: fallback.id, callId: callId ?? null, selectedOption: reply.message?.selected_option ?? null }, input.to_extension, callId, sessionId);
    }
    const waited: PhoneWaitResult = {
      ...enriched,
      fallback_reply: reply.reply?.body ?? null,
      fallback_selected_option: reply.message?.selected_option ?? null,
      fallback_timeout: reply.timeout === true
    };
    // Last-resort escalation: in-app call failed AND the text fallback went
    // unanswered — ring the user's REAL phone via Twilio.
    if (waited.fallback_timeout === true && input.escalate_to_twilio === true) {
      return escalateToTwilio(context, input, callId, waited);
    }
    return waited;
  } catch (error) {
    context.db.event("fallback_failed", { error: error instanceof Error ? error.message : "fallback_error", callId: callId ?? null }, input.from_extension, callId, input.session_id);
    return result;
  }
}

function maybeStoreMessageMemory(context: ToolContext, message: MessageRow, extraTags: string[]) {
  const tags = Array.from(new Set([...extraTags, message.priority]));
  context.memory.storeMemory({
    scope: "message",
    key: message.id,
    content: `[${message.priority}] ${message.title}\n${message.body}`.slice(0, 4000),
    tags
  });
  if (message.session_id) {
    context.memory.appendSessionEvent(message.session_id, "agent_message", message.title, {
      messageId: message.id,
      threadId: message.thread_id,
      priority: message.priority,
      callId: message.call_id
    });
  }
}

function storeCallResponse(
  context: ToolContext,
  call: CallRecord,
  transcript: string,
  decision: string,
  transcriptId: string | undefined,
  expectedResponseType: string
) {
  const memory = context.memory.storeMemory({
    scope: "call",
    key: `${call.id}:response:${transcriptId ?? Date.now()}`,
    content: transcript,
    tags: ["call", "transcript", expectedResponseType, decision]
  });
  if (call.session_id) {
    context.memory.appendSessionEvent(call.session_id, "user_transcript", transcript, {
      callId: call.id,
      transcriptId,
      decision,
      expectedResponseType
    });
  }
  return memory;
}

function classifyResponse(text: string, expectedResponseType: "approval" | "instruction" | "freeform") {
  if (expectedResponseType !== "approval") return expectedResponseType === "instruction" ? "instruction" : "received";
  const normalized = text.toLowerCase();
  if (/\b(no|deny|denied|reject|rejected|stop|do not|don't|cancel|not approved)\b/.test(normalized)) return "denied";
  if (/\b(yes|approve|approved|approval|allowed|go ahead|do it|proceed|restart it|run it|ok|okay)\b/.test(normalized)) return "approved";
  return "unclear";
}

function elapsedSeconds(started: number) {
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

async function waitForTranscriptOrFailure(
  context: ToolContext,
  callId: string,
  fromExtension: string,
  timeoutMs: number
): Promise<
  | { kind: "transcript"; transcript: TranscriptWaitResult }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" }
> {
  const transcriptPromise = context.wsHub.waitForNextTranscript(callId, fromExtension, timeoutMs).then((value) =>
    value ? ({ kind: "transcript" as const, transcript: value }) : ({ kind: "timeout" as const })
  );
  const statePromise = context.wsHub.waitForCallState(callId, ["failed", "ended", "timeout"], timeoutMs).then((value) => ({ kind: "state" as const, value }));
  const winner = await Promise.race([transcriptPromise, statePromise]);
  if (winner.kind === "transcript" || winner.kind === "timeout") return winner;
  if (winner.value.state === "timeout") return { kind: "timeout" };
  const reason = winner.value.call?.failure_reason ?? winner.value.state;
  return { kind: "failed", reason };
}

function requireTwilioService(context: ToolContext): TwilioService {
  if (!context.twilio) throw new Error("twilio_unavailable: server was built without Twilio support");
  return context.twilio;
}

function requireTwilio(context: ToolContext): TwilioService {
  const twilio = requireTwilioService(context);
  if (!twilio.enabled) {
    throw new Error("twilio_not_configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and TWILIO_PUBLIC_BASE_URL in .env");
  }
  return twilio;
}

function resolveTargetNumber(twilio: TwilioService, requested?: string): string {
  const raw = requested ?? twilio.getDefaultUserNumber();
  if (!raw) throw new Error("no destination number: pass to_number or set one with twilio_set_user_number");
  return twilio.normalizeNumber(raw);
}

type TwilioCallAndWaitInput = {
  to_number?: string;
  reason: string;
  say: string;
  from_extension: string;
  urgency: string;
  session_id?: string;
  timeout_seconds: number;
  expected_response_type: "approval" | "instruction" | "freeform";
  fallback_to_sms: boolean;
};

/**
 * Real-phone twin of callAndWaitForUser: dial agent → ext 700, place the
 * Twilio call whose media stream bridges into that internal call, then reuse
 * the exact same speak/wait/classify pipeline.
 */
async function twilioCallAndWait(input: TwilioCallAndWaitInput, context: ToolContext): Promise<PhoneWaitResult> {
  const twilio = requireTwilio(context);
  const bridge = context.twilioBridge;
  if (!bridge) throw new Error("twilio_unavailable: PSTN bridge is not running");
  const caller = context.extensions.get(input.from_extension);
  if (!caller || caller.owner_type !== "agent") throw new Error(`from_extension ${input.from_extension} is not a registered agent extension`);
  const toNumber = resolveTargetNumber(twilio, input.to_number);
  if (!twilio.isAllowed(toNumber)) {
    throw new Error(`${toNumber} is not on the phone allowlist — add it with twilio_allowlist_add first`);
  }

  const started = Date.now();
  // Sink first: ext 700 must be "online" or the dial below records a miss.
  bridge.prepareOutbound();
  const call = context.calls.dial({
    fromExtension: input.from_extension,
    toExtension: PSTN_EXTENSION,
    reason: `PSTN ${toNumber}: ${input.reason}`,
    urgency: input.urgency,
    sessionId: input.session_id
  });

  const withSmsFallback = async (result: PhoneWaitResult): Promise<PhoneWaitResult> => {
    if (!input.fallback_to_sms) return result;
    try {
      const sms = await twilio.sendSms({
        toNumber,
        body: `Missed call from your agent — ${input.reason}: ${input.say}`.slice(0, 1500)
      });
      return { ...result, sms_fallback_sent: true, sms_sid: sms.sid };
    } catch (error) {
      context.db.event(
        "twilio.sms_fallback_failed",
        { error: error instanceof Error ? error.message : "sms_failed" },
        input.from_extension,
        call.id,
        input.session_id
      );
      return { ...result, sms_fallback_sent: false };
    }
  };

  let callSid: string;
  try {
    ({ callSid } = await twilio.placeCall({ toNumber, internalCallId: call.id }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "twilio_call_failed";
    context.wsHub.failCall(call.id, detail);
    return withSmsFallback({
      ok: false,
      answered: false,
      call_answered: false,
      reason: "twilio_call_failed",
      decision: "failed",
      call_id: call.id,
      failure_reason: "twilio_call_failed",
      error_detail: detail,
      phone_number: toNumber
    });
  }
  bridge.expectOutbound(call.id, callSid, toNumber);

  const timeoutMs = input.timeout_seconds * 1000;
  // The bridge accepts the call when Twilio's media stream connects (= the user
  // answered); the status callback fails/timeouts it on no-answer/busy.
  const answer = await context.wsHub.waitForCallState(call.id, ["active", "rejected", "ended", "failed", "timeout"], timeoutMs);
  if (answer.state === "timeout") {
    context.wsHub.timeoutCall(call.id, "pstn_answer_timeout");
    void twilio.hangup(callSid).catch(() => undefined);
    return withSmsFallback({ ok: false, answered: false, call_answered: false, reason: "timeout", decision: "timeout", call_id: call.id, twilio_call_sid: callSid, phone_number: toNumber });
  }
  if (answer.state !== "active") {
    return withSmsFallback({ ok: false, answered: false, call_answered: false, reason: answer.state, decision: answer.state, call_id: call.id, twilio_call_sid: callSid, phone_number: toNumber });
  }

  try {
    context.wsHub.setCallState(call.id, "speaking", input.from_extension);
    await context.wsHub.synthesizeForCall(call.id, input.from_extension, PSTN_EXTENSION, input.say);
    context.wsHub.setCallState(call.id, "waiting_for_user", input.from_extension);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "tts_failed";
    context.wsHub.failCall(call.id, detail);
    void twilio.hangup(callSid).catch(() => undefined);
    return withSmsFallback({
      ok: false,
      answered: true,
      call_answered: true,
      reason: "tts_synthesis_failed",
      decision: "failed",
      call_id: call.id,
      failure_reason: "tts_synthesis_failed",
      error_detail: detail,
      twilio_call_sid: callSid,
      phone_number: toNumber
    });
  }

  try {
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - started));
    const outcome = await waitForTranscriptOrFailure(context, call.id, PSTN_EXTENSION, remainingMs);
    if (outcome.kind === "timeout") {
      context.wsHub.timeoutCall(call.id, "user_response_timeout");
      void twilio.hangup(callSid).catch(() => undefined);
      return withSmsFallback({ ok: false, answered: true, call_answered: true, reason: "timeout", decision: "timeout", call_id: call.id, twilio_call_sid: callSid, phone_number: toNumber });
    }
    if (outcome.kind === "failed") {
      return withSmsFallback({ ok: false, answered: true, call_answered: true, reason: outcome.reason, decision: "failed", call_id: call.id, twilio_call_sid: callSid, phone_number: toNumber });
    }
    const transcript = outcome.transcript;
    context.wsHub.setCallState(call.id, "active", PSTN_EXTENSION);
    const loadedCall = context.calls.get(call.id) ?? call;
    const decision = classifyResponse(transcript.text, input.expected_response_type);
    const memory = storeCallResponse(context, loadedCall, transcript.text, decision, transcript.transcriptId, input.expected_response_type);
    return {
      ok: true,
      answered: true,
      call_answered: true,
      call_id: call.id,
      user_transcript: transcript.text,
      decision,
      duration_seconds: elapsedSeconds(started),
      session_id: loadedCall.session_id,
      memory_id: (memory as { id?: string }).id,
      transcript_id: transcript.transcriptId,
      twilio_call_sid: callSid,
      phone_number: toNumber
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "call_processing_error";
    const current = context.calls.get(call.id);
    if (current && !["ended", "failed", "timeout", "rejected", "missed"].includes(current.state)) {
      context.wsHub.failCall(call.id, detail);
    }
    void twilio.hangup(callSid).catch(() => undefined);
    return withSmsFallback({
      ok: false,
      answered: true,
      call_answered: true,
      reason: "call_processing_error",
      decision: "failed",
      call_id: call.id,
      failure_reason: "call_processing_error",
      error_detail: detail,
      twilio_call_sid: callSid,
      phone_number: toNumber
    });
  }
}

/** In-app call missed + text fallback unanswered → ring the user's real phone. */
async function escalateToTwilio(
  context: ToolContext,
  input: CallAndWaitInput,
  callId: string | undefined,
  fallbackResult: PhoneWaitResult
): Promise<PhoneWaitResult> {
  try {
    const twilio = requireTwilio(context);
    const phone = input.escalate_phone_number ?? twilio.getDefaultUserNumber();
    if (!phone) return fallbackResult;
    context.db.event("call.escalated_to_pstn", { originalCallId: callId ?? null, phone }, input.from_extension, callId, input.session_id);
    const escalation = await twilioCallAndWait(
      {
        to_number: phone,
        reason: input.reason,
        say: input.say,
        from_extension: input.from_extension,
        urgency: input.urgency,
        session_id: input.session_id,
        timeout_seconds: Math.min(input.timeout_seconds || 300, 300),
        expected_response_type: input.expected_response_type,
        fallback_to_sms: false
      },
      context
    );
    if (escalation.ok) {
      // The real call got an answer — surface IT as the result, keeping the
      // fallback breadcrumbs so the thread stays traceable.
      return {
        ...escalation,
        escalated: true,
        escalation_of_call_id: callId,
        fallback_sent: fallbackResult.fallback_sent,
        fallback_message_id: fallbackResult.fallback_message_id,
        fallback_thread_id: fallbackResult.fallback_thread_id,
        fallback_timeout: true
      };
    }
    return {
      ...fallbackResult,
      escalated: true,
      escalation_call_id: escalation.call_id,
      escalation_decision: escalation.decision
    };
  } catch (error) {
    context.db.event(
      "call.escalation_failed",
      { error: error instanceof Error ? error.message : "escalation_failed" },
      input.from_extension,
      callId,
      input.session_id
    );
    return fallbackResult;
  }
}

function schema(properties: Record<string, string>) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, descriptor]) => [
        name,
        descriptor.startsWith("number")
          ? { type: "number" }
          : descriptor.startsWith("boolean")
            ? { type: "boolean" }
            : descriptor.startsWith("string[]")
              ? { type: "array", items: { type: "string" } }
              : descriptor.startsWith("object")
                ? { type: "object" }
                : { type: "string" }
      ])
    )
  };
}

function jsonRpc(id: string | number | undefined, result: unknown) {
  return id === undefined ? result : { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | undefined, message: string) {
  return id === undefined ? { error: message } : { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function wrapToolResult(result: unknown) {
  // Provide a text-friendly content block for Claude/Copilot plus structured content.
  const text = JSON.stringify(result, null, 2);
  const structuredContent = normalizeStructuredContent(result);
  const wrapper: Record<string, unknown> = {
    content: [
      {
        type: "text",
        text
      }
    ],
    structuredContent,
    result
  };
  return wrapper;
}

function normalizeStructuredContent(result: unknown) {
  if (Array.isArray(result)) return { items: result };
  if (result !== null && typeof result === "object") return result;
  return { value: result };
}
