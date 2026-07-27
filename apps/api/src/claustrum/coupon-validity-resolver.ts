// coupon-validity-resolver.ts — LE2-019 / spec Decision 18: the SHARED
// claustrum-side resolver behind the COUPON_VALID / COUPON_INVALID claims
// ("o cupom X1234 vale?", "esse código BEMVINDO15 ainda funciona?").
//
// WHAT THIS EXISTS FOR (spec Decision 18): coupon validity becomes a GROUNDED
// READ instead of attempt-and-see. Today the only way to learn whether a code
// works is to try to APPLY it and watch the checkout refuse (the D1 fail-closed
// 422 COUPON_REJECTED) — destructive, late, and unavailable to a customer who is
// merely asking. This module answers the question from a promotion LOOKUP, before
// anything is touched, and is the read primitive the journeys' feasibility
// pre-checks (LE2-022/023) reuse — see {@link evaluateCouponFeasibility}.
//
// DECISION 14 NEGATIVE SPACE — HARD BOUNDARY: this is a PURE READ. There is no
// apply path here, no cart mutation, and no intent envelope. The ONLY IO is a
// single admin GET of the promotion by code.
//
// AMENDED BY LE2-023, precisely. This comment used to say "no price-adjustment
// capability" full stop, and that became false the day the swap-for-coupon
// workflow needed its closed branch to NAME one. The accurate statement is:
// `order.coupon.adjust` IS DECLARED, and it is workflow-scoped and REFUSED BY
// POLICY — no parse can propose it and no guard in `ordersPolicyBundle` produces
// EXECUTE for it, so the kernel's default REFUSE is the only verdict it can
// receive. Opening it needs a catalog switch AND a pack policy change, in two
// packages, reviewed separately. `coupon_on_placed_order` still ships OFF and
// nothing in this module opens it. The boundary is unchanged in force; only its
// wording is now true.
//
// WHY a SHARED per-turn-memoized resolver (the delivery-coverage-resolver.ts /
// store-info-resolver.ts discipline): the investigator's evidence read AND the
// claim planner's value derivation BOTH need the IDENTICAL scalar within a turn
// so the kernel's C6 compares byte-equal values (PASS by construction). The memo
// is keyed on turnId + the request text; both call sites pass `cognition.turnId`
// and `perception.text`, so the ONE promotion read serves both — and the clock
// the campaign window is judged against is read ONCE per turn, so the two arms can
// never straddle a campaign boundary.
//
// THE FOUR BRANCHES (the delivery-coverage shape, which this ticket follows):
//
//   · `valid`      — the utterance supplies a code, the lookup SUCCEEDED, and the
//                    record is usable NOW (promotion-validity.ts). Carries the
//                    discount TERMS composed from the record's own
//                    `application_method`, pre-composed into ONE pt-BR scalar.
//   · `invalid`    — the lookup SUCCEEDED and positively determined the code is
//                    not usable: no such code, draft/inactive, outside its
//                    campaign window, or budget-exhausted. This is a FACT read off
//                    the promotion data, so it is a VALIDATED negative claim (an
//                    honest "no"), NOT an UNKNOWN.
//   · `needs_code` — coupon phrasing with NO extractable code (or two, which we
//                    will not pick between). The resolver NEVER guesses which
//                    coupon is meant; the turn CLARIFIES and asks for the code.
//   · `unknown`    — the promotion lookup was UNREADABLE (a throw). "Could not
//                    check" is NOT "your coupon is invalid" (Inv 7), so this
//                    degrades to the honest UNKNOWN, never a negative. This is
//                    where this module DIVERGES from the display route
//                    `POST /api/coupons/validate`, which collapses a failed
//                    lookup to `valid: false` because a UI showing no discount is
//                    harmless — a chat answer saying "seu cupom não vale" is not.
//
// NO NEW STORE PATH: the read goes through the EXISTING `medusaAdmin` transport
// (`@ibatexas/tools`, the same one store-info-resolver.ts uses) at the EXISTING
// `GET /admin/promotions?code=…` endpoint, and the usability predicate is the
// SHARED `evaluatePromotionRecord` the display route also calls — one client, one
// path, one predicate.
//
// PURE-ish: the only IO is `medusaAdmin`. The clock is read once per uncached
// resolution and threaded explicitly into the pure predicate. The memo is
// process-scoped and bounded; keyed by turnId so entries never leak across turns.

