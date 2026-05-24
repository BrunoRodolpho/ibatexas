// anonymize-grace-resolver.ts — Task 14 (M3).
//
// Consumes `intent.defer.timeout` events from the defer-timeout-sweeper
// (task 03). Filters for events whose `signal` matches the customer
// onboarding pack's anonymize grace signal. If the customer's pending-
// deletion receipt is still in Redis (i.e. they did NOT call
// cancel-deletion within the 24h grace window), runs the actual
// `anonymizeCustomer` and clears the receipt.
//
// ── Why this subscriber exists ────────────────────────────────────────────
//
// Per investigation 08 P0 #2 and the master plan §"Customer destructive
// flow", LGPD anonymize is parked as DEFER for a 24h grace. The kernel's
// own park-resume machinery doesn't run the destructive operation — by
// design — because the wire signal for `customer.anonymize.confirmed_after_grace`
// is "no cancel arrived in time", not a Stripe-style confirmation event.
// This subscriber is the "wait period elapsed" consumer: it bridges the
// timeout sweeper to the actual destructive call.
//
// ── Safety invariants ─────────────────────────────────────────────────────
//
//   1. Signal-mismatch is silently skipped — `intent.defer.timeout`
//      fires for ALL parked envelopes, not just anonymize. Other parks
//      (PIX pending, future destructive ops) are handled by their own
//      resolvers.
//
//   2. The cancel-deletion endpoint deletes the receipt under
//      `rk('anonymize:pending:{customerId}')`. Absence == cancelled.
//      Presence == still pending; safe to run.
//
//   3. Idempotent: the receipt is deleted AFTER `anonymizeCustomer`
//      runs. If anonymize throws, the receipt stays; the next sweep
//      retries. If the customer record is already anonymized
//      (concurrent run), `anonymizeCustomer` is idempotent at the
//      Prisma level (UPDATE-with-no-rows is a no-op).
//
//   4. Audit linkage: emit an audit record carrying `supersedes`
//      pointing back to the parked envelope's `intentHash`, so the
//      decision log shows the DEFER → EXECUTE bridge.
//
// ── Rollback-safety ───────────────────────────────────────────────────────
//
// On hard rollback (PR revert), pending anonymize-deferred intents
// within the 24h window still have their timeout fire — but the
// subscriber is no longer registered, so nothing runs. The receipt
// expires naturally after 24h. Worst case: a customer who initiated
// deletion during the rollback window may need to re-initiate. No data
// is lost — the destructive call never ran.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import {
  CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
} from "@ibatexas/pack-customer-onboarding";
import { anonymizeCustomer } from "@ibatexas/domain";
import { buildAuditRecord, BASIS_CODES } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/llm-provider";
import type { FastifyBaseLogger } from "fastify";
import { clearPendingDeletion, readPendingDeletion } from "../routes/me/anonymize-otp-gate.js";
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

/**
 * Core handler — exported for direct testing without NATS.
 *
 * Returns:
 *   - `{kind: "skipped", reason}` — signal mismatch or no pending receipt.
 *   - `{kind: "anonymized"}` — ran the destructive operation.
 *   - `{kind: "error", err}` — anonymize threw; receipt NOT cleared.
 */
export type GraceResolverOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "anonymized"; readonly customerId: string; readonly intentHash: string }
  | { readonly kind: "error"; readonly customerId: string; readonly err: Error };

