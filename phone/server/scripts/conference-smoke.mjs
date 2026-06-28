// Live smoke test for conference calls: lead policy + voice kick.
// Mock STT echoes printable audio bytes, so the "audio" we send IS the transcript.
import { WebSocket } from "ws";

const BASE = "http://127.0.0.1:18800";
const DEVICE_TOKEN = "vmdevice001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = [];
const ws = new WebSocket(`ws://127.0.0.1:18800/ws?token=${DEVICE_TOKEN}&extension=100&clientType=device`);
ws.on("message", (raw) => {
  const e = JSON.parse(raw.toString());
  if (["call_message", "tts_start", "conference_roster", "call_end", "call_accept", "dial_result"].includes(e.type)) {
    events.push(e);
    const who = e.fromExtension ?? e.kicked ?? "";
    const what = e.content ?? e.text ?? (e.members ? `members=${e.members}` : "") ?? "";
    console.log(`[evt] ${e.type} ${who} ${typeof what === "string" ? what.slice(0, 60) : what}`);
  }
});
await new Promise((r) => ws.on("open", r));
console.log("WS open");

// 1. Start conference with Alice(201) + Bob(202) + Carol(203)
const res = await fetch(`${BASE}/api/conference`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_TOKEN}` },
  body: JSON.stringify({ members: ["201", "202", "203"] })
});
const conf = await res.json();
console.log("conference:", res.status, JSON.stringify(conf));
if (!conf.ok) process.exit(1);
const callId = conf.callId;
await sleep(2000);

function turn(text) {
  ws.send(JSON.stringify({ type: "audio_start", callId, fromExtension: "100", audioFormat: "pcm_s16le", sampleRate: 16000, channels: 1 }));
  ws.send(JSON.stringify({ type: "audio_chunk", callId, fromExtension: "100", audioBase64: Buffer.from(text).toString("base64") }));
  ws.send(JSON.stringify({ type: "audio_end", callId, fromExtension: "100" }));
}

function repliesSince(mark) {
  return events.slice(mark).filter((e) => e.type === "call_message" && e.fromExtension !== "100" && e.source !== "stt").map((e) => `${e.fromExtension}:${(e.content ?? "").slice(0, 40)}`);
}

// 2. Unaddressed turn → ONLY the lead (Alice 201) should reply
let mark = events.length;
turn("status report please");
await sleep(5000);
console.log("TEST lead-only =>", JSON.stringify(repliesSince(mark)));

// 3. Named turn → only Bob
mark = events.length;
turn("bob are you there");
await sleep(5000);
console.log("TEST named-bob =>", JSON.stringify(repliesSince(mark)));

// 4. Everyone
mark = events.length;
turn("everyone sound off now");
await sleep(9000);
console.log("TEST everyone =>", JSON.stringify(repliesSince(mark)));

// 5. Kick the lead (Alice) → confirmation + lead promotion to Bob
mark = events.length;
turn("kick alice");
await sleep(5000);
console.log("TEST kick-alice events =>", JSON.stringify(events.slice(mark).filter((e) => ["conference_roster", "tts_start"].includes(e.type)).map((e) => e.type + ":" + (e.kicked ?? e.fromExtension ?? ""))));

mark = events.length;
turn("who is leading now");
await sleep(5000);
console.log("TEST new-lead =>", JSON.stringify(repliesSince(mark)));

// 6. Kick the rest → call must end
turn("kick bob");
await sleep(4000);
mark = events.length;
turn("kick carol");
await sleep(4000);
const ended = events.slice(mark).some((e) => e.type === "call_end");
console.log("TEST all-kicked-call-ends =>", ended);

const fin = await fetch(`${BASE}/api/calls/${callId}`, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } });
if (fin.ok) {
  const callRow = await fin.json();
  console.log("final call state:", callRow.state ?? callRow.call?.state);
}
ws.close();
process.exit(0);
