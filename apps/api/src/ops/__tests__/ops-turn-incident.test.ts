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

import {
  OPS_DASHBOARD_CHANNEL,
  OPS_WHATSAPP_CHANNEL,
  deriveSeverity,
} from "@ibatexas/domain";
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

  it("a DELIVERED fallback is degraded, not a ghost (customerImpacted false + detail)", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: true,
    });

    const payload = capturedPayload();
    // The column's documented contract: false when a canned holding message landed.
    expect(payload.customerImpacted).toBe(false);
    expect(String(payload.detail)).toContain("honest fallback delivered");
  });

  it("a FAILED fallback IS a total-silence ghost (customerImpacted true + detail)", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: false,
    });

    const payload = capturedPayload();
    // The staffer got NOTHING — that is a real ghost and must read as one.
    expect(payload.customerImpacted).toBe(true);
    expect(String(payload.detail)).toContain("ALSO failed (total silence)");
  });

  it("the DASHBOARD channel is distinguishable on the same staff session", async () => {
    await recordOpsTurnDelivery({
      ctx: ctx(OPS_DASHBOARD_CHANNEL),
      replyText: "",
      replyDelivered: false,
      fallbackDelivered: false,
    });

    expect(capturedPayload()).toMatchObject({
      channel: OPS_DASHBOARD_CHANNEL,
      cause: "empty_completion",
      // Same session as the WhatsApp ingress — that shared identity is why the
      // dashboard must also auto-close (otherwise: stuck-open rows).
      sessionId: "admin:staff_7",
    });
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

describe("ops severity weighting — the consequence of !fallbackDelivered, made explicit", () => {
  const openedAt = new Date("2026-07-26T12:00:00.000Z");
  const aged = new Date(openedAt.getTime() + 60 * 60_000);

  it("the ordinary ops case (fallback delivered) is low, and cannot outrank a customer ghost", () => {
    // fallbackDelivered:true ⇒ customerImpacted:false ⇒ the degraded branch.
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 1, openedAt, now: openedAt }),
    ).toBe("low");
    // Even aged + repeated it tops out at medium while not impacted.
    expect(
      deriveSeverity({ customerImpacted: false, dropCount: 5, openedAt, now: aged }),
    ).toBe("medium");
  });

  it("a TOTAL-SILENCE ops row can reach high once aged/repeated — deliberate, not accidental", () => {
    // fallbackDelivered:false ⇒ customerImpacted:true ⇒ the `silêncio` branch. This
    // is the tradeoff of honouring the column's contract: a staffer who got NOTHING
    // escalates like any other ghost. Pinned so the weighting is reviewable rather
    // than a silent side effect.
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 5, openedAt, now: aged }),
    ).toBe("high");
    // Recent + single drop is still only medium, so one blip does not cry wolf.
    expect(
      deriveSeverity({ customerImpacted: true, dropCount: 1, openedAt, now: openedAt }),
    ).toBe("medium");
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
