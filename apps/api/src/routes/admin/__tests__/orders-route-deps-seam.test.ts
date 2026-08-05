// admin/orders.ts — R5-S5 composition-root seam proof.
//
// Same construction as the admin/payments.ts and admin/order-actions.ts seam
// proofs. This file defers ONE service to onReady rather than two:
// `orderCommandService` closes over `getAuditSink()` (plus BKL-074's
// staffRoleGuard), so it must stay unconstructed until the hook fires, while
// the three read services keep their registration-time construction.
//
// No `@ibatexas/domain` interception: if `resolveAdminOrderRouteDeps` stops
// honouring `options.deps`, every count below reads 0.

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  FiscalDocumentService,
  OrderCommandService,
  OrderQueryService,
  PaymentQueryService,
} from "@ibatexas/domain";
import { orderRoutes, type AdminOrderRouteDeps } from "../orders.js";

function buildDeps(): {
  deps: AdminOrderRouteDeps;
  factories: Record<keyof AdminOrderRouteDeps, ReturnType<typeof vi.fn>>;
} {
  const factories = {
    orderCommandService: vi.fn(() => ({}) as unknown as OrderCommandService),
    orderQueryService: vi.fn(() => ({}) as unknown as OrderQueryService),
    paymentQueryService: vi.fn(() => ({}) as unknown as PaymentQueryService),
    fiscalDocumentService: vi.fn(() => ({}) as unknown as FiscalDocumentService),
    // R5 family 5 — a rejecting TRIPWIRE, not a client. The Redis resolver is
    // per-REQUEST; registration must never call it, and this file drives no
    // request. Anything that resolves it here fails loudly instead of
    // silently succeeding against a stub.
    redis: vi.fn(() =>
      Promise.reject(new Error("deps.redis resolved at REGISTRATION time")),
    ),
  };
  return { factories, deps: factories as unknown as AdminOrderRouteDeps };
}

describe("admin/orders.ts — R5-S5 registration-level deps seam", () => {
  it("resolves the injected set, deferring ONLY the audit-wired command service to onReady", async () => {
    const { deps, factories } = buildDeps();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    try {
      await app.register(orderRoutes, { deps });

      // ── after the plugin body, before onReady ──────────────────────────
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.fiscalDocumentService).toHaveBeenCalledTimes(1);
      // The one that closes over getAuditSink() must NOT have been called yet.
      expect(factories.orderCommandService).not.toHaveBeenCalled();

      // ── onReady fires here ─────────────────────────────────────────────
      await app.ready();

      expect(factories.orderCommandService).toHaveBeenCalledTimes(1);
      expect(factories.orderQueryService).toHaveBeenCalledTimes(1);
      expect(factories.paymentQueryService).toHaveBeenCalledTimes(1);
      expect(factories.fiscalDocumentService).toHaveBeenCalledTimes(1);
      // The Redis resolver is per-REQUEST, so neither the plugin body nor
      // onReady may call it. (Had it been called, the tripwire's rejection
      // would have surfaced as an unhandled rejection rather than a count.)
      expect(factories.redis).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
