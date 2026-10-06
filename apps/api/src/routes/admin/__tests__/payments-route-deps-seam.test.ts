// admin/payments.ts — R5-S5 composition-root seam proof.
//
// Injects through the registration seam with NO `@ibatexas/domain`
// interception: if `resolveAdminPaymentRouteDeps` stops honouring
// `options.deps`, none of the injected factories is ever called and every
// count below reads 0.
//
// The assertions deliberately straddle the register→ready boundary, because
// for this file the seam and the T8 boot-order invariant are the same fact.
// `paymentCommandService` / `orderCommandService` close over `getAuditSink()`,
// which THROWS before `bootstrapAuditSinkDI()` has run. R5-S5 keeps them safe
// by making the dep members lazy factories: resolving the set in the plugin
// body constructs nothing, and the onReady hook is still what calls them.
//
// So a regression that "simplified" the members from factories to constructed
// instances would move those `getAuditSink()` calls into plugin-body execution
// and crash production boot — and it fails the middle assertion here, at the
// exact moment it becomes wrong, rather than in a boot log.

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
import { adminPaymentRoutes, type AdminPaymentRouteDeps } from "../payments.js";

function buildDeps(): {
  deps: AdminPaymentRouteDeps;
  factories: Record<keyof AdminPaymentRouteDeps, ReturnType<typeof vi.fn>>;
} {
  const factories = {
    paymentCommandService: vi.fn(() => ({}) as unknown as PaymentCommandService),
    orderCommandService: vi.fn(() => ({}) as unknown as OrderCommandService),
    paymentQueryService: vi.fn(() => ({}) as unknown as PaymentQueryService),
    orderQueryService: vi.fn(() => ({}) as unknown as OrderQueryService),
    orderEventLogService: vi.fn(() => ({}) as unknown as OrderEventLogService),
  };
  return { factories, deps: factories as unknown as AdminPaymentRouteDeps };
}

describe("admin/payments.ts — R5-S5 registration-level deps seam", () => {
  it("resolves the injected set, deferring ONLY the audit-wired command services to onReady", async () => {
    const { deps, factories } = buildDeps();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    try {
      await app.register(adminPaymentRoutes, { deps });

      // ── after the plugin body, before onReady ──────────────────────────
      // The three read services keep their registration-time construction.
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderEventLogService).toHaveBeenCalledTimes(1);
      // The two that close over getAuditSink() must NOT have been called yet.
      expect(factories.paymentCommandService).not.toHaveBeenCalled();
      expect(factories.orderCommandService).not.toHaveBeenCalled();

      // ── onReady fires here ─────────────────────────────────────────────
      await app.ready();

      expect(factories.paymentCommandService).toHaveBeenCalledTimes(1);
      expect(factories.orderCommandService).toHaveBeenCalledTimes(1);
      // The read services were not re-constructed by the hook.
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.orderEventLogService).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
