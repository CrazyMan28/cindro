#!/usr/bin/env node
// Bridge between the Agent Phone universal stdio adapter and the standalone
// GitHub Copilot CLI (`copilot`). The universal adapter speaks a tiny NDJSON
// protocol on this process's stdin/stdout:
//   in:  {"kind":"session_start", systemPrompt, context, ...}
//        {"kind":"user_turn", "text":"..."}
//   out: {"action":"speak","text":"..."}   (spoken back to the caller)
//        {"action":"end"}                   (hang up)
//
// Each user turn runs `copilot -p <prompt> --allow-all-tools -s` non-interactively.
// Full-tool mode is intentional: the operator chose to let inbound calls drive
// Copilot's tools. Conversation continuity is kept by prepending a short rolling
// transcript to each prompt (the CLI is one-shot per invocation).

import { spawn } from "node:child_process";
import readline from "node:readline";

const COPILOT_BIN = process.env.COPILOT_BIN || "copilot";
const COPILOT_CWD = process.env.COPILOT_CWD || process.cwd();
const MAX_REPLY_CHARS = 1000;
const HISTORY_TURNS = 6;

let systemPrompt = "";
let callContext = "";
const history = []; // { role: "user" | "copilot", text }

const rl = readline.createInterface({ input: process.stdin });

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(msg) {
  process.stderr.write(`[copilot-bridge] ${msg}\n`);
}

function buildPrompt(userText) {
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  if (callContext) parts.push(`Relevant memory:\n${callContext}`);
  const recent = history.slice(-HISTORY_TURNS);
  if (recent.length) {
    parts.push(
      "Conversation so far:\n" +
        recent.map((t) => `${t.role === "user" ? "Caller" : "You"}: ${t.text}`).join("\n")
    );
  }
  parts.push(`Caller (by phone) just said: ${userText}`);
  parts.push("Reply briefly and conversationally for text-to-speech. No code blocks unless asked.");
  return parts.join("\n\n");
}

function runCopilot(prompt) {
  return new Promise((resolve) => {
    const args = [
      "-C",
      COPILOT_CWD,
      "-p",
      prompt,
      "--allow-all-tools",
      "-s",
      "--no-color",
      "--log-level",
      "none"
    ];
    let child;
    try {
      child = spawn(COPILOT_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve(`I couldn't start Copilot: ${error?.message ?? error}`);
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.on("error", (error) => resolve(`I couldn't start Copilot: ${error?.message ?? error}`));
    child.on("close", () => {
      const raw = (out.trim() || err.trim() || "").trim();
      if (!raw) {
        resolve("Copilot returned an empty response.");
        return;
      }
      if (/exceeded your monthly quota|quota/i.test(raw)) {
        resolve("Copilot's monthly quota is used up right now, so I can't get an answer until it resets.");
        return;
      }
      resolve(raw);
    });
  });
}

function tidy(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_REPLY_CHARS) return collapsed;
  return collapsed.slice(0, MAX_REPLY_CHARS) + " … that's the short version.";
}

let busy = false;

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.kind === "session_start") {
    systemPrompt = typeof msg.systemPrompt === "string" ? msg.systemPrompt : "";
    callContext = typeof msg.context === "string" ? msg.context : "";
    emit({ action: "speak", text: "Copilot here. What can I help you with?" });
    return;
  }

  if (msg.kind === "user_turn") {
    const userText = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!userText) return;
    if (/^(good ?bye|bye|hang up|that's all|that is all|we're done|were done)\b/i.test(userText)) {
      emit({ action: "speak", text: "Okay, talk soon." });
      emit({ action: "end" });
      return;
    }
    if (busy) {
      emit({ action: "speak", text: "Still working on the last one, give me a second." });
      return;
    }
    busy = true;
    history.push({ role: "user", text: userText });
    log(`user_turn: ${userText.slice(0, 120)}`);
    // Copilot's slash commands are interactive-only — answer /help honestly
    // and pass other /text through raw (the model treats it as a prompt).
    const isSlash = /^\s*\//.test(userText);
    if (isSlash && /^\/(help)?\s*$|^\/\?\s*$/.test(userText.trim())) {
      const help = [
        "COPILOT CLI — its slash commands are interactive-only;",
        "any /text you send here goes to Copilot as a prompt.",
        "",
        "Phone commands: /phone   (calls, voice, groups, /911 ...)"
      ].join("\n");
      history.push({ role: "copilot", text: help });
      emit({ action: "speak", text: help });
      busy = false;
      return;
    }
    const reply = await runCopilot(isSlash ? userText.trim() : buildPrompt(userText));
    const spoken = isSlash ? reply.trim().slice(0, 4000) : tidy(reply);
    history.push({ role: "copilot", text: spoken });
    emit({ action: "speak", text: spoken });
    busy = false;
    return;
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
