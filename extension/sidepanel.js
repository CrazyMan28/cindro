// Jarvis co-worker side panel.
//
// Connects to the Jarvis DAEMON control WebSocket (NOT the engine bridge that
// sw.js uses) and runs a real chat session. A Jarvis session's computer-use
// already drives THIS browser through the engine bridge, so all we own here is
// the chat UI + the daemon connection + handing Jarvis the tab context.
//
// Daemon protocol (Contract A v1):
//   connect: ws://127.0.0.1:<controlPort>/control/ws?token=<controlToken>
//   request:  {v:1, id, method, params}
//   reply:    {v:1, id, ok:true,  result} | {v:1, id, ok:false, error:{code,message}}
//   event:    {v:1, event:"session.event", data:{session_id, ev:{kind, ...}}}

const $ = (id) => document.getElementById(id);

const els = {
  dot: $("dot"),
  brain: $("brain"),
  model: $("model"),
  tabchip: $("tabchip"),
  ctxTitle: $("ctxTitle"),
  ctxUrl: $("ctxUrl"),
  refreshBtn: $("refreshBtn"),
  transcript: $("transcript"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  stopBtn: $("stopBtn"),
  sessionsBtn: $("sessionsBtn"),
  newBtn: $("newBtn"),
  sessionsPanel: $("sessionsPanel"),
  sessionsList: $("sessionsList"),
  sessionsClose: $("sessionsClose"),
};

// ----------------------------------------------------------------- state
let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let warnedNoToken = false;

let nextRpcId = 1;
const pending = new Map(); // rpcId -> {resolve, reject}

let sessionId = null;
let turnInFlight = false;
let lastTabCtx = { active: null, tabs: [] };

// Live "streaming" assistant bubble for the current turn (we append message
// deltas into it). Reset at each turn / final.
let liveBubble = null;
let liveText = "";

// Active client-side typewriter reveals. Each assistant `message` event gets its
// OWN bubble + its OWN reveal timer + full text, so a fast follow-up message never
// clobbers an in-progress reveal. Cleared (and snapped to full) on turn end.
// Each entry: { timer, el, full }.
const reveals = new Set();

// While replaying session.history we render instantly (no typewriter, no driving
// signal, no turn UI) — these are PAST events, not a live turn.
let replaying = false;

// The most recent rendered tool_call row, so a following tool_result can stamp
// it with ✓ / ✗ instead of adding a separate noisy line.
let lastToolEl = null;

// ----------------------------------------------------------------- config
async function getConfig() {
  return await chrome.storage.local.get({ controlPort: 8795, controlToken: "" });
}

// ----------------------------------------------------------------- connect
function setConnected(on) {
  connected = on;
  els.dot.classList.toggle("ok", on);
  els.dot.title = on ? "connected to Jarvis daemon" : "disconnected from Jarvis daemon";
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { controlPort, controlToken } = await getConfig();
  if (!controlToken) {
    setConnected(false);
    if (!warnedNoToken) {  // show ONCE, not on every reconnect tick
      warnedNoToken = true;
      addSys("No Jarvis control token set — open the extension Options and paste it.");
    }
    return;
  }
  warnedNoToken = false;
  let sock;
  try {
    sock = new WebSocket(
      `ws://127.0.0.1:${controlPort}/control/ws?token=${encodeURIComponent(controlToken)}`
    );
  } catch (e) {
    scheduleReconnect();
    return;
  }
  sock.onopen = () => {
    ws = sock;
    reconnectDelay = 1000;
    setConnected(true);
    // 2FA + fingerprint gate: on the FIRST successful connect, gate the panel
    // behind a phone approval (origin:"extension"). Fails open when no phone is
    // paired. Runs once per panel lifetime (a reconnect doesn't re-lock).
    if (!authStartedOnce && !authUnlocked) {
      authStartedOnce = true;
      startAuthGate();
    }
    loadModels(els.brain.value || "codex");  // fill the model picker once connected
    // Refresh the (shared) conversation list whenever we (re)connect so a chat
    // started on the desktop/phone shows up here immediately.
    loadSessions().catch(() => {});
  };
  sock.onmessage = (ev) => onFrame(ev.data);
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setConnected(false);
    // Reject any in-flight RPCs so callers don't hang forever.
    for (const [, p] of pending) p.reject(new Error("connection closed"));
    pending.clear();
    scheduleReconnect();
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(reconnectDelay, 15000);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ------------------------------------------ 2FA + fingerprint unlock gate
// On connect the side panel runs the SAME unlock flow as the desktop LockGate,
// tagged origin:"extension". It renders an inline gate over the panel content,
// calls auth.request, polls auth.status, and reveals the panel on "approved".
// FAIL-OPEN: when paired==false the daemon answers state="approved" immediately
// so the user is never locked out.
let authChallengeId = "";
let authUnlocked = false;
let authPollTimer = null;
let authTimeoutTimer = null;
let authStartedOnce = false;

function authGateEl() { return document.getElementById("authGate"); }

function ensureAuthGate() {
  let gate = authGateEl();
  if (gate) return gate;
  gate = document.createElement("div");
  gate.id = "authGate";
  gate.style.cssText =
    "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:14px;text-align:center;" +
    "padding:24px;background:#04060B;color:#EAF6FF;" +
    "font-family:Inter,'Noto Sans',sans-serif;";
  gate.innerHTML =
    '<div style="font-family:Orbitron,Rajdhani,sans-serif;font-size:16px;' +
    'letter-spacing:2px;color:#29E7FF;font-weight:600;">JARVIS LOCKED</div>' +
    '<div id="authGateMsg" style="font-size:13px;color:#8DA6C4;max-width:280px;' +
    'line-height:1.5;">Requesting unlock…</div>' +
    '<button id="authGateRetry" style="display:none;margin-top:6px;padding:8px 22px;' +
    'border:1px solid rgba(41,231,255,0.55);border-radius:8px;background:transparent;' +
    'color:#29E7FF;font-family:Orbitron,sans-serif;font-size:12px;letter-spacing:1px;' +
    'cursor:pointer;">RETRY</button>';
  document.body.appendChild(gate);
  gate.querySelector("#authGateRetry").addEventListener("click", startAuthGate);
  return gate;
}

function setAuthMsg(text, showRetry) {
  const gate = ensureAuthGate();
  const msg = gate.querySelector("#authGateMsg");
  if (msg) msg.textContent = text;
  const btn = gate.querySelector("#authGateRetry");
  if (btn) btn.style.display = showRetry ? "inline-block" : "none";
}

function clearAuthTimers() {
  if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
  if (authTimeoutTimer) { clearTimeout(authTimeoutTimer); authTimeoutTimer = null; }
}

function revealPanel() {
  authUnlocked = true;
  clearAuthTimers();
  const gate = authGateEl();
  if (gate) gate.remove();
}

async function startAuthGate() {
  if (authUnlocked) return;
  authChallengeId = "";
  ensureAuthGate();
  setAuthMsg("Requesting unlock…", false);
  clearAuthTimers();
  let res;
  try {
    res = await rpc("auth.request", { origin: "extension" });
  } catch (e) {
    // Daemon doesn't implement auth.* (older build) or RPC failed -> FAIL-OPEN.
    revealPanel();
    return;
  }
  // FAIL-OPEN (no phone paired) OR already approved -> reveal now.
  if (res.paired === false || res.state === "approved") {
    revealPanel();
    return;
  }
  authChallengeId = res.challenge_id || "";
  if (!authChallengeId) { revealPanel(); return; }
  setAuthMsg("Approve on your phone — tap the notification and confirm with your fingerprint.", false);
  // Poll auth.status as a fallback to the unsolicited auth.event push.
  authPollTimer = setInterval(async () => {
    if (authUnlocked || !authChallengeId) return;
    try {
      const st = await rpc("auth.status", { challenge_id: authChallengeId });
      onAuthState(st.challenge_id || authChallengeId, st.state || "");
    } catch (e) { /* keep polling */ }
  }, 2000);
  // Hard timeout -> Retry.
  authTimeoutTimer = setTimeout(() => {
    if (!authUnlocked) setAuthMsg("Timed out waiting for approval.", true);
  }, 130000);
}

function onAuthState(challengeId, state) {
  if (authUnlocked) return;
  if (challengeId && authChallengeId && challengeId !== authChallengeId) return;
  if (state === "approved") {
    revealPanel();
  } else if (state === "denied") {
    setAuthMsg("Sign-in was denied on your phone.", true);
  } else if (state === "expired") {
    setAuthMsg("The unlock request expired.", true);
  }
}

// ----------------------------------------------------------------- RPC
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected to Jarvis daemon"));
      return;
    }
    const id = nextRpcId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ v: 1, id, method, params: params || {} }));
    // Safety timeout so a dropped reply doesn't wedge the UI forever.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

function onFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  // Unsolicited events.
  if (msg.event === "session.event" && msg.data) {
    if (!sessionId || msg.data.session_id === sessionId) {
      handleEv(msg.data.ev || {});
    }
    return;
  }

  // 2FA unlock: a paired phone approved/denied the desktop/extension sign-in.
  // Mirrors the desktop LockGate — unlock the panel instantly (the auth.status
  // poll is the fallback).
  if (msg.event === "auth.event" && msg.data) {
    onAuthState(msg.data.challenge_id || "", msg.data.state || "");
    return;
  }

  // RPC reply.
  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result || {});
    else p.reject(new Error((msg.error && msg.error.message) || "rpc error"));
  }
}

// ------------------------------------------------------- event rendering
// `ev` is a NormalizedBrainEvent: {kind, ...fields}. Render kinds:
//   message{role,text} thinking{text} tool_call{name,...} tool_result{...}
//   final  error{message}  turn_started
function handleEv(ev) {
  const kind = ev.kind || ev.ev; // tolerate either discriminator
  switch (kind) {
    case "turn_started":
      // New turn: stop any prior live bubble accumulation + drop stale tool ref.
      endLiveBubble();
      lastToolEl = null;
      break;

    case "thinking":
      // Close any open assistant bubble first so the dim italic thinking line
      // renders on its OWN row in normal flow — never on top of / overwriting
      // the assistant's spoken text. Following message text starts a fresh bubble.
      if (ev.text) { endLiveBubble(); addThinking(ev.text); }
      break;

    case "message": {
      // The daemon emits ONE message event per COMPLETE assistant segment (same as
      // the phone), NOT streaming deltas. So each one is its OWN bubble — never
      // append to the previous (that ran two separate replies together, e.g.
      // "…full desktop.I'm on the login page…"). Tool calls between them already
      // render as their own rows, so the sequence reads: reply · tool · reply.
      const role = ev.role || "assistant";
      const text = ev.text || "";
      if (role === "user") break; // we already echoed the user's own message
      if (text.trim()) addAssistantMessage(text);
      break;
    }

    case "tool_call":
      // Show the user EXACTLY what Jarvis does: "▸ <name> <short args/target>".
      endLiveBubble();
      addToolCall(ev);
      break;

    case "tool_result":
      // Mark the matching call ✓ / ✗ so the action sequence reads at a glance.
      markToolResult(ev);
      break;

    case "error":
      endLiveBubble();
      addError(ev.message || "error");
      endTurn();
      break;

    case "final":
      endLiveBubble();
      endTurn();
      break;

    default:
      // thread_started / usage / diff / approval / driving.state — ignore for chat UI.
      break;
  }
}

