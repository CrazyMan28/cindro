// JARVIS web console — browser management dashboard.
//
// Connects the browser DIRECTLY to the Jarvis daemon control WebSocket
// (loopback-only by design). No build step, no framework: plain DOM + WS.
//
// Daemon protocol (Contract A v1) — mirrors extension/sidepanel.js:
//   connect:  ws://127.0.0.1:<controlPort>/control/ws?token=<controlToken>
//   request:  {v:1, id, method, params}
//   reply:    {v:1, id, ok:true, result} | {v:1, id, ok:false, error:{code,message}}
//   event:    {v:1, event:"session.event", data:{session_id, ev:{kind, ...}}}
//
// SECURITY: every piece of user/model text is inserted via textContent — never
// innerHTML for dynamic content. This surface renders untrusted model output.

"use strict";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ config
// Tokens live in localStorage (this is a same-origin static page, so there is no
// chrome.storage). Pairing writes bearer/port too, though only the control token
// + port are used to reach the daemon from the browser.
const CFG = {
  get controlPort() {
    const v = parseInt(localStorage.getItem("jarvis.controlPort") || "8795", 10);
    return Number.isFinite(v) && v > 0 ? v : 8795;
  },
  set controlPort(v) { localStorage.setItem("jarvis.controlPort", String(parseInt(v, 10) || 8795)); },
  get controlToken() { return localStorage.getItem("jarvis.controlToken") || ""; },
  set controlToken(v) { localStorage.setItem("jarvis.controlToken", v || ""); },
  setBearer(bearer, port) {
    if (bearer != null) localStorage.setItem("jarvis.bearer", bearer);
    if (port != null) localStorage.setItem("jarvis.bearerPort", String(port));
  },
};

// ------------------------------------------------------------------- state
let ws = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let statusTimer = null;

let nextRpcId = 1;
const pending = new Map(); // rpcId -> {resolve, reject}

let sessionId = null;      // the panel's ACTIVE session (strict event scope)
let turnInFlight = false;
let replaying = false;     // history replay: render instantly, no turn UI

let liveText = "";
let lastToolEl = null;     // most recent tool_call row (for ✓/✗ stamping)
const seenApprovals = new Set(); // approval_id dedupe

// ================================================================ RPC layer
// {v:1,id,method,params} with a pending-Map + 30s timeout — exactly like
// sidepanel.js. Rejects immediately when the socket is not open.
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected to Jarvis daemon"));
      return;
    }
    const id = nextRpcId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ v: 1, id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

// ============================================================== connection
function setConnected(on, connecting) {
  connected = on;
  const dot = $("dot");
  dot.classList.toggle("ok", on);
  dot.classList.toggle("connecting", !on && !!connecting);
  $("connLabel").textContent = on ? "connected" : (connecting ? "connecting…" : "disconnected");
  if (!on) { $("verLabel").textContent = ""; $("agentCount").textContent = ""; }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const token = CFG.controlToken;
  if (!token) {
    setConnected(false);
    showView("setup");
    return;
  }
  setConnected(false, true);
  let sock;
  try {
    sock = new WebSocket(
      `ws://127.0.0.1:${CFG.controlPort}/control/ws?token=${encodeURIComponent(token)}`
    );
  } catch (e) {
    scheduleReconnect();
    return;
  }
  sock.onopen = () => {
    ws = sock;
    reconnectDelay = 1000;
    setConnected(true);
    // Re-subscribe to the active session on reconnect so its events keep flowing.
    if (sessionId) rpc("session.subscribe", { session_ids: [sessionId] }).catch(() => {});
    refreshStatus();
    loadSessions().catch(() => {});
    startStatusPoll();
  };
  sock.onmessage = (ev) => onFrame(ev.data);
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setConnected(false);
    // Reject any in-flight RPCs so callers don't hang forever (mirror sidepanel).
    for (const [, p] of pending) p.reject(new Error("connection closed"));
    pending.clear();
    stopStatusPoll();
    if (turnInFlight) endTurn();
    scheduleReconnect();
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(reconnectDelay, 15000);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function reconnectNow() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = 1000;
  try { if (ws) ws.close(); } catch (e) {}
  ws = null;
  connect();
}

