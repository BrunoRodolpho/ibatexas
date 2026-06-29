// Unit tests for the W1 Phase-2 auto-close seam (`closeIncidentOnDeliveredReply`).
//
// Asserts the three contract cases from the plan's "Auto-close & re-open rules":
//   - an OPEN incident on the session → governed AUTO close (resolved_by=system),
//   - no incident on the session      → fast-null no-op (no close routed),
//   - an already-terminal incident    → idempotent no-op (findOpenBySession
//                                       excludes terminal rows → no close routed),
// plus the fail-open guarantee (a lookup throw never propagates to the reply path).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

const findOpenBySession = vi.fn();
const closeIncidentFromEnvelope = vi.fn();

vi.mock("@ibatexas/domain", () => ({
  createIncidentService: () => ({
    findOpenBySession,
    closeIncidentFromEnvelope,
  }),
}));

import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";

beforeEach(() => {
  findOpenBySession.mockReset();
  closeIncidentFromEnvelope.mockReset();
  closeIncidentFromEnvelope.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: null });
});

describe("closeIncidentOnDeliveredReply", () => {
  it("closes an OPEN incident as AUTO (resolved_by=system, closingTurnId=delivered turn)", async () => {
    findOpenBySession.mockResolvedValue({ id: "inc_1", status: "OPEN" });

    await closeIncidentOnDeliveredReply("sess_1", "turn_abc");

    expect(findOpenBySession).toHaveBeenCalledWith("sess_1");
    expect(closeIncidentFromEnvelope).toHaveBeenCalledTimes(1);

    const envelope = closeIncidentFromEnvelope.mock.calls[0]![0] as IntentEnvelope<
      "incident.ticket.close",
      {
        id: string;
        resolvedBy: string;
        resolutionType: string;
        closingTurnId?: string | null;
      }
    >;
    expect(envelope.kind).toBe("incident.ticket.close");
    expect(envelope.payload).toMatchObject({
      id: "inc_1",
      resolvedBy: "system",
      resolutionType: "AUTO",
      closingTurnId: "turn_abc",
    });
    // SYSTEM-actor envelope, nonce keyed per-delivered-turn (re-open-safe).
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.nonce).toBe("inc_1:turn_abc");
  });

  it("is a fast-null no-op when no incident is open on the session", async () => {
    findOpenBySession.mockResolvedValue(null);

    await closeIncidentOnDeliveredReply("sess_2", "turn_x");

    expect(findOpenBySession).toHaveBeenCalledWith("sess_2");
    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op for an already-terminal incident (excluded by the lookup)", async () => {
    // `findOpenBySession` filters to non-terminal rows, so a session whose only
    // incident is already AUTO_RESOLVED / RESOLVED returns null → no second close.
    findOpenBySession.mockResolvedValue(null);

    await closeIncidentOnDeliveredReply("sess_3", "turn_y");

    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });

  it("is fail-open: a lookup error never propagates to the reply path", async () => {
    findOpenBySession.mockRejectedValue(new Error("db down"));

    await expect(
      closeIncidentOnDeliveredReply("sess_4", "turn_z"),
    ).resolves.toBeUndefined();
    expect(closeIncidentFromEnvelope).not.toHaveBeenCalled();
  });
});
