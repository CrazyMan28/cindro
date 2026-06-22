// Service worker: WebSocket client to the computer-use MCP server + command dispatch.
//
// Protocol: server sends {id, method, params}; we reply {id, result} or
// {id, error: {message}}. We send {event: "hello", params} after connecting.
// The server pings every 20s with a real JSON message, which also keeps this
// MV3 service worker alive (Chrome 116+ extends SW lifetime on WS activity).

let ws = null;
let reconnectDelay = 1000;
let connecting = false;
let lastPingTs = null;
let lastCloseCode = null;

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#16a34a" : "#dc2626" }).catch(() => {});
}
setBadge(false);

const attached = new Set();          // tabIds with debugger attached
const consoleBuffers = new Map();    // tabId -> [{ts, level, text}]
const CONSOLE_RING = 500;

// ---------------------------------------------------------------- connection

async function getConfig() {
  const cfg = await chrome.storage.local.get({ port: 8794, token: "" });
  return cfg;
}

async function ensureConnected() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) {
    return;
  }
  const { port, token } = await getConfig();
  if (!token) {
    console.warn("computer-use: no token configured — open the extension Options page");
    return;
  }
  connecting = true;
  try {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/extension?token=${encodeURIComponent(token)}`);
    sock.onopen = () => {
      ws = sock;
      reconnectDelay = 1000;
      lastCloseCode = null;
      setBadge(true);
      console.log("computer-use: connected");
      sock.send(JSON.stringify({
        event: "hello",
        params: { extVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent },
      }));
    };
    sock.onmessage = (ev) => onCommand(sock, ev.data);
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      lastCloseCode = ev.code;
      setBadge(false);
      // 4401 = bad token: retry slowly, the user needs to fix Options.
      scheduleReconnect(ev.code === 4401 ? 30000 : undefined);
    };
    sock.onerror = () => { /* onclose follows */ };
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(delayOverride) {
  const delay = delayOverride ?? Math.min(reconnectDelay, 30000);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  setTimeout(ensureConnected, delay);
}

chrome.alarms.create("cu-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "cu-reconnect") ensureConnected(); });
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "cu-reconnect") {
    if (ws) try { ws.close(); } catch (e) {}
    ws = null;
    reconnectDelay = 1000;
    ensureConnected();
    sendResponse({ ok: true });
  } else if (msg && msg.type === "cu-status") {
    getConfig().then((cfg) => {
      sendResponse({
        connected: !!(ws && ws.readyState === WebSocket.OPEN),
        port: cfg.port,
        tokenSet: !!cfg.token,
        lastPing: lastPingTs,
        lastCloseCode,
        attachedTabs: [...attached],
        extVersion: chrome.runtime.getManifest().version,
      });
    });
    return true; // async sendResponse
  }
  return true;
});
ensureConnected();

// ---------------------------------------------------------------- dispatch

async function onCommand(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg.id || !msg.method) return;
  try {
    const handler = HANDLERS[msg.method];
    if (!handler) throw new Error(`unknown method ${msg.method}`);
    const result = await handler(msg.params || {});
    sock.send(JSON.stringify({ id: msg.id, result: result === undefined ? null : result }));
  } catch (e) {
    sock.send(JSON.stringify({ id: msg.id, error: { message: String(e && e.message || e) } }));
  }
}

// ---------------------------------------------------------------- helpers

async function targetTab(params) {
  if (params && params.tabId != null) {
    return await chrome.tabs.get(params.tabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

function checkScriptable(tab) {
  const url = tab.url || "";
  if (/^(chrome|chrome-extension|devtools|edge|about):/.test(url) || url.startsWith("https://chromewebstore.google.com")) {
    throw new Error(`cannot script ${url} (browser-internal page) — use tabs/nav tools or a normal site`);
  }
}

async function contentCall(tab, payload) {
  checkScriptable(tab);
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch (e) {
    // Content script not there (tab opened before install / discarded) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, payload);
  }
}

function waitForLoad(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const removed = (id) => { if (id === tabId) finish(); };
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
      clearTimeout(timer);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    const timer = setTimeout(finish, timeoutMs);
    // Already complete?
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }).catch(finish);
  });
}

function tabInfo(t) {
  return { id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, status: t.status, index: t.index };
}

// ---------------------------------------------------------------- CDP

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const m = String(e && e.message || e);
    if (m.includes("Another debugger")) {
      throw new Error("debugger already attached to this tab (close DevTools on it and retry)");
    }
    if (!m.includes("already attached")) throw e;
  }
  attached.add(tabId);
  consoleBuffers.set(tabId, consoleBuffers.get(tabId) || []);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Log.enable").catch(() => {});
}

function pushConsole(tabId, entry) {
  const buf = consoleBuffers.get(tabId) || [];
  buf.push(entry);
  if (buf.length > CONSOLE_RING) buf.splice(0, buf.length - CONSOLE_RING);
  consoleBuffers.set(tabId, buf);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || []).map((a) => {
      if (a.value !== undefined) return String(a.value);
      if (a.description) return a.description;
      return a.type;
    }).join(" ");
    pushConsole(tabId, { ts: params.timestamp, level: params.type, text });
  } else if (method === "Log.entryAdded") {
    const e = params.entry || {};
    pushConsole(tabId, { ts: e.timestamp, level: e.level, text: `[${e.source}] ${e.text}` });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attached.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    attached.delete(tabId);
  }
  consoleBuffers.delete(tabId);
});

async function cdp(tabId, method, params) {
  await ensureAttached(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// ---------------------------------------------------------------- handlers

const HANDLERS = {
  async ping() {
    lastPingTs = Date.now();
    return { ok: true, ts: lastPingTs, attachedTabs: [...attached] };
  },

  async "tabs.list"() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tabInfo);
  },

  async "tabs.create"(p) {
    const tab = await chrome.tabs.create({ url: p.url || "about:blank", active: p.active !== false });
    await waitForLoad(tab.id);
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  async "tabs.activate"(p) {
    const tab = await chrome.tabs.update(p.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async "tabs.close"(p) {
    await chrome.tabs.remove(p.tabId);
    return { closed: p.tabId };
  },

  async "nav.goto"(p) {
    const tab = await targetTab(p);
    if (p.url === "back" || p.url === "forward") {
      await (p.url === "back" ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id));
    } else {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : `https://${p.url}`;
      await chrome.tabs.update(tab.id, { url });
    }
    await waitForLoad(tab.id);
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  async "page.snapshot"(p) {
    const tab = await targetTab(p);
    return await contentCall(tab, { type: "snapshot", maxNodes: p.maxNodes || 600 });
  },

  async "page.click"(p) {
    const tab = await targetTab(p);
    if (p.trusted) {
      const pt = await contentCall(tab, { type: "clickPoint", ref: p.ref, selector: p.selector });
      if (pt && pt.error) throw new Error(pt.error);
      const base = { x: pt.x, y: pt.y, button: "left", clickCount: 1 };
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { clicked: true, trusted: true, point: pt, note: "debugger attached (Chrome shows an automation banner)" };
    }
    return await contentCall(tab, { type: "click", ref: p.ref, selector: p.selector });
  },

  async "page.type"(p) {
    const tab = await targetTab(p);
    return await contentCall(tab, {
      type: "type", ref: p.ref, selector: p.selector,
      text: p.text, clear: p.clear !== false, submit: !!p.submit,
    });
  },

  async "page.select"(p) {
    const tab = await targetTab(p);
    return await contentCall(tab, { type: "select", ref: p.ref, selector: p.selector, value: p.value });
  },

  async "page.scroll"(p) {
    const tab = await targetTab(p);
    return await contentCall(tab, { type: "scroll", direction: p.direction, amount: p.amount, ref: p.ref });
  },

  async "page.screenshot"(p) {
    const tab = await targetTab(p);
    if (!p.fullPage && tab.active) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, tabId: tab.id, method: "captureVisibleTab" };
    }
    const res = await cdp(tab.id, "Page.captureScreenshot",
      p.fullPage ? { format: "png", captureBeyondViewport: true } : { format: "png" });
    return { dataUrl: `data:image/png;base64,${res.data}`, tabId: tab.id, method: "cdp" };
  },

  async "page.eval"(p) {
    const tab = await targetTab(p);
    checkScriptable(tab);
    // Prefer MAIN-world injection (no debugger banner); page CSP can block
    // eval there, in which case fall back to CDP Runtime.evaluate.
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (code) => {
          try { return { ok: true, value: window.eval(code) }; }
          catch (e) { return { ok: false, error: String(e) }; }
        },
        args: [p.js],
      });
      const r = res && res.result;
      if (r && r.ok) return { value: r.value === undefined ? null : r.value, method: "main-world" };
      if (r && !/EvalError|unsafe-eval|CSP|Content Security Policy/i.test(r.error || "")) {
        throw new Error(r.error);
      }
    } catch (e) {
      // fall through to CDP
    }
    const out = await cdp(tab.id, "Runtime.evaluate", { expression: p.js, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    }
    return { value: out.result ? out.result.value : null, method: "cdp" };
  },

  async "console.read"(p) {
    const tab = await targetTab(p);
    await ensureAttached(tab.id);
    const buf = consoleBuffers.get(tab.id) || [];
    const limit = p.limit || 50;
    return { tabId: tab.id, entries: buf.slice(-limit), note: buf.length ? undefined : "buffer empty — console capture starts when the debugger attaches; reload the page to capture from load" };
  },

  async "cdp.send"(p) {
    const tab = await targetTab(p);
    return await cdp(tab.id, p.method, p.params);
  },
};
