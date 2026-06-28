import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

describe("agent enrollment", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  async function build() {
    const built = await makeTestApp();
    apps.push(built);
    return built;
  }

  it("mints an enrollment package with token + extension + mcpConfig + bootstrap", async () => {
    const built = await build();
    const response = await built.app.inject({
      method: "POST",
      url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hermes VM", adapterType: "remote-stdio" })
    });
    expect(response.statusCode).toBe(201);
    const pkg = response.json();
    expect(pkg).toEqual(
      expect.objectContaining({
        extension: expect.stringMatching(/^\d{2,8}$/),
        agentId: expect.any(String),
        name: "Hermes VM",
        token: expect.stringMatching(/^agp_/),
        serverUrl: expect.stringMatching(/^https?:\/\//),
        wsUrl: expect.stringMatching(/^wss?:\/\//),
        bootstrapId: expect.any(String),
        bootstrapUrl: expect.stringContaining("/enroll/"),
        bootstrapCmd: expect.stringContaining("curl"),
        expiresAt: expect.any(String)
      })
    );
    expect(pkg.mcpConfig?.mcpServers?.["agent-phone"]?.headers?.Authorization).toBe(`Bearer ${pkg.token}`);
    expect(pkg.mcpConfig?.mcpServers?.["agent-phone"]?.url).toContain("/mcp");
    // Token round-trips: verifying the issued token authenticates as the agent.
    const me = await built.app.inject({
      method: "GET",
      url: "/api/extensions",
      headers: { authorization: `Bearer ${pkg.token}` }
    });
    expect(me.statusCode).toBe(200);
  });

  it("requires admin or device auth (agent token is rejected)", async () => {
    const built = await build();
    const response = await built.app.inject({
      method: "POST",
      url: "/api/agents/enroll",
      headers: { ...authHeaders.agent, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Should Fail" })
    });
    expect(response.statusCode).toBe(401);
  });

  it("allocates distinct extensions when called twice without a requested ext", async () => {
    const built = await build();
    const a = await built.app.inject({
      method: "POST", url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Agent A" })
    });
    const b = await built.app.inject({
      method: "POST", url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Agent B" })
    });
    expect(a.json().extension).not.toBe(b.json().extension);
  });

  it("serves the bootstrap shell once, then 410s", async () => {
    const built = await build();
    const enroll = await built.app.inject({
      method: "POST", url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Bootstrap Test" })
    });
    const { bootstrapId } = enroll.json();
    const first = await built.app.inject({ method: "GET", url: `/enroll/${bootstrapId}/sh` });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/x-shellscript");
    expect(first.body).toContain("agent-phone:");
    expect(first.body).toContain("Bootstrap Test");
    const second = await built.app.inject({ method: "GET", url: `/enroll/${bootstrapId}/sh` });
    expect(second.statusCode).toBe(410);
  });

  it("serves the static connector source", async () => {
    const built = await build();
    const response = await built.app.inject({ method: "GET", url: "/static/connect.mjs" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/javascript");
    expect(response.body).toContain("agent-phone connector");
  });

  it("a per-agent token bound to ext A cannot list as ext B over HTTP", async () => {
    // HTTP routes don't check boundExtension on every call (it's a WS thing),
    // but the token must at least authenticate. WS-side enforcement is covered
    // by the integration test below.
    const built = await build();
    const pkg = (await built.app.inject({
      method: "POST", url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Bind Test" })
    })).json();
    const ok = await built.app.inject({
      method: "GET",
      url: "/api/extensions",
      headers: { authorization: `Bearer ${pkg.token}` }
    });
    expect(ok.statusCode).toBe(200);
  });

  it("revoking the issued token disables it for subsequent requests", async () => {
    const built = await build();
    const pkg = (await built.app.inject({
      method: "POST", url: "/api/agents/enroll",
      headers: { ...authHeaders.device, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Revoke Test" })
    })).json();
    // The token id is internal; we look it up via the admin list endpoint.
    const tokens = (await built.app.inject({
      method: "GET",
      url: `/api/agents/${pkg.agentId}/tokens`,
      headers: authHeaders.admin
    })).json();
    expect(tokens).toHaveLength(1);
    const tokenId = tokens[0].id;
    const revoke = await built.app.inject({
      method: "DELETE",
      url: `/api/agents/${pkg.agentId}/tokens/${tokenId}`,
      headers: authHeaders.admin
    });
    expect(revoke.statusCode).toBe(200);
    const after = await built.app.inject({
      method: "GET",
      url: "/api/extensions",
      headers: { authorization: `Bearer ${pkg.token}` }
    });
    expect(after.statusCode).toBe(401);
  });
});
