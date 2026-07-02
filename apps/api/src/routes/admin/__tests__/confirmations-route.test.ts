// B2 (OPS-071): GET /api/admin/confirmations — the pending two-person queue.
//
// The route surfaces step-1 receipts awaiting a SECOND operator. Coverage:
//   - manager-gated (requireManagerRole) fail-closed: ATTENDANT and an
//     authentic-but-unmapped x-admin-key are refused, mirroring escalations;
//   - a MANAGER (JWT or registry-mapped api-key) reads the queue;
//   - the response shape carries confirmationId / kind / route / orderId /
//     params / requestedBy / createdAt / expiresAt (createdAt + TTL) and
//     NEVER the receipt nonce.
//
// Harness mirrors escalations-authz.test.ts: an instance-level preHandler
// injects the staff identity the parent admin DOM-001 guard would attach;
// the store is mocked (the Redis-backed listPending semantics are pinned in
// force-routes-governance.test.ts against real Redis).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockListPending = vi.hoisted(() => vi.fn());

vi.mock("../admin-confirmation-store.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../admin-confirmation-store.js")
  >();
  return {
    ...actual, // keep ADMIN_CONFIRMATION_TTL_SECONDS + the types real
    createAdminConfirmationStore: () => ({
      listPending: mockListPending,
    }),
  };
});

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
  readonly adminApiKeyRole?: "OWNER" | "MANAGER";
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };
const API_KEY_NO_ROLE: StaffContext = { staffId: null, staffRole: null };
const API_KEY_MANAGER: StaffContext = {
  staffId: null,
  staffRole: null,
  adminApiKeyRole: "MANAGER",
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminConfirmationRoutes } = await import("../confirmations.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Mimic what the parent admin DOM-001 guard attaches. Instance-level
  // preHandlers run BEFORE route-level ones, so requireManagerRole sees this.
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    } else if (staff.adminApiKeyRole) {
      (req as unknown as { adminApiKeyRole: "OWNER" | "MANAGER" }).adminApiKeyRole =
        staff.adminApiKeyRole;
    }
  });
  await app.register(adminConfirmationRoutes);
  await app.ready();
  return app;
}

const PENDING_FIXTURE = {
  confirmationId: "11111111-2222-4333-8444-555555555555",
  pending: {
    kind: "payment.status.transition" as const,
    payload: { paymentId: "pay_01", orderId: "order_01", newStatus: "refunded" },
    nonce: "secret-nonce-must-not-leak",
    staffId: "staff_mgr_02",
    staffRole: "MANAGER",
    actorPrincipal: "user" as const,
    requestorIp: "127.0.0.1",
    prompt: "Confirmar reembolso de R$ 199,99?",
    route: "refund" as const,
    createdAt: "2026-07-02T12:00:00.000Z",
    orderId: "order_01",
    refundAmountCentavos: 19_999,
    reason: "produto danificado",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/admin/confirmations — manager gate (fail-closed)", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(403);
      expect(mockListPending).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects an authentic x-admin-key WITHOUT a registry role (fail-closed)", async () => {
    const server = await buildServer(API_KEY_NO_ROLE);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { message: string }).message).toContain(
        "chave de API sem permissão",
      );
      expect(mockListPending).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("lets a registry-mapped MANAGER api-key read the queue (200)", async () => {
    mockListPending.mockResolvedValue([]);
    const server = await buildServer(API_KEY_MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ confirmations: [] });
      expect(mockListPending).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/confirmations — response shape", () => {
  it("returns confirmationId/kind/route/orderId/params/requestedBy/createdAt/expiresAt", async () => {
    mockListPending.mockResolvedValue([PENDING_FIXTURE]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { confirmations: Array<Record<string, unknown>> };
      expect(body.confirmations).toHaveLength(1);
      const item = body.confirmations[0]!;
      expect(item.confirmationId).toBe(PENDING_FIXTURE.confirmationId);
      expect(item.kind).toBe("payment.status.transition");
      expect(item.route).toBe("refund");
      expect(item.orderId).toBe("order_01");
      expect(item.params).toEqual({
        paymentId: "pay_01",
        orderId: "order_01",
        newStatus: "refunded",
      });
      expect(item.requestedBy).toBe("staff_mgr_02");
      expect(item.prompt).toContain("Confirmar reembolso");
      expect(item.createdAt).toBe("2026-07-02T12:00:00.000Z");
      // expiresAt = createdAt + the 600s receipt TTL.
      expect(item.expiresAt).toBe("2026-07-02T12:10:00.000Z");
      expect(item.refundAmountCentavos).toBe(19_999);
      expect(item.reason).toBe("produto danificado");
    } finally {
      await server.close();
    }
  });

  it("never leaks the receipt nonce", async () => {
    mockListPending.mockResolvedValue([PENDING_FIXTURE]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("secret-nonce-must-not-leak");
      const item = (res.json() as { confirmations: Array<Record<string, unknown>> })
        .confirmations[0]!;
      expect(item).not.toHaveProperty("nonce");
    } finally {
      await server.close();
    }
  });

  it("null-staff receipts surface requestedBy: null; unparseable createdAt → expiresAt null", async () => {
    mockListPending.mockResolvedValue([
      {
        confirmationId: "22222222-3333-4444-8555-666666666666",
        pending: {
          ...PENDING_FIXTURE.pending,
          staffId: null,
          createdAt: "not-a-date",
        },
      },
    ]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/confirmations",
      });
      expect(res.statusCode).toBe(200);
      const item = (res.json() as { confirmations: Array<Record<string, unknown>> })
        .confirmations[0]!;
      expect(item.requestedBy).toBeNull();
      expect(item.expiresAt).toBeNull();
    } finally {
      await server.close();
    }
  });
});
