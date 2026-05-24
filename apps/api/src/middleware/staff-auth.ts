// DOM-001: Staff authorization middleware.
//
// Usage:
//   requireStaff       — 401 if not authenticated, 403 if not a staff member
//   requireManager     — same as requireStaff, plus 403 if role is ATTENDANT
//   requireManagerRole — JWT or API-key route gate; MANAGER+ required
//   requireOwnerRole   — JWT or API-key route gate; OWNER required (P1-H)
//
// These are preHandlers — attach them to route config:
//   { preHandler: [optionalAuth, requireStaff] }
//
// Note: extractAuth (from auth.ts) must run first to populate request.staffId.
//
// ── W4 P1-H — fail-closed API-key role registry ──────────────────────────
//
// Pre-W4 `requireManagerRole` was a no-op for API-key callers (it only
// applied when a staff JWT was present). Any process holding
// ADMIN_API_KEY had unbounded mutation power. Audit 05 §S2.
//
// W4 introduces an API-key role registry. The admin guard at
// `routes/admin/index.ts` reads `ADMIN_API_KEY_ROLES_JSON` from env at
// startup, validates the incoming `x-admin-key` against the registry
// with `timingSafeEqual`, and sets `request.adminApiKeyRole` if a
// match is found. The role gates below now fail-closed when neither a
// JWT role nor an API-key registry role is present.

import type { FastifyRequest, FastifyReply } from "fastify";

// Extend Fastify's request type with the API-key role decoration.
declare module "fastify" {
  interface FastifyRequest {
    /**
     * Role inferred from a matched API-key registry entry. Set by the
     * admin guard at `routes/admin/index.ts` after timing-safe compare
     * against `ADMIN_API_KEY_ROLES_JSON`. Undefined for JWT-only paths
     * or for API keys not present in the registry.
     */
    adminApiKeyRole?: "OWNER" | "MANAGER";
  }
}

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

/**
 * Role gate for mutation routes that are reachable via staff JWT OR
 * API key. W4 P1-H change: API-key callers MUST have a role mapped in
 * `ADMIN_API_KEY_ROLES_JSON`; an unmapped API key fails-closed (403).
 *
 * - Staff JWT path: enforces OWNER or MANAGER role.
 * - API-key path (no JWT): enforces `request.adminApiKeyRole ∈
 *   {OWNER, MANAGER}` — set by the admin guard from the registry.
 * - Neither: 403.
 */
export function requireManagerRole(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  // JWT path — same role check as before.
  if (request.staffId) {
    if (!["OWNER", "MANAGER"].includes(request.staffRole ?? "")) {
      void reply
        .code(403)
        .send({ statusCode: 403, error: "Forbidden", message: "Acesso restrito a gerentes." });
      return;
    }
    done();
    return;
  }
  // API-key path — must have a registry-mapped role.
  if (request.adminApiKeyRole === "OWNER" || request.adminApiKeyRole === "MANAGER") {
    done();
    return;
  }
  // P1-H — fail-closed. An API key without a registry entry, OR no
  // auth at all, is refused at this gate even though the outer admin
  // guard accepted the key as authentic.
  void reply
    .code(403)
    .send({
      statusCode: 403,
      error: "Forbidden",
      message: "Acesso restrito a gerentes — chave de API sem permissão suficiente.",
    });
}

/**
 * P1-H — OWNER-only gate. Mirrors requireManagerRole but requires the
 * OWNER role specifically. Used by routes that must NEVER be reachable
 * with a MANAGER-mapped API key.
 *
 * - Staff JWT path: enforces OWNER role.
 * - API-key path: enforces `request.adminApiKeyRole === "OWNER"`.
 * - Neither: 403.
 */
export function requireOwnerRole(
  request: FastifyRequest,
  reply: FastifyReply,
  done: DoneCallback,
): void {
  if (request.staffId) {
    if (request.staffRole !== "OWNER") {
      void reply
        .code(403)
        .send({ statusCode: 403, error: "Forbidden", message: "Acesso restrito ao proprietário." });
      return;
    }
    done();
    return;
  }
  if (request.adminApiKeyRole === "OWNER") {
    done();
    return;
  }
  void reply
    .code(403)
    .send({
      statusCode: 403,
      error: "Forbidden",
      message: "Acesso restrito ao proprietário — chave de API sem permissão suficiente.",
    });
}
