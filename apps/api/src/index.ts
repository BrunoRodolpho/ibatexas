import * as Sentry from "@sentry/node";
import { closeNatsConnection, setOutboxWriter } from "@ibatexas/nats-client";
import { closeRedisClient, getRedisClient } from "@ibatexas/tools";
import { prisma, createScheduleService } from "@ibatexas/domain";
import { buildServer } from "./server.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { startHandoffSubscriber } from "./subscribers/handoff-subscriber.js";
import { startConversationArchiver } from "./subscribers/conversation-archiver.js";
import { startPaymentLifecycleSubscriber } from "./subscribers/payment-lifecycle.js";
import { initWhatsAppSender } from "./whatsapp/init.js";
import { registerWorkers, shutdownWorkers } from "./jobs/register-workers.js";
import logger from "./lib/logger.js";

// Initialize Sentry before anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? "development",
  });
}
if (process.env.NODE_ENV === "production" && !process.env.SENTRY_DSN) {
  logger.warn("[startup] SENTRY_DSN not set — errors will not be reported to Sentry");
}

process.on("unhandledRejection", (reason) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
  logger.error({ err: reason }, "[unhandledRejection]");
});

process.on("uncaughtException", (err) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  logger.fatal({ err }, "[uncaughtException]");
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3001);

const start = async (): Promise<void> => {
  const server = await buildServer();

  // Graceful shutdown: stop BullMQ workers, drain NATS, close Fastify, close Redis, disconnect Prisma
  const shutdown = async (): Promise<void> => {
    await shutdownWorkers();
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
    // Seed schedule from env vars if table is empty (no-op if rows exist)
    try {
      const scheduleSvc = createScheduleService();
      await scheduleSvc.seedFromEnv();
    } catch (err) {
      server.log.warn({ error: String(err) }, "[startup] Schedule seed failed — run 'ibx db migrate:domain'");
    }

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
      await startHandoffSubscriber(server.log);
      await startConversationArchiver(server.log);
      await startPaymentLifecycleSubscriber(server.log);

      // Start all BullMQ background workers
      registerWorkers(server.log);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
