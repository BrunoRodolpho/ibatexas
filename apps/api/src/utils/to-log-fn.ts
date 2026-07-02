// Fastify request.log → LogFn adapter (shared).
//
// The incident/no-delivery seams (incident-auto-close, no-delivery) accept a
// plain `LogFn` ({ info, warn, error }), NOT a Pino logger. The admin routes that
// drive those seams (admin/incidents.ts + admin/escalations.ts) each hand-built
// the SAME 3-line adapter object inline; this is the ONE copy. Behaviour is
// byte-identical to the inlined form (`(...a) => request.log.X(a[0], a[1])`).

import type { FastifyRequest } from "fastify";
import type { LogFn } from "../conversation/no-delivery.js";

/** Adapt a Fastify `request.log` (Pino) into the plain {@link LogFn} shape. */
export function toLogFn(request: FastifyRequest): LogFn {
  return {
    info: (...a) => request.log.info(a[0] as object, a[1] as string),
    warn: (...a) => request.log.warn(a[0] as object, a[1] as string),
    error: (...a) => request.log.error(a[0] as object, a[1] as string),
  };
}
