/**
 * compose-policy-packs — proves the post-prepend composition is identical to
 * the logic previously inlined in claustrum-bootstrap: the two adopter-level
 * business guards (F4 token-budget, confirm-on-autoresolve) are prepended to
 * EVERY pack's business phase, and the adopter-level AUTH guards (T3-4 agent
 * scope + per-agent budget) to EVERY pack's auth phase — in order, before the
 * pack's own guards; all other phases + pack identity are preserved untouched.
 *
 * This is the no-drift guarantee the policy-manifest exporter relies on.
 */

import { describe, expect, it } from "vitest";
import type { PackV0 } from "@adjudicate/core";
import { readGuardMetadata, type Guard, type PolicyBundle } from "@adjudicate/core/kernel";
import {
  agentKillSwitchGuard,
  agentScopeGuard,
  agentBudgetGuards,
  buildIbatexasPolicyPacks,
  confirmOnAutoResolveGuard,
  refuseAllergenMentionGuard,
  refuseUnresolvedAmendItemGuard,
  refuseUnresolvedReviewProductGuard,
  sessionTokenBudgetGuard,
  IBATEXAS_ADOPTER_AUTH_GUARDS,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  orderStatusTransitionBandGuard,
  paymentTransitionBandGuard,
  staffRoleGuard,
} from "../claustrum/staff-role-guard.js";

const ownGuard: Guard<string, unknown, unknown> = function ownBusinessGuard() {
  return null;
};
const ownAuthGuard: Guard<string, unknown, unknown> = function ownAuthGuard() {
  return null;
};

function mkPack(id: string, intents: string[]): ErasedPack {
  const policy: PolicyBundle<string, unknown, unknown> = {
    stateGuards: [function stateG() { return null; } as Guard<string, unknown, unknown>],
    authGuards: [ownAuthGuard],
    business: [ownGuard],
    taint: { minimumFor: () => "UNTRUSTED" },
    default: "REFUSE",
  };
  return {
    id,
    version: "1.2.3",
    contract: "v0",
    intents,
    basisCodes: [`${id}.code`],
    signals: [],
    policy,
    planner: { plan: () => ({ visibleReadTools: [], allowedIntents: [] }) },
  } as unknown as PackV0<string, unknown, unknown, unknown>;
}

