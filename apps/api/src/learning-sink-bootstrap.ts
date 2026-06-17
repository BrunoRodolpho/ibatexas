// learning-sink-bootstrap.ts — the `learning.event.v1` telemetry channel (ERDS-060).
//
// Mirrors the audit-sink bootstrap pattern (audit-sink-bootstrap.ts +
// @ibatexas/audit-sink's `__setAuditSinkDependencies` leaf DI): a leaf that
// owns construction of a best-effort, FAIL-OPEN `LearningSink`, fed live
// NATS + Redis pub/sub publishers at app boot via
// `bootstrapLearningSinkDI(log)` BEFORE any subscriber / turn path can reach
// `getLearningSink()`.
//
// A LearningEvent is pure telemetry — it lives STRICTLY OUTSIDE the kernel
// `adjudicate()`/canonicalization hot path. Each event is published to BOTH:
//   - the NATS subject `learning.event.v1` (the client prepends `ibatexas.`,
//     so the wire subject is `ibatexas.learning.event.v1`, captured by the
//     `IBX_LEARNING` stream); AND
//   - the Redis pub/sub channel `learning.event.v1` (mirrors how the audit
//     sink publishes to its `audit.event.v1` bus for the console live-tail —
//     here the adjudicate console reader consumes the live learning feed).
//
// FAIL-OPEN by construction: every publish is wrapped so a NATS/Redis failure
// is logged and swallowed. A learning-event emit MUST NEVER affect a turn or a
// decision (the determinism boundary: telemetry-only, no edge to the kernel).
//
// The payload contract below is EXACT — it is shared verbatim with the
// adjudicate console's learning-event reader. Do not reshape it without
// updating that consumer.

import { getRedisClient } from "@ibatexas/tools"
import { publishNatsEvent } from "@ibatexas/nats-client"
import {
  LEARNING_EVENT_CHANNEL,
  LEARNING_EVENT_SUBJECT,
  type LearningEventV1,
} from "@adjudicate/core"
import type { FastifyBaseLogger } from "fastify"

/**
 * The `learning.event.v1` payload contract — single-sourced from
 * `@adjudicate/core` as `LearningEventV1` (item A — UltraReview #94-20) so the
 * ibatexas publisher and the adjudicate console reader can no longer drift.
 * Telemetry only: keep payloads minimal — no message bodies, no secrets.
 */
export type LearningEvent = LearningEventV1

/**
 * The NATS subject (short form — the client prepends `ibatexas.`) and the Redis
 * pub/sub channel the console live-tail subscribes to. Re-exported from
 * `@adjudicate/core` so the wire subject/channel are single-sourced (item A).
 */
export { LEARNING_EVENT_SUBJECT, LEARNING_EVENT_CHANNEL }

/**
 * Best-effort, FAIL-OPEN learning telemetry sink. `recordLearningEvent` NEVER
 * throws and NEVER rejects with an error the caller must handle — a publish
 * failure is logged and swallowed.
 */
export interface LearningSink {
  recordLearningEvent(event: LearningEvent): Promise<void>
}

/** A no-throw NATS publisher seam (injected; default `publishNatsEvent`). */
export interface LearningNatsPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>
}

/** A no-throw Redis pub/sub publisher seam (injected; default the live client). */
export interface LearningRedisPublisher {
  publish(channel: string, message: string): Promise<unknown>
}

/** Dependencies the leaf composes into a {@link LearningSink}. */
export interface LearningSinkDependencies {
  /** NATS arm. Absent ⇒ that arm is skipped (no NATS connection at boot). */
  readonly nats?: LearningNatsPublisher
  /** Redis pub/sub arm. Absent ⇒ that arm is skipped (Redis unreachable at boot). */
  readonly redis?: LearningRedisPublisher
  /** pino-shaped logger for fail-open warnings. */
  readonly logger: Pick<FastifyBaseLogger, "warn" | "info">
}

// ── Module-level leaf state ────────────────────────────────────────────────

let _deps: LearningSinkDependencies | null = null
let _sink: LearningSink | null = null

/**
 * Compose the deps into a fail-open sink. BOTH arms fire per event; each is
 * independently wrapped so one failure never starves the other and never
 * surfaces to the caller.
 */
function buildLearningSink(deps: LearningSinkDependencies): LearningSink {
  return {
    async recordLearningEvent(event: LearningEvent): Promise<void> {
      const payload = event as unknown as Record<string, unknown>
      // NATS arm — `ibatexas.learning.event.v1` (captured by IBX_LEARNING).
      if (deps.nats) {
        try {
          await deps.nats.publish(LEARNING_EVENT_SUBJECT, payload)
        } catch (err) {
          deps.logger.warn(
            { component: "learning-sink", arm: "nats", err: String(err) },
            "[learning-sink] NATS publish failed (swallowed — turn/decision unaffected)",
          )
        }
      }
      // Redis pub/sub arm — the console live-tail channel `learning.event.v1`.
      if (deps.redis) {
        try {
          await deps.redis.publish(LEARNING_EVENT_CHANNEL, JSON.stringify(event))
        } catch (err) {
          deps.logger.warn(
            { component: "learning-sink", arm: "redis", err: String(err) },
            "[learning-sink] Redis publish failed (swallowed — turn/decision unaffected)",
          )
        }
      }
    },
  }
}

/**
 * Boot-time dependency registration (idempotent — REPLACES deps + resets the
 * cached sink). The `__` prefix mirrors `__setAuditSinkDependencies` for
 * cross-package symmetry on internal-but-cross-module wiring APIs.
 */
export function __setLearningSinkDependencies(deps: LearningSinkDependencies): void {
  _deps = deps
  _sink = null
}

/** @internal — test isolation. Clears the leaf so the next get rebuilds. */
export function __resetLearningSink(): void {
  _deps = null
  _sink = null
}

/**
 * The composed learning sink. When the leaf is un-wired (boot skipped /
 * Redis+NATS both unavailable), returns a no-op sink rather than throwing —
 * learning telemetry is strictly secondary, so its absence must never surface
 * to a caller (fail-open all the way down, unlike the fail-CLOSED audit sink).
 */
export function getLearningSink(): LearningSink {
  if (_sink) return _sink
  if (!_deps) {
    return { async recordLearningEvent() {} }
  }
  _sink = buildLearningSink(_deps)
  return _sink
}

/**
 * Bootstrap the learning-sink DI. Resolves the live Redis client best-effort
 * (the Redis arm is simply absent when unreachable — fail-open) and wires
 * `publishNatsEvent` as the NATS arm. Same boot point as the audit sink, run
 * before the subscribers / managed-agent plane start.
 */
export async function bootstrapLearningSinkDI(log: FastifyBaseLogger): Promise<void> {
  let redis: LearningRedisPublisher | undefined
  try {
    const client = await getRedisClient()
    redis = {
      publish: (channel: string, message: string) => client.publish(channel, message),
    }
  } catch (err) {
    log.warn(
      { component: "learning-sink", err: String(err) },
      "[learning-sink-bootstrap] Redis unreachable at boot — learning bus arm disabled (fail-open)",
    )
  }

  __setLearningSinkDependencies({
    nats: {
      // `publishNatsEvent` prepends `ibatexas.`, so the wire subject is
      // `ibatexas.learning.event.v1` (captured by the IBX_LEARNING stream).
      async publish(subject, payload) {
        await publishNatsEvent(subject, payload)
      },
    },
    ...(redis ? { redis } : {}),
    logger: log,
  })

  log.info(
    { event: "learning_sink.bootstrap.complete" },
    "[learning-sink-bootstrap] learning-sink dependencies registered (learning.event.v1)",
  )
}
