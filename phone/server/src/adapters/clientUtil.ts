import { WebSocket } from "ws";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), override: false });

export function serverUrl() {
  const raw = process.env.API_BASE_URL ?? process.env.SERVER_URL ?? process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.SERVER_PORT ?? "8799"}`;
  const url = new URL(raw);
  if (url.hostname === "0.0.0.0" || url.hostname === "::") url.hostname = "127.0.0.1";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function wsUrl(path = "/ws") {
  const url = new URL(serverUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url;
}

export async function fetchJson<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, serverUrl()), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export function connectWs(token: string, extension: string, clientType: "agent" | "device" = "agent") {
  const url = wsUrl();
  url.searchParams.set("token", token);
  url.searchParams.set("extension", extension);
  url.searchParams.set("clientType", clientType);
  console.log(`API URL: ${serverUrl()}`);
  // Never log the real token — this line lands in the server log / journald via
  // the AgentRunner's stdout capture, which would persist the secret in plaintext.
  const redacted = new URL(url.toString());
  redacted.searchParams.set("token", "<redacted>");
  console.log(`WS URL: ${redacted.toString()}`);
  return new WebSocket(url);
}

export function send(ws: WebSocket, event: Record<string, unknown>) {
  ws.send(JSON.stringify(event));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
