// Unit tests for LE2-023's coupon price projection.
//
// Two properties carry this module, and both are about what happens when the
// answer is NOT clean:
//
//   1. ABSENCE vs. FALSE. A failed lookup must leave every fact ABSENT, never
//      `couponIsValid: false` — one is "we could not check", the other is a
//      positive claim that the store rejected the code. Both refuse the
//      workflow, which is exactly why the difference is easy to lose and worth
//      pinning: only one of them is true.
//   2. THE ARITHMETIC GATE. A new total is quoted to a customer as part of a
//      confirmation they approve a real cancellation against, so it is computed
//      only for the promotion shapes where "total − discount" is the right sum,
//      and the uncertain cases fail CLOSED.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { medusaAdminMock } = vi.hoisted(() => ({ medusaAdminMock: vi.fn() }));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, medusaAdmin: medusaAdminMock };
});

const { couponDiscountInCentavos, projectCouponForOrder } = await import(
  "../coupon-price-projection.js"
);

/** A live, whole-basket promotion record. `rules: []` is the ONLY shape that
 *  proves "no targeting" — see `promotionHasTargetingRules`. */
function promo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "promo_1",
    code: "BEMVINDO15",
    status: "active",
    rules: [],
    application_method: { type: "fixed", value: 15, currency_code: "brl" },
    ...overrides,
  };
}

function listing(...promotions: Record<string, unknown>[]): unknown {
  return { promotions };
}

beforeEach(() => {
  medusaAdminMock.mockReset();
});

describe("couponDiscountInCentavos — what is computable", () => {
  it("a FIXED BRL amount converts reais to centavos", () => {
    expect(
      couponDiscountInCentavos({ type: "fixed", value: 15, currency_code: "brl" }, 50_000),
    ).toBe(1_500);
  });

  it("a fixed amount in ANOTHER currency is not computable", () => {
    // Voicing it as R$ would lie about the currency — the same refusal
    // `composeCouponTermsText` makes for the same reason.
    expect(
      couponDiscountInCentavos({ type: "fixed", value: 15, currency_code: "usd" }, 50_000),
    ).toBeUndefined();
  });

  it("an UNRECOGNISED application method is not computable", () => {
    // `buyget` has no whole-basket discount at all; inventing one would be
    // quoting a number with nothing behind it.
    expect(
      couponDiscountInCentavos({ type: "buyget", value: 1 }, 50_000),
    ).toBeUndefined();
    expect(couponDiscountInCentavos(undefined, 50_000)).toBeUndefined();
    expect(couponDiscountInCentavos({ type: "fixed", value: 0 }, 50_000)).toBeUndefined();
  });

  it("a percentage over 100 is not computable", () => {
    expect(couponDiscountInCentavos({ type: "percentage", value: 150 }, 50_000)).toBeUndefined();
  });

  it("ROUNDS THE DISCOUNT DOWN at a boundary, so the quoted total is never too low", () => {
    // THE ROUNDING PIN. 12.5% of R$100,03 (10_003 centavos) is 1250.375
    // centavos — a value that is not an integer, which is the whole point of
    // choosing a boundary rather than a round number.
    //
    // Floor on the DISCOUNT means the resulting TOTAL rounds UP. That direction
    // is the customer-safe one: a quoted total one centavo HIGH costs the
    // customer nothing (they pay the smaller real amount), while one centavo LOW
    // is a promise the checkout then breaks — on a sentence they approved a
    // cancellation against. Rounding is not neutral when a number is a promise.
    expect(couponDiscountInCentavos({ type: "percentage", value: 12.5 }, 10_003)).toBe(1_250);

    // The same pin stated as the total the customer would read.
    expect(10_003 - 1_250).toBe(8_753);
  });

  it("CLAMPS at the total — a discount larger than the basket never goes negative", () => {
    expect(couponDiscountInCentavos({ type: "fixed", value: 900, currency_code: "brl" }, 5_000)).toBe(5_000);
    expect(couponDiscountInCentavos({ type: "percentage", value: 100 }, 5_000)).toBe(5_000);
  });
});

