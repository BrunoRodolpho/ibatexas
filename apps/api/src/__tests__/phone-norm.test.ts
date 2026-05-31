import { describe, it, expect } from "vitest";
import { toE164BR } from "@ibatexas/domain";

describe("toE164BR (P2-DATA-PHONENORM)", () => {
  it("is idempotent on an already-canonical E.164 string", () => {
    expect(toE164BR("+5511999999999")).toBe("+5511999999999");
  });

  it("strips a whatsapp: prefix (Twilio inbound shape)", () => {
    expect(toE164BR("whatsapp:+5511999999999")).toBe("+5511999999999");
  });

  it("strips common formatting (spaces, dashes, parens, dots)", () => {
    expect(toE164BR("+55 11 99999-9999")).toBe("+5511999999999");
    expect(toE164BR("+55 (11) 9999.9999")).toBe("+551199999999");
  });

  it("strips whatsapp: AND formatting together", () => {
    expect(toE164BR("whatsapp:+55 11 99999-9999")).toBe("+5511999999999");
  });

  it("throws on a non-E.164 input", () => {
    expect(() => toE164BR("not-a-phone")).toThrow(/Invalid phone/);
    expect(() => toE164BR("5511999999999")).toThrow(/Invalid phone/); // no +
    expect(() => toE164BR("+0511999999999")).toThrow(/Invalid phone/); // leading 0
  });

  // ★ Merge-safety: formatting-only normalization must NEVER touch the BR 9th
  // digit. +5511999999999 (with 9) and +551199999999 (without) are DISTINCT
  // numbers — canonicalizing the 9th digit could merge two different customers,
  // which is worse than the current split. They must stay different keys.
  it("does NOT merge the Brazilian mobile 9th-digit variants", () => {
    expect(toE164BR("+5511999999999")).not.toBe(toE164BR("+551199999999"));
  });

  it("formatting variants of the SAME number collapse to one key (correct merge)", () => {
    const a = toE164BR("whatsapp:+5511999999999");
    const b = toE164BR("+55 (11) 99999-9999");
    expect(a).toBe(b); // same digits = same person
  });
});
