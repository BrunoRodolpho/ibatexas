// pix-defer-timeout-resolver.ts — audit-2026-05-24 P1-7.
//
// Consumes `intent.defer.timeout` events from the defer-timeout-sweeper
// (apps/api/src/jobs/defer-timeout-sweeper.ts), filtered for the PIX
// confirmation signal (`PIX_CONFIRMATION_SIGNAL` from
// `@adjudicate/pack-payments-pix`).
//
// ── Why this subscriber exists ────────────────────────────────────────────
//
// Pre-fix: only `anonymize-grace-resolver` subscribed to the
// `intent.defer.timeout` channel. PIX parks (whose signal is
// `payment.confirmed`) whose customer never paid would have their timeout
// event published to NATS — and dropped on the floor. The audit trail
// showed a DEFER at park time but no follow-up record for the timeout,
// leaving operators blind to "customer parked a checkout 30 minutes ago
// and never paid".
//
// Post-fix: this subscriber filters `intent.defer.timeout` for the PIX
// confirmation signal and emits an audit record linking the PIX timeout
// to the original park's `intentHash`. The actual DB-side payment
// status transition is owned by the separate `pix-expiry-checker`
// cron job (runs every 5 minutes, queries Payment rows whose
// `pixExpiresAt < now()`) — that path drives the kernel-gated
// `payment.status.transition` envelope through `paymentCmdSvc`.
//
// This subscriber is the NATS-driven audit / observability bridge. It is
// intentionally lightweight:
//   - No DB writes (owned by pix-expiry-checker, who already runs the
//     kernel-gated transition through the canonical envelope path).
//   - No NATS republish to downstream consumers — those consume
//     `payment.status_changed` from the expiry checker.
//   - Emits one audit record per PIX timeout so the decision log shows
//     `DEFER (park) → defer_timeout (this record)`.
//
// ── Safety invariants ─────────────────────────────────────────────────────
//
//   1. Signal-mismatch is silently skipped — `intent.defer.timeout` fires
//      for ALL parked envelopes, not just PIX. Other parks (anonymize,
//      future destructive ops) have their own resolvers.
//
//   2. No state mutation. Re-delivery of the same NATS event is safe.
//      The audit sink dedupes by `eventId` (the `${intentHash}:pix_timeout`
//      construction yields a deterministic envelope nonce; replay produces
//      the same intentHash).
//
//   3. System-actor envelope (CLAUDE.md rule #9): `actor.principal =
//      "system"`, `taint = "SYSTEM"`. The audit record carries `supersedes`
//      pointing back to the original park's `intentHash` so the audit
//      reader can chain `DEFER → defer_timeout`.
//
// ── Concurrency note ──────────────────────────────────────────────────────
//
// Per audit-2026-05-24 P0-2, the defer-timeout-sweeper now acquires the
// `defer:resuming:{deferResumeHash}` mutex BEFORE publishing
// `intent.defer.timeout`, so this subscriber cannot fire concurrently with
// the defer-resolver's resume path. Either the resolver wins (parked key
// resumed; no timeout published) or the sweeper wins (timeout published;
// this subscriber emits an audit record; the resolver finds no parked key
// on the next NATS delivery).

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix";
import { buildAuditRecord, BASIS_CODES } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import type { FastifyBaseLogger } from "fastify";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

/**
 * Shape of the event the defer-timeout-sweeper publishes.
 * Mirrors `DeferTimeoutEventPayload` in `jobs/defer-timeout-sweeper.ts`.
 */
interface DeferTimeoutEvent {
  readonly eventType: "intent.defer.timeout";
  readonly sessionId: string;
  readonly intentHash: string;
  readonly signal: string;
  readonly parkedAt: string;
  readonly timestamp: string;
}

export type PixDeferTimeoutOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "audited";
      readonly sessionId: string;
      readonly intentHash: string;
    };

/**
 * Core handler — exported for direct testing without NATS.
 *
 * Filters on the PIX confirmation signal and emits an audit record linking
 * the timeout back to the original parked envelope's `intentHash`.
 */
