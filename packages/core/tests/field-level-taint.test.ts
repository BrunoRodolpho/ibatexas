import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canPropose,
  canProposeFieldLevel,
  collectFieldTaints,
  isTaintedValue,
  meetAll,
  tainted,
  type Taint,
  type TaintPolicy,
} from "../src/taint.js";

const taintArb = fc.constantFrom<Taint>("SYSTEM", "TRUSTED", "UNTRUSTED");

describe("TaintedValue<T> primitives", () => {
  it("tainted() wraps a value and taint", () => {
    const v = tainted(42, "TRUSTED");
    expect(v.value).toBe(42);
    expect(v.taint).toBe("TRUSTED");
  });

  it("isTaintedValue accepts wrapped values", () => {
    expect(isTaintedValue(tainted("x", "SYSTEM"))).toBe(true);
    expect(isTaintedValue({ value: 1, taint: "UNTRUSTED" })).toBe(true);
  });

  it("isTaintedValue rejects unwrapped values", () => {
    expect(isTaintedValue(null)).toBe(false);
    expect(isTaintedValue(42)).toBe(false);
    expect(isTaintedValue({})).toBe(false);
    expect(isTaintedValue({ value: 1 })).toBe(false);
    expect(isTaintedValue({ taint: "SYSTEM" })).toBe(false);
    expect(isTaintedValue({ value: 1, taint: "ROGUE" })).toBe(false);
  });
});

describe("collectFieldTaints — payload walker", () => {
  it("returns empty for plain payloads", () => {
    expect(collectFieldTaints({ a: 1, b: "x" })).toEqual([]);
    expect(collectFieldTaints([1, 2, 3])).toEqual([]);
    expect(collectFieldTaints("plain string")).toEqual([]);
  });

  it("collects single tainted field", () => {
    expect(
      collectFieldTaints({ price: 8900, note: tainted("sem cebola", "UNTRUSTED") }),
    ).toEqual(["UNTRUSTED"]);
  });

  it("collects multiple tainted fields", () => {
    expect(
      collectFieldTaints({
        price: tainted(8900, "SYSTEM"),
        note: tainted("X", "UNTRUSTED"),
        cpf: tainted("123", "TRUSTED"),
      }),
    ).toEqual(expect.arrayContaining(["SYSTEM", "UNTRUSTED", "TRUSTED"]));
  });

  it("walks nested arrays and objects", () => {
    const payload = {
      items: [
        { sku: "x", qty: tainted(1, "SYSTEM") },
        { sku: "y", qty: tainted(2, "UNTRUSTED") },
      ],
    };
    const taints = collectFieldTaints(payload);
    expect(taints).toContain("SYSTEM");
    expect(taints).toContain("UNTRUSTED");
  });
});

describe("canProposeFieldLevel — payload-walking gate", () => {
  const policy: TaintPolicy = {
    minimumFor: (k) => (k === "payment.send" ? "TRUSTED" : "UNTRUSTED"),
  };

  it("falls back to envelope-level when no TaintedValue is present", () => {
    expect(
      canProposeFieldLevel("UNTRUSTED", "payment.send", policy, { sku: "x" }),
    ).toBe(false);
    expect(
      canProposeFieldLevel("TRUSTED", "payment.send", policy, { sku: "x" }),
    ).toBe(true);
  });

  it("uses payload-level meet when fields are tainted", () => {
    // Envelope is SYSTEM but a tainted UNTRUSTED field drops the meet to UNTRUSTED.
    expect(
      canProposeFieldLevel("SYSTEM", "payment.send", policy, {
        cpf: tainted("123", "UNTRUSTED"),
      }),
    ).toBe(false);
    // Envelope is TRUSTED, all tainted fields are SYSTEM — meet is TRUSTED.
    expect(
      canProposeFieldLevel("TRUSTED", "payment.send", policy, {
        cpf: tainted("123", "SYSTEM"),
      }),
    ).toBe(true);
  });

  it("invariant: field-level can never be more permissive than envelope-level", () => {
    fc.assert(
      fc.property(taintArb, taintArb, (envT, fieldT) => {
        const payload = { x: tainted("v", fieldT) };
        const fieldDecision = canProposeFieldLevel(envT, "payment.send", policy, payload);
        // Without the field-level walker, we'd have used envelope taint alone:
        const envelopeOnly = canPropose(envT, "payment.send", policy);
        // Field-level may be MORE restrictive (false when envelope says true)
        // but never more permissive (cannot say true when envelope said false).
        if (envelopeOnly === false) {
          expect(fieldDecision).toBe(false);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("invariant: equivalent to envelope-level when payload has no TaintedValues", () => {
    fc.assert(
      fc.property(taintArb, (taint) => {
        const plainPayload = { sku: "x", qty: 1 };
        expect(
          canProposeFieldLevel(taint, "payment.send", policy, plainPayload),
        ).toBe(canPropose(taint, "payment.send", policy));
      }),
      { numRuns: 500 },
    );
  });
});

describe("invariant: meetAll(envelope + fieldTaints) === effective taint", () => {
  it("holds for arbitrary mixed payloads", () => {
    fc.assert(
      fc.property(
        taintArb,
        fc.array(taintArb, { minLength: 0, maxLength: 5 }),
        (envT, fieldTaints) => {
          // Construct a payload with each fieldTaint
          const payload = fieldTaints.map((t, i) => ({ [`f${i}`]: tainted(i, t) }));
          const collected = collectFieldTaints(payload);
          expect(collected.sort()).toEqual([...fieldTaints].sort());
          if (fieldTaints.length === 0) {
            expect(meetAll([envT])).toBe(envT);
          } else {
            const effective = meetAll([envT, ...fieldTaints]);
            // Sanity: effective is at least as restrictive as envelope alone
            const RANK: Record<Taint, number> = {
              SYSTEM: 3,
              TRUSTED: 2,
              UNTRUSTED: 1,
            };
            expect(RANK[effective]).toBeLessThanOrEqual(RANK[envT]);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
