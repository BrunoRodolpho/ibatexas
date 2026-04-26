import { describe, expect, it } from "vitest";
import { BASIS_CODES, basis, isKnownBasisCode } from "../src/basis-codes.js";

describe("BASIS_CODES — vocabulary-controlled", () => {
  it("has all seven categories", () => {
    expect(Object.keys(BASIS_CODES).sort()).toEqual(
      [
        "auth",
        "business",
        "ledger",
        "schema",
        "state",
        "taint",
        "validation",
      ].sort(),
    );
  });

  it("basis() helper carries category and code", () => {
    const b = basis("state", BASIS_CODES.state.TRANSITION_VALID);
    expect(b.category).toBe("state");
    expect(b.code).toBe("transition_valid");
  });

  it("basis() attaches detail when provided", () => {
    const b = basis("business", BASIS_CODES.business.QUANTITY_CAPPED, {
      requested: 1000,
      capped: 100,
    });
    expect(b.detail).toEqual({ requested: 1000, capped: 100 });
  });

  it("isKnownBasisCode accepts every code in every category", () => {
    for (const category of Object.keys(BASIS_CODES) as Array<
      keyof typeof BASIS_CODES
    >) {
      const codes = Object.values(BASIS_CODES[category]);
      for (const code of codes) {
        expect(
          isKnownBasisCode({ category, code: code as never }),
        ).toBe(true);
      }
    }
  });

  it("isKnownBasisCode rejects drift strings", () => {
    expect(
      isKnownBasisCode({ category: "auth", code: "scope_ok" as never }),
    ).toBe(false);
    expect(
      isKnownBasisCode({ category: "auth", code: "scope-valid" as never }),
    ).toBe(false);
    expect(
      isKnownBasisCode({
        category: "state",
        code: "arbitrary_string" as never,
      }),
    ).toBe(false);
  });
});
