import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { makeTestApp, authHeaders } from "./testApp.js";
import { mulawEncode } from "../audio/g711.js";

type Built = Awaited<ReturnType<typeof makeTestApp>>;

const builts: Built[] = [];
const sockets: WebSocket[] = [];

function track(socket: WebSocket): WebSocket {
  sockets.push(socket);
  return socket;
}

afterEach(async () => {
  // Close client sockets FIRST and wait for them — their disconnect handlers
  // touch the DB, which app.close() is about to shut down.
  await Promise.all(
    sockets.splice(0).map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          try {
            socket.close();
          } catch {
            resolve();
          }
        })
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const built of builts.splice(0)) await built.app.close();
});

async function listeningApp(): Promise<{ built: Built; host: string }> {
  const built = await makeTestApp();
  builts.push(built);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { built, host: `127.0.0.1:${port}` };
}

function mcpCall(built: Built, name: string, args: Record<string, unknown>) {
  return built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: authHeaders.agent,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
  });
}

function toolResult(response: { json(): any }): any {
  return response.json().result?.result ?? response.json().result;
}

function formPost(built: Built, url: string, fields: Record<string, string>) {
  return built.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString()
  });
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 20ms of loud 8kHz audio (alternating square) as a base64 mulaw Twilio frame. */
function loudFrame(): string {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i % 2 === 0 ? 9000 : -9000, i * 2);
  return mulawEncode(pcm).toString("base64");
}

function silentFrame(): string {
  return mulawEncode(Buffer.alloc(320)).toString("base64");
}

describe("twilio outbound call bridge", () => {
  it("twilio_call_and_wait places the call, speaks TTS to the stream, and returns the caller's transcript", async () => {
    const { built, host } = await listeningApp();
    built.services.twilio.allowlistAdd("+15551234567", "Kizek");

    const resultPromise = mcpCall(built, "twilio_call_and_wait", {
      to_number: "+15551234567",
      reason: "integration test",
      say: "hello from the agent",
      from_extension: "101",
      timeout_seconds: 30,
      expected_response_type: "freeform"
    });

    // The tool dials internally then asks (fake) Twilio for a call — grab the mapping.
    const row = await until(
      () => built.services.db.sqlite.prepare("SELECT * FROM twilio_calls WHERE direction = 'outbound'").get() as
        | { call_id: string; call_sid: string }
        | undefined,
      "outbound twilio_calls row"
    );
    expect(built.twilioApi.createCall).toHaveBeenCalledTimes(1);

    // Simulate Twilio opening the bidirectional media stream.
    const media = track(new WebSocket(`ws://${host}/twilio/media`));
    const mediaFrames: string[] = [];
    let sawMark = false;
    media.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.event === "media") mediaFrames.push(event.media.payload);
      if (event.event === "mark") {
        sawMark = true;
        // Twilio echoes the mark back once playback finishes.
        media.send(JSON.stringify({ event: "mark", streamSid: "MZ_test_1", mark: event.mark }));
        // Now the user talks: sustained speech then trailing silence.
        for (let i = 0; i < 12; i++) media.send(JSON.stringify({ event: "media", media: { payload: loudFrame() } }));
        for (let i = 0; i < 45; i++) media.send(JSON.stringify({ event: "media", media: { payload: silentFrame() } }));
      }
    });
    media.on("open", () => {
      media.send(JSON.stringify({ event: "connected", protocol: "Call" }));
      media.send(
        JSON.stringify({
          event: "start",
          start: {
            streamSid: "MZ_test_1",
            callSid: row.call_sid,
            customParameters: { internalCallId: row.call_id, direction: "outbound" }
          }
        })
      );
    });

    const response = await resultPromise;
    const result = toolResult(response);
    expect(result.ok).toBe(true);
    expect(result.answered).toBe(true);
    expect(result.user_transcript).toContain("mock transcript");
    expect(result.twilio_call_sid).toBe(row.call_sid);
    expect(result.phone_number).toBe("+15551234567");
    expect(sawMark).toBe(true);
    expect(mediaFrames.length).toBeGreaterThan(0); // agent TTS reached the phone line

    // The call is in the same calls table the app's History screen renders.
    const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(row.call_id) as Record<string, unknown>;
    expect(call.to_extension).toBe("700");
    expect(String(call.reason)).toContain("+15551234567");
  });

  it("refuses to call numbers that are not allowlisted", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const response = await mcpCall(built, "twilio_call_and_wait", {
      to_number: "+15550009999",
      reason: "nope",
      say: "hi",
      from_extension: "101"
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("allowlist");
    expect(built.twilioApi.createCall).not.toHaveBeenCalled();
  });

  it("resolves as timeout when the status callback reports no-answer", async () => {
    const { built } = await listeningApp();
    built.services.twilio.allowlistAdd("+15551234567");
    const resultPromise = mcpCall(built, "twilio_call_and_wait", {
      to_number: "+15551234567",
      reason: "no answer test",
      say: "hello?",
      from_extension: "101",
      timeout_seconds: 20
    });
    const row = await until(
      () => built.services.db.sqlite.prepare("SELECT * FROM twilio_calls WHERE direction = 'outbound'").get() as
        | { call_sid: string }
        | undefined,
      "outbound twilio_calls row"
    );
    const status = await formPost(built, "/twilio/status", { CallSid: row.call_sid, CallStatus: "no-answer" });
    expect(status.statusCode).toBe(200);
    const result = toolResult(await resultPromise);
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("timeout");
  });
});

