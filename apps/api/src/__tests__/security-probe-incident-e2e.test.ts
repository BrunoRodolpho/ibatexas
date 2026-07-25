// BKL-211 — end-to-end: a probe refusal becomes a reviewable incident.
//
// Drives the REAL chain at the deepest seam the existing incident tests use (the
// `createIncidentService` boundary, per incident-auto-close.test.ts):
//
//   audit.intent.decision.v1 record
//     → REAL security-probe-subscriber handler
//     → REAL withDedup (fake Redis)
//     → REAL openIncidentInline (envelope construction + journal wiring)
//     → captured incident.ticket.open envelope
//   …then, on the SAME session:
//     → REAL closeIncidentOnDeliveredReply (the refusal reply IS delivered)
//     → asserted NOT to close the security row.
//
// The domain half of the chain (kernel adjudication, the per-journal dedup
// queries, the actual row write) is pinned by
// packages/domain/src/services/__tests__/incident-security-journal.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn());
const openIncidentFromEnvelope = vi.hoisted(() => vi.fn());
const closeIncidentFromEnvelope = vi.hoisted(() => vi.fn());
const findOpenBySession = vi.hoisted(() => vi.fn());

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
      return { unsubscribe: () => {} };
    },
  ),
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  NO_REPLY_KIND: "no_reply",
  SECURITY_PROBE_KIND: "security_probe",
  createIncidentService: () => ({
    openIncidentFromEnvelope,
    closeIncidentFromEnvelope,
    findOpenBySession,
  }),
}));

vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => undefined }));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({ set: mockRedisSet, del: mockRedisDel })),
  rk: (k: string) => `test:${k}`,
}));

vi.mock("../escalation/escalation-store.js", () => ({
  getEscalationStore: vi.fn(),
}));

import { startSecurityProbeSubscriber } from "../subscribers/security-probe-subscriber.js";
import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";

const SESSION = "wa:5511999999999";

type OpenEnvelope = IntentEnvelope<
  "incident.ticket.open",
  { sessionId: string; cause: string; kind?: string; externalId: string; customerImpacted?: boolean; detail?: string | null }
>;

/** SCN-109: the PII probe proposed a read of an order the customer does not own. */
function piiProbeRecord(over: Record<string, unknown> = {}) {
  return {
    intentHash: "hash_scn109",
    at: "2026-07-25T12:00:00.000Z",
    envelope: {
      kind: "order.status.read",
      actor: { principal: "llm", sessionId: SESSION },
    },
    decision: { kind: "REFUSE" },
    decision_basis: [{ category: "auth", code: "scope_insufficient" }],
    ...over,
  };
}

async function getHandler(): Promise<(payload: unknown) => Promise<void>> {
  await startSecurityProbeSubscriber();
  return natsHandlers["audit.intent.decision.v1"]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisSet.mockResolvedValue("OK");
  openIncidentFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE" },
    result: { opened: true, incident: { id: "inc_sec", severity: "low" } },
  });
  closeIncidentFromEnvelope.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: null });
});

describe("BKL-211 e2e — a refused probe becomes exactly one reviewable incident", () => {
  it("routes ONE governed incident.ticket.open on the security journal", async () => {
    const handler = await getHandler();
    await handler(piiProbeRecord());

    expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);
    const envelope = openIncidentFromEnvelope.mock.calls[0]![0] as OpenEnvelope;

    expect(envelope.kind).toBe("incident.ticket.open");
    // CLAUDE.md Hard Rule 9 — a system-driven mutation carries the system actor.
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");

    expect(envelope.payload).toMatchObject({
      sessionId: SESSION,
      cause: "security_probe",
      kind: "security_probe",
      customerImpacted: false,
    });
    // Its OWN externalId namespace — it can never collide with a no-reply row.
    expect(envelope.payload.externalId).toBe(
      "security.probe_refused:wa:5511999999999:hash_scn109",
    );
    expect(envelope.payload.detail).toContain("auth.scope_insufficient");
  });

  it("does NOT fire the staff no-reply ping (its copy would state something false)", async () => {
    const handler = await getHandler();
    await handler(piiProbeRecord());

    // `conversation.incident_opened` drives a pt-BR alert asserting the customer
    // got no reply — but the customer WAS answered, with the refusal.
    expect(mockPublishNatsEvent).not.toHaveBeenCalledWith(
      "conversation.incident_opened",
      expect.anything(),
    );
  });

  it("a SECOND identical record does not open a second incident", async () => {
    const handler = await getHandler();
    await handler(piiProbeRecord());
    expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);

    mockRedisSet.mockResolvedValue(null); // redelivery: dedup key already committed
    await handler(piiProbeRecord());

    expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);
  });

  it("an ORDINARY BUSINESS REFUSAL on the same subject opens nothing", async () => {
    const handler = await getHandler();
    await handler(
      piiProbeRecord({ decision_basis: [{ category: "business", code: "rule_violated" }] }),
    );

    expect(openIncidentFromEnvelope).not.toHaveBeenCalled();
  });
});

describe("BKL-211 e2e — AUTO-CLOSE RULING: the delivered refusal must not close it", () => {
  it("the delivered reply routes NO close when the session's only open row is the probe", async () => {
    const handler = await getHandler();
    await handler(piiProbeRecord());
    expect(openIncidentFromEnvelope).toHaveBeenCalledTimes(1);

    // The refusal reply IS delivered to the customer in this same turn, so the
    // auto-close seam fires. `findOpenBySession` is scoped to the no_reply journal
    // (incident.service.ts), so the security row is not a candidate → null.
    findOpenBySession.mockResolvedValue(null);

    await closeIncidentOnDeliveredReply(SESSION, "turn_scn109");

    expect(findOpenBySession).toHaveBeenCalledWith(SESSION);
    // No incident.ticket.close was routed — the attack row survives for review.
    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("a genuine no-reply incident on the same session STILL auto-closes (no collateral damage)", async () => {
    // The exemption must be surgical: the W1 self-heal is untouched.
    findOpenBySession.mockResolvedValue({ id: "inc_ghost", status: "OPEN" });

    await closeIncidentOnDeliveredReply(SESSION, "turn_recovered");

    expect(closeIncidentFromEnvelope).toHaveBeenCalledTimes(1);
    const envelope = closeIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope<
      "incident.ticket.close",
      { id: string; resolutionType: string; resolvedBy: string }
    >;
    expect(envelope.payload).toMatchObject({
      id: "inc_ghost",
      resolutionType: "AUTO",
      resolvedBy: "system",
    });
  });
});
