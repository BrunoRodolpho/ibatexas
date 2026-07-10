// Route tests for admin/conversations.ts — the un-redacted, PII-bearing
// transcript surface (WS4B). These pin the ROUTE-level guarantees the domain
// service tests cannot reach:
//   1. WS4B — BOTH GET routes are MANAGER-gated (requireManagerRole): an
//      ATTENDANT JWT → 403 with no read; a MANAGER → 200.
//   2. The orderId→customer indirection: a known displayId resolves to that
//      customer's conversations; an unknown displayId → an empty page (count 0);
//      a non-numeric AND an above-INT4 displayId BOTH degrade to an empty page
//      and NEVER 500 (the range-guard fix).
//   3. listForAdmin pagination/count shape is threaded to the wire.
//
// Harness mirrors customers.test.ts / broadcast.test.ts: an instance-level
// preHandler injects the staff identity the parent admin guard would attach.
// requireManagerRole is the REAL middleware (we assert its gating).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockSearchConversations = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const mockListForAdmin = vi.hoisted(() =>
  vi.fn(async () => ({ rows: [] as unknown[], count: 0 })),
);
const mockFindBySessionId = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockGetTranscript = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const mockOrderFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("@ibatexas/domain", () => ({
  createConversationService: () => ({
    searchConversations: mockSearchConversations,
    listForAdmin: mockListForAdmin,
    findBySessionId: mockFindBySessionId,
    getTranscript: mockGetTranscript,
  }),
  prisma: {
    orderProjection: { findMany: mockOrderFindMany },
  },
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

const LAST_MSG_AT = new Date("2026-07-08T18:00:00.000Z");

const SUMMARY_ROW = {
  id: "conv_01",
  sessionId: "sess_01",
  customerId: "cust_01",
  channel: "whatsapp",
  messageCount: 4,
  lastMessageAt: LAST_MSG_AT,
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { conversationRoutes } = await import("../conversations.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(conversationRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

// ── WS4B — both reads are MANAGER-gated ────────────────────────────────────────

describe("conversation reads are manager-gated (WS4B)", () => {
  it("rejects an ATTENDANT on the list with 403 and never reads", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/conversations" });
      expect(res.statusCode).toBe(403);
      expect(mockListForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects an ATTENDANT on the transcript with 403 and never reads", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations/sess_01",
      });
      expect(res.statusCode).toBe(403);
      expect(mockFindBySessionId).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("allows a MANAGER on the list with 200", async () => {
    mockListForAdmin.mockResolvedValueOnce({ rows: [SUMMARY_ROW], count: 1 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/conversations" });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("allows a MANAGER on the transcript with 200", async () => {
    mockFindBySessionId.mockResolvedValueOnce({ id: "conv_01" });
    mockGetTranscript.mockResolvedValueOnce([
      {
        role: "customer",
        content: "Olá, quero fazer um pedido",
        sentAt: LAST_MSG_AT,
        metadata: null,
      },
    ]);
    mockSearchConversations.mockResolvedValueOnce([SUMMARY_ROW]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations/sess_01",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sessionId: string;
        customerId: string | null;
        channel: string | null;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.sessionId).toBe("sess_01");
      expect(body.customerId).toBe("cust_01");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe("Olá, quero fazer um pedido");
    } finally {
      await server.close();
    }
  });
});

// ── orderId → customer indirection ─────────────────────────────────────────────

describe("GET /api/admin/conversations (orderId → customer indirection)", () => {
  it("resolves a known orderId to that customer's conversations", async () => {
    mockOrderFindMany.mockResolvedValueOnce([{ customerId: "cust_01" }]);
    mockListForAdmin.mockResolvedValueOnce({ rows: [SUMMARY_ROW], count: 1 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations?orderId=4242",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { conversations: unknown[]; count: number };
      expect(body.count).toBe(1);
      // The displayId is resolved, then the customer is scoped in the list read.
      expect(mockOrderFindMany).toHaveBeenCalledWith({
        where: { displayId: 4242 },
        select: { customerId: true },
        orderBy: { id: "asc" },
        take: 2,
      });
      expect(mockListForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust_01" }),
      );
    } finally {
      await server.close();
    }
  });

  it("returns an empty page (count 0) for an unknown orderId — never all, never 500", async () => {
    mockOrderFindMany.mockResolvedValueOnce([]); // no order with that displayId
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations?orderId=999",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ conversations: [], count: 0 });
      // Degrades WITHOUT falling through to an unscoped listForAdmin.
      expect(mockListForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("degrades a NON-NUMERIC orderId to an empty page and never queries orders", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations?orderId=abc",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ conversations: [], count: 0 });
      // Guarded before the read — Number("abc") is NaN, never reaches Prisma.
      expect(mockOrderFindMany).not.toHaveBeenCalled();
      expect(mockListForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("degrades an ABOVE-INT4 orderId to an empty page and never 500s (range guard)", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations?orderId=99999999999",
      });
      // 99999999999 > 2147483647 (INT4 max) — the guard short-circuits to empty
      // instead of letting orderProjection.findMany throw and 500 the route.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ conversations: [], count: 0 });
      expect(mockOrderFindMany).not.toHaveBeenCalled();
      expect(mockListForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── listForAdmin pagination / count shape ──────────────────────────────────────

describe("GET /api/admin/conversations (pagination + count shape)", () => {
  it("maps the listForAdmin rows (Date → ISO) and returns its count", async () => {
    mockListForAdmin.mockResolvedValueOnce({ rows: [SUMMARY_ROW], count: 57 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/conversations?customerId=cust_01&limit=5&offset=10",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        conversations: Array<Record<string, unknown>>;
        count: number;
      };
      expect(body.count).toBe(57);
      expect(body.conversations[0]).toEqual({
        id: "conv_01",
        sessionId: "sess_01",
        customerId: "cust_01",
        channel: "whatsapp",
        messageCount: 4,
        lastMessageAt: LAST_MSG_AT.toISOString(),
      });
      // limit/offset are threaded through to the service.
      expect(mockListForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust_01", limit: 5, offset: 10 }),
      );
    } finally {
      await server.close();
    }
  });
});
