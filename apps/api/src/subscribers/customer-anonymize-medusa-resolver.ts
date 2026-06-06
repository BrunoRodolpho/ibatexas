// customer-anonymize-medusa-resolver.ts — audit-2026-05-24 H3 Wave B.
//
// ── Why this subscriber exists ────────────────────────────────────────────
//
// Wave A1 (`packages/domain/src/services/customer.service.ts`) scrubs 7
// in-process Prisma surfaces inside a single transaction. Surface 8 —
// the Medusa-side customer row — lives in a separate Postgres database
// reachable only via HTTP admin API. It CANNOT participate in the Prisma
// TX. Per the SYNTHESIS-recommended pattern (h3-investigation/cross-db.md
// §"Decision: Compensation + retry job"), after the Prisma TX commits the
// service emits `customer.anonymize.medusa.pending`; this subscriber
// consumes it and runs the Medusa-side PATCH.
//
// ── Pattern reference: anonymize-grace-resolver.ts ────────────────────────
//
// Same shape: NATS subscriber + module-level `handle*` function exported
// for unit testing. Returns a typed outcome instead of throwing so the
// caller (BullMQ retry, test) can distinguish skipped vs success vs
// failed without try/catch parsing.
//
// ── Idempotency ───────────────────────────────────────────────────────────
//
// The Medusa-side POST is idempotent by virtue of:
//   1. HTTP POST/PATCH semantics on Medusa v2 — repeating the same body
//      against the same customer-id leaves the record in the same state.
//   2. A stable `Idempotency-Key` header threaded through
//      `medusaAdjudicated({ idempotencyKey })`. Key formula in
//      `medusaAnonymizeIdempotencyKey(medusaId, parkedIntentHash)` —
//      identical across every retry of the same scrub request.
//   3. Subscriber-side dedup: if a `.confirmed` audit record already
//      exists for this customerId + parkedIntentHash pair, the retry job
//      will not re-publish. Within a single subscriber pass, the call is
//      naturally a no-op against an already-anonymized Medusa row.
//
// ── PII discipline (CLAUDE.md rule #9) ────────────────────────────────────
//
// Audit-record payloads carry (customerId, medusaId, parkedIntentHash,
// parkedAt, attempt). No name / email / phone / cpf. The Medusa PATCH
// body sends `name=null, email=null, phone=null, company_name=null,
// metadata={anonymized: true}` — wholesale scrub, per Step-1 audit:
// no documented PII in `metadata` today, full-replace is the safe
// default (cross-db.md §"Risk 2: Medusa customer metadata").

import { subscribeNatsEvent, publishNatsEvent } from "@ibatexas/nats-client";
import {
  clearMedusaAnonymizePending,
  medusaAdjudicated,
  readMedusaAnonymizePending,
  recordMedusaAnonymizePending,
} from "@ibatexas/tools";
import { buildAuditRecord, BASIS_CODES } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import type { FastifyBaseLogger } from "fastify";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";
import {
  type MedusaAnonymizePayload,
  medusaAnonymizeIdempotencyKey,
} from "./__shared__/medusa-anonymize-kinds.js";

/**
 * Sentinel values written to the Medusa customer row. Full-replace per
 * Step-1 audit (no documented PII in `metadata` today; integrations could
 * theoretically write to it without docs, so the safe default is to clear
 * the whole blob to `{anonymized: true}`).
 *
 * The Medusa v2 admin API validator (verified at
 * node_modules/@medusajs/medusa/dist/api/admin/customers/validators.js):
 *   email: z.string().email().nullish()
 *   first_name / last_name / phone / company_name: z.string().nullish()
 *   metadata: z.record(z.unknown()).nullish()
 *
 * All fields accept `null` — we send explicit nulls (vs omitting) so
 * Medusa overwrites any pre-existing value. The `metadata` blob is
 * full-replaced, not omitted.
 */
const MEDUSA_ANONYMIZE_PATCH_BODY = {
  first_name: null as string | null,
  last_name: null as string | null,
  email: null as string | null,
  phone: null as string | null,
  company_name: null as string | null,
  metadata: { anonymized: true } as Record<string, unknown>,
};

