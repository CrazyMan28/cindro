#!/usr/bin/env node
// Manage which REAL phone numbers agents may call/text (and accept calls from).
// Use when the user tells you a number is allowed (or no longer allowed).
//
// Usage:
//   node phone-allow.mjs list
//   node phone-allow.mjs add +1XXXXXXXXXX "label"
//   node phone-allow.mjs remove +1XXXXXXXXXX
//   node phone-allow.mjs set-default +1XXXXXXXXXX   (the user's own number; auto-allowlists)

const [cmd, number, label] = process.argv.slice(2);
const base = process.env.API_BASE_URL || process.env.SERVER_URL || "http://127.0.0.1:8799";
const token = process.env.AGENT_TOKEN || "";

const tools = {
  list: { name: "twilio_allowlist_list", arguments: {} },
  add: { name: "twilio_allowlist_add", arguments: { phone_number: number, ...(label ? { label } : {}) } },
  remove: { name: "twilio_allowlist_remove", arguments: { phone_number: number } },
  "set-default": { name: "twilio_set_user_number", arguments: { phone_number: number } }
};
const params = tools[cmd];
if (!params || (cmd !== "list" && !number)) {
  console.error('usage: phone-allow list | add +1XXXXXXXXXX ["label"] | remove +1XXXXXXXXXX | set-default +1XXXXXXXXXX');
  process.exit(2);
}

try {
  const res = await fetch(new URL("/mcp-local", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: `phone-allow-${Date.now()}`, method: "tools/call", params })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`allowlist ${cmd} failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  const result = json.result?.result ?? json.result ?? {};
  if (cmd === "list") {
    const numbers = (result.numbers ?? []).map((n) => `${n.phone_number}${n.label ? ` (${n.label})` : ""}`);
    console.log(
      `allowed numbers: ${numbers.length ? numbers.join(", ") : "(none)"} | default user number: ${result.default_user_number ?? "(not set)"} | inbound agent ext: ${result.inbound_extension}`
    );
  } else {
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(`allowlist ${cmd} failed: ${error?.message ?? error}`);
  process.exit(1);
}
