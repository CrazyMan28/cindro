import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { ExtensionService } from "../extensions/extensionService.js";
import type { CallRecord } from "../types.js";

export const DialSchema = z.object({
  fromExtension: z.string().regex(/^\d{2,8}$/),
  toExtension: z.string().regex(/^\d{2,8}$/),
  reason: z.string().optional(),
  urgency: z.string().optional().default("normal"),
  sessionId: z.string().optional()
});

export class CallService {
  private readonly extensions: ExtensionService;

  constructor(private readonly db: AppDatabase) {
    this.extensions = new ExtensionService(db);
  }

  dial(input: z.infer<typeof DialSchema>) {
    const value = DialSchema.parse(input);
    const from = this.extensions.get(value.fromExtension);
    const to = this.extensions.get(value.toExtension);
    if (!from) {
      throw Object.assign(new Error(`caller extension ${value.fromExtension} is unknown`), { statusCode: 404 });
    }
    if (!to) {
      throw Object.assign(new Error(`target extension ${value.toExtension} is unknown`), { statusCode: 404 });
    }
    this.assertAllowedCaller(to.allowed_callers, value.fromExtension);

    const now = this.db.now();
    const callId = this.db.id("call");
    // Issue #11: the busy read, the call INSERT and the setBusy write must be one
    // atomic unit. better-sqlite3 is synchronous so a JS-level interleave can't
    // happen, but wrapping in a transaction makes the check-and-set explicit and
    // all-or-nothing, and re-reading busy *inside* the transaction guarantees we
    // decide on the freshest state rather than a value read before validation.
    this.db.transaction(() => {
      const target = this.extensions.get(value.toExtension) ?? to;
      const targetOffline = target.online !== 1 && target.owner_type !== "group";
      const targetBusy = target.busy === 1;
      const state = targetOffline ? "missed" : targetBusy ? "created" : "ringing";
      this.db.sqlite
        .prepare(
          `INSERT INTO calls
           (id, from_extension, to_extension, state, reason, urgency, session_id, created_at, updated_at, failure_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          callId,
          value.fromExtension,
          value.toExtension,
          state,
          value.reason ?? null,
          value.urgency ?? "normal",
          value.sessionId ?? null,
          now,
          now,
          targetOffline ? "target_offline" : targetBusy ? "target_busy_queued" : null
        );
      this.addParticipant(callId, value.fromExtension, "caller", "joined");
      this.addParticipant(callId, value.toExtension, "callee", state === "missed" ? "missed" : "ringing");

      if (targetOffline) {
        this.db.sqlite
          .prepare(
            `INSERT INTO missed_calls (id, call_id, from_extension, to_extension, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(this.db.id("missed"), callId, value.fromExtension, value.toExtension, value.reason ?? null, now);
        this.db.event("call.missed", value, value.fromExtension, callId, value.sessionId);
        this.db.event("call_missed", value, value.fromExtension, callId, value.sessionId);
      } else if (targetBusy) {
        this.db.event("call.queued", value, value.fromExtension, callId, value.sessionId);
      } else {
        this.extensions.setBusy(value.toExtension, true);
        this.db.event("call.ringing", value, value.fromExtension, callId, value.sessionId);
        this.db.event("call_started", value, value.fromExtension, callId, value.sessionId);
      }
    });
    return this.get(callId)!;
  }

  /**
   * Create a multi-party "war room" call (911 red alert): the user as caller, the
   * 911 group as the target, and every currently-online agent already joined. It
   * opens `active` immediately — there's no single callee to ring.
   */
  createWarRoomCall(fromExtension: string, toExtension: string, agentExtensions: string[], reason: string) {
    const now = this.db.now();
    const callId = this.db.id("call");
    this.db.transaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO calls
           (id, from_extension, to_extension, state, reason, urgency, session_id, created_at, updated_at, accepted_at, failure_reason)
           VALUES (?, ?, ?, 'active', ?, 'critical', NULL, ?, ?, ?, NULL)`
        )
        .run(callId, fromExtension, toExtension, reason, now, now, now);
      this.addParticipant(callId, fromExtension, "caller", "joined");
      for (const ext of agentExtensions) this.addParticipant(callId, ext, "callee", "joined");
      this.extensions.setBusy(fromExtension, true);
      this.db.event("call.warroom", { participants: agentExtensions }, fromExtension, callId);
    });
    return this.get(callId)!;
  }

  /** All extensions currently attached to a call (any role). */
  participantExtensions(callId: string): string[] {
    const rows = this.db.sqlite.prepare("SELECT extension FROM call_participants WHERE call_id = ?").all(callId) as Array<{ extension: string }>;
    return rows.map((r) => r.extension);
  }

  /** Extensions still ACTIVE in the call (joined — excludes kicked/left), in join order. */
  joinedParticipantExtensions(callId: string): string[] {
    const rows = this.db.sqlite
      .prepare("SELECT extension FROM call_participants WHERE call_id = ? AND state = 'joined' ORDER BY rowid")
      .all(callId) as Array<{ extension: string }>;
    return rows.map((r) => r.extension);
  }

  /** Joined participants that are agents, in join order (lead = first). */
  agentParticipantExtensions(callId: string): string[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT cp.extension FROM call_participants cp
         JOIN extensions e ON e.extension = cp.extension
         WHERE cp.call_id = ? AND cp.state = 'joined' AND e.owner_type = 'agent'
         ORDER BY cp.rowid`
      )
      .all(callId) as Array<{ extension: string }>;
    return rows.map((r) => r.extension);
  }

