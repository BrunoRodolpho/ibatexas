// audit-sink-bootstrap.ts — wire @ibatexas/audit-sink's boot-time DI.
//
// Per audit-2026-05-24 H2 (sub-option A1), `@ibatexas/audit-sink` owns
// the construction of the IbateXas audit sink but has ZERO runtime deps
// on the live Redis / Prisma / NATS clients. The dependencies are
// injected at app startup via `__setAuditSinkDependencies(deps)` BEFORE
// any subscriber / route / wrapper-call site can reach `getAuditSink()`.
//
// This file is the apps/api-side bootstrap step. It:
//   1. Resolves the live Redis client (best-effort — falls back to
//      in-memory spill storage if Redis is unreachable at boot).
//   2. Composes the deps via `buildAuditSinkDependencies` from
//      `@ibatexas/llm-provider` (which threads through the per-process
//      hook state populated by `installKernelMetricsSink`).
//   3. Calls `__setAuditSinkDependencies(deps)` on the leaf so every
//      subsequent `getAuditSink()` returns the composed sink.
//
// Boot ordering contract:
//   server.ts:buildServer()
//     └─ installKernelMetricsSink()         // sets W3-* observability hooks
//   index.ts:start()
//     └─ await bootstrapKernel(server)      // assertAuditPostgresReady etc.
//     └─ await bootstrapAuditSinkDI(server.log)   // ← THIS FILE
//     └─ startCart{...}Subscribers / registerWorkers / etc.
//
// Tests stub the leaf directly via the legacy `_setAuditSinkDependencies`
// shim — see `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts`
// for the pattern.

import {
  __setAuditSinkDependencies,
  buildAuditSinkDependencies,
} from "@ibatexas/audit-sink"
import { getRedisClient } from "@ibatexas/tools"
import { prisma } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"
import type { FastifyBaseLogger } from "fastify"
import { observeDriftRecord } from "./observability/drift-detector.js"
import { assertAuditRedactSecretPosture } from "./audit-redact-secret-posture.js"

/**
 * Bootstrap the audit-sink dependency injection. Idempotent — safe to
 * call once at boot; calling twice REPLACES the registered deps and
 * resets the cached sink.
 *
 * @param log — pino-shaped logger (typically `server.log`). Threads
 *   through to the leaf so audit-pipeline warnings carry the request-
 *   correlated reqId when invoked from a route handler.
 */
export async function bootstrapAuditSinkDI(
  log: FastifyBaseLogger,
): Promise<void> {
  // BKL-093 — fail closed at boot in production when the redaction salt is empty
  // (before any audit record is composed). Runs first so a misconfigured prod
  // deploy exits non-zero via start()'s catch rather than serving traffic.
  assertAuditRedactSecretPosture({
    nodeEnv: process.env.NODE_ENV,
    secret: process.env.AUDIT_REDACT_SECRET,
    log,
  });

  // Resolve Redis best-effort. If Redis is unreachable at boot, fall
  // back to the leaf's in-memory spill storage — production deployments
  // need Redis up for spill durability, but the boot must not wedge on
  // a transient connect failure (the kernel-bootstrap audit-postgres
  // preflight already asserts the Postgres path).
  let redis: Awaited<ReturnType<typeof getRedisClient>> | null = null
  try {
    redis = await getRedisClient()
  } catch (err) {
    log.warn(
      { err: String(err) },
      "[audit-sink-bootstrap] Redis unreachable at boot — falling back to in-memory spill storage",
    )
  }

  // P2 — publish-only Redis audit bus adapter (live-tail SSE + console drift).
  // Built HERE, NOT the agentsEnabled-gated RedisPubSubClient in
  // claustrum-bootstrap — the bus must fire for ALL decisions at boot,
  // independent of the agent-plane flag. The console is the subscriber; this
  // side only ever publishes. Absent when Redis is unreachable (the busSink arm
  // is simply not added — fail-open, the durable sinks are unaffected).
  const auditPubsub = redis
    ? {
        publish: (channel: string, message: string) => redis!.publish(channel, message),
        // Publish-only: the console subscribes, never this side.
        subscribe: async (): Promise<() => Promise<void>> => {
          throw new Error("audit-sink pubsub is publish-only (the console subscribes)")
        },
      }
    : undefined

  const deps = {
    ...buildAuditSinkDependencies({
      redis,
      prismaWriter: prisma,
      natsPublisher: {
        async publish(subject, payload) {
          // `publishNatsEvent` prepends `ibatexas.` so the final NATS
          // subject is `ibatexas.audit.intent.decision.v1`. Subscribers
          // (`audit-consumer`) filter on the full subject.
          await publishNatsEvent(subject, payload)
        },
      },
      logger: log,
    }),
    // F3 — behavioral-drift tee. Fail-open (the leaf arm swallows); sees only
    // redacted records. observe() is no-throw.
    onAuditRecord: observeDriftRecord,
    // P2 — Redis audit bus arm (publish-only; fail-open in the leaf).
    ...(auditPubsub ? { pubsub: auditPubsub } : {}),
  }

  __setAuditSinkDependencies(deps)

  log.info(
    { event: "audit_sink.bootstrap.complete" },
    "[audit-sink-bootstrap] audit-sink dependencies registered with @ibatexas/audit-sink leaf",
  )
}
