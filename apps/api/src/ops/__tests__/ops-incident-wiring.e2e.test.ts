// ops-incident-wiring.e2e — BKL-235: the ops channel joins the incident ledger.
//
// THE DEFECT. Two ops-WhatsApp turns on 2026-07-21 (6935339a, 236b4dd9) exhausted
// their empty-completion retries and fell to the honest holding fallback, and
// `conversation_incidents` has count=0 for those sessions. The customer planes open
// a governed ConversationIncident for exactly that disposition and auto-close it on
// a delivered reply; the ops plane had NO wiring at all.
//
// WHY THIS LEVEL. These drive `handleOpsWhatsAppMessage` — the REAL ingress — over a
// REAL composed ops conductor and a REAL audited kernel through a full `handleTurn`
// (the ops-e2e-harness machinery, extended rather than rebuilt). The disposition is
// produced by the actual turn, not asserted against a synthetic reply object, so a
// wiring that is dead through the gate cannot pass here.
//
// The DOMAIN incident service is the one seam doubled, because the assertion is
// about what the ops plane ROUTES, not about Postgres. To keep that double from
// becoming a blind spot, the captured envelope is additionally run through the REAL
// `incidentPolicyBundle` via the REAL `adjudicate()`: if the payload the ops seam
// builds would not actually EXECUTE under production governance, these tests fail.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Doubles hoisted above the SUT import ─────────────────────────────────────

const openIncidentFromEnvelope = vi.hoisted(() => vi.fn());
const closeIncidentFromEnvelope = vi.hoisted(() => vi.fn());
const findOpenBySession = vi.hoisted(() => vi.fn());
// Typed params so `mock.calls` is indexable (an inferred zero-arg mock is not).
const mockPublishNatsEvent = vi.hoisted(() =>
  vi.fn(async (_event: string, _payload: unknown) => {}),
);

// Keep every other domain export REAL — the conductor, packs, and the policy
// bundle these tests adjudicate against all come from here.
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    createIncidentService: () => ({
      openIncidentFromEnvelope,
      closeIncidentFromEnvelope,
      findOpenBySession,
    }),
  };
});

// `getAuditSink()` THROWS when the process was never bootstrapped, and
// `openIncidentInline` calls it inside its fail-open try — an unmocked sink would
// swallow the open and make these tests pass for the wrong reason.
vi.mock("@ibatexas/audit-sink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/audit-sink")>();
  return { ...actual, getAuditSink: () => ({ emit: async () => {} }) };
});

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/nats-client")>();
  return { ...actual, publishNatsEvent: mockPublishNatsEvent };
});

import {
  OPS_WHATSAPP_CHANNEL,
  incidentPolicyBundle,
  isOpsPlaneChannel,
} from "@ibatexas/domain";
import type { StaffEnvelopeActor } from "../../claustrum/ibatexas-planner.js";
import { composeOpsConductor, type OpsConductorContext } from "../ops-conductor.js";
import { createOpsResolver } from "../ops-resolver.js";
import {
  handleOpsWhatsAppMessage,
  type OpsWhatsAppIngressDeps,
} from "../ops-whatsapp-ingress.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  scriptedModel,
} from "./ops-e2e-harness.js";

const STAFF_ID = "staff_1";
const OPS_SESSION = `admin:${STAFF_ID}`;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Wire the REAL ingress over a REAL composed ops conductor. `responderText` is the
 * only knob these tests turn: `""` drives the genuine empty-completion disposition
 * the RCA observed, a non-blank string drives the delivered-reply path.
 */
