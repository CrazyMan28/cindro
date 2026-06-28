import fs from "node:fs";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { WebSocket } from "ws";
import { connectWs, fetchJson, send, serverUrl, sleep } from "./clientUtil.js";
import { loadAgentsConfig, type AgentConfig } from "../agents/agentsConfig.js";

const execFileAsync = promisify(execFile);

// --------------------------------------------------------------------------
// argv / config
// --------------------------------------------------------------------------

const argv = parseArgs(process.argv.slice(2));
const explicitConfigPath = argv.config ?? process.env.AGENT_PHONE_CONFIG;

let cfg: AgentConfig;
if (explicitConfigPath) {
  // Enrollment-package mode: read a single JSON file that contains either the
  // full EnrollmentPackage or just the connectorConfig slice.
  try {
    const raw = JSON.parse(fs.readFileSync(explicitConfigPath, "utf8")) as Record<string, unknown>;
    const inner = (raw.connectorConfig as Record<string, unknown> | undefined) ?? raw;
    cfg = {
      extension: String(inner.extension ?? ""),
      agentId: String(inner.agentId ?? ""),
      name: String(inner.name ?? "Remote Agent"),
      adapterType: String(inner.adapterType ?? "remote-stdio"),
      mode: (inner.mode as AgentConfig["mode"]) ?? "stdio",
      command: (inner.command as string | null | undefined) ?? null,
      args: Array.isArray(inner.args) ? (inner.args as string[]) : [],
      cwd: (inner.cwd as string | null | undefined) ?? null,
      tmuxSession: (inner.tmuxSession as string | undefined) ?? undefined,
      enabled: true,
      timeoutSeconds: 15,
      memoryTags: Array.isArray(inner.memoryTags) ? (inner.memoryTags as string[]) : ["agent-phone"],
      systemPrompt: String(inner.systemPrompt ?? ""),
      capabilities: Array.isArray(inner.capabilities) ? (inner.capabilities as string[]) : ["calls"]
    };
    // The enrollment package also carries the per-agent token; expose it via
    // env so the default AGENT_TOKEN-based plumbing below picks it up.
    if (inner.token && !process.env.AGENT_TOKEN_OVERRIDE) {
      process.env.AGENT_TOKEN = String(inner.token);
    }
    if (inner.serverUrl && !process.env.API_BASE_URL) {
      process.env.API_BASE_URL = String(inner.serverUrl);
    }
  } catch (error) {
    console.error(`universalAgent: failed to read --config ${explicitConfigPath}: ${(error as Error).message}`);
    process.exit(2);
  }
} else {
  const requestedExt = argv.extension ?? process.env.AGENT_PHONE_EXTENSION;
  if (!requestedExt) {
    console.error("universalAgent: missing --extension, --config, AGENT_PHONE_EXTENSION, or AGENT_PHONE_CONFIG");
    process.exit(2);
  }
  const configFile = loadAgentsConfig();
  const found = configFile.agents.find((a) => a.extension === requestedExt);
  if (!found) {
    console.error(`universalAgent: extension ${requestedExt} not found in agents.config.json`);
    process.exit(2);
  }
  if (!found.enabled) {
    console.error(`universalAgent: agent ${found.agentId} (ext ${found.extension}) is disabled`);
    process.exit(2);
  }
  cfg = found;
}

const token = process.env.AGENT_TOKEN ?? "change-me-agent-token";

// --------------------------------------------------------------------------
// register + connect
// --------------------------------------------------------------------------

await fetchJson("/api/agents/register", token, {
  method: "POST",
  body: JSON.stringify({
    id: cfg.agentId,
    extension: cfg.extension,
    name: cfg.name,
    adapterType: cfg.adapterType,
    capabilities: cfg.capabilities,
    permissions: { needsApprovalForDangerousCommands: true },
    status: "online",
    currentTask: `auto-spawned ${cfg.mode} adapter`
  })
}).catch((error) => console.error(`registration failed: ${error?.message ?? error}`));

const ws = connectWs(token, cfg.extension, "agent");

ws.on("open", () => {
  send(ws, { type: "presence_update", extension: cfg.extension, online: true, status: "online", currentTask: `auto-spawned ${cfg.mode}` });
  console.log(`READY ${cfg.agentId} ext ${cfg.extension} mode ${cfg.mode}`);
});

