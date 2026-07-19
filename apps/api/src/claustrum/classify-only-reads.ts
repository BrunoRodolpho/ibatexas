// classify-only-reads.ts — FE-T18 (FE-3.0 / D1, manifesto rev 3.1 §2 P7): the
// classify-only grounded-read toggle. Per the adopted D1 direction (see
// IBX_LANGUAGE_ENGINE_SPEC.md FE-3.0), a read-shaped turn's claim TYPE is
// determined DETERMINISTICALLY from the request text — the SAME §O#15 keyword
// classifier `required-claim-decomposer.ts` already uses for completeness —
// and the candidate claim is built directly from the AUTHENTICATED owner-scoped
// context, never from a model-proposed claim body. This retires the
// `propose_claim` MODEL CALL (`ibatexas-planner.ts` `proposeClaims`) for these
// turns; the retained validators (`runClaimsKernel`, @adjudicate/core) and
// templates (`slot-grammar.ts`) are UNCHANGED — this module only changes HOW a
// candidate is FRAMED, never how it is validated or rendered (P5: validators
// implement, the model never authors facts).
//
// TOGGLE (env flag, default OFF — mirrors the ENABLE_CLAIMS_PIPELINE idiom in
// claims-pipeline.ts): `classifyOnlyReadsEnabled()` gates whether the caller
// (`ibatexas-claim-planner.ts`) even calls `classifyOnlyRequiredTypes`. OFF (or
// a turn this module declines) falls through to the EXISTING
// `ibatexas-planner.ts` `proposeClaims` model call, byte-identical to today.
//
// SCOPE (deliberately narrow — a vertical slice, not the full closure table):
// eligible ONLY for the Trustworthiness-Triad OWNER-SCOPED read types this
// ticket proves (ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS, RESERVATION_STATUS —
// FE-T15/17 live-proofs). A turn whose deterministic classification pulls in
// ANY type outside {@link CLASSIFY_ONLY_ELIGIBLE_TYPES} (e.g. PICKUP_Q ⇒
// STORE_OPEN_NOW, or a bare schedule question) is declined WHOLESALE — the
// caller falls through to the model path rather than handling a MIXED turn
// half-deterministically, half not. Growing the eligible set (e.g. to
// STORE_OPEN_NOW) is a conscious follow-up, not a byproduct of this change.
//
// RESIDUAL / KNOWN TRADEOFF — tracked as FE-D12 (owner-ruled: PROCEED, do not
// invent a detector; surfaced, not hidden). The ONLY existing §O#9
// safety-marker channel (`routeSafety`, claim-registry.ts) is sourced
// EXCLUSIVELY from the model's own `propose_claim` self-report
// (`collectSafetyMarkers`, ibatexas-planner.ts) — there is no independent
// safety-marker detector anywhere else in this codebase. A turn this module
// classifies as read-eligible therefore does NOT run that (already-
// probabilistic, SDD §O#8 "bounded input") marker self-report, so a safety
// marker co-occurring with read phrasing in the SAME message cannot escalate
// via §O#9 while classify-only is ON for that turn.
//
// BOUNDED (why this is acceptable as-is): the marker was always the model's
// self-report inside the EXACT call D1 retires — an already-probabilistic
// signal, not a reliable control, so classify-only removes a bounded-input
// check rather than a guaranteed one. The subset-eligibility gate above
// ALREADY sends any MIXED-intent turn (a read span PLUS any ineligible span —
// e.g. a schedule/pickup marker riding alongside a payment question) to the
// model path, so the residual is further bounded to unclassifiable safety
// content riding a PURE read-shaped turn matching ONLY the narrow eligible
// set. The toggle also defaults OFF, and D1 itself is owner-veto-able.
//
// MITIGATIONS CONSIDERED, DEFERRED (FE-D12):
//   - narrower eligibility (e.g. drop to a single type, or require an
//     even-stricter span match) — would shrink the residual's surface but not
//     close it (the model self-report is absent on ANY classify-only turn,
//     regardless of how narrow); deferred as marginal for the cost of
//     shrinking this ticket's proven vertical slice.
//   - an independent, deterministic safety-marker detector (a keyword net
//     parallel to `classifyRequestSpans`) — REJECTED for this ticket: it is
//     new scope beyond what FE-T18 asks, and a hastily-built keyword net for
//     nuanced severity/emergency framing risks a false sense of coverage
//     (worse than an honestly-absent check) — not attempted here.
// This does NOT weaken the OFF path (byte-identical) or any turn shape outside
// the narrow eligible set.