function opsIngress(responderText: string): {
  deps: OpsWhatsAppIngressDeps;
  replies: string[];
  errors: string[];
} {
  const sink = makeCapturingAuditSink();
  const { tools } = buildOpsTools({}, sink);
  const conductorDeps = composeOpsDeps({
    adjudicator: makeAuditedAdjudicator({ sink }),
    session: makeStatefulSession(),
    tools,
    model: scriptedModel([], { responderText }),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async () => null,
        lookupActivePayment: async () => null,
        lookupAlert: async () => null,
        lookupIncident: async () => null,
      }),
  });

  const replies: string[] = [];
  const errors: string[] = [];
  const deps: OpsWhatsAppIngressDeps = {
    findStaffByPhone: async () => ({ id: STAFF_ID, role: "OWNER", active: true }),
    composeConductor: (actor: StaffEnvelopeActor, context: OpsConductorContext) =>
      composeOpsConductor(conductorDeps as never, actor, context),
    acquireLock: async () => "lock-uuid",
    releaseLock: async () => {},
    loadHistoryBlock: async () => undefined,
    appendHistory: async () => {},
    sendReply: async (text) => {
      replies.push(text);
    },
    sendError: async (text) => {
      errors.push(text);
    },
  };
  return { deps, replies, errors };
}

function driveOpsTurn(deps: OpsWhatsAppIngressDeps, text = "quantos pedidos hoje?") {
  return handleOpsWhatsAppMessage(deps, {
    phone: "+5511999999999",
    hash: "phone-hash-1",
    text,
    log,
  });
}

beforeEach(() => {
  openIncidentFromEnvelope.mockReset();
  closeIncidentFromEnvelope.mockReset();
  findOpenBySession.mockReset();
  mockPublishNatsEvent.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();

  openIncidentFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { opened: true, incident: { id: "inc_ops_1", severity: "low" } },
  });
  closeIncidentFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { id: "inc_ops_1", status: "AUTO_RESOLVED" },
  });
  findOpenBySession.mockResolvedValue(null);
});

describe("BKL-235 — an ops-WhatsApp empty completion opens a governed incident", () => {
  it("opens exactly ONE incident, on the ops channel, via a SYSTEM-actor envelope", async () => {
    const { deps, replies, errors } = opsIngress("");

    const out = await driveOpsTurn(deps);

    expect(out).toEqual({ consumed: true });
    // The pre-existing honest fallback still goes out, unchanged.
    expect(replies).toHaveLength(0);
    expect(errors).toHaveLength(1);

    // THE REGRESSION GATE: pre-fix this was 0.
    expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);

    const envelope = openIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope<
      "incident.ticket.open",
      {
        sessionId: string;
        cause: string;
        channel: string;
        customerId: string | null;
        customerImpacted: boolean;
        externalId: string;
        phoneHash: string | null;
        senderRef: string | null;
      }
    >;

    // Governed, never a raw DB write — the same chokepoint the customer plane uses.
    expect(envelope.kind).toBe("incident.ticket.open");
    expect(envelope.actor.principal).toBe("system");

    expect(envelope.payload).toMatchObject({
      sessionId: OPS_SESSION,
      cause: "empty_completion",
      // Distinguishability: `channel` is the plane discriminator (no new enum).
      channel: OPS_WHATSAPP_CHANNEL,
      // A staffer is not a Customer row — the column stays null.
      customerId: null,
      // The honest fallback LANDED → degraded, not a ghost.
      customerImpacted: false,
      phoneHash: "phone-hash-1",
      senderRef: "whatsapp:+5511999999999",
    });
    // Per-event dedup id, so a redelivery collapses instead of double-opening.
    expect(envelope.payload.externalId).toMatch(/^conversation\.no_delivery:/);
  });

  it("builds a payload the REAL incident policy actually EXECUTEs (not just a plausible shape)", async () => {
    const { deps } = opsIngress("");
    await driveOpsTurn(deps);

    const envelope = openIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope;
    // The REAL bundle: the frozen-cause guard + the SYSTEM taint floor. An ops
    // cause outside the frozen taxonomy, or a non-system actor, would REFUSE here.
    const decision = await adjudicate(envelope, {} as never, incidentPolicyBundle as never);
    expect(decision.kind).toBe("EXECUTE");
  });

  it("fans out `conversation.incident_opened` carrying the ops channel (so the staff ping can tell the planes apart)", async () => {
    const { deps } = opsIngress("");
    await driveOpsTurn(deps);

    const opened = mockPublishNatsEvent.mock.calls.find(
      (c) => c[0] === "conversation.incident_opened",
    );
    expect(opened).toBeDefined();
    expect(opened![1]).toMatchObject({
      incidentId: "inc_ops_1",
      sessionId: OPS_SESSION,
      channel: OPS_WHATSAPP_CHANNEL,
      cause: "empty_completion",
    });
  });

  it("does NOT auto-close on the honest fallback — an error surface is not a recovery", async () => {
    // An incident is already open on this staff conversation…
    findOpenBySession.mockResolvedValue({ id: "inc_ops_prev", status: "OPEN" });
    const { deps } = opsIngress("");

    await driveOpsTurn(deps);

    // …and "não consegui processar" must never self-heal it.
    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });
});

