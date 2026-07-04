// Unit tests for the per-dish ingredient stock depletion subscriber (NEW-036).
//
// Coverage:
//   (a) single-line order → depleteStock called with qtyMilli × quantity per line
//   (b) multi-line order  → each line's recipe depleted
//   (c) recipe-less product (getByProduct → null) → NO depleteStock call (no-op)
//   (d) shortfall > 0 → structured warn logged
//   (e) handler throw → routed to the DLQ, NEVER rethrown into the order flow
//   (f) duplicate (withDedup → false) → skip, no depletion
//
// The subscriber is NON-KERNEL: it calls the domain services directly (no
// system-actor envelope, no adjudicate). Own queue group + own dedup namespace.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockGetByProduct = vi.hoisted(() => vi.fn());
const mockDepleteStock = vi.hoisted(() => vi.fn());
const mockWithDedup = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockOpenAlert = vi.hoisted(() => vi.fn());
const mockGetAuditSink = vi.hoisted(() => vi.fn(() => ({})));

// Store registered handlers so we can invoke them directly in tests.
const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
    },
  ),
}));

vi.mock("@ibatexas/domain", () => ({
  createRecipeService: () => ({ getByProduct: mockGetByProduct }),
  createIngredientService: () => ({ depleteStock: mockDepleteStock }),
  createOpsAlertService: () => ({ openAlertFromEnvelope: mockOpenAlert }),
  OPS_ALERT_CAUSE_LABELS_PT: {
    ops_ingredient_underflow: "estoque de insumo abaixo do necessário (baixa de pedido)",
  },
}));

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: mockGetAuditSink,
}));

vi.mock("../dedup.js", () => ({
  withDedup: mockWithDedup,
}));

