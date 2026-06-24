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
  refreshStatus();
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

load();
setInterval(refreshStatus, 5000);