/**
 * Outcome surface — exported for direct testing without NATS.
 *
 * `skipped`   — event shape was invalid (e.g., missing medusaId) and the
 *               subscriber declined to run. NO confirmed emitted, NO
 *               failed emitted. Operator inspects logs.
 * `confirmed` — Medusa PATCH succeeded, `.confirmed` audit record emitted.
 *               The chain is closed.
 * `failed`    — Medusa PATCH threw (network/4xx/5xx). `.failed` audit
 *               record emitted. The pending event remains in audit; the
 *               retry job will pick it up.
 */
export type MedusaAnonymizeResolverOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "confirmed";
      readonly customerId: string;
      readonly medusaId: string;
    }
  | {
      readonly kind: "failed";
      readonly customerId: string;
      readonly medusaId: string;
      readonly err: Error;
    };

/**
 * Core handler. Pure of NATS wiring so unit tests can drive it directly
 * with a payload object.
 *
 * The Medusa call is gated by `medusaAdjudicated` (system-actor SYSTEM-
 * tainted envelope, audit record per egress). On success we emit a second
 * audit record at THIS layer (`.confirmed`) — supersession-linked to the
 * parked anonymize envelope — so audit replay can chain the full
 * lifecycle: parked DEFER → grace expire → Prisma scrub → Medusa pending
 * → Medusa confirmed.
 */
export async function handleMedusaAnonymizePending(
  payload: MedusaAnonymizePayload,
  log?: FastifyBaseLogger,
): Promise<MedusaAnonymizeResolverOutcome> {
  const { customerId, medusaId, parkedIntentHash, parkedAt } = payload;

  if (!medusaId || typeof medusaId !== "string" || medusaId.length === 0) {
    log?.warn(
      { customerId, parkedIntentHash },
      "[customer-anonymize-medusa-resolver] missing medusaId in pending event — skipping",
    );
    return { kind: "skipped", reason: "missing_medusa_id" };
  }

  const startedAt = Date.now();
  const idempotencyKey = medusaAnonymizeIdempotencyKey(
    medusaId,
    parkedIntentHash,
  );

  // Record the pending entry BEFORE the Medusa call so the retry job
  // can find it if THIS subscriber pass crashes mid-flight. Best-effort
  // — Redis unreachable means no retry, but the destructive op is still
  // attempted via the NATS event.
  //
  // audit-2026-05-25 (I11): preserve `firstEmittedAt` across retries.
  // Pre-fix the subscriber called recordMedusaAnonymizePending without
  // passing firstEmittedAt; the function's `entry.firstEmittedAt ?? now`
  // fallback overwrote the field on every retry receipt. The documented
  // semantics ("Wall-clock ms when the pending event was first
  // emitted") were silently falsified — operator dashboards joining on
  // firstEmittedAt to detect stuck-for-hours customers reported stale
  // "just started" values. Now we read the existing entry first and
  // propagate the original firstEmittedAt.
  const existingEntry = await readMedusaAnonymizePending(customerId).catch(
    () => null,
  );
  await recordMedusaAnonymizePending(
    {
      customerId,
      medusaId,
      parkedIntentHash,
      parkedAt,
      attempt: payload.attempt,
      ...(existingEntry?.firstEmittedAt !== undefined
        ? { firstEmittedAt: existingEntry.firstEmittedAt }
        : {}),
    },
    log,
  );

  try {
    await medusaAdjudicated({
      scope: "admin",
      method: "POST",
      path: `/admin/customers/${medusaId}`,
      payload: MEDUSA_ANONYMIZE_PATCH_BODY,
      idempotencyKey,
      sourceSubject: "subscriber:customer-anonymize-medusa-resolver",
      auditSink: getAuditSink(),
      ...(log ? { log } : {}),
    });
  } catch (err) {
    log?.error(
      {
        customerId,
        medusaId,
        parkedIntentHash,
        err: (err as Error).message,
      },
      "[customer-anonymize-medusa-resolver] Medusa PATCH failed — emitting failed audit; retry job will re-publish",
    );
    emitMedusaAnonymizeAudit({
      kind: "customer.anonymize.medusa.failed",
      payload,
      durationMs: Date.now() - startedAt,
      rule: "medusa_scrub_failed",
      err,
      log,
    });
    return { kind: "failed", customerId, medusaId, err: err as Error };
  }

  log?.info(
    { customerId, medusaId, parkedIntentHash, attempt: payload.attempt },
    "[customer-anonymize-medusa-resolver] Medusa customer scrubbed",
  );

  // Clear the pending entry so the retry job stops sweeping for this
  // customer. Best-effort — TTL would GC eventually anyway, but explicit
  // clear makes the timeline visible in Redis.
  await clearMedusaAnonymizePending(customerId, log);

  emitMedusaAnonymizeAudit({
    kind: "customer.anonymize.medusa.confirmed",
    payload,
    durationMs: Date.now() - startedAt,
    rule: "medusa_scrub_succeeded",
    log,
  });

  return { kind: "confirmed", customerId, medusaId };
}

