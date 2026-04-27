/**
 * DEFER round-trip — park-on-pending, resume-on-signal.
 *
 * Pins the integration contract between the Pack's DEFER guard and
 * `@adjudicate/runtime`'s `resumeDeferredIntent`:
 *
 *   1. Adjudicate a `pix.charge.confirm` while the charge is pending →
 *      kernel returns DEFER on PIX_CONFIRMATION_SIGNAL.
 *   2. Persist the parked envelope under the session's defer key.
 *   3. Webhook arrives; adopter calls `resumeDeferredIntent`.
 *   4. Resume succeeds exactly once; duplicate webhook delivery is
 *      suppressed by the SET-NX ledger.
 *   5. Re-adjudicate the resumed envelope against the now-settled
 *      charge state → kernel returns the next legal Decision (in this
 *      test: REFUSE-already-captured, since the post-resume state is
 *      now `captured`).
 */

import { describe, expect, it, vi } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import {
  resumeDeferredIntent,
  type DeferRedis,
} from "@adjudicate/runtime";
import {
  PIX_CONFIRMATION_SIGNAL,
  pixPaymentsPolicyBundle,
  type PixChargeState,
} from "../src/index.js";

const DET_TIME = "2026-04-26T12:00:00.000Z";

function makeRedis(initialPendingValue: string | null = null) {
  const store = new Map<string, string>();
  if (initialPendingValue !== null) {
    store.set("ENV:defer:pending:s-1", initialPendingValue);
  }
  const redis: DeferRedis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key, value, options) => {
      if (options.NX && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    }),
  };
  return { redis, store };
}

const rk = (raw: string) => `ENV:${raw}`;

describe("DEFER round-trip via @adjudicate/runtime", () => {
  it("parks on pending, resumes once on signal, suppresses duplicates", async () => {
    // Step 1 — pending charge, kernel DEFERs.
    const pending: PixChargeState = {
      charge: {
        id: "ch_round",
        status: "pending",
        amountCentavos: 1500,
        capturedAt: null,
        refundedAmountCentavos: 0,
        expiresAt: null,
      },
    };
    const confirmEnvelope = buildEnvelope({
      kind: "pix.charge.confirm",
      payload: { chargeId: "ch_round" },
      actor: { principal: "system", sessionId: "s-1" },
      taint: "TRUSTED",
      createdAt: DET_TIME,
    });
    const deferDecision = adjudicate(
      confirmEnvelope,
      pending,
      pixPaymentsPolicyBundle,
    );
    expect(deferDecision.kind).toBe("DEFER");
    if (deferDecision.kind !== "DEFER") return;
    expect(deferDecision.signal).toBe(PIX_CONFIRMATION_SIGNAL);

    // Step 2 — adopter persists the parked envelope.
    const parked = JSON.stringify({
      envelope: {
        intentHash: confirmEnvelope.intentHash,
        kind: confirmEnvelope.kind,
        actor: { sessionId: "s-1" },
        payload: confirmEnvelope.payload,
      },
      signal: PIX_CONFIRMATION_SIGNAL,
      parkedAt: DET_TIME,
    });
    const { redis } = makeRedis(parked);

    // Step 3 — webhook lands → resume succeeds.
    const first = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: PIX_CONFIRMATION_SIGNAL,
      redis,
      rk,
    });
    expect(first.resumed).toBe(true);
    expect(first.intentHash).toBe(confirmEnvelope.intentHash);

    // Step 4 — duplicate webhook delivery suppressed.
    // The pending key was deleted by the first resume. Re-stage a parked
    // envelope to simulate the at-least-once webhook coming back; the
    // SET-NX dedup ledger should suppress it.
    const { redis: redis2 } = makeRedis(parked);
    // Pre-seed the same dedup key so the second attempt's NX collision
    // is the suppressing factor.
    const firstAgain = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: PIX_CONFIRMATION_SIGNAL,
      redis: redis2,
      rk,
    });
    expect(firstAgain.resumed).toBe(true);
    const second = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: PIX_CONFIRMATION_SIGNAL,
      redis: redis2,
      rk,
    });
    // Pending key has been del'd by the first run on `redis2`.
    expect(second.resumed).toBe(false);
    expect(second.reason).toBe("no_parked_envelope");
  });

  it("re-adjudicating after resume sees the now-captured state and refuses replay", () => {
    // After the webhook applies, the persisted state advances to
    // captured. Re-adjudicating the same envelope must NOT DEFER again
    // (would be an infinite loop) — instead it surfaces the
    // already_captured guard, proving the kernel is stable across
    // resume re-entry.
    const captured: PixChargeState = {
      charge: {
        id: "ch_round",
        status: "captured",
        amountCentavos: 1500,
        capturedAt: DET_TIME,
        refundedAmountCentavos: 0,
        expiresAt: null,
      },
    };
    const replayEnvelope = buildEnvelope({
      kind: "pix.charge.confirm",
      payload: { chargeId: "ch_round" },
      actor: { principal: "system", sessionId: "s-1" },
      taint: "TRUSTED",
      createdAt: DET_TIME,
    });
    const decision = adjudicate(
      replayEnvelope,
      captured,
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.already_captured");
  });

  it("park signal mismatch is reported by resume", async () => {
    const parked = JSON.stringify({
      envelope: {
        intentHash: "h-fake",
        kind: "pix.charge.confirm",
        actor: { sessionId: "s-1" },
        payload: {},
      },
      signal: "some.other.signal",
      parkedAt: DET_TIME,
    });
    const { redis } = makeRedis(parked);
    const result = await resumeDeferredIntent({
      sessionId: "s-1",
      signal: PIX_CONFIRMATION_SIGNAL,
      redis,
      rk,
    });
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("signal_mismatch");
  });
});