export async function handlePixDeferTimeout(
  event: DeferTimeoutEvent,
  log?: FastifyBaseLogger,
): Promise<PixDeferTimeoutOutcome> {
  // 1. Filter on signal — many parks share the same timeout channel.
  if (event.signal !== PIX_CONFIRMATION_SIGNAL) {
    return { kind: "skipped", reason: "signal_mismatch" };
  }

  // 2. If the parked envelope blob was malformed, the sweeper still
  //    publishes a minimal timeout payload (no `intentHash`). We can't
  //    build a useful audit record without it — log and skip.
  if (!event.intentHash) {
    log?.warn(
      { sessionId: event.sessionId, parkedAt: event.parkedAt },
      "[pix-defer-timeout-resolver] empty intentHash — minimal timeout, skipping audit emit",
    );
    return { kind: "skipped", reason: "missing_intent_hash" };
  }

  // 3. Emit a system-actor audit record. The audit log chains:
  //    DEFER (park) → defer_timeout (this record). `supersedes` points
  //    back to the parked envelope's hash so an operator can join the
  //    two records by `record.supersedes.predecessorIntentHash`.
  //
  //    No DB writes here — pix-expiry-checker owns the kernel-gated
  //    `payment.status.transition` envelope path. This resolver's
  //    contribution to the audit trail is the timeout itself.
  const startedAt = Date.now();
  try {
    const auditEnvelope = buildSystemEnvelope({
      kind: "payment.pix.timeout.audit" as const,
      payload: {
        sessionId: event.sessionId,
        originalIntentHash: event.intentHash,
        signal: event.signal,
        parkedAt: event.parkedAt,
      },
      sourceSubject: "intent.defer.timeout",
      // Deterministic per-timeout nonce so replay produces an identical
      // envelope (audit sink dedupes by intentHash).
      eventId: `${event.intentHash}:pix_timeout`,
    });
    const record = buildAuditRecord({
      envelope: auditEnvelope,
      decision: {
        kind: "EXECUTE",
        basis: [
          {
            category: "business",
            code: BASIS_CODES.business.RULE_SATISFIED,
            detail: {
              rule: "pix_park_timeout",
              signal: PIX_CONFIRMATION_SIGNAL,
              note:
                "PIX parked envelope reached TTL without confirmation. " +
                "pix-expiry-checker owns the payment.status.transition path.",
            },
          },
        ],
      },
      durationMs: Date.now() - startedAt,
      supersedes: {
        predecessorIntentHash: event.intentHash,
        predecessorAt: event.parkedAt,
        // Use the framework's `defer_resumed` reason — the closest existing
        // SupersessionReason value (the framework's enum doesn't include a
        // `defer_timeout` variant). Mirrors the anonymize-grace-resolver
        // pattern; both encode "the wait period elapsed" as a resume.
        reason: "defer_resumed",
      },
    });
    void getAuditSink()
      .emit(record)
      .catch((err: unknown) => {
        log?.warn(
          {
            sessionId: event.sessionId,
            intentHash: event.intentHash,
            err: (err as Error).message,
          },
          "[pix-defer-timeout-resolver] audit emit failed",
        );
      });
  } catch (err) {
    log?.warn(
      {
        sessionId: event.sessionId,
        intentHash: event.intentHash,
        err: (err as Error).message,
      },
      "[pix-defer-timeout-resolver] audit record build failed",
    );
  }

  log?.info(
    {
      sessionId: event.sessionId,
      intentHash: event.intentHash,
      parkedAt: event.parkedAt,
    },
    "[pix-defer-timeout-resolver] PIX park timed out — audit emitted",
  );

  return {
    kind: "audited",
    sessionId: event.sessionId,
    intentHash: event.intentHash,
  };
}

/**
 * Wire the subscriber to NATS. Called from `apps/api/src/index.ts`
 * alongside the other startup-phase subscribers.
 */
export async function startPixDeferTimeoutResolverSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("intent.defer.timeout", async (payload) => {
    const event = payload as unknown as DeferTimeoutEvent;
    try {
      await handlePixDeferTimeout(event, log);
    } catch (err) {
      // Belt-and-braces: handlePixDeferTimeout never throws (it returns a
      // skipped outcome instead), but guard regardless.
      log?.error(
        { err: (err as Error).message, event },
        "[pix-defer-timeout-resolver] unexpected error",
      );
    }
  }, { queueGroup: "pix-defer-timeout-resolver" });
  log?.info("[pix-defer-timeout-resolver] Subscriber started");
}
