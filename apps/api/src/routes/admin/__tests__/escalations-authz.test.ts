// F2 regression: D2 take-over reply/resolve (and the queue read) MUST be
// manager-gated. Before the fix these routes carried only the parent
// adminRoutes DOM-001 guard, so any authenticated ATTENDANT — or any authentic
// x-admin-key with no registry role — could POST /reply to message a customer
// over WhatsApp as the business and POST /resolve to un-pause the bot. This
// suite locks in `requireManagerRole` fail-closed, mirroring D3 broadcast.
//
// Harness mirrors force-routes-governance.test.ts: an instance-level preHandler
// injects the staff identity (staffId/staffRole, or a registry-mapped
// adminApiKeyRole) the parent admin guard would normally attach, then the
// route-level `requireManagerRole` preHandler runs and must fail closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockFindBySessionId = vi.hoisted(() => vi.fn());
const mockSearchConversations = vi.hoisted(() => vi.fn());
const mockAppendMessage = vi.hoisted(() => vi.fn());
const mockListOpen = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
// AUT-017 — the escalation-approval gateway (getEscalationApprovalGateway) is
// mocked so the resolve-route authz matrix drives its outcome directly.
const mockGatewayResolve = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createConversationService: () => ({
    findBySessionId: mockFindBySessionId,
    searchConversations: mockSearchConversations,
    appendMessage: mockAppendMessage,
  }),
  prisma: { customer: { findUnique: vi.fn(async () => null) } },
}));

vi.mock("@ibatexas/tools", () => ({
  getWhatsAppSender: () => null,
}));

vi.mock("../../../escalation/escalation-store.js", () => ({
  getEscalationStore: vi.fn(async () => ({
    listOpen: mockListOpen,
    resolve: mockResolve,
  })),
}));

vi.mock("../../../claustrum-bootstrap.js", () => ({
  getEscalationApprovalGateway: () => ({ resolve: mockGatewayResolve }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
  readonly adminApiKeyRole?: "OWNER" | "MANAGER";
}

const OWNER: StaffContext = { staffId: "staff_owner_01", staffRole: "OWNER" };
const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };
const API_KEY_NO_ROLE: StaffContext = { staffId: null, staffRole: null };
const API_KEY_MANAGER: StaffContext = {
  staffId: null,
  staffRole: null,
  adminApiKeyRole: "MANAGER",
};
const API_KEY_OWNER: StaffContext = {
  staffId: null,
  staffRole: null,
  adminApiKeyRole: "OWNER",
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { escalationRoutes } = await import("../escalations.js");
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
  await app.register(escalationRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("F2: POST /api/admin/escalations/:sessionId/reply is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never runs the handler", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/escalations/sess_1/reply",
        payload: { text: "ola" },
      });
      expect(res.statusCode).toBe(403);
      // Guard fired before the handler: no transcript write, no lookup.
      expect(mockAppendMessage).not.toHaveBeenCalled();
      expect(mockFindBySessionId).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects an authentic x-admin-key WITHOUT a registry role (fail-closed)", async () => {
    const server = await buildServer(API_KEY_NO_ROLE);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/escalations/sess_1/reply",
        payload: { text: "ola" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { message: string }).message).toContain(
        "chave de API sem permissão",
      );
      expect(mockAppendMessage).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("lets a MANAGER past the guard (reaches handler → 404 for unknown session)", async () => {
    mockFindBySessionId.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/escalations/sess_unknown/reply",
        payload: { text: "ola" },
      });
      // Past the guard: the handler ran and 404'd on the missing conversation.
      expect(res.statusCode).toBe(404);
      expect(mockFindBySessionId).toHaveBeenCalledWith("sess_unknown");
    } finally {
      await server.close();
    }
  });
});

describe("F2: POST /api/admin/escalations/:sessionId/resolve is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never touches the store", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/escalations/sess_1/resolve",
      });
      expect(res.statusCode).toBe(403);
      expect(mockResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("lets a registry-mapped MANAGER api-key past the guard (200)", async () => {
    mockResolve.mockResolvedValue(null);
    const server = await buildServer(API_KEY_MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/escalations/sess_1/resolve",
      });
      expect(res.statusCode).toBe(200);
      expect(mockResolve).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

describe("F2: GET /api/admin/escalations queue is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/escalations",
      });
      expect(res.statusCode).toBe(403);
      expect(mockListOpen).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("lets a MANAGER read the queue (200)", async () => {
    mockListOpen.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/escalations",
      });
      expect(res.statusCode).toBe(200);
      expect(mockListOpen).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

// AUT-017 — the OWNER-gated approve/reject route + its outcome mapping.
describe("AUT-017: POST /api/admin/escalations/:sessionId/intents/:token/resolve is OWNER-gated", () => {
  const url = "/api/admin/escalations/sess_1/intents/tok_1/resolve";

  it("lets an OWNER through → 200 approved (gateway EXECUTE)", async () => {
    mockGatewayResolve.mockResolvedValue({
      status: "approved",
      decision: { kind: "EXECUTE" },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        status: "approved",
        decision: { kind: "EXECUTE" },
      });
      expect(mockGatewayResolve).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("lets a registry-mapped OWNER api-key through → 200", async () => {
    mockGatewayResolve.mockResolvedValue({ status: "rejected" });
    const server = await buildServer(API_KEY_OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, status: "rejected" });
    } finally {
      await server.close();
    }
  });

  it("rejects a MANAGER with 403 and NEVER calls the gateway", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(403);
      expect(mockGatewayResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects an ATTENDANT with 403 and NEVER calls the gateway", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(403);
      expect(mockGatewayResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a registry-mapped MANAGER api-key with 403 (OWNER required, not MANAGER)", async () => {
    const server = await buildServer(API_KEY_MANAGER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(403);
      expect(mockGatewayResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a bare/unmapped x-admin-key with 403 (fail-closed)", async () => {
    const server = await buildServer(API_KEY_NO_ROLE);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(403);
      expect(mockGatewayResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("maps a self-approval outcome to 409", async () => {
    mockGatewayResolve.mockResolvedValue({ status: "self_approve" });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain("autor da solicitação");
    } finally {
      await server.close();
    }
  });

  it("maps a replayed/expired token (missing) to 404", async () => {
    mockGatewayResolve.mockResolvedValue({ status: "missing" });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toContain("expirada ou já utilizada");
    } finally {
      await server.close();
    }
  });

  it("maps an executor failure after audited EXECUTE to 502 (honest, no fabricated success)", async () => {
    mockGatewayResolve.mockResolvedValue({
      status: "execute_failed",
      decision: { kind: "EXECUTE" },
      refusalPtBr: "A aprovação foi autorizada, mas a execução falhou. Tente novamente.",
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ ok: false, status: "execute_failed" });
    } finally {
      await server.close();
    }
  });

  it("maps a since-parked terminal/partial state (denied_by_kernel) to 200 with refusalPtBr", async () => {
    mockGatewayResolve.mockResolvedValue({
      status: "denied_by_kernel",
      decision: { kind: "REFUSE" },
      refusalPtBr: "Não foi possível concluir esta ação.",
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "POST", url, payload: { accept: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        status: "denied_by_kernel",
        decision: { kind: "REFUSE" },
      });
    } finally {
      await server.close();
    }
  });
});

afterEach(() => {
  vi.resetModules();
});