// ----------------------------------------------------------- transcript DOM
function atBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
}
function scrollDown(force) {
  if (force || atBottom()) els.transcript.scrollTop = els.transcript.scrollHeight;
}

function addRow(side, cls, text) {
  const row = document.createElement("div");
  row.className = "row " + side;
  const b = document.createElement("div");
  b.className = cls;
  b.textContent = text;
  row.appendChild(b);
  els.transcript.appendChild(row);
  scrollDown();
  return b;
}

function addUser(text) { addRow("user", "bubble user", text); }

// Each assistant message event is a COMPLETE segment -> its OWN bubble. Live
// turns reveal the text with a client-side typewriter (the daemon sends the whole
// message at once, but the user wants a ChatGPT-style "printing" effect). History
// replay renders instantly (replaying === true) since those are past events.
function addAssistantMessage(text) {
  if (replaying) { addRow("jarvis", "bubble jarvis", text); return; }
  typewriterBubble(text);
}

// Append an assistant bubble and reveal `full` incrementally. Each call owns its
// own bubble + its own setInterval (tracked in `reveals`), so overlapping messages
// never fight over the same DOM node or timer. ~3 chars / 12ms; auto-scrolls.
function typewriterBubble(full) {
  const row = document.createElement("div");
  row.className = "row jarvis";
  const b = document.createElement("div");
  b.className = "bubble jarvis caret";
  row.appendChild(b);
  els.transcript.appendChild(row);
  scrollDown();

  const rec = { timer: null, el: b, full };
  let i = 0;
  const step = 3;
  rec.timer = setInterval(() => {
    i = Math.min(i + step, full.length);
    b.textContent = full.slice(0, i);
    scrollDown();
    if (i >= full.length) {
      clearInterval(rec.timer);
      reveals.delete(rec);
      b.classList.remove("caret");
    }
  }, 12);
  reveals.add(rec);
}

