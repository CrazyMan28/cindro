import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

async function callTool(app: Awaited<ReturnType<typeof makeTestApp>>, name: string, args: Record<string, unknown>) {
  const response = await app.app.inject({
    method: "POST",
    url: "/mcp",
    headers: authHeaders.agent,
    payload: { jsonrpc: "2.0", id: `t-${name}-${Math.random()}`, method: "tools/call", params: { name, arguments: args } }
  });
  expect(response.statusCode).toBe(200);
  return response.json().result;
}

describe("In-app messaging", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("notify_user creates a message row and a thread and stores a memory", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const result = await callTool(built, "notify_user", {
      from_extension: "101",
      to_extension: "100",
      title: "Build green",
      message: "All tests pass",
      priority: "normal"
    });

    const inner = result.result;
    expect(inner.ok).toBe(true);
    expect(inner.message_id).toMatch(/^amsg_/);
    expect(inner.thread_id).toMatch(/^thr_/);

    const messages = built.services.db.sqlite.prepare("SELECT * FROM agent_messages").all();
    expect(messages).toHaveLength(1);
    expect((messages[0] as { title: string }).title).toBe("Build green");
    expect((messages[0] as { status: string }).status).toBe("queued");

    const events = built.services.db.sqlite.prepare("SELECT type FROM events ORDER BY created_at").all() as { type: string }[];
    expect(events.map((row) => row.type)).toContain("message_sent");
  });

  it("MCP response schema stays Claude/Copilot compatible", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const result = await callTool(built, "notify_user", {
      from_extension: "101",
      title: "Hello",
      message: "schema check"
    });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(typeof result.structuredContent).toBe("object");
    expect(Array.isArray(result.structuredContent)).toBe(false);
  });

  it("notify_user_and_wait times out cleanly and reports it", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const result = await callTool(built, "notify_user_and_wait", {
      from_extension: "101",
      title: "Decision",
      message: "Approve restart?",
      options: ["approve", "deny"],
      timeout_seconds: 1
    });
    const inner = result.result;
    expect(inner.ok).toBe(true);
    expect(inner.replied).toBe(false);
    expect(inner.timeout).toBe(true);
    expect(inner.message_id).toMatch(/^amsg_/);
  }, 5000);

  it("HTTP reply writes a symmetric reply row and emits message_replied", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const created = await callTool(built, "notify_user", {
      from_extension: "101",
      title: "Need yes/no",
      message: "Proceed?"
    });
    const messageId = created.result.message_id;
    const reply = await built.app.inject({
      method: "POST",
      url: `/api/messages/${messageId}/reply`,
      headers: authHeaders.device,
      payload: { response_text: "yes please" }
    });
    expect(reply.statusCode).toBe(200);
    const allMessages = built.services.db.sqlite.prepare("SELECT * FROM agent_messages ORDER BY created_at").all() as { status: string; from_extension: string; body: string }[];
    expect(allMessages.length).toBe(2);
    expect(allMessages[0].status).toBe("replied");
    expect(allMessages[1].body).toBe("yes please");

    const events = built.services.db.sqlite.prepare("SELECT type FROM events ORDER BY created_at").all() as { type: string }[];
    expect(events.map((row) => row.type)).toContain("message_replied");
  });

  it("call_user_and_wait falls back to text when user is offline", async () => {
    const built = await makeTestApp();
    apps.push(built);
    // Ensure ext 100 is offline (default seed leaves online=0)
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 0, busy = 0 WHERE extension = '100'").run();
    const result = await callTool(built, "call_user_and_wait", {
      from_extension: "101",
      to_extension: "100",
      reason: "test fallback",
      say: "are you there",
      timeout_seconds: 1,
      fallback_to_text: true,
      fallback_timeout_seconds: 1
    });
    const inner = result.result;
    expect(inner.ok).toBe(false);
    expect(inner.fallback_sent).toBe(true);
    expect(inner.fallback_message_id).toMatch(/^amsg_/);
    expect(inner.call_answered).toBe(false);
    const events = built.services.db.sqlite.prepare("SELECT type FROM events").all() as { type: string }[];
    expect(events.map((row) => row.type)).toContain("fallback_sent");
  }, 7000);

  it("send_call_receipt writes inbox row + memory + receipt_sent event", async () => {
    const built = await makeTestApp();
    apps.push(built);
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension IN ('100','101')").run();
    const session = await callTool(built, "create_session", { agent_id: "test-agent", task: "qa" });
    const sessionId = session.result.id;
    const call = await callTool(built, "call_user", { from_extension: "101", reason: "test", session_id: sessionId });
    const callId = call.result.id;
    const receipt = await callTool(built, "send_call_receipt", { call_id: callId });
    const inner = receipt.result;
    expect(inner.ok).toBe(true);
    expect(inner.message_id).toMatch(/^amsg_/);
    expect(inner.summary).toContain(callId);
    const memories = built.services.db.sqlite.prepare("SELECT * FROM memories WHERE tags LIKE '%receipt%'").all();
    expect(memories.length).toBeGreaterThan(0);
    const events = built.services.db.sqlite.prepare("SELECT type FROM events").all() as { type: string }[];
    expect(events.map((row) => row.type)).toContain("receipt_sent");
  });

  it("send_live_log_drop writes inbox row + live_log_drop_sent event", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const result = await callTool(built, "send_live_log_drop", {
      from_extension: "101",
      title: "Progress",
      log_text: "step 1\nstep 2"
    });
    const inner = result.result;
    expect(inner.ok).toBe(true);
    expect(inner.message_id).toMatch(/^amsg_/);
    expect(inner.pushed_in_call).toBe(false);
    const events = built.services.db.sqlite.prepare("SELECT type FROM events").all() as { type: string }[];
    expect(events.map((row) => row.type)).toContain("live_log_drop_sent");
  });
});