import type { ClaimVerdict } from "@adjudicate/core";
import { medusaAdmin, reaisToCentavos } from "@ibatexas/tools";
// ONE money formatter for the whole claims layer: `formatCentavosBRL` is already
// the single place a claim scalar turns INTEGER CENTAVOS into pt-BR text (Hard
// Rule 2). Re-deriving it here would be a second, drifting formatter for the same
// currency in the same renderer.
import { formatCentavosBRL } from "./delivery-coverage-resolver.js";
import {
  detectCouponCodeInText,
  evaluatePromotionRecord,
  promotionByCodePath,
  type PromotionListResponse,
  type PromotionRecord,
} from "./promotion-validity.js";

/**
 * The LEDGER EVIDENCE KEYS this resolver's states are recorded under. Declared
 * HERE, next to the states that produce them, and imported by BOTH the
 * investigator (which records) and the claim registry / classify-only seam (which
 * read) — so a key can never drift from the state it witnesses.
 *
 * `coupon:valid` / `coupon:invalid` are the COMPLEMENTARY pair backing
 * COUPON_VALID / COUPON_INVALID (claim-registry.ts): at most one is ever PRESENT
 * in a turn.
 */
export const COUPON_VALID_KEY = "coupon:valid";
export const COUPON_INVALID_KEY = "coupon:invalid";

/**
 * The ledger MARKER recorded (PRESENT) when a coupon question resolved to "I
 * cannot answer this without the code": no code-shaped token at all, or two
 * (which we will not pick between). Recorded ONLY on that positive determination
 * — a READ ERROR records nothing (Inv 7), so "tell me the code" can never be
 * confused with "I could not check".
 *
 * It backs NO registry claim and matches no owner-scoped key prefix — it is a
 * pure routing witness, the FE-T17b marker idiom (`delivery:needs_cep`), read by
 * `couponValidityNeedsCode` (classify-only-reads.ts) to force the CLARIFY.
 */
export const COUPON_NEEDS_CODE_MARKER_KEY = "coupon:needs_code";

/** The resolved coupon-validity state for a turn — see the module's four branches. */
export type CouponValidityResolution =
  | {
      readonly kind: "valid";
      /** The C6-bound pre-composed pt-BR scalar the positive template renders. */
      readonly validityText: string;
      /** The promotion's OWN code, as the record states it (audit/debug). */
      readonly code: string;
    }
  | {
      readonly kind: "invalid";
      /** The C6-bound pre-composed pt-BR scalar the negative template renders. */
      readonly invalidityText: string;
      /** The code the CUSTOMER supplied (there is no record to read one from). */
      readonly code: string;
    }
  | { readonly kind: "needs_code" }
  | { readonly kind: "unknown" };

// ── The pt-BR scalars (composed in CODE, never model-authored) ───────────────

/**
 * The DISCOUNT TERMS, composed from the promotion record's OWN
 * `application_method` — the ONLY discount facts this repo can honestly state.
 * Returns `undefined` when the terms cannot be read, which makes the caller
 * degrade to the honest UNKNOWN rather than assert a bare "está válido" with no
 * substance behind it. Pure.
 *
 * WHAT IS RENDERED, and why nothing else is: Medusa v2's promotion record carries
 * the discount as `application_method.{type,value}` — `percentage` (a percent) or
 * `fixed` (an amount in the store currency's MAJOR unit, i.e. reais; converted to
 * INTEGER CENTAVOS via the shared `reaisToCentavos` before formatting, Hard Rule
 * 2). A MINIMUM-ORDER threshold is DELIBERATELY NOT rendered: v2 has no
 * first-class minimum-order field — thresholds live in the generic
 * `rules[{attribute,operator,values}]` list whose semantics only Medusa's own
 * engine can interpret — so voicing one would be inventing a field the record
 * does not carry. If a first-class threshold field ever appears, it belongs here.
 *
 * CURRENCY GUARD: a `fixed` promotion whose `currency_code` is present and is NOT
 * BRL cannot be voiced as "R$ …" without lying about the currency, so it returns
 * `undefined` → honest UNKNOWN.
 */
export function composeCouponTermsText(
  applicationMethod: PromotionRecord["application_method"],
): string | undefined {
  const value = applicationMethod?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const type = applicationMethod?.type;

  if (type === "percentage") {
    // Integers render bare ("10%"); a fractional percent renders with the pt-BR
    // decimal comma ("12,5%"). Never a model-authored number either way.
    return `${String(value).replace(".", ",")}% de desconto`;
  }

  if (type === "fixed") {
    const currency = applicationMethod?.currency_code;
    if (typeof currency === "string" && currency.trim() !== "" && currency.toLowerCase() !== "brl") {
      return undefined;
    }
    return `${formatCentavosBRL(reaisToCentavos(value))} de desconto`;
  }

  // An application method with no recognised `type` states no terms we can read.
  return undefined;
}

