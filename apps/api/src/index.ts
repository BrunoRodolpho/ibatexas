import * as Sentry from "@sentry/node";
import { buildServer } from "./server.js";
import { startNoShowChecker, stopNoShowChecker } from "./jobs/no-show-checker.js";
import { startReviewPromptPoller, stopReviewPromptPoller } from "./jobs/review-prompt-poller.js";
import { startAbandonedCartChecker, stopAbandonedCartChecker } from "./jobs/abandoned-cart-checker.js";
// AUDIT-FIX: INFRA-08 — Import reservation-reminder job (was defined but never started)
import { startReservationReminder, stopReservationReminder } from "./jobs/reservation-reminder.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { closeNatsConnection, setOutboxWriter } from "@ibatexas/nats-client";
// AUDIT-FIX: INFRA-05 — Import closeRedisClient and prisma for graceful shutdown
import { closeRedisClient, getRedisClient } from "@ibatexas/tools";
import { prisma } from "@ibatexas/domain";
import { initWhatsAppSender } from "./whatsapp/init.js";
// AUDIT-FIX: EVT-F01 — outbox retry job for critical NATS events
import { startOutboxRetry, stopOutboxRetry } from "./jobs/outbox-retry.js";

// Initialize Sentry before anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? "development",
  });
}
// AUDIT-FIX: INFRA-11 — Warn if Sentry is not configured in production (errors will be silently dropped)
if (process.env.NODE_ENV === "production" && !process.env.SENTRY_DSN) {
  console.warn("[startup] SENTRY_DSN not set — errors will not be reported to Sentry");
}

process.on("unhandledRejection", (reason) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  console.error("[uncaughtException]", err);
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3001);

const start = async (): Promise<void> => {
  const server = await buildServer();

  // AUDIT-FIX: INFRA-05 — Graceful shutdown: close all connections in correct order
  // 1. Stop background jobs, 2. Drain NATS, 3. Close Fastify, 4. Close Redis, 5. Disconnect Prisma
  const shutdown = async (): Promise<void> => {
    stopNoShowChecker();
    stopReviewPromptPoller();
    stopAbandonedCartChecker();
    stopReservationReminder(); // AUDIT-FIX: INFRA-08
    stopOutboxRetry(); // AUDIT-FIX: EVT-F01
    await closeNatsConnection();
    await server.close();
    await closeRedisClient();        // AUDIT-FIX: INFRA-05
    await prisma.$disconnect();      // AUDIT-FIX: INFRA-05
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    // Initialize WhatsApp sender (before background jobs that may send notifications)
    initWhatsAppSender();
    // Start background jobs and NATS subscribers after server is listening
    if (process.env.NODE_ENV !== "test") {
      // AUDIT-FIX: EVT-F01 — Inject Redis client as outbox writer for critical NATS events
      try {
        const redis = await getRedisClient();
        setOutboxWriter(redis);
      } catch (err) {
        server.log.warn({ error: String(err) }, "[startup] Failed to set outbox writer — outbox disabled");
      }

      // AUDIT-FIX: EVT-F07 — Register subscribers BEFORE starting jobs to prevent race condition.
      // Jobs fire events immediately on startup; subscribers must be listening first.
      await startCartIntelligenceSubscribers(server.log);

      // AUDIT-FIX: INFRA-08 — Start reservation-reminder job (was never started)
      startReservationReminder();
      startNoShowChecker();
      startReviewPromptPoller(server.log);
      startAbandonedCartChecker(server.log);

      // AUDIT-FIX: EVT-F01 — Start outbox retry job (polls every 60s for undelivered critical events)
      startOutboxRetry(server.log);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
