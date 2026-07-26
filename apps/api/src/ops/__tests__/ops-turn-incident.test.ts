// ops-turn-incident — the ops-plane incident seam's branching contract (BKL-235).
//
// The e2e (ops-incident-wiring.e2e.test.ts) proves the WhatsApp ingress reaches this
// module through a real handleTurn. These cover the branches an e2e cannot cheaply
// reach: the catch-path cause mapping (including the F2 already-served exclusion that
// must NOT open an incident), the ESCALATE exclusion inherited from the shared
// customer-plane classifier, and the dashboard channel's distinct impact semantics.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

const openIncidentFromEnvelope = vi.hoisted(() => vi.fn());
const findOpenBySession = vi.hoisted(() => vi.fn());
const closeIncidentFromEnvelope = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    createIncidentService: () => ({
      openIncidentFromEnvelope,
      findOpenBySession,
      closeIncidentFromEnvelope,
    }),
  };
});

vi.mock("@ibatexas/audit-sink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/audit-sink")>();
  return { ...actual, getAuditSink: () => ({ emit: async () => {} }) };
});

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/nats-client")>();
  return { ...actual, publishNatsEvent: vi.fn(async () => {}) };
});

import { OPS_WHATSAPP_CHANNEL, deriveSeverity } from "@ibatexas/domain";
import {
  classifyOpsReply,
  opsSessionId,
  recordOpsTurnDelivery,
  recordOpsTurnFailure,
  type OpsTurnContext,
} from "../ops-turn-incident.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function ctx(channel: string = OPS_WHATSAPP_CHANNEL): OpsTurnContext {
  return {
    staffId: "staff_7",
    channel,
    turnId: "turn_1",
    messageRef: "msg_1",
    senderRef: null,
    phoneHash: null,
    log,
  };
}

/** The `incident.ticket.open` payload of the single captured envelope. */
function capturedPayload(): Record<string, unknown> {
  expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);
  const envelope = openIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope<
    "incident.ticket.open",
    Record<string, unknown>
  >;
  expect(envelope.kind).toBe("incident.ticket.open");
  expect(envelope.actor.principal).toBe("system");
  return envelope.payload;
}

beforeEach(() => {
  openIncidentFromEnvelope.mockReset();
  findOpenBySession.mockReset();
  closeIncidentFromEnvelope.mockReset();
  openIncidentFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { opened: true, incident: { id: "inc_1", severity: "low" } },
  });
  findOpenBySession.mockResolvedValue(null);
});

describe("classifyOpsReply", () => {
  it("keeps empty and whitespace-only DISTINCT (the send gate collapses them; the journal must not)", () => {
    expect(classifyOpsReply("")).toBe("empty_completion");
    expect(classifyOpsReply(null)).toBe("empty_completion");
    expect(classifyOpsReply(undefined)).toBe("empty_completion");
    expect(classifyOpsReply("   ")).toBe("whitespace_only");
    expect(classifyOpsReply("\n\t")).toBe("whitespace_only");
    expect(classifyOpsReply("Feito.")).toBe("deliverable");
  });
});

describe("opsSessionId", () => {
  it("is the ops conversation id both ingresses already stamp", () => {
    expect(opsSessionId("staff_7")).toBe("admin:staff_7");
  });
});

describe("recordOpsTurnDelivery", () => {
  it("opens a whitespace_only incident (its own frozen cause, not empty_completion)", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "   ",
      replyDelivered: false,
      fallbackDelivered: true,
    });

    expect(capturedPayload()).toMatchObject({
      cause: "whitespace_only",
      channel: OPS_WHATSAPP_CHANNEL,
      customerImpacted: false,
    });
  });

  it("a DELIVERED reply is never a drop", async () => {
    const out = await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "Feito.",
      replyDelivered: true,
      fallbackDelivered: false,
    });

    expect(out).toBeNull();
    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("inherits the ESCALATE exclusion from the shared customer-plane classifier", async () => {
    // A deliberate handoff is not a ghost — the staffer is being routed to a human.
    const out = await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: true,
      decisionKind: "ESCALATE",
    });

    expect(out).toBeNull();
    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("customerImpacted stays FALSE even when the fallback ALSO failed — never customer-harm weighting", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: false,
    });

    const payload = capturedPayload();
    // No customer is reachable on this plane, so the flag cannot be true — even
    // though this is the worst ops case (the staffer got total silence).
    expect(payload.customerImpacted).toBe(false);
    // …but the fact is NOT lost: it is recorded in the non-PII diagnostic instead of
    // by bending the severity flag.
    expect(String(payload.detail)).toContain("ALSO failed (total silence)");
  });

  it("records a delivered fallback distinctly in detail", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: true,
    });

    expect(String(capturedPayload().detail)).toContain("honest fallback delivered");
  });

  it("always sets the ops channel explicitly — never left to the subscriber's 'whatsapp' default", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: true,
    });

    // incident-subscriber.ts:50 defaults a MISSING channel to "whatsapp", which would
    // mislabel an ops ghost as a customer one. The value must be present here.
    expect(capturedPayload().channel).toBe(OPS_WHATSAPP_CHANNEL);
    expect(capturedPayload().channel).not.toBe("whatsapp");
  });

  it("the incident sessionId is the key intent_audit + turn_trace already use", () => {
    // ibatexas-planner.ts:779 stamps the ops actor `sessionId: admin:<staffId>`, and
    // turn_trace keys on that same conversation id — so an incident on this key joins
    // its own turn's evidence. `ops:<staffId>` (the lock domain) is in neither store.
    expect(opsSessionId("staff_7")).toBe("admin:staff_7");
  });
});