describe("BKL-235 — a delivered ops reply auto-closes the incident", () => {
  it("routes a governed AUTO close on the ops session and opens nothing", async () => {
    findOpenBySession.mockResolvedValue({ id: "inc_ops_1", status: "OPEN" });
    const { deps, replies, errors } = opsIngress("Feito.");

    const out = await driveOpsTurn(deps);

    expect(out).toEqual({ consumed: true });
    expect(replies).toHaveLength(1);
    expect(errors).toHaveLength(0);

    // A delivered reply is never a drop.
    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();

    // The lookup is scoped to the OPS session — both ops ingresses share it.
    expect(findOpenBySession).toHaveBeenCalledWith(OPS_SESSION);
    expect(closeIncidentFromEnvelope).toHaveBeenCalledTimes(1);

    const envelope = closeIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope<
      "incident.ticket.close",
      { id: string; resolvedBy: string; resolutionType: string }
    >;
    expect(envelope.kind).toBe("incident.ticket.close");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.payload).toMatchObject({
      id: "inc_ops_1",
      resolvedBy: "system",
      resolutionType: "AUTO",
    });

    const decision = await adjudicate(
      envelope as IntentEnvelope,
      {} as never,
      incidentPolicyBundle as never,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("is a fast-null no-op when the staff conversation has no open incident", async () => {
    findOpenBySession.mockResolvedValue(null);
    const { deps } = opsIngress("Feito.");

    await driveOpsTurn(deps);

    expect(findOpenBySession).toHaveBeenCalledWith(OPS_SESSION);
    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });
});

describe("BKL-235 — the customer plane is unchanged (pins)", () => {
  it("no customer-plane channel is ever classified as ops", () => {
    // The staff-ping copy branch keys on this predicate. If a customer channel
    // ever answered true here, a real customer outage would be announced as an
    // internal ops hiccup.
    expect(isOpsPlaneChannel("whatsapp")).toBe(false);
    expect(isOpsPlaneChannel("web")).toBe(false);
    expect(isOpsPlaneChannel(null)).toBe(false);
    expect(isOpsPlaneChannel(undefined)).toBe(false);
    expect(isOpsPlaneChannel("")).toBe(false);
  });

  it("the ops channel is a distinct value, not a rename of a customer channel", () => {
    expect(OPS_WHATSAPP_CHANNEL).toBe("ops-whatsapp");
    expect(isOpsPlaneChannel(OPS_WHATSAPP_CHANNEL)).toBe(true);
  });

  it("the UNWIRED ops dashboard is not silently claimed as covered", () => {
    // Scope is ops-WhatsApp only. No constant is declared for the dashboard, so the
    // predicate cannot overstate its coverage; if the dashboard is wired later this
    // assertion is the reminder to add it deliberately.
    expect(isOpsPlaneChannel("ops-dashboard")).toBe(false);
  });
});
