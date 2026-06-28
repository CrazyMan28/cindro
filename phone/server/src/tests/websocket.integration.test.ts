import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { makeTestApp } from "./testApp.js";

describe("WebSocket integration", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(closeSocket));
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("routes calls, text, audio transcripts, and TTS chunks between fake Android and fake agent", async () => {
    const built = await makeTestApp();
    apps.push(built);
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = built.app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `ws://127.0.0.1:${address.port}/ws`;

    const android = new WebSocket(`${base}?token=device-token-test&extension=100&clientType=device`);
    const agent = new WebSocket(`${base}?token=agent-token-test&extension=101&clientType=agent`);
    sockets.push(android, agent);
    await Promise.all([waitForType(android, "hello"), waitForType(agent, "hello")]);

    android.send(JSON.stringify({ type: "dial", fromExtension: "100", toExtension: "101", reason: "integration" }));
    const incoming = await waitForType(agent, "incoming_call");
    const call = incoming.call as { id: string };
    agent.send(JSON.stringify({ type: "call_accept", callId: call.id, extension: "101" }));
    await waitForType(android, "call_accept");

    android.send(JSON.stringify({ type: "call_message", callId: call.id, fromExtension: "100", toExtension: "101", content: "hello text" }));
    const text = await waitForType(agent, "call_message");
    expect(text.content).toBe("hello text");

    android.send(JSON.stringify({ type: "audio_start", callId: call.id, fromExtension: "100", toExtension: "101", audioFormat: "pcm_s16le", sampleRate: 16000, channels: 1 }));
    android.send(JSON.stringify({ type: "audio_chunk", callId: call.id, fromExtension: "100", audioBase64: Buffer.from("hello audio").toString("base64") }));
    android.send(JSON.stringify({ type: "audio_end", callId: call.id, fromExtension: "100" }));
    const transcript = await waitForType(agent, "transcript_final");
    expect(transcript.text).toBe("hello audio");

    const androidMessage = waitForType(android, "call_message");
    const ttsStart = waitForType(android, "tts_start");
    const ttsChunk = waitForType(android, "tts_chunk");
    agent.send(JSON.stringify({ type: "call_message", callId: call.id, fromExtension: "101", toExtension: "100", content: "agent reply" }));
    await androidMessage;
    const start = await ttsStart;
    expect(start).toEqual(expect.objectContaining({ audioFormat: expect.any(String), mimeType: expect.any(String) }));
    const chunk = await ttsChunk;
    expect(String(chunk.audioBase64).length).toBeGreaterThan(20);
    android.close();
    agent.close();
  });

  it("authenticates a device over an explicit auth message on /ws", async () => {
    const built = await makeTestApp();
    apps.push(built);
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = built.app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const android = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(android);
    const authPrompt = await waitForType(android, "hello");
    expect(authPrompt.requiresAuth).toBe(true);

    android.send(JSON.stringify({ type: "auth", token: "device-token-test", extension: "100", clientType: "device" }));
    const hello = await waitForType(android, "hello");
    expect(hello).toEqual(expect.objectContaining({ extension: "100", role: "device" }));

    android.send(JSON.stringify({ type: "presence_update", extension: "100", online: true }));
    const presence = await waitForType(android, "presence_update");
    expect(presence).toEqual(expect.objectContaining({ extension: "100", online: true }));
  });
});

function waitForType(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: Buffer) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === type) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(event);
      }
    };
    ws.on("message", onMessage);
  });
}

function closeSocket(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timeout = setTimeout(resolve, 500);
    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.close();
  });
}
