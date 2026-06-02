// Regression tests for the 2026-05-27 P2 audit fixes on admin/payments.ts:
//
//   P2-CONC-CONFIRMVER — confirm-cash transition must pin expectedVersion
//                        (read the payment first, pass payment.version).
//   P2-AUTH-REFUNDATTR — refund reached via the bare ADMIN_API_KEY path (no
//                        staff JWT ⇒ request.staffId undefined) must still
//                        record a NON-BLANK actor on the money action.
//
// All heavy deps are mocked so the route collects without the @ibatexas/domain
// chain (mirrors admin-payments-refund.test.ts conventions).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Conductor is unconditional post-cutover; a permissive EXECUTE conductor lets the
// gateway run the route's domain mutation (behaviour-preserving for these tests).
vi.mock("../claustrum-bootstrap.js", () => {
  const conductor = { adjudicator: { adjudicate: async () => ({ kind: "EXECUTE", basis: [] }) } };
  return {
    getConductor: () => conductor,
    tryGetConductor: () => conductor,
    policyForKind: () => ({
      stateGuards: [], authGuards: [], business: [],
      taint: { minimumFor: () => "UNTRUSTED" }, default: "EXECUTE",
    }),
  };
});
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { PaymentStatus } from "@ibatexas/types";
import { adminPaymentRoutes } from "../routes/admin/payments.js";

const mockTransitionStatus = vi.hoisted(() => vi.fn());
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockOrderGetById = vi.hoisted(() => vi.fn());
const mockPaymentUpdate = vi.hoisted(() => vi.fn());
// When false, requireManagerRole does NOT set staffId — i.e. the bare
// ADMIN_API_KEY path (requireManagerRole passes it through). Defaults to a
// staff JWT being present.
const managerHasJwt = vi.hoisted(() => ({ value: true }));

vi.mock("@ibatexas/domain", () => ({
  createPaymentCommandService: () => ({ transitionStatus: mockTransitionStatus }),
  createPaymentQueryService: () => ({ getActiveByOrderId: mockGetActiveByOrderId, getById: mockGetById }),
  createOrderQueryService: () => ({ getById: mockOrderGetById }),
  prisma: { payment: { update: mockPaymentUpdate } },
}));

vi.mock("@ibatexas/tools", () => ({
  // Pass-through lock so the refund's atomic re-read/write sequence runs inline.
  withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/staff-auth.js", () => ({
  // confirm-cash uses requireStaff → a staff JWT is always present here.
  requireStaff: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string }).staffId = "staff_1";
    done();
  },
  // refund uses requireManagerRole, which passes the API-key path through
  // WITHOUT a staffId. Toggle via managerHasJwt to exercise both branches.
  requireManagerRole: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    if (managerHasJwt.value) {
      (req as FastifyRequest & { staffId?: string }).staffId = "staff_mgr";
    }
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(adminPaymentRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  managerHasJwt.value = true;
  mockOrderGetById.mockResolvedValue({ id: "order_1" });
  mockTransitionStatus.mockResolvedValue({ version: 3, previousStatus: "x", newStatus: "y" });
  mockPaymentUpdate.mockResolvedValue({});
});

// ── P2-CONC-CONFIRMVER ──────────────────────────────────────────────────────
describe("P2-CONC-CONFIRMVER — confirm-cash pins expectedVersion", () => {
  function confirmCash(app: Awaited<ReturnType<typeof buildServer>>) {
    return app.inject({ method: "POST", url: "/api/admin/orders/order_1/payment/confirm-cash", payload: {} });
  }

  it("passes expectedVersion = payment.version to the transition", async () => {
    mockGetActiveByOrderId.mockResolvedValue({
      id: "pay_1", method: "cash", status: PaymentStatus.CASH_PENDING, version: 7,
    });

    const app = await buildServer();
    const res = await confirmCash(app);

    expect(res.statusCode).toBe(200);
    expect(mockTransitionStatus).toHaveBeenCalledWith(
      "pay_1",
      expect.objectContaining({
        newStatus: PaymentStatus.PAID,
        expectedVersion: 7,
      }),
    );
  });
});

// ── P2-AUTH-REFUNDATTR ──────────────────────────────────────────────────────
describe("P2-AUTH-REFUNDATTR — refund never records a blank actor", () => {
  function refund(app: Awaited<ReturnType<typeof buildServer>>, body: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/api/admin/orders/order_1/payment/refund", payload: body });
  }

  function paidPayment() {
    const p = {
      id: "pay_1", status: PaymentStatus.PAID, amountInCentavos: 8900, refundedAmountCentavos: 0, method: "pix",
    };
    mockGetActiveByOrderId.mockResolvedValue(p);
    mockGetById.mockResolvedValue(p);
  }

  it("API-key path (no staff JWT) stamps a synthetic, non-blank actorId", async () => {
    managerHasJwt.value = false; // bare ADMIN_API_KEY → request.staffId undefined
    paidPayment();

    const app = await buildServer();
    const res = await refund(app);

    expect(res.statusCode).toBe(200);
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
    const [, input] = mockTransitionStatus.mock.calls[0] as [string, { actor: string; actorId?: string }];
    // The money action's audit attribution must be present and non-blank.
    expect(input.actor).toBe("admin");
    expect(input.actorId).toBeTruthy();
    expect(input.actorId).not.toBe("");
    expect(input.actorId).toBe("api-key:admin");
  });

  it("staff JWT path attributes the refund to the staff member", async () => {
    managerHasJwt.value = true; // staff JWT present → request.staffId set
    paidPayment();

    const app = await buildServer();
    const res = await refund(app);

    expect(res.statusCode).toBe(200);
    const [, input] = mockTransitionStatus.mock.calls[0] as [string, { actorId?: string }];
    expect(input.actorId).toBe("staff_mgr");
  });
});
