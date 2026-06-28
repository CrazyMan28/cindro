import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { authenticateToken, extractBearer } from "../auth/tokens.js";
import { AgentService } from "../agents/agentService.js";
import type { AgentRunner } from "../agents/agentRunner.js";
import { CallService } from "../calls/callService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { MemoryService } from "../memory/memoryService.js";
import { ApprovalService } from "../approvals/approvalService.js";
import { MessageService, type MessageRow } from "../messaging/messageService.js";
import { WarRoomService, RED_ALERT_EXTENSION } from "../messaging/warRoom.js";
import { parseKickCommand, selectTurnTargets, selectGroupTextTargets } from "../calls/conferenceRouting.js";
import type { AudioGateway, AudioEventSink } from "../audio/audioGateway.js";
import type { AuthContext, CallRecord } from "../types.js";
import {
  AgentHelloSchema,
  AudioChunkEventSchema,
  AudioStartEventSchema,
  AuthEventSchema,
  CallIdEventSchema,
  CallMessageEventSchema,
  DialEventSchema,
  PresenceUpdateSchema,
  parseJsonMessage
} from "./protocol.js";

/** Call states from which a call never transitions again — cleanup triggers. */
const TERMINAL_CALL_STATES = new Set<CallRecord["state"]>(["ended", "rejected", "timeout", "failed", "missed"]);

/**
 * Rough spoken duration of a TTS utterance: ~15 chars/sec (≈150 wpm), clamped
 * to [1.2s, 30s]. Used to pace the per-call speak chain so the next war-room
 * speaker doesn't start while this utterance is still playing on the phone.
 */
