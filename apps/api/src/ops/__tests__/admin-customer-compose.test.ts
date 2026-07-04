// admin-customer-compose.ts — the OPS-070 read-composition unit (view-first).
// The route test covers the fully-populated + one-satellite-fail + 404 paths;
// this file pins the NULL / optional / string-date normalization branches and
// the empty-collection fallbacks the route fixtures don't hit.

import { describe, it, expect, vi } from "vitest";
import {
  composeAdminCustomerDetail,
  type AdminCustomerDetailComposeDeps,
} from "../admin-customer-compose.js";

const silentLog = { error: vi.fn() };

// Data fixtures (customer / addresses / orders / loyalty / optedOut) are kept
// SEPARATE from real dep overrides so they never collide with the `orders`
// accessor key on the deps object.
interface ComposeFixtures {
  customer?: unknown;
  addresses?: unknown;
  orders?: unknown;
  loyalty?: unknown;
  optedOut?: boolean;
  recentOrdersLimit?: number;
}

function deps(fx: ComposeFixtures = {}): AdminCustomerDetailComposeDeps {
  const getByIdForAdmin = vi.fn().mockResolvedValue(
    "customer" in fx
      ? fx.customer
      : { id: "c1", phone: "+55", createdAt: new Date(), updatedAt: new Date() },
  );
  const listAddresses = vi.fn().mockResolvedValue(fx.addresses ?? []);
  const listByCustomer = vi.fn().mockResolvedValue(fx.orders ?? { orders: [], count: 0 });
  const peekBalance = vi
    .fn()
    .mockResolvedValue(
      fx.loyalty ?? { stamps: 0, stampsNeeded: 10, totalEarned: 0, redeemed: 0, exists: false },
    );
  return {
    customerId: "c1",
    customers: () => ({ getByIdForAdmin, listAddresses }) as never,
    orders: () => ({ listByCustomer }) as never,
    loyalty: () => ({ peekBalance }) as never,
    isOptedOut: vi.fn().mockResolvedValue(fx.optedOut ?? false),
    log: silentLog,
    ...(fx.recentOrdersLimit !== undefined ? { recentOrdersLimit: fx.recentOrdersLimit } : {}),
  };
}

describe("composeAdminCustomerDetail", () => {
  it("returns null (→ 404) when the anchor customer read is null", async () => {
    const d = deps({ customer: null });
    await expect(composeAdminCustomerDetail(d)).resolves.toBeNull();
  });

  it("normalizes null optional profile fields and null preferences", async () => {
    const d = deps({
      customer: {
        id: "c1",
        phone: "+5511",
        name: null,
        email: null,
        cpf: null,
        source: null,
        firstContactAt: null,
        createdAt: "2026-06-01T00:00:00.000Z", // already an ISO string
        updatedAt: "2026-06-02T00:00:00.000Z",
        preferences: null,
      },
    });
    const out = await composeAdminCustomerDetail(d);
    expect(out).not.toBeNull();
    expect(out!.name).toBeNull();
    expect(out!.email).toBeNull();
    expect(out!.cpf).toBeNull();
    expect(out!.firstContactAt).toBeNull();
    expect(out!.preferences).toBeNull();
    // String dates pass through untouched (no double-wrap).
    expect(out!.createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(out!.addresses).toEqual([]);
    expect(out!.recentOrders).toEqual({ orders: [], count: 0 });
    expect(out!.loyalty.exists).toBe(false);
  });

  it("maps null address.complement and null order optionals", async () => {
    const d = deps({
      addresses: [
        {
          id: "a1",
          street: "R",
          number: "1",
          complement: null,
          district: "D",
          city: "C",
          state: "SP",
          cep: "01000000",
          isDefault: false,
        },
      ],
      orders: {
        orders: [
          {
            id: "o1",
            displayId: 1,
            fulfillmentStatus: "pending",
            paymentStatus: null,
            totalInCentavos: 0,
            itemCount: 1,
            deliveryType: null,
            paymentMethod: null,
            medusaCreatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
        count: 1,
      },
    });
    const out = await composeAdminCustomerDetail(d);
    expect(out!.addresses[0].complement).toBeNull();
    expect(out!.recentOrders.orders[0].paymentStatus).toBeNull();
    expect(out!.recentOrders.orders[0].deliveryType).toBeNull();
    expect(out!.recentOrders.orders[0].createdAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("honors an explicit recentOrdersLimit", async () => {
    const listByCustomer = vi.fn().mockResolvedValue({ orders: [], count: 0 });
    const d: AdminCustomerDetailComposeDeps = {
      ...deps({ recentOrdersLimit: 3 }),
      orders: () => ({ listByCustomer }) as never,
    };
    await composeAdminCustomerDetail(d);
    expect(listByCustomer).toHaveBeenCalledWith("c1", { limit: 3 });
  });
});
