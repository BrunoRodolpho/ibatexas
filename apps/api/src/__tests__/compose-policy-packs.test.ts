/**
 * compose-policy-packs — proves the post-prepend composition is identical to
 * the logic previously inlined in claustrum-bootstrap: the two adopter-level
 * business guards (F4 token-budget, confirm-on-autoresolve) are prepended to
 * EVERY pack's business phase, in order, before the pack's own business guards;
 * all other phases + pack identity are preserved untouched.
 *
 * This is the no-drift guarantee the policy-manifest exporter relies on.
 */

import { describe, expect, it } from "vitest";
import type { PackV0 } from "@adjudicate/core";
import { readGuardMetadata, type Guard, type PolicyBundle } from "@adjudicate/core/kernel";
import {
  buildIbatexasPolicyPacks,
  confirmOnAutoResolveGuard,
  sessionTokenBudgetGuard,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";

const ownGuard: Guard<string, unknown, unknown> = function ownBusinessGuard() {
  return null;
};

function mkPack(id: string, intents: string[]): ErasedPack {
  const policy: PolicyBundle<string, unknown, unknown> = {
    stateGuards: [function stateG() { return null; } as Guard<string, unknown, unknown>],
    authGuards: [function authG() { return null; } as Guard<string, unknown, unknown>],
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
  const composed = buildIbatexasPolicyPacks(packs, IBATEXAS_ADOPTER_BUSINESS_GUARDS);

  it("prepends the two adopter guards to every pack's business, in order", () => {
    for (const p of composed) {
      const business = (p.policy as PolicyBundle<string, unknown, unknown>).business;
      expect(business[0]).toBe(sessionTokenBudgetGuard);
      expect(business[1]).toBe(confirmOnAutoResolveGuard);
      expect(business[2]).toBe(ownGuard); // the pack's own guard, unmoved
      expect(business.length).toBe(3);
    }
  });

  it("the prepended guards carry their stable names (visible in audit/trace)", () => {
    const business = (composed[0]!.policy as PolicyBundle<string, unknown, unknown>).business;
    expect(readGuardMetadata(business[0]!)?.name).toBe("sessionTokenBudget");
    expect(readGuardMetadata(business[1]!)?.name).toBe("confirmOnAutoResolvedRef");
  });

  it("preserves state/auth/taint/default and pack identity untouched", () => {
    const src = packs[0]!.policy as PolicyBundle<string, unknown, unknown>;
    const out = composed[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(out.stateGuards).toBe(src.stateGuards);
    expect(out.authGuards).toBe(src.authGuards);
    expect(out.taint).toBe(src.taint);
    expect(out.default).toBe("REFUSE");
    expect(composed[0]!.id).toBe("ibatexas/pack-a");
    expect(composed[0]!.version).toBe("1.2.3");
    expect([...composed[0]!.intents]).toEqual(["a.x"]);
  });

  it("defaults to the two adopter guards when none are passed", () => {
    const def = buildIbatexasPolicyPacks(packs);
    const business = (def[0]!.policy as PolicyBundle<string, unknown, unknown>).business;
    expect(business[0]).toBe(sessionTokenBudgetGuard);
    expect(business[1]).toBe(confirmOnAutoResolveGuard);
  });
});
