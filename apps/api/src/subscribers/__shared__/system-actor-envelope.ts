// system-actor-envelope.ts — shared helper for NATS subscribers + BullMQ jobs.
//
// ── Task 16 (M3) — system-actor envelopes ─────────────────────────────────
//
// Every reactive mutation (auto-confirm on payment, auto-cancel on refund,
// stale-order cancel, conversation archival, notification fan-out) flows
// through `adjudicate()` via the `*FromEnvelope` entry points on the
// command services (Task 15). The system-actor envelope captures the
// provenance of these subscriber/job-driven intents in a uniform shape:
//
//   - `actor.principal = "system"` — these are not user-driven.
//   - `actor.sessionId = "${sourceSubject}:${eventId}"` for subscribers,
//     or `"${jobName}:${tickId}"` for cron-driven jobs. Gives operators a
//     traceable correlation between an upstream NATS message / cron tick
//     and the kernel audit record.
//   - `taint = "SYSTEM"` — clears the SYSTEM-only floor on system-only
//     intent kinds (`payment.create`, `order.projection.create`,
//     `order.status.reconcile`, `conversation.*`).
//   - `nonce = eventId` — deterministic intentHash per upstream event.
//     Replay-safe: re-delivering the same NATS message or a cron tick
//     produces the same hash, and the Execution Ledger / kernel can
//     dedupe even across the Redis 7-day dedup window.
//
// Per investigation 04 §"Architectural recommendations" #2: "Every place
// a subscriber/job invokes a domain command service (orderCmdSvc.transitionStatus,
// paymentCmdSvc.transitionStatus, paymentCmdSvc.create) should build an
// IntentEnvelope with actor.principal = 'system' and pass it through
// adjudicate() with a system-actor PolicyBundle."
//
// pt-BR (CLAUDE.md rule #4): this helper is purely structural — no
// user-facing strings — so no Portuguese copy needed here.

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";

export interface BuildSystemEnvelopeArgs<K extends string, P> {
  /** Intent kind — must match a kind declared by the target policy bundle. */
  readonly kind: K;
  /** Payload — typed per the kind. */
  readonly payload: P;
  /**
   * NATS subject name (e.g. `"payment.status_changed"`) or job name (e.g.
   * `"stale-order-checker"`). Used as the prefix of `actor.sessionId` so
   * audit consumers can correlate the kernel decision back to its upstream
   * trigger.
   */
  readonly sourceSubject: string;
  /**
   * Stable per-event identifier. Subscribers: the NATS event id or a
   * derived key like `${paymentId}:${newStatus}`. Jobs: a per-tick id
   * (e.g. `${jobId}:${runAt}`). Used for `nonce` so re-delivery produces
   * a byte-identical envelope (and thus a deterministic `intentHash`).
   */
  readonly eventId: string;
  /**
   * Optional correlation key for downstream observability (rendered into
   * the audit record). Typically the NATS event's correlationId or the
   * upstream Stripe / Twilio event id.
   */
  readonly correlationKey?: string;
}

/**
 * Build an `IntentEnvelope<K, P>` with the system-actor shape.
 *
 * Use this helper for any subscriber or job mutation that needs to flow
 * through the adjudicate kernel. Callers then pass the envelope to a
 * service-level `*FromEnvelope` entry point (e.g.,
 * `orderCmdSvc.transitionStatusFromEnvelope(envelope)` per Task 15).
 *
 * The kernel's audit record carries:
 *   - `actor.principal = "system"`
 *   - `actor.sessionId = "${sourceSubject}:${eventId}"`
 *   - `taint = "SYSTEM"`
 *   - `nonce = eventId`
 *
 * @example
 *   // Subscriber: payment-lifecycle auto-confirm
 *   const envelope = buildSystemEnvelope({
 *     kind: "order.status.transition",
 *     payload: { orderId, newStatus: "confirmed", actor: "system", ... },
 *     sourceSubject: "payment.status_changed",
 *     eventId: `${paymentId}:${newStatus}`,
 *   });
 *   const outcome = await orderCmdSvc.transitionStatusFromEnvelope(envelope);
 */
export function buildSystemEnvelope<K extends string, P>(
  args: BuildSystemEnvelopeArgs<K, P>,
): IntentEnvelope<K, P> {
  return buildEnvelope({
    kind: args.kind,
    payload: args.payload,
    actor: {
      principal: "system",
      sessionId: `${args.sourceSubject}:${args.eventId}`,
    },
    taint: "SYSTEM",
    nonce: args.eventId,
  });
}
