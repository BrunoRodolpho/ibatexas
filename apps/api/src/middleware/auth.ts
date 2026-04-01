// Auth middleware for Fastify.
// Extracts the JWT from the `token` httpOnly cookie and attaches
// request.customerId + request.userType so route handlers can access them.
//
// Usage:
//   requireAuth  — throws 401 if no valid JWT
//   optionalAuth — attaches fields if JWT present, no-op otherwise

import type { FastifyRequest, FastifyReply } from "fastify";
import { getRedisClient, rk } from "@ibatexas/tools";

// Extend Fastify's request type with our custom fields
declare module "fastify" {
  interface FastifyRequest {
    customerId?: string;
    userType?: "guest" | "customer" | "staff";
    /** DOM-001: Staff-specific fields (set when userType === "staff") */
    staffId?: string;
    staffRole?: "OWNER" | "MANAGER" | "ATTENDANT";
  }
}

type DoneCallback = (err?: Error) => void

class RedisUnavailableError extends Error {
  constructor() {
    super("Redis revocation check unavailable");
    this.name = "RedisUnavailableError";
  }
}

async function extractAuth(request: FastifyRequest): Promise<void> {
  try {
    // @fastify/jwt decorates server with jwtVerify — call it here
    await (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify();
    const payload = (request as unknown as { user: { sub: string; userType: string; jti?: string; role?: string } }).user;

    // SEC-004: Check if the token has been revoked (e.g., after logout)
    if (payload.jti) {
      try {
        const redis = await getRedisClient();
        const revoked = await redis.get(rk(`jwt:revoked:${payload.jti}`));
        if (revoked) return; // Treat revoked token as unauthenticated
      } catch {
        // SEC: Fail closed — if Redis is unreachable, reject the request
        // to prevent revoked tokens from being accepted
        throw new RedisUnavailableError();
      }
    }

    request.userType = payload.userType as "guest" | "customer" | "staff";

    // DOM-001: Staff tokens carry staffId (sub) + role; customer tokens carry customerId (sub)
    if (payload.userType === "staff") {
      request.staffId = payload.sub;
      request.staffRole = payload.role as "OWNER" | "MANAGER" | "ATTENDANT";
    } else {
      request.customerId = payload.sub;
    }
  } catch (err) {
    // SEC: Redis failure must propagate — do not silently accept potentially revoked tokens
    if (err instanceof RedisUnavailableError) throw err;
    // Invalid or missing JWT — caller decides whether to throw
  }
}

/**
 * preHandler: requires a valid JWT cookie.
 * Returns 401 if missing or invalid.
 *
 * Uses callback style to satisfy Fastify's preHandler type (S6544).
 */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  // Return before done() on 401 to prevent route handler from executing
  extractAuth(request).then(() => {
    if (!request.customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
      return;
    }
    done();
  }, (err) => {
    if (err instanceof RedisUnavailableError) {
      void reply
        .code(503)
        .send({ error: "Service temporarily unavailable" });
      return;
    }
    done(err);
  });
}

/**
 * preHandler: attaches auth fields if a valid JWT cookie is present.
 * Does nothing if the cookie is absent or invalid.
 *
 * Uses callback style to satisfy Fastify's preHandler type (S6544).
 */
export function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  extractAuth(request).then(() => done(), (err) => {
    if (err instanceof RedisUnavailableError) {
      void reply
        .code(503)
        .send({ error: "Service temporarily unavailable" });
      return;
    }
    done(err);
  });
}
