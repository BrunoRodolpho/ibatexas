// Shared pino multistream wiring for the api log path (observability Layer 3).
//
// When VICTORIALOGS_URL is set (the obs stack is up — see
// docker-compose.observability.yml), every api log line is fanned out to TWO
// sinks via pino.multistream:
//   1. raw pino JSON  → VictoriaLogs (failure-isolated; never blocks a turn —
//      see victorialogs-stream.ts)
//   2. human-readable → stdout (pino-pretty in dev, raw JSON in prod)
//
// When VICTORIALOGS_URL is unset the helpers return null and callers keep their
// existing single-stream (transport) config — so a dev without the obs stack is
// unaffected. This is the single place that decides "ship logs or not"; both the
// standalone logger (lib/logger.ts) and the Fastify server logger (server.ts)
// build on it so their behaviour stays in lockstep.

import pino from "pino";
import pretty from "pino-pretty";
import { createVictoriaLogsStream } from "./victorialogs-stream.js";

/** The configured VictoriaLogs base URL, or undefined when the obs stack is off. */
export function victoriaLogsUrl(): string | undefined {
  const u = process.env.VICTORIALOGS_URL?.trim();
  return u || undefined;
}

/**
 * Shared root pino options for the multistream (→ VictoriaLogs) path. The single
 * place both the standalone logger (lib/logger.ts) and the Fastify server logger
 * configure signal quality, so they stay in lockstep:
 *  - `base: { component: "api" }` — the VL insert pins `_stream_fields=component,event`,
 *    so a line with no `component` lands in the shared empty `{}` stream and VMUI
 *    can't slice it. A base binding gives EVERY line a default stream; per-log
 *    `{ component: "..." }` objects (conductor/kernel/whatsapp/job.*) still override
 *    it via pino's last-key-wins. This also drops pino's default `{pid,hostname}`.
 *  - `formatters.level` — ship the level NAME ("info"/"warn"/"error") not the raw
 *    number, so `level:error` LogsQL filters work. Safe here because these are
 *    main-thread streams, NOT a worker `transport` (pino forbids `formatters`
 *    alongside `transport` — never add this to the transport-fallback branch).
 *  - `redact` — defense-in-depth for secret-named fields. Free-text PII (message
 *    bodies, completions) is scrubbed at the call site via the turn_trace redactor,
 *    NOT here (path-based redact can't reach free prose). `token` is deliberately
 *    NOT redacted — it is a non-secret approval idempotency handle in this codebase.
 */
export const MULTISTREAM_PINO_OPTIONS = {
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { component: "api" },
  formatters: { level: (label: string) => ({ level: label }) },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "password",
      "*.password",
      "otp",
      "*.otp",
      "secret",
      "*.secret",
      "phone",
      "*.phone",
    ],
    censor: "[REDACTED]",
  },
} satisfies pino.LoggerOptions;

/** Build a pino multistream fanning raw JSON → VictoriaLogs and human-readable
 *  → stdout. Returns null when VICTORIALOGS_URL is unset (callers fall back to
 *  their existing single-stream config). The VictoriaLogs stream is
 *  failure-isolated, so a logs outage degrades to "stdout only", never a stall. */
export function buildLogStreams(): pino.MultiStreamRes | null {
  const url = victoriaLogsUrl();
  if (!url) return null;
  const isProd = process.env.NODE_ENV === "production";
  // pino-pretty's factory defaults its destination to stdout (fd 1).
  const human = isProd ? process.stdout : pretty({ colorize: true });
  return pino.multistream([
    { stream: createVictoriaLogsStream(url) }, // raw pino JSON → VictoriaLogs
    { stream: human }, // human-readable → stdout
  ]);
}

/** A fully-built pino instance over the multistream (ISO timestamps so the
 *  VictoriaLogs `_time_field=time` stream parses correctly), or null when the
 *  obs stack is off. Used as Fastify's `loggerInstance`. */
export function buildMultistreamLogger(): pino.Logger | null {
  const streams = buildLogStreams();
  if (!streams) return null;
  return pino(MULTISTREAM_PINO_OPTIONS, streams);
}
