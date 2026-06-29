// Unit tests for the cart-intelligence subscriber — UNCOVERED handlers + branches.
//
// Complements:
//   • src/__tests__/cart-intelligence.test.ts (order.placed / product.viewed /
//     refunded / disputed / canceled / review.submitted / cart.item_added / dedup)
//   • src/__tests__/subscribers/cart-intelligence-governance.test.ts (envelope
//     shapes + payment REFUSE→DLQ + reconcile REFUSE→DLQ)
//
// This file targets the handlers those two never touch and the kernel-decision
// branches not yet hit:
//   - reservation.created / modified / cancelled / no_show (profile counters)
//   - outreach.sent (profile update + error-swallow)
//   - notification.send (deliver / skip / stub / body-precedence / DLQ)
//   - search.results_viewed (batch recentlyViewed)
//   - review.prompt.schedule (schedule) + review.prompt (delivery)
//   - product.intelligence.purge (copurchase + global-score cleanup)
//   - follow-up.due (reason → notification body)
//   - order.payment_failed (event-log append)
//   - order.status_changed notification path (notifiable vs non-notifiable)
//   - kernel-write branches: projection REFUSE→DLQ, projection ESCALATE→no-DLQ,
//     reconcile ConcurrencyError→no-DLQ
//
// All external deps are mocked at the module boundary — no real Redis / NATS /
// Medusa / WhatsApp / LLM. User-facing assertions check pt-BR strings.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConcurrencyError } from "@ibatexas/domain";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `ibatexas:${key}`));
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockEventLogAppend = vi.hoisted(() => vi.fn());
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockReconcileStatusFromEnvelope = vi.hoisted(() => vi.fn());
const mockPaymentCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockAddStampFromEnvelope = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { stamps: 1, rewarded: false },
  }),
);
const mockScheduleReviewPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendText = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());

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
  createOrderEventLogService: () => ({ append: mockEventLogAppend }),
  createOrderCommandService: () => ({
    createFromEnvelope: mockCreateFromEnvelope,
    reconcileStatusFromEnvelope: mockReconcileStatusFromEnvelope,
  }),
  createPaymentCommandService: () => ({
    createFromEnvelope: mockPaymentCreateFromEnvelope,
  }),
  createLoyaltyService: () => ({ addStampFromEnvelope: mockAddStampFromEnvelope }),
  ConcurrencyError: class ConcurrencyError extends Error {},
  ITEMS_SCHEMA_VERSION: 1,
}));

vi.mock("../../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: mockScheduleReviewPrompt,
}));

vi.mock("../../whatsapp/client.js", () => ({ sendText: mockSendText }));

vi.mock("../../subscribers/dlq.js", () => ({ pushToDlq: mockPushToDlq }));

vi.mock("@sentry/node", () => ({
  withScope: (cb: (s: unknown) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ── Redis mock ──────────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  const pipeline = {
    zIncrBy: vi.fn().mockReturnThis(),
    zRemRangeByRank: vi.fn().mockReturnThis(),
    zRem: vi.fn().mockReturnThis(),
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
    zRem: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue({ cursor: 0, keys: [] }),
    multi: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
    ...overrides,
  };
}

async function registerSubscribers() {
  for (const key of Object.keys(natsHandlers)) delete natsHandlers[key];
  const { startCartIntelligenceSubscribers } = await import(
    "../../subscribers/cart-intelligence.js"
  );
  await startCartIntelligenceSubscribers();
}

function resetCommonMocks() {
  vi.clearAllMocks();
  mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  mockGetWhatsAppSender.mockReturnValue(null);
  mockGetById.mockResolvedValue(null);
  mockEventLogAppend.mockResolvedValue(undefined);
  mockRecordOrderItems.mockResolvedValue({ count: 1 });
  mockScheduleReviewPrompt.mockResolvedValue(undefined);
  mockAddStampFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { stamps: 1, rewarded: false },
  });
  mockCreateFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { id: "order_01", version: 1 },
  });
  mockPaymentCreateFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { id: "pay_01", version: 1 },
  });
  mockReconcileStatusFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { version: 2 },
  });
}

