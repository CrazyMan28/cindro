import { loadConfig } from "../config.js";

const config = loadConfig();
const adminToken = process.env.ADMIN_TOKEN ?? config.auth.adminToken;
const baseUrl = (process.env.SERVER_URL ?? `http://127.0.0.1:${config.server.port}`).replace(/\/$/, "");

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type ExtensionRow = {
  extension: string;
  owner_type: string;
  owner_id: string;
  name: string;
  online: number;
  busy: number;
};

type AgentRow = {
  id: string;
  extension: string;
  name: string;
  adapter_type: string;
  status: string;
};

console.log(`Seeding demo data via ${baseUrl}`);
await request("/health");
const seeded = await request<{ extensionCount: number; agentCount: number }>("/api/setup/dev-seed", { method: "POST", body: "{}" });
const extensions = await request<ExtensionRow[]>("/api/extensions");
const agents = await request<AgentRow[]>("/api/agents");

console.log(`Extensions count: ${extensions.length} (seed result: ${seeded.extensionCount})`);
console.table(
  extensions.map((entry) => ({
    extension: entry.extension,
    owner: entry.owner_type,
    ownerId: entry.owner_id,
    name: entry.name,
    online: entry.online === 1 ? "yes" : "no",
    busy: entry.busy === 1 ? "yes" : "no"
  }))
);
console.log(`Agents count: ${agents.length} (seed result: ${seeded.agentCount})`);
console.table(
  agents.map((entry) => ({
    id: entry.id,
    extension: entry.extension,
    name: entry.name,
    adapter: entry.adapter_type,
    status: entry.status
  }))
);
