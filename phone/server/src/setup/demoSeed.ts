import type { AppDatabase } from "../db/database.js";
import { AgentService } from "../agents/agentService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { DEMO_AGENTS, DEMO_EXTENSIONS } from "./defaults.js";

export function seedDemoData(db: AppDatabase) {
  const extensions = new ExtensionService(db);
  const agents = new AgentService(db);
  const seededExtensions = DEMO_EXTENSIONS.map((entry) => extensions.create(entry));
  const seededAgents = DEMO_AGENTS.map((entry) => agents.register(entry));
  return {
    extensions: seededExtensions,
    agents: seededAgents,
    extensionCount: extensions.list().length,
    agentCount: agents.list().length
  };
}
