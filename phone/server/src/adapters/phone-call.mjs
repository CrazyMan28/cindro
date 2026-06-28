#!/usr/bin/env node
// Call the user from an agent: rings their phone. The agent then drives the live
// conversation itself — greets when they answer, then replies to what they say.
// Uses the server's call_user tool. Inherits AGENT_TOKEN / API_BASE_URL /
// AGENT_PHONE_EXTENSION from the agent process.
//
// Usage:
//   node phone-call.mjs "what to say"
//   node phone-call.mjs "the build is done, deploy?" --reason "needs a decision" --timeout 180

const argv = process.argv.slice(2);
let say = "";
let reason = "Agent calling";
let to = "100";
let timeout = 300;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--reason") reason = argv[++i] ?? reason;
  else if (a === "--to") to = argv[++i] ?? to;
  else if (a === "--timeout") timeout = parseInt(argv[++i] ?? "", 10) || timeout;
  else say = say ? `${say} ${a}` : a;
}
if (!say.trim()) {
  console.error('usage: phone-call "what to say" [--reason "why"] [--to 100] [--timeout 300]');
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
      id: `phone-call-${Date.now()}`,
      method: "tools/call",
      params: {
        name: "call_user",
        arguments: { from_extension: from, reason: say || reason }
      }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`call failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  // call_user just rings; this agent then drives the live conversation when they
  // answer (greets, then replies to what they say) — no need to wait here.
  console.log("ringing the user now; I'll talk with them live when they pick up.");
} catch (error) {
  console.error(`call failed: ${error?.message ?? error}`);
  process.exit(1);
}
