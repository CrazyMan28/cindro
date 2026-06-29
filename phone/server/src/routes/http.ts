import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { requireHttpAuth } from "../auth/tokens.js";
import { ExtensionInputSchema, ExtensionService } from "../extensions/extensionService.js";
import { DialSchema, CallService } from "../calls/callService.js";
import { AgentService } from "../agents/agentService.js";
import { EnrollmentService, EnrollAgentInputSchema } from "../agents/enrollmentService.js";
import { AuthTokenService } from "../auth/authTokens.js";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";
import { MemoryService } from "../memory/memoryService.js";
import { ApprovalService } from "../approvals/approvalService.js";
import type { AudioGateway } from "../audio/audioGateway.js";
import { seedDemoData } from "../setup/demoSeed.js";
import { setupStatus } from "../setup/status.js";
import type { WebSocketHub } from "../websocket/hub.js";
import { VoiceProfileService } from "../audio/voiceProfiles.js";
import { TwilioService } from "../twilio/twilioService.js";
import { checkMistralKey } from "../mistral/health.js";
import { ModelConfigService } from "../agents/modelConfig.js";
import { WarRoomService } from "../messaging/warRoom.js";
import { listVoices, fetchVoiceSample } from "../mistral/voices.js";
import { listLocalVoices, getLocalVoice, espeakDataZipPath } from "../voices/localVoices.js";
import { listCloneVoices } from "../voices/cloneVoices.js";
import { handleSlashCommand, isSlashCommand, type SlashContext } from "../messaging/slashCommands.js";

