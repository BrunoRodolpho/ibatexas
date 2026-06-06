// Probe test: unicode whitespace bypass attempts
import { describe, it, expect, vi, beforeEach } from "vitest";

const redisStorage = vi.hoisted(() => new Map<string, string>());
const mockRedisSet = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    redisStorage.set(key, value);
    return "OK";
  }),
);
const mockRedisGet = vi.hoisted(() => vi.fn(async () => null));
const mockRedisDel = vi.hoisted(() => vi.fn(async () => 1));
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

describe("PROBE G1 — unicode whitespace + control chars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
  });

  // U+00A0 NO-BREAK SPACE — common bypass for JS trim() since ES2019+
  // it() is actually trimmed by String.prototype.trim() per the spec.
  it("U+00A0 NBSP is rejected", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    await expect(markOtpFresh(" ")).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });

  // U+2003 EM SPACE — Unicode whitespace, trimmed by JS String.trim()
  it("U+2003 EM SPACE is rejected", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    await expect(markOtpFresh(" ")).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });

  // U+FEFF BOM (ZWNBSP) — also trimmed by JS String.trim()
  it("U+FEFF BOM is rejected", async () => {
    const { markOtpFresh, InvalidCustomerIdError } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    await expect(markOtpFresh("﻿")).rejects.toBeInstanceOf(InvalidCustomerIdError);
  });

  // U+200B Zero-Width Space — NOT trimmed by JS String.trim() (it's a non-printable, not whitespace per Unicode WhiteSpace property)
  it("U+200B ZWSP behavior — NOTE: NOT trimmed by JS String.trim()", async () => {
    const { markOtpFresh } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    // This one ACCEPTS — String.trim() does not strip ZWSP.
    // The post-trim length === 1, so it passes the guard.
    await markOtpFresh("​");
    expect(mockRedisSet).toHaveBeenCalled();
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:​");
  });

  // NUL byte — also NOT a String.trim() whitespace
  it("\\x00 NUL byte behavior — NOTE: NOT trimmed by JS String.trim()", async () => {
    const { markOtpFresh } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    await markOtpFresh("\x00");
    expect(mockRedisSet).toHaveBeenCalled();
  });

  // markOtpFresh canonicalizes — padded id with NBSP gets the NBSP trimmed
  it("NBSP-padded id is canonicalized via trim", async () => {
    const { markOtpFresh } = await import(
      "/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me/anonymize-otp-gate.ts"
    );
    await markOtpFresh(" abc ");
    expect(mockRedisSet.mock.calls[0][0]).toBe("ibatexas:anonymize:otp:abc");
  });
});
