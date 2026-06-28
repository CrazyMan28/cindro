import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { makeTestApp, authHeaders } from "./testApp.js";

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

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 20ms of loud 16kHz PCM16 mono (alternating square) as base64. 160 samples = 320 bytes. */
function loudFrame(): string {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i % 2 === 0 ? 9000 : -9000, i * 2);
  return pcm.toString("base64");
}

function silentFrame(): string {
  return Buffer.alloc(320).toString("base64");
}

describe("relay call screening", () => {
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
    // The test app's TWILIO_INBOUND_EXTENSION is 101 (testApp.ts), so the relay
    // bridge dials ext 101 — answer there, exactly like twilio.test.ts.
    const agent = track(new WebSocket(`ws://${host}/ws?token=agent-token-test&extension=101&clientType=agent`));
    agent.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "incoming_call") {
        agent.send(JSON.stringify({ type: "call_accept", callId: event.call.id, extension: "101" }));
      }
    });
    return agent;
  }

  /** A relay media socket that records outbound media/mark frames from the bridge. */
  function connectRelay(host: string) {
    const socket = track(new WebSocket(`ws://${host}/relay/media`));
    const mediaFrames: string[] = [];
    const marks: string[] = [];
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.kind === "media") mediaFrames.push(event.pcmBase64);
      if (event.kind === "mark") {
        marks.push(event.name);
        // Echo the mark back once playback finishes (relay client contract).
        socket.send(JSON.stringify({ kind: "mark", name: event.name }));
      }
    });
    return { socket, mediaFrames, marks };
  }

  async function startScreeningSession(opts: { callerNumber: string; forwardedFrom?: string }) {
    const { built, host } = await listeningApp();
    await mcpCall(built, "twilio_screening_enable", {});
    built.services.twilio.setDefaultUserNumber("+13193898338");
    const device = await connectDevice(host);
    const agent = connectAutoAcceptAgent(host);
    await new Promise((resolve) => agent.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const relay = connectRelay(host);
    await new Promise((resolve) => relay.socket.on("open", resolve));
    relay.socket.send(
      JSON.stringify({
        kind: "start_call",
        callerNumber: opts.callerNumber,
        screening: true,
        ...(opts.forwardedFrom ? { forwardedFrom: opts.forwardedFrom } : {})
      })
    );

    const started = await until(
      () => device.events.find((e) => e.type === "screening_started"),
      "screening_started event"
    );
    return { built, host, device, relay, started, agent };
  }

  it("screens an unknown relay caller and mirrors both sides of the conversation to the device", async () => {
    const { built, device, relay, started, agent } = await startScreeningSession({
      callerNumber: "+15550009999",
      forwardedFrom: "+13193898338"
    });
    expect(started.callerNumber).toBe("+15550009999");
    expect(started.forwardedFrom).toBe("+13193898338");
    expect(started.callId).toBeTruthy();

    // The relay call is in the same calls table the History screen renders, with
    // a screening reason, dialed from ext 702.
    const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(started.callId) as Record<string, unknown>;
    expect(call.from_extension).toBe("702");
    expect(String(call.reason).toLowerCase()).toContain("screening");

    // Caller speaks → mock STT → screening_update speaker=caller.
    for (let i = 0; i < 12; i++) relay.socket.send(JSON.stringify({ kind: "media", pcmBase64: loudFrame() }));
    for (let i = 0; i < 45; i++) relay.socket.send(JSON.stringify({ kind: "media", pcmBase64: silentFrame() }));
    const callerLine = await until(
      () => device.events.find((e) => e.type === "screening_update" && e.speaker === "caller"),
      "caller screening_update"
    );
    expect(callerLine.text).toContain("mock transcript");

    // Agent replies the way universalAgent does — call_message over WS to ext 702
    // → mirrored to the device AND synthesized out the relay socket as PCM media.
    agent.send(
      JSON.stringify({
        type: "call_message",
        callId: started.callId,
        fromExtension: "101",
        toExtension: "702",
        content: "Who is calling, please?",
        synthesize: true
      })
    );
    const agentLine = await until(
      () => device.events.find((e) => e.type === "screening_update" && e.speaker === "agent"),
      "agent screening_update"
    );
    expect(agentLine.text).toBe("Who is calling, please?");

    // The agent's TTS reached the relay as PCM media frames + a mark.
    await until(() => (relay.mediaFrames.length > 0 ? true : undefined), "outbound relay media frames");
    await until(() => (relay.marks.length > 0 ? true : undefined), "relay mark");
    expect(relay.mediaFrames.length).toBeGreaterThan(0);
    expect(relay.marks.length).toBeGreaterThan(0);

    // Sequence numbers are monotonic so the app can dedup its two sockets.
    const seqs = device.events.filter((e) => typeof e.seq === "number").map((e) => e.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  }, 20_000);

  it("the relay end control message ends the screening session", async () => {
    const { built, device, relay, started } = await startScreeningSession({ callerNumber: "+15550007777" });
    relay.socket.send(JSON.stringify({ kind: "end" }));
    const ended = await until(() => device.events.find((e) => e.type === "screening_ended"), "screening_ended");
    expect(ended.outcome).toBe("ended");
    await until(
      () => {
        const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(started.callId) as Record<string, unknown>;
        return call.state === "ended" ? call : undefined;
      },
      "internal relay call ended"
    );
  });

  it("a takeover control message leaves the internal call alive when the relay socket closes", async () => {
    const { built, relay, started } = await startScreeningSession({ callerNumber: "+15550006666" });
    relay.socket.send(JSON.stringify({ kind: "takeover" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The relay device disconnects (the user took the call on their phone). The
    // internal call must NOT be torn down by the socket close.
    relay.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const call = built.services.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(started.callId) as Record<string, unknown>;
    expect(["active", "ringing", "speaking", "listening", "transcribing", "agent_thinking", "waiting_for_user"]).toContain(String(call.state));
  });
});
