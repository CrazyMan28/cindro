import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";
import { AppDatabase } from "../db/database.js";
import { CallService } from "../calls/callService.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { parseKickCommand, selectTurnTargets, selectGroupTextTargets, MAX_AGENT_CHAIN } from "../calls/conferenceRouting.js";
import { CONFERENCE_GROUP_EXTENSION } from "../messaging/warRoom.js";
import { AudioGateway } from "../audio/audioGateway.js";

const AGENTS = [
  { extension: "101", name: "Codex" },
  { extension: "103", name: "Copilot" },
  { extension: "104", name: "Echo (built-in test)" }
];

describe("conferenceRouting.parseKickCommand", () => {
  it("matches kick/drop/remove by agent name, case-insensitively", () => {
    expect(parseKickCommand("Kick Codex", AGENTS)?.target.extension).toBe("101");
    expect(parseKickCommand("drop copilot.", AGENTS)?.target.extension).toBe("103");
    expect(parseKickCommand("please remove echo", AGENTS)?.target.extension).toBe("104");
  });

  it("matches by extension digits too", () => {
    expect(parseKickCommand("kick 101", AGENTS)?.target.extension).toBe("101");
  });

  it("ignores non-kick turns and unknown targets", () => {
    expect(parseKickCommand("can you kick off the build?", AGENTS)).toBeNull();
    expect(parseKickCommand("kick claude", AGENTS)).toBeNull(); // not in this call
    expect(parseKickCommand("I want to remove this file", AGENTS)).toBeNull();
  });

  it("tolerates STT mishears of the kick verb", () => {
    // Mistral STT sometimes hears the plosive "kick" as "kik"/"click".
    expect(parseKickCommand("Kik Codex.", AGENTS)?.target.extension).toBe("101");
    expect(parseKickCommand("Click Copilot", AGENTS)?.target.extension).toBe("103");
    // "pick" must NOT kick — "pick Copilot for X" is a plausible assignment.
    expect(parseKickCommand("Pick Copilot for the research", AGENTS)).toBeNull();
  });

  it("accepts the verb-less '<name>, leave' form (survives clipped onsets)", () => {
    expect(parseKickCommand("Codex, leave.", AGENTS)?.target.extension).toBe("101");
    expect(parseKickCommand("Copilot leave the call", AGENTS)?.target.extension).toBe("103");
    expect(parseKickCommand("Echo, get out", AGENTS)?.target.extension).toBe("104");
    // A bare name is ADDRESSING, never a kick.
    expect(parseKickCommand("Codex.", AGENTS)).toBeNull();
  });

  it("'leave' form is strict — negations and relayed sentences never kick", () => {
    expect(parseKickCommand("Codex, don't leave", AGENTS)).toBeNull();
    expect(parseKickCommand("Claude, do not leave", AGENTS)).toBeNull();
    expect(parseKickCommand("Codex, tell Copilot to leave", AGENTS)).toBeNull();
    expect(parseKickCommand("we can't let Codex leave", AGENTS)).toBeNull();
    // "you can go" means "go ahead", not "hang up" — must never kick.
    expect(parseKickCommand("Codex, you can go", AGENTS)).toBeNull();
  });
});

describe("conferenceRouting.selectTurnTargets (lead-listens-first)", () => {
  const input = { lead: "101", agents: AGENTS };

  it("routes unaddressed turns to the lead only", () => {
    expect(selectTurnTargets("what's the status of the build?", input)).toEqual(["101"]);
  });

  it("routes named turns to the named agents only", () => {
    expect(selectTurnTargets("Copilot, what do you think?", input)).toEqual(["103"]);
    expect(selectTurnTargets("codex and copilot, compare notes", input).sort()).toEqual(["101", "103"]);
  });

  it("routes 'everyone' to all agents", () => {
    expect(selectTurnTargets("everyone, sound off", input).sort()).toEqual(["101", "103", "104"]);
    expect(selectTurnTargets("all of you give a one liner", input).sort()).toEqual(["101", "103", "104"]);
  });

  it("falls back to the first agent when the lead has left", () => {
    expect(selectTurnTargets("hello", { lead: "999", agents: AGENTS })).toEqual(["101"]);
  });
});

