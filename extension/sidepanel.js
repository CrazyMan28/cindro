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
  slashPalette: $("slashPalette"),
  quickbar: $("quickbar"),
  planPanel: $("planPanel"),
  planHead: $("planHead"),
  planBody: $("planBody"),
  planCount: $("planCount"),
  planToggle: $("planToggle"),
  planDismiss: $("planDismiss"),
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

// Collapsible "thinking" block for the current turn: ALL `thinking` event
// chunks accumulate into ONE growing DOM block (not a new element per chunk).
// thinkingEl is the outer <div class="thinking">; thinkingHeadEl/thinkingBodyEl
// are its header (click-to-collapse) and body; thinkingText is the accumulated
// raw text; thinkingStartTs/thinkingTicker drive the "Thinking… Ns" live clock,
// frozen to "Thought for Ns" once the turn's first non-thinking content lands.
let thinkingEl = null;
let thinkingBodyEl = null;
let thinkingHeadEl = null;
let thinkingText = "";
let thinkingStartTs = 0;
let thinkingTicker = null;

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
  els.dot.title = on ? "connected to Cindro daemon" : "disconnected from Cindro daemon";
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { controlPort, controlToken } = await getConfig();
  if (!controlToken) {
    setConnected(false);
    if (!warnedNoToken) {  // show ONCE, not on every reconnect tick
      warnedNoToken = true;
      addSys("No Cindro control token set — open the extension Options and paste it.");
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
    // Subscribe to the widget bus over the control WS so render_widget output
    // (charts, cards, the PLAN checklist) appears in the panel — same DSL the
    // desktop/phone render. The desktop tails the file itself and never subscribes.
    rpc("widget.subscribe", { on: true }).catch(() => {});
    // Real-time phone events (jarvis#76 item 3): pushed incoming_call /
    // call_state / call_message frames replace the fast polling loops.
    rpc("phone.event.subscribe", { on: true }).catch(() => {});
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
    'letter-spacing:2px;color:#29E7FF;font-weight:600;">CINDRO LOCKED</div>' +
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
      reject(new Error("not connected to Cindro daemon"));
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

  // Unsolicited events. Scope STRICTLY to the panel's current session: with no
  // session yet (fresh panel), accept NOTHING — the daemon broadcasts every
  // session's events to unsubscribed control clients, so a null sessionId used
  // to mean "accept everything" and leaked other chats (desktop/phone/other
  // tabs/subagents) into a blank panel before the user sent anything.
  if (msg.event === "phone.event" && msg.data) {
    // Pushed phone-server event (jarvis#76 item 3). Refresh only what changed:
    // call lifecycle -> re-list calls (banner + list); call_message -> live
    // transcript line for the call being watched.
    const pev = msg.data;
    if (pev.type === "call_message") {
      if (_liveTranscriptCallId && String(pev.callId || "") === String(_liveTranscriptCallId)) {
        refreshLiveTranscript();
      }
    } else if (phoneOpen) {
      loadActiveCalls();
    } else if (pev.type === "incoming_call") {
      // Panel closed on another tab: still surface the ringing banner.
      loadActiveCalls();
    }
    return;
  }

  if (msg.event === "session.event" && msg.data) {
    if (sessionId && msg.data.session_id === sessionId) {
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

  // Widget bus (render_widget / todo plan / charts) over the control WS.
  if (msg.event === "widget.render" && msg.data) {
    // Scope to the current session. No active session yet -> drop it, so another
    // chat's widgets (incl. its PLAN card) can't paint into a blank panel.
    if (!sessionId) return;
    const wsid = msg.data.session_id || "";
    // The model's live plan/checklist (id "__todo__:<session>") goes to the
    // dedicated PLAN panel above the transcript, NOT inline in chat.
    if (String(msg.data.id || "").indexOf("__todo__") === 0) {
      // A plan card is SESSION-PRIVATE. Its true owner is encoded in the id
      // ("__todo__:<owner>"); the session_id field can be blank when the shared
      // global engine can't disambiguate (2+ running) — the OLD gate below
      // (`wsid && wsid !== sessionId`) let that blank fall straight through, so
      // another chat's plan painted into this panel (the reported leak). Derive
      // the owner from the id and require it to match this session. An empty or
      // "default" owner is the ambiguous shared-engine LIVE plan, adopted into
      // the current session like the desktop does.
      const owner = wsid || String(msg.data.id || "").replace(/^__todo__:?/, "");
      if (owner && owner !== "default" && owner !== sessionId) return;
      renderPlan(msg.data);
      return;
    }
    // A session-less/global widget (empty session_id) is allowed only once THIS
    // panel has a session, matching the transcript gate above.
    if (wsid && wsid !== sessionId) return;
    renderWidget(msg.data);
    return;
  }
  if (msg.event === "widget.remove" && msg.data) {
    const rid = String(msg.data.id || "");
    if (rid.indexOf("__todo__") === 0) {
      // Only dismiss OUR plan — a foreign session clearing its own plan card
      // (id "__todo__:<owner>") must not wipe the plan we're showing. Same
      // owner rule as the render gate above.
      const owner = rid.replace(/^__todo__:?/, "");
      if (!owner || owner === "default" || owner === sessionId) dismissPlan();
      return;
    }
    removeWidget(rid);
    return;
  }
  if (msg.event === "widget.clear") { clearWidgets(); dismissPlan(); return; }

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
      freezeThinking();
      lastToolEl = null;
      break;

    case "thinking":
      // Close any open assistant bubble first so the collapsible thinking block
      // renders on its OWN row in normal flow — never on top of / overwriting
      // the assistant's spoken text. Following message text starts a fresh bubble.
      // NOTE: does NOT freeze the thinking block — this is the site where its
      // chunks accumulate; freezing happens once non-thinking content lands.
      if (ev.text) { endLiveBubble(); appendThinking(ev.text); }
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
      if (text.trim()) { freezeThinking(); addAssistantMessage(text); }
      break;
    }

    case "tool_call":
      // Show the user EXACTLY what Jarvis does: "▸ <name> <short args/target>".
      endLiveBubble();
      freezeThinking();
      addToolCall(ev);
      break;

    case "tool_result":
      // Mark the matching call ✓ / ✗ so the action sequence reads at a glance.
      markToolResult(ev);
      break;

    case "diff": {
      // File edit — show a compact "✎ path +N/-M" line via the same tool-row
      // primitive tool_call/tool_result use, so edits are visible in-chat
      // instead of silently vanishing (parity with desktop/phone diff cards).
      endLiveBubble();
      freezeThinking();
      const stat = diffStat(ev.patch);
      addTool(`✎ ${ev.path || "diff"}  +${stat.add}/-${stat.del}`);
      break;
    }

    case "approval":
      // Gated turn (e.g. ApiBrain's injection hold) — render an allow/deny
      // card. Continuing this session from the Sessions picker on ANY brain
      // (incl. api-brain) must be able to answer this, or the turn hangs
      // forever; Stop already calls session.cancel (see doStop) which
      // releases the daemon's server-side injection hold.
      endLiveBubble();
      freezeThinking();
      addApprovalCard(ev);
      break;

    case "error":
      endLiveBubble();
      freezeThinking();
      addError(ev.message || "error");
      endTurn();
      break;

    case "final":
      endLiveBubble();
      freezeThinking();
      endTurn();
      break;

    default:
      // thread_started / usage / driving.state — ignore for chat UI.
      break;
  }
}

// Sum patch +/- lines for the compact diff row (skip the "+++"/"---" file
// header lines so they don't get counted as an added/removed line).
function diffStat(patch) {
  let add = 0, del = 0;
  String(patch || "").split("\n").forEach((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  });
  return { add, del };
}

// Allow/deny card for a gated turn (approval{approval_id,summary,risk}).
// Responding calls approval.respond{session_id,approval_id,decision} — the
// same RPC/shape the desktop's respondApproval() sends.
function addApprovalCard(ev) {
  const approvalId = ev.approval_id || "";
  const summary = ev.summary || "Approval requested";
  const risk = ev.risk != null && ev.risk !== "" ? String(ev.risk) : "";

  const row = document.createElement("div");
  row.className = "row left";
  const card = document.createElement("div");
  card.className = "widget-card";
  card.style.cssText = "margin:6px 0;padding:10px 12px;border:1px solid #3D6EFF;border-radius:12px;background:#0C141C;color:#EAF6FF;font-size:13px;";

  const head = document.createElement("div");
  head.textContent = (risk ? `[${risk}] ` : "") + summary;
  head.style.cssText = "margin-bottom:8px;";
  card.appendChild(head);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  const mkBtn = (label, decision, primary) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `padding:5px 14px;border-radius:8px;cursor:pointer;font-size:12px;` +
      `border:1px solid ${primary ? "rgba(61,214,255,.55)" : "rgba(255,90,90,.5)"};` +
      `background:${primary ? "rgba(61,214,255,.15)" : "rgba(255,90,90,.12)"};` +
      `color:${primary ? "#3DD6FF" : "#FF8A8A"};`;
    b.addEventListener("click", async () => {
      if (b.disabled) return;
      [...btnRow.children].forEach((x) => { x.disabled = true; x.style.opacity = "0.5"; });
      head.textContent += `  — ${decision}`;
      try {
        await rpc("approval.respond", { session_id: sessionId, approval_id: approvalId, decision });
      } catch (e) {
        addError("approval.respond failed: " + (e && e.message || e));
      }
    });
    return b;
  };
  btnRow.appendChild(mkBtn("Allow", "allow", true));
  btnRow.appendChild(mkBtn("Deny", "deny", false));
  card.appendChild(btnRow);

  row.appendChild(card);
  els.transcript.appendChild(row);
  scrollDown(true);
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
// Accumulate ALL `thinking` chunks for the current turn into ONE growing
// collapsible block (collapsed by default; click the header to expand). The
// first chunk builds the DOM + starts the "Thinking… Ns" ticker; every chunk
// (including the first) appends to thinkingText and re-renders the body.
function appendThinking(chunk) {
  if (!thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking collapsed";

    thinkingHeadEl = document.createElement("div");
    thinkingHeadEl.className = "thinking-head";
    const toggle = document.createElement("span");
    toggle.className = "thinking-toggle";
    toggle.textContent = "▾";
    const label = document.createElement("span");
    label.className = "thinking-label";
    label.textContent = "Thinking… 0s";
    thinkingHeadEl.appendChild(toggle);
    thinkingHeadEl.appendChild(label);
    thinkingHeadEl.addEventListener("click", () => thinkingEl.classList.toggle("collapsed"));

    thinkingBodyEl = document.createElement("div");
    thinkingBodyEl.className = "thinking-body";

    thinkingEl.appendChild(thinkingHeadEl);
    thinkingEl.appendChild(thinkingBodyEl);
    els.transcript.appendChild(thinkingEl);

    thinkingStartTs = Date.now();
    thinkingTicker = setInterval(() => {
      label.textContent = `Thinking… ${Math.floor((Date.now() - thinkingStartTs) / 1000)}s`;
    }, 1000);
  }
  thinkingText += chunk;
  thinkingBodyEl.textContent = thinkingText;
  scrollDown();
}

// Stop the live ticker and freeze the label to "Thought for Ns" — called at
// every point a new turn segment starts (i.e. the same sites that call
// endLiveBubble(), plus the "message" case, which owns its own bubble and
// never calls endLiveBubble()). The finished block is left in the transcript,
// collapsed, as the visual record — never removed.
function freezeThinking() {
  if (!thinkingEl) return;
  if (thinkingTicker) { clearInterval(thinkingTicker); thinkingTicker = null; }
  const secs = Math.round((Date.now() - thinkingStartTs) / 1000);
  const label = thinkingHeadEl && thinkingHeadEl.querySelector(".thinking-label");
  if (label) label.textContent = `Thought for ${secs}s`;
  thinkingEl = null;
  thinkingBodyEl = null;
  thinkingHeadEl = null;
  thinkingText = "";
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

// ----------------------------------------------------------- widget rendering
// Renders the generative-widget DSL (the same JSON the desktop/phone render) to
// DOM. A compact subset: column/row/grid containers; text (color/size/bold/
// italic/strike/weight/align), badge, divider, spacer, rect, progress, list,
// link, image, button (action {send|skill}), and svg. Stable id -> replace.
const widgetEls = new Map(); // id -> row element

function asArray(v) { return Array.isArray(v) ? v : (v && typeof v === "object" && v.length !== undefined ? Array.from(v) : []); }

function renderWidgetNode(node) {
  if (!node || typeof node !== "object") {
    const t = document.createElement("span"); t.textContent = node == null ? "" : String(node); return t;
  }
  const type = node.type || "text";
  const px = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v) + "px");
  if (type === "column" || type === "row" || type === "grid") {
    const el = document.createElement("div");
    el.style.display = type === "grid" ? "grid" : "flex";
    if (type === "row") el.style.flexDirection = "row";
    else if (type === "column") el.style.flexDirection = "column";
    if (type === "grid") el.style.gridTemplateColumns = `repeat(${Math.max(1, Number(node.cols) || 2)}, 1fr)`;
    el.style.gap = px(node.gap, "6px");
    if (node.pad != null) el.style.padding = px(node.pad, "0");
    if (node.bg) el.style.background = node.bg;
    if (node.radius != null) el.style.borderRadius = px(node.radius, "0");
    if (node.border) el.style.border = `${px(node.borderW, "1px")} solid ${node.border}`;
    if (node.fill) el.style.width = "100%";
    if (node.w != null) el.style.width = px(node.w, "auto");
    if (node.h != null) el.style.height = px(node.h, "auto");
    asArray(node.children).forEach((c) => {
      const child = renderWidgetNode(c);
      if (c && c.grow) child.style.flex = "1";
      if (c && c.align) child.style.textAlign = c.align;
      el.appendChild(child);
    });
    return el;
  }
  if (type === "text") {
    const el = document.createElement("div");
    el.textContent = node.text == null ? "" : String(node.text);
    if (node.color) el.style.color = node.color;
    el.style.fontSize = px(node.size, "13px");
    if (node.weight) el.style.fontWeight = String(node.weight);
    else if (node.bold) el.style.fontWeight = "600";
    if (node.italic) el.style.fontStyle = "italic";
    if (node.strike) el.style.textDecoration = "line-through";
    if (node.mono) el.style.fontFamily = "ui-monospace, monospace";
    if (node.align) el.style.textAlign = node.align;
    return el;
  }
  if (type === "badge") {
    const el = document.createElement("span");
    el.textContent = node.text || "";
    el.style.cssText = `display:inline-block;padding:1px 8px;border-radius:6px;font-size:11px;background:rgba(61,214,255,.15);color:${node.color || "#3DD6FF"}`;
    return el;
  }
  if (type === "divider") {
    const el = document.createElement("div");
    el.style.cssText = `height:1px;width:100%;background:${node.color || "#1E2C3B"};margin:2px 0`;
    return el;
  }
  if (type === "spacer") {
    const el = document.createElement("div");
    if (node.grow) el.style.flex = "1"; else el.style.height = px(node.size, "8px");
    return el;
  }
  if (type === "rect") {
    const el = document.createElement("div");
    el.style.cssText = `width:${px(node.w, "40px")};height:${px(node.h, "40px")};border-radius:${px(node.radius, "0")};background:${node.color || "#3DD6FF"}`;
    return el;
  }
  if (type === "progress") {
    let v = Number(node.value) || 0; if (v > 1) v = v / 100; v = Math.max(0, Math.min(1, v));
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;height:8px;border-radius:50px;background:#142233;overflow:hidden";
    const bar = document.createElement("div");
    bar.style.cssText = `height:100%;width:${(v * 100).toFixed(0)}%;background:${node.color || "#3DD6FF"}`;
    wrap.appendChild(bar); return wrap;
  }
  if (type === "list") {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;flex-direction:column;gap:6px";
    asArray(node.rows).forEach((r) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:8px;font-size:12px";
      const left = document.createElement("span"); left.textContent = (r && r.text) || "";
      const right = document.createElement("span"); right.textContent = (r && (r.badge || r.sub)) || "";
      right.style.color = (r && r.color) || "#93A7B8";
      row.appendChild(left); row.appendChild(right); el.appendChild(row);
    });
    return el;
  }
  if (type === "link") {
    const el = document.createElement("a");
    el.textContent = node.text || node.url || "link"; el.href = node.url || "#"; el.target = "_blank";
    el.style.color = "#5B8CFF"; return el;
  }
  if (type === "image") {
    const el = document.createElement("img");
    // Scheme allow-list mirrors desktop/QML, web, and Android: only inline
    // data:image/ and network http(s) — never file:// or other schemes a
    // prompt-injected model could use to read a local file onto the panel
    // (or beacon via a non-image URL).
    const u = node.url || "";
    const safe = /^data:image\//i.test(u) || /^https?:\/\//i.test(u);
    el.src = safe ? u : ""; if (node.w) el.style.width = px(node.w, "auto"); if (node.h) el.style.height = px(node.h, "auto");
    el.style.maxWidth = "100%"; return el;
  }
  if (type === "button") {
    const el = document.createElement("button");
    el.textContent = node.text || "Button";
    el.style.cssText = "padding:5px 12px;border-radius:8px;border:1px solid rgba(61,214,255,.4);background:rgba(61,214,255,.12);color:#3DD6FF;cursor:pointer;font-size:12px";
    el.addEventListener("click", () => {
      const a = node.action || {};
      if (a.send) { els.input.value = String(a.send); doSend(); }
      else if (a.skill) { els.input.value = "/" + a.skill + (a.args ? " " + a.args : ""); doSend(); }
    });
    return el;
  }
  if (type === "svg") {
    // Widget content isn't trusted the way it once was assumed to be — raw
    // innerHTML would let a <script>/onerror/onload in the markup execute
    // with this side panel's own privileged extension origin. Route through
    // an <img> data URI instead: browsers never run script or fire
    // event-handler attributes for SVG loaded as an image resource, so this
    // strips the executable subset while still rendering shapes/paths/
    // gradients/text pixel-identically. Mirrors the desktop WidgetRenderer's
    // data:image/svg+xml Image source.
    const svgText = String(node.svg || "");
    const el = document.createElement("img");
    el.alt = "";
    el.style.maxWidth = "100%";
    if (node.w != null) el.style.width = px(node.w, "auto");
    if (node.h != null) el.style.height = px(node.h, "auto");
    if (svgText) {
      try {
        el.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgText)));
      } catch (e) { /* malformed markup -> leave src unset */ }
    }
    return el;
  }
  // pager/canvas and unknown -> render children if any, else a small label.
  if (node.children) { const el = document.createElement("div"); asArray(node.children).forEach((c) => el.appendChild(renderWidgetNode(c))); return el; }
  const el = document.createElement("div"); el.textContent = node.type || ""; return el;
}

