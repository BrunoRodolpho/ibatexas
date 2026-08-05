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
import type { SubscriberArgs } from "@medusajs/framework";

// ── Helpers ───────────────────────────────────────────────────────────────────

// The handler reads exactly two things off its argument: `event.data.id` and
// `container.resolve("logger")`. The stub implements that surface and nothing
// else, so it stands in for a real `SubscriberArgs` — whose `container` is a
// full Awilix container that cannot be built in a unit test. The widening hop
// through `unknown` is what the partial stub costs; naming the destination type
// is what keeps the seam honest (a bare `as any` named nothing).
function buildArgs(productId: string): SubscriberArgs<{ id: string }> {
  return {
    event: { data: { id: productId } },
    container: {
      resolve: (_key: string) => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
  } as unknown as SubscriberArgs<{ id: string }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("product.deleted subscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes product.intelligence.purge with correct productId", async () => {
    await productDeletedHandler(buildArgs("prod_123"));

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

    await productDeletedHandler(buildArgs("prod_456"));

    expect(callOrder).toEqual(["typesense", "cache", "nats"]);
  });

  it("does not publish the event when Typesense deletion throws", async () => {
    mockWithTypesenseRetry.mockRejectedValueOnce(new Error("Typesense unavailable"));

    await productDeletedHandler(buildArgs("prod_789"));

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
