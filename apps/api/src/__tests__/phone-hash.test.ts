// Unit tests for the centralized keyed-HMAC phone pseudonym (P1-CRYPTO-PHONEHASH).

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { hashPhone } from "../lib/phone-hash.js";

const PEPPER_A = "test-pepper-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEPPER_B = "test-pepper-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PHONE = "+5511999990000";

describe("hashPhone — keyed HMAC phone pseudonym", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is deterministic for a fixed pepper", () => {
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_A);
    expect(hashPhone(PHONE)).toBe(hashPhone(PHONE));
  });

  it("is salted by the pepper — same phone, different pepper → different hash", () => {
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_A);
    const withA = hashPhone(PHONE);
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_B);
    const withB = hashPhone(PHONE);
    expect(withA).not.toBe(withB);
  });

  it("produces a full-length (untruncated) SHA-256 HMAC — 64 hex chars", () => {
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_A);
    const hash = hashPhone(PHONE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a plain createHmac under the same pepper (keyed, not bare sha256)", () => {
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_A);
    const expected = createHmac("sha256", PEPPER_A).update(PHONE).digest("hex");
    expect(hashPhone(PHONE)).toBe(expected);
  });

  it("distinguishes different phones", () => {
    vi.stubEnv("PHONE_HASH_PEPPER", PEPPER_A);
    expect(hashPhone("+5511999990000")).not.toBe(hashPhone("+5511999990001"));
  });
});
