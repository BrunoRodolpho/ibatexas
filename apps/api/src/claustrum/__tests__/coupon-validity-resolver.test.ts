// coupon-validity-resolver.test.ts — LE2-019 / spec Decision 18: the PURE half of
// the coupon-validity read.
//
//   1. detectCouponCodeInText — the deterministic, never-guessing code extractor.
//   2. evaluatePromotionRecord — the SHARED rejection classes, and the proof that
//      the display route and the claims read now run the SAME transcription.
//   3. composeCouponTermsText — the terms come from the record's OWN fields, and
//      the composer REFUSES to state terms it cannot read (no invented min-order,
//      no foreign currency printed as R$).
//   4. resolveCouponValidity — the four branches over ONE mocked IO edge, the
//      lower-case retry, and the per-turn memo (which is what makes the
//      investigator's and the planner's scalars byte-equal, C6 by construction).
//   5. evaluateCouponFeasibility — the journey-feasibility claim predicate, and
//      its fail-closed behaviour in BOTH directions.
//
// The claim/registry/template/turn-seam half lives in the sibling
// `coupon-validity-claim.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimVerdict } from "@adjudicate/core";
import {
  detectCouponCodeInText,
  evaluatePromotionRecord,
  promotionByCodePath,
  type PromotionRecord,
} from "../promotion-validity.js";

// Mock ONLY the transport — the ONE IO edge. `reaisToCentavos` and every other
// helper stay REAL, so the money text asserted below is the production text.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, medusaAdmin: vi.fn() };
});
const { medusaAdmin } = await import("@ibatexas/tools");
const {
  clearCouponValidityMemoForTests,
  composeCouponInvalidText,
  composeCouponTermsText,
  composeCouponValidText,
  evaluateCouponFeasibility,
  resolveCouponValidity,
} = await import("../coupon-validity-resolver.js");

/** A fixed "now" so every campaign-window assertion is deterministic. */
const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const now = () => NOW;

/** The live welcome coupon (packages/tools welcome-credit.ts): R$ 15 fixed. */
const BEMVINDO15: PromotionRecord = {
  id: "promo_1",
  code: "BEMVINDO15",
  status: "active",
  application_method: { type: "fixed", value: 15, currency_code: "brl" },
};

function listing(...promotions: PromotionRecord[]): { promotions: PromotionRecord[] } {
  return { promotions };
}

beforeEach(() => {
  clearCouponValidityMemoForTests();
  vi.mocked(medusaAdmin).mockReset();
});

// ── (1) The code extractor ───────────────────────────────────────────────────

describe("LE2-019 — detectCouponCodeInText (deterministic; never a guess)", () => {
  it.each([
    ["o cupom X1234 vale?", "X1234"],
    ["esse código BEMVINDO15 ainda funciona?", "BEMVINDO15"],
    ["cupom: FRETEGRATIS ainda tá valendo?", "FRETEGRATIS"],
    // Lower-case as typed — relayed VERBATIM; the retry (not the extractor) is
    // what reconciles it with the store's upper-case convention.
    ["meu cupom bemvindo15 vale?", "bemvindo15"],
    ["voucher promo2026 serve?", "promo2026"],
  ])("extracts the code from %j", (text, expected) => {
    expect(detectCouponCodeInText(text)).toBe(expected);
  });

  it("returns undefined when the utterance names NO code", () => {
    // The load-bearing negative: "ainda" and "vale" are code-SHAPED only in the
    // loosest sense, and mining one of them would look up a coupon nobody named.
    expect(detectCouponCodeInText("esse cupom ainda vale?")).toBeUndefined();
    expect(detectCouponCodeInText("tem algum cupom de desconto?")).toBeUndefined();
    expect(detectCouponCodeInText("o cupom que me mandaram funciona?")).toBeUndefined();
  });

  it("returns undefined for TWO distinct codes — never picks one", () => {
    expect(detectCouponCodeInText("o cupom X1234 ou o PROMO2026 valem?")).toBeUndefined();
  });

  it("treats the SAME code in two casings as ONE candidate, not an ambiguity", () => {
    expect(detectCouponCodeInText("o cupom bemvindo15 (BEMVINDO15) vale?")).toBe(
      "bemvindo15",
    );
  });

  it("does not mine SHOUTED coupon vocabulary as a code", () => {
    // Without the stop set, "CUPOM"/"VALE" are upper-case alphabetic runs and the
    // turn would dead-end in the needs-code CLARIFY on a perfectly clear question.
    expect(detectCouponCodeInText("CUPOM X1234 VALE?")).toBe("X1234");
    expect(detectCouponCodeInText("MEU CUPOM AINDA VALE?")).toBeUndefined();
  });

  it("rejects tokens outside the 4-24 length band and digit-only runs", () => {
    expect(detectCouponCodeInText("cupom AB1?")).toBeUndefined();
    expect(detectCouponCodeInText("cupom 15 vale?")).toBeUndefined();
    expect(
      detectCouponCodeInText(`cupom ${"A1".repeat(20)} vale?`),
    ).toBeUndefined();
  });
});

