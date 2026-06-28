import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

describe("MCP client compatibility", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("tools/call list_extensions returns text content and parsable JSON", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const res = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_extensions", arguments: {} } }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeTruthy();
    const content = body.result.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((entry: { type: string }) => entry.type === "json")).toBe(false);
    expect(content[0].type).toBe("text");
    expect(typeof content[0].text).toBe("string");
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toBeDefined();
    expect(body.result.structuredContent).toBeTruthy();
    expect(Array.isArray(body.result.structuredContent)).toBe(false);
    expect(typeof body.result.structuredContent).toBe("object");
    expect(body.result.structuredContent.items).toEqual(parsed);
  });

  it("tools/call list_agents returns text content", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const res = await built.app.inject({ method: "POST", url: "/mcp", headers: authHeaders.agent, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agents", arguments: {} } } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const content = body.result.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((entry: { type: string }) => entry.type === "json")).toBe(false);
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text);
    expect(Array.isArray(body.result.structuredContent)).toBe(false);
    expect(typeof body.result.structuredContent).toBe("object");
    expect(body.result.structuredContent.items).toEqual(parsed);
  });

  it("call_user_and_wait returns text content (timeout path)", async () => {
    const built = await makeTestApp();
    apps.push(built);
    // ensure extensions online so call proceeds
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension IN ('100','101')").run();
    const res = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "call_user_and_wait", arguments: { from_extension: "101", to_extension: "100", reason: "test", say: "hello", timeout_seconds: 1 } }
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const content = body.result.content;
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text);
    expect(Array.isArray(body.result.structuredContent)).toBe(false);
    expect(typeof body.result.structuredContent).toBe("object");
    expect(body.result.structuredContent).toEqual(parsed);
  });
});
