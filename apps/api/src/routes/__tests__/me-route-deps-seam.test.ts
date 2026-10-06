// me.ts — R5-S5 composition-root seam proof.
//
// The sibling me-routes.test.ts drives these handlers through a
// `vi.mock("@ibatexas/domain")` factory interception. This file drives them
// with NO domain interception at all: it injects through the registration
// seam and lets the real module load. If `resolveMeRouteDeps` stops honouring
// `options.deps`, every handler below falls back to a service bound to the
// REAL `prisma` singleton and the assertions fail on the singleton's
// invocation error — there is no mock left to mask it.
//
// One route is exercised per dep member, chosen as the cheapest handler that
// reaches each one:
//
//   GET  /api/me/loyalty   → loyaltyService
//   GET  /api/me/addresses → customerService
//   POST /api/me/reviews   → orderQueryService (a null owner-scoped read is a
//                            403, so the seam is provable without a happy path)
//
// It also pins this file's chosen shape: every construction in me.ts was
// PER-REQUEST inline in a handler, so the factories must be called again on
// each request — never hoisted to registration, never memoized.

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import type { CustomerService, LoyaltyService, OrderQueryService } from "@ibatexas/domain";

const CUSTOMER_ID = "cust_seam_01";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: { customerId?: string }, _reply: unknown, done: () => void) => {
    req.customerId = CUSTOMER_ID;
    done();
  },
  optionalAuth: (req: { customerId?: string }, _reply: unknown, done: () => void) => {
    req.customerId = CUSTOMER_ID;
    done();
  },
}));

const { meRoutes } = await import("../me.js");
type Deps = import("../me.js").MeRouteDeps;

const ADDRESS = {
  id: "addr_seam_01",
  street: "Rua das Palmeiras",
  number: "42",
  complement: null,
  district: "Centro",
  city: "Ibaté",
  state: "SP",
  cep: "13970-000",
  isDefault: true,
};

const BALANCE = { stamps: 3, stampsNeeded: 7, totalEarned: 13 };

function buildDeps(): {
  deps: Deps;
  customerFactory: ReturnType<typeof vi.fn>;
  loyaltyFactory: ReturnType<typeof vi.fn>;
  orderFactory: ReturnType<typeof vi.fn>;
  redisFactory: ReturnType<typeof vi.fn>;
  listAddresses: ReturnType<typeof vi.fn>;
  getBalance: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
} {
  const listAddresses = vi.fn().mockResolvedValue([ADDRESS]);
  const getBalance = vi.fn().mockResolvedValue(BALANCE);
  // Owner-scoped read returns null → the handler's 403 branch. Enough to prove
  // the INJECTED service is the one consulted, with no happy path to stage.
  const getById = vi.fn().mockResolvedValue(null);

  const customerFactory = vi.fn(() => ({ listAddresses }) as unknown as CustomerService);
  const loyaltyFactory = vi.fn(() => ({ getBalance }) as unknown as LoyaltyService);
  const orderFactory = vi.fn(() => ({ getById }) as unknown as OrderQueryService);
  // R5 family 4: a TRIPWIRE, not a double. None of the three routes this file
  // drives touches Redis, so a resolution here is itself the defect.
  const redisFactory = vi.fn(() =>
    Promise.reject(new Error("me deps seam: redis must not resolve here")),
  );

  return {
    customerFactory,
    loyaltyFactory,
    orderFactory,
    redisFactory,
    listAddresses,
    getBalance,
    getById,
    deps: {
      customerService: customerFactory as unknown as () => CustomerService,
      loyaltyService: loyaltyFactory as unknown as () => LoyaltyService,
      orderQueryService: orderFactory as unknown as () => OrderQueryService,
      redis: redisFactory as unknown as Deps["redis"],
    },
  };
}

async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(meRoutes, { deps });
  await app.ready();
  return app;
}

describe("me.ts — R5-S5 registration-level deps seam", () => {
  it("serves the INJECTED LoyaltyService on GET /api/me/loyalty", async () => {
    const { deps, loyaltyFactory, getBalance } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({ method: "GET", url: "/api/me/loyalty" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stamps: 3, stampsNeeded: 7, totalEarned: 13 });
      expect(loyaltyFactory).toHaveBeenCalled();
      expect(getBalance).toHaveBeenCalledWith(CUSTOMER_ID);
    } finally {
      await server.close();
    }
  });

  it("serves the INJECTED CustomerService on GET /api/me/addresses", async () => {
    const { deps, customerFactory, listAddresses } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({ method: "GET", url: "/api/me/addresses" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ addresses: [ADDRESS] });
      expect(customerFactory).toHaveBeenCalled();
      expect(listAddresses).toHaveBeenCalledWith(CUSTOMER_ID);
    } finally {
      await server.close();
    }
  });

  it("consults the INJECTED OrderQueryService on POST /api/me/reviews", async () => {
    const { deps, orderFactory, getById } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/me/reviews",
        payload: { orderId: "order_seam_01", productId: "prod_01", rating: 5 },
      });
      // The injected read returned null → the owner-scoped 403 branch.
      expect(res.statusCode).toBe(403);
      expect(orderFactory).toHaveBeenCalled();
      // Owner-scoped: the customerId MUST be threaded, not just the orderId.
      expect(getById).toHaveBeenCalledWith("order_seam_01", { customerId: CUSTOMER_ID });
    } finally {
      await server.close();
    }
  });

  it("calls the injected factory PER REQUEST — never hoisted, never memoized", async () => {
    // me.ts's shape: every construction was per-request inline in a handler.
    // A rewrite that hoisted these to registration would fail the first
    // expectation; one that memoized them would fail the last.
    const { deps, loyaltyFactory } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(loyaltyFactory).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i += 1) {
        const res = await server.inject({ method: "GET", url: "/api/me/loyalty" });
        expect(res.statusCode).toBe(200);
      }

      expect(loyaltyFactory).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });
});
