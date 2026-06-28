import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../db/database.js";
import { AuthTokenService } from "../auth/authTokens.js";

describe("AuthTokenService", () => {
  let db: AppDatabase;
  let svc: AuthTokenService;

  beforeEach(() => {
    db = new AppDatabase("file::memory:");
    svc = new AuthTokenService(db);
  });

  it("issues a token that verifies and resolves to the agent role", () => {
    const issued = svc.issue({ ownerType: "agent", ownerId: "agent-x", scopes: ["agent", "ext:777"] });
    expect(issued.token.startsWith("agp_")).toBe(true);
    const verified = svc.verify(issued.token);
    expect(verified?.context.role).toBe("agent");
    expect(verified?.context.agentId).toBe("agent-x");
    expect(verified?.context.boundExtension).toBe("777");
    expect(verified?.context.tokenLabel).toBe("agent:agent-x");
  });

  it("returns null for an unknown token", () => {
    expect(svc.verify("agp_does-not-exist")).toBeNull();
  });

  it("returns null after revocation", () => {
    const issued = svc.issue({ ownerType: "agent", ownerId: "agent-y" });
    expect(svc.verify(issued.token)?.context.role).toBe("agent");
    expect(svc.revoke(issued.id)).toBe(true);
    expect(svc.verify(issued.token)).toBeNull();
    // Re-revoke is a no-op.
    expect(svc.revoke(issued.id)).toBe(false);
  });

  it("ignores tokens without the agp_ prefix", () => {
    expect(svc.verify("change-me-agent-token")).toBeNull();
    expect(svc.verify(undefined)).toBeNull();
    expect(svc.verify("")).toBeNull();
  });

  it("never collides across 1000 issuances", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const issued = svc.issue({ ownerType: "agent", ownerId: `agent-${i}` });
      tokens.add(issued.token);
    }
    expect(tokens.size).toBe(1000);
  });

  it("lists tokens for an owner", () => {
    const a = svc.issue({ ownerType: "agent", ownerId: "agent-z" });
    const b = svc.issue({ ownerType: "agent", ownerId: "agent-z" });
    const rows = svc.listByOwner("agent", "agent-z");
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});
