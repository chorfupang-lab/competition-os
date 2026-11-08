import type { FastifyRequest } from "fastify";
import { AppError } from "@cos/core";

export const SESSION_COOKIE = "cos_session";

export interface AuthInfo {
  userId: string;
  sessionId: string;
  platformAdmin: boolean;
  viaCookie: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export function requireAuth(request: FastifyRequest): AuthInfo {
  if (!request.auth) throw new AppError("UNAUTHENTICATED");
  return request.auth;
}

export function requirePlatformAdmin(request: FastifyRequest): AuthInfo {
  const auth = requireAuth(request);
  if (!auth.platformAdmin) throw new AppError("FORBIDDEN");
  return auth;
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return null;
}