interface EmitAuditArgs {
  readonly kind:
    | "customer.anonymize.medusa.confirmed"
    | "customer.anonymize.medusa.failed";
  readonly payload: MedusaAnonymizePayload;
  readonly durationMs: number;
  readonly rule: string;
  readonly err?: unknown;
  readonly log?: FastifyBaseLogger;
}

/**
 * Emit a confirmed/failed audit record. Best-effort — the destructive op
 * (or its failure) is already realized regardless of whether the audit
 * sink accepts the write. Mirrors the anonymize-grace-resolver pattern.
 *
 * `supersedes` chains back to the originating `customer.anonymize`
 * envelope (the parked intent that triggered the whole flow) so audit
 * replay can follow the chain end-to-end.
 */
function emitMedusaAnonymizeAudit(args: EmitAuditArgs): void {
  const { kind, payload, durationMs, rule, err, log } = args;
  try {
    const envelope = buildSystemEnvelope({
      kind,
      payload: {
        customerId: payload.customerId,
        medusaId: payload.medusaId,
        attempt: payload.attempt,
      },
      sourceSubject: "customer.anonymize.medusa.pending",
      eventId: `${payload.parkedIntentHash}:${kind}:${payload.attempt}`,
    });
    const record = buildAuditRecord({
      envelope,
      decision: {
        kind: "EXECUTE",
        basis: [
          {
            category: "business",
            code:
              kind === "customer.anonymize.medusa.confirmed"
                ? BASIS_CODES.business.RULE_SATISFIED
                : BASIS_CODES.business.RULE_VIOLATED,
            detail: {
              rule,
              kind,
              attempt: payload.attempt,
              ...(err !== undefined
                ? { errorMessage: (err as Error).message ?? String(err) }
                : {}),
            },
          },
        ],
      },
      durationMs,
      supersedes: {
        predecessorIntentHash: payload.parkedIntentHash,
        predecessorAt: payload.parkedAt,
        reason: "defer_resumed",
      },
    });
    void getAuditSink()
      .emit(record)
      .catch((emitErr: unknown) => {
        log?.warn(
          {
            customerId: payload.customerId,
            kind,
            err: (emitErr as Error).message,
          },
          "[customer-anonymize-medusa-resolver] audit emit failed",
        );
      });
  } catch (buildErr) {
    log?.warn(
      {
        customerId: payload.customerId,
        kind,
        err: (buildErr as Error).message,
      },
      "[customer-anonymize-medusa-resolver] audit record build failed",
    );
  }
}

/**
 * Wire the subscriber to NATS. Called from `apps/api/src/index.ts`
 * alongside the other startup-phase subscribers.
 *
 * Per-event errors are swallowed by the handler; we do not let one bad
 * payload take down the subscription. `subscribeNatsEvent` is
 * fire-and-forget on the receive side.
 */
export async function startCustomerAnonymizeMedusaResolverSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent(
    "customer.anonymize.medusa.pending",
    async (rawPayload) => {
      try {
        const payload = rawPayload as unknown as MedusaAnonymizePayload;
        await handleMedusaAnonymizePending(payload, log);
      } catch (err) {
        log?.error(
          { err: (err as Error).message },
          "[customer-anonymize-medusa-resolver] unexpected handler error",
        );
      }
    },
    { queueGroup: "customer-anonymize-medusa-resolver" },
  );
  log?.info(
    "[customer-anonymize-medusa-resolver] Subscriber started",
  );
}

// Internal exports for unit testing. Not part of the public API.
export const _customerAnonymizeMedusaInternals = {
  MEDUSA_ANONYMIZE_PATCH_BODY,
} as const;

// Re-export so tests can spy on the publish path without depending on
// the nats-client module directly (the mock surface lives there).
export { publishNatsEvent as _publishForTests };
