// Unit tests for the backfill EXECUTOR (backfill-lineitem-ids.ts) with fully
// INJECTED deps — no prisma client, no Medusa, no network. Proves the sweep +
// re-derivation + raw-write orchestration (the live run itself is deferred, owner
// skip-live).

import { describe, expect, it, vi } from "vitest";
import { backfillLineItemIds, type BackfillDeps } from "../backfill-lineitem-ids.js";

/** A Medusa admin order shape toOrderProjectionData reads (id-bearing line items). */
function medusaOrder(id: string, itemIds: string[]) {
  return {
    id,
    display_id: 1,
    items: itemIds.map((li) => ({
      id: li,
      product_id: `prod_${li}`,
      variant_id: `var_${li}`,
      title: li,
      quantity: 1,
      unit_price: 25,
    })),
  };
}

interface Row {
  id: string;
  itemsJson: unknown;
}

function fakeDeps(rows: Row[], medusaOrders: Record<string, ReturnType<typeof medusaOrder>>) {
  const updateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const findMany = vi.fn(async () => rows);
  const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateCalls.push(args);
    return {};
  });
  const medusaAdmin = vi.fn(async (path: string) => {
    const id = path.replace("/admin/orders/", "");
    const order = medusaOrders[id];
    if (order === undefined) {
      const e = new Error("not found") as Error & { statusCode?: number };
      e.statusCode = 404;
      throw e;
    }
    return { order };
  });
  // The real mapper is pure; a faithful fake echoes the id-bearing itemsJson + count.
  const toOrderProjectionData = vi.fn((order: ReturnType<typeof medusaOrder>) => ({
    itemsJson: order.items.map((it) => ({
      id: it.id,
      productId: it.product_id,
      variantId: it.variant_id,
      title: it.title,
      quantity: it.quantity,
      priceInCentavos: 2500,
    })),
    itemCount: order.items.length,
  }));
  const deps = {
    prisma: { orderProjection: { findMany, update } },
    toOrderProjectionData,
    medusaAdmin,
  } as unknown as BackfillDeps;
  return { deps, updateCalls, findMany, update, medusaAdmin, toOrderProjectionData };
}

describe("backfillLineItemIds — dry-run (read-only preview)", () => {
  it("reports the plan, writes nothing, fetches no Medusa", async () => {
    const rows: Row[] = [
      { id: "o_legacy", itemsJson: [{ variantId: "v1" }] },
      { id: "o_done", itemsJson: [{ id: "li_1" }] },
      { id: "o_empty", itemsJson: [] },
    ];
    const { deps, update, medusaAdmin } = fakeDeps(rows, {});

    const res = await backfillLineItemIds({ dryRun: true, deps });

    expect(res.dryRun).toBe(true);
    expect(res.scanned).toBe(3);
    expect(res.updated).toEqual([]);
    expect(res.plan.toBackfill).toEqual(["o_legacy"]);
    expect(res.skippedAlreadyId).toEqual(["o_done"]);
    expect(res.skippedNoItems).toEqual(["o_empty"]);
    expect(update).not.toHaveBeenCalled();
    expect(medusaAdmin).not.toHaveBeenCalled();
  });
});

describe("backfillLineItemIds — live sweep", () => {
  it("re-derives + writes ONLY the needing-backfill rows (itemsJson + itemCount, NO version bump)", async () => {
    const rows: Row[] = [
      { id: "o_legacy", itemsJson: [{ variantId: "v1" }, { variantId: "v2" }] },
      { id: "o_done", itemsJson: [{ id: "li_x" }] },
    ];
    const { deps, updateCalls, medusaAdmin } = fakeDeps(rows, {
      o_legacy: medusaOrder("o_legacy", ["li_1", "li_2"]),
    });

    const res = await backfillLineItemIds({ deps });

    expect(res.updated).toEqual(["o_legacy"]);
    expect(res.skippedAlreadyId).toEqual(["o_done"]);
    expect(res.medusa404Skipped).toEqual([]);
    // Only the legacy order was fetched from Medusa (the complete one is skipped).
    expect(medusaAdmin).toHaveBeenCalledTimes(1);
    expect(medusaAdmin).toHaveBeenCalledWith("/admin/orders/o_legacy");
    // Exactly one write, carrying the re-derived id-bearing itemsJson + itemCount.
    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0]!;
    expect(call.where).toEqual({ id: "o_legacy" });
    expect(Object.keys(call.data).sort()).toEqual(["itemCount", "itemsJson"]);
    expect(call.data.itemCount).toBe(2);
    expect((call.data.itemsJson as Array<{ id: string }>).map((i) => i.id)).toEqual([
      "li_1",
      "li_2",
    ]);
    // DATA ENRICHMENT, not a state transition — version must NOT be touched.
    expect(call.data).not.toHaveProperty("version");
    expect(call.data).not.toHaveProperty("fulfillmentStatus");
  });

  it("skips an order Medusa no longer has (404 → medusa404Skipped, no write)", async () => {
    const rows: Row[] = [{ id: "o_gone", itemsJson: [{ variantId: "v1" }] }];
    const { deps, update } = fakeDeps(rows, {}); // no Medusa order → 404

    const res = await backfillLineItemIds({ deps });

    expect(res.updated).toEqual([]);
    expect(res.medusa404Skipped).toEqual(["o_gone"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("is idempotent: a fully-backfilled sweep writes nothing", async () => {
    const rows: Row[] = [
      { id: "o1", itemsJson: [{ id: "li_1" }] },
      { id: "o2", itemsJson: [{ id: "li_2" }, { id: "li_3" }] },
    ];
    const { deps, update, medusaAdmin } = fakeDeps(rows, {});

    const res = await backfillLineItemIds({ deps });

    expect(res.updated).toEqual([]);
    expect(res.skippedAlreadyId).toEqual(["o1", "o2"]);
    expect(update).not.toHaveBeenCalled();
    expect(medusaAdmin).not.toHaveBeenCalled();
  });
});