function renderWidget(data) {
  let spec = data.spec;
  if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch (e) { return; } }
  if (!spec) return;
  const id = data.id || ("w" + Date.now());
  // Replace in place if this id already rendered.
  const existing = widgetEls.get(id);
  const card = document.createElement("div");
  card.className = "widget-card";
  card.style.cssText = "margin:6px 0;padding:10px;border:1px solid #16232E;border-radius:12px;background:#0C141C";
  if (data.title) {
    const h = document.createElement("div");
    h.textContent = data.title;
    h.style.cssText = "font-size:10px;letter-spacing:1.4px;color:#7FF4FF;margin-bottom:6px;text-transform:uppercase";
    card.appendChild(h);
  }
  card.appendChild(renderWidgetNode(spec));
  if (existing && existing.parentElement) {
    existing.replaceWith(card);
  } else {
    const row = document.createElement("div");
    row.className = "row left";
    row.appendChild(card);
    els.transcript.appendChild(row);
  }
  widgetEls.set(id, card);
  scrollDown();
}

function removeWidget(id) {
  const el = widgetEls.get(id);
  if (el) { const row = el.closest(".row") || el; row.remove(); widgetEls.delete(id); }
}

// ----- PLAN panel (the model's todo checklist, pinned above the transcript) --
let planDismissed = false;

function renderPlan(data) {
  let spec = data.spec;
  if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch (e) { return; } }
  if (!spec) return;
  planDismissed = false;
  els.planBody.innerHTML = "";
  // The todo spec is a column: [header row (title + "done/total" badge),
  // divider, then one row per item]. Render items as clean plan rows; pull the
  // count out of the badge for the header. We walk the spec instead of using the
  // generic widget renderer so the plan reads as a checklist, not a raw card.
  const kids = asArray(spec.children);
  let count = "";
  const items = [];
  for (const k of kids) {
    if (k && k.type === "row" && Array.isArray(k.children)) {
      // header row carries a badge with "done/total"
      const badge = k.children.find((c) => c && c.type === "badge");
      if (badge && /\d+\s*\/\s*\d+/.test(String(badge.text || ""))) { count = String(badge.text); continue; }
      // item row: [glyph text, label text]
      const texts = k.children.filter((c) => c && c.type === "text");
      if (texts.length >= 2) {
        const label = String(texts[texts.length - 1].text || "");
        const strike = !!texts[texts.length - 1].strike;
        const glyph = String(texts[0].text || "○");
        let status = "pending";
        if (strike || glyph === "✓" || glyph === "✔") status = "done";
        else if (texts[texts.length - 1].weight >= 700) status = "in_progress";
        items.push({ label, status, glyph });
      }
    }
  }
  if (items.length === 0) { dismissPlan(); return; }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "plan-item " + it.status;
    const box = document.createElement("span");
    box.className = "box";
    box.textContent = it.status === "done" ? "✓" : (it.status === "in_progress" ? "◔" : "○");
    const lab = document.createElement("span");
    lab.textContent = it.label;
    row.appendChild(box); row.appendChild(lab);
    els.planBody.appendChild(row);
  }
  els.planCount.textContent = count || (items.filter((i) => i.status === "done").length + "/" + items.length);
  els.planPanel.classList.remove("hidden");
}

function dismissPlan() {
  els.planPanel.classList.add("hidden");
  els.planBody.innerHTML = "";
  els.planCount.textContent = "";
}

function clearWidgets() {
  for (const [, el] of widgetEls) { const row = el.closest(".row") || el; row.remove(); }
  widgetEls.clear();
}

// ----------------------------------------------------------------- turn state
const WORK_PHRASES = [
  "Conquering the world", "Just chillin", "Pondering the universe", "Cooking", "Summoning electrons",
  "Reticulating splines", "Bending spacetime", "Consulting the oracle", "Doing crimes (legal ones)", "Vibing",
  "Untangling the matrix", "Herding photons", "Caffeinating neurons", "Computing the meaning of life", "Manifesting",
  "Hacking the mainframe", "Plotting world domination", "Aligning the stars", "Overthinking it", "Galaxy-braining",
  "Locking in", "Spinning up the hamster wheel", "Bribing the compiler", "Negotiating with the GPU", "Untangling spaghetti code",
  "Counting to infinity (twice)", "Dividing by almost-zero", "Asking the rubber duck", "Polishing the pixels", "Warming up the flux capacitor",
  "Rerouting the neutrinos", "Feeding the neural net", "Petting the algorithm", "Convincing the linter", "Wrangling tensors",
  "Buffering enthusiasm", "Defragmenting thoughts", "Compiling brilliance", "Loading the vibes", "Tuning the antennae",
  "Charging the arc reactor", "Greasing the gears", "Whispering to the kernel", "Consulting ancient scrolls", "Brewing more coffee",
  "Sharpening the pencils", "Rolling for initiative", "Aligning the chakras", "Untwisting the logic", "Counting electrons",
  "Stretching before the sprint", "Booting the brain cells", "Summoning the muse", "Crunching the numbers", "Cross-referencing the cosmos",
  "Tickling the transistors", "Asking nicely", "Reading the fine print", "Triangulating the answer", "Synthesizing wisdom",
  "Doing the math (carrying the one)", "Politely arguing with physics", "Folding the proteins", "Dusting off the manual", "Calibrating the vibes",
  "Reverse-engineering reality", "Threading the needle", "Untangling the headphones", "Chasing the bug", "Following the breadcrumbs",
  "Connecting the dots", "Spinning plates", "Juggling chainsaws (safely)", "Pondering orbs", "Decrypting the universe",
  "Loading the enthusiasm", "Looking busy", "Pretending to think", "Actually thinking", "Thinking very hard",
  "Doing a little dance", "Consulting the spreadsheet", "Counting sheep (the smart ones)", "Rebooting the imagination", "Stacking the bytes",
  "Optimizing the optimizer", "Refactoring the cosmos", "Untangling causality", "Negotiating with entropy", "Bargaining with the deadline",
  "Warming the tubes", "Spooling up", "Engaging warp drive", "Plotting a course", "Scanning the horizon",
  "Reading the room", "Doing recon", "Gathering intel", "Assembling the squad", "Sharpening the axe",
  "Filing the paperwork", "Stamping the forms", "Convincing myself", "Double-checking twice", "Triple-checking once",
  "Measuring twice, cutting once", "Untying the Gordian knot", "Solving for x", "Carrying the remainder", "Rounding up the usual suspects",
  "Herding cats", "Counting the cats", "Naming the cats", "Befriending the firewall", "Sweet-talking the database",
  "Coaxing the cache", "Flattering the framework", "Whittling the wood", "Sketching the blueprint", "Drafting the masterplan",
  "Consulting my notes", "Remembering where I put it", "Finding the thing", "Locating the other thing", "Cross-stitching the logic",
  "Knitting the threads", "Weaving the tapestry", "Tightening the bolts", "Oiling the joints", "Spinning the dials",
  "Flipping the switches", "Pulling the levers", "Pressing the big red button (carefully)", "Reading the tea leaves", "Shaking the magic 8-ball",
  "Rolling the dice", "Drawing the cards", "Casting the runes", "Channeling the energy", "Focusing the beam",
  "Adjusting the dials", "Fine-tuning the model", "Annealing the network", "Backpropagating vibes", "Gradient-descending",
  "Climbing the loss landscape", "Escaping a local minimum", "Avoiding the saddle point", "Embedding the meaning", "Tokenizing the thoughts",
  "Attention is all I need", "Sampling the distribution", "Lowering the temperature", "Raising the stakes", "Doubling down",
  "Hedging my bets", "Reading ahead", "Skipping to the good part", "Saving the best for last", "Connecting to the hive mind",
  "Pinging the satellites", "Bouncing off the moon", "Phoning a friend", "Asking the audience", "Going with my gut",
  "Trusting the process", "Embracing the chaos", "Taming the chaos", "Befriending the chaos", "Surfing the data stream",
  "Riding the wave", "Catching the current", "Sailing the seven C's", "Charting the unknown", "Mapping the territory",
  "Drawing the map", "Folding the map", "Reading the compass", "Finding true north", "Recalculating the route",
  "Taking the scenic path", "Avoiding the traffic", "Beating the rush", "Catching the train of thought", "Boarding the idea express",
  "Connecting the flights", "Packing light", "Checking the luggage", "Going through customs", "Stamping the passport",
  "Touching grass (virtually)", "Stretching the legs", "Taking a deep breath", "Centering myself", "Finding my zen",
  "Channeling my inner genius", "Unleashing the kraken", "Releasing the hounds", "Wrapping it up", "Sprinkling in some magic"
];
let workTimer = null;
function rollPhrase() {
  const work = $("workTxt");
  if (work) work.textContent = WORK_PHRASES[Math.floor(Math.random() * WORK_PHRASES.length)];
}
// Reschedule the NEXT phrase at a RANDOM time (not a fixed beat) — organic drift.
function scheduleRoll() {
  if (workTimer) clearTimeout(workTimer);
  workTimer = setTimeout(() => { rollPhrase(); scheduleRoll(); }, 5000 + Math.floor(Math.random() * 9000));
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
  scheduleRoll();   // random-interval reschedule (organic drift, not a fixed beat)
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
  if (workTimer) { clearTimeout(workTimer); workTimer = null; }
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

// Declare which session(s) this panel wants live events for, so the daemon
// scopes delivery to just that session instead of the unscoped legacy
// broadcast (every session's events sent to every unsubscribed control
// client). Mirrors Bridge.cpp's syncSubscriptions(); tolerates older daemons
// that don't implement session.subscribe (the daemon then just keeps
// broadcasting, same as before this fix). Best-effort — never blocks the UI.
function syncSessionSubscription() {
  rpc("session.subscribe", { session_ids: sessionId ? [sessionId] : [] }).catch(() => {});
}

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
  syncSessionSubscription();
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
    let list = (res && res.sessions) || [];
    // Subagent CHILD sessions are not standalone conversations — they belong to
    // their parent chat and disappear when done. Never list them as top-level
    // rows (parity with desktop SessionsPage + Android SessionsViewModel).
    list = list.filter((s) => !(s.parent_session_id && String(s.parent_session_id).length));
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
    const texts = document.createElement("div");
    texts.className = "sess-texts";
    texts.appendChild(title);
    texts.appendChild(meta);
    texts.addEventListener("click", () => pickSession(s));
    item.appendChild(texts);
    // Delete affordance (parity with desktop/Android). Two-step: first click
    // arms, second confirms — so a misclick can't nuke a thread.
    const del = document.createElement("button");
    del.className = "sess-del";
    del.textContent = "✕";
    del.title = "Delete conversation";
    let armed = false;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!armed) { armed = true; del.textContent = "Delete?"; del.classList.add("armed");
        setTimeout(() => { armed = false; del.textContent = "✕"; del.classList.remove("armed"); }, 2500); return; }
      try {
        await rpc("session.delete", { session_id: s.id });
        if (s.id === sessionId) newSession();
        loadSessions();
      } catch (err) { /* leave the row; list reloads on next open */ }
    });
    item.appendChild(del);
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
  syncSessionSubscription();
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
    freezeThinking();
    lastToolEl = null;
  }
  scrollDown(true);
}

function clearTranscript() {
  flushReveals();
  endLiveBubble();
  freezeThinking();
  lastToolEl = null;
  els.transcript.innerHTML = "";
  dismissPlan();   // the plan is per-session — never carry it into another chat
}

// "+ New": drop the session id so the next Send creates a fresh one (re-priming
// the Chrome co-worker primer), clear the transcript, refresh the list.
function newSession() {
  if (turnInFlight) doStop();
  closeSessions();
  sessionId = null;
  sessionPrimed = false;
  syncSessionSubscription();
  clearTranscript();
  addSys("New conversation — your next message starts a fresh session.");
}

