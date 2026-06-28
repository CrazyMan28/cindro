import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, authHeaders } from "./testApp.js";
import { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { MessageService } from "../messaging/messageService.js";
import { VoiceProfileService } from "../audio/voiceProfiles.js";
import { WarRoomService } from "../messaging/warRoom.js";

function seededDb() {
  const db = new AppDatabase("file::memory:");
  new ExtensionService(db).seedDefaults();
  return db;
}

const noopHub = {
  ensureAgentOnline: async () => {},
  notifyNewMessage: () => true,
  sendToExtension: () => {},
  isExtensionOnline: () => false,
  hasLiveConnection: () => false
};

describe("voice profiles (per-extension voice + rate)", () => {
  it("sets and reads a profile, clamps speed, and resets", () => {
    const db = seededDb();
    const svc = new VoiceProfileService(db);
    expect(svc.get("101")).toEqual({});

    const set = svc.set("101", { voiceId: "11111111-2222-3333-8444-555555555555", speed: 5, name: "Jarvis" });
    expect(set?.voiceId).toBe("11111111-2222-3333-8444-555555555555");
    expect(set?.speed).toBe(2); // clamped to max
    expect(set?.name).toBe("Jarvis");

    const got = svc.get("101");
    expect(got.name).toBe("Jarvis");

    const cleared = svc.set("101", { voiceId: null, speed: null, name: null });
    expect(cleared).toEqual({});
    db.close();
  });

  it("returns undefined for an unknown extension", () => {
    const db = seededDb();
    expect(new VoiceProfileService(db).set("999999", { speed: 1.2 })).toBeUndefined();
    db.close();
  });

  it("a voice profile SURVIVES agent re-registration (spawn must not wipe it)", async () => {
    const db = seededDb();
    const { AgentService } = await import("../agents/agentService.js");
    const agents = new AgentService(db);
    const vp = new VoiceProfileService(db);
    const reg = () => agents.register({
      id: "codex-agent", extension: "101", name: "Codex", adapterType: "codex-cli",
      permissions: {}, capabilities: ["calls"], status: "online"
    } as Parameters<InstanceType<typeof AgentService>["register"]>[0]);

    reg(); // first spawn
    vp.set("101", { voiceId: "local:jarvis", name: "Jarvis (on-device)" });
    expect(vp.get("101").voiceId).toBe("local:jarvis");
    reg(); // agent spawns AGAIN (a later call/text) — used to clobber the voice
    expect(vp.get("101").voiceId).toBe("local:jarvis");
    db.close();
  });

  it("rejects a non-UUID voiceId at set time (would brick every later call)", () => {
    const db = seededDb();
    const svc = new VoiceProfileService(db);
    expect(() => svc.set("101", { voiceId: "Oliver" })).toThrow(/UUID/);
    // The profile stayed clean.
    expect(svc.get("101")).toEqual({});
    db.close();
  });
});

describe("war room (911 red alert + group chat)", () => {
  it("red alert puts every agent + the user into ONE shared war-room thread", () => {
    const db = seededDb();
    const messages = new MessageService(db);
    const wr = new WarRoomService(db, messages, noopHub);
    const agents = wr.listAgentExtensions().map((a) => a.extension).sort();
    expect(agents).toEqual(["101", "103", "104"]);

    return wr.triggerRedAlert({ message: "prod is down" }).then((result) => {
      expect(result.alerted.map((a) => a.extension).sort()).toEqual(["101", "103", "104"]);
      // ONE alert message in ONE shared group thread (not a DM per agent) —
      // agent replies land back in this same thread.
      const groupMsgs = wr.groupMessages(result.groupId);
      expect(groupMsgs).toHaveLength(1);
      expect(groupMsgs[0].priority).toBe("critical");
      expect(messages.threadMembers(result.groupId).sort()).toEqual(["100", "101", "103", "104"]);
      // The 911 group extension was created on demand.
      expect(new ExtensionService(db).get("911")?.name).toContain("RED ALERT");
      db.close();
    });
  });

  it("group chat delivers to members and records them under one group id", async () => {
    const db = seededDb();
    const messages = new MessageService(db);
    // delivered now counts members that are actually reachable, so this hub
    // reports everyone online (the noopHub would make delivered 0).
    const wr = new WarRoomService(db, messages, { ...noopHub, isExtensionOnline: () => true });
    const result = await wr.createGroupChat({ members: ["101", "103"], message: "huddle up" });
    // The sender (user 100) is a member too — it's a shared conversation.
    expect(result.members.sort()).toEqual(["100", "101", "103"]);
    expect(result.delivered).toBe(2);
    // ONE shared message in the group thread — not a copy per member.
    expect(wr.groupMessages(result.groupId)).toHaveLength(1);
    db.close();
  });

  it("an agent posting to a group as ext 100 is recorded as AGENT, not user (anti-spoof)", async () => {
    const db = seededDb();
    const messages = new MessageService(db);
    const wr = new WarRoomService(db, messages, { ...noopHub, isExtensionOnline: () => true });
    const { threadId } = await wr.createGroupChat({ members: ["101", "103"], message: "kickoff", userAuthored: true });

    // The opener (real user route) is device-authored.
    const opener = wr.groupMessages(threadId).at(-1)!;
    expect(opener.from_type).toBe("device");

    // An agent posting as ext 100 WITHOUT the userAuthored flag (the MCP path)
    // must NOT be recorded as the user — otherwise it would reset the relay cap.
    await wr.postToGroup({ threadId, fromExtension: "100", body: "spoof as the user" });
    const spoof = wr.groupMessages(threadId).at(-1)!;
    expect(spoof.from_type).toBe("agent");
    db.close();
  });

  it("group chat rejects unknown member extensions", async () => {
    const db = seededDb();
    const messages = new MessageService(db);
    const wr = new WarRoomService(db, messages, noopHub);
    await expect(wr.createGroupChat({ members: ["101", "999"], message: "hi" })).rejects.toThrow(/unknown extension/);
    db.close();
  });

  it("offline group members catch up via delivered_to receipts (no double replay)", async () => {
    const db = seededDb();
    const messages = new MessageService(db);
    const wr = new WarRoomService(db, messages, { ...noopHub, isExtensionOnline: () => true });
    const { groupId } = await wr.createGroupChat({ members: ["101", "103"], message: "while 103 is down" });
    const [post] = wr.groupMessages(groupId);

    // 101 had a live socket at fanout; 103 did not.
    messages.markDeliveredTo(post.id, "101");

    // 103 reconnects: the message is pending exactly for it…
    expect(messages.queuedGroupMessagesFor("103").map((m) => m.id)).toContain(post.id);
    expect(messages.queuedGroupMessagesFor("101").map((m) => m.id)).not.toContain(post.id);

    // …and replaying stamps the receipt so a second reconnect replays nothing.
    messages.markDeliveredTo(post.id, "103");
    expect(messages.queuedGroupMessagesFor("103")).toHaveLength(0);
    // The sender never gets its own message back.
    expect(messages.queuedGroupMessagesFor("100")).toHaveLength(0);
    db.close();
  });
});

describe("slash commands over text", () => {
  const apps: Awaited<ReturnType<typeof makeTestApp>>[] = [];
  afterEach(async () => {
    for (const item of apps.splice(0)) await item.app.close();
  });

  async function sendText(app: Awaited<ReturnType<typeof makeTestApp>>, to: string, body: string) {
    const res = await app.app.inject({
      method: "POST",
      url: "/api/messages",
      headers: authHeaders.device,
      payload: { to_extension: to, body }
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("/phone replies instantly with the phone command list (CLI feel)", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const out = await sendText(built, "101", "/phone");
    expect(out.slash_reply).toBeDefined();
    expect(out.slash_reply.body).toContain("/911");
    expect(out.slash_reply.from_extension).toBe("101");
    expect(out.slash_reply.metadata).toBeDefined();
  });

  it("/help belongs to the AGENT'S CLI — forwarded, not server-answered", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const out = await sendText(built, "101", "/help");
    expect(out.slash_reply).toBeUndefined();
    expect(out.body).toBe("/help");
  });

  it("/agents lists registered agents", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const out = await sendText(built, "101", "/agents");
    expect(out.slash_reply.body).toContain("101");
  });

  it("/voice speed sets the speaking rate and /voice show reflects it", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const set = await sendText(built, "101", "/voice speed 1.5");
    expect(set.slash_reply.body).toContain("1.5");
    const show = await sendText(built, "101", "/voice show");
    expect(show.slash_reply.body).toContain("1.5");
  });

  it("/voice with a malformed uuid returns a friendly reply, not an HTTP error", async () => {
    const built = await makeTestApp();
    apps.push(built);
    for (const bad of ["/voice 12345678", "/voice deadbeef", "/voice 12345678-1234-1234-1234-1234567890ab"]) {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/messages",
        headers: authHeaders.device,
        payload: { to_extension: "101", body: bad }
      });
      // The CLI contract: every slash command gets a 200 + in-thread reply.
      expect(res.statusCode).toBe(200);
      expect(res.json().slash_reply.body).toMatch(/usage|could not set voice/);
    }
  });

  it("unknown /commands fall through to the agent's own CLI (no slash_reply)", async () => {
    const built = await makeTestApp();
    apps.push(built);
    for (const cli of ["/usage", "/context", "/my-custom-command do the thing"]) {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/messages",
        headers: authHeaders.device,
        payload: { to_extension: "101", body: cli }
      });
      expect(res.statusCode).toBe(200);
      // Delivered as a NORMAL message for the agent's CLI — not server-answered.
      expect(res.json().slash_reply).toBeUndefined();
      expect(res.json().body).toBe(cli);
    }
  });

  it("/911 triggers a red alert from a text", async () => {
    const built = await makeTestApp();
    apps.push(built);
    const out = await sendText(built, "101", "/911 everything is on fire");
    expect(out.slash_reply.body).toContain("RED ALERT");
    // metadata is stored/returned as a JSON string by design.
    expect(JSON.parse(out.slash_reply.metadata).red_alert).toBe(true);
  });
});
