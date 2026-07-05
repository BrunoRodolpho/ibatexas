// Escalation state + bot-pause (responder-trace-admin D2).
//
// When a turn ESCALATEs (support.handoff_requested), a human takes over the
// session. We need: (a) a queue of open escalations for staff; (b) a CHEAP
// per-session "paused for human" check on the hot path so the LLM stops
// auto-replying once a human is handling it. Per the plan this is backed by
// Redis (not a per-turn DB hit, and no Prisma migration): the escalation
// lifecycle is operational state, not the kernel audit ledger.
//
// Keys (via rk(), Hard Rule #7):
//   escalation:rec:<sessionId>  → JSON EscalationRecord
//   escalation:open             → SET of sessionIds with an OPEN escalation
//
// The pause is active for as long as the escalation is OPEN; resolving it
// un-pauses the session (the bot resumes auto-replying).

import { getRedisClient, rk } from "@ibatexas/tools";

/**
 * AUT-017 — the operator-facing projection of ONE parked, approval-pending money
 * intent riding on an escalation record. The FULL envelope lives (single-use) in
 * the escalation park store keyed by `token`; this is the read-model the
 * escalações UI renders + the OWNER resolves against. Lifecycle statuses:
 *   - `pending`         parked, awaiting an OWNER decision.
 *   - `approved`        OWNER approved, the resumed kernel verdict was EXECUTE,
 *                        AND the executor ran (money moved).
 *   - `rejected`        OWNER declined (accept=false) — nothing executed.
 *   - `denied_by_kernel` OWNER approved but the re-adjudication was NON-EXECUTE
 *                        (e.g. the payment moved to a terminal/partial/non-refundable
 *                        state since parking, or an integrity check failed) — the
 *                        kernel refused; nothing executed.
 *   - `execute_failed`  OWNER approved + the kernel EXECUTEd, but the executor was
 *                        missing or THREW — NO money moved. Distinct from `approved`
 *                        so the projection + `verifyEscalationApprovalLineage` never
 *                        bless a refund that did not run (AUT-017 FIX 4).
 *   - `expired`         the park TTL lapsed before a decision (advisory).
 */
export interface PendingEscalationIntent {
  readonly token: string;
  readonly intentKind: string;
  readonly intentHash: string;
  /** pt-BR one-liner (e.g. "reembolso de R$ 1.500,00"). */
  readonly summaryPtBr: string;
  readonly requestedAt: string;
  readonly status:
    | "pending"
    | "approved"
    | "rejected"
    | "denied_by_kernel"
    | "execute_failed"
    | "expired";
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

export interface EscalationRecord {
  readonly sessionId: string;
  readonly customerId: string | null;
  readonly reason: string | null;
  readonly channel: string | null;
  readonly handoffAt: string;
  readonly status: "open" | "resolved";
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  /**
   * AUT-017 — parked money intents awaiting OWNER approval on this session. Kept
   * ADDITIVE + optional so a record written before AUT-017 (no field) round-trips
   * unchanged. Per-envelope by intentHash (BKL-063: a future claustrum
   * multi-envelope handoff appends multiple rows — no ibatexas change needed).
   */
  readonly pendingIntents?: ReadonlyArray<PendingEscalationIntent>;
}

/** Minimal node-redis v4 surface the store uses (injectable for tests). */
export interface EscalationRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
}