describe("ops severity weighting (ruling 4 verification)", () => {
  it("an ops row lands low/medium — never the customer-harm `high` branch", () => {
    const openedAt = new Date("2026-07-26T12:00:00.000Z");

    // Recent → low.
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 1, openedAt, now: openedAt }),
    ).toBe("low");

    // The three escalators that would drive a CUSTOMER row to `high` — aged,
    // repeat drops, and a re-open — top out at `medium` while customerImpacted is
    // false, so a staff-channel hiccup can never outrank a real customer ghost.
    const aged = new Date(openedAt.getTime() + 60 * 60_000);
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 5, openedAt, now: aged }),
    ).toBe("medium");

    // Contrast: the identical shape WITH customer impact is `high`. This is the
    // weighting ops rows must not import.
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 5, openedAt, now: aged }),
    ).toBe("high");
  });
});

describe("recordOpsTurnFailure", () => {
  it("a PRE-send throw is mapped INTO the frozen taxonomy as send_failed (BKL-175 parity)", async () => {
    const opened = await recordOpsTurnFailure({
      ctx: ctx(),
      error: new Error("planner blew up"),
      sendEntered: false,
      sendCompleted: false,
      fallbackDelivered: true,
    });

    expect(opened).toBe(true);
    expect(capturedPayload()).toMatchObject({
      cause: "send_failed",
      channel: OPS_WHATSAPP_CHANNEL,
    });
  });

  it("a throw INSIDE the send is send_failed", async () => {
    const opened = await recordOpsTurnFailure({
      ctx: ctx(),
      error: new Error("Twilio 500"),
      sendEntered: true,
      sendCompleted: false,
      fallbackDelivered: true,
    });

    expect(opened).toBe(true);
    expect(capturedPayload()).toMatchObject({ cause: "send_failed" });
  });

  it("a timeout keeps its own cause", async () => {
    await recordOpsTurnFailure({
      ctx: ctx(),
      error: new Error("ops turn timed out"),
      sendEntered: false,
      sendCompleted: false,
      fallbackDelivered: true,
    });

    expect(capturedPayload()).toMatchObject({ cause: "timeout" });
  });

  it("F2 — a POST-send throw opens NOTHING: the staffer was already served", async () => {
    const opened = await recordOpsTurnFailure({
      ctx: ctx(),
      error: new Error("history append failed after the reply went out"),
      sendEntered: true,
      sendCompleted: true,
      fallbackDelivered: false,
    });

    expect(opened).toBe(false);
    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("a post-send throw whose message merely CONTAINS 'timed out' is still excluded", async () => {
    // The F2 check must precede the timeout regex, or an already-served turn would
    // open a customer-impacted timeout incident.
    const opened = await recordOpsTurnFailure({
      ctx: ctx(),
      error: new Error("downstream persistence timed out"),
      sendEntered: true,
      sendCompleted: true,
      fallbackDelivered: false,
    });

    expect(opened).toBe(false);
    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("is fail-open — a governed-open failure never propagates into the turn", async () => {
    openIncidentFromEnvelope.mockRejectedValue(new Error("db down"));

    await expect(
      recordOpsTurnFailure({
        ctx: ctx(),
        error: new Error("planner blew up"),
        sendEntered: false,
        sendCompleted: false,
        fallbackDelivered: true,
      }),
    ).resolves.toBe(true);
  });
});
