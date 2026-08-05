// order-actions.ts — R5-S5 composition-root seam proof.
//
// Injects through the registration seam with NO `@ibatexas/domain`
// interception. If `resolveOrderActionRouteDeps` stops honouring
// `options.deps`, the four plugin-scope factories below are never called (the
// plugin builds production services instead) and the ownership read falls
// through to the REAL `prisma` singleton.
//
// This file has the rollout's only MIXED shape, and both halves are pinned:
//
//   • four members replaced PLUGIN-BODY constructions → registration-time,
//     called exactly once, never again per request;
//   • `noteOrderCommandService` replaced a PER-REQUEST construction → it must
//     stay unconstructed at registration, because it closes over
//     `getAuditSink()` and resolving that early is the boot-order hazard the
//     T8 gate exists for.
//
// The cheapest handler reaching an injected service is the notes list: its
// ownership check consults `orderQuerySvc.getById`, and a foreign customerId
// 404s before the raw `prisma.orderNote` read (a documented residual) is
// touched.

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  OrderCommandService,
  OrderQueryService,
  PaymentCommandService,
  PaymentQueryService,
} from "@ibatexas/domain";

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

const { orderActionRoutes } = await import("../order-actions.js");
type Deps = import("../order-actions.js").OrderActionRouteDeps;

function buildDeps(): {
  deps: Deps;
  factories: Record<keyof Deps, ReturnType<typeof vi.fn>>;
  getById: ReturnType<typeof vi.fn>;
} {
  // The ownership read resolves to an order owned by SOMEONE ELSE, so the
  // handler 404s on the injected answer — no happy path to stage.
  const getById = vi.fn().mockResolvedValue({ customerId: "cust_someone_else" });

  // R5 family 4: `redis` is a TRIPWIRE here, not a double. None of the routes
  // this file drives (the notes read and the registration-time construction
  // count) touches Redis, so resolving the client at all is itself a defect —
  // in particular it would mean the resolver had been hoisted out of the
  // per-request handlers into the plugin body.
  const factories = {
    orderCommandService: vi.fn(() => ({}) as unknown as OrderCommandService),
    orderQueryService: vi.fn(() => ({ getById }) as unknown as OrderQueryService),
    paymentCommandService: vi.fn(() => ({}) as unknown as PaymentCommandService),
    paymentQueryService: vi.fn(() => ({}) as unknown as PaymentQueryService),
    noteOrderCommandService: vi.fn(() => ({}) as unknown as OrderCommandService),
    redis: vi.fn(() =>
      Promise.reject(new Error("order-actions deps seam: redis must not resolve here")),
    ),
  };

  return {
    getById,
    factories,
    deps: factories as unknown as Deps,
  };
}

async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(orderActionRoutes, { deps });
  await app.ready();
  return app;
}

describe("order-actions.ts — R5-S5 registration-level deps seam", () => {
  it("constructs the four plugin-scope services at REGISTRATION, once each", async () => {
    const { deps, factories } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(factories.orderCommandService).toHaveBeenCalledTimes(1);
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.paymentCommandService).toHaveBeenCalledTimes(1);
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      // The Redis resolver is per-REQUEST, so registration must not call it.
      expect(factories.redis).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("leaves the PER-REQUEST note service unconstructed at registration", async () => {
    // It closes over getAuditSink(). Constructing it here would resolve the
    // sink during plugin-body execution — the exact boot-order hazard the T8
    // conformance gate guards on the admin files.
    const { deps, factories } = buildDeps();
    const server = await buildServer(deps);
    try {
      expect(factories.noteOrderCommandService).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("serves the INJECTED OrderQueryService on the ownership check", async () => {
    const { deps, factories, getById } = buildDeps();
    const server = await buildServer(deps);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/orders/order_seam_01/notes",
      });
      // The injected read said another customer owns it → 404, and the raw
      // prisma.orderNote read is never reached.
      expect(res.statusCode).toBe(404);
      expect(getById).toHaveBeenCalledWith("order_seam_01");
      // Still the single registration-time construction — the handler reuses it.
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
