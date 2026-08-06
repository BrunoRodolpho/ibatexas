import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import { paymentsPixPack } from "@adjudicate/pack-payments-pix";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";

const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, "pay_001");

function refundEnvelope() {
  return buildEnvelope({
    kind: "pix.charge.refund",
    payload: { chargeId: "chg_001", refundCentavos: 1_000 },
    actor: { principal: "llm", sessionId: AGENT_SESSION },
    taint: "UNTRUSTED",
    nonce: "nonce-refund-1",
  });
}

const charge = {
  chargeId: "chg_001",
  amountCentavos: 5_000,
  status: "confirmed",
  refundedCentavos: 0,
};

/** My fixture: charges as a MAP, plus the ctx wrapper adopter guards read. */
function mapState() {
  return {
    charges: new Map([["chg_001", charge]]),
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      sessionTokensConsumed: 0,
    },
  };
}

/** The scenarios/*.json shape: charges as a PLAIN OBJECT, no ctx. */
function jsonScenarioState() {
  return { charges: { chg_001: charge } };
}

describe("F-52 instrument validity", () => {
  it("LEAD'S CONTROL: bare pack, NO adopter prepend — must be SANE, not guard_panic", () => {
    const d = adjudicate(
      refundEnvelope() as never,
      mapState() as never,
      paymentsPixPack.policy as never,
    );
    // eslint-disable-next-line no-console
    console.log("BARE PACK decision:", d.kind, JSON.stringify((d as { refusal?: unknown }).refusal ?? ""));
    expect(d.kind).not.toBe("REFUSE");
    expect(d.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("REPRODUCES THE VOID: the scenarios/*.json state shape panics the same guard", () => {
    const d = adjudicate(
      refundEnvelope() as never,
      jsonScenarioState() as never,
      paymentsPixPack.policy as never,
    );
    // eslint-disable-next-line no-console
    console.log("JSON-SHAPE decision:", d.kind, JSON.stringify((d as { refusal?: unknown }).refusal ?? ""));
    expect(d.kind).toBe("REFUSE");
  });
});