describe("twilio inbound call bridge", () => {
  it("answers an allowlisted caller and bridges them to the registered agent extension", async () => {
    const { built, host } = await listeningApp();
    built.services.twilio.allowlistAdd("+15551234567", "Kizek");

    // A fake agent client on ext 101 that auto-accepts incoming calls.
    const agent = track(new WebSocket(`ws://${host}/ws?token=agent-token-test&extension=101&clientType=agent`));
    let agentSawIncoming = false;
    agent.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "incoming_call") {
        agentSawIncoming = true;
        agent.send(JSON.stringify({ type: "call_accept", callId: event.call.id, extension: "101" }));
      }
    });
    await new Promise((resolve) => agent.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100)); // let auth settle

    const voice = await formPost(built, "/twilio/voice", { CallSid: "CA_inbound_1", From: "+15551234567" });
    expect(voice.statusCode).toBe(200);
    expect(voice.body).toContain("<Connect>");
    expect(voice.body).toContain("/twilio/media");

    const media = track(new WebSocket(`ws://${host}/twilio/media`));
    media.on("open", () => {
      media.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ_in_1", callSid: "CA_inbound_1", customParameters: { direction: "inbound" } }
        })
      );
    });

    const call = await until(
      () =>
        built.services.db.sqlite
          .prepare("SELECT * FROM calls WHERE from_extension = '700' AND state = 'active'")
          .get() as Record<string, unknown> | undefined,
      "active inbound PSTN call"
    );
    expect(call.to_extension).toBe("101");
    expect(String(call.reason)).toContain("+15551234567");
    expect(agentSawIncoming).toBe(true);
    const twilioRow = built.services.twilio.findByCallSid("CA_inbound_1");
    expect(twilioRow).toMatchObject({ direction: "inbound", phone_number: "+15551234567" });
  });

  it("rejects callers that are not on the allowlist", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const voice = await formPost(built, "/twilio/voice", { CallSid: "CA_bad_1", From: "+15550009999" });
    expect(voice.statusCode).toBe(200);
    expect(voice.body).toContain("<Reject/>");
  });
});

