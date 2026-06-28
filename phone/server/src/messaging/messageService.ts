import { z } from "zod";
import type { AppDatabase } from "../db/database.js";

export type MessagePriority = "low" | "normal" | "urgent" | "critical";
export type MessageStatus = "queued" | "delivered" | "read" | "replied" | "expired";
export type ParticipantType = "agent" | "device" | "system";

export type MessageRow = {
  id: string;
  thread_id: string;
  session_id: string | null;
  call_id: string | null;
  from_extension: string;
  to_extension: string;
  from_type: ParticipantType;
  to_type: ParticipantType;
  title: string;
  body: string;
  priority: MessagePriority;
  status: MessageStatus;
  requires_response: number;
  response_options: string;
  response_text: string | null;
  selected_option: string | null;
  metadata: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  expires_at: string | null;
};

export type ThreadRow = {
  id: string;
  subject: string;
  related_agent_id: string | null;
  related_extension: string | null;
  latest_message_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  members: string;
};

export const CreateMessageSchema = z.object({
  from_extension: z.string().min(1),
  to_extension: z.string().min(1),
  from_type: z.enum(["agent", "device", "system"]).default("agent"),
  to_type: z.enum(["agent", "device", "system"]).default("device"),
  title: z.string().min(1),
  body: z.string().default(""),
  priority: z.enum(["low", "normal", "urgent", "critical"]).default("normal"),
  requires_response: z.boolean().default(false),
  response_options: z.array(z.string()).default([]),
  session_id: z.string().optional(),
  call_id: z.string().optional(),
  thread_id: z.string().optional(),
  subject: z.string().optional(),
  related_agent_id: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  expires_at: z.string().optional()
});
export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;

export const ReplyInputSchema = z.object({
  response_text: z.string().optional(),
  selected_option: z.string().optional()
});
export type ReplyInput = z.infer<typeof ReplyInputSchema>;

export class MessageService {
  constructor(private readonly db: AppDatabase) {}

