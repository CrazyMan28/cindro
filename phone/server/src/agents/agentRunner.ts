import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { repoRoot } from "../config.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { AgentRegistry } from "./agentRegistry.js";
import { defaultAgentsConfigPath } from "./agentsConfig.js";
import type { AgentConfig } from "./agentsConfig.js";
import type { AgentRecord } from "../types.js";

export type EnsureResult = { ok: true } | { ok: false; error: string };

/** Synthesized config for an agent that lives only in the DB (enrolled remote). */
export type RemoteAgentConfig = {
  extension: string;
  agentId: string;
  name: string;
  /** Always present on remote-only agents; AgentRunner uses this to skip auto-spawn. */
  transport: "remote";
};

type ChildEntry = {
  child: ChildProcess;
  startedAt: number;
  lastActive: number;
  lastLines: string[];
};

type IsOnlineFn = (extension: string) => boolean;

const UNIVERSAL_ADAPTER_PATH = path.join(repoRoot, "server", "src", "adapters", "universalAgent.ts");

/**
 * Owns the auto-spawn lifecycle for configured agents.
 *
 * On dial to a configured extension that isn't online yet, we spawn the
 * universalAgent adapter as a child process pointed at that extension. The
 * adapter authenticates back over the WebSocket as that agent, runs the
 * configured command, and responds to the inbound call.
 *
 * If the spawn fails (command missing, non-zero exit before online, timeout),
 * we surface a structured error so the caller can fail the call cleanly and
 * notify the user — no stuck "busy" state.
 */
