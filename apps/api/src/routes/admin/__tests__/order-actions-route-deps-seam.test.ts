// admin/order-actions.ts — R5-S5 composition-root seam proof.
//
// Same construction as the admin/payments.ts seam proof, for the same reason:
// for this file the seam and the T8 boot-order invariant are one fact.
// `orderCommandService` / `paymentCommandService` close over `getAuditSink()`,
// which throws before `bootstrapAuditSinkDI()` has run, so they must stay
// unconstructed until the onReady hook. Keeping the dep members lazy factories
// is what preserves that; a regression to constructed instances moves the sink
// resolution into plugin-body execution and crashes production boot.
//
// No `@ibatexas/domain` interception: if `resolveAdminOrderActionRouteDeps`
// stops honouring `options.deps`, every count below reads 0.

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  OrderCommandService,
  OrderEventLogService,
  OrderQueryService,
  PaymentCommandService,
  PaymentQueryService,
} from "@ibatexas/domain";
import {
  adminOrderActionRoutes,
  type AdminOrderActionRouteDeps,
} from "../order-actions.js";

function buildDeps(): {
  deps: AdminOrderActionRouteDeps;
  factories: Record<keyof AdminOrderActionRouteDeps, ReturnType<typeof vi.fn>>;
} {
  const factories = {
    orderCommandService: vi.fn(() => ({}) as unknown as OrderCommandService),
    paymentCommandService: vi.fn(() => ({}) as unknown as PaymentCommandService),
    orderQueryService: vi.fn(() => ({}) as unknown as OrderQueryService),
    paymentQueryService: vi.fn(() => ({}) as unknown as PaymentQueryService),
    orderEventLogService: vi.fn(() => ({}) as unknown as OrderEventLogService),
  };
  return { factories, deps: factories as unknown as AdminOrderActionRouteDeps };
}

describe("admin/order-actions.ts — R5-S5 registration-level deps seam", () => {
  it("resolves the injected set, deferring ONLY the audit-wired command services to onReady", async () => {
    const { deps, factories } = buildDeps();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    try {
      await app.register(adminOrderActionRoutes, { deps });

      // ── after the plugin body, before onReady ──────────────────────────
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderEventLogService).toHaveBeenCalledTimes(1);
      // The two that close over getAuditSink() must NOT have been called yet.
      expect(factories.orderCommandService).not.toHaveBeenCalled();
      expect(factories.paymentCommandService).not.toHaveBeenCalled();

      // ── onReady fires here ─────────────────────────────────────────────
      await app.ready();

      expect(factories.orderCommandService).toHaveBeenCalledTimes(1);
      expect(factories.paymentCommandService).toHaveBeenCalledTimes(1);
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderEventLogService).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