// ── (2) The SHARED rejection classes ─────────────────────────────────────────

describe("LE2-019 — evaluatePromotionRecord (the ONE shared transcription)", () => {
  it("an ACTIVE promotion with no campaign is usable", () => {
    expect(evaluatePromotionRecord(BEMVINDO15, NOW)).toEqual({ usable: true });
  });

  it("a MISSING record is a POSITIVE `absent` determination, not an error", () => {
    // This is why the honest "no" is a VALIDATED claim: a successful lookup that
    // matched nothing is a fact about the store's promotions.
    expect(evaluatePromotionRecord(undefined, NOW)).toEqual({
      usable: false,
      reason: "absent",
    });
  });

  it.each(["draft", "inactive"] as const)("rejects status=%s", (status) => {
    expect(evaluatePromotionRecord({ ...BEMVINDO15, status }, NOW)).toEqual({
      usable: false,
      reason: "not_active",
    });
  });

  it("an ABSENT status is never assumed active (fail-closed)", () => {
    const { status: _dropped, ...noStatus } = BEMVINDO15;
    expect(evaluatePromotionRecord(noStatus, NOW)).toEqual({
      usable: false,
      reason: "not_active",
    });
  });

  it("rejects a campaign that has not started, and one that has ended", () => {
    expect(
      evaluatePromotionRecord(
        { ...BEMVINDO15, campaign: { starts_at: "2026-08-01T00:00:00.000Z" } },
        NOW,
      ),
    ).toEqual({ usable: false, reason: "not_started" });
    expect(
      evaluatePromotionRecord(
        { ...BEMVINDO15, campaign: { ends_at: "2026-07-01T00:00:00.000Z" } },
        NOW,
      ),
    ).toEqual({ usable: false, reason: "ended" });
  });

  it("accepts a campaign whose window is OPEN, and one with no bounds at all", () => {
    expect(
      evaluatePromotionRecord(
        {
          ...BEMVINDO15,
          campaign: {
            starts_at: "2026-07-01T00:00:00.000Z",
            ends_at: "2026-08-01T00:00:00.000Z",
          },
        },
        NOW,
      ),
    ).toEqual({ usable: true });
    expect(
      evaluatePromotionRecord({ ...BEMVINDO15, campaign: { starts_at: null, ends_at: null } }, NOW),
    ).toEqual({ usable: true });
  });

  it("rejects an exhausted PROMOTION budget and an exhausted CAMPAIGN budget", () => {
    expect(evaluatePromotionRecord({ ...BEMVINDO15, limit: 100, used: 100 }, NOW)).toEqual({
      usable: false,
      reason: "promotion_budget_exhausted",
    });
    expect(
      evaluatePromotionRecord(
        { ...BEMVINDO15, campaign: { budget: { type: "usage", limit: 50, used: 50 } } },
        NOW,
      ),
    ).toEqual({ usable: false, reason: "campaign_budget_exhausted" });
  });

  it("does NOT evaluate the PER-ATTRIBUTE budget types (over-rejection guard)", () => {
    // Only Medusa's engine can judge these — it needs the customer attribute. A
    // check here would refuse a code that actually works at checkout.
    for (const type of ["use_by_attribute", "spend_by_attribute"] as const) {
      expect(
        evaluatePromotionRecord(
          { ...BEMVINDO15, campaign: { budget: { type, limit: 1, used: 99 } } },
          NOW,
        ),
      ).toEqual({ usable: true });
    }
  });

  it("names ONE store path for every caller", () => {
    // The property under test is UNCHANGED and is the reason this assertion is
    // spelled out rather than computed: every caller queries the same endpoint,
    // so two of them can never disagree about the same coupon.
    //
    // LE2-023 added `fields=+rules` to that one path rather than introducing a
    // second one. The `+` prefix ADDS to Medusa's default admin promotion
    // fields, so the two validity callers receive every field they already read,
    // byte-identically, plus one they ignore — and the swap-for-coupon
    // projection gets the field its arithmetic gate needs
    // (`promotionHasTargetingRules`) without forking the path.
    expect(promotionByCodePath("BEM VINDO/15")).toBe(
      "/admin/promotions?code=BEM%20VINDO%2F15&limit=1&fields=%2Brules",
    );
  });
});

