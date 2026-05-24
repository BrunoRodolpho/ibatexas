// Wave 6 Red-Team — Target 5 (NEW-P0-X8 empty customerId guard)
//
// Finding: the empty-string guard checks `customerId === ""` and falsy
// values but does NOT trim. Strings consisting entirely of whitespace
// ("   ", "\n", "\t") or the literal string "null" / "undefined" pass
// the guard and are propagated downstream as Redis-key suffixes.
//
// Severity: P1 — these strings DO get propagated but the downstream
// `assertCustomerId` in anonymize-otp-gate.ts has the same gap (it also
// only checks `=== ""`). So:
//   * `customerId = "   "` lands keys like `anonymize:otp:   ` →
//     a colliding-state namespace shared by every empty-after-trim
//     forged token.
//   * `customerId = "null"` lands keys like `anonymize:otp:null` →
//     a separate but still-colliding namespace.
//
// The stolen-JWT amplifier the original P0-X8 fix was meant to close
// is only PARTIALLY closed: any forger whose token includes a `sub` of
// whitespace OR the literal string `"null"` still satisfies the
// requireAuth gate.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("RED-TEAM Target 5 — whitespace customerId bypass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
  });

  it("EXPLOIT: '   ' (whitespace only) bypasses assertCustomerId — writes to Redis", async () => {
    const { markOtpFresh } = await import("../../routes/me/anonymize-otp-gate.js");

    // The guard does NOT trim → the whitespace string passes.
    // Demonstrates the bypass: Redis IS written.
    await expect(markOtpFresh("   ")).resolves.toBeUndefined();
    expect(mockRedisSet).toHaveBeenCalledTimes(1);

    // The Redis key namespace gets a whitespace suffix — visually
    // identical to a "no suffix" footgun in a log/dashboard view.
    const args = mockRedisSet.mock.calls[0];
    expect(args[0]).toBe("ibatexas:anonymize:otp:   ");
  });

  it("EXPLOIT: '\\n' (newline only) bypasses assertCustomerId", async () => {
    const { markOtpFresh } = await import("../../routes/me/anonymize-otp-gate.js");

    await expect(markOtpFresh("\n")).resolves.toBeUndefined();
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:\n");
  });

  it("EXPLOIT: 'null' (literal string) bypasses assertCustomerId", async () => {
    const { markOtpFresh } = await import("../../routes/me/anonymize-otp-gate.js");

    await expect(markOtpFresh("null")).resolves.toBeUndefined();
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    // Every forged JWT with sub="null" lands on the same Redis key —
    // multi-actor collision risk just like the original P0-X8 attack
    // model with sub="".
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:null");
  });

  it("EXPLOIT: '\\tabc\\t' (padded with tabs) passes through unchanged", async () => {
    const { markOtpFresh } = await import("../../routes/me/anonymize-otp-gate.js");
    await markOtpFresh("\tabc\t");
    // The whitespace-padded id is NOT canonicalised — keys with
    // "\tabc\t" and "abc" never collide BUT are conceptually the same
    // actor. Two stolen JWTs for the same human can satisfy independent
    // namespaces.
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:\tabc\t");
  });

  it("CONTRAST: empty string IS correctly rejected", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("")).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });
});

// ── Recommendation ──────────────────────────────────────────────────
//
// The fix is one-liner in assertCustomerId (apps/api/src/routes/me/
// anonymize-otp-gate.ts:86-90) and in middleware/auth.ts:64,95,127:
//
//   if (customerId == null || typeof customerId !== "string" ||
//       customerId.trim().length === 0) {
//     throw new InvalidCustomerIdError();
//   }
//
// AND the assigned value should be the trimmed form so downstream
// Redis keys are canonical.