ws.on("message", (raw) => handleEvent(safeParse(raw.toString())).catch((error) => console.error("event handler error:", error)));

ws.on("close", (code, reason) => {
  console.error(`websocket closed code=${code} reason=${reason?.toString() ?? ""}`);
  process.exit(0);
});

ws.on("error", (error) => console.error(`websocket error: ${error?.message ?? error}`));

// --------------------------------------------------------------------------
// Per-call session state
// --------------------------------------------------------------------------

type CallSession = {
  /** callId for a voice call, or `text:<ext>` for a text conversation. */
  callId: string;
  callerExtension: string;
  /** "call" → replies are spoken; "text" → replies go back as in-app texts. */
  channel: "call" | "text";
  /** thread to reply into for text chats, so the conversation stays coherent. */
  threadId?: string;
  /** true when WE placed the call (callback) — we greet on accept, not on dial. */
  outbound?: boolean;
  /** true when this is a multi-party group chat thread. */
  groupThread?: boolean;
  child?: ChildProcessWithoutNullStreams;
  /** set synchronously before the (async) spawn so a concurrent turn can't double-spawn. */
  spawning?: boolean;
  /** keepalive timer while a turn is in flight (stops the server's idle reaper). */
  keepalive?: ReturnType<typeof setInterval>;
  /** swallow the brain's next speak — war-room joins must be SILENT, but stdio
   *  bridges emit their greeting as an output line that bypasses the ignored
   *  return value (heard live as "Claude here…","Codex here…" pile-ups). */
  muteNextSpeak?: boolean;
  /** true when this call is screening an UNKNOWN caller — the brain runs with
   *  NO tools (talk-only), so a malicious caller can't trigger any action. */
  screening?: boolean;
  turn: number;
  ended: boolean;
};

/**
 * While the CLI brain is working on a turn, ping the server every minute so the
 * idle reaper sees activity. A long agentic turn (>AGENT_IDLE_TIMEOUT_MINUTES)
 * used to look idle — the reaper SIGTERM'd the adapter mid-work and the reply
 * was silently lost. Cleared as soon as the brain produces its next line.
 */
function startTurnKeepalive(session: CallSession) {
  stopTurnKeepalive(session);
  session.keepalive = setInterval(() => {
    if (session.ended) { stopTurnKeepalive(session); return; }
    send(ws, { type: "presence_update", extension: cfg.extension, online: true, status: "online", currentTask: "working on a turn" });
  }, 60_000);
  session.keepalive.unref?.();
}

function stopTurnKeepalive(session: CallSession) {
  if (session.keepalive) {
    clearInterval(session.keepalive);
    session.keepalive = undefined;
  }
}

const sessions = new Map<string, CallSession>();

async function handleEvent(event: Record<string, unknown> | null) {
  if (!event) return;
  const type = event.type as string;
  switch (type) {
    case "incoming_call":
      await onIncomingCall(event);
      break;
    case "call_message":
      await onCallMessage(event);
      break;
    case "transcript_final":
      await onTranscriptFinal(event);
      break;
    case "dial_result":
      await onOutboundDial(event);
      break;
    case "war_room_join":
      await onWarRoomJoin(event);
      break;
    case "call_accept":
      await onCallAccepted(event);
      break;
    case "message_new":
    case "message_reply":
      await onInboundText(event);
      break;
    case "call_end":
    case "call_reject":
    case "call_timeout":
    case "call_failed":
      await onCallTerminated(event);
      break;
  }
}

async function onIncomingCall(event: Record<string, unknown>) {
  const call = event.call as { id: string; from_extension: string; reason?: string };
  if (!call?.id) return;
  // Dedup: a repeated incoming_call for a call we already track must not replace
  // the session (the old child would be orphaned with a live exit handler).
  if (sessions.has(call.id)) return;
  console.log(`incoming_call ${call.id} from ${call.from_extension}`);

  // A screening call carries a reason starting with "SCREENING" (set by the
  // Twilio bridge for unknown callers). Those run the brain with NO tools.
  const screening = (call.reason ?? "").startsWith("SCREENING");
  const session: CallSession = { callId: call.id, callerExtension: call.from_extension, channel: "call", screening, turn: 0, ended: false };
  sessions.set(call.id, session);

  // Accept the call right away so audio can flow.
  send(ws, { type: "call_accept", callId: call.id, extension: cfg.extension });

  // Load context from memory + recent calls so the agent has continuity. The
  // call reason carries per-call instructions (e.g. screening an unknown caller
  // on the user's behalf) — without it the brain doesn't know why it's answering.
  const context = await loadCallContext(call.from_extension);
  const fullContext = call.reason ? `${context}\n\nIncoming call reason: ${call.reason}` : context;
  const greeting = await spawnAgentProcess(cfg, session, fullContext);
  if (greeting) await speak(session, greeting);
}