export function registerHttpRoutes(app: FastifyInstance, config: AppConfig, db: AppDatabase, audio: AudioGateway, wsHub: WebSocketHub) {
  const extensions = new ExtensionService(db);
  const calls = new CallService(db);
  const agents = new AgentService(db);
  const memory = new MemoryService(db);
  const approvals = new ApprovalService(db);
  const enrollment = new EnrollmentService(db, config);
  const authTokens = new AuthTokenService(db);
  const messages = wsHub.messages;
  const voiceProfiles = new VoiceProfileService(db);
  const modelConfig = new ModelConfigService();
  const warRoom = new WarRoomService(db, messages, wsHub);
  const slashContext: SlashContext = { db, extensions, agents, messages, calls, warRoom, voiceProfiles, hub: wsHub };
  const anyAuth = requireHttpAuth(config, db);
  const adminAuth = requireHttpAuth(config, db, ["admin"]);
  const agentAuth = requireHttpAuth(config, db, ["admin", "agent"]);
  const deviceAuth = requireHttpAuth(config, db, ["admin", "device"]);
  const enrollAuth = requireHttpAuth(config, db, ["admin", "device"]);

  app.get("/health", async () => ({ ok: true, service: "agent-phone", time: db.now() }));
  if (config.legacyCommandsPullNoop) {
    app.post("/commands/pull", async (_request, reply) => reply.code(204).send());
  }
  app.get("/api/setup/status", { preHandler: requireHttpAuth(config, db, ["admin", "device"]) }, async () => setupStatus(config, db));
  app.post("/api/setup/dev-seed", { preHandler: adminAuth }, async (request, reply) => {
    if (config.productionMode) {
      return reply.code(403).send({ error: "dev_seed_disabled_in_production" });
    }
    const seeded = seedDemoData(db);
    db.audit("setup.dev_seed", { actor: request.auth?.tokenLabel, target: "demo-data", metadata: { extensionCount: seeded.extensionCount, agentCount: seeded.agentCount } });
    return {
      ok: true,
      ...seeded,
      status: setupStatus(config, db)
    };
  });

  app.get("/api/extensions", { preHandler: anyAuth }, async () => extensions.list());
  app.post("/api/extensions", { preHandler: adminAuth }, async (request, reply) => {
    const body = ExtensionInputSchema.parse(request.body);
    const extension = extensions.create(body);
    db.audit("extension.create", { actor: request.auth?.tokenLabel, target: body.extension });
    return reply.code(201).send(extension);
  });
  app.get("/api/extensions/:extension", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ extension: z.string() }).parse(request.params);
    const extension = extensions.get(params.extension);
    if (!extension) return reply.code(404).send({ error: "extension_not_found" });
    return extension;
  });

  app.post("/api/dial", { preHandler: anyAuth }, async (request, reply) => {
    try {
      const call = calls.dial(DialSchema.parse(request.body));
      return reply.code(call.state === "missed" ? 202 : 201).send(call);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/calls/:id/accept", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ extension: z.string() }).parse(request.body);
    try {
      return calls.accept(params.id, body.extension);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/calls/:id/reject", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ extension: z.string(), reason: z.string().optional() }).parse(request.body);
    try {
      return calls.reject(params.id, body.extension, body.reason);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/calls/:id/end", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ extension: z.string(), reason: z.string().optional() }).parse(request.body);
    try {
      return calls.end(params.id, body.extension, body.reason);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get("/api/calls", { preHandler: anyAuth }, async () => calls.list());
  app.get("/api/calls/:id", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const call = calls.get(params.id);
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    return { ...call, messages: calls.getMessages(params.id), transcripts: calls.getTranscripts(params.id) };
  });
  app.get("/api/missed-calls", { preHandler: anyAuth }, async (request) => {
    const query = z.object({ extension: z.string().optional() }).parse(request.query);
    return calls.listMissed(query.extension);
  });

  app.get("/api/agents", { preHandler: anyAuth }, async () => {
    agents.expireHeartbeats(config.agentHeartbeatTimeoutSeconds);
    return agents.list();
  });
  app.post("/api/agents/register", { preHandler: agentAuth }, async (request, reply) => {
    const body = z
      .object({
        id: z.string(),
        extension: z.string(),
        name: z.string(),
        adapterType: z.string(),
        permissions: z.record(z.unknown()).default({}),
        capabilities: z.array(z.string()).default([]),
        status: z.string().default("online"),
        currentTask: z.string().optional(),
        sessionId: z.string().optional()
      })
      .parse(request.body);
    return reply.code(201).send(agents.register(body));
  });
  // Self-service agent enrollment. Mints a per-agent token (stored as SHA-256
  // hash), allocates an extension via AgentService.onboard, and returns an
  // EnrollmentPackage with: token, extension, server URL, MCP config snippet,
  // and a one-shot curl-pipe-bash bootstrap URL for the remote VM.
  app.post("/api/agents/enroll", { preHandler: enrollAuth }, async (request, reply) => {
    try {
      const body = EnrollAgentInputSchema.parse(request.body);
      const pkg = enrollment.enroll(body);
      db.audit("agent.enroll", {
        actor: request.auth?.tokenLabel,
        target: pkg.agentId,
        metadata: { extension: pkg.extension, bootstrapId: pkg.bootstrapId }
      });
      return reply.code(201).send(pkg);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // List per-agent tokens (admin only). Hashes only — never the raw token.
  app.get("/api/agents/:id/tokens", { preHandler: adminAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return authTokens.listByOwner("agent", params.id).map((row) => ({
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      scopes: db.parseJson<string[]>(row.scopes, []),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      tokenHashPrefix: row.token_hash.slice(0, 12)
    }));
  });

  // Revoke a per-agent token (admin only). After this the connector loses WS
  // auth on next reconnect and MCP calls return 401.
  app.delete("/api/agents/:id/tokens/:tokenId", { preHandler: adminAuth }, async (request, reply) => {
    const params = z.object({ id: z.string(), tokenId: z.string() }).parse(request.params);
    const ok = authTokens.revoke(params.tokenId);
    if (!ok) return reply.code(404).send({ error: "token_not_found_or_already_revoked" });
    db.audit("agent.token.revoke", { actor: request.auth?.tokenLabel, target: params.id, metadata: { tokenId: params.tokenId } });
    return { ok: true };
  });

  // Single-use bootstrap installer served as a bash script (no auth — the
  // bootstrap id is the credential, single-use, 24h TTL).
  app.get("/enroll/:id/sh", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const pkg = enrollment.consumeBootstrap(params.id);
    if (!pkg) return reply.code(410).type("text/plain").send("enrollment bootstrap expired or already used");
    const templatePath = path.join(repoRoot, "server", "static", "bootstrap.sh.template");
    const template = fs.readFileSync(templatePath, "utf8");
    const connectorUrl = `${pkg.serverUrl.replace(/\/$/, "")}/static/connect.mjs`;
    const rendered = template
      .replace(/__AGENT_NAME__/g, pkg.name)
      .replace(/__EXTENSION__/g, pkg.extension)
      .replace(/__EXPIRES_AT__/g, pkg.expiresAt)
      .replace(/__CONNECTOR_URL__/g, connectorUrl)
      .replace(/__AGENT_JSON__/g, JSON.stringify(pkg, null, 2));
    return reply.type("text/x-shellscript").send(rendered);
  });

  // Static connector source. Public — the bootstrap installer needs it before
  // the agent has a token. The connector itself authenticates on connect.
  app.get("/static/connect.mjs", async (_request, reply) => {
    const connectorPath = path.join(repoRoot, "server", "static", "connect.mjs");
    const body = fs.readFileSync(connectorPath, "utf8");
    return reply.type("application/javascript").send(body);
  });

  // 2026 cyberpunk ops HUD. The HTML shell is public (no secrets in it); it
  // prompts for a token in-page and calls the authenticated /api/* endpoints.
  const serveDashboard = (_request: unknown, reply: { type: (t: string) => { send: (b: unknown) => unknown } }) => {
    const dashboardPath = path.join(repoRoot, "server", "static", "dashboard.html");
    return reply.type("text/html").send(fs.readFileSync(dashboardPath, "utf8"));
  };
  app.get("/dashboard", serveDashboard);
  app.get("/static/dashboard.html", serveDashboard);

  // One-command device onboarding script (public — it requires an ENROLL_TOKEN
  // passed by the operator at runtime, so serving the script itself is safe):
  //   curl -fsSL <server>/onboard/device.sh | SERVER_URL=.. ENROLL_TOKEN=.. NAME=.. bash
  app.get("/onboard/device.sh", async (_request, reply) => {
    const scriptPath = path.join(repoRoot, "scripts", "onboard-device.sh");
    return reply.type("text/x-shellscript").send(fs.readFileSync(scriptPath, "utf8"));
  });

  app.post("/api/agents/onboard", { preHandler: agentAuth }, async (request, reply) => {
    const body = z
      .object({
        agent_id: z.string().min(1),
        name: z.string().min(1),
        adapter_type: z.string().min(1),
        requested_extension: z.string().optional(),
        capabilities: z.array(z.string()).default([]),
        current_task: z.string().optional()
      })
      .parse(request.body);
    try {
      const agent = agents.onboard({
        agentId: body.agent_id,
        name: body.name,
        adapterType: body.adapter_type,
        requestedExtension: body.requested_extension,
        capabilities: body.capabilities,
        currentTask: body.current_task
      });
      return reply.code(201).send(agent);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get("/api/agents/:id", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const agent = agents.get(params.id);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return agent;
  });
  app.post("/api/agents/:id/heartbeat", { preHandler: agentAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        status: z.string().default("online"),
        current_task: z.string().optional(),
        currentTask: z.string().optional(),
        session_id: z.string().optional(),
        sessionId: z.string().optional()
      })
      .parse(request.body);
    const agent = agents.heartbeat(params.id, body.status, body.currentTask ?? body.current_task, body.sessionId ?? body.session_id);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return agent;
  });
  app.post("/api/agents/:id/status", { preHandler: agentAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ status: z.string(), currentTask: z.string().optional(), sessionId: z.string().optional() }).parse(request.body);
    const agent = agents.updateStatus(params.id, body.status, body.currentTask, body.sessionId);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return agent;
  });

  app.get("/api/sessions", { preHandler: anyAuth }, async () => memory.listSessions());
  app.post("/api/sessions", { preHandler: anyAuth }, async (request, reply) => {
    const body = z.object({ agentId: z.string().optional(), repoPath: z.string().optional(), task: z.string().optional() }).parse(request.body);
    return reply.code(201).send(memory.createSession(body.agentId, body.repoPath, body.task));
  });
  app.get("/api/sessions/:id", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const session = memory.getSession(params.id);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return { ...session, context: memory.getSessionContext(params.id, 100) };
  });
  app.get("/api/sessions/:id/calls", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return memory.getSessionCalls(params.id);
  });
  app.get("/api/sessions/:id/summary", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return memory.summarizeSession(params.id);
  });
  app.post("/api/sessions/:id/event", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ eventType: z.string(), content: z.string(), metadata: z.unknown().optional() }).parse(request.body);
    return memory.appendSessionEvent(params.id, body.eventType, body.content, body.metadata);
  });
  app.get("/api/memory/search", { preHandler: anyAuth }, async (request) => {
    const query = z.object({ q: z.string(), limit: z.coerce.number().int().positive().max(100).default(10) }).parse(request.query);
    return memory.searchMemory(query.q, query.limit);
  });
  app.post("/api/memory", { preHandler: anyAuth }, async (request, reply) => {
    const body = z.object({ scope: z.string(), key: z.string(), content: z.string(), tags: z.array(z.string()).default([]) }).parse(request.body);
    return reply.code(201).send(memory.storeMemory(body));
  });
  app.get("/api/agents/:id/context", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return memory.getLatestAgentContext(params.id);
  });
  app.get("/api/calls/:id/transcript", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return { transcripts: calls.getTranscripts(params.id), messages: calls.getMessages(params.id) };
  });
  app.get("/api/calls/:id/summary", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return memory.getCallSummary(params.id);
  });

  app.post("/api/audio/stt", { preHandler: deviceAuth }, async (request) => {
    const body = z
      .object({
        callId: z.string(),
        fromExtension: z.string(),
        audioBase64: z.string(),
        audioFormat: z.string().optional(),
        codec: z.string().optional(),
        sampleRate: z.coerce.number().int().positive().default(16_000),
        channels: z.coerce.number().int().positive().default(1)
      })
      .parse(request.body);
    return audio.transcribeBuffer(
      body.callId,
      body.fromExtension,
      Buffer.from(body.audioBase64, "base64"),
      body.audioFormat ?? body.codec ?? "pcm_s16le",
      body.sampleRate,
      body.channels
    );
  });
  app.post("/api/audio/tts", { preHandler: anyAuth }, async (request) => {
    const body = z
      .object({
        text: z.string(),
        responseFormat: z.enum(["pcm", "wav", "mp3", "flac", "opus"]).default("wav"),
        voiceId: z.string().optional(),
        refAudioBase64: z.string().optional()
      })
      .parse(request.body);
    const result = await audio.ttsBuffer(body.text, body);
    return { ...result, audioBase64: result.audio.toString("base64"), audio: undefined };
  });

  app.post("/api/approvals/:id/approve", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ response: z.string().optional() }).parse(request.body ?? {});
    return approvals.approve(params.id, body.response);
  });
  app.post("/api/approvals/:id/deny", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ response: z.string().optional() }).parse(request.body ?? {});
    return approvals.deny(params.id, body.response);
  });
  app.get("/api/audit", { preHandler: adminAuth }, async () =>
    db.sqlite.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250").all()
  );

  const MessageStatusSchema = z.enum(["queued", "delivered", "read", "replied", "expired"]);

  app.get("/api/messages", { preHandler: deviceAuth }, async (request) => {
    const query = z
      .object({
        extension: z.string().optional(),
        status: MessageStatusSchema.optional(),
        thread_id: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).default(100)
      })
      .parse(request.query);
    return messages.listMessages({ thread_id: query.thread_id, extension: query.extension, status: query.status, limit: query.limit });
  });

  app.get("/api/messages/:id", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const message = messages.getMessage(params.id);
    if (!message) return reply.code(404).send({ error: "message_not_found" });
    return message;
  });

  app.post("/api/messages/:id/read", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const message = messages.markRead(params.id);
    if (!message) return reply.code(404).send({ error: "message_not_found" });
    wsHub.notifyMessageRead(message);
    return message;
  });

  // Call-screening master switch + which agent answers, from the phone app
  // (device auth). Pure settings read/write — no Twilio API client needed.
  const screeningSettings = new TwilioService(db, config);
  const screeningExtensions = new ExtensionService(db);
  const screeningAgents = () =>
    screeningExtensions
      .list()
      .filter((e) => e.owner_type === "agent")
      .map((e) => ({ extension: e.extension, name: e.name }));
  // Mistral key liveness — so a revoked/expired key (which silently breaks ALL
  // screening voice on both transports) is visible, and a fresh key verifies in
  // one call. Checks the voice key (TTS/STT) and the screener chat key.
  app.get("/api/mistral-health", { preHandler: deviceAuth }, async () => {
    const base = config.mistral.baseUrl;
    const [voice, chat] = await Promise.all([
      checkMistralKey(config.mistral.apiKey, base),
      checkMistralKey(process.env.MISTRAL_CHAT_API_KEY || config.mistral.apiKey, base)
    ]);
    return { voice_key: voice, chat_key: chat, ok: voice.ok && chat.ok };
  });

  // `inbound_extension` = who answers when YOU (allowlisted) dial in.
  // `screening_extension` = who screens UNKNOWN callers. Kept separate so the
  // screening agent picker never changes who takes your own calls.
  const assertAgent = (reply: import("fastify").FastifyReply, extension: string) => {
    const ext = screeningExtensions.get(extension);
    if (!ext || ext.owner_type !== "agent") {
      reply.code(400).send({ error: "not_an_agent_extension" });
      return false;
    }
    return true;
  };
  app.get("/api/screening", { preHandler: deviceAuth }, async () => ({
    enabled: screeningSettings.getScreeningEnabled(),
    configured: screeningSettings.enabled,
    inbound_extension: screeningSettings.getInboundExtension(),
    screening_extension: screeningSettings.getScreeningAgentExtension(),
    transport: screeningSettings.getScreeningTransport(),
    agents: screeningAgents()
  }));
  app.post("/api/screening", { preHandler: deviceAuth }, async (request, reply) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        inbound_extension: z.string().optional(),
        screening_extension: z.string().optional(),
        transport: z.enum(["twilio", "relay"]).optional()
      })
      .parse(request.body ?? {});
    if (typeof body.enabled === "boolean") screeningSettings.setScreeningEnabled(body.enabled);
    if (body.transport) screeningSettings.setScreeningTransport(body.transport);
    if (body.inbound_extension) {
      if (!assertAgent(reply, body.inbound_extension)) return;
      screeningSettings.setInboundExtension(body.inbound_extension);
    }
    if (body.screening_extension) {
      if (!assertAgent(reply, body.screening_extension)) return;
      screeningSettings.setScreeningAgentExtension(body.screening_extension);
    }
    return {
      enabled: screeningSettings.getScreeningEnabled(),
      inbound_extension: screeningSettings.getInboundExtension(),
      screening_extension: screeningSettings.getScreeningAgentExtension(),
      transport: screeningSettings.getScreeningTransport(),
      agents: screeningAgents()
    };
  });

  // Two-way "text your agent" over SMS: master switch + which agent answers.
  app.get("/api/sms-agent", { preHandler: deviceAuth }, async () => ({
    enabled: screeningSettings.getSmsAgentEnabled(),
    configured: screeningSettings.enabled,
    extension: screeningSettings.getSmsAgentExtension(),
    agents: screeningAgents()
  }));
  app.post("/api/sms-agent", { preHandler: deviceAuth }, async (request, reply) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        extension: z.string().optional()
      })
      .parse(request.body ?? {});
    if (typeof body.enabled === "boolean") screeningSettings.setSmsAgentEnabled(body.enabled);
    if (body.extension) {
      const ext = screeningExtensions.get(body.extension);
      if (!ext || ext.owner_type !== "agent") {
        return reply.code(400).send({ error: "not_an_agent_extension" });
      }
      screeningSettings.setSmsAgentExtension(body.extension);
    }
    return {
      enabled: screeningSettings.getSmsAgentEnabled(),
      extension: screeningSettings.getSmsAgentExtension(),
      agents: screeningAgents()
    };
  });

  app.post("/api/messages/:id/reply", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ response_text: z.string().optional(), selected_option: z.string().optional() })
      .parse(request.body ?? {});
    const result = messages.replyToMessage(params.id, body);
    if (!result) return reply.code(404).send({ error: "message_not_found" });
    await wsHub.ensureAgentOnline(result.original.from_extension);
    wsHub.notifyMessageReplied(result.original, result.reply);
    return result;
  });

  // Start a new chat (no thread_id) or continue one (with thread_id): a user-sent
  // message to an agent. Spawns the agent if offline so you can text without calling.
  app.post("/api/messages", { preHandler: deviceAuth }, async (request, reply) => {
    const body = z
      .object({
        to_extension: z.string().min(1),
        body: z.string().min(1),
        from_extension: z.string().default("100"),
        thread_id: z.string().optional(),
        title: z.string().optional()
      })
      .parse(request.body ?? {});

    // Group thread: route through the war room so the post reaches EVERY member and
    // all agents respond into the same shared thread.
    if (body.thread_id && messages.threadMembers(body.thread_id).length > 1) {
      // deviceAuth route = the real phone = a genuine USER turn (resets the
      // agent-relay chain cap). MCP/agent group posts never get this flag.
      const delivered = await warRoom.postToGroup({ threadId: body.thread_id, fromExtension: body.from_extension, body: body.body, userAuthored: true });
      return { ok: true, thread_id: body.thread_id, group: true, delivered };
    }

    const input = {
      from_extension: body.from_extension,
      to_extension: body.to_extension,
      from_type: "device" as const,
      to_type: "agent" as const,
      title: body.title?.trim() || body.body.slice(0, 80),
      body: body.body,
      priority: "normal" as const,
      requires_response: false,
      response_options: [] as string[],
      metadata: {}
    };
    const message = body.thread_id
      ? messages.createMessage({ ...input, thread_id: body.thread_id })
      : messages.startConversation(input);

    // Slash-commands: handle server-side and have the agent "reply" instantly
    // (CLI-style) instead of forwarding the text to the LLM agent.
    if (isSlashCommand(body.body)) {
      // A slash command must ALWAYS produce an in-thread reply — a handler
      // throw degrading to a raw HTTP error breaks the CLI-style contract.
      const result = await handleSlashCommand(
        { body: body.body, fromExtension: body.from_extension, toExtension: body.to_extension, threadId: message.thread_id },
        slashContext
      ).catch((error: unknown) => ({
        handled: true,
        reply: `command failed: ${error instanceof Error ? error.message : "unknown error"}`,
        meta: { error: true } as Record<string, unknown>
      }));
      if (!result.handled) {
        // Not a phone command — deliver to the agent like a normal message so
        // its own CLI runs the slash command (Claude Code /usage, custom
        // commands, Codex slash commands, ...).
        await wsHub.ensureAgentOnline(body.to_extension);
        wsHub.notifyNewMessage(message);
        return message;
      }
      // /clear may have deleted the thread; createMessage re-creates one if so.
      const cleared = result.meta?.cleared === true;
      const replyMsg = messages.createMessage({
        from_extension: body.to_extension,
        to_extension: body.from_extension,
        from_type: "agent",
        to_type: "device",
        title: input.title,
        body: result.reply,
        priority: "normal",
        requires_response: false,
        response_options: [],
        ...(cleared ? {} : { thread_id: message.thread_id }),
        metadata: { kind: "slash_reply", command: body.body.trim().split(/\s+/)[0], ...(result.meta ?? {}) }
      });
      wsHub.notifyNewMessage(replyMsg);
      return { ...message, slash_reply: replyMsg };
    }

    await wsHub.ensureAgentOnline(body.to_extension);
    wsHub.notifyNewMessage(message);
    return message;
  });

  // Voice profiles (per-extension call voice + speaking rate).
  app.get("/api/extensions/:extension/voice", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ extension: z.string() }).parse(request.params);
    return voiceProfiles.get(params.extension);
  });
  // deviceAuth (not adminAuth) so the app's Settings voice picker works with the
  // device token — same trust level as the model picker right below.
  app.put("/api/extensions/:extension/voice", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ extension: z.string() }).parse(request.params);
    const body = z
      .object({
        voiceId: z.string().nullable().optional(),
        speed: z.number().nullable().optional(),
        name: z.string().nullable().optional()
      })
      .parse(request.body ?? {});
    const profile = voiceProfiles.set(params.extension, body);
    if (!profile) return reply.code(404).send({ error: "extension_not_found" });
    db.audit("voice.profile.set", { actor: request.auth?.tokenLabel, target: params.extension, metadata: body });
    return profile;
  });

  // Voice catalog for the per-agent voice picker: ON-DEVICE models first
  // (synthesized on the phone), then Mistral voices.
  app.get("/api/voices", { preHandler: anyAuth }, async () => {
    // The user's named cloned voices (record/upload, managed by the Jarvis daemon)
    // come FIRST, then on-device Piper voices, then the Mistral preset catalog.
    const clones = listCloneVoices().map((v) => ({ id: v.id, name: v.name }));
    const local = listLocalVoices().map((v) => ({ id: v.id, name: v.name }));
    return { voices: [...clones, ...local, ...(await listVoices(config.mistral))] };
  });

  // On-device voice model distribution: the phone downloads the model from
  // HERE (the laptop only stores/serves — synthesis runs on the phone).
  app.get("/api/local-voices", { preHandler: anyAuth }, async () => {
    return {
      voices: listLocalVoices().map((v) => ({
        id: v.id,
        name: v.name,
        sampleRate: v.sampleRate,
        files: Object.fromEntries(
          Object.entries(v.files).map(([k, p]) => [k, { size: fs.statSync(p).size }])
        )
      })),
      espeakDataAvailable: espeakDataZipPath() !== null
    };
  });
  app.get("/api/local-voices/espeak-ng-data.zip", { preHandler: anyAuth }, async (_request, reply) => {
    const p = espeakDataZipPath();
    if (!p) return reply.code(404).send({ error: "espeak_data_missing" });
    return reply.type("application/zip").send(fs.createReadStream(p));
  });
  app.get("/api/local-voices/:voice/:file", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ voice: z.string(), file: z.enum(["model.onnx", "config.json", "tokens.txt", "sample.mp3"]) }).parse(request.params);
    const voice = getLocalVoice(params.voice);
    if (!voice) return reply.code(404).send({ error: "local_voice_not_found" });
    // sample.mp3 = the model's bundled preview clip; the app plays it WITHOUT
    // running the native engine, so previewing can never crash the app.
    if (params.file === "sample.mp3") {
      if (!voice.samplePath) return reply.code(404).send({ error: "no_sample" });
      reply.header("content-length", fs.statSync(voice.samplePath).size);
      return reply.type("audio/mpeg").send(fs.createReadStream(voice.samplePath));
    }
    const filePath = params.file === "model.onnx" ? voice.files.model : params.file === "config.json" ? voice.files.config : voice.files.tokens;
    const type = params.file.endsWith(".json") ? "application/json" : params.file.endsWith(".txt") ? "text/plain" : "application/octet-stream";
    reply.header("content-length", fs.statSync(filePath).size);
    return reply.type(type).send(fs.createReadStream(filePath));
  });

  // Preview audio for one voice (proxies Mistral's sample endpoint, cached).
  app.get("/api/voices/:voiceId/sample", { preHandler: anyAuth }, async (request, reply) => {
    const params = z.object({ voiceId: z.string() }).parse(request.params);
    const sample = await fetchVoiceSample(config.mistral, params.voiceId);
    if (!sample) return reply.code(404).send({ error: "voice_sample_unavailable" });
    return reply.type(sample.contentType).send(sample.bytes);
  });

  // Per-agent model + thinking/reasoning level (Settings model picker). Read live
  // by the CLI bridges each turn, so changes apply on the agent's next message.
  app.get("/api/extensions/:extension/model", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ extension: z.string() }).parse(request.params);
    return modelConfig.get(params.extension);
  });
  app.put("/api/extensions/:extension/model", { preHandler: deviceAuth }, async (request) => {
    const params = z.object({ extension: z.string() }).parse(request.params);
    const body = z
      .object({ model: z.string().nullable().optional(), reasoning: z.string().nullable().optional() })
      .parse(request.body ?? {});
    const next = modelConfig.set(params.extension, {
      model: body.model === null ? "" : body.model,
      reasoning: body.reasoning === null ? "" : body.reasoning
    });
    db.audit("agent.model.set", { actor: request.auth?.tokenLabel, target: params.extension, metadata: next });
    return next;
  });

  // Dynamic cross-channel memory: the unified recent history between an agent and a
  // user — BOTH in-app texts and what was said on phone calls — merged in time order.
  // The agent connectors load this each turn so a chat and a call share one memory.
  app.get("/api/conversation", { preHandler: anyAuth }, async (request) => {
    const q = z
      .object({ agent: z.string(), peer: z.string(), limit: z.coerce.number().int().positive().max(100).default(30) })
      .parse(request.query);
    const texts = db.sqlite
      .prepare(
        `SELECT created_at, from_extension, body AS text FROM agent_messages
         WHERE (from_extension = ? AND to_extension = ?) OR (from_extension = ? AND to_extension = ?)
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(q.agent, q.peer, q.peer, q.agent, q.limit) as Array<{ created_at: string; from_extension: string; text: string }>;
    const calls = db.sqlite
      .prepare(
        `SELECT m.created_at, m.from_extension, m.content AS text FROM messages m
         JOIN calls c ON m.call_id = c.id
         WHERE m.content IS NOT NULL AND m.content != ''
           AND ((c.from_extension = ? AND c.to_extension = ?) OR (c.from_extension = ? AND c.to_extension = ?))
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(q.agent, q.peer, q.peer, q.agent, q.limit) as Array<{ created_at: string; from_extension: string; text: string }>;
    const items = [
      ...texts.map((t) => ({ at: t.created_at, channel: "text" as const, who: t.from_extension === q.agent ? "agent" : "user", text: t.text })),
      ...calls.map((c) => ({ at: c.created_at, channel: "call" as const, who: c.from_extension === q.agent ? "agent" : "user", text: c.text }))
    ]
      .filter((i) => typeof i.text === "string" && i.text.trim())
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(-q.limit);
    return { items };
  });

  // War zone: trigger a red alert / start a group chat over HTTP.
  app.post("/api/red-alert", { preHandler: deviceAuth }, async (request) => {
    const body = z.object({ from_extension: z.string().default("100"), message: z.string().default("") }).parse(request.body ?? {});
    return warRoom.triggerRedAlert({ fromExtension: body.from_extension, message: body.message });
  });
  app.post("/api/group-chat", { preHandler: deviceAuth }, async (request, reply) => {
    try {
      // Parse inside the try so a malformed body (e.g. empty members) is a clean
      // 400, not a raw 500 with a Zod stack dump.
      const body = z
        .object({
          from_extension: z.string().default("100"),
          members: z.array(z.string()).min(1),
          subject: z.string().optional(),
          message: z.string().optional()
        })
        .parse(request.body ?? {});
      return await warRoom.createGroupChat({ fromExtension: body.from_extension, members: body.members, subject: body.subject, message: body.message, userAuthored: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/group-chat/:groupId/post", { preHandler: anyAuth }, async (request, reply) => {
    try {
      const params = z.object({ groupId: z.string() }).parse(request.params);
      const body = z.object({ from_extension: z.string().default("100"), body: z.string().min(1) }).parse(request.body ?? {});
      // Only a device/admin token (the phone) is a genuine user turn; an agent
      // token posting here is agent-authored (can't reset the relay cap).
      const userAuthored = request.auth?.role === "device" || request.auth?.role === "admin";
      const delivered = await warRoom.postToGroup({ threadId: params.groupId, fromExtension: body.from_extension, body: body.body, userAuthored });
      return { ok: true, delivered };
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get("/api/group-chat/:groupId", { preHandler: anyAuth }, async (request) => {
    const params = z.object({ groupId: z.string() }).parse(request.params);
    return { group_id: params.groupId, messages: warRoom.groupMessages(params.groupId) };
  });

  // Conference CALL with hand-picked agents (the voice twin of /api/group-chat).
  app.post("/api/conference", { preHandler: deviceAuth }, async (request, reply) => {
    try {
      const body = z
        .object({
          from_extension: z.string().default("100"),
          members: z.array(z.string()).min(1),
          reason: z.string().optional()
        })
        .parse(request.body ?? {});
      return await warRoom.startConference({ fromExtension: body.from_extension, members: body.members, reason: body.reason });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/message-threads/:id", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const ok = messages.deleteThread(params.id);
    if (!ok) return reply.code(404).send({ error: "thread_not_found" });
    return { ok: true, thread_id: params.id };
  });

  app.get("/api/message-threads", { preHandler: deviceAuth }, async (request) => {
    const query = z
      .object({
        extension: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).default(50)
      })
      .parse(request.query);
    return messages.listThreads({ extension: query.extension, status: query.status, limit: query.limit });
  });

  app.get("/api/message-threads/:id", { preHandler: deviceAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const thread = messages.getThread(params.id);
    if (!thread) return reply.code(404).send({ error: "thread_not_found" });
    return { ...thread, messages: messages.listMessages({ thread_id: params.id, limit: 500 }) };
  });
}

function sendError(reply: { code: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  const statusCode = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode: number }).statusCode) : 400;
  const message = error instanceof Error ? error.message : "request_failed";
  return reply.code(statusCode).send({ error: message });
}