// ── reservation.* profile counters ──────────────────────────────────────────

describe("reservation.* profile-update handlers", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    resetCommonMocks();
    redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    await registerSubscribers();
  });

  it("reservation.created increments reservationCount + sets lastReservationAt + resets TTL", async () => {
    await natsHandlers["reservation.created"]({ customerId: "cus_res" });

    expect(redis.hIncrBy).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_res",
      "reservationCount",
      1,
    );
    expect(redis.hSet).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_res",
      "lastReservationAt",
      expect.any(String),
    );
    expect(redis.expire).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_res",
      604800,
    );
  });

  it("reservation.created skips entirely when customerId is missing", async () => {
    await natsHandlers["reservation.created"]({});
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it("reservation.modified records lastReservationModifiedAt", async () => {
    await natsHandlers["reservation.modified"]({ customerId: "cus_mod" });

    expect(redis.hSet).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_mod",
      "lastReservationModifiedAt",
      expect.any(String),
    );
    // modified mutate does NOT touch the counter fields
    expect(redis.hIncrBy).not.toHaveBeenCalled();
  });

  it("reservation.modified skips when customerId is missing", async () => {
    await natsHandlers["reservation.modified"]({});
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it("reservation.cancelled increments cancellationCount", async () => {
    await natsHandlers["reservation.cancelled"]({ customerId: "cus_can" });

    expect(redis.hIncrBy).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_can",
      "cancellationCount",
      1,
    );
  });

  it("reservation.no_show increments noShowCount", async () => {
    await natsHandlers["reservation.no_show"]({ customerId: "cus_ns" });

    expect(redis.hIncrBy).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_ns",
      "noShowCount",
      1,
    );
  });
});

// ── outreach.sent ───────────────────────────────────────────────────────────

describe("outreach.sent handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  it("records lastOutreachAt and resets profile TTL", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    await natsHandlers["outreach.sent"]({
      customerId: "cus_out",
      messageType: "win_back",
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    expect(redis.hSet).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_out",
      "lastOutreachAt",
      expect.any(String),
    );
    expect(redis.expire).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_out",
      604800,
    );
  });

  it("skips when customerId is missing", async () => {
    await natsHandlers["outreach.sent"]({ messageType: "win_back" });
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it("swallows mutation errors (never rethrows so NATS does not crash)", async () => {
    const redis = createMockRedis({
      hSet: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    mockGetRedisClient.mockResolvedValue(redis);

    await expect(
      natsHandlers["outreach.sent"]({
        customerId: "cus_err",
        messageType: "win_back",
        sentAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});

// ── notification.send ───────────────────────────────────────────────────────

describe("notification.send handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    await registerSubscribers();
  });

  it("delivers via the configured WhatsApp sender to the customer phone", async () => {
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: "5519999990000" });

    await natsHandlers["notification.send"]({
      type: "order_received",
      customerId: "cus_n1",
      channel: "whatsapp",
      body: "Seu pedido foi recebido!",
    });

    expect(senderSendText).toHaveBeenCalledWith(
      "whatsapp:5519999990000",
      "Seu pedido foi recebido!",
    );
  });

  it("body takes precedence over the legacy message field", async () => {
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: "5519999990001" });

    await natsHandlers["notification.send"]({
      type: "promo",
      customerId: "cus_n2",
      channel: "whatsapp",
      message: "mensagem legada",
      body: "mensagem personalizada",
    });

    expect(senderSendText).toHaveBeenCalledWith(
      "whatsapp:5519999990001",
      "mensagem personalizada",
    );
  });

  it("skips non-whatsapp channels without looking up the customer", async () => {
    await natsHandlers["notification.send"]({
      type: "promo",
      customerId: "cus_n3",
      channel: "email",
      body: "x",
    });

    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("does not send when the customer has no phone", async () => {
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: null });

    await natsHandlers["notification.send"]({
      type: "promo",
      customerId: "cus_n4",
      channel: "whatsapp",
      body: "x",
    });

    expect(senderSendText).not.toHaveBeenCalled();
  });

  it("routes a delivery failure to the DLQ (not silently dropped)", async () => {
    const senderSendText = vi.fn().mockRejectedValue(new Error("twilio 500"));
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: "5519999990005" });

    await natsHandlers["notification.send"]({
      type: "promo",
      customerId: "cus_n5",
      channel: "whatsapp",
      body: "x",
    });

    expect(mockPushToDlq).toHaveBeenCalled();
    const [subject] = mockPushToDlq.mock.calls[0] as [string];
    expect(subject).toBe("notification.send");
  });
});