// WE dialed the user (a callback). Register a call session now so that when they
// answer, transcript_final has somewhere to land. We greet on accept, not here
// (the user hasn't picked up yet).
async function onOutboundDial(event: Record<string, unknown>) {
  const call = event.call as { id?: string; to_extension?: string; from_extension?: string };
  const callId = String(call?.id ?? "");
  if (!callId || sessions.has(callId)) return;
  const peer = String(call?.to_extension ?? "100");
  sessions.set(callId, { callId, callerExtension: peer, channel: "call", outbound: true, turn: 0, ended: false });
  console.log(`outbound call ${callId} to ${peer} ringing`);
}

// The user answered. For a call WE placed, start the agent now so it greets and
// then converses (incoming calls already started in onIncomingCall, so skip).
async function onCallAccepted(event: Record<string, unknown>) {
  const call = event.call as { id?: string; reason?: string };
  const callId = String(call?.id ?? "");
  const session = callId ? sessions.get(callId) : undefined;
  if (!session || !session.outbound || session.child || session.spawning) return;
  console.log(`outbound call ${callId} accepted; starting agent`);
  session.spawning = true;
  let greeting: string | null = null;
  try {
    const context = await loadCallContext(session.callerExtension);
    greeting = await spawnAgentProcess(cfg, session, context);
  } finally {
    session.spawning = false;
  }
  // The agent placed this call with something specific to say (e.g. a report it
  // was asked to deliver) — that travels in the call's `reason`. Speak THAT as the
  // opening so "gather data and call me with a report" actually delivers the
  // report, instead of a regenerated generic greeting. Only fall back to the
  // agent's auto-greeting when the call carried no message.
  const opening = String(call?.reason ?? "").trim();
  const toSay = opening || greeting;
  if (toSay) await speak(session, toSay);
}

// 911 RED ALERT: the server opened a war-room call and is pulling us in. Join the
// room silently (don't greet — every agent joining at once would talk over each
// other) and respond when the user speaks; the server broadcasts the user's turns
// to every agent in the room and serializes our replies so we take turns.
async function onWarRoomJoin(event: Record<string, unknown>) {
  const callId = String(event.callId ?? "");
  const user = String(event.from ?? "100");
  if (!callId || sessions.has(callId)) return;
  // muteNextSpeak ONLY for stdio: those bridges emit an auto-greeting as their
  // first output line. Stub/tmux return their greeting as a (discarded) value
  // and never emit a greeting line — an armed mute would eat their first REAL
  // reply instead.
  const session: CallSession = { callId, callerExtension: user, channel: "call", outbound: true, muteNextSpeak: cfg.mode === "stdio", turn: 0, ended: false };
  sessions.set(callId, session);
  console.log(`war room join ${callId} (silent)`);
  // Start the brain so it's ready for the first spoken turn; ignore its greeting.
  const context = await loadCallContext(user);
  await spawnAgentProcess(cfg, session, context);
}

async function onCallMessage(event: Record<string, unknown>) {
  // Text from the user (Android device) sent during the call.
  const callId = String(event.callId ?? "");
  const fromExtension = String(event.fromExtension ?? "");
  if (fromExtension === cfg.extension) return; // ignore our own echoes
  // The server delivers a spoken turn as BOTH a `transcript_final` (handled in
  // onTranscriptFinal) AND a `call_message` with source "stt". Acting on both
  // ran Codex twice for one thing the caller said — two replies stacking up.
  // Only handle genuinely typed text here; let transcript_final own STT turns.
  if (String(event.source ?? "") === "stt") return;
  const session = sessions.get(callId);
  if (!session) return;
  const text = String(event.content ?? "").trim();
  if (!text) return;
  await forwardUserTurn(session, text);
}

