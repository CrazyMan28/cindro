import { createHash, randomBytes } from "node:crypto";
import type { AppDatabase } from "../db/database.js";
import type { AuthContext, AuthRole } from "../types.js";

export type AuthTokenOwnerType = "agent" | "device" | "user" | "service";

export type AuthTokenRow = {
  id: string;
  owner_type: AuthTokenOwnerType;
  owner_id: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
};

export type IssuedToken = {
  id: string;
  /** The full bearer token (`agp_…`). Shown ONCE; the server only stores the SHA-256 hash. */
  token: string;
  ownerType: AuthTokenOwnerType;
  ownerId: string;
  scopes: string[];
  createdAt: string;
};

export type VerifyResult = {
  context: AuthContext;
  row: AuthTokenRow;
} | null;

const TOKEN_PREFIX = "agp_";

/**
 * Per-owner bearer tokens stored as SHA-256 hashes in `auth_tokens`. The full
 * token is returned by `issue()` exactly once; subsequent verifications hash
 * the presented value and look it up. Tokens may carry scopes; for agent
 * enrollment we use `["agent", "ext:<extension>"]` so an issued token is
 * bound to a single extension at WS auth time.
 */
export class AuthTokenService {
  constructor(private readonly db: AppDatabase) {}

  issue(input: { ownerType: AuthTokenOwnerType; ownerId: string; scopes?: string[] }): IssuedToken {
    const id = this.db.id("authtok");
    const secret = randomBytes(32).toString("base64url");
    const token = `${TOKEN_PREFIX}${secret}`;
    const hash = sha256(token);
    const scopes = input.scopes ?? [];
    const now = this.db.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO auth_tokens (id, owner_type, owner_id, token_hash, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(id, input.ownerType, input.ownerId, hash, this.db.json(scopes), now);
    this.db.event("auth.token.issued", { tokenId: id, ownerType: input.ownerType, ownerId: input.ownerId });
    return { id, token, ownerType: input.ownerType, ownerId: input.ownerId, scopes, createdAt: now };
  }

  verify(token: string | undefined): VerifyResult {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const row = this.db.sqlite
      .prepare("SELECT * FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hash) as AuthTokenRow | undefined;
    if (!row) return null;
    const scopes = this.db.parseJson<string[]>(row.scopes, []);
    const boundExtension = extractExtensionScope(scopes);
    const role = roleFromOwnerType(row.owner_type);
    if (!role) return null;
    return {
      row,
      context: {
        role,
        tokenLabel: `${row.owner_type}:${row.owner_id}`,
        agentId: row.owner_type === "agent" ? row.owner_id : undefined,
        boundExtension
      }
    };
  }

  revoke(id: string): boolean {
    const result = this.db.sqlite
      .prepare("UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.db.now(), id);
    if (result.changes > 0) {
      this.db.event("auth.token.revoked", { tokenId: id });
      return true;
    }
    return false;
  }

  listByOwner(ownerType: AuthTokenOwnerType, ownerId: string): AuthTokenRow[] {
    return this.db.sqlite
      .prepare("SELECT * FROM auth_tokens WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC")
      .all(ownerType, ownerId) as AuthTokenRow[];
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roleFromOwnerType(ownerType: AuthTokenOwnerType): AuthRole | undefined {
  switch (ownerType) {
    case "agent": return "agent";
    case "device": return "device";
    case "user": return "device";
    case "service": return "admin";
    default: return undefined;
  }
}

function extractExtensionScope(scopes: string[]): string | undefined {
  for (const scope of scopes) {
    if (scope.startsWith("ext:")) return scope.slice("ext:".length);
  }
  return undefined;
}