// ── search.results_viewed (batch) ───────────────────────────────────────────

describe("search.results_viewed handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  it("pushes every productId into recentlyViewed and resets profile TTL", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    await natsHandlers["search.results_viewed"]({
      customerId: "cus_s",
      productIds: ["p1", "p2", "p3"],
    });

    expect(redis._pipeline.lPush).toHaveBeenCalledTimes(3);
    expect(redis._pipeline.lPush).toHaveBeenCalledWith(
      "ibatexas:customer:recentlyViewed:cus_s",
      "p1",
    );
    expect(redis._pipeline.lTrim).toHaveBeenCalledWith(
      "ibatexas:customer:recentlyViewed:cus_s",
      0,
      19,
    );
    expect(redis.expire).toHaveBeenCalledWith(
      "ibatexas:customer:profile:cus_s",
      604800,
    );
  });

  it("skips when productIds is empty", async () => {
    await natsHandlers["search.results_viewed"]({
      customerId: "cus_s2",
      productIds: [],
    });
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it("skips when customerId is missing", async () => {
    await natsHandlers["search.results_viewed"]({
      customerId: null,
      productIds: ["p1"],
    });
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });
});

// ── review.prompt.schedule ──────────────────────────────────────────────────

describe("review.prompt.schedule handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  it("schedules a review prompt for the customer/order", async () => {
    await natsHandlers["review.prompt.schedule"]({
      customerId: "cus_rp",
      orderId: "order_rp",
    });

    expect(mockScheduleReviewPrompt).toHaveBeenCalledWith("cus_rp", "order_rp");
  });

  it("skips when orderId is missing", async () => {
    await natsHandlers["review.prompt.schedule"]({ customerId: "cus_rp" });
    expect(mockScheduleReviewPrompt).not.toHaveBeenCalled();
  });
});

// ── review.prompt (delivery) ────────────────────────────────────────────────

describe("review.prompt delivery handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  afterEach(() => {
    delete process.env.APP_BASE_URL;
  });

  it("sends a pt-BR review request with the account link when phone + APP_BASE_URL set", async () => {
    process.env.APP_BASE_URL = "https://ibatexas.example";
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: "5519999991111" });

    await natsHandlers["review.prompt"]({
      customerId: "cus_rpd",
      orderId: "order_rpd",
    });

    expect(senderSendText).toHaveBeenCalledTimes(1);
    const [to, message] = senderSendText.mock.calls[0] as [string, string];
    expect(to).toBe("whatsapp:5519999991111");
    expect(message).toContain("Como foi sua experiência?");
    expect(message).toContain("https://ibatexas.example/conta/pedidos");
  });

  it("does not send when APP_BASE_URL is not configured", async () => {
    delete process.env.APP_BASE_URL;
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: "5519999992222" });

    await natsHandlers["review.prompt"]({
      customerId: "cus_rpd2",
      orderId: "order_rpd2",
    });

    expect(senderSendText).not.toHaveBeenCalled();
  });

  it("does not send when the customer has no phone", async () => {
    process.env.APP_BASE_URL = "https://ibatexas.example";
    const senderSendText = vi.fn().mockResolvedValue(undefined);
    mockGetWhatsAppSender.mockReturnValue({ sendText: senderSendText });
    mockGetById.mockResolvedValue({ phone: null });

    await natsHandlers["review.prompt"]({
      customerId: "cus_rpd3",
      orderId: "order_rpd3",
    });

    expect(senderSendText).not.toHaveBeenCalled();
  });
});