async function onTranscriptFinal(event: Record<string, unknown>) {
  // Spoken audio transcribed by the server's STT pipeline.
  const callId = String(event.callId ?? "");
  const from = String(event.fromExtension ?? "");
  if (from === cfg.extension) return;
  const session = sessions.get(callId);
  if (!session) return;
  const text = String(event.text ?? "").trim();
  if (!text) return;
  await forwardUserTurn(session, text);
}

// A text from the user — either a fresh in-app message to this agent
// (message_new) or a reply to one of our texts (message_reply). Runs the same
// agent brain as a call, but in a "text" session so the reply goes back as an
// in-app text instead of speech. Keyed per user so the conversation has memory.
const handledInboundIds = new Map<string, number>();
function alreadyHandledInbound(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of handledInboundIds) if (now - t > 60_000) handledInboundIds.delete(k);
  if (handledInboundIds.has(id)) return true;
  handledInboundIds.set(id, now);
  return false;
}

async function onInboundText(event: Record<string, unknown>) {
  const source = (event.reply ?? event.message) as Record<string, unknown> | undefined;
  if (!source) return;
  const fromExtension = String(source.from_extension ?? "");
  if (!fromExtension || fromExtension === cfg.extension) return; // ignore our own
  // Another agent's message: only act on it in a GROUP thread. The server
  // routes group messages — an agent-authored one is only delivered to us when
  // it explicitly addresses us ("Claude, tell Codex X" → Codex hears Claude and
  // answers), with a server-side chain cap so agents can't ping-pong forever.
  // Outside groups, agent texts are context only — never take a turn.
  let sourceIsGroup = false;
  try {
    const meta = typeof source.metadata === "string" ? JSON.parse(source.metadata) : (source.metadata ?? {});
    sourceIsGroup = Boolean((meta as Record<string, unknown>)?.group_thread);
  } catch { /* ignore */ }
  if (String(source.from_type ?? "") === "agent" && !sourceIsGroup) return;
  const text = String(source.body ?? source.response_text ?? source.selected_option ?? "").trim();
  if (!text) return;
  // A reply lands as BOTH message_new and message_reply for the same message —
  // handle it once so Codex doesn't run the turn twice.
  const messageId = String(source.id ?? "");
  if (messageId && alreadyHandledInbound(messageId)) return;
  console.log(`inbound text from ${fromExtension}: ${text.slice(0, 80)}`);

  // Key the conversation by THREAD so each chat keeps its own context/history —
  // a new chat is a fresh brain, continuing a chat resumes it. Falls back to the
  // user when a thread id isn't present.
  const threadId = String(source.thread_id ?? "");
  // Detect a group chat from the message metadata so we load the full shared thread
  // (everyone's messages) for context, and reply into that thread.
  let isGroup = false;
  try {
    const meta = typeof source.metadata === "string" ? JSON.parse(source.metadata) : (source.metadata ?? {});
    isGroup = Boolean(meta?.group_thread || (Array.isArray(meta?.group_members) && meta.group_members.length > 1));
  } catch { /* ignore */ }
  const id = threadId ? `text:${threadId}` : `text:${fromExtension}`;
  let session = sessions.get(id);
  if (!session || session.ended) {
    session = { callId: id, callerExtension: fromExtension, channel: "text", threadId: threadId || undefined, groupThread: isGroup, turn: 0, ended: false };
    sessions.set(id, session);
  } else if (isGroup) {
    session.groupThread = true;
  }
  // (Re)spawn the agent process for stdio agents so the turn has somewhere to go.
  // `spawning` is claimed SYNCHRONOUSLY before the await: two texts arriving in
  // the same second for a brand-new thread would otherwise both pass the
  // `!session.child` check (the first is parked on loadCallContext) and spawn
  // TWO CLI children — one orphaned forever, and its exit handler would later
  // tear down the session the live child is serving.
  if (cfg.mode === "stdio" && !session.spawning && (!session.child || session.child.exitCode !== null)) {
    session.spawning = true;
    try {
      const context = await loadCallContext(fromExtension);
      startStdioAgent(cfg, session, context);
    } finally {
      session.spawning = false;
    }
  } else if (cfg.mode === "stdio" && session.spawning) {
    // A spawn is in flight for this session — wait for it so this turn goes to
    // the same child instead of racing it.
    while (session.spawning) await sleep(25);
  }
  await forwardUserTurn(session, text);
}

