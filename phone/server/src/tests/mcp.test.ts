import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

describe("MCP tools", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("lists tools and stores memory", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const list = await built.app.inject({ method: "POST", url: "/mcp", headers: authHeaders.agent, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(list.json().result.tools.map((tool: { name: string }) => tool.name)).toContain("call_user");

    const store = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_memory", arguments: { scope: "repo", key: "failure", content: "npm test failed", tags: ["test"] } } }
    });
    expect(store.statusCode).toBe(200);

    const search = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_memory", arguments: { query: "npm" } } }
    });
    expect(search.json().result.result).toHaveLength(1);
  });

  it("call_user routes to extension 100 and logs the tool call", async () => {
    const built = await makeTestApp();
    apps.push(built);
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension IN ('100','101')").run();
    const response = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "call_user", arguments: { from_extension: "101", reason: "approval needed" } } }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.result.to_extension).toBe("100");
    const rows = built.services.db.sqlite.prepare("SELECT * FROM mcp_tool_calls WHERE tool_name = 'call_user'").all();
    expect(rows).toHaveLength(1);
  });

  it("requires approval for dangerous terminal input", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const session = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: "s", method: "tools/call", params: { name: "create_session", arguments: { agent_id: "tmux-agent", repo_path: "/tmp/repo", task: "test" } } }
    });
    const sessionId = session.json().result.result.id;
    const response = await built.app.inject({
      method: "POST",
      url: "/mcp",
      headers: authHeaders.agent,
      payload: { jsonrpc: "2.0", id: "danger", method: "tools/call", params: { name: "send_terminal_input", arguments: { session_id: sessionId, input: "sudo rm -rf /tmp/example" } } }
    });
    const result = response.json().result.result;
    expect(result.requiresApproval).toBe(true);
    expect(result.sent).toBe(false);
    const approvals = built.services.db.sqlite.prepare("SELECT * FROM approvals WHERE state = 'pending'").all();
    expect(approvals).toHaveLength(1);
  });
});
