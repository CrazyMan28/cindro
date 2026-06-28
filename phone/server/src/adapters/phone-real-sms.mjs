#!/usr/bin/env node
// Send a REAL SMS (Twilio) from an agent to the user's actual phone.
//
// Usage:
//   node phone-real-sms.mjs "your message"
//   node phone-real-sms.mjs "build done" --number +13193898338
//
// Only allowlisted numbers work. NOTE: toll-free SMS is blocked until toll-free
// verification completes (Twilio error 30032) — prefer the in-app text
// (phone-text.mjs) unless the user explicitly wants a real SMS.

const argv = process.argv.slice(2);
let body = "";
let number;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--number" || a === "--to") number = argv[++i] ?? number;
  else body = body ? `${body} ${a}` : a;
}
if (!body.trim()) {
  console.error('usage: phone-real-sms "message" [--number +1XXXXXXXXXX]');
  process.exit(2);
}

const base = process.env.API_BASE_URL || process.env.SERVER_URL || "http://127.0.0.1:8799";
const token = process.env.AGENT_TOKEN || "";

try {
  const res = await fetch(new URL("/mcp-local", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `phone-real-sms-${Date.now()}`,
      method: "tools/call",
      params: { name: "twilio_sms", arguments: { ...(number ? { to_number: number } : {}), body } }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`real sms failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  const result = json.result?.result ?? json.result ?? {};
  console.log(`real SMS accepted by Twilio (sid ${result.sid}) to ${result.to_number} — delivery may still be blocked until toll-free verification.`);
} catch (error) {
  console.error(`real sms failed: ${error?.message ?? error}`);
  process.exit(1);
}
