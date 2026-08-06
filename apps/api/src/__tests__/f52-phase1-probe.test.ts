/**
 * F-52 PHASE 1 — CHARACTERIZATION OF A DEFECT. Nothing here endorses the
 * behaviour it pins; every assertion records what production DOES today so the
 * owner can rule on the fix. NOT proposed for merge as-is.
 *
 * QUESTION: is the B1 agent-refund-confirm rule (@adjudicate/pack-payments-pix)
 * in the PolicyBundle that adjudicates an agent-session `pix.charge.refund`?
 *
 * ANSWER: no. There are two rosters. The kernel INSTALL roster
 * (claustrum-bootstrap.ts:1493 `[...IBATEXAS_COMPOSED_PACKS, paymentsPixPack]`)
 * carries the pix pack; the POLICY ROUTER (claustrum-bootstrap.ts:1864-1870,
 * built from `IBATEXAS_COMPOSED_PACKS` alone) does not. The live agent plane
 * adjudicates through the ROUTER — `liveConductor.tenantResolver` is
 * `resolveIbatexasTenantPolicy`, whose `resolve()` returns
 * `policy: IBATEXAS_POLICY_ROUTER`, and @claustrum/core's conductor passes that
 * `resolution.policy` to every adjudicate / adjudicatePlan / resume call.
 *
 * ARM A reproduces the production composition verbatim.
 * ARM B is the CONTROL: identical envelope + identical state, through a router
 * that DOES carry the pix pack. It MUST reach REQUEST_CONFIRMATION — otherwise
 * Arm A's refusal would be attributable to the fixture rather than the roster.
 * The two arms differ in exactly one thing: whether the pix pack is present.
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { paymentsPixPack } from "@adjudicate/pack-payments-pix";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  composePolicyRouter,
  type CapabilityPolicyPack,
} from "../claustrum/capability-policy.js";

const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, "pay_001");

/** claustrum-bootstrap.ts:1864-1870 verbatim — the six composed packs, no pix. */
function productionRouter(): PolicyBundle<string, unknown, unknown> {
  return composePolicyRouter(
    buildIbatexasPolicyPacks(
      IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
    ) as unknown as ReadonlyArray<CapabilityPolicyPack>,
  );
}

/** CONTROL: the identical composition WITH the pix pack appended. */
function routerWithPix(): PolicyBundle<string, unknown, unknown> {
  return composePolicyRouter(
    buildIbatexasPolicyPacks([
      ...(IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>),
      paymentsPixPack as unknown as ErasedPack,
    ]) as unknown as ReadonlyArray<CapabilityPolicyPack>,
  );
}

function refundEnvelope(sessionId: string) {
  return buildEnvelope({
    kind: "pix.charge.refund",
    payload: { chargeId: "chg_001", refundCentavos: 1_000 },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "nonce-refund-1",
  });
}

/** State the pix pack's own guards accept: charge exists, confirmed, unrefunded. */
function refundState() {
  return {
    charges: new Map([
      [
        "chg_001",
        {
          chargeId: "chg_001",
          amountCentavos: 5_000,
          status: "confirmed",
          refundedCentavos: 0,
        },
      ],
    ]),
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      sessionTokensConsumed: 0,
    },
  };
}

describe("F-52 Phase 1 — the roster that adjudicates an agent refund", () => {
  it("CONTROL: with the pix pack in the router, B1 fires — REQUEST_CONFIRMATION", () => {
    const decision = adjudicate(
      refundEnvelope(AGENT_SESSION) as never,
      refundState() as never,
      routerWithPix(),
    );
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    // The B1 rule specifically — not merely "some confirmation". Without this
    // the arm would pass on the pack's amount-threshold confirm guard, which is
    // a DIFFERENT rule that a small refund would not have crossed.
    expect(
      decision.basis.some(
        (b) =>
          (b.detail as { rule?: string } | undefined)?.rule ===
          "agent_refund_confirm",
      ),
    ).toBe(true);
  });

  it("DEFECT: the production router REFUSEs the same envelope at the TAINT phase", () => {
    const decision = adjudicate(
      refundEnvelope(AGENT_SESSION) as never,
      refundState() as never,
      productionRouter(),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind === "REFUSE") {
      // Not a business refusal — the kind is UNOWNED, so it dies on the
      // unknown-kind SYSTEM taint floor (capability-policy.ts:54) before the
      // auth and business phases where B1 lives ever run.
      expect(decision.refusal.code).toBe("taint_level_insufficient");
    }
    // B1 never evaluated: no agent_refund_confirm basis anywhere.
    expect(
      decision.basis.some(
        (b) =>
          (b.detail as { rule?: string } | undefined)?.rule ===
          "agent_refund_confirm",
      ),
    ).toBe(false);
  });

  it("ROSTER: the production router does not own pix.charge.refund", () => {
    // An unowned kind gets the SYSTEM floor; an owned one gets the pack's own.
    expect(productionRouter().taint.minimumFor("pix.charge.refund")).toBe(
      "SYSTEM",
    );
    expect(routerWithPix().taint.minimumFor("pix.charge.refund")).toBe(
      "UNTRUSTED",
    );
    // No composed first-party pack declares the kind — the pix pack is its
    // only owner, and it is absent from the composed roster.
    expect(
      IBATEXAS_COMPOSED_PACKS.filter((p) =>
        (p.intents as ReadonlyArray<string>).includes("pix.charge.refund"),
      ),
    ).toEqual([]);
  });

  it("PRODUCTION SYMBOL: policyForKind returns null for the agent's money kind", async () => {
    const { policyForKind } = await import("../claustrum-bootstrap.js");
    expect(policyForKind("pix.charge.refund")).toBeNull();
    // Control for the lookup itself: a kind the router DOES own resolves.
    // Without this, `null` could mean "policyForKind is broken".
    expect(policyForKind("payment.refund.issue")).not.toBeNull();
  });
});