// ── (3) The terms composer ───────────────────────────────────────────────────

describe("LE2-019 — composeCouponTermsText (terms from the record, nothing invented)", () => {
  it("renders a FIXED discount from integer centavos (Hard Rule 2)", () => {
    expect(composeCouponTermsText({ type: "fixed", value: 15 })).toBe(
      "R$ 15,00 de desconto",
    );
    expect(composeCouponTermsText({ type: "fixed", value: 7.5 })).toBe(
      "R$ 7,50 de desconto",
    );
  });

  it("renders a PERCENTAGE discount with the pt-BR decimal comma", () => {
    expect(composeCouponTermsText({ type: "percentage", value: 10 })).toBe(
      "10% de desconto",
    );
    expect(composeCouponTermsText({ type: "percentage", value: 12.5 })).toBe(
      "12,5% de desconto",
    );
  });

  it("REFUSES to state terms it cannot read — the honest-UNKNOWN feeder", () => {
    expect(composeCouponTermsText(undefined)).toBeUndefined();
    expect(composeCouponTermsText({ type: "fixed" })).toBeUndefined();
    expect(composeCouponTermsText({ value: 15 })).toBeUndefined();
    expect(composeCouponTermsText({ type: "buyget", value: 1 })).toBeUndefined();
    expect(composeCouponTermsText({ type: "fixed", value: 0 })).toBeUndefined();
    expect(
      composeCouponTermsText({ type: "fixed", value: Number.NaN }),
    ).toBeUndefined();
  });

  it("never prints a FOREIGN currency as R$", () => {
    expect(
      composeCouponTermsText({ type: "fixed", value: 15, currency_code: "usd" }),
    ).toBeUndefined();
    // BRL (either casing) and an unstated currency are the store's own.
    expect(composeCouponTermsText({ type: "fixed", value: 15, currency_code: "BRL" })).toBe(
      "R$ 15,00 de desconto",
    );
  });

  it("the composed scalars are the full pt-BR clauses the templates bind", () => {
    expect(
      composeCouponValidText({ code: "BEMVINDO15", termsText: "R$ 15,00 de desconto" }),
    ).toBe("Sim, o cupom BEMVINDO15 está válido — R$ 15,00 de desconto");
    expect(composeCouponInvalidText("XPTO123")).toBe("O cupom XPTO123 não está válido");
    // The negative never volunteers a store-internal REASON.
    expect(composeCouponInvalidText("XPTO123")).not.toMatch(/campanha|orçamento|rascunho/);
  });
});

// ── (4) The resolver's four branches ─────────────────────────────────────────

describe("LE2-019 — resolveCouponValidity: the four branches", () => {
  it("VALID — a usable record yields the terms scalar and the record's OWN code", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(listing(BEMVINDO15));
    const out = await resolveCouponValidity("t1", "o cupom BEMVINDO15 vale?", now);
    expect(out).toEqual({
      kind: "valid",
      validityText: "Sim, o cupom BEMVINDO15 está válido — R$ 15,00 de desconto",
      code: "BEMVINDO15",
    });
    expect(vi.mocked(medusaAdmin)).toHaveBeenCalledWith(promotionByCodePath("BEMVINDO15"));
  });

  it("INVALID — a SUCCESSFUL lookup that found nothing is the honest no", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(listing());
    const out = await resolveCouponValidity("t1", "o cupom XPTO123 vale?", now);
    expect(out).toEqual({
      kind: "invalid",
      invalidityText: "O cupom XPTO123 não está válido",
      code: "XPTO123",
    });
  });

  it("INVALID — an EXPIRED campaign is a fact, not an abstain", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(
      listing({ ...BEMVINDO15, campaign: { ends_at: "2026-07-01T00:00:00.000Z" } }),
    );
    const out = await resolveCouponValidity("t1", "o cupom BEMVINDO15 vale?", now);
    expect(out.kind).toBe("invalid");
  });

  it("NEEDS_CODE — no code named ⇒ NO lookup at all, and no guess", async () => {
    const out = await resolveCouponValidity("t1", "esse cupom ainda vale?", now);
    expect(out).toEqual({ kind: "needs_code" });
    expect(vi.mocked(medusaAdmin)).not.toHaveBeenCalled();
  });

  it("UNKNOWN — a THROWN lookup is honest ignorance, NEVER the negative (Inv 7)", async () => {
    vi.mocked(medusaAdmin).mockRejectedValue(new Error("medusa down"));
    const out = await resolveCouponValidity("t1", "o cupom BEMVINDO15 vale?", now);
    // The load-bearing assertion of this whole ticket's honesty story: this is
    // exactly where the display route would have said `valid: false`.
    expect(out).toEqual({ kind: "unknown" });
  });

  it("UNKNOWN — a usable record whose TERMS are unreadable never claims validity", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(
      listing({ ...BEMVINDO15, application_method: { type: "buyget", value: 1 } }),
    );
    const out = await resolveCouponValidity("t1", "o cupom BEMVINDO15 vale?", now);
    expect(out).toEqual({ kind: "unknown" });
  });

  it("retries the UPPER-CASE form when the verbatim code matched nothing", async () => {
    vi.mocked(medusaAdmin)
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing(BEMVINDO15));
    const out = await resolveCouponValidity("t1", "o cupom bemvindo15 vale?", now);
    expect(out.kind).toBe("valid");
    expect(vi.mocked(medusaAdmin).mock.calls.map((c) => c[0])).toEqual([
      promotionByCodePath("bemvindo15"),
      promotionByCodePath("BEMVINDO15"),
    ]);
  });

  it("does NOT retry when the code was already upper-case (one GET, not two)", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(listing());
    await resolveCouponValidity("t1", "o cupom XPTO123 vale?", now);
    expect(vi.mocked(medusaAdmin)).toHaveBeenCalledTimes(1);
  });
});

