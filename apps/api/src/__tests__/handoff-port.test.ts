// T3-8 — HandoffPort wiring (ESCALATE → staff notification).
//
// Own acceptance (plan-v2 §5 T3-8): an ESCALATE decision's
// capsule.handoff.queue(envelope, reason) publishes the support.handoff_requested
// notification artifact (consumed by handoff-subscriber → WhatsApp staff alert).
// queue() must NEVER throw — the kernel dispatcher catches a throw as
// handoff_threw and would mask the ESCALATE.
//
// (JOURNEY-003 stays blocked on chat-confirmation-resume — T3-8 closes only the
// handoff-port-noop gap.)

import { describe, expect, it } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { natsHandoff } from "../claustrum-bootstrap.js";

function escalatedEnvelope(sessionId: string): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_900" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "n-handoff",
  });
}

describe("natsHandoff — ESCALATE → support.handoff_requested", () => {
  it("publishes the notification artifact with sessionId, reason, intentKind", async () => {
    const published: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const port = natsHandoff(async (event, payload) => {
      published.push({ event, payload });
    });

    await port.queue(escalatedEnvelope("cust_001"), "needs human judgment");

    expect(published).toHaveLength(1);
    expect(published[0]!.event).toBe("support.handoff_requested");
    expect(published[0]!.payload).toMatchObject({
      sessionId: "cust_001",
      reason: "needs human judgment",
      intentKind: "order.cancel",
    });
  });

  it("passes an agent-namespaced sessionId through as the correlation key", async () => {
    const published: Array<{ payload: Record<string, unknown> }> = [];
    const port = natsHandoff(async (_event, payload) => {
      published.push({ payload });
    });
    const agentSession = "agent:pix-payment-failure-remediation@0.1.0:entity:ord_900";

    await port.queue(escalatedEnvelope(agentSession), "agent escalation");

    expect(published[0]!.payload.sessionId).toBe(agentSession);
  });

  it("NEVER throws when the publish fails (dispatcher would mask ESCALATE otherwise)", async () => {
    const port = natsHandoff(async () => {
      throw new Error("NATS down");
    });
    await expect(
      port.queue(escalatedEnvelope("cust_001"), "x"),
    ).resolves.toBeUndefined();
  });
});

// ── AUT-017 — the ESCALATE park seam ─────────────────────────────────────────

/** An above-threshold staff refund (a RESUMABLE escalation kind). */
function refundEnvelope(sessionId: string): IntentEnvelope {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: {
      paymentId: "pay_1",
      refundAmountCentavos: 150_000,
      refundableBalanceCentavos: 500_000,
      amountInCentavos: 500_000,
      currentRefundedCentavos: 0,
      actor: "admin",
      actorId: "owner1",
    },
    actor: { principal: "user", sessionId, role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-refund-park",
  });
}

describe("natsHandoff — AUT-017 ESCALATE park", () => {
  it("parks a RESUMABLE kind BEFORE publish and threads parkToken/intentHash/summaryPtBr onto the event", async () => {
    const published: Array<{ payload: Record<string, unknown> }> = [];
    const parkArgs: IntentEnvelope[] = [];
    const port = natsHandoff(
      async (_event, payload) => {
        published.push({ payload });
      },
      {
        park: async (envelope) => {
          parkArgs.push(envelope);
          return {
            token: "park-tok-1",
            intentHash: envelope.intentHash,
            summaryPtBr: "reembolso de R$ 1.500,00",
          };
        },
      },
    );

    await port.queue(refundEnvelope("admin:owner1"), "acima do limite");

    expect(parkArgs).toHaveLength(1); // parked
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      sessionId: "admin:owner1",
      intentKind: "payment.refund.issue",
      parkToken: "park-tok-1",
      summaryPtBr: "reembolso de R$ 1.500,00",
    });
    expect(published[0]!.payload.intentHash).toBeTruthy();
  });

  it("degrades to a park-less escalation when park() throws — never re-throws, still publishes (no park fields)", async () => {
    const published: Array<{ payload: Record<string, unknown> }> = [];
    const port = natsHandoff(
      async (_event, payload) => {
        published.push({ payload });
      },
      {
        park: async () => {
          throw new Error("Redis down");
        },
      },
    );

    await expect(
      port.queue(refundEnvelope("admin:owner1"), "acima do limite"),
    ).resolves.toBeUndefined();
    // Still escalated (park-less): the event went out WITHOUT park fields.
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).not.toHaveProperty("parkToken");
    expect(published[0]!.payload.intentKind).toBe("payment.refund.issue");
  });

  it("does NOT park a non-resumable kind — the event is byte-identical to the park-less path", async () => {
    const published: Array<{ payload: Record<string, unknown> }> = [];
    let parkCalls = 0;
    const port = natsHandoff(
      async (_event, payload) => {
        published.push({ payload });
      },
      {
        park: async (envelope) => {
          parkCalls += 1;
          return { token: "x", intentHash: envelope.intentHash, summaryPtBr: "y" };
        },
      },
    );

    await port.queue(escalatedEnvelope("cust_001"), "needs human judgment");

    expect(parkCalls).toBe(0); // order.cancel is not resumable → never parked
    expect(published[0]!.payload).not.toHaveProperty("parkToken");
    expect(published[0]!.payload).toMatchObject({
      sessionId: "cust_001",
      reason: "needs human judgment",
      intentKind: "order.cancel",
    });
  });
});