/**
 * The DETERMINISTIC pt-BR POSITIVE scalar (the DELIVERY_COVERAGE / STORE_INFO
 * "pre-composed serialized scalar under the frozen single-C6-field kernel"
 * idiom). Composed in CODE from the promotion record's own code + terms — NEVER
 * model-authored (Hard Rule 2 / SDD §O#3). Pure.
 *
 * The application hint ("é só informar o código no checkout") is NOT part of this
 * scalar: it is STATIC LITERAL text in the validated template (slot-grammar.ts),
 * because it asserts nothing about the world — it describes what the CUSTOMER
 * does next. Keeping it out of the proposition keeps the C6-bound value purely
 * factual, and keeps this read free of any promise that the SYSTEM will apply
 * anything (Decision 14).
 */
export function composeCouponValidText(args: {
  readonly code: string;
  readonly termsText: string;
}): string {
  return `Sim, o cupom ${args.code} está válido — ${args.termsText}`;
}

/**
 * The DETERMINISTIC pt-BR NEGATIVE scalar. A definitive "this code is not usable"
 * from the promotion data is a FACT, so it renders as a VALIDATED claim — but the
 * sentence stays narrow: it says THIS code is not valid right now, and never
 * volunteers a reason the customer cannot verify (why a campaign is exhausted is
 * store-internal). Pure.
 */
export function composeCouponInvalidText(code: string): string {
  return `O cupom ${code} não está válido`;
}

// ── The read ─────────────────────────────────────────────────────────────────

/**
 * Look the promotion up BY CODE through the EXISTING admin transport. Tries the
 * code VERBATIM first; if that matched nothing and the code was not already
 * upper-case, retries the UPPER-CASE form — the store's codes are upper-case by
 * convention ("BEMVINDO15", and the web cart upper-cases before validating), and
 * Medusa's `code` filter is EXACT, so a customer who typed "bemvindo15" would
 * otherwise be told a live coupon does not exist. At most two GETs, only ever on
 * the same one path. Throws are the CALLER's `unknown` branch.
 */
async function lookupPromotionByCode(code: string): Promise<PromotionRecord | undefined> {
  const first = (await medusaAdmin(promotionByCodePath(code))) as PromotionListResponse;
  const found = first.promotions?.[0];
  if (found !== undefined) return found;
  const upper = code.toUpperCase();
  if (upper === code) return undefined;
  const retry = (await medusaAdmin(promotionByCodePath(upper))) as PromotionListResponse;
  return retry.promotions?.[0];
}

async function resolveCouponValidityUncached(
  text: string,
  nowMs: number,
): Promise<CouponValidityResolution> {
  const code = detectCouponCodeInText(text);
  // No code (or two) → ask. NEVER a guess at which coupon was meant, and never a
  // lookup of a token we are not confident is a code.
  if (code === undefined) return { kind: "needs_code" };

  try {
    const promo = await lookupPromotionByCode(code);
    const validity = evaluatePromotionRecord(promo, nowMs);
    if (!validity.usable) {
      // A POSITIVE determination off a SUCCESSFUL lookup — a fact, so the honest
      // "no" is a VALIDATED negative claim, not an abstain. The code echoed is the
      // customer's own (an `absent` rejection has no record to read one from).
      return { kind: "invalid", invalidityText: composeCouponInvalidText(code), code };
    }
    // Usable — but we only claim validity when we can also state the TERMS. A
    // record whose application method we cannot read is a coupon we cannot
    // describe, and "está válido" with nothing after it is a half-answer.
    const termsText = composeCouponTermsText(promo?.application_method);
    if (termsText === undefined) return { kind: "unknown" };
    // Render the promotion's OWN code when the record states one, so every byte of
    // the positive answer is ledger-sourced; fall back to the customer's spelling.
    const recordCode =
      typeof promo?.code === "string" && promo.code.trim() !== "" ? promo.code : code;
    return {
      kind: "valid",
      validityText: composeCouponValidText({ code: recordCode, termsText }),
      code: recordCode,
    };
  } catch {
    // Inv 7 — "could not check" is a DISTINCT state from "not valid". This is the
    // one place this module must NOT behave like the display route.
    return { kind: "unknown" };
  }
}

