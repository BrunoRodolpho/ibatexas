// Unit tests for pix-expiry-checker job governance — Task 16.
//
// What's under test:
//   1. Expired PIX payments trigger a payment.status.transition envelope
//      (SYSTEM taint, system actor, nonce = `pix:expiry:${paymentId}`).
//   2. EXECUTE path: Stripe PI canceled + payment.status_changed published.
//   3. REFUSE path: no Stripe cancel, no NATS publish.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockWithLock = vi.hoisted(() =>
  vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
);
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPublishNatsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@ibatexas/tools", () => ({
  withLock: mockWithLock,
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    payment: { findMany: mockFindMany },
  },
  createPaymentCommandService: () => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
  }),
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockGetAuditSinkEmit }),
}));

vi.mock("@sentry/node", () => ({
  withScope: (cb: (s: unknown) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  captureException: vi.fn(),
}));

vi.mock("../../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({ upsertJobScheduler: vi.fn(), close: vi.fn() })),
  createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("pix-expiry-checker governance (task 16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "payment_pending", newStatus: "payment_expired" },
    });
  });

  it("builds payment.status.transition envelope with SYSTEM actor + deterministic nonce", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "pay_pix_01",
        orderId: "order_01",
        stripePaymentIntentId: "pi_01",
        version: 1,
      },
    ]);

    const { checkPixExpiry } = await import("../../jobs/pix-expiry-checker.js");
    await checkPixExpiry(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
    const [envelope] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
    ];
    expect(envelope.kind).toBe("payment.status.transition");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("pix:expiry:pay_pix_01");
    expect(envelope.payload).toMatchObject({
      paymentId: "pay_pix_01",
      newStatus: "payment_expired",
      expectedVersion: 1,
      reason: "PIX expirado",
    });
  });

  it("on EXECUTE: cancels Stripe PI and publishes payment.status_changed", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "pay_pix_02",
        orderId: "order_02",
        stripePaymentIntentId: "pi_02",
        version: 1,
      },
    ]);

    const { checkPixExpiry } = await import("../../jobs/pix-expiry-checker.js");
    await checkPixExpiry(makeLogger() as never);

    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_02");
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({
        paymentId: "pay_pix_02",
        newStatus: "payment_expired",
      }),
    );
  });

  it("on REFUSE: no Stripe cancel, no NATS publish", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "pay_pix_03",
        orderId: "order_03",
        stripePaymentIntentId: "pi_03",
        version: 1,
      },
    ]);
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "payment.terminal_state",
          userFacing: "Pagamento já está em estado final.",
          class: "BUSINESS_RULE",
        },
        basis: [],
      },
    });

    const { checkPixExpiry } = await import("../../jobs/pix-expiry-checker.js");
    await checkPixExpiry(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
