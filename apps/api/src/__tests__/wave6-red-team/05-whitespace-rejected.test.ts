// Wave 7 G1 — positive regression test for the whitespace customerId fix.
//
// The Wave 6 red-team tests in `01-customerid-whitespace-bypass.test.ts`
// documented an EXPLOIT against the empty-string-only guard in
// `apps/api/src/routes/me/anonymize-otp-gate.ts`:
//
//   `customerId === ""` does NOT match `"   "`, `"\n"`, `"\t"`, etc.
//
// W7-G1 tightens the guard to also reject whitespace-only and trims the
// assigned value so downstream Redis keys are canonical. The Wave 6
// exploits now FAIL (markOtpFresh rejects with InvalidCustomerIdError);
// this file pins the NEW, correct behaviour as a positive regression
// test so a future revert of the guard breaks the build immediately.
//
// Contract:
//   - markOtpFresh("   ")     ⇒ rejects with InvalidCustomerIdError
//   - markOtpFresh("\n")      ⇒ rejects
//   - markOtpFresh("\t")      ⇒ rejects
//   - markOtpFresh("  \n  ")  ⇒ rejects (any all-whitespace string)
//   - markOtpFresh(" abc ")   ⇒ accepts but writes the trimmed key
//     `anonymize:otp:abc` (canonicalises padded ids so two stolen
//     JWTs for the same human can't satisfy independent namespaces)
//   - markOtpFresh("abc")     ⇒ accepts (untouched control)
//
// Note: the literal string "null" is a legitimate (though unusual)
// customerId; the guard does NOT treat the four-character string
// "null" as null. requireAuth upstream guards `sub` against the literal
// before any call reaches this layer, so the additional guard would
// only cause false-positive bug reports.

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

describe("W7-G1 — whitespace customerId is now correctly rejected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
  });

  it("rejects '   ' (three spaces) with InvalidCustomerIdError — no Redis write", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("   ")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("rejects '\\n' (newline) with InvalidCustomerIdError", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("\n")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("rejects '\\t' (tab) with InvalidCustomerIdError", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("\t")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("rejects '  \\n  ' (mixed whitespace) with InvalidCustomerIdError", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("  \n  ")).rejects.toBeInstanceOf(InvalidCustomerIdError);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("canonicalises padded ids — '\\tabc\\t' lands key with the TRIMMED suffix", async () => {
    // Two stolen JWTs for the same human ("abc" vs "\tabc\t") used to land
    // on different keys, satisfying independent attack namespaces. Trim-on-
    // accept collapses them onto the same canonical key.
    const { markOtpFresh } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await markOtpFresh("\tabc\t");
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:abc");
  });

  it("canonicalises padded ids — ' abc ' lands key with the TRIMMED suffix", async () => {
    const { markOtpFresh } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await markOtpFresh(" abc ");
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:abc");
  });

  it("accepts 'abc' (untrimmed, no leading/trailing whitespace) — control", async () => {
    const { markOtpFresh } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await markOtpFresh("abc");
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:abc");
  });

  it("continues to reject empty string (Wave 4 P0-11 contract preserved)", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "../../routes/me/anonymize-otp-gate.js"
    );
    await expect(markOtpFresh("")).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });
});
