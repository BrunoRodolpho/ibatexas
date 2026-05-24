// Wave 6 Red-Team — Target 12 (P0-X-OTP atomic counter)
//
// Finding: when ops calls `clearOtpLockout(customerId)` to manually
// release a lockout, the failure counter is NOT also reset. The very
// next attempt re-trips the lockout because:
//   1. Lockout sentinel deleted by clearOtpLockout
//   2. Lua script reads `EXISTS lockout_key == 0` → proceeds to INCR
//   3. Counter is at `threshold + 1` from the previous burst
//   4. After INCR, `count > threshold` → sentinel re-set
//
// Effective outcome: a single "clearOtpLockout" call as ops intervention
// is silently undone by the next OTP attempt. Operators expect a clean
// slate; they get one-attempt grace.
//
// Severity: P2 — not exploitable from outside; operator-UX bug. But
// could cause confused incident response (ops thinks "I cleared the
// lockout, why are they still locked out?").

import { describe, it, expect, vi, beforeEach } from "vitest";

const redisStorage = vi.hoisted(() => new Map<string, string>());

// Lua-aware mock: implements OTP_ACQUIRE_ATTEMPT_LUA semantics so we
// can verify the bug end-to-end without spinning up Redis.
const mockEval = vi.hoisted(() =>
  vi.fn(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
    const [failKey, lockoutKey] = opts.keys;
    const [ttl, threshold, lockoutTtl] = opts.arguments.map(Number);

    if (redisStorage.has(lockoutKey)) {
      const current = Number.parseInt(redisStorage.get(failKey) ?? "0", 10);
      return [0, current, 1];
    }
    const prior = Number.parseInt(redisStorage.get(failKey) ?? "0", 10);
    const next = prior + 1;
    redisStorage.set(failKey, String(next));
    // (TTL handling omitted in mock — irrelevant for the bug)
    void ttl;
    void lockoutTtl;
    if (next > threshold) {
      redisStorage.set(lockoutKey, "1");
      return [0, next, 0];
    }
    return [1, next, 0];
  }),
);

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: vi.fn(async (key: string, value: string) => {
      redisStorage.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => redisStorage.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      redisStorage.delete(key);
      return 1;
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    eval: mockEval,
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

describe("RED-TEAM Target 12 — OTP lockout: clearOtpLockout does NOT reset counter", () => {
  beforeEach(() => {
    redisStorage.clear();
    vi.clearAllMocks();
  });

  it("EXPLOIT/BUG: after admin clears lockout, the very next attempt re-locks", async () => {
    const { acquireOtpAttempt, clearOtpLockout, resetOtpFailureCount } =
      await import("../../routes/me/anonymize-otp-gate.js");

    const customerId = "cus_abc";

    // Burn through the threshold (5 attempts) — sixth trips lockout.
    for (let i = 0; i < 6; i++) {
      await acquireOtpAttempt(customerId);
    }

    // Verify locked out.
    const locked = await acquireOtpAttempt(customerId);
    expect(locked.kind).toBe("locked_out");

    // Admin clears the lockout sentinel manually (but NOT the counter).
    await clearOtpLockout(customerId);

    // First attempt after clear — BUG: immediately re-locked because
    // counter still > threshold from the original burst.
    const afterClear = await acquireOtpAttempt(customerId);
    expect(afterClear.kind).toBe("locked_out");
  });

  it("CONTRAST: when admin ALSO resets counter, the next attempt succeeds", async () => {
    const { acquireOtpAttempt, clearOtpLockout, resetOtpFailureCount } =
      await import("../../routes/me/anonymize-otp-gate.js");
    const customerId = "cus_def";

    for (let i = 0; i < 6; i++) {
      await acquireOtpAttempt(customerId);
    }

    // The proper ops sequence requires BOTH calls (not documented as
    // such in the codebase) — exposing the API leakage.
    await clearOtpLockout(customerId);
    await resetOtpFailureCount(customerId);

    const afterClear = await acquireOtpAttempt(customerId);
    expect(afterClear.kind).toBe("allowed");
  });
});

// ── Recommendation ──────────────────────────────────────────────────
//
// Make `clearOtpLockout` symmetric: a single ops call should reset
// both the sentinel AND the counter. Otherwise document the
// "clear+reset" combo in ops runbooks (it currently isn't).
//
// Add to anonymize-otp-gate.ts:
//
//   export async function clearOtpLockout(customerId: string): Promise<void> {
//     assertCustomerId(customerId);
//     const redis = await getRedisClient();
//     // Reset BOTH the sentinel AND the counter — ops convenience.
//     await redis.del(rk(`anonymize:lockout:${customerId}`));
//     await redis.del(rk(`anonymize:fail:${customerId}`));
//   }
