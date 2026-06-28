import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";

describe("HTTP API", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("requires bearer auth for API routes", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const response = await built.app.inject({ method: "GET", url: "/api/extensions" });
    expect(response.statusCode).toBe(401);
  });

  it("lists and creates extensions with admin auth", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const create = await built.app.inject({
      method: "POST",
      url: "/api/extensions",
      headers: authHeaders.admin,
      payload: {
        extension: "777",
        ownerType: "agent",
        ownerId: "test-agent",
        name: "Test Agent",
        permissions: {},
        allowedCallers: ["100"],
        metadata: {}
      }
    });
    expect(create.statusCode).toBe(201);
    const list = await built.app.inject({ method: "GET", url: "/api/extensions", headers: authHeaders.device });
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ extension: "777", name: "Test Agent" })]));
  });

  it("handles dial, accept, message persistence, transcript persistence, TTS metadata, and end", async () => {
    const built = await makeTestApp();
    apps.push(built);
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension IN ('100','101')").run();

    const dial = await built.app.inject({
      method: "POST",
      url: "/api/dial",
      headers: authHeaders.device,
      payload: { fromExtension: "100", toExtension: "101", reason: "test" }
    });
    expect(dial.statusCode).toBe(201);
    const call = dial.json();
    expect(call.state).toBe("ringing");

    const accept = await built.app.inject({
      method: "POST",
      url: `/api/calls/${call.id}/accept`,
      headers: authHeaders.agent,
      payload: { extension: "101" }
    });
    expect(accept.json().state).toBe("active");

    const audio = await built.app.inject({
      method: "POST",
      url: "/api/audio/stt",
      headers: authHeaders.device,
      payload: {
        callId: call.id,
        fromExtension: "100",
        audioBase64: Buffer.from("approve the task").toString("base64"),
        audioFormat: "pcm_s16le",
        sampleRate: 16000,
        channels: 1
      }
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.json().stt.text).toBe("approve the task");

    const tts = await built.app.inject({
      method: "POST",
      url: "/api/audio/tts",
      headers: authHeaders.agent,
      payload: { text: "Agent response", responseFormat: "wav" }
    });
    expect(tts.statusCode).toBe(200);
    expect(tts.json().audioBase64.length).toBeGreaterThan(20);

    const end = await built.app.inject({
      method: "POST",
      url: `/api/calls/${call.id}/end`,
      headers: authHeaders.device,
      payload: { extension: "100" }
    });
    expect(end.json().state).toBe("ended");

    const loaded = await built.app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: authHeaders.admin });
    expect(loaded.json().transcripts).toHaveLength(1);
  });

  it("rejects unknown extensions and records missed calls for offline targets", async () => {
    const built = await makeTestApp();
    apps.push(built);
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension = '100'").run();

    const unknown = await built.app.inject({
      method: "POST",
      url: "/api/dial",
      headers: authHeaders.device,
      payload: { fromExtension: "100", toExtension: "999" }
    });
    expect(unknown.statusCode).toBe(404);

    const missed = await built.app.inject({
      method: "POST",
      url: "/api/dial",
      headers: authHeaders.device,
      payload: { fromExtension: "100", toExtension: "101" }
    });
    expect(missed.statusCode).toBe(202);
    expect(missed.json().state).toBe("missed");
    const missedList = await built.app.inject({ method: "GET", url: "/api/missed-calls?extension=101", headers: authHeaders.admin });
    expect(missedList.json()).toHaveLength(1);
  });

  it("queues calls for a busy extension", async () => {
    const built = await makeTestApp();
    apps.push(built);
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1, busy = 1 WHERE extension = '101'").run();
    built.services.db.sqlite.prepare("UPDATE extensions SET online = 1 WHERE extension = '100'").run();

    const response = await built.app.inject({
      method: "POST",
      url: "/api/dial",
      headers: authHeaders.device,
      payload: { fromExtension: "100", toExtension: "101" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(expect.objectContaining({ state: "created", failure_reason: "target_busy_queued" }));
  });
});