export interface EscalationStore {
  /** Record (idempotently) that a session escalated to a human. */
  recordHandoff(input: {
    sessionId: string;
    customerId?: string | null;
    reason?: string | null;
    channel?: string | null;
    at: string;
  }): Promise<EscalationRecord>;
  get(sessionId: string): Promise<EscalationRecord | null>;
  /** Cheap hot-path check: is this session currently handled by a human? */
  isPaused(sessionId: string): Promise<boolean>;
  /** Resolve an open escalation → un-pauses the session. */
  resolve(
    sessionId: string,
    resolvedBy: string,
    at: string,
  ): Promise<EscalationRecord | null>;
  /** The open-escalation queue (newest handoff first). */
  listOpen(limit?: number): Promise<EscalationRecord[]>;
  /**
   * AUT-017 — append a parked money intent's projection to a session's record
   * (idempotent on `intentHash`: a NATS redelivery of the same handoff does not
   * duplicate the row). The record must already exist (the subscriber calls
   * `recordHandoff` first); a missing record is a no-op returning null.
   */
  appendPendingIntent(
    sessionId: string,
    intent: PendingEscalationIntent,
  ): Promise<EscalationRecord | null>;
  /**
   * AUT-017 — set the lifecycle status of a parked intent (idempotent on
   * `intentHash`). No-op returning null when the record or the intent is absent.
   */
  markIntentResolved(
    sessionId: string,
    intentHash: string,
    status: PendingEscalationIntent["status"],
    resolvedBy: string,
    at: string,
  ): Promise<EscalationRecord | null>;
  /**
   * BKL-114 — COMPARE-AND-SET a parked intent from `pending` → `expired` when its
   * backing park token has TTL-lapsed (queue hygiene; money is unaffected — a
   * lapsed token already 404s on resolve). The `status === "pending"` guard is
   * LOAD-BEARING: a consumed park (a successful resolve) and a lapsed park both
   * read as "gone" to the sweeper, so this flip must NEVER clobber an intent that
   * has since moved to `approved`/`rejected`/`denied_by_kernel`/`execute_failed`.
   * Re-reads the record so the compare is against CURRENT state, not the
   * sweeper's scan snapshot. Stamps `resolvedBy = "system"` for provenance.
   *
   * No-op returning null when the record or the intent is absent, OR when the
   * intent's current status is no longer `pending`. Deliberately NOT
   * `markIntentResolved` (which overwrites status unconditionally — unsafe here).
   */
  markIntentExpired(
    sessionId: string,
    intentHash: string,
    at: string,
  ): Promise<EscalationRecord | null>;
}

const OPEN_SET = (): string => rk("escalation:open");
const recKey = (sessionId: string): string => rk(`escalation:rec:${sessionId}`);

function parse(raw: string | null): EscalationRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EscalationRecord;
  } catch {
    return null;
  }
}

