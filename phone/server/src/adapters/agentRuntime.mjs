// Shared per-agent runtime config (model + thinking/reasoning level) for the CLI
// bridges. The server writes it (via the Settings UI / API); the bridges read it
// PER TURN so a change from the phone takes effect on the next message — no
// restart needed.
//
// File: ~/.agent-phone/runtime/<extension>.json  ->  { "model": "...", "reasoning": "low" }

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function runtimeConfigPath(extension) {
  return path.join(os.homedir(), ".agent-phone", "runtime", `${extension}.json`);
}

export function readRuntimeConfig(extension) {
  if (!extension) return {};
  try {
    const obj = JSON.parse(readFileSync(runtimeConfigPath(extension), "utf8"));
    return {
      model: typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined,
      reasoning: typeof obj.reasoning === "string" && obj.reasoning.trim() ? obj.reasoning.trim().toLowerCase() : undefined
    };
  } catch {
    return {};
  }
}

/** Claude extended-thinking budget (MAX_THINKING_TOKENS) per level. */
export function claudeThinkingTokens(reasoning) {
  switch ((reasoning || "").toLowerCase()) {
    case "minimal": return 0;
    case "low": return 2048;
    case "medium": return 8192;
    case "high": return 16384;
    case "xhigh": return 31999;
    default: return undefined;
  }
}

/** Codex `model_reasoning_effort` per level (codex tops out at "high"). */
export function codexReasoningEffort(reasoning) {
  switch ((reasoning || "").toLowerCase()) {
    case "minimal": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "high";
    default: return undefined;
  }
}
