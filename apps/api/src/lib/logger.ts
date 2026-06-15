// Standalone pino logger for non-request contexts (jobs, subscribers, startup).
// Request handlers should use request.log (Fastify's child logger with reqId).

import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

/**
 * Creates a child logger with a correlationId bound to every log entry.
 * Use in NATS subscribers to propagate tracing context from event payloads.
 */
// Accept any logger-like object (pino.Logger, FastifyBaseLogger, etc.)
type LoggerLike = { info: (...args: unknown[]) => void; child?: (bindings: Record<string, unknown>) => unknown }

export function withCorrelation(
  baseLog: LoggerLike | null | undefined,
  correlationId?: string | null,
): pino.Logger {
  if (!baseLog) return logger;
  if (!correlationId) return baseLog as pino.Logger;
  return (baseLog as pino.Logger).child({ correlationId });
}

export { logger };
export default logger;
