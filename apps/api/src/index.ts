import * as Sentry from "@sentry/node";
import { closeNatsConnection, setOutboxWriter } from "@ibatexas/nats-client";
import { closeRedisClient, getRedisClient } from "@ibatexas/tools";
import { prisma, createScheduleService } from "@ibatexas/domain";
import { buildServer } from "./server.js";
import { bootstrapKernel } from "./plugins/kernel-bootstrap.js";
import { bootstrapAuditSinkDI } from "./audit-sink-bootstrap.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { startHandoffSubscriber } from "./subscribers/handoff-subscriber.js";
import { startConversationArchiver } from "./subscribers/conversation-archiver.js";
import { startPaymentLifecycleSubscriber } from "./subscribers/payment-lifecycle.js";
import { startDeferResolverSubscriber } from "./subscribers/defer-resolver.js";
import { startAnonymizeGraceResolverSubscriber } from "./subscribers/anonymize-grace-resolver.js";
import { startPixDeferTimeoutResolverSubscriber } from "./subscribers/pix-defer-timeout-resolver.js";
import { startAuditConsumer } from "./subscribers/audit-consumer.js";
import { createResumeDispatcherAdapter } from "./adapters/resume-dispatcher.js";
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

  // Bootstrap the @adjudicate/core kernel: install MetricsSink slot,
  // validate IBX_KERNEL_SHADOW/IBX_KERNEL_ENFORCE for typos, and (post
  // task 08) register the orders Pack via installPack. Runs after
  // Sentry init (so any future PackConformanceError surfaces in
  // Sentry) but before server.listen so a failed conformance check
  // prevents serving traffic. See
  // docs/adjudicate-migration/tasks/01-kernel-bootstrap-plugin.md.
  await bootstrapKernel(server);

  // audit-2026-05-24 H2 (A1): register the audit-sink leaf's boot-time
  // DI BEFORE subscribers / routes / workers fire. Post-H2, `getAuditSink()`
  // lives in `@ibatexas/audit-sink` (zero-dep leaf) and is fail-closed —
  // any wrapper-call site that runs before this bootstrap throws
  // `AuditSinkNotInitializedError`. Must run AFTER `bootstrapKernel`
  // (which calls `installKernelMetricsSink` to populate the hook
  // state read by `buildAuditSinkDependencies`).
  await bootstrapAuditSinkDI(server.log);

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
      // [task 03] defer-resolver wired after payment-lifecycle so the lifecycle
      // subscriber has already settled the payment row before defer-resolver
      // re-executes the parked envelope. See docs/adjudicate-migration/tasks/03-*.
      //
      // NEW-P0-X1 fix: pass the resume-intent dispatcher as an explicit
      // parameter so it is wired BEFORE the NATS subscription becomes
      // live. Pre-fix the dispatcher was wired ~19 lines later via
      // `setResumeIntentDispatcher(...)`, leaving a boot-window where a
      // PIX webhook would silently mark a parked envelope as resumed
      // without dispatching the intent — silent data loss on every cold
      // boot for in-flight PIX confirmations.
      await startDeferResolverSubscriber(server.log, {
        dispatcher: createResumeDispatcherAdapter({ log: server.log }),
      });
      // [task 14] LGPD anonymize 24h grace resolver — consumes
      // `intent.defer.timeout` for the customer.anonymize signal and runs
      // `anonymizeCustomer` if no cancel-deletion arrived within the
      // window. Wired alongside the defer-resolver so both subscribe to
      // the timeout fan-out from `defer-timeout-sweeper`.
      await startAnonymizeGraceResolverSubscriber(server.log);
      // [audit-2026-05-24 P1-7] PIX defer-timeout audit bridge. Consumes
      // `intent.defer.timeout` filtered for the PIX confirmation signal
      // and emits a `payment.pix.timeout.audit` audit record so the
      // decision log chains `DEFER (park) → defer_timeout` for parked
      // PIX checkouts whose customer never paid. Actual DB-side payment
      // status transition is owned by the pix-expiry-checker cron.
      await startPixDeferTimeoutResolverSubscriber(server.log);
      // [task 19] M4 audit-postgres redundancy consumer. Subscribes to
      // `audit.intent.decision.v1` and writes records durably to Postgres
      // — decoupled-archiver pattern. Always-on per IBX-IGE v3.0 cutover
      // (CLAUDE.md rule #9); pairs with the in-process Postgres sink
      // composed by `intent-audit-wiring.ts`.
      await startAuditConsumer(server.log);

      // Start all BullMQ background workers
      registerWorkers(server.log);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// P0-6: installPack fail-fast wiring. `start()` invokes `bootstrapKernel`
// which can throw `PackConformanceError` synchronously. Without an explicit
// `.catch()`, the rejection only reached `unhandledRejection` (Sentry capture
// + log) but the process never exited — subscribers never started, no traffic
// served, yet the pod looked "alive" to a bare `node` orchestrator. Wrap with
// an explicit catch so bootstrap failures exit non-zero. Sentry still captures
// via the catch flow (Sentry.captureException is invoked before exit).
start().catch((err) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  logger.fatal({ err }, "[fatal] startup error");
  process.exit(1);
});
