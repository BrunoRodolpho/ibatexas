// Unit tests for staff high-value cart alert in cart.abandoned subscriber

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `test:${key}`));
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn());
const mockMedusaStore = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockRecordOrderItems = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());

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
  medusaStore: mockMedusaStore,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    recordOrderItems: mockRecordOrderItems,
    getById: vi.fn().mockResolvedValue({ id: "cus_01", name: "Cliente Teste", phone: "+5519900000001" }),
  }),
  createLoyaltyService: () => ({
    addStamp: vi.fn().mockResolvedValue({ stamps: 1, rewarded: false }),
  }),
}));

vi.mock("@sentry/node", () => ({
  captureException: mockSentryCaptureException,
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
}));

vi.mock("../../jobs/review-prompt.js", () => ({
  scheduleReviewPrompt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobs/cart-recovery-messages.js", () => ({
  buildCartRecoveryMessage: vi.fn().mockReturnValue("Seu carrinho está esperando!"),
}));

vi.mock("../../whatsapp/client.js", () => ({
  sendText: mockSendText,
}));

vi.mock("../../session/store.js", () => ({
  loadSession: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../whatsapp/session.js", () => ({
  hashPhone: vi.fn((phone: string) => `hash_${phone}`),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { startCartIntelligenceSubscribers } from "../../subscribers/cart-intelligence.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
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
    hGet: vi.fn().mockResolvedValue(null),
    hDel: vi.fn().mockResolvedValue(1),
    hKeys: vi.fn().mockResolvedValue([]),
    multi: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
    ...overrides,
  };
}

async function registerSubscribers() {
  for (const key of Object.keys(natsHandlers)) {
    delete natsHandlers[key];
  }
  await startCartIntelligenceSubscribers();
}

const ABANDONED_CART_PAYLOAD = {
  cartId: "cart_01",
  sessionId: "sess_01",
  customerId: "cus_01",
  phone: "+5519900000001",
  customerName: "Cliente Teste",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cart.abandoned — staff high-value cart alert", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `test:${key}`);
    await registerSubscribers();
    delete process.env.STAFF_ALERT_PHONE;
  });

  it("sends alert to STAFF_ALERT_PHONE when cart total > R$200 (20000 centavos)", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({
      // First get: nudge key (no previous tier), incr for alert counter
      incr: vi.fn().mockResolvedValue(1),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 25000 } }); // R$250

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("250,00"),
    );
    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("Cliente Teste"),
    );
  });

  it("does NOT send alert when cart total is exactly R$200 (threshold is >20000)", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 20000 } }); // exactly R$200

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).not.toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("🚨"),
    );
  });

  it("does NOT send alert when cart total < R$200", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 15000 } }); // R$150

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).not.toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("🚨"),
    );
  });

  it("suppresses the 11th alert in the same hour (rate limit = 10)", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({
      // incr returns 11 — over rate limit
      incr: vi.fn().mockResolvedValue(11),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 50000 } });

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).not.toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("🚨"),
    );
  });

  it("sends the 10th alert (boundary: rate limit allows up to 10)", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({
      incr: vi.fn().mockResolvedValue(10),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 30000 } });

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5519900000099",
      expect.stringContaining("🚨"),
    );
  });

  it("skips silently when STAFF_ALERT_PHONE is not set", async () => {
    // STAFF_ALERT_PHONE not set (deleted in beforeEach)
    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaStore.mockResolvedValue({ cart: { total: 50000 } });

    await natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD);

    expect(mockSendText).not.toHaveBeenCalledWith(
      expect.stringContaining("whatsapp:"),
      expect.stringContaining("🚨"),
    );
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it("does NOT block cart abandonment flow when staff alert throws", async () => {
    process.env.STAFF_ALERT_PHONE = "+5519900000099";

    const mockRedis = createMockRedis({ incr: vi.fn().mockResolvedValue(1) });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // medusaStore throws — staff alert path fails
    mockMedusaStore.mockRejectedValue(new Error("Medusa unavailable"));

    // Should resolve without throwing
    await expect(
      natsHandlers["cart.abandoned"](ABANDONED_CART_PAYLOAD),
    ).resolves.toBeUndefined();

    // Main nudge flow still ran
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "notification.send",
      expect.objectContaining({ type: "cart_abandoned" }),
    );
  });
});
