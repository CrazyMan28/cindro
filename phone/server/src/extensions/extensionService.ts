import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { ExtensionOwnerType, ExtensionRecord } from "../types.js";
import { DEMO_EXTENSIONS } from "../setup/defaults.js";

export const ExtensionInputSchema = z.object({
  extension: z.string().regex(/^\d{2,8}$/),
  ownerType: z.enum(["user", "device", "agent", "group"]),
  ownerId: z.string().min(1),
  name: z.string().min(1),
  permissions: z.record(z.unknown()).default({}),
  allowedCallers: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({})
});

export type ExtensionInput = z.infer<typeof ExtensionInputSchema>;

export class ExtensionService {
  constructor(private readonly db: AppDatabase) {}

  create(input: ExtensionInput) {
    const value = ExtensionInputSchema.parse(input);
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO extensions
         (extension, owner_type, owner_id, name, permissions, allowed_callers, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(extension) DO UPDATE SET
           owner_type=excluded.owner_type,
           owner_id=excluded.owner_id,
           name=excluded.name,
           permissions=excluded.permissions,
           allowed_callers=excluded.allowed_callers,
           metadata=excluded.metadata,
           updated_at=excluded.updated_at`
      )
      .run(
        value.extension,
        value.ownerType,
        value.ownerId,
        value.name,
        this.db.json(value.permissions),
        this.db.json(value.allowedCallers),
        this.db.json(value.metadata),
        now,
        now
      );
    this.db.event("extension.upserted", { extension: value.extension, ownerType: value.ownerType }, value.extension);
    return this.get(value.extension)!;
  }

  list() {
    return this.db.sqlite.prepare("SELECT * FROM extensions ORDER BY CAST(extension AS INTEGER), extension").all() as ExtensionRecord[];
  }

  get(extension: string) {
    return this.db.sqlite.prepare("SELECT * FROM extensions WHERE extension = ?").get(extension) as ExtensionRecord | undefined;
  }

  update(
    extension: string,
    fields: Partial<{
      name: string;
      permissions: Record<string, unknown>;
      allowedCallers: string[];
      metadata: Record<string, unknown>;
      ownerType: ExtensionOwnerType;
      ownerId: string;
    }>
  ) {
    const current = this.get(extension);
    if (!current) return undefined;
    const now = this.db.now();
    const next = {
      name: fields.name ?? current.name,
      permissions: fields.permissions ? this.db.json(fields.permissions) : current.permissions,
      allowed_callers: fields.allowedCallers ? this.db.json(fields.allowedCallers) : current.allowed_callers,
      metadata: fields.metadata ? this.db.json(fields.metadata) : current.metadata,
      owner_type: fields.ownerType ?? current.owner_type,
      owner_id: fields.ownerId ?? current.owner_id
    };
    this.db.sqlite
      .prepare(
        `UPDATE extensions
         SET name = ?, permissions = ?, allowed_callers = ?, metadata = ?, owner_type = ?, owner_id = ?, updated_at = ?
         WHERE extension = ?`
      )
      .run(
        next.name,
        next.permissions,
        next.allowed_callers,
        next.metadata,
        next.owner_type,
        next.owner_id,
        now,
        extension
      );
    this.db.event("extension.updated", { extension }, extension);
    return this.get(extension);
  }

  setPresence(extension: string, online: boolean, currentSessionId?: string | null) {
    const now = this.db.now();
    this.db.sqlite
      .prepare("UPDATE extensions SET online = ?, current_session_id = ?, updated_at = ? WHERE extension = ?")
      .run(online ? 1 : 0, currentSessionId ?? null, now, extension);
    this.db.event("presence_update", { extension, online, currentSessionId: currentSessionId ?? null }, extension, undefined, currentSessionId ?? undefined);
    return this.get(extension);
  }

  setBusy(extension: string, busy: boolean) {
    this.db.sqlite
      .prepare("UPDATE extensions SET busy = ?, updated_at = ? WHERE extension = ?")
      .run(busy ? 1 : 0, this.db.now(), extension);
  }

  seedDefaults() {
    return DEMO_EXTENSIONS.map((entry) => this.create(entry));
  }
}
