import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canPropose, meetAll, mergeTaint, type Taint, type TaintPolicy } from "../src/taint.js";

const taintArb = fc.constantFrom<Taint>("SYSTEM", "TRUSTED", "UNTRUSTED");
const RANK: Record<Taint, number> = { SYSTEM: 3, TRUSTED: 2, UNTRUSTED: 1 };

describe("mergeTaint — lattice algebra", () => {
  it("is commutative", () => {
    fc.assert(
      fc.property(taintArb, taintArb, (a, b) => {
        expect(mergeTaint(a, b)).toBe(mergeTaint(b, a));
      }),
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(taintArb, taintArb, taintArb, (a, b, c) => {
        expect(mergeTaint(mergeTaint(a, b), c)).toBe(
          mergeTaint(a, mergeTaint(b, c)),
        );
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(taintArb, (t) => {
        expect(mergeTaint(t, t)).toBe(t);
      }),
    );
  });

  it("is monotonic — never raises trust", () => {
    fc.assert(
      fc.property(taintArb, taintArb, (a, b) => {
        const merged = mergeTaint(a, b);
        expect(RANK[merged]).toBeLessThanOrEqual(Math.min(RANK[a], RANK[b]));
      }),
    );
  });

  it("lowest-trust-wins on canonical pairs", () => {
    expect(mergeTaint("SYSTEM", "UNTRUSTED")).toBe("UNTRUSTED");
    expect(mergeTaint("TRUSTED", "UNTRUSTED")).toBe("UNTRUSTED");
    expect(mergeTaint("SYSTEM", "TRUSTED")).toBe("TRUSTED");
    expect(mergeTaint("SYSTEM", "SYSTEM")).toBe("SYSTEM");
  });
});

describe("meetAll", () => {
  it("returns SYSTEM for empty input (nothing untrusted present)", () => {
    expect(meetAll([])).toBe("SYSTEM");
  });

  it("returns the single value for singleton input", () => {
    expect(meetAll(["TRUSTED"])).toBe("TRUSTED");
    expect(meetAll(["UNTRUSTED"])).toBe("UNTRUSTED");
  });

  it("collapses via mergeTaint across the list", () => {
    fc.assert(
      fc.property(fc.array(taintArb, { minLength: 1, maxLength: 8 }), (ts) => {
        const expected = ts.reduce((acc, t) => mergeTaint(acc, t));
        expect(meetAll(ts)).toBe(expected);
      }),
    );
  });
});

describe("canPropose", () => {
  const policy: TaintPolicy = {
    minimumFor: (kind) => {
      if (kind === "payment.send") return "SYSTEM";
      if (kind === "order.submit") return "TRUSTED";
      return "UNTRUSTED";
    },
  };

  it("blocks UNTRUSTED from proposing a TRUSTED-minimum intent", () => {
    expect(canPropose("UNTRUSTED", "order.submit", policy)).toBe(false);
  });

  it("blocks TRUSTED from proposing a SYSTEM-minimum intent", () => {
    expect(canPropose("TRUSTED", "payment.send", policy)).toBe(false);
  });

  it("allows SYSTEM to propose any intent", () => {
    expect(canPropose("SYSTEM", "payment.send", policy)).toBe(true);
    expect(canPropose("SYSTEM", "order.submit", policy)).toBe(true);
    expect(canPropose("SYSTEM", "browse", policy)).toBe(true);
  });

  it("allows UNTRUSTED to propose an UNTRUSTED-minimum intent (e.g. read-only)", () => {
    expect(canPropose("UNTRUSTED", "browse", policy)).toBe(true);
  });
});
