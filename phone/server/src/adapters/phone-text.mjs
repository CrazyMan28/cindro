#!/usr/bin/env node
// Text the user from an agent, via the Agent Phone server's notify_user tool.
// The agent process exports AGENT_TOKEN / API_BASE_URL / AGENT_PHONE_EXTENSION,
// which a spawned shell (e.g. Codex) inherits — so this just works on a call.
//
// Usage:
//   node phone-text.mjs "your message"
//   node phone-text.mjs "message" --to 100 --title "Codex" --urgent

const argv = process.argv.slice(2);
let body = "";
let to = "100";
let title = process.env.AGENT_NAME || "Codex";
let priority = "normal";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--to") to = argv[++i] ?? to;
  else if (a === "--title") title = argv[++i] ?? title;
  else if (a === "--urgent") priority = "urgent";
  else body = body ? `${body} ${a}` : a;
}
if (!body.trim()) {
  console.error('usage: phone-text "your message" [--to 100] [--title "Codex"] [--urgent]');
  process.exit(2);
}

const base = process.env.API_BASE_URL || process.env.SERVER_URL || "http://127.0.0.1:8799";
const token = process.env.AGENT_TOKEN || "";
const from = process.env.AGENT_PHONE_EXTENSION || "101";

try {
  const res = await fetch(new URL("/mcp-local", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `phone-text-${Date.now()}`,
      method: "tools/call",
      params: { name: "notify_user", arguments: { from_extension: from, to_extension: to, title, message: body, priority } }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`text failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  console.log(`texted ${to}: ${body}`);
} catch (error) {
  console.error(`text failed: ${error?.message ?? error}`);
  process.exit(1);
}
