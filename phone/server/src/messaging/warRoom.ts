import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { CallService } from "../calls/callService.js";
import { MessageService, type MessagePriority, type MessageRow } from "./messageService.js";
import type { CallRecord, ExtensionRecord } from "../types.js";

/** The extension that triggers a red alert. Dialing/texting it fans out to every agent. */
export const RED_ALERT_EXTENSION = "911";
/** The pre-seeded broadcast group ("Emergency / All Agents"). */
export const BROADCAST_GROUP_EXTENSION = "900";
/** Group extension for user-picked multi-agent conference calls. */
export const CONFERENCE_GROUP_EXTENSION = "902";
export const PRIMARY_USER_EXTENSION = "100";

/**
 * Minimal slice of the WebSocket hub the war room needs. Declared as an interface
 * so this module doesn't import the hub (which imports messaging — would be a
 * cycle).
 */
export interface WarRoomHub {
  ensureAgentOnline(extension: string): Promise<void>;
  notifyNewMessage(message: MessageRow): boolean;
  sendToExtension(extension: string, event: Record<string, unknown>): void;
  isExtensionOnline(extension: string): boolean;
  /** Live WebSocket ONLY — the DB online flag can be set before the socket exists. */
  hasLiveConnection(extension: string): boolean;
}

export type RedAlertCallResult = {
  ok: true;
  mode: "call" | "none";
  callId: string | null;
  agents: Array<{ extension: string; name: string }>;
  message: string;
};

export type RedAlertResult = {
  ok: true;
  groupId: string;
  thread_subject: string;
  alerted: Array<{ extension: string; agentId: string; name: string; spawned: boolean }>;
  message: string;
};

export type GroupChatResult = {
  ok: true;
  /** The shared thread id for the whole group (open this to see the conversation). */
  threadId: string;
  groupId: string; // alias of threadId, kept for compatibility
  subject: string;
  members: string[];
  delivered: number;
};

export type ConferenceResult = {
  ok: true;
  callId: string;
  members: Array<{ extension: string; name: string }>;
  /** Selected members that could not be brought online (left out of the call). */
  skipped: string[];
};

/**
 * War zone / group chat (feature: "if I call extension 911 → red alert, all
 * agents join and help; group chat with me and multiple agents").
 *
 * Group conversations are modeled on top of the existing per-extension inbox: a
 * group is a shared `groupId` carried in message metadata, and a post fans out as
 * one urgent message to each member plus a `group_message` WebSocket event. This
 * works with the current 1:1 thread/inbox model without a schema change. Full
 * N-way *audio* bridging is tracked separately (issues #1 / #6).
 */
export class WarRoomService {
  private readonly extensions: ExtensionService;
  private readonly calls: CallService;

  constructor(
    private readonly db: AppDatabase,
    private readonly messages: MessageService,
    private readonly hub: WarRoomHub
  ) {
    this.extensions = new ExtensionService(db);
    this.calls = new CallService(db);
  }

  /** Every registered agent extension (online or not). */
  listAgentExtensions(): ExtensionRecord[] {
    return this.extensions.list().filter((row) => row.owner_type === "agent");
  }

  /** Agents that have a live connection right now. */
  listOnlineAgents(): ExtensionRecord[] {
    return this.listAgentExtensions().filter((row) => row.online === 1 || this.hub.isExtensionOnline(row.extension));
  }

  /**
   * RED ALERT as a CALL (feature: "when I call 911, all online agents JOIN the
   * call"). Opens a multi-party war-room call with the user, pulls every ONLINE
   * agent into it, and tells each agent's connector to join and talk. Offline
   * agents are deliberately NOT texted — only online agents join.
   */
  async triggerRedAlertCall(input: { fromExtension?: string }): Promise<RedAlertCallResult> {
    this.ensureRedAlertExtension();
    const from = input.fromExtension ?? PRIMARY_USER_EXTENSION;
    // Bring EVERY agent online (spawn the offline ones) so ALL available agents join,
    // not just the ones that happened to be connected.
    const all = this.listAgentExtensions();
    await Promise.allSettled(all.map((a) => this.hub.ensureAgentOnline(a.extension)));
    // Live sockets only — the DB online flag flips on REST register BEFORE the
    // socket exists, and a rostered agent with no socket would be reported as
    // "joining" while its war_room_join silently goes nowhere.
    const online = all.filter((a) => this.hub.hasLiveConnection(a.extension));
    if (online.length === 0) {
      this.hub.sendToExtension(from, { type: "red_alert_empty", message: "No agents could be brought online to join the war room." });
      return { ok: true, mode: "none", callId: null, agents: [], message: "No agents available." };
    }
    const exts = online.map((a) => a.extension);
    const call: CallRecord = this.calls.createWarRoomCall(from, RED_ALERT_EXTENSION, exts, "🚨 RED ALERT war room");
    // Put the user into the active call (mirror the normal dial→active handshake).
    this.hub.sendToExtension(from, { type: "dial_result", call });
    this.hub.sendToExtension(from, { type: "call_accept", call });
    // Bring each online agent into the room — its connector joins and responds to
    // the user's spoken turns (agent TTS is serialized server-side so they take
    // turns rather than talk over each other).
    for (const a of online) {
      this.hub.sendToExtension(a.extension, { type: "war_room_join", callId: call.id, from, subject: "RED ALERT" });
    }
    this.db.event("red_alert_call", { callId: call.id, agents: exts }, from);
    return { ok: true, mode: "call", callId: call.id, agents: online.map((a) => ({ extension: a.extension, name: a.name })), message: `${exts.length} agent(s) joining the war room.` };
  }

