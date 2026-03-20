/**
 * Shared auth mock factory for route tests.
 *
 * Centralizes the requireAuth / optionalAuth mock implementations so every
 * test file uses the SAME correct pattern.
 *
 * KEY DESIGN DECISION — `return` before `done()` on the 401 path:
 *   The production auth middleware (middleware/auth.ts) must `return` after
 *   sending 401 so the route handler never executes.  The old cart-routes
 *   mock called `done()` unconditionally, replicating the production bug
 *   (SEC-F03) where the route handler runs with `request.customerId`
 *   undefined.  These factories use the async preHandler style (`return
 *   reply.code(401)...`) which short-circuits correctly in Fastify.
 *
 * Usage in vi.mock():
 *
 *   import { createRequireAuthMock, createOptionalAuthMock } from "./helpers/auth-mock.js";
 *
 *   vi.mock("../middleware/auth.js", () => ({
 *     requireAuth: createRequireAuthMock("cust_123"),
 *     optionalAuth: createOptionalAuthMock("cust_123"),
 *   }));
 *
 * Or, when customerId changes across tests, use a mutable ref:
 *
 *   let customerId: string | undefined = "cust_123";
 *   vi.mock("../middleware/auth.js", () => ({
 *     requireAuth: createRequireAuthMock(() => customerId),
 *   }));
 */

import type { FastifyRequest, FastifyReply } from "fastify";

type CustomerIdSource = string | (() => string | undefined);

function resolveCustomerId(source: CustomerIdSource): string | undefined {
  return typeof source === "function" ? source() : source;
}

/**
 * Creates a mock Fastify preHandler that enforces authentication.
 *
 * - Reads `x-customer-id` header (falls back to the provided customerId).
 * - On 401: sends the response AND returns immediately — the route handler
 *   will NOT execute.  This matches the correct production behavior.
 * - On success: sets `request.customerId`.
 *
 * @param customerId - A fixed customer ID string, or a function that returns
 *   the current ID (useful when tests mutate the value between cases).
 */
export function createRequireAuthMock(customerId: CustomerIdSource) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const headerCid = request.headers["x-customer-id"] as string | undefined;
    const cid = headerCid ?? resolveCustomerId(customerId);

    if (!cid) {
      // IMPORTANT: `return` here prevents the route handler from executing.
      // The old cart-routes mock omitted this return, replicating the
      // production auth bypass bug (SEC-F03).
      return reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticacao necessaria." });
    }

    request.customerId = cid;
  };
}

/**
 * Creates a mock Fastify preHandler for optional authentication.
 *
 * - Sets `request.customerId` if available, but never rejects.
 * - Safe for public endpoints that optionally personalize responses.
 *
 * @param customerId - A fixed customer ID string, or a function that returns
 *   the current ID.  Pass `undefined` to simulate unauthenticated access.
 */
export function createOptionalAuthMock(customerId?: CustomerIdSource) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const headerCid = request.headers["x-customer-id"] as string | undefined;
    const cid = headerCid ?? (customerId ? resolveCustomerId(customerId) : undefined);

    if (cid) {
      request.customerId = cid;
    }
  };
}