// ── product.intelligence.purge ──────────────────────────────────────────────

describe("product.intelligence.purge handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  it("deletes the product's own copurchase set, scrubs it from peers, and drops global scores", async () => {
    const redis = createMockRedis({
      scan: vi.fn().mockResolvedValue({
        cursor: 0,
        keys: ["ibatexas:copurchase:peer_a", "ibatexas:copurchase:peer_b"],
      }),
    });
    mockGetRedisClient.mockResolvedValue(redis);

    await natsHandlers["product.intelligence.purge"]({ productId: "prod_purge" });

    // 1. own copurchase set deleted
    expect(redis.del).toHaveBeenCalledWith("ibatexas:copurchase:prod_purge");
    // 2. removed from every peer copurchase set (pipeline zRem per scanned key)
    expect(redis._pipeline.zRem).toHaveBeenCalledTimes(2);
    expect(redis._pipeline.zRem).toHaveBeenCalledWith(
      "ibatexas:copurchase:peer_a",
      "prod_purge",
    );
    // 3. removed from both global ranking sets
    expect(redis.zRem).toHaveBeenCalledWith(
      "ibatexas:product:global:score",
      "prod_purge",
    );
    expect(redis.zRem).toHaveBeenCalledWith(
      "ibatexas:product:cart:popularity",
      "prod_purge",
    );
  });
});

// ── follow-up.due ───────────────────────────────────────────────────────────

describe("follow-up.due handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    mockPublishNatsEvent.mockResolvedValue(undefined);
    await registerSubscribers();
  });

  it("publishes a cart_save follow-up notification with the customer name", async () => {
    mockGetById.mockResolvedValue({ phone: "5519999993333", name: "Bruno" });

    await natsHandlers["follow-up.due"]({
      customerId: "cus_fu",
      reason: "cart_save",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        type: "follow_up",
        customerId: "cus_fu",
        channel: "whatsapp",
        body: expect.stringContaining("carrinho ainda tá salvo"),
      }),
    );
    const [, evt] = mockPublishNatsEvent.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(evt.body).toContain("Bruno");
  });

  it("uses the generic fallback message for an unknown reason", async () => {
    mockGetById.mockResolvedValue({ phone: "5519999994444", name: null });

    await natsHandlers["follow-up.due"]({
      customerId: "cus_fu2",
      reason: "totally_unknown_reason",
    });

    const [, evt] = mockPublishNatsEvent.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(evt.body).toContain("IbateXas tá aqui se precisar");
  });

  it("does not publish when the customer has no phone", async () => {
    mockGetById.mockResolvedValue({ phone: null });

    await natsHandlers["follow-up.due"]({
      customerId: "cus_fu3",
      reason: "thinking",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

// ── order.payment_failed ────────────────────────────────────────────────────

describe("order.payment_failed handler", () => {
  beforeEach(async () => {
    resetCommonMocks();
    await registerSubscribers();
  });

  it("appends a payment-failure event keyed by the stripe payment intent", async () => {
    await natsHandlers["order.payment_failed"]({
      orderId: "order_pf",
      stripePaymentIntentId: "pi_pf",
      lastPaymentError: "card_declined",
    });

    expect(mockEventLogAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_pf",
        eventType: "order.payment_failed",
        discriminator: "pi_pf",
      }),
    );
  });

  it("falls back to orderId as the discriminator when no stripe intent is present", async () => {
    await natsHandlers["order.payment_failed"]({ orderId: "order_pf2" });

    expect(mockEventLogAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "order.payment_failed",
        discriminator: "order_pf2",
      }),
    );
  });
});

