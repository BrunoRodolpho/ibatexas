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
import {
  ESCALATION_RESUMABLE_KINDS,
  summarizeEscalation,
} from "../escalation/escalation-park-store.js";

function escalatedEnvelope(sessionId: string): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_900" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "n-handoff",
  });
}

/**
 * BKL-103 — a customer-plane escalatable kind that is NOT in
 * `ESCALATION_RESUMABLE_KINDS` (an amend request escalates to a human but has no
 * approve-and-execute loop). Used by the non-resumable negative control, which
 * asserts this non-membership against the live registry so the control cannot
 * silently rot the way `order.cancel` just did.
 */
const NON_RESUMABLE_KIND = "order.amend.request";

function nonResumableEnvelope(sessionId: string): IntentEnvelope {
  return buildEnvelope({
    kind: NON_RESUMABLE_KIND,
    payload: { orderId: "ord_900", changes: [] },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "n-handoff-nonresumable",
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

  // BKL-103 — this negative control used to fire `order.cancel`, which is now a
  // RESUMABLE kind (it parks by design). Re-pointed at a kind that is genuinely
  // non-resumable, and the premise is now ASSERTED against the live registry
  // rather than assumed: if `NON_RESUMABLE_KIND` ever joins
  // `ESCALATION_RESUMABLE_KINDS`, the first expectation fails loudly instead of
  // the test silently degrading into "a resumable kind parks" (i.e. proving
  // nothing about the non-resumable branch).
  it("does NOT park a non-resumable kind — the event is byte-identical to the park-less path", async () => {
    expect(
      ESCALATION_RESUMABLE_KINDS.has(NON_RESUMABLE_KIND),
      `${NON_RESUMABLE_KIND} became resumable — this negative control needs a different kind, or it proves nothing`,
    ).toBe(false);

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

    await port.queue(nonResumableEnvelope("cust_001"), "needs human judgment");

    expect(parkCalls).toBe(0); // not resumable → never parked
    expect(published[0]!.payload).not.toHaveProperty("parkToken");
    expect(published[0]!.payload).toMatchObject({
      sessionId: "cust_001",
      reason: "needs human judgment",
      intentKind: NON_RESUMABLE_KIND,
    });
  });

  // BKL-103 — the POSITIVE counterpart on the customer plane: a resumable
  // `order.cancel` ESCALATE now DOES park, and the park fields ride the event.
  it("DOES park a resumable order.cancel — the park token + pt-BR summary ride the event (BKL-103)", async () => {
    const published: Array<{ payload: Record<string, unknown> }> = [];
    const parked: IntentEnvelope[] = [];
    const port = natsHandoff(
      async (_event, payload) => {
        published.push({ payload });
      },
      {
        park: async (envelope) => {
          parked.push(envelope);
          return {
            token: "park-cancel-1",
            intentHash: envelope.intentHash,
            summaryPtBr: summarizeEscalation(envelope),
          };
        },
      },
    );

    await port.queue(escalatedEnvelope("conv_001"), "cancelamento acima do limite");

    expect(parked).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      sessionId: "conv_001",
      intentKind: "order.cancel",
      parkToken: "park-cancel-1",
      // pt-BR (Hard Rule #4), never the bare kind string.
      summaryPtBr: "cancelamento do pedido ord_900",
    });
    // The payload itself NEVER rides NATS — only the opaque token + hash + summary.
    expect(published[0]!.payload).not.toHaveProperty("payload");
    expect(published[0]!.payload.intentHash).toBeTruthy();
  });
});
