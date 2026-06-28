#!/usr/bin/env node
// Agent Phone — standalone remote connector
//
// Reads an enrollment package (JSON) and brings the agent online by:
//   1. authenticating to the server WebSocket with the per-agent bearer token
//   2. on incoming_call, accepting and spawning the configured local CLI
//   3. piping transcripts/messages to the CLI's stdin
//   4. parsing CLI stdout for NDJSON directives (speak / notify / memory / etc.)
//
// Usage:
//   node connect.mjs /path/to/agent.json
//   AGENT_PHONE_CONFIG=/path/to/agent.json node connect.mjs
//
// Requires: Node 18+ and the `ws` package installed in the working directory
// (the bootstrap.sh installer takes care of this).

import fs from "node:fs";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

const cfgPath = process.argv[2] ?? process.env.AGENT_PHONE_CONFIG;
if (!cfgPath) {
  console.error("usage: node connect.mjs <agent.json>  (or set AGENT_PHONE_CONFIG)");
  process.exit(2);
}
const enrollment = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const cfg = enrollment.connectorConfig ?? enrollment; // accept full package or just the connector slice
const required = ["extension", "agentId", "name", "token", "serverUrl", "wsUrl"];
for (const key of required) {
  if (!cfg[key]) {
    console.error(`connect.mjs: missing required config field "${key}"`);
    process.exit(2);
  }
}

const mode = cfg.mode ?? "stub";

// --- Connect ---------------------------------------------------------------

const wsUrl = new URL(cfg.wsUrl);
wsUrl.searchParams.set("token", cfg.token);
wsUrl.searchParams.set("extension", cfg.extension);
wsUrl.searchParams.set("clientType", "agent");

console.log(`agent-phone connector: ${cfg.name} (ext ${cfg.extension}, mode ${mode})`);
console.log(`connecting to ${wsUrl.origin}${wsUrl.pathname}`);