  /** Make sure the 911 red-alert group extension exists (created on demand). */
  ensureRedAlertExtension(): void {
    if (this.extensions.get(RED_ALERT_EXTENSION)) return;
    this.extensions.create({
      extension: RED_ALERT_EXTENSION,
      ownerType: "group",
      ownerId: "red-alert",
      name: "🚨 RED ALERT / War Room",
      permissions: { broadcast: true },
      allowedCallers: [PRIMARY_USER_EXTENSION],
      metadata: { role: "red-alert", emergency: true }
    });
  }

  /** Make sure the conference group extension exists (created on demand). */
  ensureConferenceExtension(): void {
    if (this.extensions.get(CONFERENCE_GROUP_EXTENSION)) return;
    this.extensions.create({
      extension: CONFERENCE_GROUP_EXTENSION,
      ownerType: "group",
      ownerId: "conference",
      name: "Conference call",
      permissions: { broadcast: true },
      allowedCallers: [PRIMARY_USER_EXTENSION],
      metadata: { role: "conference" }
    });
  }

  /**
   * Start a conference CALL with the user + only the CHOSEN agents (the voice
   * twin of createGroupChat). Same machinery as the 911 war room — multi-party
   * call, war_room_join to each member — but with a hand-picked roster instead
   * of every agent.
   */
  async startConference(input: { fromExtension?: string; members: string[]; reason?: string }): Promise<ConferenceResult> {
    this.ensureConferenceExtension();
    const from = input.fromExtension ?? PRIMARY_USER_EXTENSION;
    const wanted = Array.from(new Set(input.members.filter((m) => m && m !== from)));
    if (wanted.length === 0) throw new Error("conference needs at least one agent member");
    const notAgents = wanted.filter((m) => this.extensions.get(m)?.owner_type !== "agent");
    if (notAgents.length > 0) throw new Error(`not agent extension(s): ${notAgents.join(", ")}`);

    // Spawn each chosen member; the roster is whoever actually has a LIVE
    // socket (not just the DB online flag — see triggerRedAlertCall).
    await Promise.allSettled(wanted.map((m) => this.hub.ensureAgentOnline(m)));
    const online = wanted.filter((m) => this.hub.hasLiveConnection(m));
    if (online.length === 0) {
      throw new Error("none of the selected agents could be brought online");
    }
    const reason = input.reason?.trim() || `Conference: ${online.map((m) => this.extensions.get(m)?.name ?? m).join(", ")}`;
    const call: CallRecord = this.calls.createWarRoomCall(from, CONFERENCE_GROUP_EXTENSION, online, reason);
    // Mirror the dial→active handshake so the phone's call screen lights up.
    this.hub.sendToExtension(from, { type: "dial_result", call });
    this.hub.sendToExtension(from, { type: "call_accept", call, conference_roster: online });
    for (const ext of online) {
      this.hub.sendToExtension(ext, { type: "war_room_join", callId: call.id, from, subject: "Conference" });
    }
    this.db.event("conference_call", { callId: call.id, members: online }, from);
    return {
      ok: true,
      callId: call.id,
      members: online.map((m) => ({ extension: m, name: this.extensions.get(m)?.name ?? m })),
      skipped: wanted.filter((m) => !online.includes(m))
    };
  }

  /**
   * RED ALERT: pull every agent online and drop the alert into ONE shared
   * war-room group thread (user + every agent), so all replies land in the same
   * conversation instead of scattering into per-agent DM threads.
   */
  async triggerRedAlert(input: { fromExtension?: string; message: string }): Promise<RedAlertResult> {
    this.ensureRedAlertExtension();
    const from = input.fromExtension ?? PRIMARY_USER_EXTENSION;
    const subject = `🚨 RED ALERT ${this.db.id("war").slice(-6)}`;
    const agents = this.listAgentExtensions();
    const body = input.message?.trim() || "All hands — red alert. Join the war room and help.";

    const alerted: RedAlertResult["alerted"] = [];
    for (const agent of agents) {
      let spawned = false;
      try {
        if (agent.online !== 1) {
          await this.hub.ensureAgentOnline(agent.extension);
          spawned = this.extensions.get(agent.extension)?.online === 1;
        }
      } catch {
        // best-effort spawn; the message is still queued for when it connects
      }
      alerted.push({ extension: agent.extension, agentId: agent.owner_id, name: agent.name, spawned });
    }

    // ONE shared thread = the war room. Same mechanism as a normal group chat,
    // just at critical priority with every agent as a member.
    const thread = this.messages.createGroupThread(subject, [from, ...agents.map((a) => a.extension)], from);
    const groupId = thread.id;
    await this.postToGroup({ threadId: groupId, fromExtension: from, body, priority: "critical" });
    for (const agent of agents) {
      this.hub.sendToExtension(agent.extension, { type: "red_alert", group_id: groupId, from, message: body, subject });
    }

    // Mirror the alert to the user's own feed so the war room shows on the device too.
    this.hub.sendToExtension(from, { type: "red_alert", group_id: groupId, from, message: body, subject, alerted: alerted.map((a) => a.extension) });
    this.db.event("red_alert", { groupId, from, agentCount: alerted.length }, from);
    return { ok: true, groupId, thread_subject: subject, alerted, message: body };
  }

