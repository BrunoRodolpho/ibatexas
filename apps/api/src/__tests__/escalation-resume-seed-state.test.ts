// escalation-resume-seed-state — BKL-103. The per-plane RESUME seed.
//
// `enrichResumeState` has two branches: an `admin:`-keyed ops table, and a CUSTOMER
// branch that only runs when the state it is handed carries `{ customerId, channel }`.
// The escalation-approval engine used to hand it a bare `{ ctx: { exists: false } }` —
// correct for the ops refund, but it made the customer branch return that stub
// UNCHANGED, so a resumed `order.cancel` would have adjudicated with NO
// paymentStatus / total / fulfillmentStatus and the fresh-state re-verification
// BKL-103 depends on would silently not happen.
//
// These arms pin the three behaviours: ops unchanged (byte-identical), customer
// seeded from the PROPOSER STAMP, and unstamped ⇒ the stub (fail-closed).

import { describe, expect, it } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { escalationResumeSeedState } from "../claustrum-bootstrap.js";

const OPS_STUB = { ctx: { exists: false } };

function envelope(
  kind: string,
  sessionId: string,
  payload: Record<string, unknown>,
  principal: "llm" | "user" = "llm",
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal, sessionId },
    taint: "UNTRUSTED",
    nonce: "n-seed",
  }) as IntentEnvelope;
}

describe("BKL-103 — escalationResumeSeedState", () => {
  it("an OPS-plane (`admin:`) envelope gets the UNCHANGED stub — the OPS_RESUME_TABLE serves it", () => {
    const env = envelope(
      "payment.refund.issue",
      "admin:owner1",
      { paymentId: "pay_1", actorId: "owner1" },
      "user",
    );
    // Byte-identical to what the engine passed before BKL-103, so the refund's
    // re-projection path is provably untouched.
    expect(escalationResumeSeedState(env)).toEqual(OPS_STUB);
  });

  it("a CUSTOMER-plane order.cancel seeds { customerId, channel } from the PROPOSER STAMP", () => {
    // The conversational actor.sessionId is a CONVERSATION id, so the stamp is the
    // only authenticated customer identity that survives the park — seeding from
    // the session would scope the re-read to a conversation id and find nothing.
    const env = envelope("order.cancel", "conv_abc", {
      orderId: "order_1",
      actorId: "cust_1",
    });
    expect(escalationResumeSeedState(env)).toEqual({
      customerId: "cust_1",
      channel: "web",
    });
  });

  it("the seeded customerId is the STAMP, never the session id", () => {
    const env = envelope("order.cancel", "conv_abc", {
      orderId: "order_1",
      actorId: "cust_1",
    });
    const seed = escalationResumeSeedState(env) as { customerId?: string };
    expect(seed.customerId).toBe("cust_1");
    expect(seed.customerId).not.toBe("conv_abc");
  });

  it("an UNSTAMPED customer-plane cancel falls back to the stub (FAIL-CLOSED — no order state ⇒ the guards REFUSE)", () => {
    const env = envelope("order.cancel", "conv_abc", { orderId: "order_1" });
    expect(escalationResumeSeedState(env)).toEqual(OPS_STUB);
  });

  it("a BLANK stamp is treated as absent (fail-closed)", () => {
    const env = envelope("order.cancel", "conv_abc", {
      orderId: "order_1",
      actorId: "",
    });
    expect(escalationResumeSeedState(env)).toEqual(OPS_STUB);
  });

  it("an UNDECLARED (non-resumable) kind gets the stub — the stamp registry is the only source", () => {
    const env = envelope("order.amend.request", "conv_abc", {
      orderId: "order_1",
      actorId: "cust_1",
    });
    expect(escalationResumeSeedState(env)).toEqual(OPS_STUB);
  });
});