async function onCallTerminated(event: Record<string, unknown>) {
  const call = (event.call as { id?: string }) ?? {};
  const callId = String(call.id ?? event.callId ?? "");
  const session = callId ? sessions.get(callId) : undefined;
  if (!session || session.ended) return;
  session.ended = true;
  stopTurnKeepalive(session);
  console.log(`call terminated ${callId}`);
  if (session.child && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch {}
  }
  sessions.delete(callId);
  // Write a brief receipt memory so the next call has continuity.
  await storeMemory({
    scope: "call",
    key: callId,
    content: `Call with ${session.callerExtension} ended after ${session.turn} user turn(s).`,
    tags: [...cfg.memoryTags, "receipt"]
  }).catch(() => {});
}

// --------------------------------------------------------------------------
// Per-mode dispatch
// --------------------------------------------------------------------------

async function spawnAgentProcess(cfg: AgentConfig, session: CallSession, context: string): Promise<string | null> {
  switch (cfg.mode) {
    case "stub":
      return runStubGreeting(cfg);
    case "tmux":
      await ensureTmuxSession(cfg);
      return `${cfg.name} attached (tmux session ${tmuxName(cfg)}). Speak or type and I'll relay.`;
    case "stdio":
      return startStdioAgent(cfg, session, context);
  }
}

async function forwardUserTurn(session: CallSession, text: string) {
  session.turn += 1;
  // Failsafe: once a real user turn is in flight, the next speak is an ANSWER.
  // (Covers stdio bridges that never auto-greet — their armed mute would
  // otherwise eat the first genuine reply.)
  session.muteNextSpeak = false;
  switch (cfg.mode) {
    case "stub":
      await speak(session, `Echo: ${text}`);
      if (text.toLowerCase().includes("end")) await endCall(session, "stub end keyword");
      return;
    case "tmux":
      await tmuxSendKeys(cfg, text);
      await sleep(800);
      const pane = await tmuxCapturePane(cfg);
      if (pane) await speak(session, pane.slice(-800));
      return;
    case "stdio":
      if (!session.child || session.child.exitCode !== null) {
        await notify({
          fromExtension: cfg.extension,
          toExtension: session.callerExtension,
          title: `${cfg.name} disconnected`,
          body: "The agent process exited; please redial.",
          priority: "urgent"
        });
        await endCall(session, "agent_process_exited");
        return;
      }
      try {
        const recent = session.groupThread && session.threadId
          ? await loadThreadHistory(session.threadId)
          : await loadConversationHistory(session.callerExtension);
        session.child.stdin.write(JSON.stringify({ kind: "user_turn", text, recent }) + "\n");
        startTurnKeepalive(session);
      } catch (error) {
        await notify({
          fromExtension: cfg.extension,
          toExtension: session.callerExtension,
          title: `${cfg.name} write failed`,
          body: (error as Error)?.message ?? String(error),
          priority: "urgent"
        });
        await endCall(session, "agent_stdin_write_failed");
      }
      return;
  }
}

// --------------------------------------------------------------------------
// stub mode
// --------------------------------------------------------------------------

function runStubGreeting(cfg: AgentConfig): string {
  return `${cfg.name} test responder online. Anything you say will be echoed back. Say "end" to hang up.`;
}

// --------------------------------------------------------------------------
// tmux mode
// --------------------------------------------------------------------------

function tmuxName(cfg: AgentConfig): string {
  return cfg.tmuxSession ?? `agent-phone-${cfg.extension}`;
}

async function ensureTmuxSession(cfg: AgentConfig) {
  const name = tmuxName(cfg);
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
  } catch {
    const cwd = cfg.cwd ?? process.cwd();
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, cfg.command ?? "bash"]);
  }
}

async function tmuxSendKeys(cfg: AgentConfig, text: string) {
  const name = tmuxName(cfg);
  try {
    await execFileAsync("tmux", ["send-keys", "-t", name, text, "Enter"]);
  } catch (error) {
    console.error(`tmux send-keys failed: ${(error as Error).message}`);
  }
}

