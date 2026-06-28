import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { AgentService } from "./agentService.js";
import { type AgentConfig, type AgentsConfigFile, loadAgentsConfig } from "./agentsConfig.js";

export class AgentRegistry {
  private file: AgentsConfigFile;
  private byExtension = new Map<string, AgentConfig>();

  constructor(file: AgentsConfigFile = loadAgentsConfig()) {
    this.file = file;
    this.indexAgents();
  }

  reload(file: AgentsConfigFile = loadAgentsConfig()) {
    this.file = file;
    this.indexAgents();
  }

  private indexAgents() {
    this.byExtension.clear();
    for (const agent of this.file.agents) this.byExtension.set(agent.extension, agent);
  }

  lookup(extension: string): AgentConfig | undefined {
    return this.byExtension.get(extension);
  }

  list(): AgentConfig[] {
    return [...this.file.agents];
  }

  enabledList(): AgentConfig[] {
    return this.file.agents.filter((a) => a.enabled);
  }

  /**
   * Ensure DB rows exist for every configured agent. Idempotent — safe to call on
   * every server startup. Uses the existing ExtensionService + AgentService writers
   * so the rest of the system (presence, busy, calls) keeps working unchanged.
   */
  seed(db: AppDatabase) {
    const extensions = new ExtensionService(db);
    const agents = new AgentService(db);
    for (const cfg of this.file.agents) {
      try {
        extensions.create({
          extension: cfg.extension,
          ownerType: "agent",
          ownerId: cfg.agentId,
          name: cfg.name,
          permissions: { needsApprovalForDangerousCommands: true },
          allowedCallers: [],
          metadata: {
            adapterType: cfg.adapterType,
            adapterMode: cfg.mode,
            capabilities: cfg.capabilities,
            managedBy: "agents.config.json"
          }
        });
        agents.register({
          id: cfg.agentId,
          extension: cfg.extension,
          name: cfg.name,
          adapterType: cfg.adapterType,
          permissions: { needsApprovalForDangerousCommands: true },
          capabilities: cfg.capabilities,
          status: "offline",
          currentTask: `${cfg.mode} adapter (auto-spawn on dial)`
        });
      } catch (error) {
        // Per-agent collisions (e.g. extension already owned by a demo seed)
        // shouldn't abort the whole startup. Log via console because we don't
        // have a Fastify logger here, and move on. The DB row that already
        // exists keeps working.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`agent registry: skipped ${cfg.extension} (${cfg.agentId}): ${message}`);
      }
    }
  }
}
