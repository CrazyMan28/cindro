import { connectWs, send, sleep } from "./clientUtil.js";
import fs from "node:fs";
import path from "node:path";

const extension = process.env.DEVICE_EXTENSION ?? "100";
const deviceToken = process.env.DEVICE_TOKEN ?? "change-me-device-token";
const target = process.env.DIAL_EXTENSION ?? "101";
const audioFile = process.env.FAKE_ANDROID_AUDIO_FILE;
const audioFiles = (process.env.FAKE_ANDROID_AUDIO_FILES ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
const audioFormat =
  process.env.FAKE_ANDROID_AUDIO_FORMAT ??
  (audioFile ? normalizeAudioFormat(path.extname(audioFile).replace(".", "").toLowerCase()) : "pcm_s16le");
const scriptedResponses = (process.env.FAKE_ANDROID_RESPONSES ?? "Yes, restart it but do not delete logs.|Run backend tests first. If they pass, run all tests.")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
let activeCallId: string | undefined;
let dialed = false;
let responseIndex = 0;

const ws = connectWs(deviceToken, extension, "device");
ws.on("open", async () => {
  send(ws, { type: "presence_update", extension, online: true });
  console.log(`fake Android online at extension ${extension}`);
  if (!process.argv.includes("--wait-only")) {
    await sleep(500);
    dialed = true;
    send(ws, { type: "dial", fromExtension: extension, toExtension: target, reason: "CLI demo call", urgency: "normal" });
  }
});

ws.on("message", async (raw) => {
  const event = JSON.parse(raw.toString()) as Record<string, unknown>;
  console.log("[fake-android]", event.type);
  if (event.type === "incoming_call") {
    const call = event.call as { id: string; from_extension: string };
    activeCallId = call.id;
    send(ws, { type: "call_accept", callId: call.id, extension });
  }
  if (event.type === "dial_result") {
    const call = event.call as { id: string };
    activeCallId = call.id;
  }
  if (event.type === "call_accept" && activeCallId && dialed) {
    send(ws, { type: "call_message", callId: activeCallId, fromExtension: extension, content: "Hello agent, this is the text fallback path." });
    const audio = audioFile ? fs.readFileSync(audioFile) : Buffer.from("hello from fake android audio");
    send(ws, { type: "audio_start", callId: activeCallId, fromExtension: extension, audioFormat, sampleRate: 16_000, channels: 1 });
    send(ws, { type: "audio_chunk", callId: activeCallId, fromExtension: extension, audioBase64: audio.toString("base64") });
    send(ws, { type: "audio_end", callId: activeCallId, fromExtension: extension });
    await sleep(1500);
    send(ws, { type: "call_end", callId: activeCallId, extension, reason: "demo complete" });
    await sleep(300);
    ws.close();
    process.exit(0);
  }
  if (event.type === "tts_chunk") {
    const bytes = Buffer.from(String(event.audioBase64 ?? ""), "base64").length;
    console.log(`received TTS chunk ${bytes} bytes`);
  }
  if (event.type === "tts_end" && activeCallId && !dialed) {
    await sendScriptedAudioResponse();
  }
});

async function sendScriptedAudioResponse() {
  if (!activeCallId) return;
  const response = scriptedResponses[Math.min(responseIndex, scriptedResponses.length - 1)] ?? "Yes.";
  const responseAudioFile = audioFiles[responseIndex] ?? (responseIndex === 0 ? audioFile : undefined);
  responseIndex += 1;
  const audio = responseAudioFile ? fs.readFileSync(responseAudioFile) : Buffer.from(response);
  const responseFormat = responseAudioFile ? normalizeAudioFormat(path.extname(responseAudioFile).replace(".", "").toLowerCase()) : "pcm_s16le";
  send(ws, { type: "audio_start", callId: activeCallId, fromExtension: extension, audioFormat: responseFormat, sampleRate: 16_000, channels: 1 });
  send(ws, { type: "audio_chunk", callId: activeCallId, fromExtension: extension, audioBase64: audio.toString("base64") });
  send(ws, { type: "audio_end", callId: activeCallId, fromExtension: extension });
  await sleep(250);
}

function normalizeAudioFormat(format: string) {
  switch (format) {
    case "pcm":
      return "pcm_s16le";
    case "wav":
    case "mp3":
    case "flac":
    case "opus":
      return format;
    default:
      return "pcm_s16le";
  }
}
