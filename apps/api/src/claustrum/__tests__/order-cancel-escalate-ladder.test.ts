/**
 * order-cancel-escalate-ladder.test.ts — FE-D29 / FE-T12 seam verification
 * (team-lead ruling): proves the order.cancel money-ladder (`gatePaidCancel`/
 * `escalateLargeCancel`, pack-orders/src/policies.ts, BYTE-UNTOUCHED) is
 * TWO-STEP through the REAL, FULLY-COMPOSED policy chain — adopter-level
 * guards (apps/api/src/claustrum/compose-policy-packs.ts's
 * `confirmOnAutoResolveGuard` et al.) PREPENDED to pack-orders' own guards,
 * exactly as `buildIbatexasPolicyPacks` composes them in production. NOT a
 * mock, NOT a reimplementation — the SAME `composePolicyRouter(
 * buildIbatexasPolicyPacks(IBATEXAS_COMPOSED_PACKS))` the ops e2e harness
 * (src/ops/__tests__/ops-e2e-harness.ts) uses as its own `OPS_ROUTER`,
 * adjudicated via the REAL kernel `adjudicate()`.
 *
 * THE HYPOTHESIS UNDER TEST (team-lead): `order.cancel`'s schema has no
 * order-reference field (order-cancel.schema.ts), so `orderId` is ALWAYS
 * auto-resolved on the FIRST (park) turn — `ctx.autoResolvedMoneyRef` is
 * true, `confirmOnAutoResolveGuard` (prepended to EVERY pack's business
 * phase, matches `order.cancel` via `AUTORESOLVE_CONFIRM_KINDS`) fires
 * FIRST and short-circuits to REQUEST_CONFIRMATION — `gatePaidCancel`/
 * `escalateLargeCancel` never evaluate on THIS turn (live-caught: see the
 * PR body / FE-D29). On RESUME (the customer's "sim"), T05b's proven
 * mechanism re-runs `resolveAndAssemble` on the PARKED payload, which by
 * then carries the THREADED EXPLICIT `orderId` — `autoResolvedMoneyRef` is
 * FALSE on this pass, `confirmOnAutoResolveGuard` does not fire, and
 * `gatePaidCancel`/`escalateLargeCancel` DO evaluate. So the real chain is
 * TWO steps: confirm(target) -> ESCALATE(money) on "sim" — not a dead
 * guard, not a broken ladder.
 *
 * This file tests BOTH halves of that claim directly at the seam (no live
 * drive needed — and FE-D19 blocks web-channel confirm-resume anyway, so a
 * live E2E proof of the SECOND half isn't currently possible on this
 * channel; see the PR body's FE-D19 caveat):
 *   1. auto-resolved (ctx.autoResolvedMoneyRef: true) -> REQUEST_CONFIRMATION,
 *      even for a high-value/paid order (mirrors what pass-1/pass-2 live
 *      calibration actually observed at the park).
 *   2. explicit orderId (ctx.autoResolvedMoneyRef: false/absent — the exact
 *      ctx shape a resume produces) -> ESCALATE with the paid_cancel/
 *      escalate-ladder basis, for both an UNPAID large cancel
 *      (`escalateLargeCancel`) and a PAID large cancel (`gatePaidCancel`'s
 *      high band), at the R$1000 exact boundary and above it.
 *
 * If EITHER half refutes the hypothesis (auto-resolved case doesn't park,
 * or explicit-id case still confirms/executes instead of escalating), that
 * is a REAL governance hole, not just a corpus-labeling question — see the
 * PR body / FE-D29 for the reporting protocol this file's result feeds.
 */

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import type { OrderIntentKind, OrderPayload, OrderState } from "@ibatexas/pack-orders";
import { buildIbatexasPolicyPacks, type ErasedPack } from "../compose-policy-packs.js";
import { composePolicyRouter } from "../capability-policy.js";

// The EXACT composed router production adjudicates every turn against —
// mirrors ops-e2e-harness.ts's OPS_ROUTER precisely (same composition call),
// just not wrapped in the ops-specific conductor/turn machinery: this file
// only needs the POLICY decision for a given envelope+state, not a full
// conversational turn.
const ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

