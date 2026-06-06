// Unit tests for stale-order-checker job governance — Task 16.
//
// What's under test:
//   1. Stale candidates trigger an order.status.transition envelope
//      (SYSTEM taint, system actor, nonce = `stale:${orderId}`).
//   2. Active payment triggers a payment.status.transition envelope.
//   3. EXECUTE path: order.canceled + payment.status_changed published.
//   4. REFUSE path: nothing published, no withLock recursion.
//   5. Dry run does NOT call the envelope path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockWithLock = vi.hoisted(() =>
  vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
);
const mockPublishNatsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockPaymentTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  withLock: mockWithLock,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    orderProjection: { findMany: mockFindMany },
  },
  createOrderCommandService: () => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
  }),
  createPaymentCommandService: () => ({
    transitionStatusFromEnvelope: mockPaymentTransitionStatusFromEnvelope,
  }),
}));

// claustrum-on-dev WS8/WS9: `@ibatexas/llm-provider` was deleted. The SUT now
// imports `getAuditSink` from `@ibatexas/audit-sink` (wired to a no-op in the
// global test setup) and `parseBoolEnv` from `@ibatexas/types` (real, leaf),
// so no per-test mock of either is needed.
vi.mock("@sentry/node", () => ({
  withScope: (cb: (s: unknown) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  captureException: vi.fn(),
}));

vi.mock("../../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
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

describe("stale-order-checker governance (task 16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STALE_ORDER_DRY_RUN;
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "pending", newStatus: "canceled" },
    });
    mockPaymentTransitionStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, previousStatus: "payment_pending", newStatus: "canceled" },
    });
  });

  it("builds order.status.transition envelope with SYSTEM actor + deterministic nonce", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "order_stale_01",
        displayId: 100,
        customerId: "cust_01",
        currentPaymentId: "pay_01",
        payments: [{ id: "pay_01", status: "payment_pending", version: 1 }],
      },
    ]);

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
    const [envelope] = mockTransitionStatusFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
    ];
    expect(envelope.kind).toBe("order.status.transition");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("stale:order_stale_01");
    expect(envelope.actor.sessionId).toBe(
      "stale-order-checker:stale:order_stale_01",
    );
    expect(envelope.payload).toMatchObject({
      orderId: "order_stale_01",
      newStatus: "canceled",
      actor: "system",
      reason: "Pedido expirado — pagamento não confirmado",
    });
  });

  it("builds payment.status.transition envelope when active payment exists", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "order_stale_02",
        displayId: 101,
        customerId: "cust_02",
        currentPaymentId: "pay_02",
        payments: [{ id: "pay_02", status: "payment_pending", version: 3 }],
      },
    ]);

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockPaymentTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
    const [pEnv] = mockPaymentTransitionStatusFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
    ];
    expect(pEnv.kind).toBe("payment.status.transition");
    expect(pEnv.nonce).toBe("stale:pay_02");
    expect(pEnv.taint).toBe("SYSTEM");
    expect(pEnv.payload).toMatchObject({
      paymentId: "pay_02",
      newStatus: "canceled",
      expectedVersion: 3,
    });

    // payment.status_changed published with the right version
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({
        paymentId: "pay_02",
        newStatus: "canceled",
        version: 2,
      }),
    );
  });

  it("publishes order.canceled on EXECUTE", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "order_stale_03",
        displayId: 102,
        customerId: "cust_03",
        currentPaymentId: null,
        payments: [],
      },
    ]);

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.canceled",
      expect.objectContaining({
        orderId: "order_stale_03",
        canceledBy: "system",
      }),
    );
  });

  it("on REFUSE: does NOT publish events and skips payment transition", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "order_stale_04",
        displayId: 103,
        customerId: "cust_04",
        currentPaymentId: "pay_04",
        payments: [{ id: "pay_04", status: "payment_pending", version: 1 }],
      },
    ]);
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "order.projection.not_found",
          userFacing: "Pedido não encontrado.",
          class: "BUSINESS_RULE",
        },
        basis: [],
      },
    });

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).toHaveBeenCalledOnce();
    expect(mockPaymentTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("skips paid orders (preserves existing exclusion)", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "order_paid",
        displayId: 200,
        customerId: "cust_05",
        currentPaymentId: "pay_paid",
        payments: [{ id: "pay_paid", status: "paid", version: 2 }],
      },
    ]);

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
  });

  it("DRY RUN does NOT call envelope path", async () => {
    process.env.STALE_ORDER_DRY_RUN = "true";
    mockFindMany.mockResolvedValue([
      {
        id: "order_dry",
        displayId: 300,
        customerId: "cust_06",
        currentPaymentId: null,
        payments: [],
      },
    ]);

    const { checkStaleOrders } = await import("../../jobs/stale-order-checker.js");
    await checkStaleOrders(makeLogger() as never);

    expect(mockTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    expect(mockPaymentTransitionStatusFromEnvelope).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