  /**
   * Remove ONE participant from a multi-party call WITHOUT ending it: the row
   * flips to 'kicked' so it drops out of joined/agent participant queries, while
   * the call and every other participant stay exactly as they were.
   */
  removeParticipant(callId: string, extension: string) {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE call_participants SET state = 'kicked', left_at = ? WHERE call_id = ? AND extension = ?")
      .run(now, callId, extension);
    // Defensive: multi-party calls never mark agents busy, but clear it anyway so
    // a kicked agent is immediately callable elsewhere.
    this.extensions.setBusy(extension, false);
    this.db.event("call.participant_removed", { callId, extension }, extension, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  accept(callId: string, extension: string) {
    const call = this.requireCall(callId);
    if (![call.to_extension, call.from_extension].includes(extension)) {
      throw Object.assign(new Error("extension is not a participant in this call"), { statusCode: 403 });
    }
    if (!["ringing", "created", "accepted"].includes(call.state)) {
      throw Object.assign(new Error(`call cannot be accepted from state ${call.state}`), { statusCode: 409 });
    }
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE calls SET state = 'active', accepted_at = COALESCE(accepted_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, callId);
    this.db.sqlite
      .prepare("UPDATE call_participants SET state = 'joined', joined_at = COALESCE(joined_at, ?) WHERE call_id = ? AND extension = ?")
      .run(now, callId, extension);
    this.extensions.setBusy(call.from_extension, true);
    this.extensions.setBusy(call.to_extension, true);
    this.db.event("call.accepted", { callId, extension }, extension, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  reject(callId: string, extension: string, reason?: string) {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE calls SET state = 'rejected', failure_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(reason ?? "rejected", now, now, callId);
    this.db.sqlite.prepare("UPDATE call_participants SET state = 'rejected', left_at = ? WHERE call_id = ?").run(now, callId);
    this.extensions.setBusy(call.from_extension, false);
    this.extensions.setBusy(call.to_extension, false);
    this.db.event("call.rejected", { callId, extension, reason }, extension, callId, call.session_id ?? undefined);
    this.db.event("call_rejected", { callId, extension, reason }, extension, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  end(callId: string, extension: string, reason?: string) {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE calls SET state = 'ended', failure_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(reason ?? null, now, now, callId);
    this.db.sqlite.prepare("UPDATE call_participants SET state = 'left', left_at = ? WHERE call_id = ?").run(now, callId);
    this.extensions.setBusy(call.from_extension, false);
    this.extensions.setBusy(call.to_extension, false);
    this.db.event("call.ended", { callId, extension, reason: reason ?? null }, extension, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  timeout(callId: string, reason = "timeout") {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE calls SET state = 'timeout', failure_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(reason, now, now, callId);
    this.db.sqlite.prepare("UPDATE call_participants SET state = 'timeout', left_at = ? WHERE call_id = ?").run(now, callId);
    this.extensions.setBusy(call.from_extension, false);
    this.extensions.setBusy(call.to_extension, false);
    this.db.event("call.timeout", { callId, reason }, undefined, callId, call.session_id ?? undefined);
    this.db.event("call_timeout", { callId, reason }, undefined, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  fail(callId: string, reason = "failed") {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE calls SET state = 'failed', failure_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(reason, now, now, callId);
    this.db.sqlite.prepare("UPDATE call_participants SET state = 'failed', left_at = ? WHERE call_id = ?").run(now, callId);
    this.extensions.setBusy(call.from_extension, false);
    this.extensions.setBusy(call.to_extension, false);
    this.db.event("call.failed", { callId, reason }, undefined, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  /** Non-terminal calls an extension is currently part of (caller or callee). */
  activeCallsForExtension(extension: string): string[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT id FROM calls
         WHERE (from_extension = ? OR to_extension = ?)
           AND state NOT IN ('ended','rejected','timeout','failed','missed')`
      )
      .all(extension, extension) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  setState(callId: string, state: CallRecord["state"], actorExtension?: string, metadata: unknown = {}) {
    const call = this.requireCall(callId);
    const now = this.db.now();
    this.db.sqlite.prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?").run(state, now, callId);
    this.db.event(`call.${state}`, { callId, ...((metadata ?? {}) as Record<string, unknown>) }, actorExtension, callId, call.session_id ?? undefined);
    return this.get(callId)!;
  }

  addMessage(callId: string | undefined, sessionId: string | undefined, fromExtension: string, toExtension: string | undefined, role: string, content: string, metadata: unknown = {}) {
    const id = this.db.id("msg");
    this.db.sqlite
      .prepare(
        `INSERT INTO messages
         (id, call_id, session_id, from_extension, to_extension, role, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, callId ?? null, sessionId ?? null, fromExtension, toExtension ?? null, role, content, this.db.json(metadata), this.db.now());
    if (callId) this.db.event("message.created", { messageId: id, role, content }, fromExtension, callId, sessionId);
    return this.db.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  }

  addTranscript(callId: string, fromExtension: string, text: string, isFinal = true, confidence?: number, metadata: unknown = {}) {
    const id = this.db.id("trn");
    this.db.sqlite
      .prepare(
        `INSERT INTO transcripts
         (id, call_id, from_extension, text, is_final, confidence, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, callId, fromExtension, text, isFinal ? 1 : 0, confidence ?? null, this.db.json(metadata), this.db.now());
    this.db.event(isFinal ? "transcript.final" : "transcript.partial", { transcriptId: id, text }, fromExtension, callId);
    return this.db.sqlite.prepare("SELECT * FROM transcripts WHERE id = ?").get(id);
  }

  addAudioTrack(callId: string, participantExtension: string, direction: "inbound" | "outbound", codec: string, bytes: number, metadata: unknown = {}) {
    const id = this.db.id("aud");
    this.db.sqlite
      .prepare(
        `INSERT INTO call_audio_tracks
         (id, call_id, participant_extension, direction, codec, bytes, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, callId, participantExtension, direction, codec, bytes, this.db.json(metadata), this.db.now());
    return this.db.sqlite.prepare("SELECT * FROM call_audio_tracks WHERE id = ?").get(id);
  }

  addTtsOutput(callId: string | undefined, messageId: string | undefined, text: string, model: string, voiceId: string | undefined, format: string, bytes: number, metadata: unknown = {}) {
    const id = this.db.id("tts");
    this.db.sqlite
      .prepare(
        `INSERT INTO tts_outputs
         (id, call_id, message_id, text, model, voice_id, format, bytes, cache_key, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        callId ?? null,
        messageId ?? null,
        text,
        model,
        voiceId ?? null,
        format,
        bytes,
        `${model}:${voiceId ?? "default"}:${text}`,
        this.db.json(metadata),
        this.db.now()
      );
    if (callId) this.db.event("tts.created", { ttsId: id, bytes }, undefined, callId);
    return this.db.sqlite.prepare("SELECT * FROM tts_outputs WHERE id = ?").get(id);
  }

  list() {
    return this.db.sqlite.prepare("SELECT * FROM calls ORDER BY created_at DESC").all() as CallRecord[];
  }

  listMissed(toExtension?: string) {
    if (toExtension) {
      return this.db.sqlite.prepare("SELECT * FROM missed_calls WHERE to_extension = ? ORDER BY created_at DESC").all(toExtension);
    }
    return this.db.sqlite.prepare("SELECT * FROM missed_calls ORDER BY created_at DESC").all();
  }

  get(callId: string) {
    return this.db.sqlite.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as CallRecord | undefined;
  }

  getMessages(callId: string) {
    return this.db.sqlite.prepare("SELECT * FROM messages WHERE call_id = ? ORDER BY created_at").all(callId);
  }

  getTranscripts(callId: string) {
    return this.db.sqlite.prepare("SELECT * FROM transcripts WHERE call_id = ? ORDER BY created_at").all(callId);
  }

  private addParticipant(callId: string, extension: string, role: "caller" | "callee", state: string) {
    this.db.sqlite
      .prepare(
        `INSERT INTO call_participants (id, call_id, extension, role, state, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.id("part"), callId, extension, role, state, role === "caller" ? this.db.now() : null);
  }

  private requireCall(callId: string) {
    const call = this.get(callId);
    if (!call) throw Object.assign(new Error(`call ${callId} not found`), { statusCode: 404 });
    return call;
  }

  private assertAllowedCaller(rawAllowedCallers: string, caller: string) {
    const allowed = this.db.parseJson<string[]>(rawAllowedCallers, []);
    if (allowed.length > 0 && !allowed.includes(caller)) {
      throw Object.assign(new Error(`caller ${caller} is not allowed`), { statusCode: 403 });
    }
  }
}