export async function handleAnonymizeGraceTimeout(
  event: DeferTimeoutEvent,
  log?: FastifyBaseLogger,
): Promise<GraceResolverOutcome> {
  // 1. Filter on signal — many parks share the same wire event.
  if (event.signal !== CUSTOMER_ANONYMIZE_GRACE_SIGNAL) {
    return { kind: "skipped", reason: "signal_mismatch" };
  }

  // 2. The parked envelope's sessionId == customerId by construction
  //    (task 14 routes set `actor.sessionId = customerId`).
  const customerId = event.sessionId;

  // 3. Check the cancellation receipt. If the customer cancelled, the
  //    cancel-deletion endpoint already DELed this key.
  const receipt = await readPendingDeletion(customerId);
  if (!receipt) {
    log?.info(
      { customerId, intentHash: event.intentHash },
      "[anonymize-grace-resolver] no pending receipt — deletion was cancelled or already ran",
    );
    return { kind: "skipped", reason: "no_pending_receipt" };
  }

  // 4. Run the destructive operation. This is module-level — it does
  //    NOT go through the kernel again (the kernel's verdict was DEFER
  //    at park time; the grace expiry IS the resume signal). The audit
  //    record carries `supersedes: [parked.intentHash]` for the log
  //    bridge.
  const startedAt = Date.now();
  try {
    await anonymizeCustomer(customerId);
    log?.info(
      { customerId, intentHash: event.intentHash, parkedAt: receipt.parkedAt },
      "[anonymize-grace-resolver] anonymize executed after 24h grace expired",
    );
  } catch (err) {
    // Leave the receipt in place — next sweep retries.
    log?.error(
      { customerId, intentHash: event.intentHash, err: (err as Error).message },
      "[anonymize-grace-resolver] anonymizeCustomer threw — receipt left for retry",
    );
    return { kind: "error", customerId, err: err as Error };
  }

  // 5. P0-8 audit emit — destructive LGPD operation MUST be on the audit
  //    trail. Fired AFTER the Prisma TX commits (so a failed TX produces
  //    no audit record — the failure is logged in the catch above) and
  //    BEFORE the receipt clear (so an audit-emit failure does not block
  //    cleanup — audit is best-effort once the destructive action is
  //    durable).
  //
  //    The system-actor envelope carries:
  //      - `kind: "customer.anonymize"` — matches the originally parked
  //        intent kind; the supersedes chain disambiguates "user
  //        initiated DEFER" vs "system completed after grace".
  //      - `actor.principal = "system"`, `taint = "SYSTEM"` — set by
  //        `buildSystemEnvelope`.
  //      - `payload = {customerId, scope}` — NO PII. customerId is a UUID
  //        per CLAUDE.md rule; no name/email/phone/CPF.
  //      - `decision = EXECUTE` with `business.RULE_SATISFIED` basis
  //        carrying the LGPD anchor — the kernel was NOT re-run here (it
  //        would just DEFER again); the grace expiry IS the authorization.
  //      - `supersedes` points at the original park's intentHash so
  //        replay can chain `DEFER → defer_resumed → EXECUTE`.
  try {
    const auditEnvelope = buildSystemEnvelope({
      kind: "customer.anonymize" as const,
      payload: {
        customerId,
        scope: "lgpd_art_18" as const,
      },
      sourceSubject: "intent.defer.timeout",
      eventId: `${event.intentHash}:grace_expired`,
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
              rule: "lgpd_art_18_grace_expired",
              kind: "customer.anonymize",
              graceSignal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
            },
          },
        ],
      },
      durationMs: Date.now() - startedAt,
      supersedes: {
        predecessorIntentHash: event.intentHash,
        predecessorAt: event.parkedAt,
        reason: "defer_resumed",
      },
    });
    void getAuditSink()
      .emit(record)
      .catch((err: unknown) => {
        // Audit-emit is best-effort once anonymize committed. Log only —
        // do NOT roll back the destructive op.
        log?.warn(
          { customerId, intentHash: event.intentHash, err: (err as Error).message },
          "[anonymize-grace-resolver] audit emit failed (destructive op already committed)",
        );
      });
  } catch (err) {
    log?.warn(
      { customerId, intentHash: event.intentHash, err: (err as Error).message },
      "[anonymize-grace-resolver] audit record build failed (destructive op already committed)",
    );
  }

  // 6. Clear the pending-deletion receipt — the destructive operation
  //    completed. The 24h TTL would have GC'd it eventually anyway, but
  //    explicit clear makes the timeline visible in Redis.
  await clearPendingDeletion(customerId);

  return { kind: "anonymized", customerId, intentHash: event.intentHash };
}

/**
 * Wire the subscriber to NATS. Called from `apps/api/src/index.ts`
 * alongside the other startup-phase subscribers.
 *
 * Errors per-event are swallowed by the handler; we do not let one bad
 * event take down the subscription. `subscribeNatsEvent` is fire-and-
 * forget on the receive side, so no return-value propagation matters.
 */
export async function startAnonymizeGraceResolverSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("intent.defer.timeout", async (payload) => {
    const event = payload as unknown as DeferTimeoutEvent;
    try {
      await handleAnonymizeGraceTimeout(event, log);
    } catch (err) {
      // Belt-and-braces: handleAnonymizeGraceTimeout never throws
      // (it returns an `error` outcome instead), but guard regardless.
      log?.error(
        { err: (err as Error).message, event },
        "[anonymize-grace-resolver] unexpected error",
      );
    }
  });
  log?.info("[anonymize-grace-resolver] Subscriber started");
}