// Stop every in-progress reveal and SNAP each bubble to its full text, so ending a
// turn (or starting a replay) never leaves a half-printed message on screen.
function flushReveals() {
  for (const rec of reveals) {
    clearInterval(rec.timer);
    rec.el.textContent = rec.full;
    rec.el.classList.remove("caret");
  }
  reveals.clear();
  scrollDown();
}
function addThinking(text) {
  const el = document.createElement("div");
  el.className = "thinking";
  el.textContent = text;
  els.transcript.appendChild(el);
  scrollDown();
}
function addTool(text) {
  const el = document.createElement("div");
  el.className = "tool";
  el.textContent = text;
  els.transcript.appendChild(el);
  scrollDown();
  return el;
}

// Build a short, human "target" for a tool call from its common arg shapes so
// the user can SEE what's being acted on (url, selector/ref, typed text, ...).
function toolArgSummary(ev) {
  const a = ev.args || ev.params || ev.input || {};
  const bits = [];
  const pick = (k) => (a && a[k] != null ? String(a[k]) : "");
  const url = pick("url"); if (url) bits.push(url);
  const sel = pick("selector") || pick("ref"); if (sel) bits.push(sel);
  const text = pick("text") || pick("value"); if (text) bits.push(`"${text}"`);
  const dir = pick("direction"); if (dir) bits.push(dir);
  const q = pick("query") || pick("name"); if (q && !ev.name) bits.push(q);
  if (!bits.length && a && typeof a === "object") {
    // Fall back to a compact key=val of whatever args exist.
    const flat = Object.keys(a).slice(0, 3)
      .map((k) => `${k}=${truncate(String(a[k]), 40)}`).join(" ");
    if (flat) bits.push(flat);
  }
  return truncate(bits.join("  "), 120);
}

// Strip a leading "<server>." namespace so "real_screen.browser_click" reads as
// "browser_click". Leaves bare names ("shell", "web_search") untouched.
function cleanToolName(raw) {
  const s = String(raw || "tool");
  const dot = s.indexOf(".");
  return dot > 0 ? s.slice(dot + 1) : s;
}

