// admin/customers.ts — R5-S5 composition-root seam proof.
//
// The sibling customers.test.ts drives this route through a
// `vi.mock("@ibatexas/domain")` factory interception. This file drives the
// SAME route with NO module interception at all: it injects through the
// registration seam (`app.register(adminCustomerRoutes, { deps })`) and lets
// the real `@ibatexas/domain` module load untouched.
//
// That distinction is the whole point, and it is what makes this test
// revert-to-red rather than decorative. If `resolveAdminCustomerRouteDeps`
// stops honouring `options.deps`, the accessors fall back to the production
// `createCustomerService()` — a service bound to the REAL `prisma` singleton —
// and every assertion below fails on the singleton's invocation error instead
// of the injected stub's canned row. There is no mock left to mask it.
//
// It also pins the one property specific to this file's chosen shape: R5-S5
// converged ON the pre-existing lazy `??=` accessor idiom rather than
// replacing it, so the injected factory must be called LAZILY (not at
// registration) and MEMOIZED (once across many requests).

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { CustomerService, LoyaltyService, OrderQueryService } from "@ibatexas/domain";
import { adminCustomerRoutes, type AdminCustomerRouteDeps } from "../customers.js";

const OWNER = { staffId: "staff_own_01", staffRole: "OWNER" as const };

const SEARCH_RESULT = {
  customers: [
    {
      id: "cust_seam_01",
      name: "Seam Injected",
      phone: "+5511999990001",
      email: "seam@example.com",
      source: "whatsapp",
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
    },
  ],
  count: 1,
};

/**
 * A dep member this route must never reach for on the path under test.
 * Mirrors the `unreachableDep` guard in cart-pix-details-envelope.test.ts:
 * a member filled with a thrower proves non-reach instead of assuming it.
 */
function unreachableDep(name: keyof AdminCustomerRouteDeps): () => never {
  return () => {
    throw new Error(`admin/customers.ts reached for deps.${name}()`);
  };
}

function buildDeps(): {
  deps: AdminCustomerRouteDeps;
  customerFactory: ReturnType<typeof vi.fn>;
  searchForAdmin: ReturnType<typeof vi.fn>;
} {
  const searchForAdmin = vi.fn().mockResolvedValue(SEARCH_RESULT);
  // Only the two methods this route calls on the search path — a partial
  // double is honest here because anything else it reached for would be a
  // TypeError, not a silent pass.
  const customerService = { searchForAdmin } as unknown as CustomerService;
  const customerFactory = vi.fn(() => customerService);
  return {
    customerFactory,
    searchForAdmin,
    deps: {
      customerService: customerFactory as unknown as () => CustomerService,
      // The detail/loyalty reads are NOT on the list path. Throwers, so a
      // future change that quietly starts calling them fails loudly.
      orderQueryService: unreachableDep("orderQueryService") as unknown as () => OrderQueryService,
      loyaltyService: unreachableDep("loyaltyService") as unknown as () => LoyaltyService,
    },
  };
}

async function buildServer(deps: AdminCustomerRouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { staffId: string }).staffId = OWNER.staffId;
    (req as unknown as { staffRole: string }).staffRole = OWNER.staffRole;
  });
  // The seam under test: overrides nested under `deps`, alongside Fastify's
  // own register options.
  await app.register(adminCustomerRoutes, { deps });
  await app.ready();
  return app;
}

describe("admin/customers.ts — R5-S5 registration-level deps seam", () => {
  it("serves the INJECTED CustomerService, never the production singleton", async () => {
    const { deps, customerFactory, searchForAdmin } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/customers?q=seam&limit=10&offset=0",
      });

      expect(res.statusCode).toBe(200);
      // The row on the wire came from the injected double. With the seam
      // neutered this is the real prisma singleton's error path instead.
      expect(res.json()).toEqual({
        customers: [
          {
            id: "cust_seam_01",
            name: "Seam Injected",
            phone: "+5511999990001",
            email: "seam@example.com",
            source: "whatsapp",
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ],
        count: 1,
      });
      expect(customerFactory).toHaveBeenCalled();
      expect(searchForAdmin).toHaveBeenCalledWith({ q: "seam", limit: 10, offset: 0 });
    } finally {
      await server.close();
    }
  });

  it("calls the injected factory LAZILY and memoizes it across requests", async () => {
    // The accessor-converged shape R5-S5 chose for this file: construction is
    // still deferred to first request and still `??=`-memoized. A rewrite that
    // hoisted construction into the plugin body would fail the first
    // expectation; one that dropped the memo would fail the last.
    const { deps, customerFactory } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(customerFactory).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i += 1) {
        const res = await server.inject({ method: "GET", url: "/api/admin/customers" });
        expect(res.statusCode).toBe(200);
      }

      expect(customerFactory).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