describe("projectCouponForOrder — the third state is ABSENCE, not falsehood", () => {
  it("a FAILED LOOKUP stamps NOTHING — not `couponIsValid: false`", async () => {
    medusaAdminMock.mockRejectedValue(new Error("medusa unreachable"));

    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });

    // Inv 7. A read error tells us nothing about the coupon, so the projection
    // claims nothing about it. The pre-check refuses either way; only this
    // version is true.
    expect(projected).toEqual({});
    expect(projected.couponIsValid).toBeUndefined();
  });

  it("a coupon the store REJECTS is a positive `false` — the directional control", async () => {
    // The counterpart to the case above, and the reason it is not vacuous: a
    // SUCCESSFUL lookup that finds an expired campaign IS knowledge, and states
    // it. If both cases returned `{}` the test above would pass for the wrong
    // reason.
    medusaAdminMock.mockResolvedValue(
      listing(promo({ campaign: { ends_at: "2020-01-01T00:00:00.000Z" } })),
    );

    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });

    expect(projected.couponIsValid).toBe(false);
    expect(projected.couponNewTotalInCentavos).toBeUndefined();
  });

  it("a code that matches NOTHING is invalid, not unknown", async () => {
    medusaAdminMock.mockResolvedValue(listing());
    const projected = await projectCouponForOrder({
      code: "GHOST9",
      orderTotalInCentavos: 50_000,
    });
    expect(projected.couponIsValid).toBe(false);
  });
});

describe("projectCouponForOrder — the arithmetic gate", () => {
  it("a live whole-basket coupon yields validity AND the new total", async () => {
    medusaAdminMock.mockResolvedValue(listing(promo()));

    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });

    // LE2-023 — the EXACT shape, `couponCode` included. Kept as `toEqual`
    // rather than field-wise assertions on purpose: this projection's output is
    // spread straight onto `OrderState.ctx`, where `confirmSwapForCoupon` reads
    // it, so a field appearing here that nobody expected is a field a guard may
    // silently start reading. An exact-shape assertion is how a new one has to
    // be declared rather than discovered — it is what caught `couponCode`.
    expect(projected).toEqual({
      couponIsValid: true,
      couponNewTotalInCentavos: 48_500,
      couponCode: "BEMVINDO15",
    });
  });

  it("TARGETING RULES close the arithmetic while validity stays TRUE", async () => {
    // The asymmetry is deliberate: the coupon really is usable, and saying it is
    // not would be a falsehood about the store told to cover an absence in
    // ourselves. What we cannot do is state a resulting total, because a
    // rules-scoped discount does not apply to the whole basket.
    medusaAdminMock.mockResolvedValue(
      listing(promo({ rules: [{ attribute: "product_id", operator: "in", values: ["p1"] }] })),
    );

    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });

    expect(projected.couponIsValid).toBe(true);
    expect(projected.couponNewTotalInCentavos).toBeUndefined();
  });

  it("an ABSENT `rules` key is UNCERTAIN, and uncertainty closes the arithmetic", async () => {
    // The fail-closed pin. `promotionByCodePath` asks for `rules` explicitly, so
    // an absent key means the request did not come back the way we asked — and
    // reading that as "no rules" would quote a whole-basket total for a coupon
    // whose scope we never saw. Refusing to quote is loud and safe; quoting is
    // silent and wrong.
    const bare = promo();
    delete bare.rules;
    medusaAdminMock.mockResolvedValue(listing(bare));

    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });

    expect(projected.couponIsValid).toBe(true);
    expect(projected.couponNewTotalInCentavos).toBeUndefined();
  });

  it("an unreadable ORDER TOTAL closes the arithmetic without touching validity", async () => {
    medusaAdminMock.mockResolvedValue(listing(promo()));
    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: undefined,
    });
    // Validity AND the code survive an unpriceable basket — the code is a fact
    // about the promotion, not about the arithmetic.
    expect(projected).toEqual({ couponIsValid: true, couponCode: "BEMVINDO15" });
  });
});

