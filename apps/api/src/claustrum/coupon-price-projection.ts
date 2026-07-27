// COUPON PRICE PROJECTION — LE2-023's grounding read for the swap-for-coupon
// workflow's feasibility pre-checks and confirm sentence.
//
// Answers exactly two questions about ONE coupon code against ONE order total:
//
//   · is this coupon usable right now?          → `couponIsValid`
//   · what would the basket cost with it?       → `couponNewTotalInCentavos`
//
// ── WHY THIS IS NOT `resolveCouponValidity` ─────────────────────────────────
//
// That resolver (coupon-validity-resolver.ts) is keyed by `${turnId} ${text}` and
// re-extracts the code from the RAW UTTERANCE with `detectCouponCodeInText`. It
// is the right seam for "the customer asked whether a coupon works", which is a
// question about a sentence. This is a different seam: the workflow already HAS a
// code — the customer authored it into a declared slot — and needs it checked
// against a specific order. Routing through the utterance-keyed resolver would
// mean re-mining a code we already hold, and would return `needs_code` for any
// code that happens not to look code-shaped in isolation.
//
// So this composes the SAME two shared primitives the display route composes
// (`promotionByCodePath` → `evaluatePromotionRecord`), plus the upper-case retry
// the utterance resolver performs and the display route does not — the store's
// codes are upper-case by convention and Medusa's `code` filter is exact, so a
// customer who typed "bemvindo15" must not be told their live coupon is invalid.
// One transport, one path, one usability predicate; only the KEY differs.
//
// ── THE THIRD STATE IS NOT "INVALID". IT IS NOTHING. ────────────────────────
//
// A lookup that THREW tells us nothing about the coupon, and this projection
// reports that by returning ABSENT fields rather than `couponIsValid: false`.
// The distinction is Inv 7's and it decides real behaviour here: an absent fact
// makes the pre-check predicate FALSE (workflow-predicates.ts is total over
// absence), so the workflow is refused with its authored reason and NOTHING
// destructive happens. `couponIsValid: false` would be a POSITIVE claim that the
// store rejected this code — a sentence we would then say to a customer whose
// coupon may be perfectly good.
//
// Both land on "we are not doing this", which is why the difference is easy to
// lose. It matters because one of them is true.
//
// ── AND WHY IT FAILS CLOSED HARDER THAN THE DISPLAY ROUTE ───────────────────
//
// `POST /api/coupons/validate` collapses a read error to `{valid:false}` and says
// so: a UI that shows no discount is harmless. Nothing downstream of it moves.
// Downstream of THIS read is a saga that CANCELS A REAL ORDER, so "harmless" is
// not available — `evaluateCouponFeasibility`'s own doctrine (an unproven coupon
// is unproven, never unusable) applies with more force, not less, and unproven
// must also never be a reason to proceed.
//
// PURE-ish: the only IO is `medusaAdmin`. The clock is read once and threaded
// explicitly into the pure predicate. No model, no memo — a feasibility read runs
// once per selection and a stale cached verdict is not worth a cancelled order.

import { medusaAdmin, reaisToCentavos } from "@ibatexas/tools";
import { logger } from "../lib/logger.js";
import {
  evaluatePromotionRecord,
  promotionByCodePath,
  promotionHasTargetingRules,
  type PromotionListResponse,
  type PromotionRecord,
} from "./promotion-validity.js";

/**
 * The ctx fields this projection stamps. All OPTIONAL, and absence is the
 * honest report of "could not establish" — see the module doc.
 */
export interface CouponPriceProjection {
  readonly couponIsValid?: boolean;
  readonly couponNewTotalInCentavos?: number;
  /**
   * LE2-023 — the code AS THE STORE SPELLS IT, stamped only for a promotion that
   * was found and is usable.
   *
   * Two reasons it is the store's spelling rather than the customer's, and the
   * second is the one that matters. It is more ACCURATE — the upper-case retry
   * below means "bemvindo15" legitimately matches `BEMVINDO15`, and quoting the
   * customer's version back would show them a code that does not exist in the
   * store. And it is SAFER: the code arrives on an UNTRUSTED payload and ends up
   * inside `confirmSwapForCoupon`'s customer-facing sentence, so round-tripping
   * it through the store means the only strings that can reach that sentence are
   * strings a promotion record actually contains.
   */
  readonly couponCode?: string;
}

/**
 * The discount a promotion applies to a whole-basket total, in INTEGER CENTAVOS,
 * or `undefined` when this system cannot compute it soundly.
 *
 * ── WHAT IS COMPUTABLE, AND WHY THE REST IS NOT ─────────────────────────────
 *
 * Two shapes, both whole-basket:
 *
 *   `fixed`      — `application_method.value` in the store currency's MAJOR unit
 *                  (reais), converted with the shared `reaisToCentavos`. Refused
 *                  outright when `currency_code` is present and is not BRL: the
 *                  amount cannot be voiced as R$ without lying about the
 *                  currency, exactly as `composeCouponTermsText` refuses it.
 *   `percentage` — a percent of the total.
 *
 * Everything else is `undefined`: an unrecognised `type` (a `buyget` promotion
 * has no whole-basket discount at all), and — via the caller — any promotion
 * carrying targeting rules, where "total − discount" is simply the wrong sum
 * because the discount does not apply to the whole total.
 *
 * ── THE ROUNDING RULE, STATED ───────────────────────────────────────────────
 *
 * `Math.floor` on the percentage discount, which rounds the resulting TOTAL UP.
 * The direction is deliberate and it is the customer-safe one: the quoted new
 * total is then never LOWER than what checkout will charge. A quoted total that
 * is one centavo high costs a customer nothing — they pay the smaller real
 * amount — while one that is one centavo low is a confirmation the system then
 * fails to honour, on a sentence the customer approved a cancellation against.
 * Rounding is not neutral when a number is a promise.
 *
 * Clamped at the total: a discount larger than the basket yields a new total of
 * zero, never a negative one.
 *
 * Pure — no clock, no IO.
 */