// ---------------------------------------------------------------- frames
function onFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  // Unsolicited session events. STRICT scope: even though we call
  // session.subscribe on open (server-side filter), we ALSO guard here on the
  // client — this double layer fixed a real cross-chat leak (the daemon
  // broadcasts every session's events to unscoped clients). Both stay.
  if (msg.event === "session.event" && msg.data) {
    if (sessionId && msg.data.session_id === sessionId) handleEv(msg.data.ev || {});
    return;
  }

  // A session started elsewhere (desktop/phone) — refresh the list so it shows.
  if (msg.event === "session.opened") { loadSessions().catch(() => {}); return; }

  // RPC reply.
  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result || {});
    else p.reject(new Error((msg.error && msg.error.message) || "rpc error"));
  }
}

// ============================================================ status header
async function refreshStatus() {
  try {
    const s = await rpc("settings.get", {});
    const ver = s && s.version ? String(s.version) : "";
    $("verLabel").textContent = ver ? "v" + ver : "";
  } catch (e) { /* leave blank */ }
  refreshAgentCount().catch(() => {});
}

async function refreshAgentCount() {
  try {
    const r = await rpc("agents.running", {});
    const running = (r.agents || []).filter((a) => a.running).length;
    $("agentCount").textContent = running ? `▲ ${running} agent${running === 1 ? "" : "s"}` : "";
  } catch (e) { $("agentCount").textContent = ""; }
}

function startStatusPoll() {
  stopStatusPoll();
  statusTimer = setInterval(() => {
    if (!connected) return;
    refreshAgentCount().catch(() => {});
    if (currentView === "agents") refreshRunning().catch(() => {});
  }, 8000);
}
function stopStatusPoll() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

