import fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import formbody from "@fastify/formbody";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { MistralClient } from "./mistral/client.js";
import { AudioGateway } from "./audio/audioGateway.js";
import { registerHttpRoutes } from "./routes/http.js";
import { WebSocketHub } from "./websocket/hub.js";
import { registerMcpRoutes, registerMcpLocalRoutes } from "./mcp/tools.js";
import { AgentRegistry } from "./agents/agentRegistry.js";
import { validateAgentsConfig } from "./agents/agentsConfig.js";
import { AgentRunner } from "./agents/agentRunner.js";
import { ExtensionService } from "./extensions/extensionService.js";
import { CallService } from "./calls/callService.js";
import { TwilioService, type TwilioRestApi } from "./twilio/twilioService.js";
import { TwilioBridge } from "./twilio/twilioBridge.js";
import { ScreeningService } from "./twilio/screeningService.js";
import { registerTwilioRoutes } from "./twilio/webhooks.js";
import { RelayBridge } from "./relay/relayBridge.js";
import { createOutboundSmsHook } from "./sms/smsAgent.js";

export type AppServices = {
  db: AppDatabase;
  mistral: MistralClient;
  audio: AudioGateway;
  wsHub: WebSocketHub;
  agentRegistry: AgentRegistry;
  agentRunner: AgentRunner;
  twilio: TwilioService;
  twilioBridge: TwilioBridge;
  screening: ScreeningService;
  relayBridge: RelayBridge;
};

export type CreateAppOptions = {
  /** Test seam: inject a fake Twilio REST api so no real calls/SMS are placed. */
  twilioApi?: TwilioRestApi;
};