describe("buildIbatexasPolicyPacks", () => {
  const packs = [mkPack("ibatexas/pack-a", ["a.x"]), mkPack("ibatexas/pack-b", ["b.y"])];
  const composed = buildIbatexasPolicyPacks(packs);

  it("prepends the five adopter guards to every pack's business, in order", () => {
    for (const p of composed) {
      const business = (p.policy as PolicyBundle<string, unknown, unknown>).business;
      expect(business[0]).toBe(sessionTokenBudgetGuard);
      // FE-T14 — allergen-mention honesty sits after token-budget; FE-D18 —
      // unresolved amend-item honesty follows it; FE-D28 — unresolved
      // review-product honesty follows that; and ALL THREE REFUSE honesty
      // guards precede confirm-on-autoresolve so the "REFUSE pre-empts a
      // softer decision" ladder holds (order.amend.add_item AND
      // order.review.submit are in AUTORESOLVE_CONFIRM_KINDS). See
      // IBATEXAS_ADOPTER_BUSINESS_GUARDS's own doc comment for the
      // ladder-discipline reasoning.
      expect(business[1]).toBe(refuseAllergenMentionGuard);
      expect(business[2]).toBe(refuseUnresolvedAmendItemGuard);
      expect(business[3]).toBe(refuseUnresolvedReviewProductGuard);
      expect(business[4]).toBe(confirmOnAutoResolveGuard);
      expect(business[5]).toBe(ownGuard); // the pack's own guard, unmoved
      expect(business).toHaveLength(6);
    }
  });

  it("prepends the adopter AUTH guards (kill switch, agent scope, per-agent budgets, staff-role, then payment + order banding) to every pack's auth phase", () => {
    for (const p of composed) {
      const auth = (p.policy as PolicyBundle<string, unknown, unknown>).authGuards;
      // T3-5: a killed agent REFUSEs before scope/budget are even considered.
      expect(auth[0]).toBe(agentKillSwitchGuard);
      expect(auth[1]).toBe(agentScopeGuard);
      for (const [i, budgetGuard] of agentBudgetGuards.entries()) {
        expect(auth[2 + i]).toBe(budgetGuard);
      }
      // BKL-069 Part C: the staff-plane role guard is appended after the agent
      // guards (disjoint namespace — `admin:` vs `agent:`).
      expect(auth[2 + agentBudgetGuards.length]).toBe(staffRoleGuard);
      // BKL-075: the payment.status.transition banding companion follows staffRole.
      expect(auth[2 + agentBudgetGuards.length + 1]).toBe(paymentTransitionBandGuard);
      // BKL-131: the order.status.transition (reject) banding companion follows it.
      expect(auth[2 + agentBudgetGuards.length + 2]).toBe(orderStatusTransitionBandGuard);
      // The pack's own auth guard follows, unmoved.
      expect(auth[2 + agentBudgetGuards.length + 3]).toBe(ownAuthGuard);
      expect(auth).toHaveLength(IBATEXAS_ADOPTER_AUTH_GUARDS.length + 1);
    }
  });

  it("the prepended guards carry their stable names (visible in audit/trace)", () => {
    const bundle = composed[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(readGuardMetadata(bundle.business[0]!)?.name).toBe("sessionTokenBudget");
    expect(readGuardMetadata(bundle.business[1]!)?.name).toBe("refuseAllergenMention");
    expect(readGuardMetadata(bundle.business[2]!)?.name).toBe("refuseUnresolvedAmendItem");
    expect(readGuardMetadata(bundle.business[3]!)?.name).toBe("refuseUnresolvedReviewProduct");
    expect(readGuardMetadata(bundle.business[4]!)?.name).toBe("confirmOnAutoResolvedRef");
    expect(readGuardMetadata(bundle.authGuards[0]!)?.name).toBe("agentKillSwitch");
    expect(readGuardMetadata(bundle.authGuards[1]!)?.name).toBe("agentScope");
    for (const g of agentBudgetGuards) {
      expect(readGuardMetadata(g)?.name).toMatch(/^agentTokenBudget:/);
    }
    expect(
      readGuardMetadata(bundle.authGuards[2 + agentBudgetGuards.length]!)?.name,
    ).toBe("staffRole");
    expect(
      readGuardMetadata(bundle.authGuards[2 + agentBudgetGuards.length + 1]!)?.name,
    ).toBe("paymentTransitionBand");
    expect(
      readGuardMetadata(bundle.authGuards[2 + agentBudgetGuards.length + 2]!)?.name,
    ).toBe("orderStatusTransitionBand");
  });

  it("preserves state/taint/default and pack identity untouched", () => {
    const src = packs[0]!.policy as PolicyBundle<string, unknown, unknown>;
    const out = composed[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(out.stateGuards).toBe(src.stateGuards);
    expect(out.taint).toBe(src.taint);
    expect(out.default).toBe("REFUSE");
    expect(composed[0]!.id).toBe("ibatexas/pack-a");
    expect(composed[0]!.version).toBe("1.2.3");
    expect([...composed[0]!.intents]).toEqual(["a.x"]);
  });

  it("explicit guard lists override the defaults for both phases", () => {
    const custom = buildIbatexasPolicyPacks(packs, [ownGuard], []);
    const bundle = custom[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(bundle.business[0]).toBe(ownGuard);
    expect(bundle.business).toHaveLength(2);
    expect(bundle.authGuards).toEqual([ownAuthGuard]);
  });

  it("defaults to the adopter guard sets when none are passed", () => {
    const def = buildIbatexasPolicyPacks(packs);
    const bundle = def[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(bundle.business[0]).toBe(sessionTokenBudgetGuard);
    expect(bundle.business[1]).toBe(refuseAllergenMentionGuard);
    expect(bundle.business[2]).toBe(refuseUnresolvedAmendItemGuard);
    expect(bundle.business[3]).toBe(refuseUnresolvedReviewProductGuard);
    expect(bundle.business[4]).toBe(confirmOnAutoResolveGuard);
    expect(bundle.authGuards[0]).toBe(agentKillSwitchGuard);
    expect(bundle.authGuards[1]).toBe(agentScopeGuard);
  });
});

// ── FE-T14 — refuseAllergenMentionGuard ──────────────────────────────────

describe("refuseAllergenMentionGuard", () => {
  function mkEnvelope(kind: string): { kind: string; payload: Record<string, unknown> } {
    return { kind, payload: {} };
  }

  it("REFUSEs a customer.preferences.update envelope when ctx.allergenMentionDetected is true", () => {
    const decision = refuseAllergenMentionGuard(
      mkEnvelope("customer.preferences.update") as never,
      { ctx: { allergenMentionDetected: true } } as never,
    );
    expect(decision).not.toBeNull();
    expect(decision?.kind).toBe("REFUSE");
  });

  it("passes through (null) when ctx.allergenMentionDetected is absent", () => {
    const decision = refuseAllergenMentionGuard(
      mkEnvelope("customer.preferences.update") as never,
      { ctx: {} } as never,
    );
    expect(decision).toBeNull();
  });

  it("is INERT for every other kind, even with the flag set", () => {
    const decision = refuseAllergenMentionGuard(
      mkEnvelope("order.note.add") as never,
      { ctx: { allergenMentionDetected: true } } as never,
    );
    expect(decision).toBeNull();
  });
});

// ── FE-D18 — refuseUnresolvedAmendItemGuard ───────────────────────────────

describe("refuseUnresolvedAmendItemGuard", () => {
  function mkEnvelope(kind: string): { kind: string; payload: Record<string, unknown> } {
    return { kind, payload: {} };
  }

  it("REFUSEs an order.amend.add_item envelope when ctx.amendItemUnresolved is true, with an honest pt-BR reply", () => {
    const decision = refuseUnresolvedAmendItemGuard(
      mkEnvelope("order.amend.add_item") as never,
      { ctx: { amendItemUnresolved: true } } as never,
    );
    expect(decision).not.toBeNull();
    expect(decision?.kind).toBe("REFUSE");
    // Hard Rule #4: user-facing text is pt-BR and honest (no fabricated "found").
    const refusal = (decision as { refusal?: { userFacing?: string } }).refusal;
    expect(refusal?.userFacing).toContain("Não encontrei esse item no cardápio");
  });

  it("passes through (null) when ctx.amendItemUnresolved is absent — the resume leg carries the resolved variantId", () => {
    const decision = refuseUnresolvedAmendItemGuard(
      mkEnvelope("order.amend.add_item") as never,
      { ctx: {} } as never,
    );
    expect(decision).toBeNull();
  });

  it("is INERT for every other kind, even with the flag set", () => {
    const decision = refuseUnresolvedAmendItemGuard(
      mkEnvelope("order.item.add") as never,
      { ctx: { amendItemUnresolved: true } } as never,
    );
    expect(decision).toBeNull();
  });

  // The load-bearing ordering pin: order.amend.add_item is in
  // AUTORESOLVE_CONFIRM_KINDS, so confirmOnAutoResolveGuard WOULD fire on the
  // same envelope. Because the REFUSE guard sits earlier in the business array,
  // the kernel evaluates it first and REFUSEs pre-park — the confirm never
  // dishonestly implies the item was found.
  it("sits BEFORE confirmOnAutoResolveGuard in the adopter business ladder (REFUSE pre-empts the confirm-park)", () => {
    const refuseIdx = IBATEXAS_ADOPTER_BUSINESS_GUARDS.indexOf(refuseUnresolvedAmendItemGuard);
    const confirmIdx = IBATEXAS_ADOPTER_BUSINESS_GUARDS.indexOf(confirmOnAutoResolveGuard);
    expect(refuseIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    expect(refuseIdx).toBeLessThan(confirmIdx);
  });
});


// BKL-197 — the customer autoresolve confirm prompt must NOT call an ORDER an
// "item", and must stay honest to the most-recent resolution it performs.
describe("confirmOnAutoResolveGuard — BKL-197 prompt (pedido, not item)", () => {
  const fire = (kind: string) =>
    (confirmOnAutoResolveGuard as unknown as (
      env: { kind: string; payload: unknown },
      state: { ctx: { autoResolvedMoneyRef: boolean } },
    ) => { kind: string; prompt?: string } | null)(
      { kind, payload: {} },
      { ctx: { autoResolvedMoneyRef: true } },
    );

  it("REQUEST_CONFIRMATIONs an autoresolved amend with a 'pedido' prompt (never 'item mais recente')", () => {
    const d = fire("order.amend.add_item");
    expect(d?.kind).toBe("REQUEST_CONFIRMATION");
    expect(d?.prompt).toContain("pedido");
    expect(d?.prompt).not.toContain("item mais recente");
    expect(d?.prompt).toContain("mais recente"); // honest to the most-recent resolution
  });

  it("does not fire when the ref was not autoresolved (byte-identical no-op)", () => {
    const d = (confirmOnAutoResolveGuard as unknown as (
      env: { kind: string; payload: unknown },
      state: { ctx: { autoResolvedMoneyRef?: boolean } },
    ) => unknown)({ kind: "order.amend.add_item", payload: {} }, { ctx: {} });
    expect(d).toBeNull();
  });
});