// ── order.status_changed notification path ──────────────────────────────────

describe("order.status_changed notification path", () => {
  beforeEach(async () => {
    resetCommonMocks();
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    delete process.env.STAFF_ALERT_PHONE;
    await registerSubscribers();
  });

  it("queues a WhatsApp notification for a notifiable transition with a customer", async () => {
    await natsHandlers["order.status_changed"]({
      orderId: "order_sc",
      displayId: 77,
      previousStatus: "preparing",
      newStatus: "confirmed",
      customerId: "cus_sc",
      version: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({
        type: "order_confirmed",
        customerId: "cus_sc",
        channel: "whatsapp",
        body: expect.stringContaining("confirmado"),
      }),
    );
  });

  it("does NOT notify on a non-notifiable transition", async () => {
    await natsHandlers["order.status_changed"]({
      orderId: "order_sc2",
      displayId: 78,
      previousStatus: "confirmed",
      newStatus: "pending",
      customerId: "cus_sc2",
      version: 4,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("does NOT notify when the order has no customerId", async () => {
    await natsHandlers["order.status_changed"]({
      orderId: "order_sc3",
      displayId: 79,
      previousStatus: "preparing",
      newStatus: "ready",
      version: 5,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});

// ── kernel-write decision branches (not hit by the governance suite) ─────────

describe("kernel-write decision branches", () => {
  beforeEach(async () => {
    resetCommonMocks();
    mockGetRedisClient.mockResolvedValue(createMockRedis());
    delete process.env.STAFF_ALERT_PHONE;
    await registerSubscribers();
  });

  it("order.projection.create REFUSE routes the source event to the DLQ with the projection label", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "order.projection.duplicate",
          userFacing: "Projeção já existe.",
          class: "BUSINESS_RULE",
        },
        basis: [],
      },
    });
    // payment authorizes so the only DLQ push comes from the projection REFUSE
    mockPaymentCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "pay_x", version: 1 },
    });

    await natsHandlers["order.placed"]({
      customerId: "cus_k1",
      orderId: "order_k1",
      items: [{ productId: "p1", variantId: "v1", quantity: 1, priceInCentavos: 1000 }],
    });

    expect(mockPushToDlq).toHaveBeenCalledTimes(1);
    const [subject, , reason] = mockPushToDlq.mock.calls[0] as [
      string,
      unknown,
      string,
    ];
    expect(subject).toBe("order.placed");
    expect(reason).toContain("projection");
    expect(reason).toContain("order.projection.duplicate");
  });

  it("a non-REFUSE, non-EXECUTE projection decision (ESCALATE) warns but does NOT push to the DLQ", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "ESCALATE", basis: [] },
    });
    mockPaymentCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "ESCALATE", basis: [] },
    });

    await natsHandlers["order.placed"]({
      customerId: "cus_k2",
      orderId: "order_k2",
      items: [{ productId: "p1", variantId: "v1", quantity: 1, priceInCentavos: 1000 }],
    });

    // ESCALATE is not authorized but is also not a REFUSE → no DLQ, no crash.
    expect(mockPushToDlq).not.toHaveBeenCalled();
  });

  it("order.status_changed reconcile ConcurrencyError is treated as already-applied (no DLQ)", async () => {
    mockReconcileStatusFromEnvelope.mockRejectedValue(
      new ConcurrencyError("order_k3", 2, 1),
    );

    await natsHandlers["order.status_changed"]({
      orderId: "order_k3",
      displayId: 80,
      previousStatus: "confirmed",
      newStatus: "pending", // non-notifiable + no customerId → no further side effects
      version: 6,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(mockPushToDlq).not.toHaveBeenCalled();
  });
});
