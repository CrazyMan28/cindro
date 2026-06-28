import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import SQLite from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type SqliteDatabase = SQLite.Database;

export class AppDatabase {
  readonly sqlite: SqliteDatabase;

  constructor(databaseUrl: string) {
    const filename = sqliteFilename(databaseUrl);
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.sqlite = new SQLite(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    // The DB holds every conversation, transcript, and memory — keep it
    // owner-only. Covers the WAL/SHM sidecars too (best-effort: they may not
    // exist yet on a fresh open).
    if (filename !== ":memory:" && !filename.startsWith("file::memory:")) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.chmodSync(`${filename}${suffix}`, 0o600); } catch { /* sidecar not created yet */ }
      }
    }
    this.migrate();
  }

  migrate() {
    for (const statement of SCHEMA_SQL) {
      this.sqlite.exec(statement);
    }
    this.ensureColumn("agents", "capabilities", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("agents", "last_heartbeat_at", "TEXT");
    // Group chats: a thread can have N participant extensions (a real multi-party
    // conversation). Empty array = normal 1:1 thread.
    this.ensureColumn("message_threads", "members", "TEXT NOT NULL DEFAULT '[]'");
    // Tombstones for user-deleted threads: a late agent reply (or replayed
    // queued message) carrying a deleted thread_id used to re-CREATE the
    // conversation the user just deleted.
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS deleted_threads (id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)");
  }

  close() {
    this.sqlite.close();
  }

  now() {
    return new Date().toISOString();
  }

  id(prefix: string) {
    return `${prefix}_${randomUUID()}`;
  }

  json(value: unknown) {
    return JSON.stringify(value ?? {});
  }

  parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  event(type: string, payload: Record<string, unknown>, actorExtension?: string, callId?: string, sessionId?: string) {
    this.sqlite
      .prepare(
        `INSERT INTO events (id, type, actor_extension, call_id, session_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.id("evt"), type, actorExtension ?? null, callId ?? null, sessionId ?? null, this.json(payload), this.now());
  }

  audit(action: string, options: { actor?: string; target?: string; success?: boolean; ip?: string; metadata?: unknown } = {}) {
    this.sqlite
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, target, success, ip, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.id("audit"),
        options.actor ?? null,
        action,
        options.target ?? null,
        options.success === false ? 0 : 1,
        options.ip ?? null,
        this.json(options.metadata ?? {}),
        this.now()
      );
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function sqliteFilename(databaseUrl: string) {
  if (databaseUrl === ":memory:" || databaseUrl === "file::memory:") return ":memory:";
  if (databaseUrl.startsWith("file:")) return databaseUrl.slice("file:".length);
  return databaseUrl;
}
