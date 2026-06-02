// Standalone pino logger for non-request contexts (jobs, subscribers, startup,
// the kernel MetricsSink). Request handlers should use request.log (Fastify's
// child logger with reqId).
//
// One structured stream, fanned out via pino.multistream:
//   - terminal: pino-pretty (colorized by level) in dev, raw JSON in prod
//   - VictoriaLogs: raw JSON shipped to the log store when VICTORIALOGS_URL is
//     set (failure-isolated — see observability/victorialogs-stream.ts)
// Both the dev pretty render and the VictoriaLogs shipping run as main-thread
// streams (not worker transports) so they load cleanly under tsx in dev.

import pino from "pino";
import pretty from "pino-pretty";
import { createVictoriaLogsStream } from "../observability/victorialogs-stream.js";

const LEVEL = process.env.LOG_LEVEL || "info";

/**
 * Build the log destinations shared by the standalone logger and the Fastify
 * request logger. ISO `time` + `_stream_fields` tagging keep VictoriaLogs
 * ingestion uniform across both.
 */
export function buildLogStreams(): pino.StreamEntry[] {
  const streams: pino.StreamEntry[] = [];

  if (process.env.NODE_ENV !== "production") {
    streams.push({
      level: LEVEL as pino.Level,
      stream: pretty({ colorize: true }) as unknown as NodeJS.WritableStream,
    });
  } else {
    streams.push({ level: LEVEL as pino.Level, stream: process.stdout });
  }

  const vlUrl = process.env.VICTORIALOGS_URL;
  if (vlUrl) {
    streams.push({ level: LEVEL as pino.Level, stream: createVictoriaLogsStream(vlUrl) });
  }

  return streams;
}

const logger = pino(
  { level: LEVEL, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream(buildLogStreams()),
);

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
