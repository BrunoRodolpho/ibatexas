// Wave 6 Red-Team — Target 5 (NEW-P0-X8 empty customerId guard)
//
// HISTORIC — bypass closed at W7-G1 (b9575bc) + R1-4 (fae8dc5).
// The three EXPLOIT cases below describe a pre-fix bypass that no longer
// reproduces; they intentionally fail when the fix is in place, which is
// why they're now `.skip`ed. The positive regression test that pins the
// post-fix contract lives at `05-whitespace-rejected.test.ts`. If a
// future revert drops `customerId.trim().length === 0` from
// `assertCustomerId` or `middleware/auth.ts`, the W7-G1 regression test
// will go red — that's the canary, NOT these cases.
//
// Original finding: the empty-string guard checked `customerId === ""`
// and falsy values but did NOT trim. Strings consisting entirely of
// whitespace ("   ", "\n", "\t") passed the guard and were propagated
// downstream as Redis-key suffixes.
//
// Why we keep this file (instead of deleting): the EXPLOIT prose
// documents the original attack model and the namespace-collision
// argument; deleting it would lose that reasoning. The CONTRAST + the
// literal-"null" case still describe live behaviour and stay live.

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

  // HISTORIC — bypass closed at W7-G1 (b9575bc). Positive regression
  // test for the post-fix contract lives at 05-whitespace-rejected.test.ts.
  it.skip("EXPLOIT (CLOSED): '   ' (whitespace only) bypasses assertCustomerId — writes to Redis", async () => {
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

  // HISTORIC — bypass closed at W7-G1 (b9575bc).
  it.skip("EXPLOIT (CLOSED): '\\n' (newline only) bypasses assertCustomerId", async () => {
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
    // model with sub="". Per 05-whitespace-rejected.test.ts header:
    // the literal four-character string "null" is a legitimate (though
    // unusual) customerId; requireAuth upstream guards `sub` against the
    // literal before any call reaches this layer.
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:null");
  });

  // HISTORIC — padded ids are now canonicalised (trimmed) before key
  // construction at W7-G1 (b9575bc). The post-fix contract — the key
  // collapses to `anonymize:otp:abc` — is pinned at
  // 05-whitespace-rejected.test.ts.
  it.skip("EXPLOIT (CLOSED): '\\tabc\\t' (padded with tabs) passes through unchanged", async () => {
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

// ── Recommendation (HISTORIC — fix landed) ──────────────────────────
//
// The fix landed in two commits:
//   * W7-G1 (b9575bc) — assertCustomerId in apps/api/src/routes/me/
//     anonymize-otp-gate.ts now rejects whitespace-only and trims via
//     canonicalizeCustomerId before key construction.
//   * R1-4 (fae8dc5) — middleware/auth.ts:64,95,127 now reject
//     `payload.sub.trim().length === 0`.
//
// Positive regression test pinning the post-fix contract:
//   apps/api/src/__tests__/wave6-red-team/05-whitespace-rejected.test.ts