export class AgentRunner {
  private children = new Map<string, ChildEntry>();
  private inFlight = new Map<string, Promise<EnsureResult>>();
  private logger: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };

  constructor(
    private readonly registry: AgentRegistry,
    private readonly config: AppConfig,
    private readonly isOnline: IsOnlineFn,
    logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
    private readonly db?: AppDatabase
  ) {
    this.logger = {
      info: (msg, meta) => (logger?.info ?? console.log)(meta ? `${msg} ${JSON.stringify(meta)}` : msg),
      warn: (msg, meta) => (logger?.warn ?? console.warn)(meta ? `${msg} ${JSON.stringify(meta)}` : msg),
      error: (msg, meta) => (logger?.error ?? console.error)(meta ? `${msg} ${JSON.stringify(meta)}` : msg)
    };
  }

  /**
   * Returns the local-spawnable config from agents.config.json if present,
   * otherwise the synthesized "remote" config if the DB has an agent row for
   * this extension. Returns undefined if the extension isn't an agent at all.
   */
  lookup(extension: string): AgentConfig | RemoteAgentConfig | undefined {
    const local = this.registry.lookup(extension);
    if (local) return local;
    if (!this.db) return undefined;
    const row = this.db.sqlite
      .prepare("SELECT * FROM agents WHERE extension = ?")
      .get(extension) as AgentRecord | undefined;
    if (!row) return undefined;
    return { extension: row.extension, agentId: row.id, name: row.name, transport: "remote" };
  }

  /**
   * Make sure an agent's adapter is up and reachable. Returns success once the
   * extension reports online. Returns a structured error otherwise.
   */
  async ensureRunning(extension: string): Promise<EnsureResult> {
    const found = this.lookup(extension);
    if (!found) return { ok: false, error: `extension ${extension} is not a configured agent` };

    // Remote-only agent: we can't spawn it from here. It must already be online.
    if ("transport" in found && found.transport === "remote") {
      if (this.isOnline(extension)) return { ok: true };
      return {
        ok: false,
        error: `remote agent ${found.name} (ext ${extension}) is not connected; start the connector on its host`
      };
    }

    // Local-spawnable agent from agents.config.json.
    const cfg = found as AgentConfig;
    if (!cfg.enabled) return { ok: false, error: `agent ${cfg.agentId} is disabled in agents.config.json` };
    if (this.isOnline(extension)) return { ok: true };

    const existing = this.inFlight.get(extension);
    if (existing) return existing;

    const promise = this.spawnAndWait(cfg);
    this.inFlight.set(extension, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(extension);
    }
  }

  status(extension: string): "online" | "spawning" | "offline" | "unknown" {
    if (!this.lookup(extension)) return "unknown";
    if (this.isOnline(extension)) return "online";
    if (this.inFlight.has(extension)) return "spawning";
    return "offline";
  }

  /** Note that an agent was just used, so the idle reaper leaves it alone. */
  markActive(extension: string) {
    const entry = this.children.get(extension);
    if (entry) entry.lastActive = Date.now();
  }

  /**
   * Kill connectors that have been idle longer than `idleMs` to free RAM. The
   * conversation lives in the DB, so the agent respawns with full context on the
   * next call/text. `isBusy` keeps an agent alive while it's on a call.
   */
  reapIdle(idleMs: number, isBusy: (extension: string) => boolean): string[] {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [ext, entry] of [...this.children]) {
      if (now - entry.lastActive < idleMs) continue;
      if (isBusy(ext)) continue;
      try {
        entry.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      this.children.delete(ext);
      reaped.push(ext);
    }
    return reaped;
  }

  killAll() {
    for (const [ext, entry] of this.children) {
      try {
        entry.child.kill("SIGTERM");
      } catch (error) {
        this.logger.warn(`failed to kill agent child for ext ${ext}`, { error: errorMessage(error) });
      }
    }
    this.children.clear();
  }

  private async spawnAndWait(cfg: AgentConfig): Promise<EnsureResult> {
    const child = this.spawnAdapter(cfg);
    if (!child) return { ok: false, error: `failed to spawn universal adapter for ${cfg.agentId}` };
    this.children.set(cfg.extension, { child, startedAt: Date.now(), lastActive: Date.now(), lastLines: [] });

    const onlineDeadline = Date.now() + cfg.timeoutSeconds * 1000;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exitOutput: string[] = [];

    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? null;
      exitSignal = signal ?? null;
      // Snapshot the diagnostics BEFORE deleting the entry — the error message
      // below reads them after this handler runs, and re-fetching from the map
      // returned undefined, so crash logs were always reported as empty.
      exitOutput = this.children.get(cfg.extension)?.lastLines ?? [];
      this.children.delete(cfg.extension);
    });

    while (Date.now() < onlineDeadline) {
      if (exited) {
        return {
          ok: false,
          error: `adapter for ${cfg.agentId} exited (code=${exitCode ?? "?"} signal=${exitSignal ?? "?"}). Last output: ${exitOutput.join(" | ").slice(0, 240)}`
        };
      }
      if (this.isOnline(cfg.extension)) return { ok: true };
      await sleep(150);
    }

    // Timeout — leave child running so the agent might still come online later,
    // but report this dial as failed so the caller can react.
    return {
      ok: false,
      error: `adapter for ${cfg.agentId} did not come online within ${cfg.timeoutSeconds}s; check the agent command and PATH`
    };
  }

  private spawnAdapter(cfg: AgentConfig): ChildProcess | null {
    try {
      const env = {
        ...process.env,
        AGENT_PHONE_EXTENSION: cfg.extension,
        AGENT_TOKEN: this.config.auth.agentToken,
        // Children spawned here run on the SAME machine as the server, so always
        // hand them a loopback URL. publicBaseUrl may be a Tailscale/LAN address,
        // and the /mcp-local endpoint (used for agent text replies) rejects any
        // non-loopback peer with 403 — which silently ate every local agent's
        // text/group reply on deployments with PUBLIC_BASE_URL set.
        API_BASE_URL: `http://127.0.0.1:${this.config.server.port}`,
        // Always hand the child an explicit, resolved config path. A bare ""
        // would defeat the child's `?? defaultPath` fallback (?? ignores ""),
        // making it load an empty config and fail every auto-spawn dial.
        AGENTS_CONFIG_PATH: process.env.AGENTS_CONFIG_PATH || defaultAgentsConfigPath(),
        ...(cfg.env ?? {})
      };
      this.logger.info(`spawning universal adapter for ${cfg.agentId}`, { extension: cfg.extension, mode: cfg.mode, command: cfg.command ?? "(stub)" });
      const child = spawn("npx", ["tsx", UNIVERSAL_ADAPTER_PATH, "--extension", cfg.extension], {
        env,
        cwd: cfg.cwd ?? repoRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const entry = () => this.children.get(cfg.extension);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const lines = text.split(/\r?\n/).filter(Boolean);
        const e = entry();
        if (e) e.lastLines = [...e.lastLines, ...lines].slice(-10);
        for (const line of lines) this.logger.info(`[agent:${cfg.extension}] ${line}`);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const lines = text.split(/\r?\n/).filter(Boolean);
        const e = entry();
        if (e) e.lastLines = [...e.lastLines, ...lines].slice(-10);
        for (const line of lines) this.logger.warn(`[agent:${cfg.extension}!] ${line}`);
      });
      child.once("error", (error) => {
        this.logger.error(`adapter spawn error for ${cfg.agentId}`, { error: errorMessage(error) });
      });
      return child;
    } catch (error) {
      this.logger.error(`spawnAdapter exception`, { error: errorMessage(error) });
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
