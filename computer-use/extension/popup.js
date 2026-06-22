const $ = (id) => document.getElementById(id);

async function refresh() {
  let st;
  try {
    st = await chrome.runtime.sendMessage({ type: "cu-status" });
  } catch (e) {
    $("status").textContent = "service worker waking…";
    return;
  }
  if (!st) return;
  $("ver").textContent = "v" + (st.extVersion || "?");
  $("dot").className = "dot " + (st.connected ? "ok" : "bad");
  $("status").textContent = st.connected ? "connected" : "not connected";
  $("status").style.color = st.connected ? "#22c55e" : "#ef4444";
  $("server").textContent = "127.0.0.1:" + st.port;
  $("ping").textContent = st.lastPing
    ? Math.max(0, Math.round((Date.now() - st.lastPing) / 1000)) + "s ago"
    : "never";
  $("tabs").textContent = (st.attachedTabs || []).length;

  const warn = $("warn");
  if (!st.tokenSet) {
    warn.style.display = "block";
    warn.textContent = "No token configured — open Settings and paste the bearer token from ~/.computer-use/config.yaml.";
  } else if (!st.connected && st.lastCloseCode === 4401) {
    warn.style.display = "block";
    warn.textContent = "Server rejected the token (4401) — re-paste it in Settings.";
  } else if (!st.connected) {
    warn.style.display = "block";
    warn.textContent = "Server unreachable — is computer-use-mcp running? (systemctl --user status computer-use-mcp)";
  } else {
    warn.style.display = "none";
  }
}

$("reconnect").addEventListener("click", async () => {
  $("status").textContent = "reconnecting…";
  await chrome.runtime.sendMessage({ type: "cu-reconnect" }).catch(() => {});
  setTimeout(refresh, 1200);
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 1000);
