import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import type { AuthContext, AuthRole } from "../types.js";
import { AuthTokenService } from "./authTokens.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function extractBearer(header: string | undefined) {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

export function authenticateToken(config: AppConfig, token: string | undefined, db?: AppDatabase): AuthContext | undefined {
  if (!token) return undefined;
  if (safeEqual(token, config.auth.adminToken)) return { role: "admin", tokenLabel: "admin" };
  if (safeEqual(token, config.auth.deviceToken)) return { role: "device", tokenLabel: "device" };
  if (safeEqual(token, config.auth.agentToken)) return { role: "agent", tokenLabel: "agent" };
  // Per-owner tokens issued via /api/agents/enroll (or future device/service tokens).
  if (db) {
    const result = new AuthTokenService(db).verify(token);
    if (result) return result.context;
  }
  return undefined;
}

export function requireHttpAuth(config: AppConfig, db: AppDatabase, roles: AuthRole[] = ["admin", "device", "agent"]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(request.headers.authorization);
    const auth = authenticateToken(config, token, db);
    if (!auth || !roles.includes(auth.role)) {
      db.audit("auth.failure", {
        success: false,
        ip: request.ip,
        target: request.routeOptions.url,
        metadata: { requiredRoles: roles }
      });
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.auth = auth;
  };
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
