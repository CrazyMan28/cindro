#!/usr/bin/env node
// Send a REAL SMS from the USER'S OWN phone (their SIM/carrier) — free, instant,
// no Twilio, no registration. The text goes out as a normal message from the
// user's real number. Their phone must be online with SMS permission granted.
//
// Usage: node phone-device-sms.mjs "+15551234567" "your message"

const [number, ...rest] = process.argv.slice(2);
const body = rest.join(" ");
if (!number || !body.trim()) {
  console.error('usage: phone-device-sms "+15551234567" "message"');
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
      id: `device-sms-${Date.now()}`,
      method: "tools/call",
      params: { name: "device_sms", arguments: { to_number: number, body } }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`device sms failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  console.log(`Texted ${number} from your phone.`);
} catch (error) {
  console.error(`device sms failed: ${error?.message ?? error}`);
  process.exit(1);
}
