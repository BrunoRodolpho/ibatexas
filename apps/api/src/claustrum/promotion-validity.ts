// promotion-validity.ts — LE2-019: the PURE coupon/promotion domain primitives —
// the code EXTRACTOR and the record VALIDITY predicate — with NO IO of any kind.
//
// TWO reasons this is its own module rather than living in the resolver:
//
//   (a) the validity predicate must be the ONE transcription shared by the two
//       callers that must never disagree about whether a coupon code is usable:
//
//   · the display-parity HTTP route `POST /api/coupons/validate`
//     (routes/cart.ts — BKL-070), and
//   · the grounded COUPON_VALID / COUPON_INVALID claim read
//     (coupon-validity-resolver.ts — this ticket).
//
// WHY IT WAS EXTRACTED rather than re-derived: the rejection classes below are a
// deliberate MIRROR of the checkout's authoritative Medusa `promotions.add` gate
// (the D1 fail-closed 422 COUPON_REJECTED). A second, hand-copied transcription in
// the claims layer would be a second source of truth for "is this coupon usable",
// and the two would drift the first time an owner changed a campaign rule — the
// customer being told in chat that a code works and then watching it die at
// checkout. There is now exactly ONE transcription, and both callers read it.
//
// PURE BY CONSTRUCTION — this module performs NO IO and reads NO clock. The
// caller supplies the record (whatever it read) and `nowMs`, so the predicate is
// a total function of its arguments and both callers can be tested without a
// network. The ONE store path is named here too ({@link promotionByCodePath}) so
// the two callers cannot query different endpoints; each caller still issues the
// request through its OWN already-wired transport (the route's `medusaAdmin`
// re-export shim, the resolver's `@ibatexas/tools` import), so no test mock seam
// moves and no NEW store path is introduced.
//
// WHAT THIS PREDICATE IS NOT: it is TWO-valued (usable / not usable) over a
// record the caller ALREADY read successfully. "The lookup failed" is a THIRD
// state that belongs to the caller, and the two callers resolve it DIFFERENTLY
// and correctly: the display route collapses it to `valid: false` (a UI that
// shows no discount), while the claims resolver degrades it to an honest
// epistemic UNKNOWN (Inv 7 — "could not check" is never "not valid"). Folding
// that collapse in here would have silently imported the display fail-closed into
// the claims runtime, which is exactly the confident-wrong-answer this repo
// forbids.
//
//   (b) the code EXTRACTOR is needed by BOTH `required-claim-decomposer.ts` (the
//       span net — "cupom BEMVINDO15?" with no validity word is still a validity
//       question) and `coupon-validity-resolver.ts` (which looks the code up).
//       The decomposer is imported by the render adapter and by most of the
//       claims layer, so it must stay IO-FREE: importing the resolver (which
//       pulls `@ibatexas/tools`, hence the Medusa transport) into that graph
//       would drag a network client into every module that merely classifies a
//       span. Housing the pure extractor here keeps ONE definition with ZERO
//       graph cost.

/**
 * The subset of the Medusa v2 admin promotion record these rejection classes
 * read. Transcribed from the fields Medusa's `defaultAdminPromotionFields`
 * already returns for `GET /admin/promotions` (status, limit, used, `*campaign`,
 * `*campaign.budget`, `*application_method`) — so ONE GET with no `fields=`
 * parameter carries everything below.
 *
 * NOTE (Medusa v2): `status` is the real lifecycle flag. The v1-era
 * `is_disabled` field does NOT exist in v2 — a check against it passes
 * vacuously, which is the dead check BKL-070 removed.
 */
export interface PromotionRecord {
  readonly id?: string;
  readonly code?: string;
  readonly status?: "draft" | "active" | "inactive";
  readonly limit?: number | null;
  readonly used?: number;
  readonly campaign?: {
    readonly starts_at?: string | null;
    readonly ends_at?: string | null;
    readonly budget?: {
      readonly type?: "spend" | "usage" | "use_by_attribute" | "spend_by_attribute";
      readonly limit?: number | null;
      readonly used?: number;
    } | null;
  } | null;
  readonly application_method?: {
    readonly value?: number;
    readonly type?: string;
    readonly currency_code?: string | null;
  };
}