function addToolCall(ev) {
  const name = cleanToolName(ev.name || ev.tool || "tool");
  const args = toolArgSummary(ev);
  lastToolEl = addTool("▸ " + name + (args ? "  " + args : ""));
}

function markToolResult(ev) {
  const ok = ev.ok !== false && ev.error == null && ev.isError !== true;
  if (lastToolEl) {
    // Stamp the matching call line with a ✓ / ✗ prefix.
    const stamp = ok ? "✓ " : "✗ ";
    if (!/^[✓✗] /.test(lastToolEl.textContent)) {
      lastToolEl.textContent = stamp + lastToolEl.textContent;
    }
    lastToolEl.style.color = ok ? "" : "var(--bad)";
    if (!ok) lastToolEl.classList.add("bad");
    if (!ok) {
      const out = ev.output || ev.error || ev.message;
      if (out) {
        const e = addTool("  ✗ " + truncate(String(out), 200));
        e.style.color = "var(--bad)"; e.classList.add("bad");
      }
    }
    lastToolEl = null;
  } else if (ok === false) {
    const out = ev.output || ev.error || ev.message;
    if (out) {
      const e = addTool("✗ " + truncate(String(out), 200));
      e.style.color = "var(--bad)"; e.classList.add("bad");
    }
  }
}
function addError(text) {
  const el = document.createElement("div");
  el.className = "errmsg";
  el.textContent = text;
  els.transcript.appendChild(el);
  scrollDown(true);
}
function addSys(text) {
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  els.transcript.appendChild(el);
  scrollDown();
}

// A single growing assistant bubble for the current reply. Handles BOTH
// cumulative-snapshot brains (each event is the full text so far -> replace) and
// delta brains (each event is only the new chunk -> append), without ever
// duplicating. All writes target the live MESSAGE bubble, never the thinking row.
function appendAssistantText(delta) {
  if (delta == null || delta === "") return;
  if (!liveBubble) {
    const row = document.createElement("div");
    row.className = "row jarvis";
    liveBubble = document.createElement("div");
    liveBubble.className = "bubble jarvis caret";
    row.appendChild(liveBubble);
    els.transcript.appendChild(row);
    liveText = "";
  }
  if (delta === liveText) {
    // Identical repeat snapshot — nothing changed, don't duplicate.
  } else if (delta.startsWith(liveText)) {
    // Cumulative snapshot that extends what we have -> replace with the fuller text.
    liveText = delta;
  } else if (liveText.endsWith(delta)) {
    // Re-sent tail (snapshot brain re-emitting the last chunk) -> ignore.
  } else {
    // A genuine delta chunk -> append.
    liveText += delta;
  }
  liveBubble.textContent = liveText;
  scrollDown();
}