// ============================================================ DOM helpers
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function short8(id) { return id ? String(id).slice(0, 8) : "????????"; }
function fmtTime(n) {
  if (!n) return "";
  let ms = Number(n);
  if (!Number.isFinite(ms)) return "";
  if (ms < 1e12) ms *= 1000; // seconds -> ms
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ============================================================ transcript
function atBottom() {
  const t = $("transcript");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}
function scrollDown(force) {
  if (force || atBottom()) $("transcript").scrollTop = $("transcript").scrollHeight;
}
function addRow(side, cls, text) {
  const stick = atBottom();
  const row = mk("div", "row " + side);
  row.appendChild(mk("div", cls, text));
  $("transcript").appendChild(row);
  scrollDown(stick);
  return row.firstChild;
}
function addUser(text) { addRow("user", "bubble user", text); }
function addAssistant(text) { addRow("jarvis", "bubble jarvis", text); }
function addSys(text) {
  const stick = atBottom();
  $("transcript").appendChild(mk("div", "sys", text));
  scrollDown(stick);
}
function addError(text) {
  const stick = atBottom();
  $("transcript").appendChild(mk("div", "errmsg", text));
  scrollDown(stick);
}
function addThinking(text) {
  const stick = atBottom();
  const d = mk("details", "thinking");
  d.appendChild(mk("summary", "", "thinking"));
  d.appendChild(mk("div", "think-body", text));
  $("transcript").appendChild(d);
  scrollDown(stick);
}

function toolArgSummary(ev) {
  const a = ev.args || ev.params || ev.input || {};
  if (!a || typeof a !== "object") return "";
  const bits = [];
  const pick = (k) => (a[k] != null ? String(a[k]) : "");
  const url = pick("url"); if (url) bits.push(url);
  const sel = pick("selector") || pick("ref"); if (sel) bits.push(sel);
  const txt = pick("text") || pick("value"); if (txt) bits.push(`"${txt}"`);
  const dir = pick("direction"); if (dir) bits.push(dir);
  const q = pick("query") || pick("name"); if (q && !ev.name) bits.push(q);
  if (!bits.length) {
    const flat = Object.keys(a).slice(0, 3)
      .map((k) => `${k}=${String(a[k]).slice(0, 40)}`).join(" ");
    if (flat) bits.push(flat);
  }
  return bits.join("  ").slice(0, 160);
}
function cleanToolName(raw) {
  const s = String(raw || "tool");
  const dot = s.indexOf(".");
  return dot > 0 ? s.slice(dot + 1) : s;
}
function addToolCall(ev) {
  const stick = atBottom();
  const el = mk("div", "tool");
  el.appendChild(mk("span", "tstatus", "▸"));
  el.appendChild(mk("span", "tname", cleanToolName(ev.name || ev.tool || "tool")));
  const args = toolArgSummary(ev);
  if (args) el.appendChild(mk("span", "targs", args));
  $("transcript").appendChild(el);
  lastToolEl = el;
  scrollDown(stick);
}
function markToolResult(ev) {
  const ok = ev.ok !== false && ev.error == null && ev.isError !== true;
  const el = lastToolEl;
  if (el) {
    el.classList.add(ok ? "ok" : "bad");
    const st = el.querySelector(".tstatus");
    if (st) st.textContent = ok ? "✓" : "✗";
  }
  if (!ok) {
    const out = ev.output || ev.error || ev.message;
    if (out) addError("✗ " + truncate(String(out), 240));
  }
  lastToolEl = null;
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

// approval card — Allow / Always / Deny -> approval.respond
function addApproval(ev) {
  const aid = String(ev.approval_id || "");
  if (aid && seenApprovals.has(aid)) return;
  if (aid) seenApprovals.add(aid);
  const stick = atBottom();
  const card = mk("div", "approval");
  card.appendChild(mk("div", "a-head", "Approval requested"));
  card.appendChild(mk("div", "a-summary", ev.summary || "Jarvis wants to run a sensitive action."));
  if (ev.risk) card.appendChild(mk("div", "a-risk", "risk: " + ev.risk));
  const actions = mk("div", "a-actions");
  const sid = sessionId;
  const result = mk("div", "a-result");
  const respond = async (decision, label) => {
    [...actions.children].forEach((b) => (b.disabled = true));
    try {
      await rpc("approval.respond", { session_id: sid, approval_id: aid, decision });
      card.classList.add("resolved");
      result.textContent = "→ " + label;
      card.appendChild(result);
    } catch (e) {
      [...actions.children].forEach((b) => (b.disabled = false));
      result.textContent = "failed: " + (e && e.message || e);
      result.style.color = "var(--danger)";
      card.appendChild(result);
    }
  };
  const allow = mk("button", "btn small primary", "Allow");
  allow.addEventListener("click", () => respond("allow", "Allowed once"));
  const always = mk("button", "btn small", "Always");
  always.addEventListener("click", () => respond("always", "Always allowed"));
  const deny = mk("button", "btn small danger", "Deny");
  deny.addEventListener("click", () => respond("deny", "Denied"));
  actions.appendChild(allow); actions.appendChild(always); actions.appendChild(deny);
  card.appendChild(actions);
  $("transcript").appendChild(card);
  scrollDown(stick);
}

// A NormalizedBrainEvent: {kind, ...fields}. Mirrors sidepanel.handleEv +
// an approval card (which sidepanel ignored).
function handleEv(ev) {
  const kind = ev.kind || ev.ev;
  switch (kind) {
    case "turn_started":
      lastToolEl = null;
      break;
    case "thinking":
      if (ev.text) addThinking(ev.text);
      break;
    case "message": {
      const role = ev.role || "assistant";
      const text = ev.text || "";
      if (role === "user") break;      // already echoed the user's own message
      if (text.trim()) addAssistant(text);
      break;
    }
    case "tool_call":
      addToolCall(ev);
      break;
    case "tool_result":
      markToolResult(ev);
      break;
    case "approval":
      addApproval(ev);
      break;
    case "error":
      addError(ev.message || "error");
      endTurn();
      break;
    case "final":
      endTurn();
      break;
    default:
      break; // usage / diff / driving.state — ignored for chat
  }
}

// ============================================================ turn UI
function startTurn() {
  if (replaying) return;
  turnInFlight = true;
  $("working").classList.remove("hidden");
  $("sendBtn").disabled = true;
  $("stopBtn").hidden = false;
}
function endTurn() {
  turnInFlight = false;
  $("working").classList.add("hidden");
  $("sendBtn").disabled = false;
  $("stopBtn").hidden = true;
}

// ============================================================ sessions
async function loadSessions() {
  if (!connected) { renderSessions([], "Not connected."); return; }
  try {
    const res = await rpc("session.list", {});
    let list = (res && res.sessions) || [];
    // Subagent CHILD sessions are not standalone chats — filter them (parity
    // with desktop/Android/extension). They belong to their parent + vanish.
    list = list.filter((s) => !(s.parent_session_id && String(s.parent_session_id).length));
    list.sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
    renderSessions(list);
  } catch (e) {
    renderSessions([], "Couldn't load: " + (e && e.message || e));
  }
}

function sessionLabel(s) {
  return s.title && s.title.trim() ? s.title : `${s.brain || "session"} · ${short8(s.id)}`;
}

function renderSessions(list, note) {
  const box = $("sessionsList");
  clear(box);
  if (note) { box.appendChild(mk("div", "empty", note)); return; }
  if (!list || !list.length) {
    box.appendChild(mk("div", "empty", "No conversations yet — start one with + New."));
    return;
  }
  for (const s of list) {
    const item = mk("div", "sess-item" + (s.id === sessionId ? " current" : ""));
    const texts = mk("div", "sess-texts");
    texts.appendChild(mk("div", "sess-title", sessionLabel(s)));
    texts.appendChild(mk("div", "sess-meta", [s.brain, s.state].filter(Boolean).join(" · ")));
    texts.addEventListener("click", () => openSession(s));
    item.appendChild(texts);
    const del = mk("button", "sess-del", "✕");
    del.title = "Delete conversation";
    let armed = false;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true; del.textContent = "Delete?"; del.classList.add("armed");
        setTimeout(() => { armed = false; del.textContent = "✕"; del.classList.remove("armed"); }, 2500);
        return;
      }
      try {
        await rpc("session.delete", { session_id: s.id });
        if (s.id === sessionId) newSession();
        loadSessions();
      } catch (err) { /* list reloads on next open */ }
    });
    item.appendChild(del);
    box.appendChild(item);
  }
}