describe("selectGroupTextTargets (group-chat mention routing)", () => {
  const base = { fromExtension: "100", fromIsAgent: false, agents: AGENTS, consecutiveAgentMessages: 0 };

  it("user naming an agent routes only to it (and @ext works)", () => {
    expect(selectGroupTextTargets({ ...base, body: "@101 run the tests" })).toEqual(["101"]);
    expect(selectGroupTextTargets({ ...base, body: "@codex run the tests" })).toEqual(["101"]);
    expect(selectGroupTextTargets({ ...base, body: "what do you think, copilot?" })).toEqual(["103"]);
  });

  it("leading vocative wins: 'copilot say to codex X' goes to Copilot ALONE", () => {
    // The exact live failure: both named agents replied at once. The agent
    // addressed at the START is the actor; mid-sentence names are subjects.
    expect(selectGroupTextTargets({ ...base, body: "copilot say to Codex how your day have been" })).toEqual(["103"]);
    expect(selectGroupTextTargets({ ...base, body: "hey codex and copilot, compare notes" }).sort()).toEqual(["101", "103"]);
    // No leading vocative → all named agents get it.
    expect(selectGroupTextTargets({ ...base, body: "tell codex and copilot to check in" }).sort()).toEqual(["101", "103"]);
  });

  it("unaddressed user message goes to the lead only; 'everyone' fans out", () => {
    expect(selectGroupTextTargets({ ...base, body: "hello what's up" })).toEqual(["101"]);
    expect(selectGroupTextTargets({ ...base, body: "everyone check in please" }).sort()).toEqual(["101", "103", "104"]);
  });

  it("agent messages reach ONLY agents they name — never the lead fallback", () => {
    // Codex asks Copilot something → only Copilot gets it.
    expect(selectGroupTextTargets({ ...base, fromExtension: "101", fromIsAgent: true, body: "Copilot, how's your day been?" })).toEqual(["103"]);
    // Codex says something naming nobody → nobody takes a turn (no loop seed).
    expect(selectGroupTextTargets({ ...base, fromExtension: "101", fromIsAgent: true, body: "All done with the fix." })).toEqual([]);
    // An agent can't address itself.
    expect(selectGroupTextTargets({ ...base, fromExtension: "101", fromIsAgent: true, body: "codex is done" })).toEqual([]);
  });

  it("agent relay chains die at MAX_AGENT_CHAIN until the user speaks", () => {
    const relay = { ...base, fromExtension: "101", fromIsAgent: true, body: "Copilot, your turn" };
    expect(selectGroupTextTargets({ ...relay, consecutiveAgentMessages: MAX_AGENT_CHAIN - 1 })).toEqual(["103"]);
    expect(selectGroupTextTargets({ ...relay, consecutiveAgentMessages: MAX_AGENT_CHAIN })).toEqual([]);
    // A fresh USER message resets the chain regardless of history depth.
    expect(selectGroupTextTargets({ ...base, body: "copilot you there?", consecutiveAgentMessages: 99 })).toEqual(["103"]);
  });

  it("relayDisabled kill switch: an agent can NEVER trigger another agent", () => {
    expect(selectGroupTextTargets({
      ...base, fromExtension: "101", fromIsAgent: true, body: "Copilot, your turn", relayDisabled: true
    })).toEqual([]);
    // The USER is unaffected — they still reach agents.
    expect(selectGroupTextTargets({ ...base, body: "copilot you there?", relayDisabled: true })).toEqual(["103"]);
  });
});

describe("callService.removeParticipant (kick keeps the call alive)", () => {
  it("flips only the kicked row; call and others stay joined", () => {
    const db = new AppDatabase("file::memory:");
    new ExtensionService(db).seedDefaults();
    const calls = new CallService(db);
    const call = calls.createWarRoomCall("100", CONFERENCE_GROUP_EXTENSION, ["101", "103"], "test conference");

    calls.removeParticipant(call.id, "101");

    expect(calls.get(call.id)?.state).toBe("active");
    expect(calls.agentParticipantExtensions(call.id)).toEqual(["103"]);
    expect(calls.joinedParticipantExtensions(call.id).sort()).toEqual(["100", "103"]);
    // The kicked agent is still in the historical participant list.
    expect(calls.participantExtensions(call.id).sort()).toEqual(["100", "101", "103"]);
    db.close();
  });
});