function estimateSpeechMs(text: string): number {
  return Math.min(30_000, Math.max(1_200, Math.round(text.length * 65)));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Client = {
  id: string;
  ws: WebSocket;
  auth?: AuthContext;
  extension?: string;
  clientType?: string;
  isAlive?: boolean;
};

type CallWaiter = {
  states: Set<CallRecord["state"]>;
  resolve: (result: { state: CallRecord["state"] | "timeout"; call?: CallRecord }) => void;
  timeout: NodeJS.Timeout;
};

type TranscriptWaiter = {
  fromExtension?: string;
  resolve: (result: TranscriptWaitResult | undefined) => void;
  timeout: NodeJS.Timeout;
};

type MessageReplyWaiter = {
  resolve: (result: { replied: boolean; message?: MessageRow; reply?: MessageRow; timeout?: boolean }) => void;
  timeout: NodeJS.Timeout;
};

export type TranscriptWaitResult = {
  callId: string;
  fromExtension: string;
  text: string;
  transcriptId?: string;
  transcript?: unknown;
};

export class WebSocketHub implements AudioEventSink {
  private readonly wss = new WebSocketServer({ noServer: true });
  private log?: FastifyInstance["log"];
  private readonly clients = new Map<string, Client>();
  private readonly byExtension = new Map<string, Set<string>>();
  // In-process event sinks (e.g. the Twilio PSTN bridge for ext 700): receive
  // everything a WebSocket client on that extension would, count as online.
  private readonly localSinks = new Map<string, (event: Record<string, unknown>) => void>();
  // Per-call observers (call screening): see every event the hub delivers for
  // one callId, regardless of which extension it was addressed to.
  private readonly callObservers = new Map<string, (event: Record<string, unknown>) => void>();
  private screeningController?: { takeOver(callId: string): Promise<unknown>; end(callId: string): unknown };
  private outboundMessageHook?: (message: MessageRow) => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly calls: CallService;
  private readonly extensions: ExtensionService;
  private readonly agents: AgentService;
  private readonly memory: MemoryService;
  private readonly approvals: ApprovalService;
  readonly messages: MessageService;
  private readonly warRoom: WarRoomService;
  private readonly callWaiters = new Map<string, Set<CallWaiter>>();
  private readonly transcriptWaiters = new Map<string, Set<TranscriptWaiter>>();
  private readonly messageReplyWaiters = new Map<string, Set<MessageReplyWaiter>>();
  private readonly summarizedCalls = new Set<string>();
  // Per-call TTS queue so multiple agents in a war room speak one at a time
  // instead of synthesizing over each other into garbled overlapping audio.
  private readonly callSpeakChains = new Map<string, Promise<void>>();
  // Lead-listens-first policy: per multi-party call, the agent that answers
  // unaddressed turns. Set lazily on the first turn; promoted on kick.
  private readonly callLeads = new Map<string, string>();

  private agentRunner?: AgentRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly audioProvider: () => AudioGateway
  ) {
    this.calls = new CallService(db);
    this.extensions = new ExtensionService(db);
    this.agents = new AgentService(db);
    this.memory = new MemoryService(db);
    this.approvals = new ApprovalService(db);
    this.messages = new MessageService(db);
    this.warRoom = new WarRoomService(db, this.messages, this);
  }

  setAgentRunner(runner: AgentRunner) {
    this.agentRunner = runner;
  }

  /**
   * Cold-texting: if `extension` is a configured agent that isn't connected,
   * spawn it and wait until it's online so an inbound text/message gets handled
   * even when the user never called first. No-op for devices or online agents.
   */
  async ensureAgentOnline(extension: string): Promise<void> {
    if (!this.agentRunner) return;
    this.agentRunner.markActive(extension); // any text/interaction keeps it from being reaped
    if (this.byExtension.has(extension)) return; // already connected
    if (!this.agentRunner.lookup(extension)) return; // not a configured agent
    try {
      await this.agentRunner.ensureRunning(extension);
    } catch {
      // best-effort — the message is persisted regardless, agent picks it up next connect
    }
  }

  attach(app: FastifyInstance) {
    this.log = app.log;
    app.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      app.log.info({ path: url.pathname, host: request.headers.host }, "websocket upgrade requested");
      if (url.pathname !== "/ws") {
        app.log.warn({ path: url.pathname }, "websocket upgrade ignored for unsupported path");
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
    });
    this.wss.on("connection", (ws, request) => this.connect(ws, request));

    // Heartbeat: ping every client periodically and drop ones that stop
    // ponging. Keeps NAT/Tailscale mappings warm (mobile networks kill idle
    // sockets) and keeps presence accurate so calls aren't sent to a dead
    // connection. Clients auto-respond to ping frames at the protocol level.
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (client.isAlive === false) {
          try { client.ws.terminate(); } catch { /* already gone */ }
          continue;
        }
        client.isAlive = false;
        try { client.ws.ping(); } catch { /* will be reaped next tick */ }
      }
    }, 25_000);
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.wss.close();
  }

  sendToExtension(extension: string, event: Record<string, unknown>) {
    this.observeOutboundEvent(event);
    const sink = this.localSinks.get(extension);
    if (sink) {
      try {
        sink(event);
      } catch (error) {
        this.log?.warn({ extension, error: error instanceof Error ? error.message : "sink_failed" }, "local sink delivery failed");
      }
    }
    const ids = this.byExtension.get(extension);
    if (!ids) return;
    for (const id of ids) {
      const client = this.clients.get(id);
      if (client?.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Register an in-process delivery sink for an extension. While registered,
   * the extension is treated as online/live and every event addressed to it is
   * handed to `sink` in addition to any WebSocket clients.
   */
  registerLocalSink(extension: string, sink: (event: Record<string, unknown>) => void) {
    this.localSinks.set(extension, sink);
    this.extensions.setPresence(extension, true);
  }

  unregisterLocalSink(extension: string) {
    if (!this.localSinks.delete(extension)) return;
    if (!this.byExtension.has(extension)) this.extensions.setPresence(extension, false);
  }

  /** Watch every event delivered for one call (used by call screening). */
  observeCall(callId: string, observer: (event: Record<string, unknown>) => void) {
    this.callObservers.set(callId, observer);
  }

  unobserveCall(callId: string) {
    this.callObservers.delete(callId);
  }

  setScreeningController(controller: { takeOver(callId: string): Promise<unknown>; end(callId: string): unknown }) {
    this.screeningController = controller;
  }

  /**
   * Observe every delivered message (e.g. to text an agent's reply back out over
   * SMS). Kept generic so the hub doesn't depend on Twilio — the handler decides
   * what's relevant and must never throw. See src/sms/smsAgent.ts.
   */
  setOutboundMessageHook(handler: (message: MessageRow) => void) {
    this.outboundMessageHook = handler;
  }

  sendToCall(callId: string, event: Record<string, unknown>) {
    const participants = this.db.sqlite.prepare("SELECT extension FROM call_participants WHERE call_id = ?").all(callId) as Array<{ extension: string }>;
    for (const participant of participants) {
      this.sendToExtension(participant.extension, event);
    }
  }

  notifyIncomingCall(call: CallRecord) {
    this.emitCallState(call);
    if (call.state === "ringing") {
      this.sendToExtension(call.to_extension, { type: "incoming_call", call });
      this.sendToExtension(call.from_extension, { type: "dial_result", call });
    } else if (call.state === "missed") {
      this.sendToExtension(call.from_extension, { type: "missed_call", call });
    } else {
      this.sendToExtension(call.from_extension, { type: "dial_result", call });
    }
  }

  async synthesizeForCall(callId: string, fromExtension: string, toExtension: string, text: string) {
    return this.audioProvider().synthesizeForCall(callId, fromExtension, toExtension, text);
  }

  isExtensionOnline(extension: string) {
    return this.byExtension.has(extension) || this.localSinks.has(extension) || this.extensions.get(extension)?.online === 1;
  }

  /**
   * True only when the extension has a LIVE WebSocket right now. The DB `online`
   * flag is set by the adapter's REST register call BEFORE its socket connects,
   * so anything that fans out events (and the AgentRunner's spawn-wait) must use
   * this instead of isExtensionOnline — or it fires into a socket that isn't
   * there yet and the message is lost.
   */
  hasLiveConnection(extension: string) {
    return this.byExtension.has(extension) || this.localSinks.has(extension);
  }

  async waitForCallState(callId: string, states: CallRecord["state"][], timeoutMs: number) {
    const current = this.calls.get(callId);
    if (current && states.includes(current.state)) return { state: current.state, call: current };
    return new Promise<{ state: CallRecord["state"] | "timeout"; call?: CallRecord }>((resolve) => {
      const waiter: CallWaiter = {
        states: new Set(states),
        resolve,
        timeout: setTimeout(() => {
          this.removeCallWaiter(callId, waiter);
          resolve({ state: "timeout", call: this.calls.get(callId) });
        }, timeoutMs)
      };
      if (!this.callWaiters.has(callId)) this.callWaiters.set(callId, new Set());
      this.callWaiters.get(callId)!.add(waiter);
    });
  }

  async waitForNextTranscript(callId: string, fromExtension: string | undefined, timeoutMs: number) {
    return new Promise<TranscriptWaitResult | undefined>((resolve) => {
      const waiter: TranscriptWaiter = {
        fromExtension,
        resolve,
        timeout: setTimeout(() => {
          this.removeTranscriptWaiter(callId, waiter);
          resolve(undefined);
        }, timeoutMs)
      };
      if (!this.transcriptWaiters.has(callId)) this.transcriptWaiters.set(callId, new Set());
      this.transcriptWaiters.get(callId)!.add(waiter);
    });
  }

  setCallState(callId: string, state: CallRecord["state"], actorExtension?: string, metadata: unknown = {}) {
    const call = this.calls.setState(callId, state, actorExtension, metadata);
    this.emitCallState(call);
    this.sendToCall(callId, { type: "call_state", callId, state, call });
    return call;
  }

  timeoutCall(callId: string, reason = "timeout") {
    const call = this.calls.timeout(callId, reason);
    this.emitCallState(call);
    this.sendToCall(callId, { type: "call_timeout", call });
    return call;
  }

  failCall(callId: string, reason = "failed") {
    const call = this.calls.fail(callId, reason);
    this.emitCallState(call);
    this.sendToCall(callId, { type: "call_failed", call });
    return call;
  }

  notifyNewMessage(message: MessageRow) {
    // Outbound observers (e.g. SMS) see every delivered message; never let one throw.
    try {
      this.outboundMessageHook?.(message);
    } catch {
      /* ignore — message delivery must not depend on observers */
    }
    const members = this.messages.threadMembers(message.thread_id);
    if (members.length > 1) {
      // Real group chat. Devices see EVERYTHING (one shared conversation), but
      // agents are ROUTED like a war-room call: only the agents the message
      // names (or @'s) take a turn — unaddressed user messages go to the lead,
      // "everyone" fans out, and an AGENT's message reaches only agents it
      // explicitly names (controlled relay: "Claude, tell Codex X" works,
      // capped by MAX_AGENT_CHAIN so two agents can't ping-pong forever).
      // Un-routed agents are receipt-stamped so reconnect replay never makes
      // them answer a message that deliberately skipped them — they still see
      // the full conversation via thread history whenever they ARE addressed.
      const agentMembers = members
        .filter((m) => this.extensions.get(m)?.owner_type === "agent")
        .map((m) => ({ extension: m, name: this.extensions.get(m)?.name ?? m }));
      const fromIsAgent = this.extensions.get(message.from_extension)?.owner_type === "agent";
      const agentTargets = new Set(
        selectGroupTextTargets({
          body: message.body,
          fromExtension: message.from_extension,
          fromIsAgent,
          agents: agentMembers,
          consecutiveAgentMessages: this.messages.consecutiveAgentTail(message.thread_id, message.id),
          relayDisabled: process.env.AGENT_RELAY_DISABLED === "true"
        })
      );
      let anyOnline = false;
      for (const member of members) {
        if (member === message.from_extension) continue;
        const isAgent = this.extensions.get(member)?.owner_type === "agent";
        if (isAgent && !agentTargets.has(member)) {
          this.messages.markDeliveredTo(message.id, member);
          continue;
        }
        if (this.byExtension.has(member)) {
          anyOnline = true;
          this.messages.markDeliveredTo(message.id, member);
        } else if (isAgent) {
          // Targeted but offline (e.g. reaped): spawn it — on connect the
          // un-stamped message replays and it takes its turn.
          void this.ensureAgentOnline(member);
        }
        this.sendToExtension(member, { type: "message_new", message });
      }
      this.sendToExtension(message.from_extension, { type: "message_updated", message });
      return anyOnline;
    }
    const online = this.byExtension.has(message.to_extension);
    this.sendToExtension(message.to_extension, { type: "message_new", message });
    this.sendToExtension(message.from_extension, { type: "message_updated", message });
    if (online) {
      const updated = this.messages.markDelivered(message.id);
      if (updated) this.sendToExtension(updated.from_extension, { type: "message_updated", message: updated });
    }
    return online;
  }

  /**
   * Turn routing for multi-party calls (911 war room / conferences), invoked by
   * the AudioGateway after STT. Implements:
   *  - voice-command KICK ("kick codex"): remove that agent from the call,
   *    promote a new lead if needed, end the call when no agents remain
   *  - LEAD-LISTENS-FIRST: unaddressed turns go only to the lead; named agents
   *    get addressed turns; "everyone" fans out to all.
   */
  async routeMultiPartyTurn(input: { callId: string; fromExtension: string; text: string; transcript: unknown; sessionId?: string }): Promise<void> {
    const { callId, fromExtension, text, transcript, sessionId } = input;
    const agentExts = this.calls.agentParticipantExtensions(callId);
    const agents = agentExts.map((ext) => ({ extension: ext, name: this.extensions.get(ext)?.name ?? ext }));
    // Keep EVERY participant alive for the whole call — a silent non-lead agent
    // must not be idle-reaped mid-conference just because it hasn't had a turn.
    for (const a of agents) this.agentRunner?.markActive(a.extension);

    // Voice-command kick — only the user (the call's creator) can kick, and only
    // while more than one agent remains in the room.
    const kick = parseKickCommand(text, agents);
    const call = this.calls.get(callId);
    if (kick && call && fromExtension === call.from_extension) {
      this.calls.removeParticipant(callId, kick.target.extension);
      // Tell just that agent its call is over; its adapter kills the CLI child.
      this.sendToExtension(kick.target.extension, { type: "call_end", callId, call: this.calls.get(callId), reason: "kicked" });
      const remaining = this.calls.agentParticipantExtensions(callId);
      if (remaining.length === 0) {
        // Last agent kicked — nobody left to talk to, hang up cleanly.
        const ended = this.calls.end(callId, fromExtension, "all_agents_kicked");
        this.emitCallState(ended);
        this.sendToCall(callId, { type: "call_end", call: ended });
        return;
      }
      if (this.callLeads.get(callId) === kick.target.extension) {
        this.callLeads.set(callId, remaining[0]);
      }
      this.sendToExtension(fromExtension, { type: "conference_roster", callId, members: remaining, kicked: kick.target.extension });
      // Spoken confirmation, queued through the same per-call speak chain so it
      // never talks over an in-flight agent reply.
      const confirmation = `${kick.target.name} has left the call.`;
      const prior = this.callSpeakChains.get(callId) ?? Promise.resolve();
      const run = prior.catch(() => {}).then(async () => {
        await this.audioProvider().synthesizeForCall(callId, call.to_extension, fromExtension, confirmation);
        await sleepMs(estimateSpeechMs(confirmation));
      });
      this.callSpeakChains.set(callId, run.catch(() => {}));
      await run;
      return; // a kick command is not a conversational turn — don't forward it
    }

    // Lead-listens-first target selection.
    const lead = this.callLeads.get(callId) ?? agents[0]?.extension ?? null;
    if (lead && !this.callLeads.has(callId)) this.callLeads.set(callId, lead);
    const targets = selectTurnTargets(text, { lead, agents });
    for (const target of targets) {
      this.calls.addMessage(callId, sessionId, fromExtension, target, "user", text, { source: "stt" });
      this.sendToExtension(target, { type: "transcript_final", callId, fromExtension, text, transcript });
      this.sendToExtension(target, { type: "call_message", callId, fromExtension, toExtension: target, content: text, source: "stt" });
    }
  }

  notifyMissedCallFallback(message: MessageRow) {
    const online = this.byExtension.has(message.to_extension);
    this.sendToExtension(message.to_extension, { type: "missed_call_fallback", message });
    this.sendToExtension(message.from_extension, { type: "message_updated", message });
    if (online) {
      const updated = this.messages.markDelivered(message.id);
      if (updated) this.sendToExtension(updated.from_extension, { type: "message_updated", message: updated });
    }
    return online;
  }

  notifyMessageRead(message: MessageRow) {
    this.sendToExtension(message.from_extension, { type: "message_read", message });
    this.sendToExtension(message.to_extension, { type: "message_updated", message });
  }

  notifyMessageReplied(original: MessageRow, reply: MessageRow) {
    this.sendToExtension(original.from_extension, { type: "message_reply", message: original, reply });
    this.sendToExtension(original.to_extension, { type: "message_updated", message: original });
    this.resolveMessageReply(original.id, { replied: true, message: original, reply });
  }

  notifyCallLiveLog(callId: string, message: MessageRow) {
    const call = this.calls.get(callId);
    if (!call) {
      this.sendToExtension(message.to_extension, { type: "call_live_log", callId, message });
      return false;
    }
    this.sendToCall(callId, { type: "call_live_log", callId, message });
    return true;
  }

  waitForMessageReply(messageId: string, timeoutMs: number) {
    return new Promise<{ replied: boolean; message?: MessageRow; reply?: MessageRow; timeout?: boolean }>((resolve) => {
      // A Set per message id: two concurrent waits on the same message (e.g. an
      // in-flight notify_user_and_wait plus a wait_for_message_reply) must BOTH
      // resolve on the real reply. A single slot silently displaced the first
      // waiter, which then falsely reported timeout despite the user replying.
      let waiters = this.messageReplyWaiters.get(messageId);
      if (!waiters) {
        waiters = new Set();
        this.messageReplyWaiters.set(messageId, waiters);
      }
      const set = waiters;
      const waiter: MessageReplyWaiter = {
        resolve,
        timeout: setTimeout(() => {
          set.delete(waiter);
          if (set.size === 0) this.messageReplyWaiters.delete(messageId);
          resolve({ replied: false, timeout: true });
        }, timeoutMs)
      };
      set.add(waiter);
    });
  }

  private resolveMessageReply(messageId: string, result: { replied: boolean; message?: MessageRow; reply?: MessageRow; timeout?: boolean }) {
    const waiters = this.messageReplyWaiters.get(messageId);
    if (!waiters) return;
    this.messageReplyWaiters.delete(messageId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(result);
    }
  }

  flushPendingMessages(extension: string) {
    const pending = this.messages.getPendingForExtension(extension);
    let delivered = 0;
    for (const message of pending) {
      const updated = this.messages.markDelivered(message.id);
      const final = updated ?? message;
      this.sendToExtension(extension, { type: "message_new", message: final });
      this.sendToExtension(final.from_extension, { type: "message_updated", message: final });
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Replay messages an agent missed while offline. Unlike the device flush this
   * only replays strictly-'queued' direct messages (re-sending 'delivered' ones
   * would make the agent answer twice) plus group-thread messages whose
   * delivered_to receipts show this member never got them.
   */
  flushQueuedForAgent(extension: string) {
    let replayed = 0;
    for (const message of this.messages.getQueuedForExtension(extension)) {
      const updated = this.messages.markDelivered(message.id) ?? message;
      this.sendToExtension(extension, { type: "message_new", message: updated });
      this.sendToExtension(updated.from_extension, { type: "message_updated", message: updated });
      replayed += 1;
    }
    for (const message of this.messages.queuedGroupMessagesFor(extension)) {
      this.messages.markDeliveredTo(message.id, extension);
      this.sendToExtension(extension, { type: "message_new", message });
      replayed += 1;
    }
    if (replayed > 0) this.log?.info({ extension, replayed }, "replayed missed messages to agent");
    return replayed;
  }

  private connect(ws: WebSocket, request: IncomingMessage) {
    const id = this.db.id("ws");
    const client: Client = { id, ws, isAlive: true };
    this.clients.set(id, client);
    ws.on("pong", () => { client.isAlive = true; });
    ws.on("message", (data) => {
      this.onMessage(client, data).catch((error) => {
        this.log?.error({ clientId: client.id, error: error instanceof Error ? error.message : String(error) }, "websocket onMessage failed");
      });
    });
    ws.on("close", (code, reason) => this.disconnect(client, code, reason.toString("utf8")));

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    this.log?.info({ clientId: client.id, path: url.pathname, clientType: url.searchParams.get("clientType") }, "websocket connected");
    const queryToken = url.searchParams.get("token") ?? undefined;
    const queryExtension = url.searchParams.get("extension") ?? undefined;
    const headerToken = extractBearer(request.headers.authorization);
    const auth = authenticateToken(this.config, queryToken ?? headerToken, this.db);
    if (auth && queryExtension) {
      this.authenticate(client, { auth, extension: queryExtension, clientType: url.searchParams.get("clientType") ?? auth.role }).catch((error) => {
        const message = error instanceof Error ? error.message : "authentication failed";
        this.log?.warn({ clientId: client.id, extension: queryExtension, error: message }, "websocket upgrade auth failed");
        try {
          this.send(client, { type: "error", code: "auth_failed", message });
        } catch {}
      });
    } else {
      if (auth) client.auth = auth;
      if (queryToken || headerToken) this.log?.warn({ clientId: client.id, extension: queryExtension }, "websocket auth failed during upgrade");
      this.send(client, { type: "hello", requiresAuth: true, protocol: "agent-phone-ws-v1" });
    }
  }

  private disconnect(client: Client, code?: number, reason?: string) {
    this.log?.info({ clientId: client.id, extension: client.extension, code, reason }, "websocket closed");
    this.clients.delete(client.id);
    if (client.extension) {
      const set = this.byExtension.get(client.extension);
      set?.delete(client.id);
      if (!set || set.size === 0) {
        this.byExtension.delete(client.extension);
        this.extensions.setPresence(client.extension, false);
        // End any non-terminal calls this extension was part of so the other
        // side doesn't get stuck busy=1 forever when a caller/callee drops
        // mid-ring without an explicit hangup.
        for (const callId of this.calls.activeCallsForExtension(client.extension)) {
          try {
            const call = this.calls.end(callId, client.extension, "participant_disconnected");
            this.emitCallState(call);
            this.sendToCall(call.id, { type: "call_end", call });
          } catch (error) {
            this.log?.warn({ callId, error: error instanceof Error ? error.message : String(error) }, "failed to end call on disconnect");
          }
        }
      }
    }
  }

  private async onMessage(client: Client, data: unknown) {
    try {
      const event = parseJsonMessage(data);
      // ANY frame from an agent adapter counts as activity — without this, the
      // idle reaper only saw INBOUND texts/dials, so an agent grinding through a
      // long turn (its keepalives, call messages, presence) looked idle and got
      // SIGTERM'd mid-work, silently losing the reply.
      if (client.auth?.role === "agent" && client.extension) {
        this.agentRunner?.markActive(client.extension);
      }
      switch (event.type) {
        case "auth": {
          const parsed = AuthEventSchema.parse(event);
          const auth = authenticateToken(this.config, parsed.token, this.db);
          if (!auth) {
            this.log?.warn({ clientId: client.id, extension: parsed.extension }, "websocket auth failure");
            throw new Error("unauthorized");
          }
          await this.authenticate(client, { auth, extension: parsed.extension, clientType: parsed.clientType, agentId: parsed.agentId, name: parsed.name });
          return;
        }
        case "agent_hello":
          await this.handleAgentHello(client, event);
          return;
        case "ping":
          this.send(client, { type: "pong", time: this.db.now() });
          return;
        default:
          this.assertAuthenticated(client);
      }

      switch (event.type) {
        case "presence_update":
          this.handlePresence(client, event);
          break;
        case "dial":
          await this.handleDial(event);
          break;
        case "call_accept":
          this.handleAccept(client, event);
          break;
        case "call_reject":
          this.handleReject(client, event);
          break;
        case "call_end":
          this.handleEnd(client, event);
          break;
        case "screening_take_over":
          await this.handleScreeningCommand(client, event, "take_over");
          break;
        case "screening_end":
          await this.handleScreeningCommand(client, event, "end");
          break;
        case "call_message":
          await this.handleCallMessage(event);
          break;
        case "audio_start":
          this.handleAudioStart(event);
          break;
        case "audio_chunk":
          this.handleAudioChunk(event);
          break;
        case "audio_end":
          await this.handleAudioEnd(event);
          break;
        case "memory_query":
          this.handleMemoryQuery(client, event);
          break;
        case "approval_response":
          this.handleApprovalResponse(event);
          break;
        case "agent_status":
          this.handleAgentStatus(event);
          break;
        case "device_message_ack":
          this.handleDeviceMessageAck(event);
          break;
        case "device_message_read":
          this.handleDeviceMessageRead(event);
          break;
        case "device_message_reply":
          this.handleDeviceMessageReply(event);
          break;
        case "webrtc_offer":
          this.send(client, { type: "error", code: "webrtc_not_enabled", message: "Use WebSocket push-to-talk audio events in this build." });
          break;
        default:
          this.send(client, { type: "error", code: "unknown_event", message: `Unhandled event ${String(event.type)}` });
      }
    } catch (error) {
      this.log?.warn(
        { clientId: client.id, extension: client.extension, error: error instanceof Error ? error.message : "websocket_error" },
        "websocket message rejected"
      );
      this.send(client, { type: "error", message: error instanceof Error ? error.message : "websocket_error" });
    }
  }

  private async authenticate(
    client: Client,
    value: { auth: AuthContext; extension: string; clientType: string; agentId?: string; name?: string }
  ) {
    const extension = this.extensions.get(value.extension);
    if (!extension) throw new Error(`extension ${value.extension} is not registered`);
    if (value.auth.role === "agent" && extension.owner_type !== "agent") throw new Error("agent token can only attach to agent extensions");
    if (value.auth.role === "device" && !["device", "user"].includes(extension.owner_type)) throw new Error("device token can only attach to device/user extensions");
    // Per-agent tokens carry a bound extension scope; reject any attempt to
    // attach to a different extension than the one the token was issued for.
    if (value.auth.boundExtension && value.auth.boundExtension !== value.extension) {
      throw new Error(`token is bound to extension ${value.auth.boundExtension}, refusing ${value.extension}`);
    }
    client.auth = value.auth;
    client.extension = value.extension;
    client.clientType = value.clientType;
    // An AGENT extension must have exactly one live adapter: if two adapters are
    // connected, a single user turn gets answered twice (two independent Codex
    // runs → two different replies). When a new adapter connects for an agent
    // extension, evict the prior one(s).
    //
    // DEVICE/USER extensions are the opposite — the phone legitimately runs both
    // an in-app socket and a foreground-service socket on ext 100, so those are
    // kept (a Set); evicting them made the two fight and reconnect-loop.
    if (value.auth.role === "agent") {
      const existing = this.byExtension.get(value.extension);
      if (existing) {
        for (const oldId of [...existing]) {
          if (oldId === client.id) continue;
          const old = this.clients.get(oldId);
          if (old) {
            try { old.ws.close(4001, "replaced by newer adapter"); } catch { /* already closing */ }
            this.clients.delete(oldId);
          }
          existing.delete(oldId);
        }
      }
    }
    if (!this.byExtension.has(value.extension)) this.byExtension.set(value.extension, new Set());
    this.byExtension.get(value.extension)!.add(client.id);
    this.extensions.setPresence(value.extension, true);
    if (value.auth.role === "agent" && value.agentId) {
      this.agents.heartbeat(value.agentId, "online", value.name ? `Connected as ${value.name}` : undefined);
    }
    this.log?.info({ clientId: client.id, extension: value.extension, role: value.auth.role, clientType: value.clientType }, "websocket auth success");
    this.log?.info({ clientId: client.id, extension: value.extension }, "websocket extension registered");
    this.log?.info({ clientId: client.id, extension: value.extension, ownerType: extension.owner_type }, `${extension.owner_type === "agent" ? "agent" : "user"} connected`);
    this.db.audit("websocket.auth", { actor: value.auth.tokenLabel, target: value.extension });
    this.send(client, {
      type: "hello",
      extension: value.extension,
      role: value.auth.role,
      protocol: "agent-phone-ws-v1",
      supportedEvents: [
        "auth",
        "hello",
        "presence_update",
        "dial",
        "incoming_call",
        "call_accept",
        "call_reject",
        "call_end",
        "call_message",
        "call_live_log",
        "audio_start",
        "audio_chunk",
        "audio_end",
        "transcript_partial",
        "transcript_final",
        "tts_start",
        "tts_chunk",
        "tts_end",
        "agent_status",
        "session_update",
        "approval_request",
        "approval_response",
        "agent_hello",
        "memory_query",
        "memory_result",
        "message_new",
        "message_updated",
        "message_read",
        "message_reply",
        "missed_call_fallback",
        "device_message_ack",
        "device_message_read",
        "device_message_reply",
        "screening_started",
        "screening_update",
        "screening_ended",
        "screening_take_over",
        "screening_end",
        "error",
        "ping",
        "pong"
      ]
    });
    if (value.auth.role === "device" || value.auth.role === "admin") {
      try {
        this.flushPendingMessages(value.extension);
      } catch (error) {
        this.log?.warn({ extension: value.extension, error: error instanceof Error ? error.message : "flush_failed" }, "message flush failed");
      }
    }
    if (value.auth.role === "agent") {
      // Replay anything this agent missed while it had no live socket — a slow
      // spawn, a reaped adapter, or a remote connector that was down. Without
      // this, a group/direct message fanned out during the gap is lost forever.
      try {
        this.flushQueuedForAgent(value.extension);
      } catch (error) {
        this.log?.warn({ extension: value.extension, error: error instanceof Error ? error.message : "flush_failed" }, "agent message replay failed");
      }
    }
  }

  private handlePresence(client: Client, event: unknown) {
    const parsed = PresenceUpdateSchema.parse(event);
    if (client.extension !== parsed.extension && client.auth?.role !== "admin") throw new Error("cannot update presence for another extension");
    this.extensions.setPresence(parsed.extension, parsed.online, parsed.currentSessionId ?? null);
    if (client.auth?.role === "agent") {
      const agent = this.agents.getByExtension(parsed.extension);
      if (agent) this.agents.updateStatus(agent.id, parsed.status ?? (parsed.online ? "online" : "offline"), parsed.currentTask, parsed.currentSessionId ?? undefined);
    }
    this.broadcast({ type: "presence_update", extension: parsed.extension, online: parsed.online, currentSessionId: parsed.currentSessionId ?? null });
  }

  private async handleDial(event: unknown) {
    const parsed = DialEventSchema.parse(event);

    // War zone: dialing 911 is a RED ALERT — open a multi-party war-room CALL and
    // pull every ONLINE agent into it (offline agents are not texted). The user is
    // placed straight into the active call; each agent joins and talks.
    if (parsed.toExtension === RED_ALERT_EXTENSION) {
      const result = await this.warRoom.triggerRedAlertCall({ fromExtension: parsed.fromExtension });
      this.sendToExtension(parsed.fromExtension, { type: "red_alert_ack", ...result });
      return;
    }

    // Group extensions (900 broadcast, 902 conference) have no socket and can
    // never accept — a direct dial used to ring forever AND permanently mark
    // the group busy (CallService.dial never treats groups as offline). Reject
    // with a clear failure instead. 911 is handled above; conferences are
    // started via POST /api/conference.
    const dialTarget = this.extensions.get(parsed.toExtension);
    if (dialTarget?.owner_type === "group") {
      this.sendToExtension(parsed.fromExtension, {
        type: "call_failed",
        reason: "cannot_direct_dial_group",
        message: `${dialTarget.name} is a group extension — dial 911 for the war room or start a conference from the new-chat screen.`
      });
      return;
    }

    // Universal on-demand agent calling: if the dial target is a configured
    // agent that isn't currently online, auto-spawn its adapter before placing
    // the call so the dial doesn't immediately become "missed".
    if (this.agentRunner) {
      this.agentRunner.markActive(parsed.toExtension); // dialing an agent counts as activity
      const agentCfg = this.agentRunner.lookup(parsed.toExtension);
      if (agentCfg && !this.isExtensionOnline(parsed.toExtension)) {
        const result = await this.agentRunner.ensureRunning(parsed.toExtension);
        if (!result.ok) {
          this.log?.warn(
            { extension: parsed.toExtension, error: result.error },
            "agent auto-spawn failed; surfacing call_failed to caller"
          );
          // Tell the caller in-call that the agent is unreachable.
          this.sendToExtension(parsed.fromExtension, {
            type: "call_failed",
            toExtension: parsed.toExtension,
            reason: "agent_unavailable",
            message: result.error
          });
          // And drop a text fallback so they have a record + can retry.
          try {
            const fallback = this.messages.createMessage({
              from_extension: parsed.toExtension,
              to_extension: parsed.fromExtension,
              from_type: "agent",
              to_type: "device",
              title: `${agentCfg.name} is unavailable`,
              body: result.error,
              priority: "urgent",
              requires_response: false,
              response_options: [],
              metadata: { kind: "agent_unavailable", agentId: agentCfg.agentId }
            });
            this.notifyNewMessage(fallback);
          } catch (error) {
            this.log?.warn({ error: error instanceof Error ? error.message : "fallback_failed" }, "agent unavailable fallback failed");
          }
          return;
        }
      }
    }

    // The DB `online` flag can lag the live socket (e.g. presence wasn't
    // re-asserted after a previous call ended). If the target actually has a
    // live connection right now, sync the flag so calls.dial() doesn't wrongly
    // mark the call "missed / target_offline" while the agent is reachable.
    if (this.byExtension.has(parsed.toExtension) && this.extensions.get(parsed.toExtension)?.online !== 1) {
      this.extensions.setPresence(parsed.toExtension, true);
    }

    const call = this.calls.dial(parsed);
    this.notifyIncomingCall(call);
  }

  private handleAccept(client: Client, event: unknown) {
    const parsed = CallIdEventSchema.parse(event);
    this.acceptCall(parsed.callId, parsed.extension ?? client.extension ?? "");
  }

  /** Take-over / end buttons from the user's device during call screening. */
  private async handleScreeningCommand(client: Client, event: unknown, action: "take_over" | "end") {
    const parsed = CallIdEventSchema.parse(event);
    if (!client.auth || !["device", "admin"].includes(client.auth.role)) {
      throw new Error("screening commands require a device or admin connection");
    }
    if (!this.screeningController) throw new Error("screening_unavailable");
    if (action === "take_over") {
      await this.screeningController.takeOver(parsed.callId);
    } else {
      this.screeningController.end(parsed.callId);
    }
  }

  /** Accept a call on behalf of an extension (WS clients and local sinks alike). */
  acceptCall(callId: string, extension: string) {
    const call = this.calls.accept(callId, extension);
    this.emitCallState(call);
    this.sendToCall(call.id, { type: "call_accept", call });
    this.sendToCall(call.id, { type: "session_update", callId: call.id, state: call.state, sessionId: call.session_id });
    return call;
  }

  private handleReject(client: Client, event: unknown) {
    const parsed = CallIdEventSchema.parse(event);
    const call = this.calls.reject(parsed.callId, parsed.extension ?? client.extension ?? "", parsed.reason);
    this.emitCallState(call);
    this.sendToCall(call.id, { type: "call_reject", call });
  }

  private handleEnd(client: Client, event: unknown) {
    const parsed = CallIdEventSchema.parse(event);
    this.endCall(parsed.callId, parsed.extension ?? client.extension ?? "", parsed.reason);
  }

  /** End a call on behalf of an extension (WS clients and local sinks alike). */
  endCall(callId: string, extension: string, reason?: string) {
    const call = this.calls.end(callId, extension, reason);
    this.emitCallState(call);
    this.sendToCall(call.id, { type: "call_end", call });
    return call;
  }

  private async handleCallMessage(event: unknown) {
    const parsed = CallMessageEventSchema.parse(event);
    const call = this.calls.get(parsed.callId);
    if (!call) throw new Error("call not found");
    const toExtension = parsed.toExtension ?? (call.from_extension === parsed.fromExtension ? call.to_extension : call.from_extension);
    const target = this.extensions.get(toExtension);
    const willSynthesize = Boolean(parsed.synthesize) && !!target && ["device", "user"].includes(target.owner_type);
    // Avoid a double-write: synthesizeForCall() persists the message itself (it
    // needs the row id for the TTS messageId). Only store here for the plain,
    // non-synthesized text path.
    if (!willSynthesize) {
      this.calls.addMessage(parsed.callId, call.session_id ?? undefined, parsed.fromExtension, toExtension, "text", parsed.content, { source: "websocket" });
    }
    this.sendToExtension(toExtension, {
      type: "call_message",
      callId: parsed.callId,
      fromExtension: parsed.fromExtension,
      toExtension,
      content: parsed.content
    });
    if (willSynthesize) {
      // Serialize TTS per call: queue behind any in-flight synthesis so war-room
      // agents take turns. For a normal 1:1 call there's only one speaker, so this
      // is just a passthrough.
      const prior = this.callSpeakChains.get(parsed.callId) ?? Promise.resolve();
      const run = prior.catch(() => {}).then(async () => {
        this.setCallState(parsed.callId, "speaking", parsed.fromExtension);
        try {
          await this.audioProvider().synthesizeForCall(parsed.callId, parsed.fromExtension, toExtension, parsed.content);
          // synthesizeForCall resolves when the audio finishes STREAMING, but the
          // phone buffers the utterance and only starts PLAYING it at tts_end. So
          // hold the floor for the estimated spoken duration — otherwise the next
          // war-room agent starts a beat later and cuts this one off mid-sentence.
          await sleepMs(estimateSpeechMs(parsed.content));
        } catch (error) {
          // A mid-stream TTS failure used to leave the call stuck in "speaking"
          // forever: the phone had tts_start + partial chunks but never tts_end,
          // so its buffer never played and nobody was told. Surface the error to
          // the listener (the app's audio_error handler clears the dangling TTS
          // buffer) and fall through to the state reset below.
          const message = error instanceof Error ? error.message : "tts_synthesis_failed";
          this.log?.warn({ callId: parsed.callId, error: message }, "agent TTS synthesis failed mid-call");
          this.sendToExtension(toExtension, {
            type: "audio_error",
            callId: parsed.callId,
            fromExtension: parsed.fromExtension,
            // Utterance-scoped: the phone clears ONLY this message's buffer.
            // Without it the handler falls back to clearTtsForCall, which cuts
            // off other agents' queued/playing speech in a war room.
            messageId: (error as { ttsMessageId?: string }).ttsMessageId,
            code: "tts_synthesis_failed",
            message
          });
        }
        // Only advertise waiting_for_user if the call is still in the "speaking"
        // state WE set above — if the user already replied during the hold, the
        // call has moved on (listening/transcribing/agent_thinking) and writing
        // waiting_for_user now would clobber the live state. Terminal states are
        // never "speaking", so this also covers calls that ended mid-utterance.
        const current = this.calls.get(parsed.callId);
        if (current && current.state === "speaking") {
          this.setCallState(parsed.callId, "waiting_for_user", parsed.fromExtension);
        }
      });
      const guarded = run.catch(() => {});
      this.callSpeakChains.set(parsed.callId, guarded);
      await run;
    }
  }

  private handleAudioStart(event: unknown) {
    const parsed = AudioStartEventSchema.parse(event);
    this.ingestAudioStart(parsed.callId, parsed.fromExtension, parsed.audioFormat, parsed.sampleRate, parsed.channels, parsed.toExtension);
  }

  private handleAudioChunk(event: unknown) {
    const parsed = AudioChunkEventSchema.parse(event);
    this.ingestAudioChunk(parsed.callId, parsed.fromExtension, Buffer.from(parsed.audioBase64, "base64"));
  }

  private async handleAudioEnd(event: unknown) {
    const parsed = CallIdEventSchema.parse(event);
    await this.ingestAudioEnd(parsed.callId, parsed.fromExtension ?? parsed.extension ?? "");
  }

  /** Begin one spoken turn for an extension (WS clients and local sinks alike). */
  ingestAudioStart(callId: string, fromExtension: string, audioFormat?: string, sampleRate?: number, channels?: number, toExtension?: string) {
    this.setCallState(callId, "listening", fromExtension);
    this.audioProvider().startAudio(callId, fromExtension, audioFormat, sampleRate, channels, toExtension);
  }

  ingestAudioChunk(callId: string, fromExtension: string, audio: Buffer) {
    this.audioProvider().appendAudio(callId, fromExtension, audio);
  }

  /** Close the turn: runs STT, broadcasts transcript_final, advances call state. */
  async ingestAudioEnd(callId: string, fromExtension: string) {
    this.setCallState(callId, "transcribing", fromExtension);
    const result = await this.audioProvider().endAudio(callId, fromExtension);
    const current = this.calls.get(callId);
    if (result.ok) {
      // The turn itself may have terminated the call (e.g. a voice "kick" that
      // removed the last agent) — don't resurrect an ended call to "thinking".
      if (current && !TERMINAL_CALL_STATES.has(current.state)) {
        this.setCallState(callId, "agent_thinking", fromExtension);
      }
    } else if (current && current.state === "transcribing") {
      // A failed turn on a SURVIVING call (multi-party STT error) must not
      // strand the state machine in 'transcribing' — recover to listening.
      this.setCallState(callId, "waiting_for_user", fromExtension);
    }
    return result;
  }

  private async handleAgentHello(client: Client, event: unknown) {
    const parsed = AgentHelloSchema.parse(event);
    const auth = client.auth ?? authenticateToken(this.config, parsed.token, this.db);
    if (!auth || !["agent", "admin"].includes(auth.role)) {
      this.log?.warn({ clientId: client.id, agentId: parsed.agentId, extension: parsed.extension }, "websocket agent hello auth failure");
      throw new Error("unauthorized");
    }
    let agent = this.agents.get(parsed.agentId);
    if (!agent) {
      agent = this.agents.onboard({
        agentId: parsed.agentId,
        name: parsed.name ?? parsed.agentId,
        adapterType: parsed.adapterType ?? "generic",
        requestedExtension: parsed.extension,
        capabilities: parsed.capabilities,
        currentTask: parsed.currentTask
      });
    }
    await this.authenticate(client, {
      auth,
      extension: parsed.extension ?? agent.extension,
      clientType: "agent",
      agentId: parsed.agentId,
      name: parsed.name
    });
    const updated = this.agents.heartbeat(parsed.agentId, "online", parsed.currentTask, parsed.sessionId);
    this.broadcast({ type: "agent_status", agent: updated });
  }

  private handleMemoryQuery(client: Client, event: Record<string, unknown>) {
    const query = String(event.query ?? "");
    const limit = Number(event.limit ?? 10);
    const results = this.memory.searchMemory(query, limit);
    this.send(client, { type: "memory_result", query, results });
  }

  private handleApprovalResponse(event: Record<string, unknown>) {
    const approvalId = String(event.approvalId ?? "");
    const decision = String(event.decision ?? "");
    const response = String(event.response ?? decision);
    const approval = decision === "approved" ? this.approvals.approve(approvalId, response) : this.approvals.deny(approvalId, response);
    this.broadcast({ type: "approval_response", approval });
  }

  private handleAgentStatus(event: Record<string, unknown>) {
    const agentId = String(event.agentId ?? "");
    const status = String(event.status ?? "online");
    const currentTask = event.currentTask ? String(event.currentTask) : undefined;
    const sessionId = event.sessionId ? String(event.sessionId) : undefined;
    const agent = this.agents.updateStatus(agentId, status, currentTask, sessionId);
    this.broadcast({ type: "agent_status", agent });
  }

  private handleDeviceMessageAck(event: Record<string, unknown>) {
    const id = String(event.messageId ?? event.id ?? "");
    if (!id) return;
    const message = this.messages.markDelivered(id);
    if (message) this.sendToExtension(message.from_extension, { type: "message_updated", message });
  }

  private handleDeviceMessageRead(event: Record<string, unknown>) {
    const id = String(event.messageId ?? event.id ?? "");
    if (!id) return;
    const message = this.messages.markRead(id);
    if (message) this.notifyMessageRead(message);
  }

  private handleDeviceMessageReply(event: Record<string, unknown>) {
    const id = String(event.messageId ?? event.id ?? "");
    if (!id) return;
    const responseText = event.responseText ?? event.response_text ?? event.text;
    const selectedOption = event.selectedOption ?? event.selected_option ?? event.option;
    const result = this.messages.replyToMessage(id, {
      response_text: typeof responseText === "string" ? responseText : undefined,
      selected_option: typeof selectedOption === "string" ? selectedOption : undefined
    });
    if (result) this.notifyMessageReplied(result.original, result.reply);
  }

  private assertAuthenticated(client: Client) {
    if (!client.auth || !client.extension) throw new Error("websocket auth required");
  }

  private send(client: Client, event: Record<string, unknown>) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(event));
  }

  private broadcast(event: Record<string, unknown>) {
    for (const client of this.clients.values()) this.send(client, event);
  }

  private emitCallState(call: CallRecord) {
    // Issues #15 / #20: when a call reaches a terminal state, proactively release
    // any transcript waiters still parked on it. Without this their setTimeout
    // handles linger until the (possibly long) timeout fires — a bounded leak
    // (#15) — and any code awaiting a transcript only unblocks via the separate
    // call-state race (#20). Resolving them here makes cleanup immediate and the
    // unblock direct rather than incidental.
    if (TERMINAL_CALL_STATES.has(call.state)) {
      this.clearTranscriptWaiters(call.id);
      this.callSpeakChains.delete(call.id);
      this.callLeads.delete(call.id);
      this.summarizeTerminalCall(call);
    }
    const waiters = this.callWaiters.get(call.id);
    if (!waiters) return;
    for (const waiter of Array.from(waiters)) {
      if (!waiter.states.has(call.state)) continue;
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve({ state: call.state, call });
    }
    if (waiters.size === 0) this.callWaiters.delete(call.id);
  }

  /**
   * Call→context memory (feature: "text the agent, ask it to call you, talk, end
   * the call — the model knows what you talked about, injected into context").
   * When a call ends we summarize its transcript once and append it to the linked
   * session's context, so the agent's next turn (text or call) sees what was said.
   * Best-effort: never blocks or breaks call teardown.
   */
  private summarizeTerminalCall(call: CallRecord) {
    if (this.summarizedCalls.has(call.id)) return;
    this.summarizedCalls.add(call.id);
    try {
      const transcripts = this.calls.getTranscripts(call.id) as unknown[];
      const messages = this.calls.getMessages(call.id) as unknown[];
      if (transcripts.length === 0 && messages.length === 0) return; // nothing was said
      const summary = this.memory.summarizeCall(call.id);
      const peer = call.from_extension === "100" ? call.to_extension : call.from_extension;
      this.memory.storeMemory({
        scope: "call",
        key: `${call.id}:summary`,
        content: summary.content,
        tags: ["agent-phone", "call", "call-summary", `ext:${peer}`]
      });
      if (call.session_id) {
        this.memory.appendSessionEvent(call.session_id, "call_summary", summary.content, { callId: call.id, state: call.state });
      }
    } catch (error) {
      this.log?.warn({ callId: call.id, error: error instanceof Error ? error.message : String(error) }, "call summary on end failed");
    }
  }

  /** Resolve and discard every transcript waiter for a call (terminal cleanup). */
  private clearTranscriptWaiters(callId: string) {
    const waiters = this.transcriptWaiters.get(callId);
    if (!waiters) return;
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(undefined);
    }
    this.transcriptWaiters.delete(callId);
  }

  private observeOutboundEvent(event: Record<string, unknown>) {
    const observedCallId = String((event.callId as string | undefined) ?? (event.call as { id?: string } | undefined)?.id ?? "");
    if (observedCallId) {
      const observer = this.callObservers.get(observedCallId);
      if (observer) {
        try {
          observer(event);
        } catch (error) {
          this.log?.warn(
            { callId: observedCallId, error: error instanceof Error ? error.message : "observer_failed" },
            "call observer failed"
          );
        }
      }
    }
    const type = String(event.type ?? "");
    if (["call_accept", "call_reject", "call_end", "call_timeout", "call_failed", "call_state"].includes(type)) {
      const call = event.call as CallRecord | undefined;
      if (call?.id) this.emitCallState(call);
    }
    if (type !== "transcript_final") return;
    const callId = String(event.callId ?? "");
    const fromExtension = String(event.fromExtension ?? "");
    const text = String(event.text ?? "");
    if (!callId || !fromExtension || !text) return;
    const transcript = event.transcript as { id?: string } | undefined;
    this.emitTranscript({
      callId,
      fromExtension,
      text,
      transcriptId: transcript?.id,
      transcript
    });
  }

  private emitTranscript(result: TranscriptWaitResult) {
    const waiters = this.transcriptWaiters.get(result.callId);
    if (!waiters) return;
    for (const waiter of Array.from(waiters)) {
      if (waiter.fromExtension && waiter.fromExtension !== result.fromExtension) continue;
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
    if (waiters.size === 0) this.transcriptWaiters.delete(result.callId);
  }

  private removeCallWaiter(callId: string, waiter: CallWaiter) {
    const waiters = this.callWaiters.get(callId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.callWaiters.delete(callId);
  }

  private removeTranscriptWaiter(callId: string, waiter: TranscriptWaiter) {
    const waiters = this.transcriptWaiters.get(callId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.transcriptWaiters.delete(callId);
  }
}