async function tmuxCapturePane(cfg: AgentConfig): Promise<string> {
  const name = tmuxName(cfg);
  try {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", name, "-S", "-200"]);
    return stdout;
  } catch (error) {
    return `unable to read pane: ${(error as Error).message}`;
  }
}

// --------------------------------------------------------------------------
// stdio mode — spawn the agent's CLI, feed turns as NDJSON, parse responses
// --------------------------------------------------------------------------

function startStdioAgent(cfg: AgentConfig, session: CallSession, context: string): string | null {
  if (!cfg.command) {
    console.error("stdio mode requires a command");
    return null;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(cfg.command, cfg.args, {
      cwd: cfg.cwd ?? process.cwd(),
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    console.error(`stdio spawn failed: ${(error as Error).message}`);
    return null;
  }
  // Belt-and-suspenders: never leak a previous live child when re-spawning.
  if (session.child && session.child.exitCode === null && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  session.child = child;

  // Write the system prompt + context as the very first JSON line so the agent
  // has everything it needs up front. Agents that ignore stdin just print and exit.
  try {
    child.stdin.write(
      JSON.stringify({
        kind: "session_start",
        agentId: cfg.agentId,
        extension: cfg.extension,
        systemPrompt: cfg.systemPrompt,
        memoryTags: cfg.memoryTags,
        callerExtension: session.callerExtension,
        callId: session.callId,
        channel: session.channel,
        screening: session.screening ?? false,
        context
      }) + "\n"
    );
  } catch (error) {
    console.error(`stdio write session_start failed: ${(error as Error).message}`);
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => handleAgentLine(session, line).catch((error) => console.error("agent line error:", error)));
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/).filter(Boolean)) console.error(`[agent-stderr] ${line}`);
  });
  child.on("exit", (code, signal) => {
    console.log(`stdio child exit code=${code} signal=${signal}`);
    // Ownership check: only the session's CURRENT child may tear it down. A
    // stale/replaced child exiting must not clobber the session the live child
    // is serving (or notify the user about a process that was superseded).
    if (session.child !== child) return;
    if (!session.ended && code !== 0) {
      notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} exited`,
        body: `Agent process exited with code ${code ?? "?"}.`,
        priority: "urgent"
      }).catch(() => {});
      if (session.channel === "call") {
        endCall(session, `agent_exit_${code ?? signal ?? "unknown"}`).catch(() => {});
      } else {
        // Text session: just end it so the next inbound text respawns a fresh child.
        session.ended = true;
        stopTurnKeepalive(session);
        sessions.delete(session.callId);
      }
    }
  });
  return null; // greeting comes from the agent's first output line
}

async function handleAgentLine(session: CallSession, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  // Brain produced output — the in-flight turn is done (or streaming); stop the
  // reaper keepalive until the next user turn starts one.
  stopTurnKeepalive(session);
  const parsed = trimmed.startsWith("{") ? safeParse(trimmed) : null;
  if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).action === "string") {
    await applyDirective(session, parsed as Record<string, unknown>);
  } else {
    // Plain text — default behaviour is to speak it in the call.
    await speak(session, trimmed);
  }
}

async function applyDirective(session: CallSession, directive: Record<string, unknown>) {
  const action = String(directive.action);
  switch (action) {
    case "speak": {
      const text = String(directive.text ?? "");
      if (text) await speak(session, text);
      return;
    }
    case "notify": {
      await notify({
        fromExtension: cfg.extension,
        toExtension: String(directive.toExtension ?? session.callerExtension),
        title: String(directive.title ?? `${cfg.name}`),
        body: String(directive.body ?? directive.text ?? ""),
        priority: String(directive.priority ?? "normal"),
        requiresResponse: Boolean(directive.requiresResponse ?? false),
        responseOptions: Array.isArray(directive.responseOptions) ? (directive.responseOptions as string[]) : undefined
      });
      return;
    }
    case "call": {
      // Ring the user (voice) — the agent then drives the live call. Any agent
      // can emit this; Codex also has a phone-call helper.
      await callUser({
        fromExtension: cfg.extension,
        reason: String(directive.reason ?? directive.say ?? directive.body ?? directive.text ?? `${cfg.name} is calling`)
      });
      return;
    }
    case "memory": {
      await storeMemory({
        scope: String(directive.scope ?? "agent"),
        key: String(directive.key ?? `${cfg.agentId}-${Date.now()}`),
        content: String(directive.content ?? directive.text ?? ""),
        tags: Array.isArray(directive.tags) ? (directive.tags as string[]) : cfg.memoryTags
      });
      return;
    }
    case "approve": {
      // Request explicit approval via phone or in-app message.
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: String(directive.title ?? `${cfg.name} needs approval`),
        body: String(directive.question ?? directive.body ?? "Approval required."),
        priority: "urgent",
        requiresResponse: true,
        responseOptions: Array.isArray(directive.options) ? (directive.options as string[]) : ["approve", "deny"]
      });
      return;
    }
    case "callback": {
      const when = String(directive.when ?? "later");
      await storeMemory({
        scope: "callback",
        key: `${cfg.agentId}-callback-${session.callerExtension}`,
        content: `Agent ${cfg.agentId} wants to call ${session.callerExtension} back: ${when}. Reason: ${directive.reason ?? ""}`,
        tags: [...cfg.memoryTags, "callback", "pending"]
      });
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} will call back`,
        body: `Reason: ${directive.reason ?? "(not specified)"} · When: ${when}`,
        priority: "low"
      });
      return;
    }
    case "work": {
      // The agent is doing work; surface it as an in-app FYI so the user can see progress without speaking.
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} working`,
        body: String(directive.description ?? directive.text ?? ""),
        priority: "low"
      });
      return;
    }
    case "end": {
      await endCall(session, String(directive.reason ?? "agent_ended"));
      return;
    }
    default:
      console.error(`unknown directive action: ${action}`);
  }
}

// --------------------------------------------------------------------------
// Outbound helpers — call_message + HTTP API actions
// --------------------------------------------------------------------------

async function speak(session: CallSession, text: string) {
  if (session.ended) return;
  // War-room joins are silent: the bridge's auto-greeting arrives as a normal
  // output line, so swallow exactly one speak after join. User turns only start
  // AFTER the greeting (the bridge reads stdin sequentially), so real replies
  // are never affected.
  if (session.muteNextSpeak) {
    session.muteNextSpeak = false;
    console.log(`muted war-room join greeting: ${text.slice(0, 60)}`);
    return;
  }
  if (session.channel === "text") {
    // No call to speak into — deliver the agent's reply to the user as a text,
    // into the same thread so the chat stays coherent.
    await notify({
      fromExtension: cfg.extension,
      toExtension: session.callerExtension,
      title: cfg.name,
      body: text,
      priority: "normal",
      threadId: session.threadId
    });
    return;
  }
  send(ws, {
    type: "call_message",
    callId: session.callId,
    fromExtension: cfg.extension,
    toExtension: session.callerExtension,
    content: text,
    synthesize: true
  });
}

async function endCall(session: CallSession, reason: string) {
  if (session.ended) return;
  session.ended = true;
  send(ws, { type: "call_end", callId: session.callId, extension: cfg.extension, reason });
}

async function notify(input: {
  fromExtension: string;
  toExtension: string;
  title: string;
  body: string;
  priority: string;
  requiresResponse?: boolean;
  responseOptions?: string[];
  threadId?: string;
}) {
  try {
    // POST through the local MCP-local endpoint so we go through the same
    // pipeline as agent tools (consistent priority/threading/eventing).
    const res = await fetch(new URL("/mcp-local", serverUrl()), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `notify-${Date.now()}`,
        method: "tools/call",
        params: {
          name: input.requiresResponse ? "notify_user_and_wait" : "notify_user",
          arguments: {
            from_extension: input.fromExtension,
            to_extension: input.toExtension,
            title: input.title,
            // The notify_user / notify_user_and_wait tools take "message", not "body".
            message: input.body,
            priority: input.priority,
            requires_response: input.requiresResponse ?? false,
            ...(input.threadId ? { thread_id: input.threadId } : {}),
            ...(input.responseOptions ? { response_options: input.responseOptions } : {})
          }
        }
      })
    });
    if (!res.ok) {
      // A 403 here usually means we were handed a non-loopback API_BASE_URL —
      // surface it loudly instead of silently dropping the reply.
      console.error(`notify rejected: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`notify failed: ${(error as Error).message}`);
  }
}