export function createEscalationStore(redis: EscalationRedis): EscalationStore {
  const store: EscalationStore = {
    async get(sessionId) {
      return parse(await redis.get(recKey(sessionId)));
    },

    async recordHandoff(input) {
      const existing = parse(await redis.get(recKey(input.sessionId)));
      // Idempotent on NATS redelivery: keep the original open record (handoffAt,
      // reason) rather than resetting it.
      if (existing?.status === "open") return existing;
      const rec: EscalationRecord = {
        sessionId: input.sessionId,
        customerId: input.customerId ?? null,
        reason: input.reason ?? null,
        channel: input.channel ?? null,
        handoffAt: input.at,
        status: "open",
      };
      await redis.set(recKey(input.sessionId), JSON.stringify(rec));
      await redis.sAdd(OPEN_SET(), input.sessionId);
      return rec;
    },

    async isPaused(sessionId) {
      const rec = parse(await redis.get(recKey(sessionId)));
      return rec?.status === "open";
    },

    async resolve(sessionId, resolvedBy, at) {
      const rec = parse(await redis.get(recKey(sessionId)));
      await redis.sRem(OPEN_SET(), sessionId);
      if (!rec) return null;
      const updated: EscalationRecord = {
        ...rec,
        status: "resolved",
        resolvedAt: at,
        resolvedBy,
      };
      await redis.set(recKey(sessionId), JSON.stringify(updated));
      return updated;
    },

    async listOpen(limit = 100) {
      const members = await redis.sMembers(OPEN_SET());
      const recs = await Promise.all(
        members.map((id) => redis.get(recKey(id)).then(parse)),
      );
      const open: EscalationRecord[] = [];
      for (let i = 0; i < members.length; i++) {
        const rec = recs[i];
        if (rec?.status === "open") {
          open.push(rec);
        } else {
          // Self-heal: a missing/resolved record left a stale set member.
          await redis.sRem(OPEN_SET(), members[i]!);
        }
      }
      open.sort((a, b) => (a.handoffAt < b.handoffAt ? 1 : -1));
      return open.slice(0, Math.max(0, limit));
    },

    async appendPendingIntent(sessionId, intent) {
      const rec = parse(await redis.get(recKey(sessionId)));
      if (!rec) return null;
      const existing = rec.pendingIntents ?? [];
      // Idempotent on intentHash — a NATS redelivery must not duplicate the row.
      if (existing.some((p) => p.intentHash === intent.intentHash)) return rec;
      const updated: EscalationRecord = {
        ...rec,
        pendingIntents: [...existing, intent],
      };
      await redis.set(recKey(sessionId), JSON.stringify(updated));
      return updated;
    },

    async markIntentResolved(sessionId, intentHash, status, resolvedBy, at) {
      const rec = parse(await redis.get(recKey(sessionId)));
      if (!rec) return null;
      const existing = rec.pendingIntents ?? [];
      const idx = existing.findIndex((p) => p.intentHash === intentHash);
      if (idx === -1) return null;
      const next = [...existing];
      next[idx] = { ...existing[idx]!, status, resolvedBy, resolvedAt: at };
      const updated: EscalationRecord = { ...rec, pendingIntents: next };
      await redis.set(recKey(sessionId), JSON.stringify(updated));
      return updated;
    },

    async markIntentExpired(sessionId, intentHash, at) {
      // Re-read CURRENT state — the compare-and-set is against live Redis, not
      // the sweeper's scan snapshot (which may be stale by the time we mark).
      const rec = parse(await redis.get(recKey(sessionId)));
      if (!rec) return null;
      const existing = rec.pendingIntents ?? [];
      const idx = existing.findIndex((p) => p.intentHash === intentHash);
      if (idx === -1) return null;
      // THE CAS GUARD — only a still-"pending" intent may lapse to "expired". A
      // row that raced to approved/rejected/denied_by_kernel/execute_failed since
      // the scan is left untouched (its park is legitimately gone via consume()).
      if (existing[idx]!.status !== "pending") return null;
      const next = [...existing];
      next[idx] = {
        ...existing[idx]!,
        status: "expired",
        resolvedBy: "system",
        resolvedAt: at,
      };
      const updated: EscalationRecord = { ...rec, pendingIntents: next };
      await redis.set(recKey(sessionId), JSON.stringify(updated));
      return updated;
    },
  };
  return store;
}

/** Lazily build a store over the shared redis client. */
export async function getEscalationStore(): Promise<EscalationStore> {
  const redis = (await getRedisClient()) as unknown as EscalationRedis;
  return createEscalationStore(redis);
}

/**
 * Hot-path bot-pause gate. Fail-CLOSED per SDD Invariant 7 ("safety-gate reads
 * fail CLOSED — read-error ≠ read-absence") and §E `HUMAN_HANDOFF_ACTIVE`
 * ("read-error → safe posture, never concrete `false`").
 *
 * This gate decides whether the bot may auto-reply. A read-error means the
 * pause state is UNKNOWN — the safety gate is *unreachable*, not *absent*. A
 * concrete `false` (bot keeps replying) would let the LLM talk over a human who
 * may be handling the session; that is the unsafe posture. So on ANY store/Redis
 * error we return `true` (treat the session as PAUSED — the safe posture).
 *
 * The store-reachable path is unchanged: a genuine "not paused" still returns
 * false and a genuine OPEN escalation still returns true. Only a read-ERROR is
 * coerced to the safe `true`; a read-ABSENCE (no record) is a real `false`.
 */
export async function isSessionPausedForHuman(sessionId: string): Promise<boolean> {
  try {
    const store = await getEscalationStore();
    return await store.isPaused(sessionId);
  } catch {
    // Fail-CLOSED (Inv 7 / §E): the safety gate is unreachable ⇒ assume PAUSED.
    return true;
  }
}
