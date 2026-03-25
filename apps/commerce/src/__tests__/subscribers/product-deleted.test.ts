// Unit tests for product.deleted subscriber (apps/commerce)
// Verifies that publishNatsEvent is called with the correct event name and productId

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteProductFromIndex = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateAllQueryCache = vi.hoisted(() => vi.fn().mockResolvedValue(5));
const mockWithTypesenseRetry = vi.hoisted(() =>
  vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
);

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/tools", () => ({
  deleteProductFromIndex: mockDeleteProductFromIndex,
  invalidateAllQueryCache: mockInvalidateAllQueryCache,
}));

vi.mock("../../subscribers/_product-indexing", () => ({
  withTypesenseRetry: mockWithTypesenseRetry,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import productDeletedHandler from "../../subscribers/product-deleted";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildArgs(productId: string) {
  return {
    event: { data: { id: productId } },
    container: {
      resolve: (_key: string) => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("product.deleted subscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes product.intelligence.purge with correct productId", async () => {
    await productDeletedHandler(buildArgs("prod_123") as any);

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("product.intelligence.purge", {
      productId: "prod_123",
    });
  });

  it("publishes the event after Typesense deletion and cache flush", async () => {
    const callOrder: string[] = [];
    mockWithTypesenseRetry.mockImplementation(async (fn: () => Promise<unknown>) => {
      const result = await fn();
      callOrder.push("typesense");
      return result;
    });
    mockInvalidateAllQueryCache.mockImplementation(async () => {
      callOrder.push("cache");
      return 3;
    });
    mockPublishNatsEvent.mockImplementation(async () => {
      callOrder.push("nats");
    });

    await productDeletedHandler(buildArgs("prod_456") as any);

    expect(callOrder).toEqual(["typesense", "cache", "nats"]);
  });

  it("does not publish the event when Typesense deletion throws", async () => {
    mockWithTypesenseRetry.mockRejectedValueOnce(new Error("Typesense unavailable"));

    await productDeletedHandler(buildArgs("prod_789") as any);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