// Adopt an existing conversation: subscribe (server-side scope), clear, replay.
async function openSession(s) {
  if (turnInFlight) await doStop();
  sessionId = s.id;
  seenApprovals.clear();
  $("chatTitle").textContent = sessionLabel(s);
  closeSessionsDrawer();
  clearTranscript();
  // STRICT scoping layer 1: tell the daemon we only want THIS session's events.
  try { await rpc("session.subscribe", { session_ids: [s.id] }); } catch (e) {}
  await replayHistory(s.id);
  loadSessions(); // refresh 'current' highlight
}

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
      const ev = (raw && raw.ev) ? raw.ev : raw;
      if (ev && (ev.kind || ev.ev)) handleEv(ev);
    }
  } finally {
    replaying = false;
    lastToolEl = null;
  }
  scrollDown(true);
}

function clearTranscript() { clear($("transcript")); lastToolEl = null; }

async function newSession() {
  if (turnInFlight) await doStop(); // let its "stopped" line land BEFORE the clear
  sessionId = null;
  seenApprovals.clear();
  $("chatTitle").textContent = "New conversation";
  clearTranscript();
  addSys("New conversation — your next message starts a fresh session.");
  loadSessions();
}

// Ensure a session exists before sending (create a coworker session).
async function ensureSession() {
  if (sessionId) return sessionId;
  const res = await rpc("session.create", { profile: "coworker" });
  sessionId = res.session_id;
  if (!sessionId) throw new Error("session.create returned no session_id");
  seenApprovals.clear();
  try { await rpc("session.subscribe", { session_ids: [sessionId] }); } catch (e) {}
  return sessionId;
}

async function doSend() {
  if (turnInFlight) return;
  const text = $("input").value.trim();
  if (!text) return;
  if (!connected) { addError("Not connected to the Jarvis daemon — check Setup."); return; }
  $("input").value = "";
  autosize();
  addUser(text);
  startTurn();
  try {
    const sid = await ensureSession();
    $("chatTitle").textContent = $("chatTitle").textContent === "New conversation"
      ? "session · " + short8(sid) : $("chatTitle").textContent;
    await rpc("session.send", { session_id: sid, text });
    loadSessions();
  } catch (e) {
    addError(String(e && e.message || e));
    endTurn();
  }
}

async function doStop() {
  if (!sessionId) { endTurn(); return; }
  try { await rpc("session.cancel", { session_id: sessionId }); } catch (e) {}
  endTurn();
  addSys("stopped");
}

function autosize() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

