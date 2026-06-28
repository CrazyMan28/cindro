import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { AuthTokenService } from "../auth/authTokens.js";
import { AgentService } from "./agentService.js";
import { serverUrls } from "../setup/status.js";

export const EnrollAgentInputSchema = z.object({
  name: z.string().min(1).max(80),
  agentId: z.string().regex(/^[a-z0-9-]{2,64}$/).optional(),
  extension: z.string().regex(/^\d{2,8}$/).optional(),
  adapterType: z.string().min(1).max(64).default("remote-stdio"),
  capabilities: z.array(z.string()).default(["calls"]),
  systemPrompt: z.string().default(""),
  memoryTags: z.array(z.string()).default(["agent-phone"]),
  /** Optional command + mode the connector should run on the remote VM. */
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  mode: z.enum(["stdio", "tmux", "stub"]).default("stdio")
});
export type EnrollAgentInput = z.infer<typeof EnrollAgentInputSchema>;

export type McpConfigBlob = {
  mcpServers: {
    "agent-phone": {
      type: "streamable-http";
      url: string;
      headers: { Authorization: string };
    };
  };
};

export type EnrollmentPackage = {
  /** Stable id of the bootstrap row; appears in the bootstrap URL. */
  bootstrapId: string;
  /** The agent extension number (e.g. "107"). */
  extension: string;
  /** Stable agent id used in the agents table. */
  agentId: string;
  /** Human label. */
  name: string;
  /** Free-form adapter label. */
  adapterType: string;
  /** The per-agent bearer token. Shown ONCE. */
  token: string;
  /** HTTP base URL the agent should use for API + MCP calls. */
  serverUrl: string;
  /** WebSocket URL for the inbound connector. */
  wsUrl: string;
  /** MCP server config snippet to paste into the agent's own MCP client. */
  mcpConfig: McpConfigBlob;
  /** The runtime config the connector reads (matches AgentConfig shape). */
  connectorConfig: {
    extension: string;
    agentId: string;
    name: string;
    adapterType: string;
    mode: "stdio" | "tmux" | "stub";
    command: string | null;
    args: string[];
    systemPrompt: string;
    memoryTags: string[];
    capabilities: string[];
    token: string;
    serverUrl: string;
    wsUrl: string;
  };
  /** Public URL to the one-shot bootstrap shell installer. */
  bootstrapUrl: string;
  /** Ready-to-paste curl-pipe-bash command. */
  bootstrapCmd: string;
  /** When the bootstrap URL stops working. */
  expiresAt: string;
};

const BOOTSTRAP_TTL_HOURS = 24;

export class EnrollmentService {
  private readonly agents: AgentService;
  private readonly tokens: AuthTokenService;

  constructor(private readonly db: AppDatabase, private readonly config: AppConfig) {
    this.agents = new AgentService(db);
    this.tokens = new AuthTokenService(db);
  }

  enroll(input: EnrollAgentInput): EnrollmentPackage {
    const value = EnrollAgentInputSchema.parse(input);
    const agentId = value.agentId ?? slugify(value.name);
    const urls = serverUrls(this.config.server.port);
    // publicBaseUrl is always set in config; if it points at the bind-all
    // address (0.0.0.0 / ::) it's useless for a remote VM, so prefer the
    // Tailscale URL (or LAN, or local).
    const publicHost = safeHostname(this.config.server.publicBaseUrl);
    const serverUrl =
      (publicHost && publicHost !== "0.0.0.0" && publicHost !== "::"
        ? this.config.server.publicBaseUrl
        : undefined) ??
      urls.tailscaleUrls[0] ??
      urls.lanUrls[0] ??
      urls.localUrl;
    const wsUrl = httpToWs(serverUrl);

    // AgentService.onboard handles extension allocation (uses requestedExtension
    // or picks the next free in 105..899) and creates extensions + agents rows.
    const agent = this.agents.onboard({
      agentId,
      name: value.name,
      adapterType: value.adapterType,
      requestedExtension: value.extension,
      capabilities: value.capabilities,
      currentTask: "awaiting remote connector"
    });

    // Mint a per-agent bearer token scoped to the agent's extension. Tokens
    // store SHA-256 hashes only; the raw value is returned exactly once.
    const issued = this.tokens.issue({
      ownerType: "agent",
      ownerId: agent.id,
      scopes: ["agent", `ext:${agent.extension}`]
    });

    const connectorConfig: EnrollmentPackage["connectorConfig"] = {
      extension: agent.extension,
      agentId: agent.id,
      name: agent.name,
      adapterType: value.adapterType,
      mode: value.mode,
      command: value.command,
      args: value.args,
      systemPrompt: value.systemPrompt,
      memoryTags: value.memoryTags,
      capabilities: value.capabilities,
      token: issued.token,
      serverUrl,
      wsUrl
    };

    const mcpConfig: McpConfigBlob = {
      mcpServers: {
        "agent-phone": {
          type: "streamable-http",
          url: `${serverUrl.replace(/\/$/, "")}/mcp`,
          headers: { Authorization: `Bearer ${issued.token}` }
        }
      }
    };

    const bootstrapId = randomBytes(16).toString("base64url");
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_HOURS * 3_600_000).toISOString();
    const bootstrapUrl = `${serverUrl.replace(/\/$/, "")}/enroll/${bootstrapId}/sh`;
    const bootstrapCmd = `curl -fsSL ${bootstrapUrl} | bash`;

    const pkg: EnrollmentPackage = {
      bootstrapId,
      extension: agent.extension,
      agentId: agent.id,
      name: agent.name,
      adapterType: value.adapterType,
      token: issued.token,
      serverUrl,
      wsUrl,
      mcpConfig,
      connectorConfig,
      bootstrapUrl,
      bootstrapCmd,
      expiresAt
    };

    this.db.sqlite
      .prepare(
        `INSERT INTO enrollment_bootstrap (id, agent_id, extension, package_json, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(bootstrapId, agent.id, agent.extension, this.db.json(pkg), expiresAt, this.db.now());

    this.db.event("agent.enrolled", { agentId: agent.id, extension: agent.extension, tokenId: issued.id });
    return pkg;
  }

  consumeBootstrap(bootstrapId: string): EnrollmentPackage | undefined {
    const row = this.db.sqlite
      .prepare("SELECT * FROM enrollment_bootstrap WHERE id = ?")
      .get(bootstrapId) as { id: string; package_json: string; expires_at: string; used_at: string | null } | undefined;
    if (!row) return undefined;
    if (row.used_at) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
    this.db.sqlite.prepare("UPDATE enrollment_bootstrap SET used_at = ? WHERE id = ?").run(this.db.now(), bootstrapId);
    try {
      return JSON.parse(row.package_json) as EnrollmentPackage;
    } catch {
      return undefined;
    }
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug.length < 2) return `agent-${Date.now().toString(36)}`;
  return slug;
}

function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname; } catch { return undefined; }
}

function httpToWs(url: string): string {
  const u = new URL(url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}
