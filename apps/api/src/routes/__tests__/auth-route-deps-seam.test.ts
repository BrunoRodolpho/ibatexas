// auth.ts — R5-S5 composition-root seam proof.
//
// Injects through the registration seam with NO `@ibatexas/domain`
// interception: the real module loads, so if `resolveAuthRouteDeps` stops
// honouring `options.deps` both handlers fall back to a service bound to the
// REAL `prisma` singleton and fail on its invocation error.
//
// The only modules intercepted are the AUTH middlewares, and deliberately so:
// they read real JWTs / Redis sessions, which is orthogonal to the seam under
// test. Two identity-echo reads are the cheapest handlers reaching each member:
//
//   GET /api/auth/me       → customerService
//   GET /api/auth/staff/me → staffService
//
// It also pins this file's chosen shape: both constructions were PER-REQUEST
// inline in a handler, so the factories must be called again on each request.

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { CustomerService, StaffService } from "@ibatexas/domain";

const CUSTOMER_ID = "cust_seam_01";
const STAFF_ID = "staff_seam_01";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: { customerId?: string }, _reply: unknown, done: () => void) => {
    req.customerId = CUSTOMER_ID;
    done();
  },
  optionalAuth: (
    req: { staffId?: string; staffRole?: string },
    _reply: unknown,
    done: () => void,
  ) => {
    req.staffId = STAFF_ID;
    req.staffRole = "MANAGER";
    done();
  },
}));

vi.mock("../../middleware/staff-auth.js", () => ({
  requireStaff: (_req: unknown, _reply: unknown, done: () => void) => done(),
}));

const { authRoutes } = await import("../auth.js");
type Deps = import("../auth.js").AuthRouteDeps;

const CUSTOMER_ROW = {
  id: CUSTOMER_ID,
  phone: "+5511999990001",
  name: "Seam Injected",
  email: "seam@example.com",
  medusaId: "cus_seam",
};

function buildDeps(): {
  deps: Deps;
  customerFactory: ReturnType<typeof vi.fn>;
  staffFactory: ReturnType<typeof vi.fn>;
  customerGetById: ReturnType<typeof vi.fn>;
  staffGetById: ReturnType<typeof vi.fn>;
} {
  const customerGetById = vi.fn().mockResolvedValue(CUSTOMER_ROW);
  const staffGetById = vi.fn().mockResolvedValue({ name: "Seam Staff" });
  const customerFactory = vi.fn(
    () => ({ getById: customerGetById }) as unknown as CustomerService,
  );
  const staffFactory = vi.fn(() => ({ getById: staffGetById }) as unknown as StaffService);
  return {
    customerFactory,
    staffFactory,
    customerGetById,
    staffGetById,
    deps: {
      customerService: customerFactory as unknown as () => CustomerService,
      staffService: staffFactory as unknown as () => StaffService,
    },
  };
}

async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authRoutes, { deps });
  await app.ready();
  return app;
}

describe("auth.ts — R5-S5 registration-level deps seam", () => {
  it("serves the INJECTED CustomerService on GET /api/auth/me", async () => {
    const { deps, customerFactory, customerGetById } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(CUSTOMER_ROW);
      expect(customerFactory).toHaveBeenCalled();
      expect(customerGetById).toHaveBeenCalledWith(CUSTOMER_ID);
    } finally {
      await server.close();
    }
  });

  it("serves the INJECTED StaffService on GET /api/auth/staff/me", async () => {
    const { deps, staffFactory, staffGetById } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({ method: "GET", url: "/api/auth/staff/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        staffId: STAFF_ID,
        role: "MANAGER",
        name: "Seam Staff",
      });
      expect(staffFactory).toHaveBeenCalled();
      expect(staffGetById).toHaveBeenCalledWith(STAFF_ID);
    } finally {
      await server.close();
    }
  });

  it("calls the injected factory PER REQUEST — never hoisted, never memoized", async () => {
    const { deps, customerFactory } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(customerFactory).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i += 1) {
        const res = await server.inject({ method: "GET", url: "/api/auth/me" });
        expect(res.statusCode).toBe(200);
      }

      expect(customerFactory).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });
});
