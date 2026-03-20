import * as Sentry from "@sentry/node";
import { buildServer } from "./server.js";
import { startNoShowChecker, stopNoShowChecker } from "./jobs/no-show-checker.js";
import { startReviewPromptPoller, stopReviewPromptPoller } from "./jobs/review-prompt-poller.js";
import { startAbandonedCartChecker, stopAbandonedCartChecker } from "./jobs/abandoned-cart-checker.js";
import { startReservationReminder, stopReservationReminder } from "./jobs/reservation-reminder.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { closeNatsConnection, setOutboxWriter } from "@ibatexas/nats-client";
import { closeRedisClient, getRedisClient } from "@ibatexas/tools";
import { prisma } from "@ibatexas/domain";
import { initWhatsAppSender } from "./whatsapp/init.js";
import { startOutboxRetry, stopOutboxRetry } from "./jobs/outbox-retry.js";

// Initialize Sentry before anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? "development",
  });
}
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

  // Graceful shutdown: stop jobs, drain NATS, close Fastify, close Redis, disconnect Prisma
  const shutdown = async (): Promise<void> => {
    stopNoShowChecker();
    stopReviewPromptPoller();
    stopAbandonedCartChecker();
    stopReservationReminder();
    stopOutboxRetry();
    await closeNatsConnection();
    await server.close();
    await closeRedisClient();
    await prisma.$disconnect();
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
      // Inject Redis client as outbox writer for critical NATS events
      try {
        const redis = await getRedisClient();
        setOutboxWriter(redis);
      } catch (err) {
        server.log.warn({ error: String(err) }, "[startup] Failed to set outbox writer — outbox disabled");
      }

      // Register subscribers BEFORE starting jobs to prevent race condition
      await startCartIntelligenceSubscribers(server.log);

      startReservationReminder();
      startNoShowChecker();
      startReviewPromptPoller(server.log);
      startAbandonedCartChecker(server.log);

      startOutboxRetry(server.log);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