// Best-effort registration via HTTP (idempotent; agent_hello on the WS does the same thing).
fetch(`${cfg.serverUrl.replace(/\/$/, "")}/api/agents/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
  body: JSON.stringify({
    id: cfg.agentId,
    extension: cfg.extension,
    name: cfg.name,
    adapterType: cfg.adapterType ?? "remote-stdio",
    capabilities: cfg.capabilities ?? ["calls"],
    permissions: { needsApprovalForDangerousCommands: true },
    status: "online",
    currentTask: `remote connector (${mode})`
  })
}).catch((error) => console.error("register failed:", error?.message ?? error));

// The connector must survive server restarts and network blips — the curl
// onboarding starts it with plain nohup (no supervisor), so exiting on a
// closed socket would leave the remote agent permanently dead until someone
// SSHes in and restarts it. Reconnect with exponential backoff instead.
let ws = null;
let shuttingDown = false;
let reconnectDelayMs = 1000;
const RECONNECT_MAX_MS = 30000;

function connect() {
  ws = new WebSocket(wsUrl.toString());

  ws.on("open", () => {
    reconnectDelayMs = 1000; // healthy again — reset backoff
    send({ type: "presence_update", extension: cfg.extension, online: true, status: "online", currentTask: `remote ${mode}` });
    console.log(`READY agent ${cfg.agentId} ext ${cfg.extension}`);
  });

  ws.on("close", (code, reason) => {
    console.error(`websocket closed code=${code} reason=${reason?.toString?.() ?? ""}`);
    if (shuttingDown) return;
    console.error(`reconnecting in ${Math.round(reconnectDelayMs / 1000)}s`);
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  });
  ws.on("error", (error) => console.error(`websocket error: ${error?.message ?? error}`));
  ws.on("message", (raw) => handleEvent(safeParse(raw.toString())).catch((error) => console.error("event:", error?.message ?? error)));
}
connect();

function send(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(event));
}

// --- Per-call session state ------------------------------------------------

const sessions = new Map();

async function handleEvent(event) {
  if (!event) return;
  switch (event.type) {
    case "incoming_call": return onIncomingCall(event);
    case "call_message": return onCallMessage(event);
    case "transcript_final": return onTranscriptFinal(event);
    case "message_new":
    case "message_reply": return onInboundText(event);
    case "call_end":
    case "call_reject":
    case "call_timeout":
    case "call_failed": return onTerminated(event);
  }
}

// Inbound in-app text (so a remote agent can be TEXTED and join group chats, not
// just called). Mirrors the local universalAgent: ignore our own + other agents'
// messages (no group loops), reply into the same thread.
const handledInbound = new Map();
function alreadyHandledInbound(id) {
  const now = Date.now();
  for (const [k, t] of handledInbound) if (now - t > 60000) handledInbound.delete(k);
  if (handledInbound.has(id)) return true;
  handledInbound.set(id, now);
  return false;
}

async function onInboundText(event) {
  const src = event.reply ?? event.message;
  if (!src) return;
  const from = String(src.from_extension ?? "");
  if (!from || from === cfg.extension) return;
  // Agent-authored messages are only acted on in GROUP threads — the server
  // routes those and only delivers one to us when it addresses us by name,
  // with a server-side chain cap (no agent↔agent ping-pong).
  let srcIsGroup = false;
  try {
    const meta = typeof src.metadata === "string" ? JSON.parse(src.metadata) : (src.metadata ?? {});
    srcIsGroup = Boolean(meta?.group_thread);
  } catch { /* ignore */ }
  if (String(src.from_type ?? "") === "agent" && !srcIsGroup) return;
  const text = String(src.body ?? src.response_text ?? src.selected_option ?? "").trim();
  if (!text) return;
  const id = String(src.id ?? "");
  if (id && alreadyHandledInbound(id)) return;
  const threadId = String(src.thread_id ?? "");
  const sid = threadId ? `text:${threadId}` : `text:${from}`;
  let session = sessions.get(sid);
  if (!session || session.ended) {
    session = { callId: sid, callerExtension: from, channel: "text", threadId: threadId || undefined, ended: false, turn: 0 };
    sessions.set(sid, session);
  }
  // (Re)spawn OUTSIDE the new-session branch — mirrors the local adapter. A
  // live session whose child exited CLEANLY (one-shot CLI, code 0) kept its
  // dead child forever: every later text hit forwardUserTurn's dead-child
  // guard, told the user to "redial" a text thread, and bricked the chat.
  // `spawning` is claimed synchronously so two fast texts can't double-spawn.
  if (mode === "stdio" && !session.spawning && (!session.child || session.child.exitCode !== null)) {
    session.spawning = true;
    try {
      const context = await loadCallContext(from);
      startStdio(session, context);
    } finally {
      session.spawning = false;
    }
  } else if (mode === "stdio" && session.spawning) {
    while (session.spawning) await sleep(25);
  }
  await forwardUserTurn(session, text);
}

async function onIncomingCall(event) {
  const call = event.call;
  if (!call?.id) return;
  console.log(`incoming_call ${call.id} from ${call.from_extension}`);
  const session = { callId: call.id, callerExtension: call.from_extension, ended: false, turn: 0 };
  sessions.set(call.id, session);
  send({ type: "call_accept", callId: call.id, extension: cfg.extension });
  const context = await loadCallContext(call.from_extension);
  const greeting = await openAgentProcess(session, context);
  if (greeting) await speak(session, greeting);
}

async function onCallMessage(event) {
  const callId = String(event.callId ?? "");
  const from = String(event.fromExtension ?? "");
  if (from === cfg.extension) return;
  const text = String(event.content ?? "").trim();
  if (!text) return;
  const session = sessions.get(callId);
  if (!session) return;
  await forwardUserTurn(session, text);
}

async function onTranscriptFinal(event) {
  const callId = String(event.callId ?? "");
  const from = String(event.fromExtension ?? "");
  if (from === cfg.extension) return;
  const text = String(event.text ?? "").trim();
  if (!text) return;
  const session = sessions.get(callId);
  if (!session) return;
  await forwardUserTurn(session, text);
}

async function onTerminated(event) {
  const callId = String(event.call?.id ?? event.callId ?? "");
  const session = callId ? sessions.get(callId) : undefined;
  if (!session || session.ended) return;
  session.ended = true;
  console.log(`call ${callId} terminated`);
  if (session.child && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch {}
  }
  sessions.delete(callId);
  await storeMemory({
    scope: "call",
    key: callId,
    content: `Call with ${session.callerExtension} ended after ${session.turn} user turn(s).`,
    tags: [...(cfg.memoryTags ?? ["agent-phone"]), "receipt"]
  }).catch(() => {});
}

// --- Mode-specific dispatch -----------------------------------------------

async function openAgentProcess(session, context) {
  if (mode === "stub") {
    return `${cfg.name} test responder online. Anything you say will be echoed back. Say "end" to hang up.`;
  }
  if (mode === "tmux") {
    await ensureTmux(cfg);
    return `${cfg.name} attached (tmux session ${tmuxName(cfg)}). Type or speak and I'll relay.`;
  }
  // stdio
  return startStdio(session, context);
}

