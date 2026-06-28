import os from "node:os";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { AgentService } from "../agents/agentService.js";
import { ExtensionService } from "../extensions/extensionService.js";

const DEFAULT_TOKENS = new Set(["change-me-admin-token", "change-me-device-token", "change-me-agent-token"]);

export function setupStatus(config: AppConfig, db: AppDatabase) {
  const extensions = new ExtensionService(db);
  const agents = new AgentService(db);
  const extensionRows = extensions.list();
  const agentRows = agents.list();
  const urls = serverUrls(config.server.port);
  const defaultTokensDetected =
    DEFAULT_TOKENS.has(config.auth.adminToken) ||
    DEFAULT_TOKENS.has(config.auth.deviceToken) ||
    DEFAULT_TOKENS.has(config.auth.agentToken);
  const warnings: string[] = [];
  if (extensionRows.length === 0) warnings.push("No extensions are registered. Run ./scripts/dev-fix-empty-extensions.sh.");
  if (!extensions.get("100")) warnings.push("Extension 100 is missing. Android cannot register as the user device.");
  if (!extensions.get("101")) warnings.push("Extension 101 is missing. The fake agent cannot receive demo calls.");
  if (defaultTokensDetected) warnings.push("Default tokens are still configured. Rotate tokens before production.");
  if (!config.mistral.apiKey || config.mistral.apiKey === "replace-me") warnings.push("Mistral API key is not configured.");
  const androidUrl = urls.tailscaleUrls[0] ?? config.server.publicBaseUrl ?? urls.lanUrls[0] ?? urls.localUrl;

  return {
    ok: true,
    server: {
      host: config.server.host,
      port: config.server.port,
      publicUrl: config.server.publicBaseUrl,
      localUrl: urls.localUrl,
      lanUrls: urls.lanUrls,
      tailscaleUrls: urls.tailscaleUrls,
      androidUrl,
      webSocketPath: "/ws",
      webSocketUrl: httpToWs(androidUrl, "/ws")
    },
    database: {
      url: config.databaseUrl
    },
    extensions: {
      count: extensionRows.length,
      hasUser100: Boolean(extensions.get("100")),
      hasFakeAgent101: Boolean(extensions.get("101"))
    },
    agents: {
      count: agentRows.length
    },
    mistral: {
      realAudio: config.mistral.realAudio,
      apiKeyConfigured: Boolean(config.mistral.apiKey && config.mistral.apiKey !== "replace-me"),
      sttModel: config.mistral.sttModel,
      ttsModel: config.mistral.ttsModel,
      voiceConfigured: Boolean(config.mistral.voiceId)
    },
    security: {
      productionMode: config.productionMode,
      defaultTokensDetected
    },
    warnings
  };
}

export function httpToWs(baseUrl: string, path = "/ws") {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

export function serverUrls(port: number) {
  const localUrl = `http://127.0.0.1:${port}`;
  const lanUrls: string[] = [];
  const tailscaleUrls: string[] = [];
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return { localUrl, lanUrls, tailscaleUrls };
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const url = `http://${address.address}:${port}`;
      if (address.address.startsWith("100.")) tailscaleUrls.push(url);
      else lanUrls.push(url);
    }
  }
  return { localUrl, lanUrls, tailscaleUrls };
}
