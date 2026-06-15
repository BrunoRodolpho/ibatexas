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
