import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

type Built = Awaited<ReturnType<typeof makeTestApp>>;

const builts: Built[] = [];

afterEach(async () => {
  for (const built of builts.splice(0)) await built.app.close();
});

function formPost(built: Built, url: string, fields: Record<string, string>) {
  return built.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString()
  });
}

function mcpCall(built: Built, name: string, args: Record<string, unknown>) {
  return built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: authHeaders.agent,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
  });
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("sms ↔ agent bridge", () => {
  it("routes an inbound SMS to the selected agent and texts the agent's reply back", async () => {
    const built = await makeTestApp();
    builts.push(built);
    built.services.twilio.allowlistAdd("+15551234567");
    built.services.twilio.setSmsAgentEnabled(true);
    built.services.twilio.setSmsAgentExtension("101");

    // Inbound SMS → routed to the agent (ext 101), NOT the ext-100 inbox.
    const sms = await formPost(built, "/twilio/sms", {
      MessageSid: "SM_in_1",
      From: "+15551234567",
      Body: "hey codex, status?"
    });
    expect(sms.statusCode).toBe(200);

    const inbound = built.services.wsHub.messages
      .listMessages({ extension: "101" })
      .find((m) => m.body === "hey codex, status?");
    expect(inbound).toBeTruthy();
    expect(inbound!.to_extension).toBe("101");
    expect(inbound!.from_extension).toBe("700");

    // The agent answers into the same thread → outbound hook texts it back.
    const reply = await mcpCall(built, "notify_user", {
      from_extension: "101",
      to_extension: "700",
      title: "Codex",
      message: "All green — build passing.",
      thread_id: inbound!.thread_id
    });
    expect(reply.statusCode).toBe(200);

    await until(
      () => ((built.twilioApi.createMessage as any).mock.calls.length > 0 ? true : undefined),
      "outbound SMS sent"
    );
    expect(built.twilioApi.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551234567", from: "+15550001111", body: "All green — build passing." })
    );
  });

  it("leaves inbound SMS in the inbox (no agent, no outbound text) when the feature is OFF", async () => {
    const built = await makeTestApp();
    builts.push(built);
    built.services.twilio.allowlistAdd("+15551234567");
    // sms-agent defaults OFF.

    const sms = await formPost(built, "/twilio/sms", {
      MessageSid: "SM_off_1",
      From: "+15551234567",
      Body: "just a note"
    });
    expect(sms.statusCode).toBe(200);

    const inbox = built.services.wsHub.messages
      .listMessages({ extension: "100" })
      .find((m) => m.body === "just a note");
    expect(inbox).toBeTruthy();
    expect(inbox!.to_extension).toBe("100");
    expect(built.twilioApi.createMessage).not.toHaveBeenCalled();
  });

  it("the SMS-agent setting round-trips through /api/sms-agent", async () => {
    const built = await makeTestApp();
    builts.push(built);

    const set = await built.app.inject({
      method: "POST",
      url: "/api/sms-agent",
      headers: authHeaders.device,
      payload: { enabled: true, extension: "101" }
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ enabled: true, extension: "101" });

    const get = await built.app.inject({ method: "GET", url: "/api/sms-agent", headers: authHeaders.device });
    expect(get.json()).toMatchObject({ enabled: true, extension: "101" });

    // A non-agent extension is rejected.
    const bad = await built.app.inject({
      method: "POST",
      url: "/api/sms-agent",
      headers: authHeaders.device,
      payload: { extension: "100" }
    });
    expect(bad.statusCode).toBe(400);
  });
});
