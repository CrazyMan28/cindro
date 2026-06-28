import { z } from "zod";
import type { AppDatabase } from "../db/database.js";

export {
  AGENT_PHONE_EVENT_TYPES,
  AGENT_PHONE_MEMORY_TAGS,
  type AgentPhoneEventType,
  type AgentPhoneMemoryTag
} from "./eventTypes.js";

const MemorySchema = z.object({
  scope: z.string().min(1),
  key: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([])
});

export class MemoryService {
  constructor(private readonly db: AppDatabase) {}

  createSession(agentId: string | undefined, repoPath: string | undefined, task: string | undefined) {
    const id = this.db.id("sess");
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, repo_path, task, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(id, agentId ?? null, repoPath ?? null, task ?? null, now, now);
    this.db.event("session.created", { sessionId: id, agentId, repoPath, task }, undefined, undefined, id);
    return this.getSession(id)!;
  }

  getSession(id: string) {
    return this.db.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  }

  listSessions() {
    return this.db.sqlite.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all();
  }

  appendSessionEvent(sessionId: string, eventType: string, content: string, metadata: unknown = {}) {
    const id = this.db.id("ctx");
    this.db.sqlite
      .prepare(
        `INSERT INTO session_context (id, session_id, event_type, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, eventType, content, this.db.json(metadata), this.db.now());
    this.db.event("session.event", { sessionId, eventType, content }, undefined, undefined, sessionId);
    return this.db.sqlite.prepare("SELECT * FROM session_context WHERE id = ?").get(id);
  }

  getSessionContext(sessionId: string, limit = 50) {
    const events = this.db.sqlite
      .prepare("SELECT * FROM session_context WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit);
    const messages = this.db.sqlite
      .prepare(
        `SELECT id, thread_id, call_id, from_extension, to_extension, title, body, priority, status, created_at
         FROM agent_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(sessionId, Math.min(limit, 20));
    return { events, messages };
  }

  storeMemory(input: z.infer<typeof MemorySchema>) {
    const value = MemorySchema.parse(input);
    const id = this.db.id("mem");
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO memories (id, scope, key, content, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, value.scope, value.key, value.content, this.db.json(value.tags), now, now);
    this.db.event("memory.stored", { memoryId: id, scope: value.scope, key: value.key });
    return this.db.sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  }

  searchMemory(query: string, limit = 10) {
    const like = `%${query}%`;
    return this.db.sqlite
      .prepare(
        `SELECT * FROM memories
         WHERE key LIKE ? OR content LIKE ? OR tags LIKE ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(like, like, like, limit);
  }

  summarizeSession(sessionId: string) {
    const events = (this.db.sqlite
      .prepare("SELECT * FROM session_context WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, 20) as Array<{ event_type: string; content: string }>).reverse();
    const content =
      events.length === 0
        ? "No session events recorded yet."
        : events.map((entry) => `[${entry.event_type}] ${entry.content}`).join("\n").slice(0, 4000);
    const id = this.db.id("sum");
    this.db.sqlite
      .prepare("INSERT INTO summaries (id, session_id, content, created_at) VALUES (?, ?, ?, ?)")
      .run(id, sessionId, content, this.db.now());
    this.db.sqlite.prepare("UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?").run(content, this.db.now(), sessionId);
    return { id, sessionId, content };
  }

  summarizeCall(callId: string) {
    const messages = this.db.sqlite
      .prepare("SELECT role, from_extension, content FROM messages WHERE call_id = ? ORDER BY created_at")
      .all(callId) as Array<{ role: string; from_extension: string; content: string }>;
    const transcripts = this.db.sqlite
      .prepare("SELECT from_extension, text FROM transcripts WHERE call_id = ? ORDER BY created_at")
      .all(callId) as Array<{ from_extension: string; text: string }>;
    const content = [...messages.map((m) => `${m.from_extension}/${m.role}: ${m.content}`), ...transcripts.map((t) => `${t.from_extension}/transcript: ${t.text}`)]
      .join("\n")
      .slice(0, 4000);
    const id = this.db.id("sum");
    this.db.sqlite.prepare("INSERT INTO summaries (id, call_id, content, created_at) VALUES (?, ?, ?, ?)").run(id, callId, content || "No call content recorded.", this.db.now());
    return { id, callId, content: content || "No call content recorded." };
  }

  getCallSummary(callId: string) {
    const existing = this.db.sqlite
      .prepare("SELECT * FROM summaries WHERE call_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(callId);
    return existing ?? this.summarizeCall(callId);
  }

  getSessionCalls(sessionId: string) {
    return this.db.sqlite.prepare("SELECT * FROM calls WHERE session_id = ? ORDER BY created_at DESC").all(sessionId);
  }

  getLatestAgentContext(agentId: string) {
    const session = this.db.sqlite
      .prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(agentId) as { id?: string } | undefined;
    const agent = this.db.sqlite.prepare("SELECT extension FROM agents WHERE id = ?").get(agentId) as { extension?: string } | undefined;
    const messages = agent?.extension
      ? this.db.sqlite
          .prepare(
            `SELECT id, thread_id, call_id, from_extension, to_extension, title, body, priority, status, created_at
             FROM agent_messages WHERE from_extension = ? OR to_extension = ?
             ORDER BY created_at DESC LIMIT 20`
          )
          .all(agent.extension, agent.extension)
      : [];
    const recentMemories = this.db.sqlite
      .prepare(`SELECT * FROM memories WHERE tags LIKE '%agent-phone%' ORDER BY updated_at DESC LIMIT 10`)
      .all();
    if (!session?.id) return { agentId, session: null, context: { events: [], messages: [] }, messages, recentMemories };
    return {
      agentId,
      session,
      context: this.getSessionContext(session.id, 50),
      calls: this.getSessionCalls(session.id),
      messages,
      recentMemories
    };
  }
}
