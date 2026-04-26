// IBX-IGE Phase P0-c — DEFER consumer NATS wiring.
//
// Pure resume logic + dedup invariants live in @adjudicate/intent-runtime
// (see packages/intent-runtime/src/defer-resume.ts and the property tests
// at packages/intent-runtime/tests/defer-resume.test.ts). This module wires
// that logic to the IbateXas NATS subscriber and Redis client.
//
// Note: PaymentStatusChangedEvent carries `customerId` but not `sessionId`.
// Resume key is keyed by sessionId because that is what the responder writes
// when parking. We scan all parked sessions on each confirmation event;
// volume is low (only sessions with PIX-deferred intents), and the SET NX
// dedup makes spurious resume attempts safe. A real production deployment
// may swap this to a session-by-orderId index when parked-session count
// grows.

import { subscribeNatsEvent } from "@ibatexas/nats-client"
import { getRedisClient, rk } from "@ibatexas/tools"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"
import {
  PIX_CONFIRMED_STATUSES,
  resumeDeferredIntent as resumeDeferredIntentImpl,
  type DeferResumeResult,
} from "@adjudicate/intent-runtime"
import type { FastifyBaseLogger } from "fastify"

export {
  PIX_CONFIRMED_STATUSES,
  DEFER_PENDING_TTL_GRACE_SECONDS,
  deferResumeHash,
} from "@adjudicate/intent-runtime"
export type { DeferResumeResult } from "@adjudicate/intent-runtime"

export async function resumeDeferredIntent(
  sessionId: string,
  signal: string,
  log?: FastifyBaseLogger,
): Promise<DeferResumeResult> {
  const redis = await getRedisClient()
  return resumeDeferredIntentImpl({ sessionId, signal, redis, rk, log })
}

export async function startDeferResolverSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("payment.status_changed", async (payload) => {
    const event = payload as unknown as PaymentStatusChangedEvent
    const { newStatus, paymentId, orderId } = event

    if (!PIX_CONFIRMED_STATUSES.has(newStatus)) {
      return
    }

    const redis = await getRedisClient()
    const keys = await redis
      .keys(rk(`defer:pending:*`))
      .catch(() => [] as string[])
    for (const key of keys) {
      const m = key.match(/defer:pending:(.+)$/)
      if (!m) continue
      const sessionId = m[1]!
      const result = await resumeDeferredIntent(
        sessionId,
        "payment.confirmed",
        log,
      )
      if (result.resumed) {
        log?.info(
          { sessionId, paymentId, orderId, intentHash: result.intentHash },
          "[defer-resolver] resumed deferred intent",
        )
      } else if (result.reason === "duplicate_resume_suppressed") {
        log?.debug(
          { sessionId, paymentId, intentHash: result.intentHash },
          "[defer-resolver] duplicate webhook delivery — replay suppressed",
        )
      }
    }
  })
}
