const $ = (id) => document.getElementById(id);

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "cu-status" });
    $("status").innerHTML = res && res.connected
      ? '<span class="ok">● connected to the MCP server</span>'
      : '<span class="bad">● not connected</span> — check token/port and that the server is running';
  } catch (e) {
    $("status").textContent = "status unavailable: " + e;
  }
}

async function load() {
  const cfg = await chrome.storage.local.get({
    port: 8794, token: "", controlPort: 8795, controlToken: "",
  });
  $("port").value = cfg.port;
  $("token").value = cfg.token;
  $("controlPort").value = cfg.controlPort;
  $("controlToken").value = cfg.controlToken;
  $("pairPort").value = cfg.controlPort;
  refreshStatus();
}

// One-paste pairing: redeem a short-lived code from the Jarvis app (Settings →
// Browser Extension → "Generate pairing code") for the bearer + control tokens,
// so the user never hand-copies two secrets out of config files. The daemon serves
// this on the loopback-only control WS at /control/pair and closes right after.
function pairWithCode() {
  const code = $("pairCode").value.trim();
  const port = parseInt($("pairPort").value, 10) || 8795;
  if (!/^\d{4,8}$/.test(code)) {
    $("pairStatus").innerHTML = '<span class="bad">enter the code shown in the Orin app</span>';
    return;
  }
  $("pairStatus").textContent = "pairing…";
  let ws, done = false;
  const fail = (msg) => {
    if (done) return; done = true;
    $("pairStatus").innerHTML = '<span class="bad">' + msg + "</span>";
    try { ws && ws.close(); } catch (e) {}
  };
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/control/pair?code=${encodeURIComponent(code)}`);
  } catch (e) {
    fail("could not reach Orin: " + e);
    return;
  }
  const timer = setTimeout(() => fail("timed out — is the Orin app running?"), 5000);
  ws.onmessage = async (ev) => {
    if (done) return; done = true;
    clearTimeout(timer);
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { data = null; }
    if (!data || !data.ok) {
      $("pairStatus").innerHTML = '<span class="bad">' +
        ((data && data.error) || "invalid or expired code") + "</span>";
      try { ws.close(); } catch (e) {}
      return;
    }
    await chrome.storage.local.set({
      token: data.bearer || "",
      port: data.bearer_port || 8794,
      controlToken: data.control_token || "",
      controlPort: data.control_port || port,
    });
    $("token").value = data.bearer || "";
    $("port").value = data.bearer_port || 8794;
    $("controlToken").value = data.control_token || "";
    $("controlPort").value = data.control_port || port;
    $("pairCode").value = "";
    try { ws.close(); } catch (e) {}
    await chrome.runtime.sendMessage({ type: "cu-reconnect" });
    $("pairStatus").innerHTML = '<span class="ok">paired ✓ — connecting…</span>';
    setTimeout(refreshStatus, 1500);
  };
  ws.onerror = () => fail("could not reach Orin on port " + port);
  ws.onclose = () => { if (!done) fail("connection closed before pairing completed"); };
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    port: parseInt($("port").value, 10) || 8794,
    token: $("token").value.trim(),
    controlPort: parseInt($("controlPort").value, 10) || 8795,
    controlToken: $("controlToken").value.trim(),
  });
  await chrome.runtime.sendMessage({ type: "cu-reconnect" });
  $("status").textContent = "saved — connecting…";
  setTimeout(refreshStatus, 1500);
});

$("pair").addEventListener("click", pairWithCode);

load();
setInterval(refreshStatus, 5000);
