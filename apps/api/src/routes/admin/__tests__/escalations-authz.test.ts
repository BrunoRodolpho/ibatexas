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

afterEach(() => {
  vi.resetModules();
});
