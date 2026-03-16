// Auth middleware for Fastify.
// Extracts the JWT from the `token` httpOnly cookie and attaches
// request.customerId + request.userType so route handlers can access them.
//
// Usage:
//   requireAuth  — throws 401 if no valid JWT
//   optionalAuth — attaches fields if JWT present, no-op otherwise

import type { FastifyRequest, FastifyReply } from "fastify";

// Extend Fastify's request type with our custom fields
declare module "fastify" {
  interface FastifyRequest {
    customerId?: string;
    userType?: "guest" | "customer" | "staff";
  }
}

type DoneCallback = (err?: Error) => void

async function extractAuth(request: FastifyRequest): Promise<void> {
  try {
    // @fastify/jwt decorates server with jwtVerify — call it here
    await (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify();
    const payload = (request as unknown as { user: { sub: string; userType: string } }).user;
    request.customerId = payload.sub;
    request.userType = payload.userType as "guest" | "customer" | "staff";
  } catch {
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
  extractAuth(request).then(() => {
    if (!request.customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
    }
    done();
  }, done);
}

/**
 * preHandler: attaches auth fields if a valid JWT cookie is present.
 * Does nothing if the cookie is absent or invalid.
 *
 * Uses callback style to satisfy Fastify's preHandler type (S6544).
 */
export function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: DoneCallback,
): void {
  extractAuth(request).then(() => done(), done);
}