// Ring the user with call_user (NOT call_user_and_wait). call_user just dials;
// this agent then drives the live conversation itself (onOutboundDial creates the
// session, onCallAccepted greets, transcript_final replies) — a real back-and-forth
// instead of a one-shot say-and-listen.
async function callUser(input: { fromExtension: string; reason: string }) {
  try {
    const res = await fetch(new URL("/mcp-local", serverUrl()), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `call-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "call_user",
          arguments: {
            from_extension: input.fromExtension,
            reason: input.reason
          }
        }
      })
    });
    if (!res.ok) {
      console.error(`callUser rejected: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`callUser failed: ${(error as Error).message}`);
  }
}

async function storeMemory(memory: { scope: string; key: string; content: string; tags: string[] }) {
  try {
    await fetchJson("/api/memory", token, {
      method: "POST",
      body: JSON.stringify(memory)
    });
  } catch (error) {
    console.error(`store memory failed: ${(error as Error).message}`);
  }
}

async function loadCallContext(callerExtension: string): Promise<string> {
  try {
    const memories = await fetchJson<Array<{ key: string; content: string; tags: string }>>(
      `/api/memory/search?q=${encodeURIComponent(cfg.memoryTags[0] ?? "agent-phone")}&limit=10`,
      token
    );
    const myMemories = memories.filter((m) => {
      try {
        const parsed = JSON.parse(m.tags ?? "[]") as string[];
        return parsed.some((t) => cfg.memoryTags.includes(t));
      } catch {
        return false;
      }
    });
    if (myMemories.length === 0) return "(no prior memory for this agent)";
    return myMemories.map((m) => `[${m.key}] ${m.content}`).join("\n").slice(0, 4000);
  } catch (error) {
    return `(could not load memory: ${(error as Error).message})`;
  }
}

