import * as Sentry from "@sentry/node";
import { closeNatsConnection, ensureStreams, getNatsConnection, setOutboxWriter, setDlqHandler } from "@ibatexas/nats-client";
import { closeRedisClient, getRedisClient } from "@ibatexas/tools";
import { pushToDlq } from "./subscribers/dlq.js";
import { prisma, createScheduleService } from "@ibatexas/domain";
import { buildServer } from "./server.js";
import { bootstrapKernel } from "./plugins/kernel-bootstrap.js";
import { bootstrapAuditSinkDI } from "./audit-sink-bootstrap.js";
import { bootstrapLearningSinkDI } from "./learning-sink-bootstrap.js";
import { bootstrapClaustrum } from "./claustrum-bootstrap.js";
import { startCartIntelligenceSubscribers } from "./subscribers/cart-intelligence.js";
import { startIngredientDepletionSubscriber } from "./subscribers/ingredient-depletion.js";
import { startHandoffSubscriber } from "./subscribers/handoff-subscriber.js";
import { startIncidentSubscriber } from "./subscribers/incident-subscriber.js";
import { startIncidentNotificationSubscriber } from "./subscribers/incident-notification-subscriber.js";
import { startConversationArchiver } from "./subscribers/conversation-archiver.js";
import { startPaymentLifecycleSubscriber } from "./subscribers/payment-lifecycle.js";
import { startDeferResolverSubscriber } from "./subscribers/defer-resolver.js";
import { startAnonymizeGraceResolverSubscriber } from "./subscribers/anonymize-grace-resolver.js";
import { startCustomerAnonymizeMedusaResolverSubscriber } from "./subscribers/customer-anonymize-medusa-resolver.js";
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

  // ERDS-060 — register the learning-sink leaf's boot-time DI at the SAME boot
  // point as the audit sink, before subscribers / routes / workers (and the
  // managed-agent plane) fire. Unlike the audit sink this is fail-OPEN: a
  // missing Redis/NATS arm degrades to a no-op `getLearningSink()`, never a
  // throw — learning telemetry must never gate a turn.
  await bootstrapLearningSinkDI(server.log);

  // WS7 — bootstrap the claustrum Conductor ALONGSIDE the kernel bootstrap.
  // `getConductor()` then returns the live process singleton so the chat +
  // WhatsApp turn-entry routes run through the @claustrum/* cognitive loop
  // (planner → adjudicate → dispatch → respond), with every mutation gated by
  // the @adjudicate/* kernel (one intent_audit row before each side-effect).
  //
  // Boot-order reconciliation (do NOT reorder):
  //   1. buildServer() → installKernelMetricsSink()  — the PRODUCTION kernel
  //      MetricsSink (PostHog/Sentry/Prometheus) + the audit-lag/dedup/spill
  //      recorder hooks that subscribers + jobs depend on.
  //   2. bootstrapKernel(server)                     — installFirstPartyPacks +
  //      pack-coverage + audit-postgres preflight (kept; NOT removed).
  //   3. bootstrapAuditSinkDI(server.log)            — audit-sink leaf DI.
  //   4. bootstrapClaustrum()                        — composes the conductor.
  //
  // Double-init is safe: bootstrapClaustrum internally re-runs
  // bootstrapAuditSinkDI (idempotent — REPLACES the deps with the same values
  // and resets the cached sink, per its docstring) and re-runs installPack
  // (a stateless conformance check, not a registry mutation — install.js
  // returns the wrapped pack and mutates no global). It will NOT overwrite the
  // production MetricsSink from step 1: it guards on `hasMetricsSink()` and
  // only installs its observability-only sink when none is present (i.e. when
  // claustrum is bootstrapped standalone). The WS5 resume-intent dispatcher is
  // already wired below via `startDeferResolverSubscriber({ dispatcher })`.
  await bootstrapClaustrum();
  server.log.info("[startup] claustrum Conductor bootstrapped and live");

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
    // Start background jobs and NATS subscribers after server is listening.
    //
    // T1a-13: the NODE_ENV=test guard exists for UNIT-test processes (vitest
    // imports server.ts, never this entrypoint) — but the JOURNEY test stack
    // (T1a-11a env contract) also boots with NODE_ENV=test, and skipping the
    // subscribers there silently breaks production parity: order.placed never
    // projects (cart-intelligence), payment lifecycle never settles, defer
    // resolvers never fire — surfaced by the first JOURNEY-001 live run (no
    // order_projections row after a successful checkout). The ephemeral test
    // profile is identified by IBX_TEST_FINGERPRINT (D-010: ONLY .env.test
    // carries it), so subscribers/jobs run whenever we are NOT a bare
    // NODE_ENV=test process OR we ARE the fingerprinted journey stack.
    if (process.env.NODE_ENV !== "test" || process.env.IBX_TEST_FINGERPRINT) {
      // Inject Redis client as outbox writer for critical NATS events
      try {
        const redis = await getRedisClient();
        setOutboxWriter(redis);
      } catch (err) {
        server.log.warn({ error: String(err) }, "[startup] Failed to set outbox writer — outbox disabled");
      }

      // Route unhandled subscriber-loop errors to the DLQ (+ Sentry) instead of
      // dropping them in the nats-client's bare console.error (P1-ERR-NATSLOOP).
      // nats-client can't import pushToDlq directly (package → app), so inject it.
      setDlqHandler((event, payload, error) =>
        pushToDlq(event, payload, error, server.log),
      );

      // JetStream provisioning (at-least-once migration, Phase 0). Flag-gated:
      // when NATS_JETSTREAM_ENABLED=true, ensure the durable streams exist
      // BEFORE any subscriber attaches. Additive + fail-soft — it does NOT
      // change Core NATS delivery, and a provisioning error must not abort boot
      // (subscribers keep working on Core NATS). See
      // ~/projects/jetstream-at-least-once-plan.md.
      if (process.env.NATS_JETSTREAM_ENABLED === "true") {
        try {
          const nc = await getNatsConnection();
          const { added, updated } = await ensureStreams(nc);
          server.log.info({ added, updated }, "[startup] JetStream streams ensured");
        } catch (err) {
          server.log.error(
            { error: String(err) },
            "[startup] JetStream stream provisioning failed (continuing on Core NATS)",
          );
        }
      }

      // Register subscribers BEFORE starting jobs to prevent race condition
      await startCartIntelligenceSubscribers(server.log);
      // NEW-036 per-dish stock depletion — own queue group ("ingredient-depletion")
      // + own dedup namespace (depletion:${orderId}), parallel to cart-intelligence's
      // order.placed consumer. Non-kernel: decrements ingredient stock directly.
      await startIngredientDepletionSubscriber(server.log);
      await startHandoffSubscriber(server.log);
      // W1 no-reply incident — durable backstop consumer of conversation.no_delivery
      // (redelivery/replay + future out-of-process emitters; inline open is the
      // primary durability path) and the out-of-band staff WhatsApp ping consumer
      // of conversation.incident_opened (storm-digest rate-limited).
      await startIncidentSubscriber(server.log);
      await startIncidentNotificationSubscriber(server.log);
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
      // [audit-2026-05-24 H3 Wave-B] Cross-DB Medusa anonymize compensation.
      // Consumes `customer.anonymize.medusa.pending` (emitted by
      // anonymizeCustomer after the Prisma TX commits) and PATCHes the
      // Medusa-side customer row. The compensation chain closes with a
      // `.confirmed` audit record; failures emit `.failed` and remain
      // available for the anonymize-medusa-retry BullMQ job to re-publish.
      await startCustomerAnonymizeMedusaResolverSubscriber(server.log);
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
try {
  await start();
} catch (err) {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  logger.fatal({ err }, "[fatal] startup error");
  process.exit(1);
}