vi.mock("../dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

// ── SUT ────────────────────────────────────────────────────────────────────────

import { startIngredientDepletionSubscriber } from "../ingredient-depletion.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────

type Line = { ingredientId: string; qtyMilli: number };
const recipeWith = (...ingredients: Line[]) => ({ id: "rec", ingredients });

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makePayload(
  items: Array<{ productId: string; variantId?: string; quantity: number }>,
  orderId = "order_1",
) {
  return {
    orderId,
    items: items.map((i) => ({ variantId: "var", priceInCentavos: 0, ...i })),
  };
}

async function register() {
  for (const key of Object.keys(natsHandlers)) delete natsHandlers[key];
  await startIngredientDepletionSubscriber(log as never);
}

const fire = (payload: unknown) => natsHandlers["order.placed"]!(payload);

// ── Setup ────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: depleteStock reports a healthy row (no shortfall).
  mockDepleteStock.mockResolvedValue({ id: "ing", stockMilli: 100, shortfallMilli: 0 });
  // Default: the ops-alert chokepoint authorizes the open.
  mockOpenAlert.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: { opened: true } });
  mockGetAuditSink.mockReturnValue({});
  // Default: withDedup runs the handler and reports "newly processed".
  mockWithDedup.mockImplementation(async (_key: string, handler: () => Promise<void>) => {
    await handler();
    return true;
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ingredient-depletion subscriber", () => {
  it("subscribes to order.placed on its OWN queue group", async () => {
    await register();

    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith(
      "order.placed",
      expect.any(Function),
      { queueGroup: "ingredient-depletion" },
    );
  });

  it("(a) single-line order → depletes each recipe ingredient by qtyMilli × quantity", async () => {
    mockGetByProduct.mockResolvedValue(
      recipeWith({ ingredientId: "ing_1", qtyMilli: 100 }, { ingredientId: "ing_2", qtyMilli: 250 }),
    );
    await register();

    await fire(makePayload([{ productId: "prod_1", quantity: 3 }]));

    expect(mockGetByProduct).toHaveBeenCalledWith("prod_1");
    expect(mockDepleteStock).toHaveBeenCalledWith("ing_1", 300); // 100 × 3
    expect(mockDepleteStock).toHaveBeenCalledWith("ing_2", 750); // 250 × 3
    expect(mockDepleteStock).toHaveBeenCalledTimes(2);
  });

  it("(b) multi-line order → each line's recipe is depleted", async () => {
    mockGetByProduct.mockImplementation(async (productId: string) =>
      productId === "prod_1"
        ? recipeWith({ ingredientId: "ing_1", qtyMilli: 100 })
        : recipeWith({ ingredientId: "ing_2", qtyMilli: 40 }),
    );
    await register();

    await fire(
      makePayload([
        { productId: "prod_1", quantity: 2 },
        { productId: "prod_2", quantity: 5 },
      ]),
    );

    expect(mockDepleteStock).toHaveBeenCalledWith("ing_1", 200); // 100 × 2
    expect(mockDepleteStock).toHaveBeenCalledWith("ing_2", 200); // 40 × 5
    expect(mockDepleteStock).toHaveBeenCalledTimes(2);
  });

  it("(c) recipe-less product → NO depleteStock call (no-op)", async () => {
    mockGetByProduct.mockResolvedValue(null);
    await register();

    await fire(makePayload([{ productId: "prod_no_recipe", quantity: 4 }]));

    expect(mockGetByProduct).toHaveBeenCalledWith("prod_no_recipe");
    expect(mockDepleteStock).not.toHaveBeenCalled();
    expect(mockPushToDlq).not.toHaveBeenCalled();
  });

  it("(d) shortfall > 0 → logs a structured warn AND opens an ops_ingredient_underflow alert", async () => {
    mockGetByProduct.mockResolvedValue(recipeWith({ ingredientId: "ing_1", qtyMilli: 500 }));
    mockDepleteStock.mockResolvedValue({
      id: "ing_1",
      name: "Farinha",
      unit: "kg",
      stockMilli: 0,
      shortfallMilli: 700,
    });
    await register();

    await fire(makePayload([{ productId: "prod_1", quantity: 2 }]));

    // (d.1) the existing NEW-036 structured warn.
    expect(log.warn).toHaveBeenCalledWith(
      {
        order_id: "order_1",
        product_id: "prod_1",
        ingredient_id: "ing_1",
        consume_milli: 1000, // 500 × 2
        shortfall_milli: 700,
      },
      "[ingredient-depletion] ingredient depleted below zero — stock accuracy issue",
    );

    // (d.2 / NEW-037) a first-class ops-alert on the ops-alert plane.
    expect(mockOpenAlert).toHaveBeenCalledTimes(1);
    const envelope = mockOpenAlert.mock.calls[0]![0] as {
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(envelope.kind).toBe("ops.alert.open");
    expect(envelope.payload).toMatchObject({
      cause: "ops_ingredient_underflow",
      severity: "medium",
      source: "ingredient-depletion",
      scope: "ing_1",
      dedupeKey: "ops_ingredient_underflow:ing_1",
    });
    expect(envelope.payload.context).toMatchObject({
      orderId: "order_1",
      productId: "prod_1",
      ingredientId: "ing_1",
      consumeMilli: 1000,
      shortfallMilli: 700,
      unit: "kg",
    });
  });

  it("(c) does NOT warn NOR open an ops-alert when there is no shortfall", async () => {
    mockGetByProduct.mockResolvedValue(recipeWith({ ingredientId: "ing_1", qtyMilli: 100 }));
    mockDepleteStock.mockResolvedValue({ id: "ing_1", stockMilli: 900, shortfallMilli: 0 });
    await register();

    await fire(makePayload([{ productId: "prod_1", quantity: 1 }]));

    expect(log.warn).not.toHaveBeenCalled();
    expect(mockOpenAlert).not.toHaveBeenCalled();
  });

  it("(b) ops-alert emission THROWS → remaining lines still deplete AND pushToDlq is NOT called (best-effort isolation)", async () => {
    // A two-ingredient recipe; BOTH lines underflow. The ops-alert emit throws on
    // every call — the loop must still deplete line 2 and never route to the DLQ.
    mockGetByProduct.mockResolvedValue(
      recipeWith(
        { ingredientId: "ing_1", qtyMilli: 500 },
        { ingredientId: "ing_2", qtyMilli: 300 },
      ),
    );
    mockDepleteStock.mockImplementation(async (id: string) => ({
      id,
      name: id,
      unit: "kg",
      stockMilli: 0,
      shortfallMilli: 100,
    }));
    mockOpenAlert.mockRejectedValue(new Error("kernel down"));
    await register();

    const payload = makePayload([{ productId: "prod_1", quantity: 1 }]);
    // The handler must NOT reject — the order flow is never affected.
    await expect(fire(payload)).resolves.toBeUndefined();

    // Both lines were depleted despite the ops-alert failures on each.
    expect(mockDepleteStock).toHaveBeenCalledTimes(2);
    expect(mockDepleteStock).toHaveBeenCalledWith("ing_1", 500);
    expect(mockDepleteStock).toHaveBeenCalledWith("ing_2", 300);
    // Ops-alert failure is swallowed per-line: attempted twice, warned twice.
    expect(mockOpenAlert).toHaveBeenCalledTimes(2);
    // CRITICAL: an ops-alert failure never routes order.placed to the DLQ.
    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: "order_1",
        ingredient_id: "ing_2",
        error: expect.stringContaining("kernel down"),
      }),
      "[ingredient-depletion] ops-alert emission failed — depletion not affected",
    );
  });

  it("(e) handler throw → routed to the DLQ, never rethrown into the order flow", async () => {
    mockGetByProduct.mockResolvedValue(recipeWith({ ingredientId: "ing_1", qtyMilli: 100 }));
    mockDepleteStock.mockRejectedValue(new Error("db down"));
    await register();

    const payload = makePayload([{ productId: "prod_1", quantity: 1 }]);
    // Must NOT reject — the order flow is never affected.
    await expect(fire(payload)).resolves.toBeUndefined();

    expect(mockPushToDlq).toHaveBeenCalledWith(
      "order.placed",
      payload,
      expect.any(Error),
      log,
    );
    expect(log.error).toHaveBeenCalled();
  });

  it("(f) duplicate (withDedup → false) → skips depletion", async () => {
    mockGetByProduct.mockResolvedValue(recipeWith({ ingredientId: "ing_1", qtyMilli: 100 }));
    // Duplicate: dedup guard reports already-processed and does NOT run the handler.
    mockWithDedup.mockResolvedValue(false);
    await register();

    await fire(makePayload([{ productId: "prod_1", quantity: 1 }], "order_dup"));

    expect(mockWithDedup).toHaveBeenCalledWith("depletion:order_dup", expect.any(Function));
    expect(mockDepleteStock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { order_id: "order_dup" },
      "[ingredient-depletion] order.placed duplicate — skipping",
    );
  });
});
