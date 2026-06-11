// Unit tests for the customer checkout confirmation store.
//
// Mirrors the admin-confirmation-store coverage (create / single-use
// consume / expired→null) but Docker-free: a Map-backed mock Redis stands
// in for the real client, and `eval` emulates the atomic GET+DEL Lua so the
// single-use invariant is exercised end-to-end.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (key: string) => `ibatexas:${key}`,
}));

import {
  createCheckoutConfirmationStore,
  CHECKOUT_CONFIRMATION_TTL_SECONDS,
  type PendingCheckout,
} from "../routes/checkout-confirmation-store.js";

// Map-backed Redis: `set` stores, `get` reads, `eval` emulates the store's
// atomic GET+DEL consume script (the only script it runs).
function makeStatefulRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_script: string, opts: { keys: string[] }) => {
      const key = opts.keys[0];
      const val = store.get(key);
      if (val !== undefined) {
        store.delete(key);
        return val;
      }
      return null;
    }),
  };
}

const PENDING: PendingCheckout = {
  kind: "order.checkout.create",
  payload: { cartId: "cart_01", paymentMethod: "pix" },
  idempotencyKey: "cart_01:checkout",
  cartId: "cart_01",
  customerId: "cus_01",
  userType: "customer",
  checkoutBody: { cartId: "cart_01", paymentMethod: "pix", notes: "sem cebola" },
  pixExtra: { customerName: "Ana", customerEmail: "ana@example.com", customerTaxId: "52998224725" },
  prompt: "Confirmar pedido de R$ 1.500,00?",
  createdAt: "2026-06-08T12:00:00.000Z",
};

describe("checkout-confirmation-store", () => {
  let redis: ReturnType<typeof makeStatefulRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeStatefulRedis();
    mockGetRedisClient.mockResolvedValue(redis);
  });

  it("create() stores the pending under a UUID receipt + returns the TTL", async () => {
    const store = createCheckoutConfirmationStore();
    const { confirmationId, ttlSeconds } = await store.create(PENDING);

    expect(confirmationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(ttlSeconds).toBe(CHECKOUT_CONFIRMATION_TTL_SECONDS);
    // Persisted under the rk()-namespaced key with the 10-min EX.
    expect(redis.set).toHaveBeenCalledWith(
      `ibatexas:checkout:confirmation:${confirmationId}`,
      JSON.stringify(PENDING),
      { EX: CHECKOUT_CONFIRMATION_TTL_SECONDS },
    );
  });

  it("consume() returns the pending exactly once (single-use)", async () => {
    const store = createCheckoutConfirmationStore();
    const { confirmationId } = await store.create(PENDING);

    const first = await store.consume(confirmationId);
    expect(first).toEqual(PENDING);

    // Second consume of the same receipt → null (atomic GET+DEL drained it).
    const second = await store.consume(confirmationId);
    expect(second).toBeNull();
  });

  it("consume() of an unknown / expired receipt → null", async () => {
    const store = createCheckoutConfirmationStore();
    // Nothing stored — models both the unknown-id and the TTL-expired cases
    // (Redis cannot distinguish them; the route surfaces both as 410).
    const result = await store.consume("11111111-2222-3333-4444-555555555555");
    expect(result).toBeNull();
  });

  it("consume() rejects malformed ids without touching Redis", async () => {
    const store = createCheckoutConfirmationStore();

    expect(await store.consume("")).toBeNull();
    expect(await store.consume("x".repeat(65))).toBeNull();
    // The UUID-shape gate short-circuits before any Redis round trip.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("consume() tolerates malformed stored JSON → null", async () => {
    const store = createCheckoutConfirmationStore();
    redis.store.set("ibatexas:checkout:confirmation:bad", "{not json");

    const result = await store.consume("bad");
    expect(result).toBeNull();
  });
});