describe("twilio sms", () => {
  it("twilio_sms sends to an allowlisted number", async () => {
    const built = await makeTestApp();
    builts.push(built);
    built.services.twilio.allowlistAdd("+15551234567");
    const response = await mcpCall(built, "twilio_sms", { to_number: "+15551234567", body: "build finished" });
    const result = toolResult(response);
    expect(result.ok).toBe(true);
    expect(built.twilioApi.createMessage).toHaveBeenCalledWith({ to: "+15551234567", from: "+15550001111", body: "build finished" });
  });

  it("inbound SMS from an allowlisted number lands in the user's inbox", async () => {
    const built = await makeTestApp();
    builts.push(built);
    built.services.twilio.allowlistAdd("+15551234567");
    const sms = await formPost(built, "/twilio/sms", { MessageSid: "SM_in_1", From: "+15551234567", Body: "on my way" });
    expect(sms.statusCode).toBe(200);
    const message = built.services.db.sqlite
      .prepare("SELECT * FROM agent_messages WHERE to_extension = '100' AND from_extension = '700'")
      .get() as Record<string, unknown>;
    expect(message.body).toBe("on my way");
    expect(String(message.title)).toContain("+15551234567");
    expect(JSON.parse(String(message.metadata)).channel).toBe("sms");
  });

  it("inbound SMS from unknown numbers is dropped", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const sms = await formPost(built, "/twilio/sms", { MessageSid: "SM_bad_1", From: "+15550009999", Body: "spam" });
    expect(sms.statusCode).toBe(200);
    const count = built.services.db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("twilio management tools", () => {
  it("allowlist add/list/remove round-trips through MCP", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const add = toolResult(await mcpCall(built, "twilio_allowlist_add", { phone_number: "555 123 4567", label: "Kizek" }));
    expect(add.allowlisted.phone_number).toBe("+15551234567");
    const list = toolResult(await mcpCall(built, "twilio_allowlist_list", {}));
    expect(list.numbers).toHaveLength(1);
    const removed = toolResult(await mcpCall(built, "twilio_allowlist_remove", { phone_number: "+15551234567" }));
    expect(removed.removed).toBe(true);
  });

  it("twilio_set_user_number sets the default destination and allowlists it", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const set = toolResult(await mcpCall(built, "twilio_set_user_number", { phone_number: "5551234567" }));
    expect(set.default_user_number).toBe("+15551234567");
    const list = toolResult(await mcpCall(built, "twilio_allowlist_list", {}));
    expect(list.default_user_number).toBe("+15551234567");
    expect(list.numbers).toHaveLength(1);
  });

  it("twilio_register_inbound_agent only accepts agent extensions", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const bad = await mcpCall(built, "twilio_register_inbound_agent", { extension: "100" });
    expect(bad.statusCode).toBe(400);
    const good = toolResult(await mcpCall(built, "twilio_register_inbound_agent", { extension: "103" }));
    expect(good.inbound_extension).toBe("103");
    const status = toolResult(await mcpCall(built, "twilio_status", {}));
    expect(status.inbound_extension).toBe("103");
    expect(status.configured).toBe(true);
  });
});

