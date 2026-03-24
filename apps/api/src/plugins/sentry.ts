import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";

export async function registerSentry(server: FastifyInstance): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    server.log.warn("SENTRY_DSN not set — Sentry disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || "development",
    tracesSampleRate: 0.1,
  });

  server.addHook("onError", (_request, _reply, error, done) => {
    Sentry.captureException(error);
    done();
  });
}