// ============================================================ memory view
async function loadMemory(query) {
  const box = $("memList");
  clear(box);
  box.appendChild(mk("div", "empty", "Loading…"));
  try {
    const res = query
      ? await rpc("memory.search", { q: query, limit: 50 })
      : await rpc("memory.list", { limit: 100 });
    renderMemory((res && res.memories) || []);
  } catch (e) {
    clear(box);
    box.appendChild(mk("div", "empty", "Couldn't load memory: " + (e && e.message || e)));
  }
}
function renderMemory(list) {
  const box = $("memList");
  clear(box);
  if (!list.length) {
    const e = mk("div", "empty");
    e.appendChild(mk("span", "big", "◇"));
    e.appendChild(document.createTextNode("No memories."));
    box.appendChild(e);
    return;
  }
  for (const m of list) {
    const card = mk("div", "card");
    const rowEl = mk("div", "card-row");
    const main = mk("div", "card-main");
    main.appendChild(mk("div", "card-desc", m.text || ""));
    if (Array.isArray(m.tags) && m.tags.length) {
      const tags = mk("div", "tags");
      m.tags.forEach((t) => tags.appendChild(mk("span", "tag", t)));
      main.appendChild(tags);
    }
    const meta = [short8(m.id)];
    if (m.updated || m.created) meta.push(fmtTime(m.updated || m.created));
    if (m.score != null) meta.push("score " + Number(m.score).toFixed(2));
    main.appendChild(mk("div", "card-meta", meta.filter(Boolean).join("  ·  ")));
    rowEl.appendChild(main);
    const actions = mk("div", "card-actions");
    const del = mk("button", "btn small danger", "Remove");
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) { armed = true; del.textContent = "Confirm?"; setTimeout(() => { armed = false; del.textContent = "Remove"; }, 2500); return; }
      try { await rpc("memory.remove", { id: m.id }); card.remove(); }
      catch (e) { del.textContent = "failed"; }
    });
    actions.appendChild(del);
    rowEl.appendChild(actions);
    card.appendChild(rowEl);
    box.appendChild(card);
  }
}

// ============================================================ skills view
async function loadSkills() {
  const box = $("skillsList");
  clear(box);
  box.appendChild(mk("div", "empty", "Loading…"));
  try {
    const res = await rpc("skills.list", {});
    renderSkills((res && res.skills) || []);
  } catch (e) {
    clear(box);
    box.appendChild(mk("div", "empty", "Couldn't load skills: " + (e && e.message || e)));
  }
}
function renderSkills(list) {
  const box = $("skillsList");
  clear(box);
  if (!list.length) {
    const e = mk("div", "empty");
    e.appendChild(mk("span", "big", "✦"));
    e.appendChild(document.createTextNode("No skills yet."));
    box.appendChild(e);
    return;
  }
  for (const s of list) {
    const card = mk("div", "card");
    const rowEl = mk("div", "card-row");
    const main = mk("div", "card-main");
    const title = mk("div", "card-title", s.name || "skill");
    if (s.group) title.appendChild(mk("span", "grp", s.group));
    main.appendChild(title);
    if (s.description) main.appendChild(mk("div", "card-desc", s.description));
    if (Array.isArray(s.tags) && s.tags.length) {
      const tags = mk("div", "tags");
      s.tags.forEach((t) => tags.appendChild(mk("span", "tag", t)));
      main.appendChild(tags);
    }
    const out = mk("div", "invoke-out");
    main.appendChild(out);
    rowEl.appendChild(main);
    const actions = mk("div", "card-actions");
    const inv = mk("button", "btn small", "Invoke");
    inv.addEventListener("click", async () => {
      inv.disabled = true;
      try {
        const r = await rpc("skills.invoke", { name: s.name, args: "" });
        out.textContent = (r && r.message) || "(no output)";
        out.classList.add("show");
      } catch (e) {
        out.textContent = "failed: " + (e && e.message || e);
        out.classList.add("show");
      } finally { inv.disabled = false; }
    });
    const del = mk("button", "btn small danger", "Remove");
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) { armed = true; del.textContent = "Confirm?"; setTimeout(() => { armed = false; del.textContent = "Remove"; }, 2500); return; }
      try { await rpc("skills.remove", { name: s.name }); card.remove(); }
      catch (e) { del.textContent = "failed"; }
    });
    actions.appendChild(inv);
    actions.appendChild(del);
    rowEl.appendChild(actions);
    card.appendChild(rowEl);
    box.appendChild(card);
  }
}

