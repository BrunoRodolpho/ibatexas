// NEW-P0-X8 — Empty-string customerId guard tests (W1 correctness remediation).
//
// Per deep-audit/05-hidden-bugs.md #3: empty customerId from JWT builds
// `anonymize:otp:` (no suffix) which collapses ALL "" customers onto the
// same Redis key namespace.
//
// Coverage:
//   1. `assertCustomerId("")` throws `InvalidCustomerIdError`.
//   2. `assertCustomerId(null)` and `undefined` likewise throw.
//   3. Each public helper (markOtpFresh, hasFreshOtp, …) rejects empty
//      string BEFORE touching Redis.
//   4. The middleware-level `requireAuth` gate returns 401 when the JWT
//      `sub` is empty (defense-in-depth at the route entry).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";

// Redis stub — counts calls so we can assert "no Redis key was created".
const redisStorage = vi.hoisted(() => new Map<string, string>());
const mockRedisSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    redisStorage.set(key, value);
    return "OK";
  }),
);
const mockRedisGet = vi.hoisted(() =>
  vi.fn(async (key: string) => redisStorage.get(key) ?? null),
);
const mockRedisDel = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    redisStorage.delete(key);
    return 1;
  }),
);
const mockRedisIncr = vi.hoisted(() => vi.fn(async () => 1));
const mockRedisExpire = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: mockRedisSet,
    get: mockRedisGet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
  })),
  rk: (k: string) => `ibatexas:${k}`,
}));

vi.mock("twilio", () => ({
  default: () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: vi.fn() },
          verificationChecks: { create: vi.fn() },
        }),
      },
    },
  }),
}));

describe("NEW-P0-X8 — anonymize-otp-gate helpers reject empty customerId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
  });

  it("markOtpFresh('') throws InvalidCustomerIdError, never touches Redis", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("hasFreshOtp('') throws InvalidCustomerIdError", async () => {
    const { hasFreshOtp, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(hasFreshOtp("")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it("hasFreshVerifiedOtp('') throws InvalidCustomerIdError", async () => {
    const { hasFreshVerifiedOtp, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(hasFreshVerifiedOtp("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it("incrementOtpFailureCount('') throws — counter cannot be poisoned across all empty-sub JWTs", async () => {
    const { incrementOtpFailureCount, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(incrementOtpFailureCount("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
    expect(mockRedisIncr).not.toHaveBeenCalled();
  });

  it("getOtpFailureCount('') throws", async () => {
    const { getOtpFailureCount, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(getOtpFailureCount("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
  });

  it("setCancelCooldown('') throws", async () => {
    const { setCancelCooldown, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(setCancelCooldown("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
  });

  it("hasCancelCooldown('') throws", async () => {
    const { hasCancelCooldown, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(hasCancelCooldown("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
  });

  it("persistPendingDeletion('', …) throws", async () => {
    const { persistPendingDeletion, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(
      persistPendingDeletion("", {
        parkedAt: Date.now(),
        intentHash: "deadbeef",
        otpTokenHint: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });

  it("readPendingDeletion('') throws", async () => {
    const { readPendingDeletion, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(readPendingDeletion("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
  });

  it("clearPendingDeletion('') throws", async () => {
    const { clearPendingDeletion, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(clearPendingDeletion("")).rejects.toBeInstanceOf(
      InvalidCustomerIdError,
    );
  });

  it("null/undefined customerId rejected", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../routes/me/anonymize-otp-gate.js"
    );
    await expect(
      markOtpFresh(null as unknown as string),
    ).rejects.toBeInstanceOf(InvalidCustomerIdError);
    await expect(
      markOtpFresh(undefined as unknown as string),
    ).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });
});

// ── Integration: requireAuth middleware rejects empty-sub JWTs ───────────
//
// We unit-test `requireAuth` directly by calling it with a hand-built
// FastifyRequest/Reply pair. The middleware's behavior is:
//   - If `extractAuth` cannot populate customerId, reply 401.
//   - If `request.customerId === ""`, reply 401 (new check, NEW-P0-X8).

describe("NEW-P0-X8 — requireAuth rejects empty/missing customerId", () => {
  function makeReply() {
    const calls: Array<{ status: number; body: unknown }> = [];
    const reply = {
      code(status: number) {
        calls.push({ status, body: null });
        return reply;
      },
      send(body: unknown) {
        if (calls.length > 0) calls[calls.length - 1]!.body = body;
        return reply;
      },
    } as unknown as FastifyReply & { _calls: typeof calls };
    (reply as unknown as { _calls: typeof calls })._calls = calls;
    return reply;
  }

  it("returns 401 when extractAuth populates customerId='' (defense-in-depth)", async () => {
    const { requireAuth } = await import("../middleware/auth.js");

    const request = {
      customerId: "" as string | undefined,
      cookies: {},
      // Force jwtVerify to throw so extractAuth falls through to the
      // staff path (which also fails); customerId remains "".
      // The new explicit empty-string check must still 401.
      // We simulate "already populated by some upstream" path by
      // skipping JWT verify entirely and pre-setting customerId to "".
    } as unknown as FastifyRequest;
    (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify =
      async () => {
        throw new Error("no jwt");
      };

    const reply = makeReply();
    await new Promise<void>((resolve) => {
      requireAuth(request, reply, () => resolve());
      // also resolve after a tick in case reply path returned synchronously
      setTimeout(resolve, 50);
    });
    const calls = (reply as unknown as {
      _calls: Array<{ status: number; body: { message?: string } }>;
    })._calls;
    expect(calls[0]?.status).toBe(401);
    expect(calls[0]?.body?.message).toMatch(/Sessão inválida|Autenticação/i);
  });

  it("returns 401 when no JWT and no customerId set", async () => {
    const { requireAuth } = await import("../middleware/auth.js");
    const request = {
      cookies: {},
    } as unknown as FastifyRequest;
    (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify =
      async () => {
        throw new Error("no jwt");
      };
    const reply = makeReply();
    await new Promise<void>((resolve) => {
      requireAuth(request, reply, () => resolve());
      setTimeout(resolve, 50);
    });
    const calls = (reply as unknown as {
      _calls: Array<{ status: number; body: { message?: string } }>;
    })._calls;
    expect(calls[0]?.status).toBe(401);
  });
});
