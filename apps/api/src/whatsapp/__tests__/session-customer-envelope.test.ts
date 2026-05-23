// W7 P3 — focused envelope-routing tests for WhatsApp session resolve
//
// The broader `apps/api/src/__tests__/whatsapp-session.test.ts` covers
// the existing end-to-end semantics with a back-compat shim that routes
// `mockUpsertFromWhatsApp` calls through the new envelope path. This
// file asserts the envelope-routing details directly:
//
//   - The route invokes `customerSvc.createFromEnvelope` with:
//       * `envelope.kind = "customer.create"`
//       * `envelope.taint = "SYSTEM"` (clears pack's systemMinimum floor)
//       * `envelope.actor.principal = "system"`
//       * `envelope.actor.sessionId = "wa-session-resolve:<phoneHash>"`
//       * `envelope.payload.source = "wa-auto"`
//       * `envelope.payload.phoneHash` matches sha256(phone).slice(0,12)
//   - `extras.phone` carries the raw phone for the upsert.
//   - State has `otpFresh: false` (WhatsApp first-contact is not an OTP
//     completion).
//   - The new-session response shape `{ phone, sessionId, customerId,
//     isNew: true }` is preserved.

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveWhatsAppSession } from "../session.js";

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockCreateFromEnvelope = vi.hoisted(() => vi.fn());
const mockUuidv4 = vi.hoisted(() => vi.fn());

const mockRedis = vi.hoisted(() => ({
  hGetAll: vi.fn(),
  hGet: vi.fn(),
  hSet: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  eval: vi.fn(),
}));

const mockAtomicIncr = vi.hoisted(() => vi.fn().mockResolvedValue(1));

vi.mock("uuid", () => ({ v4: mockUuidv4 }));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `ibatexas:${key}`),
  atomicIncr: mockAtomicIncr,
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromWhatsApp: vi.fn(),
    createFromEnvelope: mockCreateFromEnvelope,
  }),
}));

vi.mock("@ibatexas/types", () => ({
  Channel: { Web: "web", WhatsApp: "whatsapp" },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.hGetAll.mockResolvedValue({}); // cache miss
  mockRedis.hSet.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(true);
  mockAtomicIncr.mockResolvedValue(1);
  mockUuidv4.mockReturnValue("session-uuid-001");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("session.ts P3 — customer.create envelope routing (WhatsApp)", () => {
  it("routes through createFromEnvelope with system-actor envelope on cache miss", async () => {
    const phone = "+5511999999999";
    const expectedHash = createHash("sha256").update(phone).digest("hex").slice(0, 12);

    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "cus_wa_01" },
    });

    const result = await resolveWhatsAppSession(phone);

    expect(result.isNew).toBe(true);
    expect(result.customerId).toBe("cus_wa_01");
    expect(mockCreateFromEnvelope).toHaveBeenCalledOnce();

    const [envelope, state, extras] = mockCreateFromEnvelope.mock.calls[0] as [
      {
        kind: string;
        taint: string;
        actor: { principal: string; sessionId: string };
        payload: { phoneHash: string; source: string };
        nonce: string;
      },
      { ctx: { actor: { principal: string }; otpFresh: boolean; customerExists: boolean } },
      { phone: string },
    ];

    // Envelope is system-seed shape per pack-customer-onboarding's
    // systemMinimum: "SYSTEM" floor for customer.create.
    expect(envelope.kind).toBe("customer.create");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.actor.sessionId).toBe(`wa-session-resolve:${expectedHash}`);
    expect(envelope.payload.phoneHash).toBe(expectedHash);
    expect(envelope.payload.source).toBe("wa-auto");

    // Nonce is deterministic per phone hash for replay-safety across
    // re-entry on cached-session paths that hit the upsert.
    expect(envelope.nonce).toBe(`wa-session-resolve:${expectedHash}`);

    // State: pre-OTP, pre-auth, no customer row yet.
    expect(state.ctx.actor.principal).toBe("system");
    expect(state.ctx.otpFresh).toBe(false);
    expect(state.ctx.customerExists).toBe(false);

    // Raw phone reaches the executor for the upsert (payload only
    // carries phoneHash per PII discipline).
    expect(extras.phone).toBe(phone);
  });

  it("preserves WhatsAppSession response shape on EXECUTE", async () => {
    const phone = "+5511888888888";
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "cus_wa_99" },
    });

    const result = await resolveWhatsAppSession(phone);

    expect(result).toEqual({
      phone,
      sessionId: "session-uuid-001",
      customerId: "cus_wa_99",
      isNew: true,
    });
  });

  it("throws when kernel REFUSEs the system-seed envelope", async () => {
    mockCreateFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          code: "taint_below_floor",
          userFacing: "Não foi possível concluir.",
        },
      },
    });

    await expect(resolveWhatsAppSession("+5511777777777")).rejects.toThrow(
      /customer\.create envelope did not EXECUTE/,
    );
  });

  it("skips envelope on cache hit (existing session)", async () => {
    mockRedis.hGetAll.mockResolvedValue({
      phone: "+5511666666666",
      sessionId: "existing-session-id",
      customerId: "cus_wa_existing",
      lastMessageAt: String(Date.now()),
    });
    mockRedis.eval.mockResolvedValue("existing-session-id");

    const result = await resolveWhatsAppSession("+5511666666666");

    expect(result.isNew).toBe(false);
    expect(result.customerId).toBe("cus_wa_existing");
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
  });

  it("respects the customer-creation rate limit BEFORE the envelope", async () => {
    // The route runs `atomicIncr` for the global customer-create cap
    // BEFORE building the envelope. Hitting the cap must throw without
    // touching the kernel.
    mockAtomicIncr.mockResolvedValue(101); // MAX_CUSTOMER_CREATES_PER_MINUTE = 100

    await expect(resolveWhatsAppSession("+5511555555555")).rejects.toThrow(
      /rate limit exceeded/,
    );
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled();
  });
});
