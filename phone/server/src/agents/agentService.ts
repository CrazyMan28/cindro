import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import type { AgentRecord } from "../types.js";

const RegisterAgentSchema = z.object({
  id: z.string().min(1),
  extension: z.string().regex(/^\d{2,8}$/),
  name: z.string().min(1),
  adapterType: z.string().min(1),
  permissions: z.record(z.unknown()).default({}),
  capabilities: z.array(z.string()).default([]),
  status: z.string().default("online"),
  currentTask: z.string().optional(),
  sessionId: z.string().optional()
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;

const OnboardAgentSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  adapterType: z.string().min(1),
  requestedExtension: z.string().regex(/^\d{2,8}$/).optional(),
  capabilities: z.array(z.string()).default([]),
  currentTask: z.string().optional()
});

export type OnboardAgentInput = z.infer<typeof OnboardAgentSchema>;

export class AgentService {
  private readonly extensions: ExtensionService;

  constructor(private readonly db: AppDatabase) {
    this.extensions = new ExtensionService(db);
  }

  register(input: RegisterAgentInput) {
    const value = RegisterAgentSchema.parse(input);
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO agents
         (id, extension, name, adapter_type, permissions, capabilities, status, current_task, session_id, last_heartbeat_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           extension=excluded.extension,
           name=excluded.name,
           adapter_type=excluded.adapter_type,
           permissions=excluded.permissions,
           capabilities=excluded.capabilities,
           status=excluded.status,
           current_task=excluded.current_task,
           session_id=excluded.session_id,
           last_heartbeat_at=COALESCE(excluded.last_heartbeat_at, agents.last_heartbeat_at),
           updated_at=excluded.updated_at`
      )
      .run(
        value.id,
        value.extension,
        value.name,
        value.adapterType,
        this.db.json(value.permissions),
        this.db.json(value.capabilities),
        value.status,
        value.currentTask ?? null,
        value.sessionId ?? null,
        value.status === "online" ? now : null,
        now,
        now
      );
    // PRESERVE existing extension metadata (esp. the user's voice profile under
    // metadata.voice) across re-registration. An agent registers on EVERY spawn
    // (a call, a text), and a bare overwrite here wiped the chosen voice — so a
    // call to a Jarvis-voiced agent reverted to the default Mistral voice.
    const existing = this.extensions.get(value.extension);
    const priorMetadata = existing ? this.db.parseJson<Record<string, unknown>>(existing.metadata, {}) : {};
    this.extensions.create({
      extension: value.extension,
      ownerType: "agent",
      ownerId: value.id,
      name: value.name,
      permissions: value.permissions,
      allowedCallers: [],
      metadata: { ...priorMetadata, adapterType: value.adapterType, capabilities: value.capabilities }
    });
    this.updateStatus(value.id, value.status, value.currentTask, value.sessionId);
    this.db.event("agent.registered", { agentId: value.id, extension: value.extension }, value.extension, undefined, value.sessionId);
    return this.get(value.id)!;
  }

  onboard(input: OnboardAgentInput) {
    const value = OnboardAgentSchema.parse(input);
    const existing = this.get(value.agentId);
    const extension = this.resolveExtensionForOnboard(value.agentId, value.requestedExtension, existing?.extension);
    return this.register({
      id: value.agentId,
      extension,
      name: value.name,
      adapterType: value.adapterType,
      permissions: {},
      capabilities: value.capabilities,
      status: existing?.status ?? "offline",
      currentTask: value.currentTask,
      sessionId: existing?.session_id ?? undefined
    });
  }

  list() {
    return this.db.sqlite.prepare("SELECT * FROM agents ORDER BY extension").all() as AgentRecord[];
  }

  get(id: string) {
    return this.db.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRecord | undefined;
  }

  getByExtension(extension: string) {
    return this.db.sqlite.prepare("SELECT * FROM agents WHERE extension = ?").get(extension) as AgentRecord | undefined;
  }

  updateStatus(id: string, status: string, currentTask?: string, sessionId?: string) {
    const agent = this.get(id);
    if (!agent) return undefined;
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE agents SET status = ?, current_task = ?, session_id = ?, last_heartbeat_at = CASE WHEN ? != 'offline' THEN ? ELSE last_heartbeat_at END, updated_at = ? WHERE id = ?")
      .run(status, currentTask ?? null, sessionId ?? null, status, now, now, id);
    this.db.sqlite
      .prepare(
        `INSERT INTO agent_presence (agent_id, extension, status, current_task, session_id, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           extension=excluded.extension,
           status=excluded.status,
           current_task=excluded.current_task,
           session_id=excluded.session_id,
           last_seen_at=excluded.last_seen_at`
      )
      .run(id, agent.extension, status, currentTask ?? null, sessionId ?? null, now);
    this.extensions.setPresence(agent.extension, status !== "offline", sessionId ?? null);
    this.db.event("agent.status", { agentId: id, status, currentTask: currentTask ?? null }, agent.extension, undefined, sessionId);
    return this.get(id);
  }

  heartbeat(id: string, status: string, currentTask?: string, sessionId?: string) {
    const agent = this.updateStatus(id, status, currentTask, sessionId);
    if (!agent) return undefined;
    const now = this.db.now();
    this.db.sqlite.prepare("UPDATE agents SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    this.db.sqlite
      .prepare("UPDATE agent_presence SET last_seen_at = ?, status = ?, current_task = ?, session_id = ? WHERE agent_id = ?")
      .run(now, status, currentTask ?? null, sessionId ?? null, id);
    return this.get(id);
  }

  expireHeartbeats(timeoutSeconds: number) {
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
    const stale = this.db.sqlite
      .prepare("SELECT id FROM agents WHERE status != 'offline' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?")
      .all(cutoff) as Array<{ id: string }>;
    for (const agent of stale) this.updateStatus(agent.id, "offline");
    return stale.length;
  }

  private resolveExtensionForOnboard(agentId: string, requestedExtension?: string, existingExtension?: string) {
    if (requestedExtension) {
      const current = this.extensions.get(requestedExtension);
      if (current && current.owner_id !== agentId) {
        throw Object.assign(new Error(`extension ${requestedExtension} is already assigned`), { statusCode: 409 });
      }
      return requestedExtension;
    }
    if (existingExtension) return existingExtension;
    for (let extension = 105; extension <= 899; extension += 1) {
      const candidate = String(extension);
      if (!this.extensions.get(candidate)) return candidate;
    }
    throw Object.assign(new Error("no_dynamic_extensions_available"), { statusCode: 409 });
  }
}
