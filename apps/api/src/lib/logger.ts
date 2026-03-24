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

export { logger };
export default logger;