// ── LE2-023 · the code the CONFIRM SENTENCE quotes ──────────────────────────
//
// `confirmSwapForCoupon` names the coupon from `ctx.couponCode`, never from the
// envelope payload. These pin the two properties that makes safe: the spelling
// is the STORE's, and it is absent for anything not usable.

describe("projectCouponForOrder — couponCode is the STORE's spelling", () => {
  it("stamps the promotion record's own code, not the caller's", async () => {
    // The customer typed lower case; the store's promotion is upper case. The
    // sentence must show what the store has — quoting the customer's version
    // would show them a code that does not exist.
    medusaAdminMock.mockResolvedValue(listing(promo()));
    const projected = await projectCouponForOrder({
      code: "bemvindo15",
      orderTotalInCentavos: 50_000,
    });
    expect(projected.couponCode).toBe("BEMVINDO15");
  });

  it("stamps NO code for a coupon that is not usable", async () => {
    medusaAdminMock.mockResolvedValue(listing(promo({ status: "inactive" })));
    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });
    expect(projected).toEqual({ couponIsValid: false });
    expect(projected.couponCode).toBeUndefined();
  });

  it("stamps NO code when the lookup could not be MADE", async () => {
    medusaAdminMock.mockRejectedValue(new Error("medusa down"));
    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });
    expect(projected).toEqual({});
  });

  it("falls back to the caller's code when the record carries none", async () => {
    // `evaluatePromotionRecord` decides usability from status and dates, never
    // from the code field it was looked up BY, so a usable record with no `code`
    // is a shape it does not reject. The fallback is the string the lookup
    // matched on, so it is still a code the store answered to.
    const noCode = promo();
    delete noCode.code;
    medusaAdminMock.mockResolvedValue(listing(noCode));
    const projected = await projectCouponForOrder({
      code: "BEMVINDO15",
      orderTotalInCentavos: 50_000,
    });
    expect(projected.couponCode).toBe("BEMVINDO15");
  });
});

describe("projectCouponForOrder — the lookup", () => {
  it("RETRIES UPPER-CASE, so a lower-cased live coupon is not called invalid", async () => {
    // The store's codes are upper-case by convention and Medusa's `code` filter
    // is EXACT. The display route omits this retry; the utterance resolver has
    // it. A workflow that cancels an order must not tell a customer their good
    // coupon is dead because they typed it in lower case.
    medusaAdminMock
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing(promo()));

    const projected = await projectCouponForOrder({
      code: "bemvindo15",
      orderTotalInCentavos: 50_000,
    });

    expect(projected.couponIsValid).toBe(true);
    expect(medusaAdminMock).toHaveBeenCalledTimes(2);
    expect(String(medusaAdminMock.mock.calls[0]?.[0])).toContain("bemvindo15");
    expect(String(medusaAdminMock.mock.calls[1]?.[0])).toContain("BEMVINDO15");
  });

  it("does NOT retry when the code was already upper-case", async () => {
    medusaAdminMock.mockResolvedValue(listing());
    await projectCouponForOrder({ code: "GHOST9", orderTotalInCentavos: 50_000 });
    expect(medusaAdminMock).toHaveBeenCalledTimes(1);
  });

  it("an empty code reads NOTHING — no request is made at all", async () => {
    const projected = await projectCouponForOrder({
      code: "   ",
      orderTotalInCentavos: 50_000,
    });
    expect(projected).toEqual({});
    expect(medusaAdminMock).not.toHaveBeenCalled();
  });

  it("asks for the `rules` field on the wire", async () => {
    // The gate above is only sound if the request actually asks for the field.
    medusaAdminMock.mockResolvedValue(listing(promo()));
    await projectCouponForOrder({ code: "BEMVINDO15", orderTotalInCentavos: 50_000 });
    expect(String(medusaAdminMock.mock.calls[0]?.[0])).toContain("rules");
  });
});
