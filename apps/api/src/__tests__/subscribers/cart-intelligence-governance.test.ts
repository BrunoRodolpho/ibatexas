// Unit tests for cart-intelligence subscriber governance — Task 16.
//
// What's under test:
//   1. order.placed: order.projection.create envelope shape, payment.create
//      envelope shape, both with SYSTEM taint + system actor + deterministic nonce.
//   2. order.status_changed: order.status.reconcile envelope shape.
//   3. EXECUTE / REFUSE branching: EXECUTE proceeds, REFUSE pushes DLQ.
//
// External deps are mocked at the module boundary. The legacy intelligence
// side-effects (Redis pipelines, copurchase, loyalty) are mocked to no-ops
// — this test is scoped to the governance wraps only.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `ibatexas:${key}`));
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockEventLogAppend = vi.hoisted(() => vi.fn());
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockReconcileStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockPaymentCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockAddStamp = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ stamps: 1, rewarded: false }),
);
const mockAddStampFromEnvelope = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { stamps: 1, rewarded: false },
  }),
);
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockIsNewEvent = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockWithDedup = vi.hoisted(() =>
  vi.fn().mockImplementation(async (_key: string, handler: () => Promise<void>) => {
    await handler();
    return true;
  }),
);

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  PROFILE_TTL_SECONDS: 604800,
  getWhatsAppSender: mockGetWhatsAppSender,
  reaisToCentavos: (n: number) => Math.round(n * 100),
  atomicIncr: vi.fn().mockResolvedValue(1),
  medusaStore: vi.fn(),
  medusaAdmin: vi.fn(),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    recordOrderItems: mockRecordOrderItems,
    getById: mockGetById,
  }),
  createOrderEventLogService: () => ({
    append: mockEventLogAppend,
  }),
  createOrderCommandService: () => ({
    createFromEnvelope: mockCreateFromEnvelope,
    reconcileStatusFromEnvelope: mockReconcileStatusFromEnvelope,
  }),
  createPaymentCommandService: () => ({
    createFromEnvelope: mockPaymentCreateFromEnvelope,
  }),
  createLoyaltyService: () => ({
    addStamp: mockAddStamp,
    addStampFromEnvelope: mockAddStampFromEnvelope,
  }),
  ConcurrencyError: class ConcurrencyError extends Error {},
  ITEMS_SCHEMA_VERSION: 1,
}));

vi.mock("../../subscribers/dedup.js", () => ({
  isNewEvent: mockIsNewEvent,
  withDedup: mockWithDedup,
}));

vi.mock("../../subscribers/dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

vi.mock("../../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: vi.fn(),
}));