// Slash commands in the side panel: /dispatch a subagent, /agents + /skills +
// /running to see them, and /<skill> args to invoke a skill. Returns true if the
// text was a slash command (so doSend stops). Mirrors desktop/phone.
async function handleSlash(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  const rest = text.slice(cmd.length).trim();
  try {
    if (cmd === "/agents") {
      const r = await rpc("agents.list", {});
      const list = r.agents || [];
      addSys(list.length
        ? "Agents:\n" + list.map((a) => `  /${a.name} — ${a.when_to_use || a.description || ""}`).join("\n")
        : "No agents yet — create one in the Agents tab on desktop/phone.");
      return true;
    }
    if (cmd === "/skills") {
      const r = await rpc("skills.list", {});
      const list = r.skills || [];
      addSys(list.length
        ? "Skills:\n" + list.map((s) => `  /${s.name} — ${s.description || ""}`).join("\n")
        : "No skills yet.");
      return true;
    }
    if (cmd === "/running") {
      const r = await rpc("agents.running", {});
      const list = (r.agents || []).filter((a) => a.running);
      addSys(list.length
        ? "Running agents:\n" + list.map((a) => `  ${a.agent} · ${short8(a.id)}`).join("\n")
        : "No agents running.");
      return true;
    }
    if (cmd === "/dispatch") {
      const agent = parts[1] || "";
      const task = rest.slice(agent.length).trim();
      if (!agent || !task) { addSys("Usage: /dispatch <agent> <task>"); return true; }
      addUser(text);
      const r = await rpc("agents.dispatch", { agent, task, parent_session_id: sessionId || undefined });
      addSys(`Dispatched ${agent} → session ${short8(r.session_id || "")}. It runs as a subagent and reports back.`);
      return true;
    }
    // /<skill> args -> invoke a skill; its rendered text becomes the next turn.
    const name = cmd.slice(1);
    if (name) {
      const r = await rpc("skills.invoke", { name, args: rest });
      const msg = r.message || "";
      if (msg) { els.input.value = msg; autosize(); await doSend(); }
      else addSys(`Invoked /${name}`);
      return true;
    }
  } catch (e) {
    addError(String((e && e.message) || e));
    return true;
  }
  return false;
}

// ------------------------------------------------- clipboard image paste (jarvis#76 bonus)
// Ctrl+V an image into the composer: it becomes a pending attachment chip and
// rides the next session.send as images:[{mime,b64}]. Vision-gated with a
// friendly inline notice — never a silent drop.
let pendingImages = [];

// Text-only model families the api brain is known NOT to see images with —
// everything else (incl. the api-brain default and Ollama llava) is assumed
// vision-capable, since daemon/ApiBrain never gates on model name and nearly
// every current model family is multimodal. Blocking is only ever a friendly
// notice (see the paste handler below) — attaching an image never silently drops.
const VISION_TEXT_ONLY = [
  "gpt-3.5", "o1-mini", "o1-preview", "text-", "davinci", "babbage", "curie",
  "ada", "code-", "whisper", "embedding", "moderation", "tts-",
  "deepseek-r1", "mistral-nemo", "mixtral", "llama-2", "llama2",
];

function supportsVision(brain, model) {
  // Mirror of the desktop predicate: codex (--image) and claude (Read tool)
  // always see images; the api brain sees images for any model EXCEPT the
  // known text-only families above (allow-unless-known-text-only, not
  // deny-unless-known-vision — the old allowlist blocked working models).
  if (brain === "codex" || brain === "claude") return true;
  const m = String(model || "").toLowerCase();
  if (!m) return true; // "" = daemon default model -> assume vision-capable
  return !VISION_TEXT_ONLY.some((p) => m.includes(p));
}

function renderImageChips() {
  let bar = $("imageChips");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "imageChips";
    bar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:4px 10px 0;";
    const composer = els.input.closest(".composer") || els.input.parentElement;
    composer.parentElement.insertBefore(bar, composer);
  }
  bar.textContent = "";
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.style.cssText = "position:relative;width:44px;height:44px;border:1px solid #2b6cb0;border-radius:6px;overflow:hidden;";
    const im = document.createElement("img");
    im.src = "data:" + img.mime + ";base64," + img.b64;
    im.style.cssText = "width:100%;height:100%;object-fit:cover;";
    const x = document.createElement("button");
    x.textContent = "\u00d7";
    x.title = "Remove image";
    x.style.cssText = "position:absolute;top:-1px;right:-1px;width:16px;height:16px;line-height:12px;padding:0;border:none;border-radius:0 0 0 6px;background:#c53030;color:#fff;cursor:pointer;font-size:11px;";
    x.addEventListener("click", () => { pendingImages.splice(i, 1); renderImageChips(); });
    chip.appendChild(im); chip.appendChild(x);
    bar.appendChild(chip);
  });
  bar.style.display = pendingImages.length ? "flex" : "none";
}

els.input.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (!item.type || !item.type.startsWith("image/")) continue;
    e.preventDefault();
    if (!supportsVision(els.brain.value, els.model ? els.model.value : "")) {
      addSys("This brain/model can't see images — switch to codex or claude (or a vision model like gpt-5.5 / gemini) and paste again.");
      return;
    }
    const file = item.getAsFile();
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const b64 = String(r.result).split(",")[1] || "";
      if (b64) { pendingImages.push({ mime: item.type, b64 }); renderImageChips(); }
    };
    r.readAsDataURL(file);
    return;
  }
});

async function doSend() {
  if (turnInFlight) return;
  const text = els.input.value.trim();
  if (!text && pendingImages.length === 0) return;
  if (!connected) { addError("Not connected to the Cindro daemon — check the control token in Options."); return; }

  // Slash command? Consume it (dispatch a subagent / list agents / invoke skill).
  if (text.startsWith("/")) {
    els.input.value = "";
    autosize();
    if (await handleSlash(text)) return;
  }

  els.input.value = "";
  autosize();
  addUser(pendingImages.length
    ? (text ? text + "\n" : "") + "\ud83d\udcce " + pendingImages.length +
      (pendingImages.length === 1 ? " image attached" : " images attached")
    : text);
  const sendImages = pendingImages.slice();
  pendingImages = [];
  renderImageChips();

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
    const sendParams = { session_id: sid, text: payload };
    if (sendImages.length) sendParams.images = sendImages;
    await rpc("session.send", sendParams);
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
  freezeThinking();
  endTurn();
  addSys("stopped");
}

// ----------------------------------------------------------------- model picker
// When the brain changes, drop the existing session so the next Send creates a
// fresh one with the chosen brain.
async function onBrainChange() {
  sessionId = null;
  endLiveBubble();
  freezeThinking();
  endTurn();
  syncSessionSubscription();
  loadModels(els.brain.value);  // repopulate models for the new brain
  addSys("brain set to " + els.brain.value + " — a new session starts on your next message");
}

// --------------------------------------------------- "/" command palette (UI)
// The Claude-Code-style menu: type "/" → a scrollable, filterable, animated list
// of COMMANDS + AGENTS + SKILLS rises above the composer. Mirrors desktop/phone.
const slashCatalog = { agents: [], skills: [], loaded: false };
let slashOpen = false;
let slashIndex = 0;
let slashResults = [];

const SLASH_COMMANDS = [
  { kind: "command", label: "/dispatch", sub: "Dispatch an agent: /dispatch <agent> <task>", insert: "/dispatch " },
  { kind: "command", label: "/agents", sub: "List your agents", insert: "/agents" },
  { kind: "command", label: "/skills", sub: "List your skills", insert: "/skills" },
  { kind: "command", label: "/running", sub: "See running agents", insert: "/running" },
  { kind: "command", label: "/new", sub: "Start a new conversation", insert: "/new" },
];

async function ensureSlashCatalog() {
  if (slashCatalog.loaded || !connected) return;
  slashCatalog.loaded = true;
  try { slashCatalog.agents = (await rpc("agents.list", {})).agents || []; } catch (e) { /* ignore */ }
  try { slashCatalog.skills = (await rpc("skills.list", {})).skills || []; } catch (e) { /* ignore */ }
}

function buildSlashResults(query) {
  const q = (query || "").toLowerCase();
  const match = (...h) => q === "" || h.some((x) => (x || "").toLowerCase().includes(q));
  const out = [];
  SLASH_COMMANDS.forEach((c) => { if (match(c.label)) out.push(c); });
  (slashCatalog.agents || []).forEach((a) => {
    if (match(a.name, a.when_to_use))
      out.push({ kind: "agent", label: "/dispatch " + a.name, sub: a.when_to_use || a.description || "", insert: "/dispatch " + a.name + " " });
  });
  (slashCatalog.skills || []).forEach((s) => {
    if (match(s.name)) out.push({ kind: "skill", label: "/" + s.name, sub: s.description || "", insert: "/" + s.name + " " });
  });
  return out;
}

function renderSlash() {
  const box = els.slashPalette;
  box.innerHTML = "";
  slashResults.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "slash-row" + (i === slashIndex ? " sel" : "");
    const ic = document.createElement("div");
    ic.className = "slash-ic " + (r.kind === "agent" ? "agent" : r.kind === "skill" ? "skill" : "");
    ic.textContent = r.kind === "agent" ? "✦" : r.kind === "skill" ? "⚡" : "›";
    const main = document.createElement("div"); main.className = "slash-main";
    const lab = document.createElement("div"); lab.className = "slash-label"; lab.textContent = r.label;
    const sub = document.createElement("div"); sub.className = "slash-sub"; sub.textContent = r.sub;
    main.appendChild(lab); if (r.sub) main.appendChild(sub);
    const grp = document.createElement("div"); grp.className = "slash-grp";
    grp.textContent = r.kind.toUpperCase();
    row.appendChild(ic); row.appendChild(main); row.appendChild(grp);
    row.addEventListener("mouseenter", () => { slashIndex = i; renderSlash(); });
    row.addEventListener("click", () => { slashIndex = i; slashAccept(); });
    box.appendChild(row);
  });
}

function openSlash(query) {
  slashResults = buildSlashResults(query);
  if (!slashResults.length) { closeSlash(); return; }
  if (slashIndex >= slashResults.length) slashIndex = 0;
  slashOpen = true;
  els.slashPalette.classList.remove("hidden");
  renderSlash();
}
function closeSlash() { slashOpen = false; els.slashPalette.classList.add("hidden"); }
function slashMove(d) { if (!slashResults.length) return; slashIndex = (slashIndex + d + slashResults.length) % slashResults.length; renderSlash(); }
function slashAccept() {
  const r = slashResults[slashIndex];
  if (!r) return;
  if (r.kind === "command" && !r.insert.endsWith(" ")) {
    // immediate command (/agents,/skills,/running,/new)
    closeSlash();
    if (r.insert === "/new") { newSession(); els.input.value = ""; }
    else { els.input.value = ""; handleSlash(r.insert); }
    autosize();
    return;
  }
  els.input.value = r.insert;   // "/dispatch name ", "/name ", "/dispatch "
  closeSlash();
  els.input.focus();
  autosize();
}

// ----------------------------------------------------------------- composer UX
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}

function onInputChanged() {
  autosize();
  const t = els.input.value;
  if (t.startsWith("/") && !t.includes(" ")) { ensureSlashCatalog().then(() => { if (els.input.value.startsWith("/") && !els.input.value.includes(" ")) openSlash(els.input.value.slice(1)); }); }
  else closeSlash();
}

els.input.addEventListener("input", onInputChanged);
els.input.addEventListener("keydown", (e) => {
  if (slashOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashMove(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashMove(-1); return; }
    if (e.key === "Tab") { e.preventDefault(); slashAccept(); return; }
    if (e.key === "Escape") { e.preventDefault(); closeSlash(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); slashAccept(); return; }
  }
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

// PLAN panel: collapse on header click, dismiss on ✕ (stops event bubbling so
// the ✕ doesn't also toggle the collapse).
if (els.planHead) {
  els.planHead.addEventListener("click", () => els.planPanel.classList.toggle("collapsed"));
}
if (els.planDismiss) {
  els.planDismiss.addEventListener("click", (e) => { e.stopPropagation(); dismissPlan(); });
}

// Quick-flow chips (Agents / Skills / Running / Commands).
if (els.quickbar) {
  els.quickbar.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cmd = chip.getAttribute("data-cmd");
      if (cmd === "phone") {
        togglePhone();
      } else if (cmd === "slash") {
        els.input.value = "/"; els.input.focus(); onInputChanged();
      } else if (cmd) {
        handleSlash(cmd);
      }
    });
  });
}

// ================================================================= PHONE PANEL
// All phone tools reach the daemon via rpc("phone.mcp", {name, arguments}).
// The daemon proxies to the agent-phone MCP server and returns
// {tool, data, text, error?} — we surface data (parsed result) or error.

async function phoneMcp(name, args) {
  const res = await rpc("phone.mcp", { name, arguments: args || {} });
  if (res && res.error) throw new Error(res.error);
  return (res && res.data != null) ? res.data : res;
}

async function phoneHttp(method, path, body) {
  const res = await rpc("phone.http", { method, path, body });
  if (res && res.error) throw new Error(res.error);
  if (res && res.status != null && res.status >= 400) throw new Error(res.text || ("HTTP " + res.status));
  return (res && res.data != null) ? res.data : res;
}

// ---- panel / tab state ----
let phoneOpen = false;
let phoneTab = "calls"; // "calls" | "inbox" | "settings"
let callMuted = false;  // banner mute toggle (client-side only)
// ---- live transcript polling ----
let _liveTranscriptTimer  = null;
let _liveTranscriptCallId = null;

function openPhone() {
  phoneOpen = true;
  $("phonePanel").classList.remove("hidden");
  $("transcript").classList.add("hidden");
  const w = $("working"); if (w) w.classList.add("hidden");
  closeSlash();
  loadPhoneTab(phoneTab);
}

function closePhone() {
  phoneOpen = false;
  $("phonePanel").classList.add("hidden");
  $("transcript").classList.remove("hidden");
  if (turnInFlight) { const w = $("working"); if (w) w.classList.remove("hidden"); }
}

function togglePhone() { phoneOpen ? closePhone() : openPhone(); }

function setPhoneTab(tab) {
  phoneTab = tab;
  document.querySelectorAll(".phone-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-ptab") === tab);
  });
  const views = {
    calls:    "phoneViewCalls",
    agents:   "phoneViewAgents",
    inbox:    "phoneViewInbox",
    hud:      "phoneViewHud",
    settings: "phoneViewSettings"
  };
  Object.entries(views).forEach(([t, id]) => {
    const el = $(id); if (el) el.classList.toggle("hidden", t !== tab);
  });
  loadPhoneTab(tab);
}

function loadPhoneTab(tab) {
  if (tab === "calls")    { loadActiveCalls(); }
  else if (tab === "agents")   { loadAgents(); }
  else if (tab === "inbox")    { loadInbox(); }
  else if (tab === "hud")      { loadHud(); }
  else if (tab === "settings") {
    loadConnectionSettings();
    loadTwilioStatus();
    loadAllowlist();
    loadCallHistory();
    loadSmsAgentConfig();
    loadScreeningConfig();
  }
}

// ---- result helpers ----
function phoneResult(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "phone-result" + (kind ? " " + kind : "");
}

