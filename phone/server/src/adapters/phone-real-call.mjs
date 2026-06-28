#!/usr/bin/env node
// Place a REAL phone call (Twilio PSTN) from an agent: rings the user's actual
// cell phone, speaks `say` via TTS, waits for their spoken reply, and prints the
// transcript — so the calling brain sees the answer as command output.
//
// Usage:
//   node phone-real-call.mjs "what to say"
//   node phone-real-call.mjs "deploy is done, all good?" --number +13193898338 --reason "decision" --timeout 120
//
// Only allowlisted numbers connect (manage with phone-allow.mjs). Default number
// is the user's configured real phone. Trial account: the callee must PRESS A KEY
// at Twilio's preamble before they hear the agent.

const argv = process.argv.slice(2);
let say = "";
let number;
let reason = "Agent calling your real phone";
let timeout = 120;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--number" || a === "--to") number = argv[++i] ?? number;
  else if (a === "--reason") reason = argv[++i] ?? reason;
  else if (a === "--timeout") timeout = parseInt(argv[++i] ?? "", 10) || timeout;
  else say = say ? `${say} ${a}` : a;
}
if (!say.trim()) {
  console.error('usage: phone-real-call "what to say" [--number +1XXXXXXXXXX] [--reason "why"] [--timeout 120]');
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
      id: `phone-real-call-${Date.now()}`,
      method: "tools/call",
      params: {
        name: "twilio_call_and_wait",
        arguments: {
          ...(number ? { to_number: number } : {}),
          reason,
          say,
          from_extension: from,
          timeout_seconds: timeout,
          expected_response_type: "freeform"
        }
      }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    console.error(`real call failed: ${JSON.stringify(json.error ?? json)}`);
    process.exit(1);
  }
  const result = json.result?.result ?? json.result ?? {};
  if (result.ok) {
    console.log(`The user answered their real phone and said: "${result.user_transcript}"`);
  } else if (result.reason === "ended" && !result.answered) {
    console.log(
      "The call connected but ended before the conversation started — on a Twilio trial the user must PRESS A KEY at the preamble. They may not have pressed it. Consider texting them to press a key next time, then retry."
    );
  } else if (result.decision === "timeout" && !result.answered) {
    console.log("No answer on their real phone (rang out).");
  } else {
    console.log(`Real call did not get a reply: ${result.reason ?? result.decision ?? "unknown"}.`);
  }
} catch (error) {
  console.error(`real call failed: ${error?.message ?? error}`);
  process.exit(1);
}