function endLiveBubble() {
  if (liveBubble) liveBubble.classList.remove("caret");
  liveBubble = null;
  liveText = "";
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

// ----------------------------------------------------------------- turn state
const WORK_PHRASES = [
  "Conquering the world", "Just chillin", "Pondering the universe", "Cooking",
  "Summoning electrons", "Reticulating splines", "Bending spacetime",
  "Consulting the oracle", "Vibing", "Untangling the matrix", "Herding photons",
  "Caffeinating neurons", "Manifesting", "Hacking the mainframe",
  "Plotting world domination", "Overthinking it", "Galaxy-braining", "Locking in"
];
let workTimer = null;
function rollPhrase() {
  const work = $("workTxt");
  if (work) work.textContent = WORK_PHRASES[Math.floor(Math.random() * WORK_PHRASES.length)];
}
// Tell the content script (via sw.js) that a turn is driving the browser, so
// the "Jarvis is controlling Chrome" chip + blue cursor stay up for the WHOLE
// turn instead of flickering for 3s on each action. Best-effort.
function signalDriving(on) {
  try {
    chrome.runtime.sendMessage({ type: "jarvis-driving", on }).catch(() => {});
  } catch (e) { /* sw waking / no receiver — ignore */ }
}

function startTurn() {
  turnInFlight = true;
  els.sendBtn.classList.add("hidden");
  els.stopBtn.classList.remove("hidden");
  els.input.disabled = false;
  const w = $("working");
  if (w) w.classList.remove("hidden");
  rollPhrase();
  if (workTimer) clearInterval(workTimer);
  workTimer = setInterval(rollPhrase, 2400);
  signalDriving(true);
}
function endTurn() {
  turnInFlight = false;
  els.stopBtn.classList.add("hidden");
  els.sendBtn.classList.remove("hidden");
  els.input.disabled = false;
  els.input.focus();
  const w = $("working");
  if (w) w.classList.add("hidden");
  if (workTimer) { clearInterval(workTimer); workTimer = null; }
  flushReveals();   // snap any still-printing message to its full text
  lastToolEl = null;
  signalDriving(false);
}

// ----------------------------------------------------------------- tabs
async function refreshTabs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "cu-tabs" });
    if (!res) return;
    lastTabCtx = res;
    const n = (res.tabs || []).length;
    els.tabchip.textContent = "tabs: " + n;
    if (res.active) {
      els.ctxTitle.textContent = res.active.title || "(untitled tab)";
      els.ctxUrl.textContent = res.active.url || "";
    } else {
      els.ctxTitle.textContent = "active tab —";
      els.ctxUrl.textContent = "";
    }
  } catch (e) {
    // service worker may be waking; leave previous context.
  }
}

function tabContextNote() {
  const a = lastTabCtx.active;
  const n = (lastTabCtx.tabs || []).length;
  const title = a ? (a.title || "(untitled)") : "(none)";
  const url = a ? (a.url || "") : "";
  return `[Chrome context — active tab: ${title} ${url}; ${n} tabs open]`;
}

// ----------------------------------------------------------------- send
let sessionPrimed = false;
// One-time primer that makes Jarvis act as the CHROME co-worker: use the precise
// browser_* tools (DOM-level) instead of janky real-screen coordinate clicks, and
// don't ask which screen for in-page actions.
const BROWSER_PRIMER =
  "[You are the user's CHROME co-worker, talking to them from a side panel INSIDE their " +
  "Chrome. You act ONLY inside Chrome. HARD RULES:\n" +
  "1) Use ONLY the browser tools: browser_snapshot (read the page + element refs), " +
  "browser_click, browser_type, browser_navigate, browser_scroll, browser_select, " +
  "browser_tabs. They drive the real Chrome directly and PRECISELY via this extension.\n" +
  "2) NEVER use real_screen / desktop_screenshot / mouse_click / mouse_move / key_press / " +
  "type_text or ANY real-screen or full-desktop computer-use tool. Those take over the " +
  "user's whole screen with a big cursor — that is FORBIDDEN here. This agent is " +
  "Chrome-only.\n" +
  "3) NEVER ask which screen to use — the answer is always THIS Chrome, via the browser " +
  "tools.\n" +
  "4) If something genuinely can't be done with the browser tools, say so plainly " +
  "instead of falling back to real-screen control.]";

async function ensureSession() {
  if (sessionId) return sessionId;
  const brain = els.brain.value || "codex";
  const model = els.model.value || "";   // "" = daemon default
  const params = { profile: "coder", brain };
  if (model) params.model = model;
  const res = await rpc("session.create", params);
  sessionId = res.session_id;
  if (!sessionId) throw new Error("session.create returned no session_id");
  sessionPrimed = false;
  return sessionId;
}

