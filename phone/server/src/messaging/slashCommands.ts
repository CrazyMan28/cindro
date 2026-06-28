import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import { AgentService } from "../agents/agentService.js";
import { MessageService } from "./messageService.js";
import { VoiceProfileService, VOICE_UUID_RE, clampSpeed } from "../audio/voiceProfiles.js";
import { WarRoomService } from "./warRoom.js";
import { CallService } from "../calls/callService.js";

/**
 * Slash-commands over text (feature: "more specific /commands for codex and
 * claude when texting — like you're really in the CLI"). When a user texts an
 * agent a body starting with `/`, the SERVER handles it deterministically and
 * the agent "replies" instantly, instead of the text being forwarded to the LLM.
 * That makes the inbox feel like a real terminal session with the agent.
 */

export interface SlashHub {
  ensureAgentOnline(extension: string): Promise<void>;
  notifyNewMessage(message: import("./messageService.js").MessageRow): boolean;
  sendToExtension(extension: string, event: Record<string, unknown>): void;
}

export type SlashContext = {
  db: AppDatabase;
  extensions: ExtensionService;
  agents: AgentService;
  messages: MessageService;
  calls: CallService;
  warRoom: WarRoomService;
  voiceProfiles: VoiceProfileService;
  hub: SlashHub;
};

export type SlashResult = { handled: boolean; reply: string; meta?: Record<string, unknown> };

export function isSlashCommand(body: string | undefined): boolean {
  return typeof body === "string" && /^\s*\//.test(body);
}

const HELP = [
  "AGENT PHONE — phone commands",
  "  /phone             this list",
  "  /presence          this agent's presence + current task",
  "  /agents            every agent, extension and presence",
  "  /whoami            who you are and your open threads",
  "  /voice [show|reset|speed <n>|name <label>|<uuid>]",
  "                     show or set this agent's call voice + rate",
  "  /call [reason]     ask this agent to call you back",
  "  /history [n]       last n messages in this thread",
  "  /clear             delete this conversation",
  "  /end               end the live call with this agent",
  "  /group <ext,ext> [msg]   start a group chat with several agents",
  "  /911 [message]     RED ALERT — pull every agent into the war room",
  "  /redalert [...]    alias for /911",
  "",
  "/help and every other /command go to THIS AGENT'S own CLI",
  "(e.g. Claude Code's /usage, /context, /cost)."
].join("\n");

/**
 * Run a slash command. `fromExtension` is the user, `toExtension` is the agent
 * they texted, `threadId` is the conversation it arrived on (for /history,
 * /clear). Returns the agent's reply text.
 */
