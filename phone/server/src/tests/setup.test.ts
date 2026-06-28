import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { seedDemoData } from "../setup/demoSeed.js";
import { makeTestApp, authHeaders } from "./testApp.js";

describe("setup API", () => {
  const apps: Array<{ app: { close(): Promise<unknown> } }> = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("returns setup status to device auth without exposing secrets", async () => {
    const built = await makeTestApp();
    apps.push(built);

    const response = await built.app.inject({ method: "GET", url: "/api/setup/status", headers: authHeaders.device });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        server: expect.objectContaining({ webSocketPath: "/ws", webSocketUrl: expect.stringMatching(/^ws:\/\/.+\/ws$/) }),
        extensions: expect.objectContaining({ hasUser100: true, hasFakeAgent101: true }),
        mistral: expect.objectContaining({ apiKeyConfigured: false }),
        security: expect.objectContaining({ productionMode: false })
      })
    );
    const body = response.body;
    expect(body).not.toContain("admin-token-test");
    expect(body).not.toContain("device-token-test");
    expect(body).not.toContain("agent-token-test");
  });

  it("seeds demo extensions and agents idempotently through the admin endpoint", async () => {
    const built = await makeTestApp();
    apps.push(built);

    const first = await built.app.inject({ method: "POST", url: "/api/setup/dev-seed", headers: authHeaders.admin });
    const second = await built.app.inject({ method: "POST", url: "/api/setup/dev-seed", headers: authHeaders.admin });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(expect.objectContaining({ extensionCount: 7, agentCount: 3 }));

    const extensions = await built.app.inject({ method: "GET", url: "/api/extensions", headers: authHeaders.admin });
    const extensionRows = extensions.json();
    expect(extensionRows).toHaveLength(7);
    expect(extensionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extension: "100", name: "Android/User device" }),
        expect.objectContaining({ extension: "101", name: "Codex" }),
        expect.objectContaining({ extension: "700", name: "Phone (PSTN)" }),
        expect.objectContaining({ extension: "702", name: "Phone (BT Relay)" }),
        expect.objectContaining({ extension: "900", name: "Emergency / All Agents" })
      ])
    );

    const agents = await built.app.inject({ method: "GET", url: "/api/agents", headers: authHeaders.admin });
    expect(agents.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extension: "101", name: "Codex" }),
        expect.objectContaining({ extension: "103", name: "Copilot" })
      ])
    );
  });

  it("requires admin auth for dev seed", async () => {
    const built = await makeTestApp();
    apps.push(built);

    const response = await built.app.inject({ method: "POST", url: "/api/setup/dev-seed", headers: authHeaders.device });
    expect(response.statusCode).toBe(401);
  });

  it("warns when default tokens are configured and still hides token values", async () => {
    const config = loadConfig({
      DATABASE_URL: "file::memory:",
      ADMIN_TOKEN: "change-me-admin-token",
      DEVICE_TOKEN: "change-me-device-token",
      AGENT_TOKEN: "change-me-agent-token",
      LOG_LEVEL: "silent",
      MISTRAL_API_KEY: "secret-test-mistral-key",
      MISTRAL_REAL_AUDIO: "false",
      MISTRAL_ENABLE_REAL_CALLS: "false"
    });
    const built = await createApp(config);
    apps.push(built);
    seedDemoData(built.services.db);

    const response = await built.app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { authorization: "Bearer change-me-admin-token" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.security.defaultTokensDetected).toBe(true);
    expect(body.warnings).toContain("Default tokens are still configured. Rotate tokens before production.");
    expect(response.body).not.toContain("change-me-admin-token");
    expect(response.body).not.toContain("change-me-device-token");
    expect(response.body).not.toContain("change-me-agent-token");
    expect(response.body).not.toContain("secret-test-mistral-key");
  });

  it("rejects dev seed in production mode", async () => {
    const config = loadConfig({
      DATABASE_URL: "file::memory:",
      ADMIN_TOKEN: "strong-admin-token-000000000000000000000000",
      DEVICE_TOKEN: "strong-device-token-0000000000000000000000",
      AGENT_TOKEN: "strong-agent-token-00000000000000000000000",
      PRODUCTION_MODE: "true",
      LOG_LEVEL: "silent",
      MISTRAL_REAL_AUDIO: "false",
      MISTRAL_ENABLE_REAL_CALLS: "false"
    });
    const built = await createApp(config);
    apps.push(built);

    const response = await built.app.inject({
      method: "POST",
      url: "/api/setup/dev-seed",
      headers: { authorization: "Bearer strong-admin-token-000000000000000000000000" }
    });
    expect(response.statusCode).toBe(403);
  });
});