// Populate the model dropdown for the chosen brain from model.list{brain}.
// model.list returns {models:[<id strings>]}. Keeps a leading "default" option.
async function loadModels(brain) {
  if (!connected) return;
  try {
    const res = await rpc("model.list", { brain });
    const models = (res && res.models) || [];
    const prev = els.model.value;
    els.model.innerHTML = "";
    const def = document.createElement("option");
    def.value = ""; def.textContent = "default model";
    els.model.appendChild(def);
    for (const m of models) {
      const id = typeof m === "string" ? m : (m && (m.id || m.model));
      if (!id) continue;
      const o = document.createElement("option");
      o.value = id; o.textContent = id;
      els.model.appendChild(o);
    }
    // restore prior selection if still present
    if (prev && [...els.model.options].some((o) => o.value === prev)) els.model.value = prev;
  } catch (e) { /* leave the default option */ }
}

// ----------------------------------------------------- session picker (UNIFY)
// All Jarvis surfaces (desktop, phone, this panel) share ONE daemon and ONE set
// of sessions. session.list shows every conversation; picking one continues it
// IN PLACE (session.send keeps using that id), so it stays in sync everywhere.

let sessionsOpen = false;

function short8(id) { return id ? String(id).slice(0, 8) : "????????"; }

// session.list -> {sessions:[{id,title,brain,model,state,updated,...}]}.
async function loadSessions() {
  if (!connected) { renderSessions([], "Not connected."); return; }
  renderSessions(null, "Loading…");
  try {
    const res = await rpc("session.list", {});
    const list = (res && res.sessions) || [];
    // Newest first by `updated` (falls back to created, then id order).
    list.sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
    renderSessions(list);
  } catch (e) {
    renderSessions([], "Couldn't load sessions: " + (e && e.message || e));
  }
}

function renderSessions(list, note) {
  const box = els.sessionsList;
  box.innerHTML = "";
  if (note) {
    const n = document.createElement("div");
    n.className = "sess-empty";
    n.textContent = note;
    box.appendChild(n);
    if (list == null) return; // "Loading…" placeholder, items follow
  }
  if (!list || !list.length) {
    if (!note) {
      const e = document.createElement("div");
      e.className = "sess-empty";
      e.textContent = "No conversations yet — send a message to start one.";
      box.appendChild(e);
    }
    return;
  }
  for (const s of list) {
    const item = document.createElement("div");
    item.className = "sess-item" + (s.id === sessionId ? " current" : "");
    const title = document.createElement("div");
    title.className = "sess-title";
    title.textContent = s.title && s.title.trim()
      ? s.title
      : `${s.brain || "session"} · ${short8(s.id)}`;
    const meta = document.createElement("div");
    meta.className = "sess-meta";
    meta.textContent = [s.brain, s.state].filter(Boolean).join(" · ");
    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener("click", () => pickSession(s));
    box.appendChild(item);
  }
}

function openSessions() {
  sessionsOpen = true;
  els.sessionsPanel.classList.remove("hidden");
  loadSessions();
}
function closeSessions() {
  sessionsOpen = false;
  els.sessionsPanel.classList.add("hidden");
}
function toggleSessions() { sessionsOpen ? closeSessions() : openSessions(); }

// Continue an existing conversation: adopt its id, wipe the transcript, replay
// its history through the SAME renderer, then let the user keep typing.
async function pickSession(s) {
  if (turnInFlight) doStop();        // don't adopt mid-turn
  closeSessions();
  sessionId = s.id;
  sessionPrimed = true;              // existing convo — don't re-inject the primer
  // Reflect the session's brain/model in the pickers (best-effort).
  if (s.brain && [...els.brain.options].some((o) => o.value === s.brain)) {
    els.brain.value = s.brain;
    await loadModels(s.brain);
  }
  if (s.model && [...els.model.options].some((o) => o.value === s.model)) els.model.value = s.model;
  clearTranscript();
  addSys(`Continuing: ${s.title && s.title.trim() ? s.title : (s.brain || "session") + " · " + short8(s.id)}`);
  await replayHistory(s.id);
}