export function couponDiscountInCentavos(
  applicationMethod: PromotionRecord["application_method"],
  orderTotalInCentavos: number,
): number | undefined {
  const value = applicationMethod?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const type = applicationMethod?.type;

  if (type === "percentage") {
    if (value > 100) return undefined;
    return Math.min(
      orderTotalInCentavos,
      Math.floor((orderTotalInCentavos * value) / 100),
    );
  }

  if (type === "fixed") {
    const currency = applicationMethod?.currency_code;
    if (
      typeof currency === "string" &&
      currency.trim() !== "" &&
      currency.toLowerCase() !== "brl"
    ) {
      return undefined;
    }
    return Math.min(orderTotalInCentavos, reaisToCentavos(value));
  }

  return undefined;
}

/**
 * Look the promotion up BY CODE, verbatim then upper-cased.
 *
 * Two GETs at most, on the one shared path. Throws are the caller's ABSENT
 * branch — this function never invents a verdict for a read it could not make.
 */
async function lookupPromotionByCode(
  code: string,
): Promise<PromotionRecord | undefined> {
  const first = (await medusaAdmin(
    promotionByCodePath(code),
  )) as PromotionListResponse;
  const found = first.promotions?.[0];
  if (found !== undefined) return found;
  const upper = code.toUpperCase();
  if (upper === code) return undefined;
  const retry = (await medusaAdmin(
    promotionByCodePath(upper),
  )) as PromotionListResponse;
  return retry.promotions?.[0];
}

/**
 * Project one coupon code against one order total.
 *
 * `code` is the customer-authored slot value, verbatim. An empty code, an
 * unreadable order total, or a failed lookup all return `{}` — no fields, no
 * claims, and a workflow that refuses honestly.
 *
 * Note the asymmetry between the two fields, which is not an oversight: a coupon
 * can be genuinely VALID and still have no computable new total (a `buyget`
 * promotion, a rules-targeted one, a non-BRL fixed amount). That combination
 * stamps `couponIsValid: true` and omits the total, so a pre-check over the
 * total refuses the SWAP while the validity fact stays true for anything else
 * that reads it. The alternative — suppressing validity because the arithmetic
 * failed — would be reporting a falsehood about the store to avoid reporting an
 * absence about ourselves.
 */
export async function projectCouponForOrder(args: {
  readonly code: string;
  readonly orderTotalInCentavos: number | undefined;
  readonly now?: () => number;
}): Promise<CouponPriceProjection> {
  const code = args.code.trim();
  if (code === "") return {};

  let promo: PromotionRecord | undefined;
  try {
    promo = await lookupPromotionByCode(code);
  } catch (error) {
    // Inv 7 — "could not check" is NOT "not valid". Nothing is stamped, the
    // pre-check refuses, and the customer is told we could not confirm the
    // coupon rather than that their coupon is bad.
    logger.warn(
      {
        component: "coupon-price-projection",
        event: "coupon_projection.read_failed",
        error: error instanceof Error ? error.message : String(error),
      },
      "coupon-price-projection: promotion lookup failed — every coupon fact stays ABSENT and the workflow refuses honestly",
    );
    return {};
  }

  const validity = evaluatePromotionRecord(promo, (args.now ?? Date.now)());
  if (!validity.usable) return { couponIsValid: false };

  // THE STORE'S OWN SPELLING, and only ever the store's. Falls back to what the
  // customer typed only when the record carries no `code` at all — a shape
  // `evaluatePromotionRecord` does not reject, since usability is decided by
  // status and dates rather than by the code field it was looked up by. The
  // fallback is the customer's trimmed slot, which is the same string the lookup
  // above matched on, so it is still a code the store answered to.
  const usable: CouponPriceProjection = {
    couponIsValid: true,
    couponCode: typeof promo?.code === "string" && promo.code !== "" ? promo.code : code,
  };

  const total = args.orderTotalInCentavos;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return usable;
  }
  // TARGETING RULES CLOSE THE ARITHMETIC. A rules-bearing promotion may discount
  // only part of a basket, so subtracting its headline value from the whole
  // total is not an approximation — it is a different number. Fail-closed on
  // uncertainty; see `promotionHasTargetingRules`.
  if (promotionHasTargetingRules(promo)) return usable;

  const discount = couponDiscountInCentavos(promo?.application_method, total);
  if (discount === undefined) return usable;
  return { ...usable, couponNewTotalInCentavos: total - discount };
}
