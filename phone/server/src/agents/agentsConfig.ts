import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { repoRoot } from "../config.js";

export const AgentConfigSchema = z.object({
  extension: z.string().regex(/^\d{2,8}$/),
  agentId: z.string().min(1),
  name: z.string().min(1),
  adapterType: z.string().min(1),
  mode: z.enum(["stdio", "tmux", "stub"]),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().optional(),
  tmuxSession: z.string().optional(),
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().positive().max(120).default(15),
  memoryTags: z.array(z.string()).default(["agent-phone"]),
  systemPrompt: z.string().default(""),
  capabilities: z.array(z.string()).default(["calls"]),
  env: z.record(z.string()).optional()
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentsConfigFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(AgentConfigSchema)
});

export type AgentsConfigFile = z.infer<typeof AgentsConfigFileSchema>;

export function defaultAgentsConfigPath(): string {
  return process.env.AGENTS_CONFIG_PATH ?? path.join(repoRoot, "server", "agents.config.json");
}

export function loadAgentsConfig(filePath: string = defaultAgentsConfigPath()): AgentsConfigFile {
  if (!fs.existsSync(filePath)) {
    return { version: 1, agents: [] };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return AgentsConfigFileSchema.parse(parsed);
}

export function summarizeAgent(agent: AgentConfig): string {
  const where = agent.cwd ? ` cwd=${agent.cwd}` : "";
  const cmd = agent.command ? ` cmd=${agent.command}${agent.args.length ? " " + agent.args.join(" ") : ""}` : " (built-in)";
  return `${agent.extension} ${agent.name} [${agent.mode}]${cmd}${where} enabled=${agent.enabled}`;
}

/** Adapter-type labels the project actually ships. Unknown values aren't fatal
 *  (adapterType is a descriptive label, not the dispatch key — the runner
 *  dispatches on `mode`), but an unrecognized one is worth flagging at boot. */
export const KNOWN_ADAPTER_TYPES = new Set([
  "codex-cli",
  "copilot-cli",
  "claude-code",
  "stub-echo",
  "remote-stdio",
  "tmux",
  "generic"
]);

export type AgentConfigProblem = { extension: string; agentId: string; severity: "error" | "warn"; message: string };

/**
 * Issue #18: validate agents.config.json at startup so a misconfigured agent
 * surfaces at boot instead of failing silently when a user finally dials it.
 *
 * Note: the original issue blamed an invalid `adapter_type`, but `adapterType`
 * is a free-form label that the runner never uses to resolve an adapter (it
 * dispatches on `mode`, which zod already enum-validates at load). The real
 * boot-time gap is *mode/command coherence*: a `stdio` agent with no `command`
 * spawns the universal adapter with nothing to run and only fails at dial time.
 */
export function validateAgentsConfig(file: AgentsConfigFile): AgentConfigProblem[] {
  const problems: AgentConfigProblem[] = [];
  const seenExtensions = new Map<string, string>();
  for (const agent of file.agents) {
    const base = { extension: agent.extension, agentId: agent.agentId };
    // stdio adapters are spawned by running `command` — without one the dial fails.
    if (agent.mode === "stdio" && !agent.command) {
      problems.push({ ...base, severity: "error", message: `mode "stdio" requires a "command" to run; none configured` });
    }
    // Duplicate extension → the registry index silently keeps only the last one.
    const prior = seenExtensions.get(agent.extension);
    if (prior) {
      problems.push({ ...base, severity: "error", message: `extension ${agent.extension} is already used by agent "${prior}"` });
    } else {
      seenExtensions.set(agent.extension, agent.agentId);
    }
    if (!KNOWN_ADAPTER_TYPES.has(agent.adapterType)) {
      problems.push({ ...base, severity: "warn", message: `adapterType "${agent.adapterType}" is not a known label (${[...KNOWN_ADAPTER_TYPES].join(", ")})` });
    }
  }
  return problems;
}
