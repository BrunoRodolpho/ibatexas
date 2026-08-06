/**
 * B1 — an agent-session PIX refund must CONFIRM, and our adopter composition
 * must not weaken that.
 *
 * WHAT THIS PINS (a property, not a defect): the B1 rule in
 * `@adjudicate/pack-payments-pix` keys on the `agent:` sessionId NAMESPACE and
 * pre-empts the pack's amount thresholds, so a managed-agent refund adjudicates
 * to REQUEST_CONFIRMATION whatever the amount — and `buildIbatexasPolicyPacks`,
 * which prepends ibatexas' adopter guards AHEAD of every pack's own business
 * guards, must not change that outcome.
 *
 * WHY IT IS OURS TO TEST even though the rule ships in an external package: the
 * prepend is ours. `business: [...adopterBusinessGuards, ...base.business]` puts
 * our guards BEFORE `confirmAgentRefund`, and a guard that returned a decision
 * for this kind would pre-empt B1 silently. Nothing else in this repo drives
 * that composition against a money-moving agent envelope.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT: anything about whether the composed
 * production ROUTER owns `pix.charge.refund`. That is an open owner decision
 * (F-71); pinning today's answer either way would plant a test that reds the
 * moment the decision lands. Both arms below compose the pix pack explicitly, so
 * this file's meaning does not change under either ruling.
 *
 * THE CUSTOMER ARM IS THE POINT, not decoration: the same R$10 refund from a
 * non-agent session EXECUTEs. So B1 is load-bearing — without it this money
 * moves — and the agent arms are not passing for some ambient reason.
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope, type Decision } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { paymentsPixPack } from "@adjudicate/pack-payments-pix";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";

type Bundle = PolicyBundle<string, unknown, unknown>;

const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, "pay_001");
const CUSTOMER_SESSION = "sess_customer_123";

/** The pack's own bundle, no adopter guards. */
const barePixBundle = paymentsPixPack.policy as unknown as Bundle;

/** The PRODUCTION composition: adopter auth + business guards prepended. */
function composedPixBundle(): Bundle {
  return buildIbatexasPolicyPacks([paymentsPixPack as unknown as ErasedPack])[0]!
    .policy as Bundle;
}

/**
 * A refund small enough to sit BELOW the pack's amount-based confirm threshold.
 * That matters: if it were above, the threshold guard would produce
 * REQUEST_CONFIRMATION on its own and every assertion below would pass without
 * B1 existing at all.
 */
function refundEnvelope(sessionId: string) {
  return buildEnvelope({
    kind: "pix.charge.refund",
    payload: { chargeId: "chg_001", refundCentavos: 1_000 },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: `nonce-${sessionId}`,
  });
}

/** A charge the pack's state guards accept: present, confirmed, unrefunded. */
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

/** The `rule` names the decision's basis recorded — B1's is `agent_refund_confirm`. */
function basisRules(decision: Decision): string[] {
  return decision.basis
    .map((b) => (b.detail as { rule?: string } | undefined)?.rule)
    .filter((r): r is string => typeof r === "string");
}

function decide(bundle: Bundle, sessionId: string): Decision {
  return adjudicate(
    refundEnvelope(sessionId) as never,
    refundState() as never,
    bundle,
  );
}

describe("B1 — agent-session PIX refunds confirm, under our composition", () => {
  it("bare pack: an agent-session refund REQUEST_CONFIRMATIONs on the B1 rule", () => {
    const decision = decide(barePixBundle, AGENT_SESSION);
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    // By NAME. "some confirmation" would also be satisfied by the amount
    // threshold guard, which is a different rule entirely.
    expect(basisRules(decision)).toContain("agent_refund_confirm");
  });

  it("PARITY: the production adopter prepend does not weaken B1", () => {
    const bare = decide(barePixBundle, AGENT_SESSION);
    const composed = decide(composedPixBundle(), AGENT_SESSION);
    expect(composed.kind).toBe(bare.kind);
    expect(basisRules(composed)).toContain("agent_refund_confirm");
    // An adopter guard prepended ahead of confirmAgentRefund that returned any
    // decision for this kind would pre-empt B1 and break this equality.
    expect(composed.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("CONTROL: the identical refund from a NON-agent session EXECUTEs", () => {
    const decision = decide(composedPixBundle(), CUSTOMER_SESSION);
    // Same kind, same amount, same state — only the session namespace differs.
    // This is what makes the arms above meaningful: B1 is the only thing
    // standing between an agent and this money moving.
    expect(decision.kind).toBe("EXECUTE");
    expect(basisRules(decision)).not.toContain("agent_refund_confirm");
  });

  it("the agent's session id really carries the namespace B1 matches", () => {
    // If agentSessionId ever stopped emitting the `agent:` prefix, the arms
    // above would silently become customer-session tests that happen to pass
    // for the wrong reason.
    expect(AGENT_SESSION.startsWith("agent:")).toBe(true);
    expect(CUSTOMER_SESSION.startsWith("agent:")).toBe(false);
  });
});