  createMessage(input: CreateMessageInput): MessageRow {
    const value = CreateMessageSchema.parse(input);
    // A write into a DELETED thread must not resurrect it — a late agent reply
    // used to re-create the conversation the user had just deleted.
    if (value.thread_id && this.isThreadDeleted(value.thread_id)) {
      throw Object.assign(new Error("thread was deleted by the user"), { statusCode: 410 });
    }
    const now = this.db.now();
    const subject = value.subject ?? (value.call_id ? `call:${value.call_id}` : value.title);
    const relatedExtension = value.to_extension;
    const thread = value.thread_id
      ? this.getThread(value.thread_id) ?? this.createThread(subject, relatedExtension, value.related_agent_id, now)
      : this.findOrCreateThread(subject, relatedExtension, value.related_agent_id, now);

    // EVERY message in a group thread is uniformly marked, regardless of entry
    // path. Agent replies arrive via notify_user with bare metadata — without
    // this stamp, a relayed agent→agent message routed by the server was then
    // DROPPED by the receiving adapter's "agent texts only count in groups"
    // guard, silently breaking "Claude, tell Codex X".
    let metadata = value.metadata;
    const members = this.db.parseJson<string[]>((thread as { members?: string }).members ?? "[]", []);
    if (members.length > 1 && !(metadata as Record<string, unknown>).group_thread) {
      metadata = { ...(metadata as Record<string, unknown>), group_thread: thread.id, group_members: members };
    }

    const id = this.db.id("amsg");
    this.db.sqlite
      .prepare(
        `INSERT INTO agent_messages (
          id, thread_id, session_id, call_id,
          from_extension, to_extension, from_type, to_type,
          title, body, priority, status,
          requires_response, response_options, response_text, selected_option,
          metadata, created_at, delivered_at, read_at, replied_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        id,
        thread.id,
        value.session_id ?? null,
        value.call_id ?? null,
        value.from_extension,
        value.to_extension,
        value.from_type,
        value.to_type,
        value.title,
        value.body,
        value.priority,
        value.requires_response ? 1 : 0,
        this.db.json(value.response_options),
        this.db.json(metadata),
        now,
        value.expires_at ?? null
      );

    this.touchThread(thread.id, now);
    const row = this.requireMessage(id);
    this.recordEvent("message_sent", row);
    return row;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.sqlite.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  /** Delete a whole conversation (its messages + the thread row). */
  deleteThread(threadId: string): boolean {
    const msgs = this.db.sqlite.prepare("DELETE FROM agent_messages WHERE thread_id = ?").run(threadId);
    const thread = this.db.sqlite.prepare("DELETE FROM message_threads WHERE id = ?").run(threadId);
    // Tombstone so a late agent reply / replayed message carrying this thread
    // id can never resurrect the conversation the user just deleted.
    this.db.sqlite
      .prepare("INSERT OR REPLACE INTO deleted_threads (id, deleted_at) VALUES (?, ?)")
      .run(threadId, this.db.now());
    // Prune ancient tombstones (anything still referencing a month-old thread
    // id is a bug, not a late reply).
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.sqlite.prepare("DELETE FROM deleted_threads WHERE deleted_at < ?").run(cutoff);
    return (msgs.changes ?? 0) > 0 || (thread.changes ?? 0) > 0;
  }

  /** True when this thread was deleted by the user (late writes must be dropped). */
  isThreadDeleted(threadId: string): boolean {
    return Boolean(this.db.sqlite.prepare("SELECT 1 FROM deleted_threads WHERE id = ?").get(threadId));
  }

  /** Start a brand-new conversation: always a fresh thread, then the first message. */
  startConversation(input: CreateMessageInput): MessageRow {
    const value = CreateMessageSchema.parse(input);
    const now = this.db.now();
    const subject = value.subject ?? value.title;
    const thread = this.createThread(subject, value.to_extension, value.related_agent_id, now);
    return this.createMessage({ ...value, thread_id: thread.id, subject });
  }

  private requireMessage(id: string): MessageRow {
    const row = this.getMessage(id);
    if (!row) {
      throw Object.assign(new Error(`message ${id} not found after write`), { statusCode: 500, code: "message_missing_after_write" });
    }
    return row;
  }

  getThread(id: string): ThreadRow | undefined {
    return this.db.sqlite.prepare("SELECT * FROM message_threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  listMessages(filter: { thread_id?: string; extension?: string; status?: MessageStatus; limit?: number }) {
    const limit = filter.limit ?? 100;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.thread_id) {
      clauses.push("thread_id = ?");
      params.push(filter.thread_id);
    }
    if (filter.extension) {
      clauses.push("(from_extension = ? OR to_extension = ?)");
      params.push(filter.extension, filter.extension);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.db.sqlite
      .prepare(`SELECT * FROM agent_messages ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as MessageRow[];
  }

  listThreads(filter: { extension?: string; status?: string; limit?: number }) {
    const limit = filter.limit ?? 50;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.extension) {
      clauses.push("related_extension = ?");
      params.push(filter.extension);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.db.sqlite
      .prepare(`SELECT * FROM message_threads ${where} ORDER BY latest_message_at DESC LIMIT ?`)
      .all(...params) as ThreadRow[];
  }

  getPendingForExtension(extension: string, limit = 50): MessageRow[] {
    return this.db.sqlite
      .prepare(
        `SELECT * FROM agent_messages
         WHERE to_extension = ? AND status IN ('queued', 'delivered')
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(extension, limit) as MessageRow[];
  }

  markDelivered(id: string): MessageRow | undefined {
    const row = this.getMessage(id);
    if (!row) return undefined;
    if (["read", "replied", "expired"].includes(row.status)) return row;
    const now = this.db.now();
    this.db.sqlite
      .prepare(`UPDATE agent_messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`)
      .run(now, id);
    const updated = this.requireMessage(id);
    this.recordEvent("message_delivered", updated);
    return updated;
  }

  /** Direct messages that never reached this extension (strictly 'queued'). */
  getQueuedForExtension(extension: string, limit = 50): MessageRow[] {
    return this.db.sqlite
      .prepare(
        `SELECT * FROM agent_messages
         WHERE to_extension = ? AND status = 'queued'
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(extension, limit) as MessageRow[];
  }

  /**
   * Tail run of agent-authored messages in a thread (excluding `excludeId`,
   * the message being routed). Used to cap agent↔agent relay chains in group
   * chats: when agents keep addressing each other, the chain dies after
   * MAX_AGENT_CHAIN until a human speaks.
   */
  consecutiveAgentTail(threadId: string, excludeId: string): number {
    const rows = this.db.sqlite
      .prepare(
        `SELECT from_type FROM agent_messages
         WHERE thread_id = ? AND id != ?
         ORDER BY created_at DESC LIMIT 12`
      )
      .all(threadId, excludeId) as Array<{ from_type: string }>;
    let run = 0;
    for (const row of rows) {
      if (row.from_type !== "agent") break;
      run += 1;
    }
    return run;
  }

  /** Per-recipient delivery receipts for group messages (kept in metadata). */
  deliveredTo(row: MessageRow): string[] {
    const meta = this.db.parseJson<Record<string, unknown>>(row.metadata, {});
    return Array.isArray(meta.delivered_to) ? (meta.delivered_to as string[]) : [];
  }

  /** Record that one group member received this message. */
  markDeliveredTo(id: string, extension: string): MessageRow | undefined {
    const row = this.getMessage(id);
    if (!row) return undefined;
    const meta = this.db.parseJson<Record<string, unknown>>(row.metadata, {});
    const list = Array.isArray(meta.delivered_to) ? (meta.delivered_to as string[]) : [];
    if (list.includes(extension)) return row;
    meta.delivered_to = [...list, extension];
    this.db.sqlite.prepare("UPDATE agent_messages SET metadata = ? WHERE id = ?").run(this.db.json(meta), id);
    return this.getMessage(id);
  }

  /**
   * Group-thread messages fanned out while this member had no live socket.
   * A group message stays 'queued' (its to_extension is the broadcast group),
   * so per-member receipts in metadata.delivered_to decide who still needs it.
   * Capped to the last 24h — replaying a week-old group conversation at a
   * reconnecting agent produces a burst of stale replies, not catch-up.
   */
  queuedGroupMessagesFor(extension: string, limit = 50): MessageRow[] {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.sqlite
      .prepare(
        `SELECT m.* FROM agent_messages m
         JOIN message_threads t ON t.id = m.thread_id
         WHERE t.members LIKE ? AND m.from_extension != ? AND m.status = 'queued' AND m.created_at >= ?
         ORDER BY m.created_at ASC LIMIT ?`
      )
      .all(`%"${extension}"%`, extension, cutoff, limit) as MessageRow[];
    return rows.filter((m) => !this.deliveredTo(m).includes(extension));
  }

  markRead(id: string): MessageRow | undefined {
    const row = this.getMessage(id);
    if (!row) return undefined;
    if (row.status === "replied" || row.status === "expired") return row;
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `UPDATE agent_messages
         SET status = 'read',
             delivered_at = COALESCE(delivered_at, ?),
             read_at = COALESCE(read_at, ?)
         WHERE id = ?`
      )
      .run(now, now, id);
    const updated = this.requireMessage(id);
    this.recordEvent("message_read", updated);
    return updated;
  }

  replyToMessage(id: string, reply: ReplyInput): { original: MessageRow; reply: MessageRow } | undefined {
    const parsed = ReplyInputSchema.parse(reply);
    // Wrap the check-and-set + reply insert in a single transaction so the whole
    // operation is atomic. The guard below (issue #16) rejects a second reply to
    // an already-replied message — this is what stops a double-submit (double-tap,
    // phone + browser, or an agent retry) from creating two reply rows. Note: the
    // original issue framed this as an async interleave; better-sqlite3 is fully
    // synchronous so two calls never truly interleave, but with no already-replied
    // guard a *sequential* double-submit still produced duplicate replies.
    return this.db.transaction(() => {
      const original = this.getMessage(id);
      if (!original) return undefined;
      if (original.status === "replied") return undefined; // already answered — reject duplicate (issue #16)
      if (this.enforceExpiry(original)) return undefined; // expired deadline — reject stale reply (issue #14)
      const now = this.db.now();
      const result = this.db.sqlite
        .prepare(
          `UPDATE agent_messages
           SET status = 'replied',
               delivered_at = COALESCE(delivered_at, ?),
               read_at = COALESCE(read_at, ?),
               replied_at = ?,
               response_text = ?,
               selected_option = ?
           WHERE id = ? AND status != 'replied'`
        )
        .run(now, now, now, parsed.response_text ?? null, parsed.selected_option ?? null, id);
      // Defensive: if another writer won the race the UPDATE matches 0 rows.
      if ((result.changes ?? 0) === 0) return undefined;
      const updated = this.requireMessage(id);

      const replyBody = parsed.response_text ?? parsed.selected_option ?? "";
      const replyRow = this.createMessage({
        thread_id: original.thread_id,
        session_id: original.session_id ?? undefined,
        call_id: original.call_id ?? undefined,
        from_extension: original.to_extension,
        to_extension: original.from_extension,
        from_type: original.to_type,
        to_type: original.from_type,
        title: `Re: ${original.title}`,
        body: replyBody,
        priority: original.priority,
        requires_response: false,
        response_options: [],
        metadata: { kind: "reply", reply_to: id, selected_option: parsed.selected_option ?? null }
      });

      this.recordEvent("message_replied", updated, { reply_message_id: replyRow.id, selected_option: parsed.selected_option ?? null });
      return { original: updated, reply: replyRow };
    });
  }

  /**
   * Issue #14: a message whose `expires_at` has passed must not accept replies and
   * should be flipped to `expired`. Returns true if the row was (or already is)
   * expired. Only deadlines that exist and are in the past count — rows without an
   * `expires_at`, or still-open messages, never expire here.
   */
  private enforceExpiry(row: MessageRow): boolean {
    if (row.status === "expired") return true;
    if (!row.expires_at) return false;
    if (Date.parse(row.expires_at) > Date.now()) return false;
    if (["queued", "delivered", "read"].includes(row.status)) {
      this.db.sqlite.prepare(`UPDATE agent_messages SET status = 'expired' WHERE id = ?`).run(row.id);
    }
    return true;
  }

  /**
   * Issue #14: bulk-mark any past-deadline messages as expired. Meant to be run on
   * a timer so deadlines are enforced even if no one reads the message. Returns the
   * number of rows transitioned.
   */
  expireDueMessages(): number {
    const result = this.db.sqlite
      .prepare(
        `UPDATE agent_messages
         SET status = 'expired'
         WHERE status IN ('queued', 'delivered', 'read')
           AND expires_at IS NOT NULL
           AND expires_at < ?`
      )
      .run(this.db.now());
    return result.changes ?? 0;
  }

  setExpired(id: string): MessageRow | undefined {
    const row = this.getMessage(id);
    if (!row) return undefined;
    if (["read", "replied", "expired"].includes(row.status)) return row;
    this.db.sqlite.prepare(`UPDATE agent_messages SET status = 'expired' WHERE id = ?`).run(id);
    return this.getMessage(id);
  }

  recentForExtension(extension: string, limit = 20): MessageRow[] {
    return this.db.sqlite
      .prepare(
        `SELECT * FROM agent_messages
         WHERE from_extension = ? OR to_extension = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(extension, extension, limit) as MessageRow[];
  }

  recentForSession(sessionId: string, limit = 20): MessageRow[] {
    return this.db.sqlite
      .prepare(`SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, limit) as MessageRow[];
  }

  recentForCall(callId: string, limit = 20): MessageRow[] {
    return this.db.sqlite
      .prepare(`SELECT * FROM agent_messages WHERE call_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(callId, limit) as MessageRow[];
  }

  private findOrCreateThread(subject: string, relatedExtension: string, relatedAgentId: string | undefined, now: string): ThreadRow {
    const existing = this.db.sqlite
      .prepare(`SELECT * FROM message_threads WHERE related_extension = ? AND subject = ? AND status = 'open' LIMIT 1`)
      .get(relatedExtension, subject) as ThreadRow | undefined;
    if (existing) return existing;
    return this.createThread(subject, relatedExtension, relatedAgentId, now);
  }

  /** Create a multi-party group thread (a real shared conversation). */
  createGroupThread(subject: string, members: string[], relatedExtension: string): ThreadRow {
    const now = this.db.now();
    const id = this.db.id("thr");
    this.db.sqlite
      .prepare(
        `INSERT INTO message_threads (id, subject, related_agent_id, related_extension, latest_message_at, status, created_at, updated_at, members)
         VALUES (?, ?, NULL, ?, ?, 'open', ?, ?, ?)`
      )
      .run(id, subject, relatedExtension, now, now, now, this.db.json(members));
    return this.getThread(id)!;
  }

  /** Participant extensions of a thread ([] for a normal 1:1 thread). */
  threadMembers(threadId: string): string[] {
    const row = this.getThread(threadId);
    if (!row) return [];
    return this.db.parseJson<string[]>(row.members ?? "[]", []);
  }

  private createThread(subject: string, relatedExtension: string, relatedAgentId: string | undefined, now: string): ThreadRow {
    const id = this.db.id("thr");
    this.db.sqlite
      .prepare(
        `INSERT INTO message_threads (id, subject, related_agent_id, related_extension, latest_message_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(id, subject, relatedAgentId ?? null, relatedExtension, now, now, now);
    return this.getThread(id)!;
  }

  private touchThread(threadId: string, now: string) {
    this.db.sqlite
      .prepare(`UPDATE message_threads SET latest_message_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, threadId);
  }

  private recordEvent(eventType: string, row: MessageRow, extra: Record<string, unknown> = {}) {
    const payload = {
      message_id: row.id,
      thread_id: row.thread_id,
      session_id: row.session_id,
      call_id: row.call_id,
      from_extension: row.from_extension,
      to_extension: row.to_extension,
      priority: row.priority,
      status: row.status,
      title: row.title,
      ...extra
    };
    this.db.event(eventType, payload, row.from_extension, row.call_id ?? undefined, row.session_id ?? undefined);
    if (row.session_id) {
      this.db.sqlite
        .prepare(
          `INSERT INTO session_context (id, session_id, event_type, content, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(this.db.id("ctx"), row.session_id, eventType, row.title, this.db.json(payload), this.db.now());
    }
  }
}