describe("LE2-019 — the per-turn memo (what makes C6 pass by construction)", () => {
  it("the SAME turnId+text reads ONCE and returns the identical resolution", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(listing(BEMVINDO15));
    const text = "o cupom BEMVINDO15 vale?";
    // The investigator's call and the claim planner's call, in that order.
    const a = await resolveCouponValidity("turn-1", text, now);
    const b = await resolveCouponValidity("turn-1", text, now);
    expect(b).toBe(a);
    expect(vi.mocked(medusaAdmin)).toHaveBeenCalledTimes(1);
  });

  it("a DIFFERENT turn reads again (entries never leak across turns)", async () => {
    vi.mocked(medusaAdmin).mockResolvedValue(listing(BEMVINDO15));
    const text = "o cupom BEMVINDO15 vale?";
    await resolveCouponValidity("turn-1", text, now);
    await resolveCouponValidity("turn-2", text, now);
    expect(vi.mocked(medusaAdmin)).toHaveBeenCalledTimes(2);
  });
});

// ── (5) The journey-feasibility claim predicate ──────────────────────────────

describe("LE2-019 — evaluateCouponFeasibility (the claim-predicate surface)", () => {
  const verdicts = (entries: Record<string, ClaimVerdict>) =>
    new Map<string, ClaimVerdict>(Object.entries(entries));

  it("reads USABLE / NOT_USABLE off the VALIDATED member", () => {
    expect(evaluateCouponFeasibility(verdicts({ COUPON_VALID: "VALIDATED" }))).toBe(
      "USABLE",
    );
    expect(evaluateCouponFeasibility(verdicts({ COUPON_INVALID: "VALIDATED" }))).toBe(
      "NOT_USABLE",
    );
  });

  it("an UNVALIDATED claim is UNKNOWN — never silently NOT_USABLE", () => {
    // A feasibility pre-check must not cancel a journey because a read failed.
    expect(evaluateCouponFeasibility(verdicts({}))).toBe("UNKNOWN");
    expect(evaluateCouponFeasibility(verdicts({ COUPON_VALID: "UNKNOWN" }))).toBe("UNKNOWN");
    expect(evaluateCouponFeasibility(verdicts({ COUPON_VALID: "REFUSED" }))).toBe("UNKNOWN");
    expect(
      evaluateCouponFeasibility(
        verdicts({ COUPON_VALID: "UNKNOWN", COUPON_INVALID: "UNKNOWN" }),
      ),
    ).toBe("UNKNOWN");
  });

  it("BOTH validated (structurally impossible) is UNKNOWN, not a coin flip", () => {
    expect(
      evaluateCouponFeasibility(
        verdicts({ COUPON_VALID: "VALIDATED", COUPON_INVALID: "VALIDATED" }),
      ),
    ).toBe("UNKNOWN");
  });

  it("ignores unrelated claim types entirely (it is a narrow predicate)", () => {
    expect(
      evaluateCouponFeasibility(
        verdicts({ STORE_OPEN_NOW: "VALIDATED", COUPON_VALID: "VALIDATED" }),
      ),
    ).toBe("USABLE");
    expect(evaluateCouponFeasibility(verdicts({ STORE_OPEN_NOW: "VALIDATED" }))).toBe(
      "UNKNOWN",
    );
  });
});
