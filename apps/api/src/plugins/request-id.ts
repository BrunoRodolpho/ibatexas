// Request ID plugin — distributed tracing via x-request-id header.
//
// 1. Reads `x-request-id` from incoming request or generates a new UUID
// 2. Attaches the ID to Fastify's built-in `request.id` via genReqId
// 3. Tags the Sentry scope so errors correlate with the originating request
// 4. Echoes `x-request-id` in the response for client-side correlation
//
// Registration: call registerRequestId(server) directly in buildServer.
// genReqId is set at server construction time (passed to Fastify constructor).

import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import * as Sentry from "@sentry/node";

const HEADER = "x-request-id";

/**
 * Generate or reuse a request ID.
 * Used as Fastify's `genReqId` — called once per incoming request.
 * Takes IncomingMessage (raw Node.js request), not FastifyRequest.
 */
export function genRequestId(request: IncomingMessage): string {
  const clientId = request.headers[HEADER];
  if (typeof clientId === "string" && clientId.length > 0 && clientId.length <= 128) {
    return clientId;
  }
  return crypto.randomUUID();
}

/**
 * Register request-ID hooks on the server instance.
 *
 * Adds hooks directly (not via plugin encapsulation) so they apply to all routes.
 * NOTE: `genReqId` must be passed to the Fastify constructor separately.
 */
export function registerRequestId(server: FastifyInstance): void {
  // Tag Sentry scope on every request so captured errors include the request ID
  server.addHook("onRequest", (_request, _reply, done) => {
    Sentry.getCurrentScope().setTag("requestId", _request.id);
    done();
  });

  // Echo request ID back to the client
  server.addHook("onSend", (_request, reply, _payload, done) => {
    void reply.header(HEADER, _request.id);
    done();
  });
}
