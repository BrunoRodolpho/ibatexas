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
  sessionTokenBudgetGuard,
  IBATEXAS_ADOPTER_AUTH_GUARDS,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import { staffRoleGuard } from "../claustrum/staff-role-guard.js";

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

  it("prepends the two adopter guards to every pack's business, in order", () => {
    for (const p of composed) {
      const business = (p.policy as PolicyBundle<string, unknown, unknown>).business;
      expect(business[0]).toBe(sessionTokenBudgetGuard);
      expect(business[1]).toBe(confirmOnAutoResolveGuard);
      expect(business[2]).toBe(ownGuard); // the pack's own guard, unmoved
      expect(business).toHaveLength(3);
    }
  });

  it("prepends the adopter AUTH guards (kill switch, agent scope, per-agent budgets, then staff-role) to every pack's auth phase", () => {
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
      // The pack's own auth guard follows, unmoved.
      expect(auth[2 + agentBudgetGuards.length + 1]).toBe(ownAuthGuard);
      expect(auth).toHaveLength(IBATEXAS_ADOPTER_AUTH_GUARDS.length + 1);
    }
  });

  it("the prepended guards carry their stable names (visible in audit/trace)", () => {
    const bundle = composed[0]!.policy as PolicyBundle<string, unknown, unknown>;
    expect(readGuardMetadata(bundle.business[0]!)?.name).toBe("sessionTokenBudget");
    expect(readGuardMetadata(bundle.business[1]!)?.name).toBe("confirmOnAutoResolvedRef");
    expect(readGuardMetadata(bundle.authGuards[0]!)?.name).toBe("agentKillSwitch");
    expect(readGuardMetadata(bundle.authGuards[1]!)?.name).toBe("agentScope");
    for (const g of agentBudgetGuards) {
      expect(readGuardMetadata(g)?.name).toMatch(/^agentTokenBudget:/);
    }
    expect(
      readGuardMetadata(bundle.authGuards[2 + agentBudgetGuards.length]!)?.name,
    ).toBe("staffRole");
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
    expect(bundle.business[1]).toBe(confirmOnAutoResolveGuard);
    expect(bundle.authGuards[0]).toBe(agentKillSwitchGuard);
    expect(bundle.authGuards[1]).toBe(agentScopeGuard);
  });
});
