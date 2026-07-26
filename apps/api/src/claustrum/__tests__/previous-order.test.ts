// LE2-021 — direct unit tests for the previous-order grounding read.
//
// The turn-seam e2e proves this module is ALIVE through the real gate; it drives
// only the two states a real conversation reaches (an order, or none). This file
// owns the degrade branches, which are the ones that decide what a customer is
// told when something is wrong — and which no happy-path turn can reach:
// a database that throws, a projection row written by an older schema version,
// a line with no title, a quantity of zero.
//
// Every one of them converges on `null`, which `confirmReorderLast` turns into
// the honest no-history sentence. That convergence is the property under test:
// there is no input to this module that yields a PARTIAL order, because a
// partial order is what would let a confirmation name a basket nobody read.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rowsFake, throwFake } = vi.hoisted(() => ({
  rowsFake: { rows: [] as unknown[] },
  throwFake: { on: false },
}));

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createOrderQueryService: () => ({
      listByCustomer: async (customerId: string, input?: { limit?: number }) => {
        if (throwFake.on) throw new Error("projection read failed");
        const owned = rowsFake.rows.filter(
          (r) => (r as { customerId?: string }).customerId === customerId,
        );
        return { orders: owned.slice(0, input?.limit ?? 20), count: owned.length };
      },
    }),
  };
});

const { loadPreviousOrder } = await import("../previous-order.js");

const CUSTOMER = "cus_prevorder";

/** A well-formed projection row for the customer under test. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order_prev_1",
    displayId: 1042,
    customerId: CUSTOMER,
    totalInCentavos: 12_500,
    itemsJson: [
      { productId: "p1", variantId: "v1", title: "Costela", quantity: 2, priceInCentavos: 4500 },
    ],
    medusaCreatedAt: new Date("2026-07-20T18:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  rowsFake.rows = [];
  throwFake.on = false;
});

describe("loadPreviousOrder — the happy path", () => {
  it("projects the newest owned order down to id, displayId, total and lines", async () => {
    rowsFake.rows = [row()];
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toEqual({
      orderId: "order_prev_1",
      displayId: 1042,
      totalInCentavos: 12_500,
      items: [{ title: "Costela", quantity: 2 }],
    });
  });

  it("asks for exactly ONE row — 'the last order' is a limit, not a client-side sort", async () => {
    // `listByCustomer` is already `medusaCreatedAt desc`, so a limit of 1 IS the
    // query. Two rows here with the fake preserving order: taking anything other
    // than the first would surface the older one.
    rowsFake.rows = [row({ id: "newest" }), row({ id: "older" })];
    const previous = await loadPreviousOrder(CUSTOMER);
    expect(previous?.orderId).toBe("newest");
  });
});

describe("loadPreviousOrder — every degrade converges on null", () => {
  it("null for a customer with no orders", async () => {
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toBeNull();
  });

  it("null for the EMPTY customer id, without touching the store", async () => {
    // Guarded before the query rather than relying on the filter to miss: an
    // owner-scoped read with no owner is not a read that returns nothing, it is
    // a read that should not have been issued.
    rowsFake.rows = [row()];
    await expect(loadPreviousOrder("")).resolves.toBeNull();
  });

  it("null when the newest order belongs to SOMEONE ELSE", async () => {
    // The de-vacuuming control: a row DOES exist, it just is not this
    // customer's. Without the query's `customerId` filter this would resolve.
    rowsFake.rows = [row({ customerId: "cus_other" })];
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toBeNull();
  });

  it("null — never a throw — when the projection read fails", async () => {
    // Fail-SAFE, one direction only. A transient database error must degrade to
    // "I could not find a previous order", never to an exception that ghosts the
    // turn and never to a confirmation over a basket nobody read.
    throwFake.on = true;
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toBeNull();
  });
});

describe("loadPreviousOrder — the itemsJson narrowing", () => {
  // `itemsJson` is a Prisma `Json?` column, so its runtime shape is a hint and
  // never a guarantee: rows written by an older projection version, or by hand,
  // can be anything. The only consumer is a sentence a customer is asked to
  // approve, so a malformed line is DROPPED rather than defaulted — "1x
  // undefined" in a confirmation is worse than a shorter list.

  it.each([
    ["null", null],
    ["an object", { not: "an array" }],
    ["a string", "[]"],
    ["a number", 7],
  ])("null when itemsJson is %s", async (_label, itemsJson) => {
    rowsFake.rows = [row({ itemsJson })];
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toBeNull();
  });

  it("null when EVERY line is malformed — an empty list is no history", async () => {
    rowsFake.rows = [
      row({ itemsJson: [{ title: "", quantity: 2 }, { title: "X", quantity: 0 }] }),
    ];
    await expect(loadPreviousOrder(CUSTOMER)).resolves.toBeNull();
  });

  it.each([
    ["a blank title", { title: "   ", quantity: 2 }],
    ["a missing title", { quantity: 2 }],
    ["a non-string title", { title: 42, quantity: 2 }],
    ["a zero quantity", { title: "Fantasma", quantity: 0 }],
    ["a negative quantity", { title: "Fantasma", quantity: -3 }],
    ["a missing quantity", { title: "Fantasma" }],
    ["a non-numeric quantity", { title: "Fantasma", quantity: "dois" }],
    ["a NaN quantity", { title: "Fantasma", quantity: Number.NaN }],
  ])("drops a line with %s and keeps the rest", async (_label, bad) => {
    rowsFake.rows = [
      row({ itemsJson: [{ title: "Costela", quantity: 2 }, bad] }),
    ];
    const previous = await loadPreviousOrder(CUSTOMER);
    expect(previous?.items).toEqual([{ title: "Costela", quantity: 2 }]);
  });

  it("trims a padded title and truncates a fractional quantity", async () => {
    rowsFake.rows = [
      row({ itemsJson: [{ title: "  Costela  ", quantity: 2.7 }] }),
    ];
    const previous = await loadPreviousOrder(CUSTOMER);
    expect(previous?.items).toEqual([{ title: "Costela", quantity: 2 }]);
  });

  it("tolerates a null entry inside the array", async () => {
    rowsFake.rows = [
      row({ itemsJson: [null, { title: "Costela", quantity: 1 }, undefined] }),
    ];
    const previous = await loadPreviousOrder(CUSTOMER);
    expect(previous?.items).toEqual([{ title: "Costela", quantity: 1 }]);
  });

  it("preserves the projection's own line ORDER", async () => {
    // The confirm names the first three lines, so order decides what a customer
    // sees. It is the order the projection recorded, never a re-sort.
    rowsFake.rows = [
      row({
        itemsJson: [
          { title: "Zebu", quantity: 1 },
          { title: "Alcatra", quantity: 1 },
          { title: "Costela", quantity: 1 },
        ],
      }),
    ];
    const previous = await loadPreviousOrder(CUSTOMER);
    expect(previous?.items.map((i) => i.title)).toEqual(["Zebu", "Alcatra", "Costela"]);
  });
});
