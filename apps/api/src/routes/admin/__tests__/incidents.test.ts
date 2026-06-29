// W1 Phase 3a: the full admin incidents REST inbox is manager-gated and shapes
// its responses for the (future) Incidentes view. This suite locks:
//   - requireManagerRole fail-closed (403) on the list (exposes customerId +
//     transcript), so non-managers never read it;
//   - GET list returns { incidents, openCount } with the INDEPENDENT openCount
//     (never rows.length) and the server-side default sort;
//   - resolve 404-only-on-missing vs 200-with-discriminable-conflict on an
//     already-terminal row (the second-click / auto-close-race case);
//   - reply phone resolution falls back to the incident senderRef when
//     customerId is null (guest / not-yet-archived).
//
// Harness mirrors escalations-authz.test.ts: an instance-level preHandler
// injects the staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
// EGRESS BRAND (E-1): the staff reply is minted into a branded RenderedReply
// before it reaches sendText; assert against the minted reply.
import { mintRenderedReply } from "@adjudicate/core";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
const mockFindBySessionId = vi.hoisted(() => vi.fn());
const mockGetTranscript = vi.hoisted(() => vi.fn());
const mockAppendMessage = vi.hoisted(() => vi.fn());
const mockCustomerFindUnique = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockCloseAuto = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createIncidentService: () => ({
    list: mockList,
    get: mockGet,
    closeIncidentFromEnvelope: mockClose,
  }),
  createConversationService: () => ({
    findBySessionId: mockFindBySessionId,
    getTranscript: mockGetTranscript,
    appendMessage: mockAppendMessage,
  }),
  prisma: { customer: { findUnique: mockCustomerFindUnique } },
}));

vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => undefined }));

vi.mock("@ibatexas/tools", () => ({
  getWhatsAppSender: () => ({ sendText: mockSendText }),
}));

vi.mock("../../../subscribers/__shared__/system-actor-envelope.js", () => ({
  buildSystemEnvelope: (args: unknown) => args,
}));

vi.mock("../../../incidents/incident-auto-close.js", () => ({
  closeIncidentOnDeliveredReply: mockCloseAuto,
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminIncidentRoutes } = await import("../incidents.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminIncidentRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/admin/incidents is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/incidents" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { incidents, openCount } with the INDEPENDENT count + default sort", async () => {
    const base = Date.now();
    // rows.length (3) deliberately != openCount (7) to prove independence.
    mockList.mockResolvedValue({
      rows: [
        { id: "C", status: "RESOLVED", openedAt: new Date(base - 5000), severity: "high" },
        { id: "B", status: "OPEN", openedAt: new Date(base - 10), severity: "high" },
        { id: "A", status: "OPEN", openedAt: new Date(base - 5000), severity: "low" },
      ],
      openCount: 7,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/incidents" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { incidents: Array<{ id: string }>; openCount: number };
      expect(body.openCount).toBe(7);
      // Active (OPEN) bucket first, aged-first within it, terminal last.
      expect(body.incidents.map((i) => i.id)).toEqual(["A", "B", "C"]);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/incidents/:id/resolve", () => {
  it("404s ONLY when the incident id does not exist", async () => {
    mockClose.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: null });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_missing/resolve",
      });
      expect(res.statusCode).toBe(404);
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("200 + conflict=auto_resolved when the bot already self-healed it (race)", async () => {
    mockClose.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "inc_1", status: "AUTO_RESOLVED", resolutionType: "AUTO", resolvedBy: "system" },
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_1/resolve",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { conflict: string | null };
      expect(body.conflict).toBe("auto_resolved");
    } finally {
      await server.close();
    }
  });

  it("200 + conflict=null when this manager wins the STAFF transition", async () => {
    mockClose.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: {
        id: "inc_1",
        status: "RESOLVED",
        resolutionType: "STAFF",
        resolvedBy: "staff:staff_mgr_01",
      },
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_1/resolve",
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { conflict: string | null }).conflict).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/incidents/:id/reply phone resolution", () => {
  it("falls back to the incident senderRef when customerId is null (guest)", async () => {
    mockGet.mockResolvedValue({
      id: "inc_1",
      sessionId: "sess_1",
      conversationId: null,
      customerId: null,
      channel: "whatsapp",
      senderRef: "whatsapp:+5511988887777",
    });
    mockFindBySessionId.mockResolvedValue(null); // not yet archived → no transcript append
    mockSendText.mockResolvedValue(undefined);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_1/reply",
        payload: { text: "ola, desculpe a demora" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; delivered: boolean; channel: string };
      expect(body).toMatchObject({ ok: true, delivered: true, channel: "whatsapp" });
      // customerId null → never hit the customer table; delivered to senderRef.
      expect(mockCustomerFindUnique).not.toHaveBeenCalled();
      expect(mockSendText).toHaveBeenCalledWith(
        "whatsapp:+5511988887777",
        mintRenderedReply("ola, desculpe a demora"),
      );
      // A delivered staff reply closes the incident (P1-3).
      expect(mockCloseAuto).toHaveBeenCalledTimes(1);
      expect(mockCloseAuto.mock.calls[0]?.[0]).toBe("sess_1");
    } finally {
      await server.close();
    }
  });

  it("resolves customerId → customer.phone when present (prefixing whatsapp:)", async () => {
    mockGet.mockResolvedValue({
      id: "inc_2",
      sessionId: "sess_2",
      conversationId: "conv_2",
      customerId: "cust_2",
      channel: "whatsapp",
      senderRef: null,
    });
    mockCustomerFindUnique.mockResolvedValue({ phone: "+5511977776666" });
    mockAppendMessage.mockResolvedValue({ id: "msg_1" });
    mockSendText.mockResolvedValue(undefined);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_2/reply",
        payload: { text: "oi" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCustomerFindUnique).toHaveBeenCalledWith({
        where: { id: "cust_2" },
        select: { phone: true },
      });
      expect(mockSendText).toHaveBeenCalledWith("whatsapp:+5511977776666", mintRenderedReply("oi"));
      // Transcript append tagged via:staff_takeover (+incidentId).
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage.mock.calls[0]?.[0]?.metadata).toMatchObject({
        via: "staff_takeover",
        incidentId: "inc_2",
      });
    } finally {
      await server.close();
    }
  });

  it("404s when the incident id does not exist", async () => {
    mockGet.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/nope/reply",
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockSendText).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects ATTENDANT with 403 and never delivers", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/incidents/inc_1/reply",
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockSendText).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