async function forwardUserTurn(session, text) {
  session.turn += 1;
  if (mode === "stub") {
    await speak(session, `Echo: ${text}`);
    if (session.channel !== "text" && text.toLowerCase().includes("end")) await endCall(session, "stub end keyword");
    return;
  }
  if (mode === "tmux") {
    await tmuxSendKeys(cfg, text);
    await sleep(800);
    const pane = await tmuxCapture(cfg);
    if (pane) await speak(session, pane.slice(-800));
    return;
  }
  // stdio
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
    // Fetch fresh cross-channel history each turn (texts + call transcripts),
    // mirroring the local adapter — without `recent` the bridge only has its
    // own in-process last-6-turns and forgets everything across respawns.
    const recent = await loadConversationHistory(session.callerExtension);
    session.child.stdin.write(JSON.stringify({ kind: "user_turn", text, ...(recent ? { recent } : {}) }) + "\n");
  } catch (error) {
    await notify({
      fromExtension: cfg.extension,
      toExtension: session.callerExtension,
      title: `${cfg.name} write failed`,
      body: error?.message ?? String(error),
      priority: "urgent"
    });
    await endCall(session, "agent_stdin_write_failed");
  }
}

// --- stdio mode ------------------------------------------------------------

function startStdio(session, context) {
  if (!cfg.command) {
    console.error("stdio mode requires command");
    return null;
  }
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd ?? process.cwd(),
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  // Never leak a previous live child when re-spawning (mirrors universalAgent).
  if (session.child && session.child.exitCode === null && !session.child.killed) {
    try { session.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  session.child = child;
  try {
    child.stdin.write(
      JSON.stringify({
        kind: "session_start",
        agentId: cfg.agentId,
        extension: cfg.extension,
        callId: session.callId,
        callerExtension: session.callerExtension,
        systemPrompt: cfg.systemPrompt ?? "",
        memoryTags: cfg.memoryTags ?? [],
        // Without channel the bridge defaults to "call" — a texted remote agent
        // would think it's on a phone call (and greet out loud into a thread).
        channel: session.channel ?? "call",
        context
      }) + "\n"
    );
  } catch (error) {
    console.error("session_start write failed:", error?.message ?? error);
  }
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => handleAgentLine(session, line).catch((error) => console.error("agent line:", error?.message ?? error)));
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) console.error(`[agent-stderr] ${line}`);
  });
  child.on("exit", (code, signal) => {
    console.log(`stdio child exit code=${code} signal=${signal}`);
    // Only the session's CURRENT child may tear it down (a replaced child's
    // late exit must not clobber the live one).
    if (session.child !== child) return;
    if (!session.ended && code !== 0) {
      notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} exited`,
        body: `Agent process exited with code ${code ?? "?"}. The call has ended.`,
        priority: "urgent"
      }).catch(() => {});
      endCall(session, `agent_exit_${code ?? signal ?? "unknown"}`).catch(() => {});
    }
  });
  return null;
}

async function handleAgentLine(session, line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parsed = trimmed.startsWith("{") ? safeParse(trimmed) : null;
  if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
    await applyDirective(session, parsed);
  } else {
    await speak(session, trimmed);
  }
}

async function applyDirective(session, d) {
  switch (d.action) {
    case "speak":
      if (d.text) await speak(session, String(d.text));
      return;
    case "notify":
      await notify({
        fromExtension: cfg.extension,
        toExtension: String(d.toExtension ?? session.callerExtension),
        title: String(d.title ?? cfg.name),
        body: String(d.body ?? d.text ?? ""),
        priority: String(d.priority ?? "normal"),
        requiresResponse: Boolean(d.requiresResponse ?? false),
        responseOptions: Array.isArray(d.responseOptions) ? d.responseOptions : undefined
      });
      return;
    case "memory":
      await storeMemory({
        scope: String(d.scope ?? "agent"),
        key: String(d.key ?? `${cfg.agentId}-${Date.now()}`),
        content: String(d.content ?? d.text ?? ""),
        tags: Array.isArray(d.tags) ? d.tags : (cfg.memoryTags ?? ["agent-phone"])
      });
      return;
    case "approve":
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: String(d.title ?? `${cfg.name} needs approval`),
        body: String(d.question ?? d.body ?? "Approval required."),
        priority: "urgent",
        requiresResponse: true,
        responseOptions: Array.isArray(d.options) ? d.options : ["approve", "deny"]
      });
      return;
    case "callback":
      await storeMemory({
        scope: "callback",
        key: `${cfg.agentId}-callback-${session.callerExtension}`,
        content: `Agent ${cfg.agentId} wants to call back ${session.callerExtension}: ${d.when ?? "later"}. Reason: ${d.reason ?? ""}`,
        tags: [...(cfg.memoryTags ?? ["agent-phone"]), "callback", "pending"]
      });
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} will call back`,
        body: `Reason: ${d.reason ?? "(not specified)"} · When: ${d.when ?? "later"}`,
        priority: "low"
      });
      return;
    case "work":
      await notify({
        fromExtension: cfg.extension,
        toExtension: session.callerExtension,
        title: `${cfg.name} working`,
        body: String(d.description ?? d.text ?? ""),
        priority: "low"
      });
      return;
    case "end":
      await endCall(session, String(d.reason ?? "agent_ended"));
      return;
    default:
      console.error(`unknown directive: ${d.action}`);
  }
}