// ── The per-turn memo (the delivery-coverage-resolver.ts shape, verbatim) ─────

const COUPON_VALIDITY_MEMO_MAX = 256;
const couponValidityMemo = new Map<string, Promise<CouponValidityResolution>>();

function couponValidityMemoSet(
  key: string,
  value: Promise<CouponValidityResolution>,
): void {
  couponValidityMemo.set(key, value);
  if (couponValidityMemo.size > COUPON_VALIDITY_MEMO_MAX) {
    const oldest = couponValidityMemo.keys().next().value;
    if (oldest !== undefined) couponValidityMemo.delete(oldest);
  }
}

/** Test seam — clear the per-turn memo between cases. */
export function clearCouponValidityMemoForTests(): void {
  couponValidityMemo.clear();
}

/**
 * Resolve this turn's coupon-validity state. `turnId` + `text` scope the memo:
 * the investigator and the claim planner MUST pass the SAME pair
 * (`cognition.turnId`, `cognition.perception.text`) so they compose the IDENTICAL
 * scalar — the same-resolver-same-text invariant menu-item-resolver.ts pins, which
 * is what makes the kernel's C6 value-binding pass by construction rather than by
 * luck. It also pins the CLOCK: the campaign window is judged once per turn, so
 * the two arms can never straddle a campaign boundary mid-turn.
 *
 * `now` is injectable for deterministic tests; production passes nothing.
 */
export function resolveCouponValidity(
  turnId: string,
  text: string,
  now: () => number = Date.now,
): Promise<CouponValidityResolution> {
  const key = `${turnId} ${text}`;
  const cached = couponValidityMemo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveCouponValidityUncached(text, now());
  couponValidityMemoSet(key, pending);
  return pending;
}

// ── The journey-feasibility CLAIM PREDICATE (ticket AC 4) ────────────────────

/**
 * The three-valued coupon feasibility answer a journey pre-check consumes.
 * DISTINCT from the resolver's own `CouponValidityResolution`: that is what the
 * READ found, this is what the KERNEL VALIDATED — the difference between "the
 * lookup said so" and "a claim survived every soundness conjunct". A feasibility
 * pre-check must only ever act on the latter.
 */
export type CouponFeasibility =
  /** COUPON_VALID VALIDATED — the code is usable, grounded in the promotion record. */
  | "USABLE"
  /** COUPON_INVALID VALIDATED — the code is positively not usable. */
  | "NOT_USABLE"
  /** Neither validated (absent / UNKNOWN / REFUSED, or an impossible both) — do not act. */
  | "UNKNOWN";

/**
 * LE2-019 AC 4 — the CLAIM-PREDICATE surface over the validated coupon read, for
 * the journey feasibility pre-checks LE2-022/023 will build.
 *
 * PURE, and deliberately MINIMAL: it quantifies over the SAME per-type verdict map
 * the §O#15 completeness check already consumes (`checkRequiredClaimCompleteness`,
 * required-claim-decomposer.ts — a caller builds it from `ClaimsKernelResult`
 * `perClaim`), so no new claim-truth mechanism is introduced. This module builds
 * NO journey machinery whatsoever; it only makes the read CONSUMABLE as a
 * predicate.
 *
 * FAIL-CLOSED in both directions:
 *   · nothing VALIDATED (the read errored, no code was given, or the claim never
 *     reached the kernel) → `UNKNOWN`. A feasibility pre-check must treat an
 *     unproven coupon as unproven, NEVER as unusable — pre-emptively cancelling a
 *     journey on "we could not check" is the Inv 7 error one layer up.
 *   · BOTH members VALIDATED → `UNKNOWN`. That is structurally impossible (the
 *     investigator records at most one of the complementary keys, and the pair is
 *     registered in PRESENCE_COMPLEMENT_PAIRS), so if it ever happens the registry
 *     is broken and the honest answer is that we do not know.
 */
export function evaluateCouponFeasibility(
  verdicts: ReadonlyMap<string, ClaimVerdict>,
): CouponFeasibility {
  const valid = verdicts.get("COUPON_VALID") === "VALIDATED";
  const invalid = verdicts.get("COUPON_INVALID") === "VALIDATED";
  if (valid && invalid) return "UNKNOWN";
  if (valid) return "USABLE";
  if (invalid) return "NOT_USABLE";
  return "UNKNOWN";
}