// ============================================================ agents view
async function loadAgents() {
  await Promise.all([refreshAgentsList(), refreshRunning()]);
}
async function refreshAgentsList() {
  const box = $("agentsList");
  clear(box);
  box.appendChild(mk("div", "empty", "Loading…"));
  try {
    const res = await rpc("agents.list", {});
    renderAgents((res && res.agents) || []);
  } catch (e) {
    clear(box);
    box.appendChild(mk("div", "empty", "Couldn't load agents: " + (e && e.message || e)));
  }
}
function renderAgents(list) {
  const box = $("agentsList");
  const dl = $("agentNames");
  clear(box); clear(dl);
  if (!list.length) {
    box.appendChild(mk("div", "empty", "No agents defined — create one in the desktop/phone Agents tab."));
    return;
  }
  for (const a of list) {
    const opt = document.createElement("option");
    opt.value = a.name; dl.appendChild(opt);
    const card = mk("div", "card");
    const rowEl = mk("div", "card-row");
    const main = mk("div", "card-main");
    main.appendChild(mk("div", "card-title", a.name || "agent"));
    const desc = a.when_to_use || a.description;
    if (desc) main.appendChild(mk("div", "card-desc", desc));
    const meta = [a.brain, a.model].filter(Boolean).join(" · ");
    if (meta) main.appendChild(mk("div", "card-meta", meta));
    rowEl.appendChild(main);
    const actions = mk("div", "card-actions");
    const use = mk("button", "btn small", "Use");
    use.addEventListener("click", () => { $("dispatchAgent").value = a.name; $("dispatchTask").focus(); });
    actions.appendChild(use);
    rowEl.appendChild(actions);
    card.appendChild(rowEl);
    box.appendChild(card);
  }
}
async function refreshRunning() {
  const box = $("runningList");
  try {
    const res = await rpc("agents.running", {});
    const rows = (res && res.agents || []).filter((a) => a.running);
    clear(box);
    if (!rows.length) { box.appendChild(mk("div", "empty", "No agents running.")); return; }
    for (const a of rows) {
      const card = mk("div", "card");
      const rowEl = mk("div", "card-row");
      const main = mk("div", "card-main");
      main.appendChild(mk("div", "card-title", (a.agent || "agent")));
      main.appendChild(mk("div", "card-meta", [short8(a.id), a.state, a.brain].filter(Boolean).join("  ·  ")));
      rowEl.appendChild(main);
      const actions = mk("div", "card-actions");
      actions.appendChild(mk("span", "badge running", "running"));
      rowEl.appendChild(actions);
      card.appendChild(rowEl);
      box.appendChild(card);
    }
  } catch (e) {
    clear(box);
    box.appendChild(mk("div", "empty", "Couldn't load running agents."));
  }
}
async function doDispatch() {
  const agent = $("dispatchAgent").value.trim();
  const task = $("dispatchTask").value.trim();
  const out = $("dispatchOut");
  out.className = "dispatch-out";
  if (!agent || !task) {
    out.textContent = "Enter an agent name and a task.";
    out.classList.add("show", "err");
    return;
  }
  $("dispatchBtn").disabled = true;
  try {
    const r = await rpc("agents.dispatch", { agent, task });
    out.textContent = `Dispatched ${agent} → session ${short8(r.session_id || "")}. It runs as a subagent and reports back.`;
    out.classList.add("show");
    $("dispatchTask").value = "";
    refreshRunning();
    refreshAgentCount();
  } catch (e) {
    out.textContent = "Dispatch failed: " + (e && e.message || e);
    out.classList.add("show", "err");
  } finally {
    $("dispatchBtn").disabled = false;
  }
}