function fmtPhoneData(obj) {
  if (obj == null) return "(no data)";
  if (typeof obj === "string") return obj;
  return JSON.stringify(obj, null, 2);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- CALLS TAB ----
async function loadActiveCalls() {
  const box = $("phoneCallsList");
  if (!box) return;
  box.innerHTML = '<div class="phone-card"><div class="phone-card-meta">Loading…</div></div>';
  try {
    const data = await phoneMcp("list_active_calls");
    const calls = Array.isArray(data) ? data : [];
    renderCallsList(calls);
    updateCallBanner(calls);
    startLiveTranscript(calls);
  } catch (e) {
    box.innerHTML =
      '<div class="phone-card"><div class="phone-card-meta" style="color:var(--bad)">' +
      escHtml(e.message || String(e)) + '</div></div>';
  }
  // Screening status is loaded separately so it doesn't block the calls section.
  updateScreeningLive().catch(() => {});
}

function renderCallsList(calls) {
  const box = $("phoneCallsList"); if (!box) return;
  box.innerHTML = "";
  if (!calls.length) {
    const d = document.createElement("div"); d.className = "phone-card";
    d.innerHTML = '<div class="phone-card-meta">No active calls.</div>';
    box.appendChild(d); return;
  }
  calls.forEach((c) => {
    const card = document.createElement("div");
    card.className = "phone-card";
    const callId   = c.id || c.call_id;
    const stateClass =
      (c.state === "active" || c.state === "accepted") ? "ok" :
      (c.state === "ringing") ? "" : "bad";
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span class="phone-card-title">' + escHtml(c.reason || "Call") + '</span>' +
        '<span class="phone-card-badge ' + stateClass + '">' + escHtml(c.state || "?") + '</span>' +
      '</div>' +
      '<div class="phone-card-meta">id: ' + escHtml(callId || "?") +
        ' · ext ' + escHtml(String(c.from_extension || "?")) +
        ' → ' + escHtml(String(c.to_extension || "?")) + '</div>';
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px";

    if (c.state === "ringing") {
      // Ringing: Accept + Reject
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "phone-sm-btn ok"; acceptBtn.textContent = "✓ Accept";
      acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        try { await phoneHttp("POST", "/api/calls/" + callId + "/accept", { extension: "100" }); await loadActiveCalls(); }
        catch (e) { addSys("Accept: " + (e.message || e)); acceptBtn.disabled = false; }
      });
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "phone-sm-btn bad"; rejectBtn.textContent = "✗ Reject";
      rejectBtn.addEventListener("click", async () => {
        rejectBtn.disabled = true;
        try { await phoneHttp("POST", "/api/calls/" + callId + "/reject", { extension: "100" }); await loadActiveCalls(); }
        catch (e) { addSys("Reject: " + (e.message || e)); rejectBtn.disabled = false; }
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(rejectBtn);
    } else if (c.state === "active" || c.state === "accepted") {
      // Active: Mute toggle (client-side) + End
      let cardMuted = false;
      const muteBtn = document.createElement("button");
      muteBtn.className = "phone-sm-btn"; muteBtn.textContent = "Mute";
      muteBtn.addEventListener("click", () => {
        cardMuted = !cardMuted;
        muteBtn.textContent = cardMuted ? "Unmute" : "Mute";
        muteBtn.classList.toggle("bad", cardMuted);
      });
      const endBtn = document.createElement("button");
      endBtn.className = "phone-sm-btn bad"; endBtn.textContent = "End Call";
      endBtn.addEventListener("click", () => endPhoneCall(callId));
      actions.appendChild(muteBtn);
      actions.appendChild(endBtn);
    } else {
      // Other states: End only
      const endBtn = document.createElement("button");
      endBtn.className = "phone-sm-btn bad"; endBtn.textContent = "End Call";
      endBtn.addEventListener("click", () => endPhoneCall(callId));
      actions.appendChild(endBtn);
    }

    const txBtn = document.createElement("button");
    txBtn.className = "phone-sm-btn"; txBtn.textContent = "Transcript";
    txBtn.addEventListener("click", () => loadCallTranscript(callId));
    actions.appendChild(txBtn);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

function updateCallBanner(calls) {
  const banner = $("phoneBanner"); if (!banner) return;
  const ringing = calls.find((c) => c.state === "ringing");
  const active  = calls.find((c) => c.state === "active" || c.state === "accepted");
  const shown   = ringing || active;
  if (shown) {
    banner.classList.remove("hidden");
    $("phoneBannerLabel").textContent = ringing ? "Incoming call…" : "Call active";
    $("phoneBannerMeta").textContent  =
      (shown.reason || "") + (shown.from_extension ? "  ext " + shown.from_extension : "");
    banner.dataset.callId = shown.id || shown.call_id || "";
    const acceptBtn = $("phoneBannerAccept");
    const rejectBtn = $("phoneBannerReject");
    const muteBtn   = $("phoneBannerMute");
    if (acceptBtn) acceptBtn.style.display = ringing ? "" : "none";
    if (rejectBtn) rejectBtn.style.display = ringing ? "" : "none";
    if (muteBtn)   muteBtn.style.display   = active  ? "" : "none";
  } else {
    banner.classList.add("hidden");
    callMuted = false;
    const bm = $("phoneBannerMute");
    if (bm) { bm.textContent = "Mute"; bm.classList.remove("bad"); }
  }
}

async function endPhoneCall(callId) {
  if (!callId) return;
  try {
    await phoneMcp("end_call", { call_id: String(callId) });
    await loadActiveCalls();
  } catch (e) {
    addSys("end_call: " + (e.message || e));
  }
}

async function loadCallTranscript(callId) {
  if (!callId) return;
  const wrap = $("phoneTranscriptWrap");
  const body = $("phoneTranscriptBody");
  if (!wrap || !body) return;
  wrap.classList.remove("hidden");
  body.textContent = "Loading…";
  try {
    const data = await phoneMcp("get_call_transcript", { call_id: String(callId) });
    const lines = [];
    if (data.transcripts && data.transcripts.length) {
      data.transcripts.forEach((t) =>
        lines.push("[" + (t.speaker || t.from_extension || "?") + "] " + (t.text || "")));
    }
    if (data.messages && data.messages.length) {
      data.messages.forEach((m) => lines.push("[msg] " + (m.content || m.message || "")));
    }
    if (data.summary) {
      lines.push("\n--- Summary ---\n" +
        (typeof data.summary === "string" ? data.summary : JSON.stringify(data.summary, null, 2)));
    }
    body.textContent = lines.length ? lines.join("\n") : "No transcript yet.";
  } catch (e) {
    body.textContent = "Error: " + (e.message || e);
  }
}

// ================================================================= LIVE TRANSCRIPT POLLING
// When a call transitions to active, auto-open the transcript wrap and poll every
// 3 s so the user sees a live read-out without having to press the Transcript button.

function startLiveTranscript(calls) {
  const active = calls.find((c) => c.state === "active" || c.state === "accepted");
  const callId = active ? (active.id || active.call_id) : null;
  if (callId) {
    if (_liveTranscriptCallId !== callId) {
      _liveTranscriptCallId = callId;
      if (_liveTranscriptTimer) { clearInterval(_liveTranscriptTimer); _liveTranscriptTimer = null; }
      const wrap = $("phoneTranscriptWrap");
      if (wrap) wrap.classList.remove("hidden");
      const dot = $("phoneTranscriptLiveDot");
      if (dot) dot.classList.remove("hidden");
      refreshLiveTranscript();
    }
    if (!_liveTranscriptTimer) {
      _liveTranscriptTimer = setInterval(() => {
        // Fallback only — call_message push events drive the live view now.
        if (phoneTab === "calls" && phoneOpen) refreshLiveTranscript();
      }, 15000);
    }
  } else {
    if (_liveTranscriptTimer) { clearInterval(_liveTranscriptTimer); _liveTranscriptTimer = null; }
    _liveTranscriptCallId = null;
    const dot = $("phoneTranscriptLiveDot");
    if (dot) dot.classList.add("hidden");
  }
}

async function refreshLiveTranscript() {
  if (!_liveTranscriptCallId) return;
  const body = $("phoneTranscriptBody");
  if (!body) return;
  try {
    const data = await phoneMcp("get_call_transcript", { call_id: String(_liveTranscriptCallId) });
    const lines = [];
    if (data.transcripts && data.transcripts.length) {
      data.transcripts.forEach((t) =>
        lines.push("[" + (t.speaker || t.from_extension || "?") + "] " + (t.text || "")));
    }
    if (data.messages && data.messages.length) {
      data.messages.forEach((m) => lines.push("[msg] " + (m.content || m.message || "")));
    }
    if (data.summary) {
      lines.push("\n--- Summary ---\n" +
        (typeof data.summary === "string" ? data.summary : JSON.stringify(data.summary, null, 2)));
    }
    body.textContent = lines.length ? lines.join("\n") : "No transcript yet.";
    body.scrollTop = body.scrollHeight;
  } catch (e) { /* keep stale transcript on transient error */ }
}

// ================================================================= LIVE SCREENING STATUS
// Polls twilio_status.screening to show a live caller transcript and expose the
// Take Over / End Screening buttons whenever call-screening is active.

async function updateScreeningLive() {
  const section = $("phoneScreeningLive"); if (!section) return;
  try {
    const data = await phoneMcp("twilio_status");
    const sc = data.screening;
    if (sc && sc.active) {
      section.classList.remove("hidden");
      section.dataset.callId = sc.call_id || "";
      const info = $("phoneScreeningInfo");
      if (info) {
        info.textContent = [
          sc.caller_number   ? "Caller: "    + sc.caller_number   : null,
          sc.caller_name     ? "Name: "      + sc.caller_name     : null,
          sc.agent_extension ? "Agent ext: " + sc.agent_extension : null,
        ].filter(Boolean).join("\n") || "Screening in progress";
      }
      const tx = $("phoneScreeningTranscript");
      if (tx && Array.isArray(sc.transcript)) {
        tx.textContent = sc.transcript
          .map((t) => "[" + (t.speaker || "?") + "] " + (t.text || t.body || ""))
          .join("\n") || "(no transcript yet)";
        tx.scrollTop = tx.scrollHeight;
      }
      const taBtn = $("phoneScreeningTakeOver");
      const enBtn = $("phoneScreeningEndBtn");
      if (taBtn) taBtn.disabled = !sc.call_id;
      if (enBtn) enBtn.disabled = !sc.call_id;
    } else {
      section.classList.add("hidden");
    }
  } catch (e) {
    const sec = $("phoneScreeningLive"); if (sec) sec.classList.add("hidden");
  }
}

async function doPhoneDial() {
  const target = dialTarget || "";
  const modeEl = $("phoneDialMode");
  const mode   = (modeEl && modeEl.value) || "extension";
  const reason = (($("phoneDialReason") && $("phoneDialReason").value) || "").trim();
  const say    = (($("phoneDialSay")    && $("phoneDialSay").value)    || "").trim();
  const toNum  = (($("phoneToNumber")   && $("phoneToNumber").value)   || "").trim();
  const btn    = $("phoneDialBtn");

  if (!target) {
    phoneResult("phoneDialResult", "Enter a number or tap an extension chip.", "bad"); return;
  }

  if (mode === "extension") {
    // Direct extension call — no reason/say needed.
    const ext = parseInt(target, 10);
    if (isNaN(ext)) {
      phoneResult("phoneDialResult", "Extension must be a number (e.g. 101).", "bad"); return;
    }
    phoneResult("phoneDialResult", "Calling ext " + ext + "…", "");
    if (btn) btn.disabled = true;
    try {
      const data = await phoneMcp("call_extension", { extension: String(ext) });
      phoneResult("phoneDialResult",
        (data.ok !== false)
          ? "✓ " + (data.call_id ? "call_id: " + data.call_id : "Dialing…")
          : "✗ " + (data.error || "Failed"),
        (data.ok !== false) ? "ok" : "bad");
      await loadActiveCalls();
    } catch (e) {
      phoneResult("phoneDialResult", "Error: " + (e.message || e), "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }

  if (!reason || !say) {
    phoneResult("phoneDialResult", "Reason and Say are required for in-app / PSTN calls.", "bad"); return;
  }
  phoneResult("phoneDialResult", "Dialing…", "");
  if (btn) btn.disabled = true;
  try {
    let data;
    if (mode === "twilio") {
      const args = { reason, say };
      const num = toNum || (target.startsWith("+") ? target : "");
      if (num) args.to_number = num;
      data = await phoneMcp("twilio_call_and_wait", args);
    } else {
      const fromExt = parseInt(target, 10) || 101;
      data = await phoneMcp("call_user_and_wait", { reason, say, from_extension: String(fromExt) });
    }
    phoneResult(
      "phoneDialResult",
      data.ok
        ? "✓ " + (data.user_transcript || data.decision || "Call placed")
        : "✗ " + (data.error || "Call failed"),
      data.ok ? "ok" : "bad"
    );
    await loadActiveCalls();
  } catch (e) {
    phoneResult("phoneDialResult", "Error: " + (e.message || e), "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- INBOX TAB ----
async function loadInbox() {
  const box = $("phoneInboxList"); if (!box) return;
  box.innerHTML = '<div class="phone-card"><div class="phone-card-meta">Loading…</div></div>';
  try {
    const data = await phoneMcp("list_inbox", { limit: 30 });
    // C-5: if the server returns a threads shape prefer it over flat messages.
    if (data && Array.isArray(data.threads) && data.threads.length) {
      renderThreadsList(data.threads);
    } else {
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      renderInboxList(msgs);
    }
  } catch (e) {
    box.innerHTML =
      '<div class="phone-card"><div class="phone-card-meta" style="color:var(--bad)">' +
      escHtml(e.message || String(e)) + '</div></div>';
  }
}

// C-5: render a threads-shaped inbox list (grouped by thread).
function renderThreadsList(threads) {
  const box = $("phoneInboxList"); if (!box) return;
  box.innerHTML = "";
  if (!threads.length) {
    const d = document.createElement("div"); d.className = "phone-card";
    d.innerHTML = '<div class="phone-card-meta">Inbox is empty.</div>';
    box.appendChild(d); return;
  }
  threads.forEach((t) => {
    const card = document.createElement("div");
    card.className = "phone-card";
    const unread = t.unread_count || 0;
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span class="phone-card-title">' +
          escHtml(t.subject || t.title || "(no subject)") +
        '</span>' +
        (unread ? '<span class="phone-card-badge">' + unread + ' new</span>' : '') +
      '</div>' +
      '<div class="phone-card-meta">' +
        escHtml(truncate(t.last_message || t.preview || "", 70)) +
      '</div>';
    const tid = t.thread_id || t.id;
    if (tid) {
      const btn = document.createElement("button");
      btn.className = "phone-sm-btn"; btn.style.marginTop = "4px";
      btn.textContent = "Open Thread";
      btn.addEventListener("click", () => loadThread(String(tid)));
      card.appendChild(btn);
    }
    box.appendChild(card);
  });
}

function renderInboxList(msgs) {
  const box = $("phoneInboxList"); if (!box) return;
  box.innerHTML = "";
  if (!msgs.length) {
    const d = document.createElement("div"); d.className = "phone-card";
    d.innerHTML = '<div class="phone-card-meta">Inbox is empty.</div>';
    box.appendChild(d); return;
  }
  msgs.slice(0, 30).forEach((m) => {
    const card = document.createElement("div");
    card.className = "phone-card";
    const priClass = (m.priority === "critical" || m.priority === "urgent") ? "bad" : "";
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span class="phone-card-title">' +
          escHtml(m.title || m.subject || "(no subject)") +
        '</span>' +
        '<span class="phone-card-badge ' + priClass + '">' +
          escHtml(m.status || m.priority || "") + '</span>' +
      '</div>' +
      '<div class="phone-card-meta">' +
        escHtml(truncate(m.message || m.body || "", 70)) + '</div>';
    if (m.thread_id) {
      const btn = document.createElement("button");
      btn.className = "phone-sm-btn"; btn.style.marginTop = "4px";
      btn.textContent = "Thread";
      btn.addEventListener("click", () => loadThread(String(m.thread_id)));
      card.appendChild(btn);
    }
    box.appendChild(card);
  });
}

// C-3: render thread as chat bubbles (inbound left / outbound right).
// from_extension === "101" = outbound (right, cyan tint).
async function loadThread(threadId) {
  const wrap = $("phoneThreadWrap");
  const body = $("phoneThreadBody");
  if (!wrap || !body) return;
  wrap.classList.remove("hidden");
  body.className = "phone-bubble-wrap";
  body.innerHTML = '<div class="phone-card-meta" style="padding:4px 0">Loading…</div>';
  const replyBar = $("phoneThreadReplyBar");
  if (replyBar) replyBar.classList.add("hidden");
  try {
    const data = await phoneMcp("get_thread_messages", { thread_id: threadId });
    const msgs = Array.isArray(data) ? data : (data.messages || data || []);
    if (!Array.isArray(msgs) || !msgs.length) {
      body.innerHTML = '<div class="phone-card-meta" style="padding:4px 0">No messages in thread.</div>';
      return;
    }
    body.innerHTML = "";
    msgs.forEach((m) => {
      const isOut = String(m.from_extension) === "101" || m.from_type === "agent";
      const bubble = document.createElement("div");
      bubble.className = "phone-bubble " + (isOut ? "out" : "in");
      let inner = "";
      if (m.title) inner += '<div class="phone-bubble-title">' + escHtml(m.title) + '</div>';
      inner += '<div>' + escHtml(m.message || m.body || "") + '</div>';
      const replyStr = m.reply_text || m.response_text;
      if (replyStr) inner += '<div class="phone-bubble-reply">↪ ' + escHtml(replyStr) + '</div>';
      if (m.selected_option) inner += '<div class="phone-bubble-meta" style="color:var(--ok)">✓ ' + escHtml(m.selected_option) + '</div>';
      inner +=
        '<div class="phone-bubble-meta">ext ' +
        escHtml(String(m.from_extension || "?")) + ' → ' +
        escHtml(String(m.to_extension   || "?")) +
        (m.status ? ' · ' + escHtml(m.status) : '') + '</div>';
      bubble.innerHTML = inner;
      body.appendChild(bubble);
    });
    body.scrollTop = body.scrollHeight;
    // Show reply bar for the most recent pending agent message requiring a response.
    const pendingMsg = msgs.slice().reverse().find((m) =>
      m.requires_response && m.status !== "replied" && m.status !== "expired" &&
      (m.from_type === "agent" || String(m.from_extension) !== "100")
    );
    if (pendingMsg) renderThreadReplyBar(pendingMsg, threadId);
  } catch (e) {
    body.innerHTML =
      '<div class="phone-card-meta" style="color:var(--bad);padding:4px 0">Error: ' +
      escHtml(e.message || String(e)) + '</div>';
  }
}

// Render the response-option buttons and free-text reply input for a pending message.
function renderThreadReplyBar(msg, threadId) {
  const replyBar = $("phoneThreadReplyBar"); if (!replyBar) return;
  replyBar.classList.remove("hidden");
  replyBar.dataset.msgId    = msg.id        || "";
  replyBar.dataset.threadId = threadId      || msg.thread_id || "";
  const optBox = $("phoneThreadOptions"); if (!optBox) return;
  optBox.innerHTML = "";
  const LABELS  = {
    approve:     "✓ Approve",  deny:      "✗ Deny",
    call_again:  "📞 Call Back", mute_30_min: "🔕 Mute 30m",
    yes:         "✓ Yes",      no:        "✗ No",
    dismiss:     "Dismiss",    got_it:    "Got it"
  };
  const CLASSES = { approve:"ok", yes:"ok", deny:"bad", no:"bad", reject:"bad" };
  const opts = Array.isArray(msg.response_options) ? msg.response_options : [];
  opts.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "phone-sm-btn " + (CLASSES[opt] || "");
    btn.textContent = LABELS[opt] || opt;
    btn.addEventListener("click", async () => {
      const mid = replyBar.dataset.msgId;
      const tid = replyBar.dataset.threadId;
      if (!mid) return;
      btn.disabled = true;
      try {
        await phoneHttp("POST", "/api/messages/" + mid + "/reply", { selected_option: opt });
        phoneResult("phoneThreadReplyResult", "✓ " + (LABELS[opt] || opt), "ok");
        if (tid) setTimeout(() => loadThread(tid), 600);
      } catch (e) {
        phoneResult("phoneThreadReplyResult", "✗ " + (e.message || e), "bad");
        btn.disabled = false;
      }
    });
    optBox.appendChild(btn);
  });
  // Replace send button to clear any previous listeners
  const oldSend = $("phoneThreadReplySend");
  if (oldSend && oldSend.parentNode) {
    const newSend = oldSend.cloneNode(true);
    oldSend.parentNode.replaceChild(newSend, oldSend);
    newSend.addEventListener("click", async () => {
      const mid  = replyBar.dataset.msgId;
      const tid  = replyBar.dataset.threadId;
      const rtEl = $("phoneThreadReplyText");
      const text = (rtEl && rtEl.value || "").trim();
      if (!mid || !text) return;
      newSend.disabled = true;
      try {
        await phoneHttp("POST", "/api/messages/" + mid + "/reply", { response_text: text });
        phoneResult("phoneThreadReplyResult", "✓ Reply sent", "ok");
        if (rtEl) rtEl.value = "";
        if (tid) setTimeout(() => loadThread(tid), 600);
      } catch (e) {
        phoneResult("phoneThreadReplyResult", "✗ " + (e.message || e), "bad");
        newSend.disabled = false;
      }
    });
  }
}

async function doCompose() {
  const title   = ($("phoneComposeTitle").value || "").trim();
  const message = ($("phoneComposeBody").value  || "").trim();
  const wait    = $("phoneComposeWait").checked;
  if (!title || !message) {
    phoneResult("phoneComposeResult", "Title and body required.", "bad"); return;
  }
  phoneResult("phoneComposeResult", "Sending…", "");
  $("phoneComposeBtn").disabled = true;
  try {
    const tool = wait ? "notify_user_and_wait" : "notify_user";
    const data = await phoneMcp(tool, { title, message, priority: "normal" });
    phoneResult(
      "phoneComposeResult",
      data.ok
        ? "✓ " + (wait
            ? (data.replied ? "Reply: " + (data.reply_text || "") : "No reply (yet)")
            : "Sent  thread:" + (data.thread_id || ""))
        : "✗ " + (data.error || "Failed"),
      data.ok ? "ok" : "bad"
    );
    if (data.ok) { $("phoneComposeTitle").value = ""; $("phoneComposeBody").value = ""; }
    await loadInbox();
  } catch (e) {
    phoneResult("phoneComposeResult", "Error: " + (e.message || e), "bad");
  } finally {
    $("phoneComposeBtn").disabled = false;
  }
}

// ---- SETTINGS TAB ----
async function loadTwilioStatus() {
  const box = $("phoneTwilioStatus"); if (!box) return;
  box.textContent = "Loading…";
  try {
    const d = await phoneMcp("twilio_status");
    box.textContent = [
      "configured : " + (d.configured    ? "✓ yes" : "✗ no"),
      "from_number: " + (d.from_number   || "—"),
      "screening  : " + (d.screening_enabled ? "enabled"  : "disabled"),
      "sms_agent  : " + (d.sms_agent_enabled ? "enabled"  : "disabled"),
      "bridge     : " + (d.bridge        || "—"),
    ].join("\n");
    const badge = $("phoneScreeningBadge");
    if (badge) {
      badge.textContent  = d.screening_enabled ? "enabled" : "disabled";
      badge.className    = "phone-badge " + (d.screening_enabled ? "ok" : "bad");
    }
  } catch (e) {
    box.textContent = "Error: " + (e.message || e);
  }
}

async function loadAllowlist() {
  const box = $("phoneAllowlist"); if (!box) return;
  box.innerHTML = '<div class="phone-card"><div class="phone-card-meta">Loading…</div></div>';
  try {
    const data = await phoneMcp("twilio_allowlist_list");
    const numbers = Array.isArray(data.numbers) ? data.numbers : [];
    box.innerHTML = "";
    if (!numbers.length) {
      const d = document.createElement("div"); d.className = "phone-card";
      d.innerHTML = '<div class="phone-card-meta">No numbers allowlisted.</div>';
      box.appendChild(d);
    } else {
      numbers.forEach((n) => {
        const card = document.createElement("div");
        card.className = "phone-card";
        card.style.cssText = "flex-direction:row;align-items:center;gap:8px";
        card.innerHTML =
          '<span class="phone-card-title" style="flex:1">' +
            escHtml(n.phone_number || n) + '</span>' +
          (n.label ? '<span class="phone-card-meta">' + escHtml(n.label) + '</span>' : "");
        box.appendChild(card);
      });
    }
    if (data.default_user_number) {
      const d = document.createElement("div"); d.className = "phone-card";
      d.innerHTML = '<div class="phone-card-meta">user#: ' +
        escHtml(data.default_user_number) + '</div>';
      box.appendChild(d);
    }
  } catch (e) {
    box.innerHTML =
      '<div class="phone-card"><div class="phone-card-meta" style="color:var(--bad)">' +
      escHtml(e.message || String(e)) + '</div></div>';
  }
}

async function doAllowlistAdd() {
  const num   = ($("phoneAllowlistNum").value   || "").trim();
  const label = ($("phoneAllowlistLabel").value || "").trim();
  if (!num) { phoneResult("phoneAllowlistResult", "Enter a phone number.", "bad"); return; }
  phoneResult("phoneAllowlistResult", "Adding…", "");
  try {
    const args = { phone_number: num };
    if (label) args.label = label;
    const data = await phoneMcp("twilio_allowlist_add", args);
    phoneResult("phoneAllowlistResult",
      data.ok ? "✓ Added" : "✗ " + (data.error || ""), data.ok ? "ok" : "bad");
    await loadAllowlist();
  } catch (e) { phoneResult("phoneAllowlistResult", "Error: " + (e.message || e), "bad"); }
}

async function doAllowlistRemove() {
  const num = ($("phoneAllowlistNum").value || "").trim();
  if (!num) { phoneResult("phoneAllowlistResult", "Enter a phone number to remove.", "bad"); return; }
  phoneResult("phoneAllowlistResult", "Removing…", "");
  try {
    const data = await phoneMcp("twilio_allowlist_remove", { phone_number: num });
    phoneResult("phoneAllowlistResult",
      data.ok ? "✓ Removed" : "✗ " + (data.error || ""), data.ok ? "ok" : "bad");
    await loadAllowlist();
  } catch (e) { phoneResult("phoneAllowlistResult", "Error: " + (e.message || e), "bad"); }
}

async function doSetUserNumber() {
  const num = ($("phoneUserNumber").value || "").trim();
  if (!num) { phoneResult("phoneUserNumResult", "Enter a phone number.", "bad"); return; }
  phoneResult("phoneUserNumResult", "Setting…", "");
  try {
    const data = await phoneMcp("twilio_set_user_number", { phone_number: num });
    phoneResult("phoneUserNumResult",
      data.ok ? "✓ " + (data.default_user_number || num) : "✗ " + (data.error || ""),
      data.ok ? "ok" : "bad");
    await loadAllowlist();
  } catch (e) { phoneResult("phoneUserNumResult", "Error: " + (e.message || e), "bad"); }
}

async function doSetVoice() {
  const ext   = ($("phoneVoiceExt").value   || "").trim();
  const vid   = ($("phoneVoiceId").value    || "").trim();
  const speed = ($("phoneVoiceSpeed").value || "").trim();
  if (!ext) { phoneResult("phoneVoiceResult", "Extension required.", "bad"); return; }
  phoneResult("phoneVoiceResult", "Setting…", "");
  try {
    const args = { extension: String(ext) };
    if (vid)   args.voice_id = vid;
    if (speed) args.speed    = parseFloat(speed);
    const data = await phoneMcp("set_voice_profile", args);
    phoneResult("phoneVoiceResult", "✓ " + fmtPhoneData(data.voice || data), "ok");
  } catch (e) { phoneResult("phoneVoiceResult", "Error: " + (e.message || e), "bad"); }
}

async function doGetVoice() {
  const ext = ($("phoneVoiceExt").value || "").trim();
  if (!ext) { phoneResult("phoneVoiceResult", "Extension required.", "bad"); return; }
  phoneResult("phoneVoiceResult", "Loading…", "");
  try {
    const data = await phoneMcp("get_voice_profile", { extension: String(ext) });
    phoneResult("phoneVoiceResult", fmtPhoneData(data.voice || data), "");
  } catch (e) { phoneResult("phoneVoiceResult", "Error: " + (e.message || e), "bad"); }
}

async function doToggleScreening(enable) {
  try {
    await phoneMcp(enable ? "twilio_screening_enable" : "twilio_screening_disable");
    await loadTwilioStatus();
  } catch (e) { addSys("Screening: " + (e.message || e)); }
}

async function doRedAlert() {
  const message = ($("phoneAlertMsg").value || "").trim();
  if (!message) { phoneResult("phoneAlertResult", "Message required.", "bad"); return; }
  if (!confirm("Broadcast RED ALERT to all agents?")) return;
  phoneResult("phoneAlertResult", "Alerting…", "");
  $("phoneRedAlert").disabled = true;
  try {
    const data = await phoneMcp("red_alert", { message });
    phoneResult("phoneAlertResult", "✓ " + fmtPhoneData(data), "ok");
  } catch (e) {
    phoneResult("phoneAlertResult", "Error: " + (e.message || e), "bad");
  } finally {
    $("phoneRedAlert").disabled = false;
  }
}

// ================================================================= PHONE PANEL EXTENSIONS

// ---- helper: convert ext string to the right type for phoneMcp args ----
function _extArg(ext) {
  // Phone MCP tools (zString) + REST routes all expect the extension as a STRING.
  return String(ext);
}

// ---- dialer state ----
let dialTarget = "101";

function dialPad_setFull(v) {
  dialTarget = String(v || "");
  const el = $("dialDisplay");
  if (el) el.textContent = dialTarget || "•";
}

function dialPad_append(digit) {
  if (dialTarget.length >= 12) return;
  dialTarget = dialTarget + digit;
  const el = $("dialDisplay");
  if (el) el.textContent = dialTarget || "•";
}

function dialPad_backspace() {
  dialTarget = dialTarget.slice(0, -1);
  const el = $("dialDisplay");
  if (el) el.textContent = dialTarget || "•";
}

// ================================================================= AGENTS TAB

let agentConfigState = {
  ext: null, name: null,
  voiceId: null, speed: 1.0,
  model: null, reasoning: null,
  voices: []
};

async function loadAgents() {
  const box = $("phoneAgentsList"); if (!box) return;
  box.innerHTML = '<div class="phone-card"><div class="phone-card-meta">Loading…</div></div>';
  try {
    const data = await phoneMcp("list_agents");
    const agents = Array.isArray(data) ? data : (data.agents || data.extensions || []);
    renderAgentsList(agents);
  } catch (e) {
    box.innerHTML =
      '<div class="phone-card"><div class="phone-card-meta" style="color:var(--bad)">' +
      escHtml(e.message || String(e)) + '</div></div>';
  }
}

function renderAgentsList(agents) {
  const box = $("phoneAgentsList"); if (!box) return;
  box.innerHTML = "";
  if (!agents.length) {
    const d = document.createElement("div"); d.className = "phone-card";
    d.innerHTML = '<div class="phone-card-meta">No agents registered — run dev-fix-empty-extensions.sh on the server.</div>';
    box.appendChild(d); return;
  }
  agents.forEach((a) => {
    const ext    = String(a.extension || a.ext || "");
    const name   = String(a.name || a.agent_name || "Agent");
    const status = String(a.status || "offline");
    const task   = String(a.current_task || a.task || "");
    const online = status === "online";

    const card = document.createElement("div");
    card.className = "phone-card";
    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span class="phone-card-title">' + escHtml(name) + '</span>' +
        '<span class="phone-card-badge ' + (online ? "ok" : "") + '">' + escHtml(status) + '</span>' +
        '<span class="phone-card-meta" style="margin-left:auto">' + escHtml(ext) + '</span>' +
      '</div>' +
      '<div class="phone-card-meta">' + escHtml(truncate(task || "No current task", 58)) + '</div>';
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;margin-top:6px";
    const callBtn = document.createElement("button");
    callBtn.className = "phone-sm-btn" + (online ? " ok" : "");
    callBtn.textContent = "☎ Call";
    callBtn.addEventListener("click", () => {
      dialPad_setFull(ext);
      setPhoneTab("calls");
    });
    const cfgBtn = document.createElement("button");
    cfgBtn.className = "phone-sm-btn";
    cfgBtn.textContent = "⚙ Config";
    cfgBtn.addEventListener("click", () => openAgentConfig(ext, name));
    actions.appendChild(callBtn); actions.appendChild(cfgBtn);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

async function openAgentConfig(ext, name) {
  agentConfigState = { ext, name, voiceId: null, speed: 1.0, model: null, reasoning: null, voices: [] };

  const listView = $("agentListView"); if (listView) listView.classList.add("hidden");
  const cfgView  = $("agentConfigView"); if (cfgView) cfgView.classList.remove("hidden");
  const nameEl   = $("agentConfigName"); if (nameEl) nameEl.textContent = name;
  const extEl    = $("agentConfigExt");  if (extEl)  extEl.textContent  = "ext " + ext;
  const resultEl = $("agentConfigResult"); if (resultEl) resultEl.textContent = "";

  // Load voice profile for this extension.
  const voiceCurrent = $("agentVoiceCurrent");
  if (voiceCurrent) voiceCurrent.textContent = "Loading voice profile…";
  try {
    const vp = await phoneHttp("GET", "/api/extensions/" + ext + "/voice");
    agentConfigState.voiceId = vp.voice_id || null;
    agentConfigState.speed   = typeof vp.speed === "number" ? vp.speed : 1.0;
    if (voiceCurrent) voiceCurrent.textContent = "Current: " + (vp.voice_id || "Default");
    const slider = $("agentSpeedSlider"); if (slider) slider.value = agentConfigState.speed;
    const sv     = $("agentSpeedValue");  if (sv)     sv.textContent = agentConfigState.speed.toFixed(2) + "×";
  } catch (e) {
    if (voiceCurrent) voiceCurrent.textContent = "Voice unavailable: " + (e.message || e);
  }

  // Load available voices — try MCP first, fall back to known list.
  const knownVoices = [
    { id: null,               name: "Default" },
    { id: "local:jarvis",     name: "Cindro (on-device)" },
    { id: "paul-cheerful",    name: "Paul - Cheerful" },
    { id: "paul-neutral",     name: "Paul - Neutral" },
    { id: "paul-sad",         name: "Paul - Sad" },
    { id: "oliver-cheerful",  name: "Oliver - Cheerful" },
    { id: "oliver-neutral",   name: "Oliver - Neutral" },
    { id: "jane-cheerful",    name: "Jane - Cheerful" },
    { id: "jane-neutral",     name: "Jane - Neutral" },
    { id: "marie-cheerful",   name: "Marie - Cheerful" },
    { id: "marie-neutral",    name: "Marie - Neutral" }
  ];
  let voices = knownVoices;
  try {
    const vd = await phoneHttp("GET", "/api/voices");
    const arr = Array.isArray(vd) ? vd : (vd && Array.isArray(vd.voices) ? vd.voices : null);
    if (arr && arr.length) voices = arr;
  } catch (_) { /* use known list */ }
  agentConfigState.voices = voices;

  const voiceGroupsEl = $("agentVoiceGroups");
  if (voiceGroupsEl) renderVoiceGroups(voiceGroupsEl, voices, agentConfigState.voiceId);

  // Load model / reasoning config.
  try {
    const mc = await phoneHttp("GET", "/api/extensions/" + ext + "/model");
    agentConfigState.model     = mc.model     || null;
    agentConfigState.reasoning = mc.reasoning || null;
  } catch (_) { /* no model config yet — use defaults */ }
  await renderAgentModelSection(name, ext);
}

function closeAgentConfig() {
  const listView = $("agentListView"); if (listView) listView.classList.remove("hidden");
  const cfgView  = $("agentConfigView"); if (cfgView) cfgView.classList.add("hidden");
}

function renderVoiceGroups(container, voices, selectedId) {
  container.innerHTML = "";
  // Group voices by speaker name (everything before " - " or " (").
  const groups = {};
  voices.forEach((v) => {
    const id   = v.id !== undefined ? v.id : v.voice_id;
    const name = v.name || (id ? String(id) : "Default");
    const key  = id === null
      ? "Default"
      : (name.includes(" - ")
          ? name.split(" - ")[0].trim()
          : name.split(" (")[0].trim());
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id, name });
  });
  Object.entries(groups).forEach(([speaker, opts]) => {
    const groupEl = document.createElement("div");
    groupEl.className = "voice-group";
    const labelEl = document.createElement("div");
    labelEl.className = "voice-group-label";
    labelEl.textContent = speaker;
    const chipsEl = document.createElement("div");
    chipsEl.style.cssText = "display:flex;flex-wrap:wrap;gap:5px";
    opts.forEach((o) => {
      const chipLabel = o.name.includes(" - ")
        ? o.name.split(" - ").slice(1).join(" - ").trim()
        : (o.name.includes(" (") ? o.name.split(" (")[0].trim() : o.name);
      const chip = document.createElement("button");
      chip.className = "config-chip" + (o.id === selectedId ? " selected" : "");
      chip.textContent = chipLabel;
      chip.addEventListener("click", () => {
        agentConfigState.voiceId = o.id;
        container.querySelectorAll(".config-chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
        const vc = $("agentVoiceCurrent");
        if (vc) vc.textContent = "Current: " + (o.id || "Default");
        if (!agentConfigState.ext) return;
        const body = {};
        if (o.id) body.voiceId = o.id;
        phoneHttp("PUT", "/api/extensions/" + agentConfigState.ext + "/voice", body).catch((e) => {
          const r = $("agentConfigResult");
          if (r) { r.textContent = "Voice error: " + (e.message || e); r.className = "phone-result bad"; }
        });
      });
      chipsEl.appendChild(chip);
    });
    groupEl.appendChild(labelEl);
    groupEl.appendChild(chipsEl);
    container.appendChild(groupEl);
  });
}

// Which daemon brain (if any) an agent's model picker should query via
// model.list — codex/claude only; other extensions (Copilot, Echo, Hermes,
// Mistral Screener, ...) have no selectable Jarvis-brain model. Mirrors
// android AgentConfigScreen.kt's brainFor() and tui/src/phone/api.ts's
// brainForAgent() — keep all three in sync if the naming convention changes.
function brainForAgent(agentName) {
  const lc = (agentName || "").toLowerCase();
  if (lc.includes("claude")) return "claude";
  if (lc.includes("codex") || lc.includes("gpt")) return "codex";
  return null;
}

async function renderAgentModelSection(agentName, ext) {
  const section = $("agentModelSection"); if (!section) return;
  const brain = brainForAgent(agentName);
  if (!brain) { section.classList.add("hidden"); return; }

  // Live model ids for this agent's brain, same model.list RPC loadModels()
  // uses for the main picker — replaces the old hardcoded per-brain option
  // arrays, which went stale the same way the main picker's used to before
  // it was wired to model.list.
  let modelIds = [];
  try {
    const res = await rpc("model.list", { brain });
    modelIds = ((res && res.models) || []).map((m) => (typeof m === "string" ? m : (m && (m.id || m.model)))).filter(Boolean);
  } catch (_) { /* leave modelIds empty — section stays hidden below */ }

  // The user may have opened a DIFFERENT agent while this await was in
  // flight — agentConfigState.ext would then no longer match, and applying
  // this response now would silently wire the wrong brain's model ids to
  // whatever agent is currently on screen.
  if (agentConfigState.ext !== ext) return;

  if (!modelIds.length) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");

  const modelChipsEl = $("agentModelChips"); if (!modelChipsEl) return;
  modelChipsEl.innerHTML = "";
  const currentModel = agentConfigState.model || modelIds[0];
  modelIds.forEach((id) => {
    const chip = document.createElement("button");
    chip.className = "config-chip" + (id === currentModel ? " selected" : "");
    chip.textContent = id;
    chip.addEventListener("click", () => {
      agentConfigState.model = id;
      modelChipsEl.querySelectorAll(".config-chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      saveAgentModelConfig();
    });
    modelChipsEl.appendChild(chip);
  });

  const thinkChipsEl = $("agentThinkingChips"); if (!thinkChipsEl) return;
  thinkChipsEl.innerHTML = "";
  const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
  const currentReasoning = agentConfigState.reasoning || "low";
  THINKING_LEVELS.forEach((level) => {
    const chip = document.createElement("button");
    chip.className = "config-chip" + (level === currentReasoning ? " selected" : "");
    chip.textContent = level;
    chip.addEventListener("click", () => {
      agentConfigState.reasoning = level;
      thinkChipsEl.querySelectorAll(".config-chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      saveAgentModelConfig();
    });
    thinkChipsEl.appendChild(chip);
  });
}

async function saveAgentModelConfig() {
  if (!agentConfigState.ext) return;
  const resultEl = $("agentConfigResult");
  try {
    const body = {};
    if (agentConfigState.model)     body.model     = agentConfigState.model;
    if (agentConfigState.reasoning) body.reasoning = agentConfigState.reasoning;
    await phoneHttp("PUT", "/api/extensions/" + agentConfigState.ext + "/model", body);
    if (resultEl) { resultEl.textContent = "✓ Model config saved"; resultEl.className = "phone-result ok"; }
  } catch (e) {
    if (resultEl) {
      resultEl.textContent = "✗ " + (e.message || e);
      resultEl.className = "phone-result bad";
    }
  }
}

// TTS Audio Format setting (Settings → Connection) has no phone.env key — the
// server always returns whatever the voice sample actually is encoded as. The
// browser <audio> element can only play containerized/encoded audio (not raw
// PCM), so the format the user picked is applied here as a real gate: we map
// it to a MIME type and use canPlayType() to decide whether to attempt
// playback, instead of just storing the value and ignoring it.
const TTS_FORMAT_MIME = {
  mp3:       "audio/mpeg",
  wav:       "audio/wav",
  ogg_opus:  "audio/ogg; codecs=opus",
  pcm_16000: "",  // raw PCM has no container — not directly playable by <audio>
  pcm_24000: ""
};

async function doPreviewVoice() {
  if (!agentConfigState.ext) return;
  const resultEl = $("agentConfigResult");
  const vid = agentConfigState.voiceId || "default";

  const { phoneAudioFormat } = await chrome.storage.local.get({ phoneAudioFormat: "pcm_16000" });
  const fmt  = (phoneAudioFormat || "pcm_16000").trim();
  const mime = Object.prototype.hasOwnProperty.call(TTS_FORMAT_MIME, fmt) ? TTS_FORMAT_MIME[fmt] : "audio/mpeg";
  if (!mime) {
    if (resultEl) {
      resultEl.textContent = "✗ " + fmt + " is raw PCM (no container) — set Settings → Connection → " +
        "TTS Audio Format to mp3, wav, or ogg_opus to preview in the browser.";
      resultEl.className = "phone-result bad";
    }
    return;
  }
  if (document.createElement("audio").canPlayType(mime) === "") {
    if (resultEl) {
      resultEl.textContent = "✗ This browser can't play " + fmt + " (" + mime + ").";
      resultEl.className = "phone-result bad";
    }
    return;
  }

  try {
    const data = await phoneHttp("GET", "/api/voices/" + encodeURIComponent(vid) + "/sample");
    const url = (data && (typeof data === "string" ? data : data.url)) || "";
    if (url) {
      try { new Audio(url).play(); } catch (_) { /* sandboxed */ }
    }
    if (resultEl) { resultEl.textContent = "▶ Playing preview (" + fmt + ")…"; resultEl.className = "phone-result ok"; }
  } catch (e) {
    if (resultEl) {
      resultEl.textContent = "✗ " + (e.message || e);
      resultEl.className = "phone-result bad";
    }
  }
}

// ================================================================= HUD TAB

async function loadHud() {
  const frame       = $("phoneHudFrame");
  const placeholder = $("phoneHudPlaceholder");
  if (!frame || !placeholder) return;
  const cfg = await chrome.storage.local.get({ phoneServerUrl: "" });
  const url = (cfg.phoneServerUrl || "").trim().replace(/\/$/, "");
  if (!url || url.includes("your-server") || url.length < 8) {
    placeholder.textContent = "Set Server URL in Settings → Connection to load the ops HUD.";
    placeholder.classList.remove("hidden");
    frame.classList.add("hidden");
    return;
  }
  const dashUrl = url + "/dashboard";
  placeholder.classList.add("hidden");
  frame.classList.remove("hidden");
  if (frame.src !== dashUrl) frame.src = dashUrl;
}

// ================================================================= SETTINGS EXPANSIONS

// ---- Connection section ----
// Server URL + audio format are extension-local prefs (chrome.storage.local —
// Server URL also drives the HUD iframe/"Open ops HUD" link). Inbound
// extension + agent token live server-side in ~/.config/jarvis/phone.env and
// are read via rpc("phone.config", ...) so this panel reflects what the
// daemon actually has, not a stale local copy. Secrets are NEVER read back —
// only has_* booleans.
// Baseline of the daemon's phone.config get, so save only writes a plain field
// the user actually changed — never the daemon's DERIVED defaults (server_url
// falls back to http://127.0.0.1:<port>, inbound_extension to "101"), which
// would otherwise freeze those keys at loopback on a first "just store my token"
// save. Mirrors the diff-on-save the desktop/web/cli surfaces use.
let _connBaseline = { serverUrl: "", ext: "101" };

async function loadConnectionSettings() {
  const cfg = await chrome.storage.local.get({
    phoneServerUrl:   "",
    phoneAudioFormat: "pcm_16000"
  });
  const u = $("connServerUrl");   if (u) u.value = cfg.phoneServerUrl;
  const f = $("connAudioFormat"); if (f) f.value = cfg.phoneAudioFormat;
  const t = $("connToken");       if (t) t.value = "";

  const statusEl = $("connStatus");
  if (statusEl) statusEl.textContent = "Loading…";
  try {
    const d = await rpc("phone.config", { action: "get" });
    const tw = d.twilio || {};
    _connBaseline = { serverUrl: d.server_url || "", ext: tw.inbound_extension || "101" };
    // The daemon's server_url is authoritative — set it UNCONDITIONALLY (not just
    // when empty) so the field equals the baseline it's diffed against on Save; a
    // stale local value must not create a spurious public_base_url write. Cache
    // it locally so the "Open ops HUD" link opens the current server URL too.
    if (u) u.value = d.server_url || "";
    chrome.storage.local.set({ phoneServerUrl: d.server_url || "" });
    const e = $("connExtension"); if (e) e.value = tw.inbound_extension || "101";
    if (t) t.placeholder = d.has_agent_token ? "•••• set (leave blank to keep)" : "not set";
    if (statusEl) {
      statusEl.textContent = [
        "phone server : " + (d.configured ? "✓ configured" : "not configured"),
        "twilio       : " + (tw.configured ? "✓ configured" : "not configured"),
        "admin token  : " + (d.has_admin_token  ? "•••• set" : "not set"),
        "device token : " + (d.has_device_token ? "•••• set" : "not set"),
        "agent token  : " + (d.has_agent_token  ? "•••• set" : "not set"),
      ].join("\n");
    }
  } catch (e) {
    if (t) t.placeholder = "not set";
    if (statusEl) statusEl.textContent = "Error: " + (e.message || e);
  }
}

async function saveConnectionSettings() {
  const url = (($("connServerUrl")   && $("connServerUrl").value)   || "").trim();
  const tok = (($("connToken")       && $("connToken").value)       || "").trim();
  const ext = (($("connExtension")   && $("connExtension").value)   || "").trim();
  const fmt = (($("connAudioFormat") && $("connAudioFormat").value) || "").trim();
  // Server URL + audio format stay local (they drive the HUD link / preview
  // gating client-side and have no phone.env key of their own).
  await chrome.storage.local.set({ phoneServerUrl: url, phoneAudioFormat: fmt });

  phoneResult("connResult", "Saving…", "");
  try {
    // Diff plain fields against the loaded baseline so an untouched/auto-derived
    // value is never persisted as an explicit phone.env key.
    const patch = {};
    if (url !== _connBaseline.serverUrl) patch.public_base_url = url;
    if (ext !== _connBaseline.ext) patch.twilio_inbound_extension = ext;
    // Only send the token when the user actually typed a new one — an empty
    // field means "leave the stored secret alone", not "clear it".
    if (tok) patch.agent_token = tok;
    if (Object.keys(patch).length === 0) {
      phoneResult("connResult", "✓ nothing changed", "ok");
      return;
    }
    const d = await rpc("phone.config", { action: "set", patch });
    if ($("connToken")) $("connToken").value = "";
    phoneResult("connResult", (d.ok ? "✓ " : "✗ ") + (d.note || "Saved"), d.ok ? "ok" : "bad");
    await loadConnectionSettings();
  } catch (e) {
    phoneResult("connResult", "✗ " + (e.message || e), "bad");
  }
}

async function testConnectionSettings() {
  phoneResult("connResult", "Testing…", "");
  try {
    const d = await rpc("phone.config", { action: "test" });
    phoneResult("connResult",
      (d.reachable ? "✓ reachable" : "✗ unreachable") +
      " · twilio " + (d.twilio_configured ? "configured" : "not configured"),
      d.reachable ? "ok" : "bad");
  } catch (e) {
    phoneResult("connResult", "✗ " + (e.message || e), "bad");
  }
}

// ---- Call History ----
async function loadCallHistory() {
  const box = $("phoneHistoryList"); if (!box) return;
  box.innerHTML = '<div class="phone-card"><div class="phone-card-meta">Loading…</div></div>';
  try {
    let calls = [];
    try {
      const d = await phoneHttp("GET", "/api/calls");
      const arr = Array.isArray(d) ? d : (d && (d.calls || d.history) ? (d.calls || d.history) : []);
      calls = arr;
    } catch (_) { /* no call history */ }
    if (!calls.length) {
      try {
        const dm = await phoneHttp("GET", "/api/missed-calls");
        const arr = Array.isArray(dm) ? dm : (dm && (dm.calls || dm.history) ? (dm.calls || dm.history) : []);
        calls = arr;
      } catch (__) { /* no missed calls either */ }
    }
    box.innerHTML = "";
    if (!calls.length) {
      const d = document.createElement("div"); d.className = "phone-card";
      d.innerHTML = '<div class="phone-card-meta">No call history.</div>';
      box.appendChild(d); return;
    }
    calls.slice(0, 30).forEach((c) => {
      const d = document.createElement("div"); d.className = "phone-card";
      const missed    = c.missed || c.state === "missed";
      const stateClass = missed ? "bad" : (c.state === "ended" ? "ok" : "");
      d.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<span class="phone-card-title" style="font-family:var(--mono);font-size:11px">' +
            escHtml((c.from_extension || c.from || "?") + " → " + (c.to_extension || c.to || "?")) +
          '</span>' +
          '<span class="phone-card-badge ' + stateClass + '">' +
            escHtml(c.state || (missed ? "missed" : "")) +
          '</span>' +
          '<span class="phone-card-meta" style="margin-left:auto">' +
            escHtml((c.created_at || c.time || "").slice(11, 16)) +
          '</span>' +
        '</div>' +
        '<div class="phone-card-meta">' +
          escHtml(truncate([c.reason, (c.created_at || "").slice(0, 10)].filter(Boolean).join(" · "), 55)) +
        '</div>';
      // Missed calls: offer a one-tap "Call Back" that pre-fills the dialer
      if (missed) {
        const fromExt = String(c.from_extension || c.from || "");
        if (fromExt) {
          const cbBtn = document.createElement("button");
          cbBtn.className = "phone-sm-btn ok"; cbBtn.style.marginTop = "4px";
          cbBtn.textContent = "📞 Call Back";
          cbBtn.addEventListener("click", () => {
            dialPad_setFull(fromExt);
            setPhoneTab("calls");
            addSys("Dialing " + fromExt + "…");
          });
          d.appendChild(cbBtn);
        }
      }
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML =
      '<div class="phone-card"><div class="phone-card-meta" style="color:var(--bad)">' +
      escHtml(e.message || String(e)) + '</div></div>';
  }
}

// ---- SMS Agent ----
const smsAgentState = { enabled: null, extension: "", agents: [] };

async function loadSmsAgentConfig() {
  try {
    const d = await phoneHttp("GET", "/api/sms-agent");
    smsAgentState.enabled   = d.enabled;
    smsAgentState.extension = d.extension || "";
    smsAgentState.agents    = d.agents    || [];
    const tog = $("smsAgentToggle"); if (tog) tog.checked = !!d.enabled;
    renderSmsAgentPicker();
  } catch (_) {
    // Fall back to loading agents for the picker via phoneMcp.
    try {
      const ad = await phoneMcp("list_agents");
      smsAgentState.agents = Array.isArray(ad) ? ad : (ad.agents || []);
      renderSmsAgentPicker();
    } catch (__) { /* no agents */ }
  }
}

function renderSmsAgentPicker() {
  const box = $("smsAgentPicker"); if (!box) return;
  box.innerHTML = "";
  if (!smsAgentState.agents.length) return;
  smsAgentState.agents.forEach((a) => {
    const ext  = typeof a === "string" ? a : String(a.extension || a.ext || a[0] || "");
    const name = typeof a === "string" ? a : String(a.name || a[1] || ext);
    const btn  = document.createElement("button");
    btn.className = "config-chip" + (ext === smsAgentState.extension ? " selected" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      smsAgentState.extension = ext;
      box.querySelectorAll(".config-chip").forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
      phoneHttp("POST", "/api/sms-agent", { extension: _extArg(ext) })
        .then(() => {
          const r = $("smsAgentResult");
          if (r) { r.textContent = "✓ SMS agent set to " + name; r.className = "phone-result ok"; }
        })
        .catch((e) => {
          const r = $("smsAgentResult");
          if (r) { r.textContent = "✗ " + (e.message || e); r.className = "phone-result bad"; }
        });
    });
    box.appendChild(btn);
  });
}

async function toggleSmsAgent(on) {
  smsAgentState.enabled = on;
  const r = $("smsAgentResult");
  try {
    await phoneHttp("POST", "/api/sms-agent", { enabled: on });
    if (r) { r.textContent = "✓ SMS agent " + (on ? "enabled" : "disabled"); r.className = "phone-result ok"; }
  } catch (e) {
    if (r) { r.textContent = "✗ " + (e.message || e); r.className = "phone-result bad"; }
  }
}

// ---- Call Screening (expanded) ----
const screeningState = { enabled: null, transport: "twilio", inboundExt: "", screeningExt: "", agents: [] };

async function loadScreeningConfig() {
  // First do a quick status check with the existing tool.
  try {
    const d = await phoneMcp("twilio_status");
    screeningState.enabled = d.screening_enabled;
    const tog = $("screeningAutoToggle"); if (tog) tog.checked = !!d.screening_enabled;
    const badge = $("phoneScreeningBadge");
    if (badge) { badge.textContent = d.screening_enabled ? "enabled" : "disabled"; badge.className = "phone-badge " + (d.screening_enabled ? "ok" : "bad"); }
  } catch (_) { /* ignore — will show old badge */ }

  // Load full config; populate transport + agent pickers.
  try {
    const cfg = await phoneHttp("GET", "/api/screening");
    screeningState.enabled       = cfg.enabled;
    screeningState.transport     = cfg.transport      || "twilio";
    screeningState.inboundExt    = cfg.inbound_extension   || "";
    screeningState.screeningExt  = cfg.screening_extension || "";
    screeningState.agents        = cfg.agents || [];
    const tog = $("screeningAutoToggle"); if (tog) tog.checked = !!cfg.enabled;
    renderScreeningTransport();
    renderScreeningAgentPickers();
    const cfSection = $("carrierForwardingSection");
    if (cfSection) cfSection.style.display = screeningState.transport === "twilio" ? "" : "none";
  } catch (_) {
    // Fall back to loading agents for pickers via phoneMcp.
    try {
      const ad = await phoneMcp("list_agents");
      screeningState.agents = Array.isArray(ad) ? ad : (ad.agents || []);
      renderScreeningAgentPickers();
    } catch (__) { /* no agents */ }
  }
}

function renderScreeningTransport() {
  const twEl = $("screeningTransportTwilio");
  const rlEl = $("screeningTransportRelay");
  if (twEl) twEl.classList.toggle("selected", screeningState.transport === "twilio");
  if (rlEl) rlEl.classList.toggle("selected", screeningState.transport === "relay");
}

function renderScreeningAgentPickers() {
  const inboundBox  = $("screeningInboundPicker");
  const screenerBox = $("screeningScreenerPicker");
  if (!inboundBox || !screenerBox) return;

  [inboundBox, screenerBox].forEach((box, idx) => {
    box.innerHTML = "";
    const isInbound = idx === 0;
    screeningState.agents.forEach((a) => {
      const ext  = typeof a === "string" ? a : String(a.extension || a.ext || (Array.isArray(a) ? a[0] : "") || "");
      const name = typeof a === "string" ? a : String(a.name || (Array.isArray(a) ? a[1] : "") || ext);
      const selected = isInbound
        ? ext === screeningState.inboundExt
        : ext === screeningState.screeningExt;
      const btn = document.createElement("button");
      btn.className = "config-chip" + (selected ? " selected" : "");
      btn.textContent = name;
      btn.addEventListener("click", () => {
        box.querySelectorAll(".config-chip").forEach((c) => c.classList.remove("selected"));
        btn.classList.add("selected");
        if (isInbound) screeningState.inboundExt = ext;
        else screeningState.screeningExt = ext;
        const body = isInbound
          ? { inbound_extension: _extArg(ext) }
          : { screening_extension: _extArg(ext) };
        phoneHttp("POST", "/api/screening", body)
          .then(() => {
            const r = $("screeningResult");
            if (r) { r.textContent = "✓ " + (isInbound ? "Inbound" : "Screener") + " set to " + name; r.className = "phone-result ok"; }
          })
          .catch((e) => {
            const r = $("screeningResult");
            if (r) { r.textContent = "✗ " + (e.message || e); r.className = "phone-result bad"; }
          });
      });
      box.appendChild(btn);
    });
  });
}

async function setScreeningTransport(t) {
  screeningState.transport = t;
  renderScreeningTransport();
  const cfSection = $("carrierForwardingSection");
  if (cfSection) cfSection.style.display = t === "twilio" ? "" : "none";
  try {
    await phoneHttp("POST", "/api/screening", { transport: t });
    const r = $("screeningResult");
    if (r) { r.textContent = "✓ Transport: " + t; r.className = "phone-result ok"; }
  } catch (e) {
    const r = $("screeningResult");
    if (r) { r.textContent = "✗ " + (e.message || e); r.className = "phone-result bad"; }
  }
}

async function toggleAutoScreening(on) {
  screeningState.enabled = on;
  const tog = $("screeningAutoToggle"); if (tog) tog.checked = on;
  try {
    await phoneHttp("POST", "/api/screening", { enabled: on });
    const badge = $("phoneScreeningBadge");
    if (badge) { badge.textContent = on ? "enabled" : "disabled"; badge.className = "phone-badge " + (on ? "ok" : "bad"); }
    const r = $("screeningResult");
    if (r) { r.textContent = "✓ Screening " + (on ? "enabled" : "disabled"); r.className = "phone-result ok"; }
  } catch (e) {
    const r = $("screeningResult");
    if (r) { r.textContent = "✗ " + (e.message || e); r.className = "phone-result bad"; }
  }
}

// ================================================================= NEW CHAT OVERLAY (C-1)
// "+ New Chat" button in the inbox header opens this overlay. It loads agents via
// phoneMcp("list_agents"), lets the user multi-select them, type a first message,
// then either "📞 Call" (call_extension for each selected agent) or "Start"
// (notify_user_and_wait with to_extension for each selected agent).

let _newChatAgents  = [];
let _newChatSelected = new Set();

async function openNewChatOverlay() {
  const overlay = $("phoneNewChatOverlay"); if (!overlay) return;
  // Reset.
  _newChatSelected = new Set();
  const msgEl = $("newChatMsg"); if (msgEl) msgEl.value = "";
  const res   = $("newChatResult"); if (res) { res.textContent = ""; res.className = "phone-result"; }
  overlay.classList.remove("hidden");

  const listEl = $("newChatAgentList");
  if (listEl) listEl.innerHTML = '<div class="new-chat-agent-row"><span class="phone-card-meta">Loading agents…</span></div>';
  try {
    const data = await phoneMcp("list_agents");
    _newChatAgents = Array.isArray(data) ? data : (data.agents || data.extensions || []);
    _renderNewChatAgents();
  } catch (e) {
    if (listEl)
      listEl.innerHTML = '<div class="new-chat-agent-row"><span class="phone-card-meta" style="color:var(--bad)">' +
        escHtml(e.message || String(e)) + '</span></div>';
  }
}

function _renderNewChatAgents() {
  const box = $("newChatAgentList"); if (!box) return;
  box.innerHTML = "";
  if (!_newChatAgents.length) {
    box.innerHTML = '<div class="new-chat-agent-row"><span class="phone-card-meta">No agents found.</span></div>';
    _updateNewChatButtons(); return;
  }
  _newChatAgents.forEach((a) => {
    const ext    = String(a.extension || a.ext || "");
    const name   = String(a.name || a.agent_name || "Agent");
    const online = (a.status || "") === "online";
    const isSel  = _newChatSelected.has(ext);
    const row    = document.createElement("div");
    row.className = "new-chat-agent-row" + (isSel ? " selected" : "");
    row.innerHTML =
      '<span class="new-chat-check">' + (isSel ? "✓" : "○") + '</span>' +
      '<span style="flex:1;color:var(--text)">' + escHtml(name) + '</span>' +
      '<span class="phone-card-badge ' + (online ? "ok" : "") +
        '" style="font-size:9px">' + escHtml(a.status || "") + '</span>' +
      '<span class="phone-card-meta" style="min-width:26px;text-align:right">' + escHtml(ext) + '</span>';
    row.addEventListener("click", () => {
      if (_newChatSelected.has(ext)) _newChatSelected.delete(ext);
      else _newChatSelected.add(ext);
      _renderNewChatAgents();
    });
    box.appendChild(row);
  });
  _updateNewChatButtons();
}

function _updateNewChatButtons() {
  const n       = _newChatSelected.size;
  const msgEl   = $("newChatMsg");
  const hasMsg  = msgEl ? msgEl.value.trim().length > 0 : false;
  const callBtn = $("newChatCallBtn");
  const startBtn= $("newChatStartBtn");
  if (callBtn)  callBtn.disabled  = n === 0;
  if (startBtn) startBtn.disabled = n === 0 || !hasMsg;
  const hdr = $("newChatOverlayTitle");
  if (hdr) hdr.textContent = n > 1 ? "New Group Chat · " + n + " selected" : "New Chat";
}

function closeNewChatOverlay() {
  const overlay = $("phoneNewChatOverlay");
  if (overlay) overlay.classList.add("hidden");
}

async function doNewChatStart() {
  const msg  = ($("newChatMsg") && $("newChatMsg").value.trim()) || "";
  const exts = [..._newChatSelected];
  if (!msg || !exts.length) return;
  const startBtn = $("newChatStartBtn"); if (startBtn) startBtn.disabled = true;
  const res = $("newChatResult");
  if (res) { res.textContent = "Sending…"; res.className = "phone-result"; }
  try {
    for (const ext of exts) {
      await phoneMcp("notify_user_and_wait", {
        to_extension: _extArg(ext), title: "New Message", message: msg, priority: "normal"
      });
    }
    if (res) { res.textContent = "✓ Sent to " + exts.length + " agent(s)"; res.className = "phone-result ok"; }
    setTimeout(() => { closeNewChatOverlay(); loadInbox(); }, 900);
  } catch (e) {
    if (res) { res.textContent = "✗ " + (e.message || e); res.className = "phone-result bad"; }
    if (startBtn) startBtn.disabled = false;
  }
}

async function doNewChatCall() {
  const exts = [..._newChatSelected];
  if (!exts.length) return;
  const callBtn = $("newChatCallBtn"); if (callBtn) callBtn.disabled = true;
  const res = $("newChatResult");
  if (res) { res.textContent = "Calling…"; res.className = "phone-result"; }
  try {
    for (const ext of exts) {
      await phoneMcp("call_extension", { extension: _extArg(ext) });
    }
    if (res) { res.textContent = "✓ Call placed"; res.className = "phone-result ok"; }
    setTimeout(() => { closeNewChatOverlay(); setPhoneTab("calls"); }, 800);
  } catch (e) {
    if (res) { res.textContent = "✗ " + (e.message || e); res.className = "phone-result bad"; }
    if (callBtn) callBtn.disabled = false;
  }
}

// ---- wire up all phone panel events once DOM is ready ----
function initPhonePanel() {
  // ---- close ----
  const cl = $("phoneClose"); if (cl) cl.addEventListener("click", closePhone);

  // ---- tabs ----
  document.querySelectorAll(".phone-tab").forEach((btn) =>
    btn.addEventListener("click", () => setPhoneTab(btn.getAttribute("data-ptab")))
  );

  // ---- call banner ----
  // Accept via REST (there is no accept_call MCP tool; HTTP route is the correct path)
  const bAccept = $("phoneBannerAccept");
  if (bAccept) bAccept.addEventListener("click", async () => {
    const cid = $("phoneBanner") && $("phoneBanner").dataset.callId;
    if (!cid) return;
    bAccept.disabled = true;
    try {
      await phoneHttp("POST", "/api/calls/" + cid + "/accept", { extension: "100" });
      await loadActiveCalls();
    } catch (e) {
      addSys("Accept failed: " + (e.message || e));
    } finally {
      bAccept.disabled = false;
    }
  });
  // Reject an incoming ringing call
  const bReject = $("phoneBannerReject");
  if (bReject) bReject.addEventListener("click", async () => {
    const cid = $("phoneBanner") && $("phoneBanner").dataset.callId;
    if (!cid) return;
    bReject.disabled = true;
    try {
      await phoneHttp("POST", "/api/calls/" + cid + "/reject", { extension: "100" });
      await loadActiveCalls();
    } catch (e) {
      addSys("Reject failed: " + (e.message || e));
    } finally {
      bReject.disabled = false;
    }
  });
  // Mute toggle (client-side microphone state; no backend endpoint exists)
  const bBannerMute = $("phoneBannerMute");
  if (bBannerMute) bBannerMute.addEventListener("click", () => {
    callMuted = !callMuted;
    bBannerMute.textContent = callMuted ? "Unmute" : "Mute";
    bBannerMute.classList.toggle("bad", callMuted);
  });
  const bEnd = $("phoneBannerEnd");
  if (bEnd) bEnd.addEventListener("click", () => {
    const cid = $("phoneBanner") && $("phoneBanner").dataset.callId;
    if (cid) endPhoneCall(cid);
  });

  // ---- SCREENING LIVE (take-over / end / refresh) ----
  const screenTakeOver = $("phoneScreeningTakeOver");
  if (screenTakeOver) screenTakeOver.addEventListener("click", async () => {
    const sec = $("phoneScreeningLive");
    const callId = sec && sec.dataset.callId;
    if (!callId) { addSys("No screened call to take over"); return; }
    screenTakeOver.disabled = true;
    try {
      await phoneMcp("twilio_screening_take_over", { call_id: callId });
      addSys("Taking over screened call — your phone should ring.");
      await loadActiveCalls();
    } catch (e) { addSys("Take over: " + (e.message || e)); }
    finally { screenTakeOver.disabled = false; }
  });
  const screenEndBtn = $("phoneScreeningEndBtn");
  if (screenEndBtn) screenEndBtn.addEventListener("click", async () => {
    const sec = $("phoneScreeningLive");
    const callId = sec && sec.dataset.callId;
    if (!callId) { addSys("No screened call to end"); return; }
    screenEndBtn.disabled = true;
    try {
      await phoneMcp("twilio_screening_end", { call_id: callId });
      addSys("Screening ended.");
      await loadActiveCalls();
    } catch (e) { addSys("End screening: " + (e.message || e)); }
    finally { screenEndBtn.disabled = false; }
  });
  const screenRefresh = $("phoneScreeningRefresh");
  if (screenRefresh) screenRefresh.addEventListener("click", () => updateScreeningLive().catch(() => {}));

  // ---- CALLS TAB ----
  const rc = $("phoneRefreshCalls"); if (rc) rc.addEventListener("click", loadActiveCalls);
  const db = $("phoneDialBtn");      if (db) db.addEventListener("click", doPhoneDial);

  // keypad digits
  document.querySelectorAll(".dialpad-key").forEach((key) => {
    key.addEventListener("click", () => dialPad_append(key.getAttribute("data-key") || ""));
  });
  // extension chips → replace display
  document.querySelectorAll(".dial-ext-chip").forEach((chip) => {
    chip.addEventListener("click", () => dialPad_setFull(chip.getAttribute("data-ext") || ""));
  });
  // backspace
  const bsp = $("phoneDialBackspace"); if (bsp) bsp.addEventListener("click", dialPad_backspace);

  // mode select → show/hide To Number field + update hint
  const dm = $("phoneDialMode");
  if (dm) dm.addEventListener("change", () => {
    const row = $("phoneToNumberRow");
    if (row) row.classList.toggle("hidden", dm.value !== "twilio" && dm.value !== "inapp");
    const hint = $("dialHint");
    if (hint) {
      if (dm.value === "extension")  hint.textContent = "tap a key or ext chip";
      else if (dm.value === "twilio") hint.textContent = "PSTN call via Twilio";
      else                            hint.textContent = "in-app call";
    }
  });
  const txBack = $("phoneTranscriptBack");
  if (txBack) txBack.addEventListener("click", () => {
    const w = $("phoneTranscriptWrap"); if (w) w.classList.add("hidden");
  });

  // ---- AGENTS TAB ----
  const ra = $("phoneRefreshAgents"); if (ra) ra.addEventListener("click", loadAgents);
  const agBack = $("agentConfigBack"); if (agBack) agBack.addEventListener("click", closeAgentConfig);
  const agPreview = $("agentVoicePreview");
  if (agPreview) agPreview.addEventListener("click", doPreviewVoice);
  const speedSlider = $("agentSpeedSlider");
  if (speedSlider) {
    speedSlider.addEventListener("input", () => {
      const val = parseFloat(speedSlider.value).toFixed(2);
      const sv = $("agentSpeedValue"); if (sv) sv.textContent = val + "×";
    });
    speedSlider.addEventListener("change", () => {
      if (!agentConfigState.ext) return;
      agentConfigState.speed = parseFloat(speedSlider.value);
      const body = { speed: agentConfigState.speed };
      if (agentConfigState.voiceId) body.voiceId = agentConfigState.voiceId;
      phoneHttp("PUT", "/api/extensions/" + agentConfigState.ext + "/voice", body).catch((e) => {
        const r = $("agentConfigResult");
        if (r) { r.textContent = "Speed: " + (e.message || e); r.className = "phone-result bad"; }
      });
    });
  }

  // ---- INBOX TAB ----
  const ri = $("phoneRefreshInbox"); if (ri) ri.addEventListener("click", loadInbox);
  const cb = $("phoneComposeBtn");   if (cb) cb.addEventListener("click", doCompose);
  const thBack = $("phoneThreadBack");
  if (thBack) thBack.addEventListener("click", () => {
    const w = $("phoneThreadWrap"); if (w) w.classList.add("hidden");
  });

  // ---- NEW CHAT OVERLAY (C-1) ----
  const ncBtn = $("phoneNewChatBtn"); if (ncBtn) ncBtn.addEventListener("click", openNewChatOverlay);
  const ncCancel = $("newChatCancelBtn"); if (ncCancel) ncCancel.addEventListener("click", closeNewChatOverlay);
  const ncCall  = $("newChatCallBtn");  if (ncCall)  ncCall.addEventListener("click",  doNewChatCall);
  const ncStart = $("newChatStartBtn"); if (ncStart) ncStart.addEventListener("click", doNewChatStart);
  const ncMsg   = $("newChatMsg");
  if (ncMsg) ncMsg.addEventListener("input", _updateNewChatButtons);

  // ---- HUD TAB ----
  const hudRefresh = $("phoneHudRefresh"); if (hudRefresh) hudRefresh.addEventListener("click", loadHud);
  const hudOpen = $("phoneHudOpen");
  if (hudOpen) hudOpen.addEventListener("click", async () => {
    const cfg = await chrome.storage.local.get({ phoneServerUrl: "" });
    const url = (cfg.phoneServerUrl || "").trim().replace(/\/$/, "");
    if (url) {
      try { chrome.tabs.create({ url: url + "/dashboard" }); } catch (_) { /* sandboxed */ }
    } else {
      addSys("Set Server URL in Settings → Connection first.");
    }
  });

  // ---- SETTINGS TAB ----
  // connection
  const connSave = $("connSave"); if (connSave) connSave.addEventListener("click", saveConnectionSettings);
  const connTest = $("connTest"); if (connTest) connTest.addEventListener("click", testConnectionSettings);

  // twilio status
  const rs = $("phoneRefreshStatus");
  if (rs) rs.addEventListener("click", () => { loadTwilioStatus(); loadAllowlist(); });

  // call history
  const rh = $("phoneRefreshHistory"); if (rh) rh.addEventListener("click", loadCallHistory);

  // call screening (expanded)
  const stTwilio = $("screeningTransportTwilio");
  if (stTwilio) stTwilio.addEventListener("click", () => setScreeningTransport("twilio"));
  const stRelay  = $("screeningTransportRelay");
  if (stRelay)  stRelay.addEventListener("click",  () => setScreeningTransport("relay"));
  const scToggle = $("screeningAutoToggle");
  if (scToggle) scToggle.addEventListener("change", () => toggleAutoScreening(scToggle.checked));
  const son  = $("phoneScreeningOn");  if (son)  son.addEventListener("click",  () => doToggleScreening(true));
  const soff = $("phoneScreeningOff"); if (soff) soff.addEventListener("click", () => doToggleScreening(false));

  // carrier forwarding — copy codes to clipboard
  const AGENT_NUMBER = "+15551234567";
  const CF_CODES = {
    cfAll:       "**004*" + AGENT_NUMBER + "#",
    cfBusy:      "**67*"  + AGENT_NUMBER + "#",
    cfNoAns:     "**61*"  + AGENT_NUMBER + "#",
    cfUnreach:   "**62*"  + AGENT_NUMBER + "#",
    cfUndo:      "##002#",
    vzBusyNoAns: "*715551234567",
    vzAll:       "*725551234567",
    vzOff:       "*73"
  };
  Object.entries(CF_CODES).forEach(([id, code]) => {
    const btn = $(id);
    if (btn) btn.addEventListener("click", () => {
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.textContent;
        btn.textContent = "✓ copied";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => { addSys("Copy: " + code); });
    });
  });

  // allowlist
  const ral = $("phoneRefreshAllowlist"); if (ral) ral.addEventListener("click", loadAllowlist);
  const aa  = $("phoneAllowlistAdd");     if (aa)  aa.addEventListener("click",  doAllowlistAdd);
  const ar  = $("phoneAllowlistRemove");  if (ar)  ar.addEventListener("click",  doAllowlistRemove);

  // user number
  const sun = $("phoneSetUserNum"); if (sun) sun.addEventListener("click", doSetUserNumber);

  // voice profile (manual / per-ext fallback)
  const vs  = $("phoneVoiceSet");   if (vs)  vs.addEventListener("click",  doSetVoice);
  const vg  = $("phoneVoiceGet");   if (vg)  vg.addEventListener("click",  doGetVoice);

  // sms agent
  const smsToggle = $("smsAgentToggle");
  if (smsToggle) smsToggle.addEventListener("change", () => toggleSmsAgent(smsToggle.checked));

  // war room
  const red = $("phoneRedAlert"); if (red) red.addEventListener("click", doRedAlert);
}

// ----------------------------------------------------------------- boot
async function init() {
  initPhonePanel();
  addSys("Cindro co-worker ready. Type a request to drive this browser.");
  await refreshTabs();
  await connect();
  // Light heartbeat to recover the connection if it silently drops.
  setInterval(() => { if (!connected) connect(); }, 4000);
}
init();