function cancelEnvelope(
  payload: Record<string, unknown>,
): IntentEnvelope<OrderIntentKind, OrderPayload> {
  return buildEnvelope({
    kind: "order.cancel",
    payload: payload as OrderPayload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "UNTRUSTED",
    nonce: "n-test",
    createdAt: "2026-07-17T12:00:00.000Z",
  }) as IntentEnvelope<OrderIntentKind, OrderPayload>;
}

/** Mirrors packages/pack-orders/src/__tests__/orders-pack.test.ts's own `state()` helper shape. */
function cancelState(
  overrides: Partial<OrderState["ctx"]> & { autoResolvedMoneyRef?: boolean } = {},
): OrderState {
  const { autoResolvedMoneyRef, ...ctxOverrides } = overrides;
  return {
    ctx: {
      channel: "web",
      customerId: "c-1",
      cartId: null,
      orderId: "order_1",
      fulfillmentStatus: "confirmed",
      paymentStatus: "paid",
      totalInCentavos: 5_000,
      lastAction: null,
      ...(autoResolvedMoneyRef === undefined ? {} : { autoResolvedMoneyRef }),
      ...ctxOverrides,
    },
  } as unknown as OrderState;
}

describe("order.cancel escalate ladder — TWO-STEP through the REAL composed policy chain (FE-D29)", () => {
  describe("step 1 — PARK: an auto-resolved target ALWAYS confirms first, regardless of amount/payment status", () => {
    it("auto-resolved + R$1500 PAID (would be high-band ESCALATE if reached) still REQUEST_CONFIRMATIONs — confirmOnAutoResolveGuard short-circuits before gatePaidCancel ever runs", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "changed_mind" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: "paid",
          totalInCentavos: 150_000,
          autoResolvedMoneyRef: true,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });

    it("auto-resolved + R$2000 UNPAID (would be escalateLargeCancel if reached) still REQUEST_CONFIRMATIONs", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "changed_mind" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: null,
          totalInCentavos: 200_000,
          autoResolvedMoneyRef: true,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });
  });

  describe("step 2 — RESUME: an EXPLICIT orderId (autoResolvedMoneyRef false/absent, the exact ctx shape a resume produces per T05b) lets the money ladder evaluate", () => {
    it("explicit orderId + R$1000,00 EXACT PAID -> ESCALATE via gatePaidCancel's high band (the exact boundary my corpus's escalate-exact-threshold-boundary targets)", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "changed_mind" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: "paid",
          totalInCentavos: 100_000,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("ESCALATE");
      if (decision.kind !== "ESCALATE") return;
      expect(decision.to).toBe("human");
      expect(
        decision.basis.some(
          (b) =>
            (b as { detail?: { reason?: string } }).detail?.reason ===
            "paid_cancel_refund_above_escalate_threshold",
        ),
      ).toBe(true);
    });

    it("explicit orderId + R$1500,00 PAID -> ESCALATE via gatePaidCancel's high band (my corpus's escalate-paid-large-with-reason target)", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "mudei de ideia" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: "paid",
          totalInCentavos: 150_000,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("ESCALATE");
      if (decision.kind !== "ESCALATE") return;
      expect(decision.to).toBe("human");
    });

    it("explicit orderId + R$2000,00 UNPAID -> ESCALATE via escalateLargeCancel (proves the UNPAID arm survives the full composition too, not just the PAID one)", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "changed_mind" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: null,
          totalInCentavos: 200_000,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("ESCALATE");
      if (decision.kind !== "ESCALATE") return;
      expect(decision.to).toBe("human");
    });

    it("explicit orderId + R$50,00 PAID (below every threshold) -> REQUEST_CONFIRMATION via gatePaidCancel's low band, never ESCALATE, never silent EXECUTE — the ladder's floor still holds through the full composition", () => {
      const decision = adjudicate(
        cancelEnvelope({ orderId: "order_1", reason: "changed_mind" }),
        cancelState({
          orderId: "order_1",
          paymentStatus: "paid",
          totalInCentavos: 5_000,
        }),
        ROUTER,
      );
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });
  });
});