// Dynamic cross-channel memory: the recent conversation with this user across BOTH
// in-app texts AND phone calls, loaded fresh each turn so a chat and a call share
// one memory (e.g. "what did I say in the call" works while texting).
async function loadConversationHistory(peerExtension: string): Promise<string> {
  try {
    const data = await fetchJson<{ items: Array<{ channel: string; who: string; text: string }> }>(
      `/api/conversation?agent=${encodeURIComponent(cfg.extension)}&peer=${encodeURIComponent(peerExtension)}&limit=30`,
      token
    );
    if (!data.items?.length) return "";
    return data.items
      .map((i) => `${i.who === "agent" ? "You" : "User"} [${i.channel}]: ${i.text}`)
      .join("\n")
      .slice(-4000);
  } catch {
    return "";
  }
}

// Group chat: load the FULL shared thread (every participant's messages) so each
// agent sees what the others said and it feels like a real group conversation.
async function loadThreadHistory(threadId: string): Promise<string> {
  try {
    const data = await fetchJson<{ messages: Array<{ from_extension: string; body: string }> }>(
      `/api/message-threads/${encodeURIComponent(threadId)}`,
      token
    );
    const msgs = data.messages ?? [];
    if (!msgs.length) return "";
    return (
      "This is a GROUP CHAT with several agents and the user. The latest message was addressed to YOU — reply to the group, speaking to whoever addressed you (the user or another agent). Keep it short. Naming another agent is what DELIVERS your message to them — so to relay something, write it TO that agent with the content included (e.g. \"Codex, the user wants to know how your day's been\"), never just \"done, sent it\". Only name an agent when you need them to respond. Recent messages:\n" +
      msgs
        .map((m) => `${m.from_extension === cfg.extension ? "You" : m.from_extension === "100" ? "User" : `Agent ${m.from_extension}`}: ${m.body}`)
        .join("\n")
        .slice(-4000)
    );
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function safeParse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch { return null; }
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i += 1; } else { out[key] = "true"; }
    }
  }
  return out;
}

// Graceful shutdown — kill any session bridge children (Codex/Claude CLIs) so they
// don't orphan when this connector is reaped for being idle.
function shutdown() {
  for (const s of sessions.values()) {
    try { s.child?.kill("SIGKILL"); } catch { /* already gone */ }
  }
  try { ws.close(); } catch { /* already closing */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
