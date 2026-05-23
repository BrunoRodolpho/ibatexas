// logger.ts — pino-shaped logger interface for llm-provider modules.
//
// Per audit/06-reliability-fail-open.md §"Logging consistency" (P2-C)
// and audit/08 §"Top 20" item #20: every failure in @ibatexas/llm-provider
// today calls `console.warn` / `console.error` directly, dropping the
// `reqId` correlation that pino+fastify provide. This causes diagnosis
// across requests to require manual grep-correlation between log lines
// that share no identifier.
//
// This module defines the minimal pino-compatible surface llm-provider
// callers need (a `warn` and `error` method, both pino-style: object
// payload first, message string second). The default passthrough
// logger uses `console.warn`/`console.error` to preserve current dev
// behavior; production callers (apps/api) pass `req.log` to get the
// reqId-carrying pino logger.
//
// Pino's runtime shape: `log.warn({ err, ctx }, "message")`. Our
// interface mirrors that contract so a `req.log` can be passed
// directly with no adapter.

/**
 * Minimum pino-compatible surface used by llm-provider. Both `req.log`
 * (fastify-bound pino) and the default passthrough below satisfy this.
 */
export interface IbxLogger {
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  info?(obj: Record<string, unknown> | string, msg?: string): void;
  debug?(obj: Record<string, unknown> | string, msg?: string): void;
}

/**
 * Default passthrough logger. Writes to console.warn / console.error
 * with a `[ibx-llm-provider]` prefix so log lines remain identifiable
 * during local dev without a real pino transport.
 *
 * Production callers should pass `req.log` instead — that carries the
 * `reqId` correlation key from `@fastify/request-id` so any line a
 * responder emits during a request is grepable by reqId.
 */
export const defaultLogger: IbxLogger = {
  warn(obj, msg) {
    if (typeof obj === "string") {
      console.warn("[ibx-llm-provider]", obj);
    } else if (msg !== undefined) {
      console.warn("[ibx-llm-provider]", msg, obj);
    } else {
      console.warn("[ibx-llm-provider]", obj);
    }
  },
  error(obj, msg) {
    if (typeof obj === "string") {
      console.error("[ibx-llm-provider]", obj);
    } else if (msg !== undefined) {
      console.error("[ibx-llm-provider]", msg, obj);
    } else {
      console.error("[ibx-llm-provider]", obj);
    }
  },
  info(obj, msg) {
    if (typeof obj === "string") {
      console.log("[ibx-llm-provider]", obj);
    } else if (msg !== undefined) {
      console.log("[ibx-llm-provider]", msg, obj);
    } else {
      console.log("[ibx-llm-provider]", obj);
    }
  },
};

/**
 * Resolve a logger. If `provided` is truthy AND has `warn` + `error`
 * methods (the load-bearing surface), use it; otherwise fall back to
 * the default passthrough.
 *
 * This guards against callers passing an undefined/null logger
 * (common during test setup) — the resolver always returns a usable
 * logger.
 */
export function resolveLogger(provided?: IbxLogger | null): IbxLogger {
  if (
    provided &&
    typeof provided.warn === "function" &&
    typeof provided.error === "function"
  ) {
    return provided;
  }
  return defaultLogger;
}