export async function handleSlashCommand(
  input: { body: string; fromExtension: string; toExtension: string; threadId?: string },
  ctx: SlashContext
): Promise<SlashResult> {
  const raw = input.body.trim().replace(/^\//, "");
  const [cmd, ...rest] = raw.split(/\s+/);
  const argStr = raw.slice(cmd.length).trim();
  const command = (cmd || "help").toLowerCase();

  switch (command) {
    // The phone's own list lives at /phone — /help belongs to the AGENT'S CLI
    // (each bridge answers it with its real command set).
    case "phone":
    case "phonehelp":
      return reply(HELP);

    // "/status" belongs to the agent's CLI (Codex account status etc.) —
    // the phone's presence readout lives at /presence now.
    case "presence": {
      const ext = ctx.extensions.get(input.toExtension);
      const agent = ctx.agents.getByExtension(input.toExtension);
      if (!ext) return reply(`extension ${input.toExtension} is not registered`);
      const presence = ext.online === 1 ? (ext.busy === 1 ? "busy" : "online") : "offline";
      const task = agent?.current_task ? `\n  task:     ${agent.current_task}` : "";
      const beat = agent?.last_heartbeat_at ? `\n  lastseen: ${agent.last_heartbeat_at}` : "";
      return reply(`${ext.name} [ext ${ext.extension}]\n  presence: ${presence}${task}${beat}`);
    }

    case "agents": {
      const rows = ctx.extensions.list().filter((e) => e.owner_type === "agent");
      if (rows.length === 0) return reply("no agents registered");
      const lines = rows.map((e) => {
        const presence = e.online === 1 ? (e.busy === 1 ? "● busy" : "● online") : "○ offline";
        const agent = ctx.agents.getByExtension(e.extension);
        const task = agent?.current_task ? ` — ${agent.current_task}` : "";
        return `  ${e.extension}  ${presence.padEnd(9)} ${e.name}${task}`;
      });
      return reply(["agents:", ...lines].join("\n"));
    }

    case "whoami": {
      const ext = ctx.extensions.get(input.fromExtension);
      const threads = ctx.messages.listThreads({ extension: input.fromExtension, limit: 100 });
      const open = threads.filter((t) => t.status === "open").length;
      return reply(`you are ${ext?.name ?? "unknown"} [ext ${input.fromExtension}]\n  open threads: ${open}`);
    }

    case "voice": {
      const sub = (rest[0] ?? "show").toLowerCase();
      if (sub === "show" || !argStr) {
        const p = ctx.voiceProfiles.get(input.toExtension);
        const bits = [
          `voice profile for ext ${input.toExtension}:`,
          `  voiceId: ${p.voiceId ?? "(global default)"}`,
          `  speed:   ${p.speed ?? 1}`,
          `  name:    ${p.name ?? "(none)"}`
        ];
        return reply(bits.join("\n"));
      }
      if (sub === "reset") {
        ctx.voiceProfiles.set(input.toExtension, { voiceId: null, speed: null, name: null });
        return reply(`voice profile for ext ${input.toExtension} reset to defaults`);
      }
      if (sub === "speed") {
        const n = Number(rest[1]);
        if (!Number.isFinite(n)) return reply("usage: /voice speed <0.5-2.0>");
        const p = ctx.voiceProfiles.set(input.toExtension, { speed: clampSpeed(n) });
        return reply(`speaking rate for ext ${input.toExtension} set to ${p?.speed}`);
      }
      if (sub === "name") {
        const name = argStr.replace(/^name\s+/i, "").trim();
        if (!name) return reply("usage: /voice name <label>");
        ctx.voiceProfiles.set(input.toExtension, { name });
        return reply(`voice label for ext ${input.toExtension} set to "${name}"`);
      }
      // Treat the first token as a voice UUID. The gate must match the STRICT
      // check inside VoiceProfileService.set — a looser regex here let
      // UUID-shaped-but-invalid ids through to set(), whose throw escaped the
      // whole POST /api/messages request as a raw 400 with no slash_reply.
      const uuid = rest[0];
      if (!VOICE_UUID_RE.test(uuid) && !/^local:[a-z0-9_-]+$/i.test(uuid)) {
        return reply("usage: /voice <uuid|local:name> | speed <n> | name <label> | show | reset (ids come from /api/voices)");
      }
      try {
        const p = ctx.voiceProfiles.set(input.toExtension, { voiceId: uuid });
        return reply(`call voice for ext ${input.toExtension} set to ${p?.voiceId}`);
      } catch (error) {
        return reply(`could not set voice: ${error instanceof Error ? error.message : "invalid voice id"}`);
      }
    }

    case "call":
    case "callme": {
      const reason = argStr || "user requested a callback";
      ctx.hub.sendToExtension(input.toExtension, {
        type: "callback_request",
        from_extension: input.fromExtension,
        to_extension: input.toExtension,
        reason
      });
      ctx.db.event("callback_request", { from: input.fromExtension, to: input.toExtension, reason }, input.fromExtension);
      try { await ctx.hub.ensureAgentOnline(input.toExtension); } catch { /* best-effort */ }
      return reply(`📞 asked ext ${input.toExtension} to call you back — reason: ${reason}`, { callback_requested: true });
    }

    case "history": {
      if (!input.threadId) return reply("no thread context for /history");
      const n = Math.min(50, Math.max(1, Number(rest[0]) || 10));
      const msgs = ctx.messages.listMessages({ thread_id: input.threadId, limit: n });
      if (msgs.length === 0) return reply("(no messages yet)");
      const lines = msgs.reverse().map((m) => `  [${m.from_extension}→${m.to_extension}] ${m.body.slice(0, 120)}`);
      return reply([`last ${msgs.length} messages:`, ...lines].join("\n"));
    }

    case "clear": {
      if (!input.threadId) return reply("no thread context for /clear");
      const ok = ctx.messages.deleteThread(input.threadId);
      return reply(ok ? "🧹 conversation cleared" : "nothing to clear", { cleared: ok, thread_id: input.threadId });
    }

    case "end": {
      const active = ctx.calls.activeCallsForExtension(input.fromExtension);
      let ended = 0;
      for (const callId of active) {
        const call = ctx.calls.get(callId);
        if (call && (call.from_extension === input.toExtension || call.to_extension === input.toExtension)) {
          ctx.calls.end(callId, input.fromExtension, "ended_via_text_command");
          ctx.hub.sendToExtension(input.toExtension, { type: "call_end", callId });
          ended += 1;
        }
      }
      return reply(ended > 0 ? `📴 ended ${ended} call(s) with ext ${input.toExtension}` : "no active call to end", { ended });
    }

    case "group": {
      const members = (rest[0] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (members.length === 0) return reply("usage: /group <ext,ext,...> [message]");
      const message = argStr.slice((rest[0] ?? "").length).trim();
      const result = await ctx.warRoom.createGroupChat({ fromExtension: input.fromExtension, members, message: message || undefined });
      return reply(`👥 group chat started (${result.members.join(", ")}) — id ${result.groupId.slice(-6)}${message ? `, delivered ${result.delivered}` : ""}`, { group_id: result.groupId });
    }

    case "911":
    case "redalert":
    case "red-alert": {
      const result = await ctx.warRoom.triggerRedAlert({ fromExtension: input.fromExtension, message: argStr });
      const roster = result.alerted.map((a) => `${a.extension}${a.spawned ? "*" : ""}`).join(", ");
      return reply(`🚨 RED ALERT broadcast to ${result.alerted.length} agent(s): ${roster}\n(* = spawned now)  group ${result.groupId.slice(-6)}`, { group_id: result.groupId, red_alert: true });
    }

    default:
      // Not a phone command — let it fall through to the AGENT'S OWN CLI
      // (Claude Code / Codex slash commands like /usage, /context, /compact,
      // or the user's custom commands). The bridge passes it raw.
      return { handled: false, reply: "" };
  }
}

function reply(text: string, meta?: Record<string, unknown>): SlashResult {
  return { handled: true, reply: text, meta };
}
