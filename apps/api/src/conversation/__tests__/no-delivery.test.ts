import { describe, it, expect } from "vitest";
import { classifyTurnDelivery, classifyCatchError } from "../no-delivery.js";

// `classifyTurnDelivery` is PURE — no DB, NATS, or kernel needed. These tests
// pin the no-false-positive short-circuits (layer 1), the abort-with-text
// false-negative (P0-2), and the customerImpacted flag per cause.
describe("classifyTurnDelivery", () => {
  it("returns null for the intentional bot-pause (suppressed_paused)", () => {
    expect(
      classifyTurnDelivery({ disposition: "suppressed_paused", deliveredText: false }),
    ).toBeNull();
  });

  it("returns null for an ESCALATE handoff regardless of disposition", () => {
    expect(
      classifyTurnDelivery({
        disposition: "empty_completion",
        decisionKind: "ESCALATE",
        deliveredText: false,
      }),
    ).toBeNull();
    // ESCALATE short-circuits BEFORE the deliverable/text branch too.
    expect(
      classifyTurnDelivery({
        disposition: "deliverable",
        decisionKind: "ESCALATE",
        deliveredText: false,
      }),
    ).toBeNull();
  });

  it("classifies an empty completion as empty_completion + customerImpacted", () => {
    expect(
      classifyTurnDelivery({ disposition: "empty_completion", deliveredText: false }),
    ).toEqual({ cause: "empty_completion", customerImpacted: true });
  });

  it("classifies a whitespace-only completion as whitespace_only + customerImpacted", () => {
    expect(
      classifyTurnDelivery({ disposition: "whitespace_only", deliveredText: false }),
    ).toEqual({ cause: "whitespace_only", customerImpacted: true });
  });

  it("catches abort-with-text (deliverable but nothing delivered) as timeout (P0-2)", () => {
    expect(
      classifyTurnDelivery({ disposition: "deliverable", deliveredText: false }),
    ).toEqual({ cause: "timeout", customerImpacted: true });
  });

  it("returns null when a deliverable turn actually reached the customer", () => {
    expect(
      classifyTurnDelivery({ disposition: "deliverable", deliveredText: true }),
    ).toBeNull();
  });

  it("returns null when an empty-text turn still delivered PIX (false-positive fix)", () => {
    // empty text but PIX copia-e-cola/QR reached the customer → deliveredText=true
    expect(
      classifyTurnDelivery({ disposition: "deliverable", deliveredText: true }),
    ).toBeNull();
  });

  it("every returned classification is customerImpacted=true (per cause)", () => {
    for (const disposition of ["empty_completion", "whitespace_only"] as const) {
      const c = classifyTurnDelivery({ disposition, deliveredText: false });
      expect(c?.customerImpacted).toBe(true);
    }
    const abort = classifyTurnDelivery({ disposition: "deliverable", deliveredText: false });
    expect(abort?.customerImpacted).toBe(true);
  });
});

describe("classifyCatchError", () => {
  it("maps an aborted turn to timeout", () => {
    expect(
      classifyCatchError({ aborted: true, message: "whatever", sendEntered: false }),
    ).toBe("timeout");
  });

  it("maps a 'timed out' message to timeout even when not aborted", () => {
    expect(
      classifyCatchError({ aborted: false, message: "WhatsApp turn timed out", sendEntered: true }),
    ).toBe("timeout");
  });

  it("maps a thrown send (sendEntered) to send_failed", () => {
    expect(
      classifyCatchError({ aborted: false, message: "Twilio 500", sendEntered: true }),
    ).toBe("send_failed");
  });

  it("maps a pre-send turn exception to turn_error (out of frozen taxonomy)", () => {
    expect(
      classifyCatchError({ aborted: false, message: "planner blew up", sendEntered: false }),
    ).toBe("turn_error");
  });
});