/** The admin list response shape `GET /admin/promotions?code=…` returns. */
export interface PromotionListResponse {
  readonly promotions?: readonly PromotionRecord[];
}

/**
 * The ONE store path either caller may use to look a promotion up BY CODE.
 * `limit=1` because the code filter is exact — at most one row can match.
 * No `fields=` parameter: the default admin promotion fields already carry every
 * field {@link evaluatePromotionRecord} reads (see {@link PromotionRecord}).
 * Pure.
 */
export function promotionByCodePath(code: string): string {
  return `/admin/promotions?code=${encodeURIComponent(code)}&limit=1`;
}

/**
 * WHY a promotion is not usable — a closed vocabulary, so a caller can log or
 * branch on the reason without re-deriving it. Every member is a POSITIVE
 * determination read off a record (or off a successful empty result), never a
 * read failure: a failed lookup produces no `PromotionRejection` at all.
 */
export type PromotionRejection =
  /** The successful lookup returned NO promotion for this code — the code does not exist. */
  | "absent"
  /** `status` is `draft`/`inactive` (or absent, which we refuse to assume is active). */
  | "not_active"
  /** The campaign has a `starts_at` in the future. */
  | "not_started"
  /** The campaign has an `ends_at` in the past. */
  | "ended"
  /** The promotion's own `used` has reached its `limit`. */
  | "promotion_budget_exhausted"
  /** The campaign's globally-evaluable (`usage`/`spend`) budget is exhausted. */
  | "campaign_budget_exhausted";

/** The two-valued outcome of {@link evaluatePromotionRecord}. */
export type PromotionValidity =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: PromotionRejection };

/**
 * Is this promotion record usable RIGHT NOW? PURE — a total function of
 * `(promo, nowMs)`; no clock, no IO.
 *
 * `undefined` (a successful lookup that matched nothing) is `absent`: the code
 * does not exist, which is a FACT about the store's promotions, not an absence of
 * knowledge — so callers may state it. A lookup that THREW never reaches here.
 *
 * DELIBERATELY NOT EVALUATED (only Medusa's own engine can decide them; the
 * checkout's 422 stays authoritative): target/buy rules, stackability, and the
 * PER-ATTRIBUTE budget types (`use_by_attribute` / `spend_by_attribute`), which
 * need the customer attribute — evaluating them here would OVER-REJECT a code
 * that actually works.
 */
export function evaluatePromotionRecord(
  promo: PromotionRecord | undefined,
  nowMs: number,
): PromotionValidity {
  if (promo === undefined) return { usable: false, reason: "absent" };

  // The v2 lifecycle flag. Absent (unexpected) ⇒ treat as NOT active — we never
  // assume a promotion is live off a field the record did not state.
  if (promo.status !== "active") return { usable: false, reason: "not_active" };

  // Campaign window — a bound is checked ONLY when present (absent ⇒ no bound).
  const startsAt = promo.campaign?.starts_at ? Date.parse(promo.campaign.starts_at) : undefined;
  const endsAt = promo.campaign?.ends_at ? Date.parse(promo.campaign.ends_at) : undefined;
  if (startsAt !== undefined && Number.isFinite(startsAt) && startsAt > nowMs) {
    return { usable: false, reason: "not_started" };
  }
  if (endsAt !== undefined && Number.isFinite(endsAt) && endsAt < nowMs) {
    return { usable: false, reason: "ended" };
  }

  // The promotion's OWN usage budget.
  if (
    typeof promo.limit === "number" &&
    typeof promo.used === "number" &&
    promo.used >= promo.limit
  ) {
    return { usable: false, reason: "promotion_budget_exhausted" };
  }

  // The campaign budget — ONLY the globally-evaluable types (see the header note).
  const budget = promo.campaign?.budget;
  if (
    budget &&
    (budget.type === "usage" || budget.type === "spend") &&
    typeof budget.limit === "number" &&
    typeof budget.used === "number" &&
    budget.used >= budget.limit
  ) {
    return { usable: false, reason: "campaign_budget_exhausted" };
  }

  return { usable: true };
}