  /**
   * Start a REAL group chat: one shared thread with the user + the chosen agents.
   * Every member sees the same conversation; the user's posts go to all agents,
   * and each agent's reply lands in the same thread (visible to everyone). Returns
   * the thread id — open it to see/continue the group chat.
   */
  async createGroupChat(input: { fromExtension?: string; members: string[]; subject?: string; message?: string; userAuthored?: boolean }): Promise<GroupChatResult> {
    const from = input.fromExtension ?? PRIMARY_USER_EXTENSION;
    const others = Array.from(new Set(input.members.filter((m) => m && m !== from)));
    if (others.length === 0) throw new Error("group chat needs at least one member besides the sender");
    // Reject members that aren't registered extensions. Without this a typo'd
    // member (e.g. "999") silently joins the group forever: it inflates the
    // "delivered" count on every post and can never receive or reply.
    const unknown = others.filter((m) => !this.extensions.get(m));
    if (unknown.length > 0) throw new Error(`unknown extension(s): ${unknown.join(", ")}`);
    const allMembers = [from, ...others];
    const names = others.map((m) => this.extensions.get(m)?.name ?? m);
    const subject = input.subject?.trim() || `Group: ${names.join(", ")}`;
    // Bring every agent member online so they all participate.
    await Promise.allSettled(others.map((m) => this.hub.ensureAgentOnline(m)));
    const thread = this.messages.createGroupThread(subject, allMembers, from);
    let delivered = 0;
    if (input.message?.trim()) {
      delivered = await this.postToGroup({ threadId: thread.id, fromExtension: from, body: input.message, userAuthored: input.userAuthored });
    }
    this.db.event("group_chat_created", { threadId: thread.id, from, members: allMembers }, from);
    return { ok: true, threadId: thread.id, groupId: thread.id, subject, members: allMembers, delivered };
  }

  /**
   * Post one message into a group thread. It goes to ALL members (via the
   * thread's member list), so everyone sees it; agents respond, and their replies
   * land back in the same thread.
   */
  async postToGroup(input: { threadId: string; fromExtension: string; body: string; priority?: MessagePriority; userAuthored?: boolean }): Promise<number> {
    const members = this.messages.threadMembers(input.threadId);
    if (members.length === 0) throw new Error("not a group thread");
    // Make sure every other member (agents) is online to receive + respond.
    await Promise.allSettled(members.filter((m) => m !== input.fromExtension).map((m) => this.hub.ensureAgentOnline(m)));
    const thread = this.messages.getThread(input.threadId);
    // TOKEN-SAFETY: a group message is "device" (a real user turn that RESETS
    // the agent-relay chain cap) ONLY when it came through the device-auth HTTP
    // route (userAuthored). Anything posted via the agent MCP tools is agent-
    // authored regardless of the claimed from_extension — otherwise an agent
    // could post as ext 100, reset the cap, and self-sustain CLI runs forever.
    const fromIsAgent = !input.userAuthored || this.extensions.get(input.fromExtension)?.owner_type === "agent";
    const message = this.messages.createMessage({
      from_extension: input.fromExtension,
      to_extension: BROADCAST_GROUP_EXTENSION,
      from_type: fromIsAgent ? "agent" : "device",
      to_type: "system",
      title: thread?.subject ?? "Group chat",
      body: input.body,
      priority: input.priority ?? "normal",
      requires_response: false,
      response_options: [],
      thread_id: input.threadId,
      metadata: { kind: "group_message", group_thread: input.threadId, group_members: members }
    });
    this.hub.notifyNewMessage(message);
    this.db.event("group_message", { threadId: input.threadId, from: input.fromExtension }, input.fromExtension);
    // Report how many members are actually reachable right now (we just tried to
    // bring them all online above), not merely how many are on the member list.
    return members.filter((m) => m !== input.fromExtension && this.hub.isExtensionOnline(m)).length;
  }

  /** All messages in a group thread, oldest first. */
  groupMessages(threadId: string, limit = 200): MessageRow[] {
    return this.messages.listMessages({ thread_id: threadId, limit }).reverse();
  }
}
