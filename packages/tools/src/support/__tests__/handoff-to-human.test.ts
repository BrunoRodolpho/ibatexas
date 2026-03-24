// Tests for handoff_to_human tool
//
// Validates:
//   1. Publishes support.handoff_requested NATS event with correct payload
//   2. Returns success with estimated wait time

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock NATS client ────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

import { handoffToHuman } from "../handoff-to-human.js";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("handoffToHuman", () => {
  it("publishes support.handoff_requested NATS event", async () => {
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await handoffToHuman({ sessionId: "sess-123", reason: "Preciso de ajuda com meu pedido" });

    expect(mockPublishNatsEvent).toHaveBeenCalledOnce();
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("support.handoff_requested", {
      sessionId: "sess-123",
      reason: "Preciso de ajuda com meu pedido",
    });
  });

  it("publishes event without reason when not provided", async () => {
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await handoffToHuman({ sessionId: "sess-456" });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("support.handoff_requested", {
      sessionId: "sess-456",
      reason: undefined,
    });
  });

  it("returns success with estimated wait time", async () => {
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const result = await handoffToHuman({ sessionId: "sess-789" });

    expect(result.success).toBe(true);
    expect(result.estimatedWaitMinutes).toBe(5);
    expect(result.message).toBe("Um atendente foi notificado e entrará em contato em breve.");
  });
});
