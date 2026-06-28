import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-agent model + thinking/reasoning settings, chosen from the phone's Settings
 * screen. Written to ~/.agent-phone/runtime/<extension>.json, which the CLI
 * bridges (codex-bridge / claude-bridge) read PER TURN — so a change takes effect
 * on the agent's next message without restarting it.
 */
export type AgentModelConfig = { model?: string; reasoning?: string };

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

function runtimeDir(): string {
  return path.join(os.homedir(), ".agent-phone", "runtime");
}
function runtimePath(extension: string): string {
  return path.join(runtimeDir(), `${extension}.json`);
}

export class ModelConfigService {
  get(extension: string): AgentModelConfig {
    try {
      const obj = JSON.parse(fs.readFileSync(runtimePath(extension), "utf8"));
      return {
        model: typeof obj.model === "string" && obj.model ? obj.model : undefined,
        reasoning: typeof obj.reasoning === "string" && obj.reasoning ? obj.reasoning : undefined
      };
    } catch {
      return {};
    }
  }

  set(extension: string, patch: AgentModelConfig): AgentModelConfig {
    const next = this.get(extension);
    if (patch.model !== undefined) next.model = patch.model?.trim() || undefined;
    if (patch.reasoning !== undefined) {
      const r = patch.reasoning?.trim().toLowerCase();
      next.reasoning = r && (REASONING_LEVELS as readonly string[]).includes(r) ? r : undefined;
    }
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(runtimePath(extension), JSON.stringify(next, null, 2));
    return next;
  }
}
