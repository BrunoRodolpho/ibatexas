import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsPaused = vi.hoisted(() => vi.fn());
const mockGetEscalationStore = vi.hoisted(() => vi.fn());
vi.mock("../../escalation/escalation-store.js", () => ({
  getEscalationStore: mockGetEscalationStore,
}));

import { classifyTurnDelivery, classifyCatchError, readPauseState } from "../no-delivery.js";

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

  it("returns null when an empty_completion turn still delivered PIX (F1 false-positive fix)", () => {
    // empty model text but PIX copia-e-cola/QR reached the customer → for empty
    // text deliveredText == hasPixData, so this must NOT flag a no-reply incident.
    expect(
      classifyTurnDelivery({ disposition: "empty_completion", deliveredText: true }),
    ).toBeNull();
  });

  it("flags empty_completion as a drop when nothing was delivered (deliveredText=false)", () => {
    expect(
      classifyTurnDelivery({ disposition: "empty_completion", deliveredText: false }),
    ).toEqual({ cause: "empty_completion", customerImpacted: true });
  });

  it("returns null when a whitespace_only turn still delivered PIX (F5 false-positive fix)", () => {
    // A whitespace reply is NOT sent as text (the send gate trims it), so
    // deliveredText == hasPixData: a blank completion that still delivered a PIX
    // action reached the customer and must NOT flag a no-reply incident.
    expect(
      classifyTurnDelivery({ disposition: "whitespace_only", deliveredText: true }),
    ).toBeNull();
  });

  it("flags whitespace_only as a drop when nothing was delivered (deliveredText=false)", () => {
    // A blank reply that delivered nothing is still a genuine ghost.
    expect(
      classifyTurnDelivery({ disposition: "whitespace_only", deliveredText: false }),
    ).toEqual({ cause: "whitespace_only", customerImpacted: true });
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

  it("maps a thrown send (sendEntered, not completed) to send_failed", () => {
    expect(
      classifyCatchError({ aborted: false, message: "Twilio 500", sendEntered: true, sendCompleted: false }),
    ).toBe("send_failed");
  });

  it("maps a POST-send throw (sendEntered && sendCompleted) to turn_error, not send_failed (F2)", () => {
    // sendText SUCCEEDED, then a later in-try statement (e.g. appendMessages)
    // threw. The customer was already served, so no spurious send_failed incident.
    expect(
      classifyCatchError({ aborted: false, message: "appendMessages failed", sendEntered: true, sendCompleted: true }),
    ).toBe("turn_error");
  });

  it("[#4] a POST-send throw whose message contains 'timed out' is turn_error, not timeout (already served)", () => {
    // The reply WAS served (sendEntered && sendCompleted); a later throw whose
    // message merely contains "timed out" (e.g. a downstream persistence call)
    // must NOT be misclassified `timeout` (customerImpacted) — the post-send
    // discrimination runs BEFORE the message regex.
    expect(
      classifyCatchError({
        aborted: false,
        message: "connection timed out while appending",
        sendEntered: true,
        sendCompleted: true,
      }),
    ).toBe("turn_error");
    // And an ABORTED-but-already-served turn is likewise turn_error (served wins).
    expect(
      classifyCatchError({
        aborted: true,
        message: "WhatsApp turn timed out",
        sendEntered: true,
        sendCompleted: true,
      }),
    ).toBe("turn_error");
  });

  it("maps a pre-send turn exception to turn_error (out of frozen taxonomy)", () => {
    expect(
      classifyCatchError({ aborted: false, message: "planner blew up", sendEntered: false }),
    ).toBe("turn_error");
  });
});

// readPauseState DISAMBIGUATES a genuine pause from a Redis read-error at the gate
// (W1 Redis-outage fix): `isSessionPausedForHuman` collapses both to `true`.
describe("readPauseState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEscalationStore.mockResolvedValue({ isPaused: mockIsPaused });
  });

  it("returns 'paused' for a genuine open escalation", async () => {
    mockIsPaused.mockResolvedValue(true);
    await expect(readPauseState("sess_1")).resolves.toBe("paused");
  });

  it("returns 'active' when the session is not paused", async () => {
    mockIsPaused.mockResolvedValue(false);
    await expect(readPauseState("sess_2")).resolves.toBe("active");
  });

  it("returns 'read_error' when the store read throws (Redis unreachable)", async () => {
    mockIsPaused.mockRejectedValue(new Error("redis down"));
    await expect(readPauseState("sess_3")).resolves.toBe("read_error");
  });

  it("returns 'read_error' when the store cannot even be constructed", async () => {
    mockGetEscalationStore.mockRejectedValue(new Error("redis down"));
    await expect(readPauseState("sess_4")).resolves.toBe("read_error");
  });
});