// --- tmux mode -------------------------------------------------------------

function tmuxName(c) { return c.tmuxSession ?? `agent-phone-${c.extension}`; }

async function ensureTmux(c) {
  const name = tmuxName(c);
  try { await execFileAsync("tmux", ["has-session", "-t", name]); }
  catch { await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", c.cwd ?? process.cwd(), c.command ?? "bash"]); }
}

async function tmuxSendKeys(c, text) {
  const name = tmuxName(c);
  try { await execFileAsync("tmux", ["send-keys", "-t", name, text, "Enter"]); }
  catch (error) { console.error(`tmux send-keys: ${error?.message ?? error}`); }
}

async function tmuxCapture(c) {
  const name = tmuxName(c);
  try { const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", name, "-S", "-200"]); return stdout; }
  catch (error) { return `unable to read pane: ${error?.message ?? error}`; }
}

// --- Outbound helpers ------------------------------------------------------

async function speak(session, text) {
  if (session.ended) return;
  if (session.channel === "text") {
    // Text chat (incl. group): reply back as an in-app text into the same thread.
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
  send({
    type: "call_message",
    callId: session.callId,
    fromExtension: cfg.extension,
    toExtension: session.callerExtension,
    content: text,
    synthesize: true
  });
}

async function endCall(session, reason) {
  if (session.ended) return;
  session.ended = true;
  send({ type: "call_end", callId: session.callId, extension: cfg.extension, reason });
}

async function notify(input) {
  try {
    // /mcp (not /mcp-local): the per-agent bearer token authenticates from ANY
    // host, so a remote connector can actually deliver texts. /mcp-local is
    // loopback-only and 403s a remote agent.
    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
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
            message: input.body, // the notify_user tool expects `message`, not `body`
            priority: input.priority,
            requires_response: input.requiresResponse ?? false,
            ...(input.threadId ? { thread_id: input.threadId } : {}),
            ...(input.responseOptions ? { response_options: input.responseOptions } : {})
          }
        }
      })
    });
    if (!res.ok) console.error(`notify rejected (${res.status}): ${(await res.text()).slice(0, 200)}`);
  } catch (error) { console.error(`notify failed: ${error?.message ?? error}`); }
}

async function storeMemory(memory) {
  try {
    await fetch(`${cfg.serverUrl.replace(/\/$/, "")}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(memory)
    });
  } catch (error) { console.error(`memory failed: ${error?.message ?? error}`); }
}

async function loadCallContext(callerExtension) {
  try {
    const tag = (cfg.memoryTags ?? ["agent-phone"])[0];
    // The search route's param is "q" (not "query") — using the wrong name made
    // this 400 and silently dropped all prior memory for remote agents.
    const res = await fetch(
      `${cfg.serverUrl.replace(/\/$/, "")}/api/memory/search?q=${encodeURIComponent(tag)}&limit=10`,
      { headers: { Authorization: `Bearer ${cfg.token}` } }
    );
    if (!res.ok) return "(no prior memory)";
    const memories = await res.json();
    if (!Array.isArray(memories) || memories.length === 0) return "(no prior memory for this agent)";
    return memories.map((m) => `[${m.key}] ${m.content}`).join("\n").slice(0, 4000);
  } catch (error) { return `(memory load failed: ${error?.message ?? error})`; }
}

// Cross-channel conversation history (texts + call transcripts merged in time
// order) — same per-turn memory the local universalAgent injects, so a remote
// agent also remembers what was said on calls while texting and vice versa.
async function loadConversationHistory(peerExtension) {
  try {
    const url = `${cfg.serverUrl.replace(/\/$/, "")}/api/conversation?agent=${encodeURIComponent(cfg.extension)}&peer=${encodeURIComponent(peerExtension)}&limit=30`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) return "";
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return "";
    return items
      .map((i) => `${i.who === "agent" ? "You" : "User"} [${i.channel}]: ${i.text}`)
      .join("\n")
      .slice(-4000);
  } catch {
    return "";
  }
}

// --- helpers ---------------------------------------------------------------

function safeParse(text) { try { return JSON.parse(text); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

process.on("SIGTERM", () => { shuttingDown = true; try { ws?.close(); } catch {} process.exit(0); });
process.on("SIGINT", () => { shuttingDown = true; try { ws?.close(); } catch {} process.exit(0); });
