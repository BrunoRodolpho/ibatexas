// customer-orders.ts — R5-S5 composition-root seam proof.
//
// This route had NO covering suite before R5-S5 (the enumeration in the slice
// report records it as the one target with zero coverage), so its seam would
// otherwise be born unguarded: a later change could stop honouring
// `options.deps` and nothing in the suite would notice.
//
// The only module intercepted here is the AUTH middleware, and deliberately
// so: `requireAuth` reads a real JWT/Redis session, which is orthogonal to the
// seam under test. `@ibatexas/domain` is NOT intercepted — it loads for real,
// which is what makes this revert-to-red. If `resolveCustomerOrderRouteDeps`
// stops honouring `options.deps`, the plugin falls back to the production
// `createOrderQueryService()` / `createPaymentQueryService()` bound to the REAL
// `prisma` singleton, and both assertions below fail on the singleton's
// invocation error rather than the injected stub's canned rows.
//
// It also pins this file's chosen shape: both constructions were PLUGIN-SCOPE
// (registration-time), and R5-S5 preserved that timing exactly rather than
// deferring them to first request.

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { OrderQueryService, PaymentQueryService } from "@ibatexas/domain";

const CUSTOMER_ID = "cust_seam_01";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (
    req: { customerId?: string },
    _reply: unknown,
    done: () => void,
  ) => {
    req.customerId = CUSTOMER_ID;
    done();
  },
}));

const { customerOrderRoutes } = await import("../customer-orders.js");
type Deps = import("../customer-orders.js").CustomerOrderRouteDeps;

const ORDER_ROW = {
  id: "order_seam_01",
  displayId: 4242,
  fulfillmentStatus: "preparing",
  paymentStatus: "pending",
  totalInCentavos: 8900,
  subtotalInCentavos: 8000,
  shippingInCentavos: 900,
  deliveryType: "delivery",
  paymentMethod: "pix",
  tipInCentavos: 0,
  version: 3,
  itemsJson: [{ title: "Costela bovina defumada", quantity: 1 }],
  medusaCreatedAt: new Date("2026-07-02T12:00:00.000Z"),
};

function buildDeps(): {
  deps: Deps;
  orderFactory: ReturnType<typeof vi.fn>;
  paymentFactory: ReturnType<typeof vi.fn>;
  listByCustomer: ReturnType<typeof vi.fn>;
} {
  const listByCustomer = vi.fn().mockResolvedValue({ orders: [ORDER_ROW], count: 1 });
  const getActiveByOrderId = vi.fn().mockResolvedValue(null);
  const orderFactory = vi.fn(
    () => ({ listByCustomer }) as unknown as OrderQueryService,
  );
  const paymentFactory = vi.fn(
    () => ({ getActiveByOrderId }) as unknown as PaymentQueryService,
  );
  return {
    orderFactory,
    paymentFactory,
    listByCustomer,
    deps: {
      orderQueryService: orderFactory as unknown as () => OrderQueryService,
      paymentQueryService: paymentFactory as unknown as () => PaymentQueryService,
    },
  };
}

async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // The seam under test: overrides nested under `deps`.
  await app.register(customerOrderRoutes, { deps });
  await app.ready();
  return app;
}

describe("customer-orders.ts — R5-S5 registration-level deps seam", () => {
  it("serves the INJECTED services, never the production singletons", async () => {
    const { deps, listByCustomer } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({ method: "GET", url: "/api/customer/orders" });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { orders: Array<Record<string, unknown>>; count: number };
      expect(body.count).toBe(1);
      // The row on the wire came from the injected double, mapped by the real
      // handler. With the seam neutered this is the prisma singleton instead.
      expect(body.orders[0]).toMatchObject({
        id: "order_seam_01",
        display_id: 4242,
        status: "preparing",
        payment_status: "pending",
        total: 8900,
        payment_method: "pix",
        source: "projection",
      });
      expect(listByCustomer).toHaveBeenCalledWith(CUSTOMER_ID, { limit: 50 });
    } finally {
      await server.close();
    }
  });

  it("constructs both services at REGISTRATION, once — the pre-R5-S5 timing", async () => {
    // Both were plugin-body constructions before the rollout. Preserving that
    // timing is the file's stated no-behavior-change claim; a rewrite that
    // deferred them to first request would fail the first expectation.
    const { deps, orderFactory, paymentFactory } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(orderFactory).toHaveBeenCalledTimes(1);
      expect(paymentFactory).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 3; i += 1) {
        const res = await server.inject({ method: "GET", url: "/api/customer/orders" });
        expect(res.statusCode).toBe(200);
      }

      // Still once — the handler reuses the registration-scope instances.
      expect(orderFactory).toHaveBeenCalledTimes(1);
      expect(paymentFactory).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