export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<{ app: FastifyInstance; services: AppServices }> {
  const db = new AppDatabase(config.databaseUrl);
  const app = fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "token", "apiKey", "*.token", "*.apiKey"]
    }
  });
  await app.register(cors, { origin: false });
  // Twilio posts webhooks as application/x-www-form-urlencoded.
  await app.register(formbody);
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.window,
    hook: "preHandler",
    onExceeded: (request) => {
      db.sqlite
        .prepare("INSERT INTO rate_limit_events (id, actor, route, ip, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(db.id("rl"), request.auth?.tokenLabel ?? null, request.routeOptions.url ?? "unknown", request.ip, db.now());
    }
  });

  const mistral = new MistralClient(config.mistral);
  let audio!: AudioGateway;
  const wsHub = new WebSocketHub(config, db, () => audio);
  audio = new AudioGateway(db, mistral, config, wsHub);

  // Auto-seed the baseline extension set on every startup so a fresh DB never
  // boots with hasUser100=false. Uses ExtensionService.seedDefaults which
  // upserts via ON CONFLICT UPDATE (safe to run on every boot, never clobbers
  // user edits to permissions/metadata that survived).
  try {
    new ExtensionService(db).seedDefaults();
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "extension seed failed");
  }

  // No WebSocket connection can survive a server restart, so any extension still
  // marked online/busy in the DB is stale. Without this reset the server believes
  // dead remote connectors are reachable: list_extensions lies, group chats count
  // delivery to them as success, and calls to them ring into the void.
  try {
    const cleared = db.sqlite
      .prepare("UPDATE extensions SET online = 0, busy = 0, current_session_id = NULL, updated_at = ? WHERE online = 1 OR busy = 1 OR current_session_id IS NOT NULL")
      .run(db.now()).changes;
    if (cleared > 0) app.log.info({ cleared }, "reset stale extension presence from previous run");
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "presence reset failed");
  }

  // Universal on-demand agent calling: seed any extensions declared in
  // agents.config.json so dials route to them, then wire the runner so the
  // adapter spawns on dial.
  const agentRegistry = new AgentRegistry();
  // Issue #18: validate agent config at startup so a misconfigured agent (e.g. a
  // stdio adapter with no command, or a duplicate extension) is loudly flagged at
  // boot instead of only failing when a user finally dials that extension.
  try {
    for (const problem of validateAgentsConfig({ version: 1, agents: agentRegistry.list() })) {
      const line = `agents.config.json: ${problem.extension} (${problem.agentId}) — ${problem.message}`;
      if (problem.severity === "error") app.log.error(line);
      else app.log.warn(line);
    }
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "agent config validation failed");
  }
  try { agentRegistry.seed(db); } catch (error) { app.log.warn({ error }, "agent registry seed failed"); }
  const agentRunner = new AgentRunner(
    agentRegistry,
    config,
    // Live socket ONLY. isExtensionOnline also trusts the DB flag, which the
    // adapter's REST register sets BEFORE its WS connects — the runner would
    // report "online" early and fanouts would fire into a not-yet-open socket.
    (ext) => wsHub.hasLiveConnection(ext),
    {
      info: (...args) => app.log.info(args[0] ?? "agent"),
      warn: (...args) => app.log.warn(args[0] ?? "agent"),
      error: (...args) => app.log.error(args[0] ?? "agent")
    },
    db
  );
  wsHub.setAgentRunner(agentRunner);

  const twilio = new TwilioService(db, config, options.twilioApi);
  const twilioBridge = new TwilioBridge(config, db, wsHub, twilio);
  const screening = new ScreeningService(db, wsHub, twilio);
  screening.setBridge(twilioBridge);
  twilioBridge.setScreening(screening);
  wsHub.setScreeningController(screening);

  // Bluetooth call relay: a near-clone of the Twilio media bridge that receives
  // PCM16 over a WebSocket from a relay device instead of mu-law from Twilio. It
  // drops into the SAME screening + agent pipeline (ext 702) with no changes to
  // the Twilio path; the inbound agent picker is shared via the TwilioService.
  const relayBridge = new RelayBridge(config, db, wsHub, screening, twilio);

  // Two-way "text your agent" over SMS: when an agent replies into an SMS thread,
  // text it back to the sender. Wired here so the hub stays Twilio-agnostic.
  wsHub.setOutboundMessageHook(createOutboundSmsHook({ messages: wsHub.messages, twilio }));

  registerHttpRoutes(app, config, db, audio, wsHub);
  registerMcpRoutes(app, config, db, wsHub, twilio, twilioBridge, screening);
  // Local-only MCP endpoint to support Copilot/Claude HTTP clients that attempt OAuth discovery.
  registerMcpLocalRoutes(app, config, db, wsHub, twilio, twilioBridge, screening);
  registerTwilioRoutes(app, config, db, twilio, twilioBridge, wsHub, screening);
  wsHub.attach(app);
  twilioBridge.attach(app);
  relayBridge.attach(app);

  // Issue #14: enforce message deadlines even when no one reads the message.
  // Sweep past-`expires_at` rows to `expired` on a timer so approval/`*_and_wait`
  // deadlines can't be answered hours late. `unref()` so it never holds the
  // process open on its own.
  const expirySweep = setInterval(() => {
    try {
      const expired = wsHub.messages.expireDueMessages();
      if (expired > 0) app.log.info({ expired }, "message expiry sweep");
    } catch (error) {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "message expiry sweep failed");
    }
  }, 30_000);
  expirySweep.unref?.();

  // Auto idle-collection: an agent that hasn't been called/texted for a while is
  // killed to free RAM. Its conversation lives in the DB, so it respawns with full
  // context the moment you chat again. Agents on an active call are never reaped.
  const idleMs = Math.max(1, Number(process.env.AGENT_IDLE_TIMEOUT_MINUTES ?? 10) || 10) * 60_000;
  const reaperIntervalMs = Math.max(5, Number(process.env.AGENT_REAPER_INTERVAL_SECONDS ?? 60) || 60) * 1_000;
  const reaperCalls = new CallService(db);
  const idleReaper = setInterval(() => {
    try {
      const reaped = agentRunner.reapIdle(idleMs, (ext) => reaperCalls.activeCallsForExtension(ext).length > 0);
      if (reaped.length > 0) app.log.info({ reaped, idleMs }, "reaped idle agent(s) to free RAM (respawn with context on next chat)");
    } catch (error) {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "idle agent reaper failed");
    }
  }, reaperIntervalMs);
  idleReaper.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(expirySweep);
    clearInterval(idleReaper);
    agentRunner.killAll();
    twilioBridge.close();
    relayBridge.close();
    wsHub.close();
    db.close();
  });

  return { app, services: { db, mistral, audio, wsHub, agentRegistry, agentRunner, twilio, twilioBridge, screening, relayBridge } };
}