describe("twilio call screening", () => {
  type DeviceEvents = { events: Array<Record<string, any>>; socket: WebSocket };

  async function connectDevice(host: string): Promise<DeviceEvents> {
    const socket = track(new WebSocket(`ws://${host}/ws?token=device-token-test&extension=100&clientType=device`));
    const events: Array<Record<string, any>> = [];
    socket.on("message", (data) => {
      try {
        events.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });
    await new Promise((resolve) => socket.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { events, socket };
  }

  function connectAutoAcceptAgent(host: string): WebSocket {
    const agent = track(new WebSocket(`ws://${host}/ws?token=agent-token-test&extension=101&clientType=agent`));
    agent.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "incoming_call") {
        agent.send(JSON.stringify({ type: "call_accept", callId: event.call.id, extension: "101" }));
      }
    });
    return agent;
  }

  async function startScreeningSession(opts: { callSid: string; from: string; forwardedFrom?: string }) {
    const { built, host } = await listeningApp();
    await mcpCall(built, "twilio_screening_enable", {});
    built.services.twilio.setDefaultUserNumber("+13193898338");
    const device = await connectDevice(host);
    const agent = connectAutoAcceptAgent(host);
    await new Promise((resolve) => agent.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const voice = await formPost(built, "/twilio/voice", {
      CallSid: opts.callSid,
      From: opts.from,
      ...(opts.forwardedFrom ? { ForwardedFrom: opts.forwardedFrom } : {})
    });
    expect(voice.body).toContain("<Connect>");

    const media = track(new WebSocket(`ws://${host}/twilio/media`));
    media.on("open", () => {
      media.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: `MZ_${opts.callSid}`, callSid: opts.callSid, customParameters: { direction: "inbound" } }
        })
      );
    });
    const started = await until(
      () => device.events.find((e) => e.type === "screening_started"),
      "screening_started event"
    );
    return { built, host, device, media, started, agent };
  }

  it("unknown callers are still rejected while screening is disabled (default)", async () => {
    const built = await makeTestApp();
    builts.push(built);
    expect(built.services.twilio.getScreeningEnabled()).toBe(false);
    const voice = await formPost(built, "/twilio/voice", { CallSid: "CA_off_1", From: "+15550009999" });
    expect(voice.body).toContain("<Reject/>");
  });

  it("screens an unknown caller and mirrors both sides of the conversation to the device", async () => {
    const { built, device, media, started, agent } = await startScreeningSession({
      callSid: "CA_scr_1",
      from: "+15550009999",
      forwardedFrom: "+13193898338"
    });
    expect(started.callerNumber).toBe("+15550009999");
    expect(started.forwardedFrom).toBe("+13193898338");
    expect(started.callId).toBeTruthy();

    // The screening reason carries the agent's instructions and shows in History.
    const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(started.callId) as Record<string, unknown>;
    expect(String(call.reason).toLowerCase()).toContain("screening");

    // Caller speaks → mock STT → screening_update speaker=caller.
    for (let i = 0; i < 12; i++) media.send(JSON.stringify({ event: "media", media: { payload: loudFrame() } }));
    for (let i = 0; i < 45; i++) media.send(JSON.stringify({ event: "media", media: { payload: silentFrame() } }));
    const callerLine = await until(
      () => device.events.find((e) => e.type === "screening_update" && e.speaker === "caller"),
      "caller screening_update"
    );
    expect(callerLine.text).toContain("mock transcript");

    // Agent replies the way universalAgent does — call_message over WS → mirrored.
    agent.send(
      JSON.stringify({
        type: "call_message",
        callId: started.callId,
        fromExtension: "101",
        toExtension: "700",
        content: "Who is calling, please?",
        synthesize: true
      })
    );
    const agentLine = await until(
      () => device.events.find((e) => e.type === "screening_update" && e.speaker === "agent"),
      "agent screening_update"
    );
    expect(agentLine.text).toBe("Who is calling, please?");

    // Sequence numbers are monotonic so the app can dedup its two sockets.
    const seqs = device.events.filter((e) => typeof e.seq === "number").map((e) => e.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("take over redirects the caller to the user's real phone without hanging up on them", async () => {
    const { built, device, media, started } = await startScreeningSession({ callSid: "CA_scr_2", from: "+15550008888" });
    device.socket.send(JSON.stringify({ type: "screening_take_over", callId: started.callId }));
    await until(
      () =>
        (built.twilioApi.updateCall as any).mock.calls.find(
          (call: any[]) => call[0] === "CA_scr_2" && typeof call[1]?.twiml === "string"
        ),
      "updateCall with twiml"
    );
    const redirect = (built.twilioApi.updateCall as any).mock.calls.find((c: any[]) => typeof c[1]?.twiml === "string");
    expect(redirect[1].twiml).toContain("<Dial");
    expect(redirect[1].twiml).toContain("+13193898338");
    expect(redirect[1].twiml).toContain("/twilio/takeover-status");

    // Twilio replaces the TwiML → the media stream stops. The caller must NOT be hung up.
    media.send(JSON.stringify({ event: "stop" }));
    await until(
      () => {
        const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(started.callId) as Record<string, unknown>;
        return call.state === "ended" ? call : undefined;
      },
      "internal call ended"
    );
    const hangups = (built.twilioApi.updateCall as any).mock.calls.filter((c: any[]) => c[1]?.status === "completed");
    expect(hangups).toHaveLength(0);
    const ended = await until(() => device.events.find((e) => e.type === "screening_ended"), "screening_ended");
    expect(ended.outcome).toBe("taken_over");
  });

  it("the end button hangs up the caller's leg", async () => {
    const { built, device, started } = await startScreeningSession({ callSid: "CA_scr_3", from: "+15550007777" });
    device.socket.send(JSON.stringify({ type: "screening_end", callId: started.callId }));
    await until(
      () => (built.twilioApi.updateCall as any).mock.calls.find((c: any[]) => c[0] === "CA_scr_3" && c[1]?.status === "completed"),
      "twilio hangup"
    );
    const ended = await until(() => device.events.find((e) => e.type === "screening_ended"), "screening_ended");
    expect(ended.outcome).toBe("ended");
  });

  it("a forwarded ring-back right after a take-over is not re-screened (loop guard)", async () => {
    const { built, started } = await startScreeningSession({ callSid: "CA_scr_4", from: "+15550006666" });
    await mcpCall(built, "twilio_screening_take_over", { call_id: started.callId });
    const voice = await formPost(built, "/twilio/voice", {
      CallSid: "CA_loop_1",
      From: "+15550006666",
      ForwardedFrom: "+13193898338"
    });
    expect(voice.body).not.toContain("<Connect>");
    expect(voice.body).toContain("<Hangup/>");
  });

  it("takeover-status webhook hangs up politely when the user does not answer", async () => {
    const built = await makeTestApp();
    builts.push(built);
    const status = await formPost(built, "/twilio/takeover-status", { CallSid: "CA_x", DialCallStatus: "no-answer" });
    expect(status.statusCode).toBe(200);
    expect(status.body).toContain("<Hangup/>");
  });

  it("kill switch turns screening back off", async () => {
    const built = await makeTestApp();
    builts.push(built);
    await mcpCall(built, "twilio_screening_enable", {});
    expect(built.services.twilio.getScreeningEnabled()).toBe(true);
    await mcpCall(built, "twilio_screening_disable", {});
    const voice = await formPost(built, "/twilio/voice", { CallSid: "CA_off_2", From: "+15550005555" });
    expect(voice.body).toContain("<Reject/>");
  });
});

describe("call_user_and_wait escalation to a real phone call", () => {
  it("escalates after the in-app call misses and the text fallback times out", async () => {
    const { built } = await listeningApp();
    built.services.twilio.allowlistAdd("+15551234567");

    // User device (ext 100) is OFFLINE and never answers the text fallback.
    const response = await mcpCall(built, "call_user_and_wait", {
      from_extension: "101",
      reason: "escalation test",
      say: "please answer",
      timeout_seconds: 2,
      fallback_timeout_seconds: 1,
      expected_response_type: "freeform",
      escalate_to_twilio: true,
      escalate_phone_number: "+15551234567"
    });
    const result = toolResult(response);
    expect(result.escalated).toBe(true);
    expect(result.fallback_sent).toBe(true);
    // The escalation actually asked Twilio for a real call.
    expect(built.twilioApi.createCall).toHaveBeenCalledTimes(1);
    const events = built.services.db.sqlite
      .prepare("SELECT * FROM events WHERE type = 'call.escalated_to_pstn'")
      .all();
    expect(events.length).toBe(1);
  }, 20_000);
});