vi.mock("../../whatsapp/client.js", () => ({
  sendText: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  withScope: (cb: (s: unknown) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function createMockRedis() {
  const pipeline = {
    zIncrBy: vi.fn().mockReturnThis(),
    zRemRangeByRank: vi.fn().mockReturnThis(),
    lPush: vi.fn().mockReturnThis(),
    lTrim: vi.fn().mockReturnThis(),
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    hIncrBy: vi.fn().mockResolvedValue(1),
    hSet: vi.fn().mockResolvedValue(true),
    hDel: vi.fn().mockResolvedValue(1),
    hKeys: vi.fn().mockResolvedValue([]),
    hGet: vi.fn().mockResolvedValue(null),
    multi: vi.fn().mockReturnValue(pipeline),
  };
}

async function registerSubscribers() {
  for (const key of Object.keys(natsHandlers)) {
    delete natsHandlers[key];
  }
  const { startCartIntelligenceSubscribers } = await import(
    "../../subscribers/cart-intelligence.js"
  );
  await startCartIntelligenceSubscribers();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cart-intelligence order.placed governance (task 16)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockIsNewEvent.mockResolvedValue(true);
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockRecordOrderItems.mockResolvedValue({ count: 1 });
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "order_01", version: 1 },
    });
    mockPaymentCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "pay_01", version: 1 },
    });
    await registerSubscribers();
  });

  it("builds order.projection.create envelope with SYSTEM actor + deterministic nonce", async () => {
    await natsHandlers["order.placed"]!({
      customerId: "cust_01",
      orderId: "order_01",
      displayId: 42,
      items: [{ productId: "prod_01", variantId: "var_01", quantity: 1, priceInCentavos: 5000 }],
      totalInCentavos: 5000,
    });

    expect(mockCreateFromEnvelope).toHaveBeenCalledOnce();
    const [envelope] = mockCreateFromEnvelope.mock.calls[0] as [IntentEnvelope];
    expect(envelope.kind).toBe("order.projection.create");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("projection:order_01");
    expect(envelope.actor.sessionId).toBe("order.placed:projection:order_01");
    expect(envelope.payload).toMatchObject({
      orderId: "order_01",
      customerId: "cust_01",
      fulfillmentStatus: "pending",
      totalInCentavos: 5000,
    });
  });

  it("builds payment.create envelope with SYSTEM actor + deterministic nonce", async () => {
    await natsHandlers["order.placed"]!({
      customerId: "cust_02",
      orderId: "order_02",
      displayId: 43,
      paymentMethod: "pix",
      stripePaymentIntentId: "pi_02",
      items: [{ productId: "prod_02", variantId: "var_02", quantity: 1, priceInCentavos: 8900 }],
      totalInCentavos: 8900,
    });

    expect(mockPaymentCreateFromEnvelope).toHaveBeenCalledOnce();
    const [envelope] = mockPaymentCreateFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
    ];
    expect(envelope.kind).toBe("payment.create");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("payment:order_02");
    expect(envelope.payload).toMatchObject({
      orderId: "order_02",
      method: "pix",
      amountInCentavos: 8900,
      stripePaymentIntentId: "pi_02",
    });
  });

  it("on payment REFUSE: pushes to DLQ", async () => {
    mockPaymentCreateFromEnvelope.mockResolvedValue({
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

    await natsHandlers["order.placed"]!({
      customerId: "cust_03",
      orderId: "order_03",
      displayId: 44,
      paymentMethod: "pix",
      items: [{ productId: "prod_03", variantId: "var_03", quantity: 1, priceInCentavos: 1000 }],
      totalInCentavos: 1000,
    });

    expect(mockPushToDlq).toHaveBeenCalled();
    const [dlqEvent] = mockPushToDlq.mock.calls[0] as [string];
    expect(dlqEvent).toBe("order.placed");
  });

  it("skips when dedup flags the event as duplicate", async () => {
    // After B2 fix: order.placed uses withDedup (not isNewEvent).
    // Return false to simulate a duplicate (already processed / in-flight).
    mockWithDedup.mockResolvedValue(false);

    await natsHandlers["order.placed"]!({
      customerId: "cust_04",
      orderId: "order_04",
      items: [{ productId: "prod_04", variantId: "var_04", quantity: 1 }],
    });

    expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
    expect(mockPaymentCreateFromEnvelope).not.toHaveBeenCalled();
  });
});

describe("cart-intelligence order.status_changed governance (task 16)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    mockReconcileStatusFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2 },
    });
    await registerSubscribers();
  });

  it("builds order.status.reconcile envelope with SYSTEM actor", async () => {
    await natsHandlers["order.status_changed"]!({
      orderId: "order_50",
      displayId: 50,
      previousStatus: "pending",
      newStatus: "confirmed",
      customerId: "cust_50",
      version: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockReconcileStatusFromEnvelope).toHaveBeenCalledOnce();
    const [envelope] = mockReconcileStatusFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
    ];
    expect(envelope.kind).toBe("order.status.reconcile");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("reconcile:order_50:2");
    expect(envelope.payload).toMatchObject({
      orderId: "order_50",
      newStatus: "confirmed",
      eventVersion: 2,
      actor: "system",
    });
  });

  it("on REFUSE: pushes to DLQ", async () => {
    mockReconcileStatusFromEnvelope.mockResolvedValue({
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

    await natsHandlers["order.status_changed"]!({
      orderId: "order_51",
      displayId: 51,
      previousStatus: "pending",
      newStatus: "confirmed",
      customerId: "cust_51",
      version: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockPushToDlq).toHaveBeenCalled();
    const [dlqEvent] = mockPushToDlq.mock.calls[0] as [string];
    expect(dlqEvent).toBe("order.status_changed");
  });
});
