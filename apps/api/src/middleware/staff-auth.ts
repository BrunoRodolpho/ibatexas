// DOM-001: Staff authorization middleware.
//
// Usage:
//   requireStaff   — 401 if not authenticated, 403 if not a staff member
//   requireManager — same as requireStaff, plus 403 if role is ATTENDANT
//
// These are preHandlers — attach them to route config:
//   { preHandler: [optionalAuth, requireStaff] }
//
// Note: extractAuth (from auth.ts) must run first to populate request.staffId.

import type { FastifyRequest, FastifyReply } from "fastify";

type DoneCallback = (err?: Error) => void;

/**
 * Requires a valid staff JWT. Returns 403 if the token belongs to a customer
 * or if staffId/staffRole are not set.
 */
export function requireStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  if (!request.staffId || !request.staffRole) {
    void reply
      .code(403)
      .send({ statusCode: 403, error: "Forbidden", message: "Acesso restrito a funcionários." });
    return;
  }
  done();
}

/**
 * Requires a staff JWT with OWNER or MANAGER role.
 * Returns 403 if the staff member is an ATTENDANT.
 */
export function requireManager(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  if (!request.staffId || !request.staffRole) {
    void reply
      .code(403)
      .send({ statusCode: 403, error: "Forbidden", message: "Acesso restrito a funcionários." });
    return;
  }
  if (!["OWNER", "MANAGER"].includes(request.staffRole)) {
    void reply
      .code(403)
      .send({ statusCode: 403, error: "Forbidden", message: "Acesso restrito a gerentes." });
    return;
  }
  done();
}