import type { CandidateClaim } from "@adjudicate/core";
import {
  ownerScopedBaseKey,
  selectCandidateClaim,
  type RegistryClaimType,
} from "./claim-registry.js";
import type { ClaimAuthContext } from "./ibatexas-planner.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "./required-claim-decomposer.js";

/** Env flag gating the classify-only read path (default OFF). */
export const CLASSIFY_ONLY_READS_ENABLED_ENV = "ENABLE_CLASSIFY_ONLY_READS";

/** Is the classify-only read path enabled for this boot? Default false (OFF). */
export function classifyOnlyReadsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CLASSIFY_ONLY_READS_ENABLED_ENV] === "true";
}

/**
 * The owner-scoped Trustworthiness-Triad read types this ticket proves
 * (FE-T15 payment/order live-proof, FE-T17 reservation live-proof). See the
 * module header SCOPE note — deliberately narrow, extend as a conscious act.
 */
export const CLASSIFY_ONLY_ELIGIBLE_TYPES: ReadonlySet<RegistryClaimType> =
  new Set<RegistryClaimType>([
    "ORDER_FULFILLMENT_STAGE",
    "PAYMENT_STATUS",
    "RESERVATION_STATUS",
    // BKL-139 — the owner-scoped cart read joins the eligible set (the deliberate,
    // conscious growth the module header calls out). Its subject is the authenticated
    // customerId, resolved by buildClassifyOnlyCandidates from the present
    // `cart_contents:{customerId}` owner-scoped read (ownerScopedBaseKey → "cart_contents").
    // NOTE (FE-D12): every eligible-set addition widens the classify-only no-safety-marker
    // residual (a pure cart-read turn skips the model's §O#9 self-report). A cart question
    // co-occurring with an unclassifiable safety marker in the SAME message would not
    // ESCALATE via that channel while classify-only is ON — surfaced, owner-veto-able.
    "CART_CONTENTS",
    // BKL-163 — CART_EMPTY joins in LOCKSTEP with CART_CONTENTS: the CART_CONTENTS_Q
    // closure row now requires BOTH (the provable-empty complement), and
    // classifyOnlyRequiredTypes declines WHOLESALE when any required type is outside
    // this set — omitting CART_EMPTY here would silently disable the classify-only
    // path for every cart question. Subject resolves from the present
    // `cart_empty:{customerId}` owner-scoped read (ownerScopedBaseKey → "cart_empty");
    // a cart WITH items leaves it absent → empty subject → honest UNKNOWN → dropped
    // when CART_CONTENTS validates. FE-D12 residual unchanged in KIND (the cart span
    // already skipped the model's §O#9 self-report; this adds no new span).
    "CART_EMPTY",
    // FE-D03 slice C — the owner-scoped list/history reads join the eligible set (the
    // same conscious growth). Subject = the authenticated customerId, resolved from the
    // present order_history:/payment_history:{customerId} owner-scoped read
    // (ownerScopedBaseKey → "order_history"/"payment_history"). FE-D12 residual grows
    // identically: a pure history-read turn skips the model's §O#9 self-report — a
    // history question co-occurring with an unclassifiable safety marker would not
    // ESCALATE via that channel while classify-only is ON (surfaced, owner-veto-able).
    "ORDER_HISTORY",
    "PAYMENT_HISTORY",
  ]);