// session.history -> {events:[{ev:{kind,...}} | rawEvent]}. Unwrap each to the
// NormalizedBrainEvent and render through handleEv with `replaying` set so nothing
// typewriters / signals driving / toggles the turn UI — these are PAST events.
async function replayHistory(id) {
  let events = [];
  try {
    const res = await rpc("session.history", { session_id: id, limit: 0 });
    events = (res && res.events) || [];
  } catch (e) {
    addError("Couldn't load history: " + (e && e.message || e));
    return;
  }
  replaying = true;
  try {
    for (const raw of events) {
      // Each entry may be {seq,ts,ev:{...}} OR the raw NormalizedBrainEvent itself.
      const ev = (raw && raw.ev) ? raw.ev : raw;
      if (ev && (ev.kind || ev.ev)) handleEv(ev);
    }
  } finally {
    replaying = false;
    endLiveBubble();
    lastToolEl = null;
  }
  scrollDown(true);
}

function clearTranscript() {
  flushReveals();
  endLiveBubble();
  lastToolEl = null;
  els.transcript.innerHTML = "";
}

// "+ New": drop the session id so the next Send creates a fresh one (re-priming
// the Chrome co-worker primer), clear the transcript, refresh the list.
function newSession() {
  if (turnInFlight) doStop();
  closeSessions();
  sessionId = null;
  sessionPrimed = false;
  clearTranscript();
  addSys("New conversation — your next message starts a fresh session.");
}

async function doSend() {
  if (turnInFlight) return;
  const text = els.input.value.trim();
  if (!text) return;
  if (!connected) { addError("Not connected to the Jarvis daemon — check the control token in Options."); return; }

  els.input.value = "";
  autosize();
  addUser(text);

  // Refresh tab context right before sending so Jarvis sees the live browser.
  await refreshTabs();
  const firstMsg = `${tabContextNote()}\n\n${text}`;

  startTurn();
  try {
    const sid = await ensureSession();
    // Lead a brand-new session with the Chrome-co-worker primer so it uses the
    // browser tools (not real-screen clicking) and skips the screen question.
    const payload = sessionPrimed ? firstMsg : `${BROWSER_PRIMER}\n\n${firstMsg}`;
    sessionPrimed = true;
    await rpc("session.send", { session_id: sid, text: payload });
    // The turn now runs; final/error events end it.
  } catch (e) {
    addError(String(e && e.message || e));
    endTurn();
  }
}

async function doStop() {
  if (!sessionId) { endTurn(); return; }
  try { await rpc("session.cancel", { session_id: sessionId }); } catch (e) { /* ignore */ }
  endLiveBubble();
  endTurn();
  addSys("stopped");
}

// ----------------------------------------------------------------- model picker
// When the brain changes, drop the existing session so the next Send creates a
// fresh one with the chosen brain.
async function onBrainChange() {
  sessionId = null;
  endLiveBubble();
  endTurn();
  loadModels(els.brain.value);  // repopulate models for the new brain
  addSys("brain set to " + els.brain.value + " — a new session starts on your next message");
}

// ----------------------------------------------------------------- composer UX
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}

els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});
els.sendBtn.addEventListener("click", doSend);
els.stopBtn.addEventListener("click", doStop);
els.refreshBtn.addEventListener("click", refreshTabs);
els.brain.addEventListener("change", onBrainChange);
els.sessionsBtn.addEventListener("click", toggleSessions);
els.sessionsClose.addEventListener("click", closeSessions);
els.newBtn.addEventListener("click", newSession);

// ----------------------------------------------------------------- boot
async function init() {
  addSys("Jarvis co-worker ready. Type a request to drive this browser.");
  await refreshTabs();
  await connect();
  // Light heartbeat to recover the connection if it silently drops.
  setInterval(() => { if (!connected) connect(); }, 4000);
}
init();