// ============================================================ setup / pairing
// One-shot pairing WS: the daemon replies with ONE JSON
// {ok, bearer, bearer_port, control_token, control_port} then closes. This is a
// WebSocket, NOT an HTTP fetch (mirrors extension/options.js pairWithCode).
function pairWithCode() {
  const code = $("pairCode").value.trim();
  const port = parseInt($("pairPort").value, 10) || 8795;
  const statusEl = $("pairStatus");
  const setStatus = (cls, text) => { statusEl.className = "status-line"; clear(statusEl); statusEl.appendChild(mk("span", cls, text)); };
  if (!/^\d{4,8}$/.test(code)) { setStatus("bad", "Enter the code shown in the Jarvis app."); return; }
  setStatus("info", "pairing…");
  let sock, done = false;
  const fail = (m) => { if (done) return; done = true; setStatus("bad", m); try { sock && sock.close(); } catch (e) {} };
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}/control/pair?code=${encodeURIComponent(code)}`);
  } catch (e) { fail("Could not reach Jarvis: " + e); return; }
  const timer = setTimeout(() => fail("Timed out — is the Jarvis app running?"), 6000);
  sock.onmessage = (ev) => {
    if (done) return; done = true;
    clearTimeout(timer);
    let data; try { data = JSON.parse(ev.data); } catch (e) { data = null; }
    if (!data || !data.ok) {
      setStatus("bad", (data && data.error) || "Invalid or expired code.");
      try { sock.close(); } catch (e) {}
      return;
    }
    CFG.controlToken = data.control_token || "";
    CFG.controlPort = data.control_port || port;
    CFG.setBearer(data.bearer || "", data.bearer_port || 8794);
    $("controlToken").value = data.control_token || "";
    $("controlPort").value = data.control_port || port;
    $("pairCode").value = "";
    try { sock.close(); } catch (e) {}
    setStatus("ok", "paired ✓ — connecting…");
    reconnectNow();
    setTimeout(() => showView("chat"), 700);
  };
  sock.onerror = () => fail("Could not reach Jarvis on port " + port + ".");
  sock.onclose = () => { if (!done) fail("Connection closed before pairing completed."); };
}

function saveTokenManually() {
  const token = $("controlToken").value.trim();
  const port = parseInt($("controlPort").value, 10) || 8795;
  const statusEl = $("saveStatus");
  clear(statusEl);
  if (!token) { statusEl.appendChild(mk("span", "bad", "Enter the control token.")); return; }
  CFG.controlToken = token;
  CFG.controlPort = port;
  statusEl.appendChild(mk("span", "info", "saved — connecting…"));
  reconnectNow();
  setTimeout(() => {
    clear(statusEl);
    statusEl.appendChild(mk("span", connected ? "ok" : "bad", connected ? "connected ✓" : "not connected — check the token/port"));
    if (connected) showView("chat");
  }, 1400);
}

function clearToken() {
  CFG.controlToken = "";
  $("controlToken").value = "";
  const statusEl = $("saveStatus");
  clear(statusEl);
  statusEl.appendChild(mk("span", "info", "cleared."));
  try { if (ws) ws.close(); } catch (e) {}
  ws = null;
  setConnected(false);
}

// ============================================================ view switching
let currentView = "chat";
function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  const view = $("view-" + name);
  if (view) view.classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "memory") loadMemory("").catch(() => {});
  else if (name === "skills") loadSkills().catch(() => {});
  else if (name === "agents") loadAgents().catch(() => {});
  else if (name === "setup") {
    $("controlToken").value = CFG.controlToken;
    $("controlPort").value = CFG.controlPort;
    $("pairPort").value = CFG.controlPort;
  }
}

function openSessionsDrawer() { $("sessionsPane").classList.add("open"); }
function closeSessionsDrawer() { $("sessionsPane").classList.remove("open"); }

// ============================================================ wiring
function wire() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => showView(t.dataset.view)));

  $("sendBtn").addEventListener("click", doSend);
  $("stopBtn").addEventListener("click", doStop);
  $("newSessionBtn").addEventListener("click", newSession);
  $("sessionsToggle").addEventListener("click", () =>
    $("sessionsPane").classList.contains("open") ? closeSessionsDrawer() : openSessionsDrawer());

  const input = $("input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  $("memSearchBtn").addEventListener("click", () => loadMemory($("memSearch").value.trim()));
  $("memRefreshBtn").addEventListener("click", () => { $("memSearch").value = ""; loadMemory(""); });
  $("memSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); loadMemory($("memSearch").value.trim()); }
  });

  $("skillsRefreshBtn").addEventListener("click", loadSkills);
  $("agentsRefreshBtn").addEventListener("click", loadAgents);
  $("dispatchBtn").addEventListener("click", doDispatch);

  $("pairBtn").addEventListener("click", pairWithCode);
  $("saveTokenBtn").addEventListener("click", saveTokenManually);
  $("clearTokenBtn").addEventListener("click", clearToken);
  $("pairCode").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pairWithCode(); } });
}

function boot() {
  wire();
  if (!CFG.controlToken) {
    showView("setup");
    setConnected(false);
  } else {
    showView("chat");
    connect();
  }
}

document.addEventListener("DOMContentLoaded", boot);