describe("POST /api/conference", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("rejects non-agent members with a clean 400", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const res = await built.app.inject({
      method: "POST",
      url: "/api/conference",
      headers: authHeaders.device,
      payload: { members: ["100", "999"] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not agent extension|at least one agent/);
  });

  it("DB-online-but-socketless agents are NOT rostered (phantom-join guard)", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const extensions = new ExtensionService(built.services.db);
    // DB flag says online, but there is no live WebSocket — the old code would
    // roster these and report them "joining" while war_room_join went nowhere.
    extensions.setPresence("101", true);
    extensions.setPresence("103", true);

    const res = await built.app.inject({
      method: "POST",
      url: "/api/conference",
      headers: authHeaders.device,
      payload: { members: ["101", "103"] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/none of the selected agents/);
  });

  it("starts a conference with only the chosen (live) agents", async () => {
    const db = new AppDatabase("file::memory:");
    new ExtensionService(db).seedDefaults();
    const sent: Array<{ ext: string; type: string }> = [];
    const liveHub = {
      ensureAgentOnline: async () => {},
      notifyNewMessage: () => true,
      sendToExtension: (ext: string, event: Record<string, unknown>) => {
        sent.push({ ext, type: String(event.type) });
      },
      isExtensionOnline: () => true,
      hasLiveConnection: (ext: string) => ["101", "103"].includes(ext)
    };
    const { WarRoomService } = await import("../messaging/warRoom.js");
    const { MessageService } = await import("../messaging/messageService.js");
    const wr = new WarRoomService(db, new MessageService(db), liveHub);

    const result = await wr.startConference({ members: ["101", "103", "104"] });
    // 104 has no live socket → skipped; the live two are rostered.
    expect(result.members.map((m) => m.extension).sort()).toEqual(["101", "103"]);
    expect(result.skipped).toEqual(["104"]);

    const calls = new CallService(db);
    const call = calls.get(result.callId)!;
    expect(call.state).toBe("active");
    expect(call.to_extension).toBe(CONFERENCE_GROUP_EXTENSION);
    expect(calls.agentParticipantExtensions(result.callId).sort()).toEqual(["101", "103"]);
    // Each LIVE member got war_room_join; the user got the call handshake.
    expect(sent.filter((s) => s.type === "war_room_join").map((s) => s.ext).sort()).toEqual(["101", "103"]);
    expect(sent.some((s) => s.ext === "100" && s.type === "call_accept")).toBe(true);
    db.close();
  });
});

describe("multi-party calls survive a single STT failure", () => {
  it("keeps the war-room call active and scopes the error to the speaker", async () => {
    const db = new AppDatabase("file::memory:");
    new ExtensionService(db).seedDefaults();
    const calls = new CallService(db);
    const call = calls.createWarRoomCall("100", CONFERENCE_GROUP_EXTENSION, ["101", "103"], "conf");

    const sentTo: string[] = [];
    const sink = {
      sendToExtension: (ext: string) => { sentTo.push(ext); },
      sendToCall: (_id: string, event: Record<string, unknown>) => { sentTo.push(`call:${event.type}`); }
    };
    const throwingMistral = {
      speechToTextOffline: async () => { throw new Error("mistral 503"); }
    } as unknown as ConstructorParameters<typeof AudioGateway>[1];
    const { loadConfig } = await import("../config.js");
    const config = loadConfig({
      DATABASE_URL: "file::memory:", ADMIN_TOKEN: "admin-token-test", DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test", LOG_LEVEL: "silent", MISTRAL_REAL_AUDIO: "false", MISTRAL_API_KEY: ""
    });
    const gateway = new AudioGateway(db, throwingMistral, config, sink);

    gateway.startAudio(call.id, "100");
    gateway.appendAudio(call.id, "100", Buffer.from("hello team"));
    const result = await gateway.endAudio(call.id, "100");

    expect(result.ok).toBe(false);
    // The call is STILL ACTIVE — one bad turn must not end a war room.
    expect(calls.get(call.id)?.state).toBe("active");
    // The error went only to the speaker; nobody got call_failed.
    expect(sentTo).toContain("100");
    expect(sentTo).not.toContain("call:call_failed");
    db.close();
  });
});

describe("on-device (local:) voices never synthesize on the server", () => {
  it("sends tts_local with the TEXT instead of calling Mistral", async () => {
    const db = new AppDatabase("file::memory:");
    new ExtensionService(db).seedDefaults();
    const { VoiceProfileService } = await import("../audio/voiceProfiles.js");
    new VoiceProfileService(db).set("101", { voiceId: "local:jarvis" });

    const events: Array<Record<string, unknown>> = [];
    const sink = {
      sendToExtension: (_ext: string, event: Record<string, unknown>) => { events.push(event); },
      sendToCall: () => {}
    };
    // The laptop must NOT run inference for a local voice — explode if tried.
    const forbiddenMistral = {
      textToSpeechStream: () => { throw new Error("SERVER MUST NOT SYNTHESIZE local voices"); }
    } as unknown as ConstructorParameters<typeof AudioGateway>[1];
    const { loadConfig } = await import("../config.js");
    const config = loadConfig({
      DATABASE_URL: "file::memory:", ADMIN_TOKEN: "admin-token-test", DEVICE_TOKEN: "device-token-test",
      AGENT_TOKEN: "agent-token-test", LOG_LEVEL: "silent", MISTRAL_REAL_AUDIO: "false", MISTRAL_API_KEY: ""
    });
    const gateway = new AudioGateway(db, forbiddenMistral, config, sink);

    const calls = new CallService(db);
    const call = calls.dial({ fromExtension: "101", toExtension: "100", urgency: "normal", reason: "test" });
    const result = await gateway.synthesizeForCall(call.id, "101", "100", "Greetings. Jarvis online.");

    expect(result.format).toBe("local");
    const local = events.find((e) => e.type === "tts_local");
    expect(local).toBeDefined();
    expect(local?.text).toBe("Greetings. Jarvis online.");
    expect(local?.voiceId).toBe("local:jarvis");
    // No streaming events — the phone does the work.
    expect(events.some((e) => e.type === "tts_start" || e.type === "tts_chunk")).toBe(false);
    db.close();
  });
});

describe("GET /api/voices", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  it("returns the fallback catalog (mock audio mode) including Default", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const res = await built.app.inject({ method: "GET", url: "/api/voices", headers: authHeaders.device });
    expect(res.statusCode).toBe(200);
    const { voices } = res.json();
    expect(Array.isArray(voices)).toBe(true);
    expect(voices.some((v: { id: string | null; name: string }) => v.id === null && v.name === "Default")).toBe(true);
  });
});