// ── Code extraction (deterministic; never a guess) ───────────────────────────

/**
 * pt-BR / coupon-domain words that are CODE-SHAPED only because a customer typed
 * them in capitals ("CUPOM", "VALE", "DESCONTO"). Compared accent-free and
 * upper-cased, so "CÓDIGO" is caught too. Without this set, "CUPOM X1234 VALE?"
 * would yield THREE candidates and dead-end in the needs-code CLARIFY.
 *
 * A real promotion literally named one of these would be unreachable — and the
 * failure is the SAFE direction (the turn asks for the code rather than answering
 * about the wrong thing). Every member is a word that appears in the QUESTION,
 * never a plausible promotion identity.
 */
const COUPON_WORD_STOP_SET: ReadonlySet<string> = new Set([
  "CUPOM", "CUPONS", "CUPAO", "CODIGO", "CODIGOS", "CODE", "VOUCHER",
  "PROMO", "PROMOCAO", "PROMOCOES", "PROMOCIONAL", "DESCONTO", "DESCONTOS",
  "VALE", "VALEM", "VALENDO", "VALIDO", "VALIDA", "VALIDOS", "VALIDAS",
  "VALIDADE", "FUNCIONA", "FUNCIONAM", "AINDA", "ESSE", "ESTE", "ESSA", "ESTA",
  "MEU", "MINHA", "AQUI", "SERVE", "USAR", "APLICA", "APLICAR", "ATIVO", "ATIVA",
  "EXPIROU", "EXPIRADO", "EXPIRADA", "PEDIDO", "ENTREGA", "CARRINHO", "CHECKOUT",
  "SIM", "NAO", "OLA", "BOM", "DIA", "TARDE", "NOITE", "OBRIGADO", "OBRIGADA",
  "PRECISO", "QUERO", "SABER", "TEM", "TEMOS", "VOCES", "CONFERE", "CONFERIR",
]);

/** Accent-free upper-case form, for the stop-set comparison. Pure. */
function foldForStopSet(token: string): string {
  return token
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toUpperCase();
}

/**
 * Is this raw token shaped like a coupon CODE? Length 4-24, alphanumeric only, at
 * least one letter, and EITHER it carries a digit ("BEMVINDO15", "X1234") OR it
 * was typed entirely in capitals ("FRETEGRATIS"). A lowercase, digit-free word is
 * ordinary prose and never a code — which is what keeps "esse cupom ainda vale?"
 * from mining "ainda" as a coupon. Pure.
 */
function isCodeShapedToken(token: string): boolean {
  if (token.length < 4 || token.length > 24) return false;
  if (!/^[A-Za-z0-9]+$/.test(token)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  if (COUPON_WORD_STOP_SET.has(foldForStopSet(token))) return false;
  return /\d/.test(token) || token === token.toUpperCase();
}

/**
 * Extract the ONE coupon code the customer supplied, VERBATIM as typed, or
 * `undefined`. Returns `undefined` when the text carries ZERO or ≥2 DISTINCT
 * code-shaped tokens — with two, there is no non-guessing way to pick one, so the
 * turn asks (the `detectCepInText` discipline, applied to coupons). Pure.
 *
 * Distinctness is judged case-insensitively, so "bemvindo15" and "BEMVINDO15" in
 * one message are ONE candidate, not an ambiguity.
 */
export function detectCouponCodeInText(text: string): string | undefined {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(/[A-Za-z0-9]+/g)) {
    const token = match[0];
    if (!isCodeShapedToken(token)) continue;
    const key = token.toUpperCase();
    if (!seen.has(key)) seen.set(key, token);
  }
  return seen.size === 1 ? [...seen.values()][0] : undefined;
}