/**
 * DETERMINISTICALLY classify `text` into the §O#15 required-claim-type set (the
 * SAME `classifyRequestSpans` → `decomposeRequiredClaims` chain
 * `ibatexas-claim-planner.ts` already runs for the BKL-110 completeness check),
 * and decide whether THIS turn is classify-only ELIGIBLE:
 *
 *   - the required set is EMPTY (no read span matched) → `undefined` (not a
 *     read-shaped turn; the caller falls through to the model path);
 *   - the required set contains any type OUTSIDE
 *     {@link CLASSIFY_ONLY_ELIGIBLE_TYPES} (e.g. a schedule/pickup question) →
 *     `undefined` (decline WHOLESALE rather than handle a mixed turn
 *     half-deterministically, half not);
 *   - otherwise → the required set (a non-empty subset of the eligible types).
 *
 * Pure.
 */
export function classifyOnlyRequiredTypes(
  text: string,
): ReadonlySet<RegistryClaimType> | undefined {
  const required = decomposeRequiredClaims(classifyRequestSpans(text));
  if (required.size === 0) return undefined;
  for (const type of required) {
    if (!CLASSIFY_ONLY_ELIGIBLE_TYPES.has(type)) return undefined;
  }
  return required;
}

/**
 * Build the deterministic candidate claims for a classify-only-eligible
 * required set — the classify-only REPLACEMENT for the model's
 * `propose_claim` tool call. Mirrors `ibatexas-planner.ts`'s FIX 1 (actor) +
 * FIX 2 (subject) resolution EXACTLY, minus the "honor the model's subject if
 * it happens to name an owned resource" branch — there is no model subject
 * here, so that branch is vacuous by construction, not omitted behavior:
 *
 *   - actor: the AUTHENTICATED principal (never model/session output — FIX 1).
 *   - subject: resolved ONLY from `auth.ownedByBaseKey` (FIX 2) — exactly ONE
 *     owned relevant resource → bind it; ZERO owned → an empty subject (the
 *     kernel's owner-scoped `owns`/present(e) check then REFUSES/ABSTAINs —
 *     the SAME honest-abstain shape FE-T17's falsifier arm proved: a claim
 *     PROPOSED then explicitly DROPPED, never a silent `prose_preserved`
 *     collapse); ≥2 owned → no unambiguous resolution, so this type's
 *     candidate is DROPPED and `forcedTerminal: "CLARIFY"` is returned —
 *     never a guess, identical to FIX 2's ambiguous branch.
 *   - value: `undefined` — the caller's existing `bindValueFromLedger` binds it
 *     from the SAME first-party ledger read, unchanged.
 *
 * Pure.
 */
export function buildClassifyOnlyCandidates(
  required: ReadonlySet<RegistryClaimType>,
  auth: ClaimAuthContext,
  sessionId: string,
): { candidates: CandidateClaim[]; forcedTerminal?: "CLARIFY" } {
  const authPrincipal =
    auth.customerId !== undefined && auth.customerId.trim() !== ""
      ? auth.customerId
      : "unauthenticated";
  const actor = { principal: authPrincipal, sessionId };

  const candidates: CandidateClaim[] = [];
  let ambiguous = false;
  for (const type of required) {
    const baseKey = ownerScopedBaseKey(type);
    // Every CLASSIFY_ONLY_ELIGIBLE_TYPES member is owner-scoped/per-resource
    // (ORDER_FULFILLMENT_STAGE / PAYMENT_STATUS / RESERVATION_STATUS all
    // declare `perResourceKey: true` — claim-registry.ts REGISTRY_SPECS), so
    // `baseKey` is defined by construction; the `[]` fallback is defense-in-
    // depth against a future eligible-set edit that adds a public type.
    const owned = baseKey === undefined ? [] : (auth.ownedByBaseKey?.get(baseKey) ?? []);
    let subject: string;
    if (owned.length === 1) {
      subject = owned[0] as string;
    } else if (owned.length > 1) {
      ambiguous = true;
      continue;
    } else {
      subject = "";
    }
    const candidate = selectCandidateClaim({ type, subject, actor, value: undefined });
    // `selectCandidateClaim` returns undefined only for an out-of-registry
    // type; every CLASSIFY_ONLY_ELIGIBLE_TYPES member IS registered, so this
    // always yields a candidate — the guard is defense-in-depth.
    if (candidate !== undefined) candidates.push(candidate);
  }
  return ambiguous ? { candidates, forcedTerminal: "CLARIFY" } : { candidates };
}
