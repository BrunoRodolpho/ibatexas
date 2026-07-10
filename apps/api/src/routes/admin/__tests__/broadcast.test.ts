// Route tests for admin/broadcast.ts — the WhatsApp blast + marketing-consent
// surface. These pin the SECURITY/COMPLIANCE guarantees the pure orchestrator
// (broadcast.test.ts) cannot reach because they live in the ROUTE wiring:
//   1. S5 — POST /broadcast/audience/preview 400s an EMPTY audience spec (the
//      whole-base-blast guard). Without a filter the compiled `where` is `{}`,
//      which would resolve to the ENTIRE non-opted-out base — a mass-send footgun.
//   2. requireManagerRole gates the blast endpoint (ATTENDANT / no-auth → 403,
//      never a send).
//   3. Opted-out recipients are SKIPPED (the send-time consent gate is honored).
//   4. S2 — a non-E.164 opt-out is REJECTED (documented pt-BR 400), never stored
//      as an un-matchable key while returning {ok:true}.
//
// Harness mirrors customers.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach. requireManagerRole is the
// REAL middleware (we assert its gating). runBroadcast is the REAL orchestrator.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockSendText = vi.hoisted(() => vi.fn(async () => {}));
const mockIsOptedOut = vi.hoisted(() => vi.fn(async (_recipient: string) => false));
const mockOptOut = vi.hoisted(() => vi.fn(async () => {}));
const mockOptIn = vi.hoisted(() => vi.fn(async () => {}));
const mockList = vi.hoisted(() => vi.fn(async () => [] as string[]));
const mockBroadcastSendCreate = vi.hoisted(() => vi.fn(async () => ({})));
const mockOrderFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const mockCustomerFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const mockConsentFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

// A stand-in for the real `toE164BR`: canonicalizes a bare BR phone, THROWS on
// anything with letters / too few digits (the S2 rejection path).
const mockToE164BR = vi.hoisted(
  () =>
    (input: string): string => {
      const s = String(input);
      const digits = s.replace(/\D/g, "");
      if (/[a-zA-Z]/.test(s) || digits.length < 12 || digits.length > 13) {
        throw new Error("Invalid BR phone");
      }
      return `+${digits}`;
    },
);

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    broadcastSend: { create: mockBroadcastSendCreate },
    orderProjection: { findMany: mockOrderFindMany },
    customer: { findMany: mockCustomerFindMany },
    customerBroadcastConsent: { findMany: mockConsentFindMany },
  },
  Prisma: {},
  toE164BR: mockToE164BR,
}));

vi.mock("../../../whatsapp/client.js", () => ({
  sendText: mockSendText,
}));

vi.mock("@adjudicate/core", () => ({
  mintBroadcastReply: (body: string) => body,
}));

vi.mock("../../../broadcast/broadcast-optout.js", () => ({
  // Identity normalizer keeps the injected recipients byte-stable through the route.
  normalizeRecipient: (r: string) => r,
  getBroadcastOptOutStore: async () => ({
    isOptedOut: mockIsOptedOut,
    optOut: mockOptOut,
    optIn: mockOptIn,
    list: mockList,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };
const NO_AUTH: StaffContext = { staffId: null, staffRole: null };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { broadcastRoutes } = await import("../broadcast.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(broadcastRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOptedOut.mockResolvedValue(false);
});
afterEach(() => vi.resetModules());

// ── S5 — whole-base-blast guard on the audience preview ────────────────────────

describe("POST /api/admin/broadcast/audience/preview (S5 whole-base guard)", () => {
  it("400s an EMPTY audience spec and never touches the customer base", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast/audience/preview",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { message: string };
      expect(body.message).toContain("Especifique ao menos um filtro");
      // The guard short-circuits BEFORE any read — the whole base is never loaded.
      expect(mockOrderFindMany).not.toHaveBeenCalled();
      expect(mockCustomerFindMany).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does NOT 400 when at least one filter is present (guard is empty-spec-specific)", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast/audience/preview",
        payload: { source: "whatsapp" },
      });
      expect(res.statusCode).toBe(200);
      // A real (whitelisted) filter compiles into a parameterized customer read.
      expect(mockCustomerFindMany).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("rejects an ATTENDANT on the preview with 403 (requireManagerRole) and never reads", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast/audience/preview",
        payload: { source: "whatsapp" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCustomerFindMany).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── requireManagerRole gating + consent enforcement on the blast ───────────────

describe("POST /api/admin/broadcast (manager gate + consent enforcement)", () => {
  it("rejects an ATTENDANT with 403 and never sends", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast",
        payload: { recipients: ["+5511999990000"], template: "Promoção!" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockSendText).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects an unauthenticated request with 403 and never sends", async () => {
    const server = await buildServer(NO_AUTH);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast",
        payload: { recipients: ["+5511999990000"], template: "Promoção!" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockSendText).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("SKIPS opted-out recipients (send-time consent gate) and sends to the rest", async () => {
    // The second number has opted out — it must never receive the blast.
    mockIsOptedOut.mockImplementation(async (r: string) => r === "+5522222222222");
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast",
        payload: {
          recipients: ["+5511111111111", "+5522222222222"],
          template: "Promoção!",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { sent: number; skipped: number; total: number };
      expect(body).toMatchObject({ total: 2, sent: 1, skipped: 1 });
      // The opted-out number is never sent to; the other one IS.
      expect(mockSendText).toHaveBeenCalledTimes(1);
      expect(mockSendText).toHaveBeenCalledWith("whatsapp:+5511111111111", "Promoção!");
      expect(mockSendText).not.toHaveBeenCalledWith(
        "whatsapp:+5522222222222",
        expect.anything(),
      );
    } finally {
      await server.close();
    }
  });
});

// ── S2 — non-E.164 opt-out rejection (never a silent un-matchable key) ─────────

describe("POST /api/admin/broadcast/optout (S2 E.164 canonicalization guard)", () => {
  it("REJECTS a non-E.164 recipient with a documented 400 and never records the opt-out", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast/optout",
        payload: { recipient: "telefone-invalido" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { message: string };
      // The documented pt-BR rejection — NOT a misleading {ok:true}.
      expect(body.message).toContain("Telefone inválido");
      expect(body).not.toHaveProperty("ok");
      // An ineffective (un-matchable) consent key must never be written.
      expect(mockOptOut).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("records a canonicalized opt-out for a valid recipient", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/broadcast/optout",
        payload: { recipient: "+55 11 98888-7777" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // Stored under the canonical E.164 key so the send-time gate can match it.
      expect(mockOptOut).toHaveBeenCalledWith("+5511988887777");
    } finally {
      await server.close();
    }
  });
});
