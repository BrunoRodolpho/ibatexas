/**
 * The CLAIM-REGISTRY-AWARE constrained-generation seam (SDD §H · §P3 · §P4 ·
 * §O#9; v1.1 §8; claim-registry v0.1 §1). This is the ibatexas half of SDD §Q.6
 * — the claim-aware planner port's deterministic walls — kept OUT of the
 * model-call body of `ibatexas-planner.ts` so each wall is a small, pure,
 * independently-testable function (the §H "planner is bounded, not trusted"
 * shape: the model proposes; these deterministic checks dispose).
 *
 * The planner SELECTS-and-PARAMETERIZES claim types from a closed REGISTRY enum
 * (claim-registry v0.1 §1: "the Claim Planner is constrained to the registry
 * enum, selects-and-parameterizes, never free-generates"). The three walls,
 * mirroring the EXISTING `allowedIntents` enum guard in the planner:
 *
 *   1. PRE-planning (§H/§P3 — constrained generation): `selectCandidateClaim`
 *      builds a typed `@adjudicate/core` `CandidateClaim` ONLY for a registry
 *      type. A model-proposed type outside the enum is DROPPED (defense in
 *      depth — exactly like a hallucinated `express_intent.capability`). The
 *      planner can never free-generate a claim type.
 *   2. POST-planning (§P4/Inv 8 — completeness): `checkCompleteness` maps every
 *      interrogative/imperative span of the request to a claim, `UNKNOWN`,
 *      `ESCALATE`, or `CLARIFY`. An UNMAPPED span → `CLARIFY` (SDD §J.8: "no
 *      silent drop"), never dropped.
 *   3. SAFETY routing (§O#9/Inv 8): `routeSafety` sends ANY flagged
 *      health/safety marker to `ESCALATE` (the generic safe terminal) —
 *      unconditional on what the marker says, which is strictly stronger than
 *      §O#9's "default-to-safe on an UNRECOGNIZED marker". `harassment` /
 *      `medical-emergency` have NO typed non-escalate terminal, and neither
 *      does anything else. It NEVER passes a safety framing through as
 *      ordinary text.
 *
 * SCOPE (SDD §Q scope guard): this proves the MACHINERY + the two deterministic
 * walls + §O#9 with a REPRESENTATIVE typed claim-type set. The full 37-row
 * registry population (registry §6) is the deferred follow-on — do NOT read
 * this representative set as the complete vocabulary.
 *
 * Consumes the LINKED `@adjudicate/core` (1.5.0) `CandidateClaim` /
 * `EvidenceRequirement` / `TurnTerminal` shapes verbatim — NOT a stub — so the
 * produced candidates are exactly what the claustrum CLAIMS-VALIDATE stage's
 * `runClaimsKernel` (Q6a/Q5) consumes downstream (SDD §F topology:
 * Read+Action → Ledger → Claims → Renderer). Pure: no clock/RNG/IO; the
 * `now`/ledger/soundness `deps` the kernel needs are injected DOWNSTREAM, not
 * here. No kernel-downstream import (SDD §R: adjudicate → claustrum → ibatexas,
 * never backward).
 */

import type {
  CandidateClaim,
  EvidenceRequirement,
  TurnTerminal,
} from "@adjudicate/core";
// inv.18 v2 — these registry specs are GENERATED from their ClaimDefinition sources by
// the claimdef-compiler (./claimdefs/*.generated.ts — DO NOT EDIT). Each handwritten
// stanza (~30 / ~57 / ~32 lines) collapsed into one import; the runtime got SMALLER for
// these types and can no longer drift from the slot grammar / closure.
// R2-S1 adopted STORE_HOURS + STORE_INFO on the STORE_OPEN_NOW precedent: all three are
// PUBLIC and FIXED-SUBJECT. R2-S2 then WIDENED the schema repo-locally
// (`./claimdefs/per-resource-claim.ts`) so a `:{subject}`-parameterized type can compile
// too, and adopted MENU_ITEM_PRICE as the proof — its generated row carries
// `perResourceKey: true` beside UNSUFFIXED base keys, which is what `selectCandidateClaim`
// below requires (it does the suffixing). R2-S3 adopted the price type's two PUBLIC
// per-item siblings — MENU_ITEM_CONTENTS and MENU_DIETARY — through that same widening,
// with no further schema change. R2-S4 through R2-S7 then adopted the seven OWNER-scoped
// parameterized types, whose `ownershipPolicy: "required"` rows survive the published
// projection BY REFERENCE (no second widening). R2-S8 closes the set with
// STORE_HOURS_FOR_DATE, the one whose span class is a COMPOSED predicate rather than a flat
// marker alternation: the `scheduleContext` conjunct became the generated marker net and
// the `dateAnchor` conjunct stayed a hand-written GUARD, so no span-net restructure was
// needed after all. EVERY `perResourceKey` type in this object compiles from a source.
//
// R2-S9 then closed the FIXED-SUBJECT remainder — the three presence-complement pairs
// (DELIVERY_COVERAGE/NO_COVERAGE, COUPON_VALID/INVALID, MENU_PAIRINGS/SUBSTITUTIONS),
// MENU_OVERVIEW and MENU_ITEM_ALLERGENS — through the PUBLISHED `compileClaimDefinition`
// (the R2-S1 path; none of them is parameterized, so R2-S2's wrapper is not involved).
// EXACTLY ONE row in this object is still hand-written, and it is a RULING rather than a
// remainder — see the PURCHASE_COMPLETED note at the end of REGISTRY_SPECS. The census is
// pinned as 22 GENERATED + 1 DOCUMENTED EXCLUSION = 23 in
// `./claimdefs/__tests__/generated-drift.test.ts`, so a future type addition must declare
// itself as one or the other instead of quietly becoming a second hand-written row.
import { CART_CONTENTS_REGISTRY_SPEC } from "./claimdefs/cart-contents.generated.js";
import { CART_EMPTY_REGISTRY_SPEC } from "./claimdefs/cart-empty.generated.js";
import { COUPON_INVALID_REGISTRY_SPEC } from "./claimdefs/coupon-invalid.generated.js";
import { COUPON_VALID_REGISTRY_SPEC } from "./claimdefs/coupon-valid.generated.js";
import { DELIVERY_COVERAGE_REGISTRY_SPEC } from "./claimdefs/delivery-coverage.generated.js";
import { DELIVERY_NO_COVERAGE_REGISTRY_SPEC } from "./claimdefs/delivery-no-coverage.generated.js";
import { MENU_DIETARY_REGISTRY_SPEC } from "./claimdefs/menu-dietary.generated.js";
import { MENU_ITEM_ALLERGENS_REGISTRY_SPEC } from "./claimdefs/menu-item-allergens.generated.js";
import { MENU_ITEM_CONTENTS_REGISTRY_SPEC } from "./claimdefs/menu-item-contents.generated.js";
import { MENU_ITEM_PRICE_REGISTRY_SPEC } from "./claimdefs/menu-item-price.generated.js";
import { MENU_OVERVIEW_REGISTRY_SPEC } from "./claimdefs/menu-overview.generated.js";
import { MENU_PAIRINGS_REGISTRY_SPEC } from "./claimdefs/menu-pairings.generated.js";
import { MENU_SUBSTITUTIONS_REGISTRY_SPEC } from "./claimdefs/menu-substitutions.generated.js";
import { ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC } from "./claimdefs/order-fulfillment-stage.generated.js";
import { ORDER_HISTORY_REGISTRY_SPEC } from "./claimdefs/order-history.generated.js";
import { PAYMENT_HISTORY_REGISTRY_SPEC } from "./claimdefs/payment-history.generated.js";
import { PAYMENT_STATUS_REGISTRY_SPEC } from "./claimdefs/payment-status.generated.js";
import { RESERVATION_STATUS_REGISTRY_SPEC } from "./claimdefs/reservation-status.generated.js";
import { STORE_HOURS_FOR_DATE_REGISTRY_SPEC } from "./claimdefs/store-hours-for-date.generated.js";
import { STORE_HOURS_REGISTRY_SPEC } from "./claimdefs/store-hours.generated.js";
import { STORE_INFO_REGISTRY_SPEC } from "./claimdefs/store-info.generated.js";
import { STORE_OPEN_NOW_REGISTRY_SPEC } from "./claimdefs/store-open-now.generated.js";

/**
 * The REGISTRY enum — the closed, representative set of claim TYPE names the
 * planner may select (claim-registry v0.1 §1; SDD §K "nothing outside the
 * registry may be asserted"). UPPER_CASE registry type names (the registry
 * namespace — distinct from the lowercase `SUCCESS_CLAIM_CLASSES` guard ids;
 * SDD §K "map, do not equate"). REPRESENTATIVE, not the full 37-row vocabulary
 * (SDD §Q scope guard) — one type per claim posture the walls must exercise:
 *
 *   - `MENU_ITEM_ALLERGENS` — a public, safety-critical INFORM read
 *     (floor `structured`; a free-text "sem alérgenos" must FAIL → UNKNOWN —
 *     SDD §E worked types).
 *   - `STORE_HOURS`         — a public, cacheable INFORM read (TODAY's hours).
 *   - `STORE_HOURS_FOR_DATE` — the DAY-SPECIFIC public hours read (BKL-138): the
 *     per-date twin of STORE_HOURS, `perResourceKey`-keyed by the QUERIED ISO date
 *     so a named-weekday / "amanhã" question is answered off the exact day, with a
 *     holiday/override ON that date as its honest W6 falsifiers (today's exception
 *     can never poison a future-date answer — the keys are date-suffixed).
 *   - `STORE_OPEN_NOW`      — the OVERRIDE-AWARE "is it open right now" read
 *     (public; W6-falsified by a present ScheduleOverride — Triad slice).
 *   - `ORDER_FULFILLMENT_STAGE` — a customer-scoped, live STATUS read
 *     (owner-scoped, `must_read_this_turn` — SDD §E / §N P1). NOT full Triad
 *     coverage yet: it degrades SAFE to UNKNOWN until per-resource ORDER key
 *     namespacing + F3 per-turn `owns` (the conductor refactor) land; the
 *     falsifier/valueBinding below are the kernel-side wiring, not end-to-end
 *     activation.
 *   - `PAYMENT_STATUS`      — a customer-scoped, live, first-party money read
 *     (ownership required, `first_party_only` — SDD §E / §N P0). Same caveat:
 *     degrades SAFE to UNKNOWN pending per-resource PAYMENT key namespacing +
 *     F3 per-turn `owns`; the rows below declare the predicate, they do not by
 *     themselves prove a VALIDATED render fires this turn.
 *   - `RESERVATION_STATUS` — a customer-scoped, live, first-party reservation
 *     read (FE-T17; ownership required, `must_read_this_turn`). Owner-scoped +
 *     per-resource like ORDER_FULFILLMENT_STAGE: keyed `reservation_status:{id}`
 *     (the investigator's `RESERVATION_KEY`, already wired), falsified by a
 *     present `reservation_cancelled` fact (the same defense-in-depth staleness
 *     shape as ORDER_FULFILLMENT_STAGE's `order_cancelled`).
 *   - `PURCHASE_COMPLETED`  — an ACTION claim (`action_outcome`; does NOT imply
 *     settlement — SDD §E / §K Cluster F).
 *
 * The membership tuple is the single source of truth; `isRegistryClaimType`
 * narrows an `unknown` against it (mirrors the `decision.ts`/`verdict.ts` idiom).
 */
export const CLAIM_REGISTRY = [
  "MENU_ITEM_ALLERGENS",
  "STORE_HOURS",
  "STORE_HOURS_FOR_DATE",
  "STORE_OPEN_NOW",
  "ORDER_FULFILLMENT_STAGE",
  "PAYMENT_STATUS",
  "RESERVATION_STATUS",
  // BKL-139 / FE-D03 — the owner-scoped IN-PROGRESS CART read ("o que tem no meu
  // carrinho?"). Owner-scoped + per-resource like RESERVATION_STATUS, but its C6
  // proposition is a DETERMINISTICALLY PRE-COMPOSED summary scalar (itemsSummaryText,
  // "2x Costela — total R$123,00") — the STORE_HOURS_FOR_DATE `hoursText` precedent for
  // rendering a list-shaped read as ONE C6 field under the frozen single-scalar kernel.
  // The money in that string is composed in code from INTEGER CENTAVOS (Hard Rule 2),
  // NEVER model-authored (FE-D04 / BKL-149).
  "CART_CONTENTS",
  // BKL-163 — the PROVABLY-EMPTY cart twin ("o que tem no meu carrinho?" when the
  // cart has no items). The presence-complement of CART_CONTENTS: the investigator
  // records `cart_empty:{customerId}` PRESENT ONLY when the owner-scoped cart read
  // resolved `hasItems: false` (a provable-empty witness — the FE-T17b marker idiom
  // inverted into a claim-bearing key), so exactly ONE of the pair can ever
  // VALIDATE in a turn. Answers "carrinho vazio" with a friendly VALIDATED render
  // instead of the honest-UNKNOWN degrade (PR #291 deviation (a)) — without
  // weakening soundness: an UNAVAILABLE read still fail-closes (Inv 7), a guest
  // still resolves ABSENT → honest UNKNOWN (the fail-closed ownership ruling).
  "CART_EMPTY",
  // FE-D03 slice C — the owner-scoped LIST/HISTORY reads ("meu histórico de pedidos" /
  // "meus últimos pagamentos"). The plural/list siblings of ORDER_FULFILLMENT_STAGE /
  // PAYMENT_STATUS: instead of a single-subject status they render a
  // DETERMINISTICALLY PRE-COMPOSED, bounded most-recent-N summary scalar
  // (historySummaryText) — the CART_CONTENTS serialized-scalar idiom for a list-shaped
  // read under the frozen single-C6-field kernel (FE-D09). Owner-scoped by the
  // authenticated customerId (order/payment listByCustomer); money composed in code
  // from INTEGER CENTAVOS (Hard Rule 2), NEVER model-authored.
  "ORDER_HISTORY",
  "PAYMENT_HISTORY",
  // BKL-142 — the PUBLIC menu-catalog reads ("quanto custa a costela?" / "o que vem
  // no combo?"). perResourceKey by the RESOLVED product id (the shared
  // menu-item-resolver.ts), ownershipPolicy not_applicable (owned by nobody, like
  // STORE_HOURS_FOR_DATE), C6-bound to a DETERMINISTICALLY PRE-COMPOSED scalar
  // (priceText from integer centavos — Hard Rule 2; contentsText from the first-party
  // description). The dietary-tags twin (MENU_DIETARY_OPTIONS) is DELIBERATELY absent
  // — "sem glúten/lactose" is allergen-adjacent legal territory behind the BKL-143/
  // BKL-123 owner gate. MENU_OVERVIEW (the menu-wide list) is the fixed-subject twin
  // (distinct catalog-LISTING read via the wildcard `searchProducts` path, not the
  // per-item resolver) — public, single-key, like STORE_HOURS.
  "MENU_ITEM_PRICE",
  "MENU_ITEM_CONTENTS",
  "MENU_OVERVIEW",
  // BKL-214 — the PUBLIC dietary-PREFERENCE read ("tem opção vegetariana?"). PUBLIC
  // per-item like MENU_ITEM_PRICE, but the "item" is the dietary TAG (vegetariano/
  // vegano) resolved deterministically from the utterance; C6-bound to a pre-composed
  // pt-BR list of tagged product titles (`dietaryText`). RESTRICTED to pure-preference
  // tags — `sem_gluten`/`sem_lactose` are allergen-adjacent (BKL-143/123 conservative
  // gate) and never reach this claim (they route to the honest-abstain path). A tag is a
  // positive PREFERENCE attribute, NEVER a "não contém X" allergen assurance.
  "MENU_DIETARY",
  // BKL-136 — the PUBLIC store-info read ("onde fica o restaurante?" / "tem
  // estacionamento?"). The STORE_HOURS/MENU_OVERVIEW fixed-subject public shape:
  // single key `store:info`, owned by nobody, C6-bound to a DETERMINISTICALLY
  // pre-composed pt-BR scalar (`infoText`) derived from the OWNER-ATTESTED Medusa
  // `store.metadata.address` / `.parking` (written by the committed seed or the
  // admin — never inferred, never model-authored). Absent/blank metadata → ABSENT
  // evidence → honest UNKNOWN ("can never ground" closes only when data exists).
  "STORE_INFO",
  // LE2-002 / NEW-007 — the PUBLIC delivery-coverage pair ("vocês entregam em
  // Ibaté?" / "entregam no CEP 14815000?"). CUSTOMER-scoped by construction: they
  // live in this enum, so `CUSTOMER_CLAIM_SCOPE` carries them and the ops plane
  // gets them only via its SUPERSET scope (ops-plane delivery answers are LE2-013's
  // job — nothing here wires ops). PUBLIC (`not_applicable` ownership, like
  // STORE_INFO / MENU_OVERVIEW): a delivery ZONE is store policy, owned by nobody.
  //
  // A COMPLEMENTARY PAIR on the CART_CONTENTS/CART_EMPTY precedent (BKL-163): the
  // investigator records `delivery:coverage` PRESENT only when a zone actually
  // matched, and `delivery:no_coverage` PRESENT only when the estimation tool
  // proved the CEP falls OUTSIDE every zone — so exactly ONE of the pair can ever
  // validate in a turn, and the other resolves honest UNKNOWN and is dropped by the
  // kernel's §D filter (never a rendered contradiction). The NEGATIVE is a
  // first-class VALIDATED claim, not an UNKNOWN: a definitive "outside every zone"
  // read off the zone data IS a fact, and answering it with "não localizei essa
  // informação" would be less honest, not more.
  //
  // The third branch — an unrecognised place name with no CEP — is deliberately
  // CLAIMLESS: neither key is recorded, the classify-only path forces CLARIFY, and
  // the turn ASKS for the CEP. There is no "probably covered" claim to make, and
  // nearest-neighbour guessing is exactly what this ticket exists to forbid.
  "DELIVERY_COVERAGE",
  "DELIVERY_NO_COVERAGE",
  // LE2-019 / spec Decision 18 — the COUPON-VALIDITY pair ("o cupom X1234
  // vale?"). CUSTOMER-scoped by construction: they live in this enum, so
  // `CUSTOMER_CLAIM_SCOPE` carries them; the ops plane reaches them only through
  // its SUPERSET scope (nothing here wires ops, and no ops phrasing override is
  // minted — a coupon question is a customer question). PUBLIC
  // (`not_applicable` ownership, like STORE_INFO / DELIVERY_COVERAGE): a
  // promotion is store policy, owned by nobody — the SAME code is valid or not
  // regardless of who asks, so this is deliberately NOT owner-scoped and a guest
  // gets the same honest answer as an authenticated customer.
  //
  // A COMPLEMENTARY PAIR on the DELIVERY_COVERAGE / CART_CONTENTS precedent: the
  // investigator records `coupon:valid` PRESENT only when a SUCCESSFUL promotion
  // lookup found a usable record, and `coupon:invalid` PRESENT only when a
  // SUCCESSFUL lookup positively determined the code is not usable — so exactly
  // ONE of the pair can ever validate in a turn, and the other resolves honest
  // UNKNOWN and is dropped by the kernel's §D filter (never a rendered
  // contradiction). Both are registered in PRESENCE_COMPLEMENT_PAIRS
  // (required-claim-decomposer.ts); omitting that registration is the LE2-002
  // latent defect this ticket refuses to reproduce.
  //
  // WHY A PAIR AND NOT ONE TYPE WITH A VALIDITY FIELD: the two answers carry
  // genuinely DIFFERENT static frames (the positive ends with how to use the
  // code at checkout; the negative ends with an offer to check another one), and
  // under the frozen single-C6-field kernel a single type would have to hide the
  // whole difference inside its one scalar, leaving a template frame that can
  // say nothing true in both branches. That is the same argument the delivery
  // pair made, and it holds identically here.
  //
  // The third branch — coupon phrasing with NO extractable code — is
  // deliberately CLAIMLESS: neither key is recorded, the classify-only path
  // forces CLARIFY, and the turn ASKS for the code. There is no "probably valid"
  // claim to make.
  //
  // DECISION 14 NEGATIVE SPACE: both are `read_claim`s. No coupon APPLY /
  // price-adjustment claim exists, here or anywhere — validity is discoverable
  // WITHOUT attempting an apply, which is the whole point of Decision 18.
  "COUPON_VALID",
  "COUPON_INVALID",
  // LE2-029 — the PAIRING pair ("o que combina com brisket?", "não tem costela,
  // o que peço no lugar?"). CUSTOMER-scoped by construction (they live in this
  // enum, so `CUSTOMER_CLAIM_SCOPE` carries them; the ops plane reaches them only
  // through its SUPERSET scope). PUBLIC (`not_applicable` ownership, like
  // STORE_INFO / COUPON_VALID): what the house serves together is store knowledge
  // owned by nobody — the same answer regardless of who asks — so a guest gets
  // the same grounded suggestion as an authenticated customer.
  //
  // A COMPLEMENTARY PAIR: the resolver classifies the utterance as a pairing ask
  // or a substitution ask and records at most ONE key, so exactly one can ever
  // validate in a turn and the other resolves honest UNKNOWN and is dropped by
  // the kernel's §D filter (never a rendered contradiction). Both are registered
  // in PRESENCE_COMPLEMENT_PAIRS (required-claim-decomposer.ts) in the same
  // commit as their §O#15 closure row — the LE2-002 defect, refused again.
  //
  // WHY A PAIR AND NOT ONE TYPE WITH A RELATION FIELD: the two answers carry
  // genuinely DIFFERENT static frames ("vai bem com" invites an addition, "no
  // lugar" answers an absence), and under the frozen single-C6-field kernel a
  // single type would have to hide the whole difference inside its one scalar,
  // leaving a template frame that can say nothing true in both branches. The same
  // argument the delivery and coupon pairs made.
  //
  // ── THERE IS NO MENU_NO_PAIRINGS, AND THERE MUST NOT BE ────────────────────
  //
  // If you came here looking for the negative twin — the CART_EMPTY to this
  // CART_CONTENTS, the COUPON_INVALID to this COUPON_VALID — it is deliberately
  // absent, and the reason is a property of the DATA rather than a style
  // preference. Adding one would be a regression, so the argument is recorded
  // here rather than in a pull request nobody will find.
  //
  // A validated negative is only sound when the store behind it is COMPLETE.
  // CART_EMPTY is honest because the cart is complete: the system knows every
  // line in it, so "it is empty" is a fact. COUPON_INVALID is honest because a
  // promotion lookup is complete: Medusa holds every promotion that exists, so
  // "no such code" is a fact.
  //
  // `PAIRING_GRAPH` is not complete and never claims to be. It is a hand-authored
  // seed of ten edges (its own header says so), grown one owner review at a time,
  // covering a fraction of the menu. So the absence of an edge carries NO
  // information about the world — it means "nobody has written this down yet",
  // and a MENU_NO_PAIRINGS claim would render as "nothing goes with this", which
  // is an assertion the data cannot support and is usually false. That is Inv 7
  // exactly ("could not check" is a distinct state from "the answer is no"), and
  // ticket 29 states the required behaviour in its own words: "unknown item or
  // empty pairing data → honest unknown".
  //
  // The day this graph becomes complete — a reconciled, exhaustive pairing set
  // the owner attests to — the negative twin becomes sound and this comment is
  // the thing to revisit. Until then the empty case degrades, and the honest
  // UNKNOWN is the whole answer.
  "MENU_PAIRINGS",
  "MENU_SUBSTITUTIONS",
  "PURCHASE_COMPLETED",
] as const;

/** A claim TYPE name the planner may select (a member of {@link CLAIM_REGISTRY}). */
export type RegistryClaimType = (typeof CLAIM_REGISTRY)[number];

/** The closed registry-type set, for O(1) membership in the constrained-gen guard. */
const REGISTRY_SET: ReadonlySet<string> = new Set<string>(CLAIM_REGISTRY);

/**
 * Type guard: is `value` an in-enum registry claim type (SDD §H/§P3 — the
 * constrained-generation membership predicate)? Pure. A `false` here is what
 * DROPS a model-proposed out-of-enum type (defense in depth) — the planner can
 * never free-generate a type past this gate.
 */
export function isRegistryClaimType(value: unknown): value is RegistryClaimType {
  return typeof value === "string" && REGISTRY_SET.has(value);
}

/**
 * CASING-ROBUST canonicalization (fix 3 — RCA 2026-06-29). The local 4B model
 * emits a correctly-CLASSIFIED registry type with NON-CANONICAL casing
 * (`ORDER_fulfillment_stage`, `PAYMENT_status`); the registry members are all
 * UPPER_SNAKE, so a raw exact-case membership check ({@link isRegistryClaimType})
 * DROPPED such a candidate → with the order/stage claim gone the candidate set
 * went empty → the turn fell back to the lie-capable PROSE responder, which
 * FABRICATED. This normalizes case (`raw.toUpperCase()` — registry members are
 * UPPER_SNAKE) BEFORE the membership test, RESCUING a correctly-classified tag
 * from being wrongly dropped into the prose path.
 *
 * Returns the CANONICAL `RegistryClaimType` when `raw` maps to a known type
 * (case-insensitively), else `undefined`. A tag that does NOT match even after
 * canonicalization still returns `undefined` → it is DROPPED by the constrained-
 * generation wall (never free-generated) and the planner's P4/safety routing
 * yields a proposition-free safe terminal (UNKNOWN/CLARIFY/ESCALATE) — NEVER
 * fabricating prose. Pure; no allocation beyond the upper-case string.
 */
export function canonicalizeRegistryType(
  raw: unknown,
): RegistryClaimType | undefined {
  return canonicalizeScopedClaimType(raw) as RegistryClaimType | undefined;
}

/**
 * LE2-012 — the SCOPE-AWARE twin of {@link canonicalizeRegistryType}: the same
 * casing-robust canonicalization, but resolved against a {@link ClaimPlaneScope}
 * instead of the hard-wired customer registry. Defaults to
 * {@link CUSTOMER_CLAIM_SCOPE}, so an unscoped call is byte-identical to the
 * customer behaviour above (the two share this ONE implementation, so they can
 * never drift). Returns the CANONICAL UPPER_SNAKE type name when `raw` maps to a
 * type IN THAT SCOPE, else `undefined` → the proposal is DROPPED by the
 * constrained-generation wall.
 *
 * This is what makes the wall do double duty as the PLANE BOUNDARY: an
 * ops-scoped type is absent from `CUSTOMER_CLAIM_SCOPE`, so a customer-plane
 * proposal of it canonicalizes to `undefined` and is dropped exactly like a
 * hallucinated type. Pure.
 */
export function canonicalizeScopedClaimType(
  raw: unknown,
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const upper = raw.toUpperCase();
  return Object.hasOwn(scope.specs, upper) ? upper : undefined;
}

/**
 * The evidence fields EVERY claim spec carries, read or action (SDD §E worked
 * types): ownership, freshness, source-integrity floor, provenance. Not exported
 * — callers use {@link RegistryClaimSpec}, and the two variants below add the
 * discriminant plus whatever is specific to their kind (BKL-270 split this out of
 * the former single `RegistryClaimSpec` interface so `dietaryPosture` could be
 * REQUIRED on reads without becoming a meaningless optional on actions).
 */
interface ClaimSpecBase {
  /** The C2 source-integrity FLOOR this type's evidence must meet-or-exceed. */
  readonly minSourceIntegrity: EvidenceRequirement["sourceIntegrity"];
  /** The `∀ e ∈ requiredEvidence` set (C0 demands it be non-empty). */
  readonly requiredEvidence: readonly EvidenceRequirement[];
  /** The Q4 consistency partition key derivation: is this claim customer-scoped? */
  readonly customerScoped: boolean;
  /**
   * W6 falsifier-completeness (Plan 1 Phase 3; `@adjudicate/core` >= 1.8.0). When
   * `true`, this type has ENUMERATED every evidence that — if PRESENT this turn —
   * FALSIFIES the claim (the `falsifiers[]`), so the kernel's eligibility cap lets
   * it reach VALIDATED and the runtime arm (`resolveAgainstFalsifiers`) demotes it
   * to UNKNOWN when a falsifier actually fires. A type that cannot HONESTLY
   * enumerate its falsifiers MUST omit this (defaults to `false` → UNKNOWN-only);
   * declaring completeness without real falsifiers is the §R lying case (the kernel
   * hard-throws). Omitted ⟹ the type stays UNKNOWN-only under the pipeline (the
   * fail-safe default the SDD §Q scope guard prescribes for un-upgraded types).
   */
  readonly falsifierComplete?: boolean;
  /**
   * The W6 falsifiers (each an `EvidenceRequirement`): a DIFFERENT key whose
   * PRESENCE this turn contradicts the claim (e.g. STORE_OPEN_NOW ← a present
   * ScheduleOverride; PAYMENT_STATUS=paid ← a present refund/chargeback). Declared
   * iff `falsifierComplete` is `true`.
   */
  readonly falsifiers?: readonly EvidenceRequirement[];
  /**
   * The W6 C6 value-binding: bind the RENDERED `value` to a specific evidence
   * entry's value so the customer-visible number/string is LEDGER-SOURCED, never a
   * model confabulation that rode the surplus channel. `key` MUST be one of
   * {@link requiredEvidence} keys (the kernel hard-throws otherwise); `path`
   * projects the bound field on BOTH sides before the canonical `sameValue`
   * compare. Omitted ⟹ §5 stays value-agnostic for this type (no-op).
   */
  readonly valueBinding?: {
    readonly key: string;
    readonly path?: readonly (string | number)[];
  };
  /**
   * Wall-2 groundwork (Track A on 4B; tag-then-derive plan STEP 3). When `true`,
   * this type's reads are recorded by the investigator under PER-RESOURCE keys
   * (`order_fulfillment_stage:{id}`, `payment_status:{id}` —
   * `ibatexas-investigator.ts`), NOT a plain key. `selectCandidateClaim` therefore
   * PARAMETERIZES this type's `requiredEvidence`/`falsifiers`/`valueBinding` keys
   * by the candidate `subject` (`${baseKey}:${subject}`) so the kernel's
   * `ledger.resolve(key)` finds the actual per-resource entry. STORE_OPEN_NOW (a
   * public, single-key type whose `schedule:store_open_now` matches the
   * investigator verbatim) leaves this OMITTED — its keys are never parameterized.
   *
   * FE-3.3 (FE-T16) — RETIRED CAVEAT: this note used to read "per-resource
   * alignment is necessary-but-not-sufficient for these owner-scoped types to go
   * LIVE; the per-turn `owns` threading is a conductor (`@claustrum/core`)
   * republish (Wall 2, out of scope here); until then ORDER/PAYMENT degrade SAFE
   * to UNKNOWN." That precondition has since LANDED and is WIRED: the REAL
   * per-turn `owns` predicate (`buildPerTurnOwnsFromLedger`,
   * ibatexas-claims-kernel-deps.ts) is threaded as the Conductor's
   * `claimsKernelDepsForTurn` seam by `claims-pipeline.ts` `buildClaimsSeams`
   * whenever the claims pipeline is on — it is NOT the process-wide fail-closed
   * `owns → false` stub. A genuine owner with a PRESENT per-resource read now
   * VALIDATEs and renders (see tracka-fix-actor-subject.test.ts,
   * reservation-status-claim.test.ts). ORDER/PAYMENT/RESERVATION still degrade
   * SAFE to UNKNOWN, but only for the reasons that remain genuinely true: no
   * ownership attribution this turn, a read error, or an absent/mismatched value
   * — never a pending upstream precondition.
   */
  readonly perResourceKey?: boolean;
}

/**
 * BKL-270 — the RATIFIED per-family answer to a DIET-QUALIFIED read ask ("o que
 * combina com brisket QUE SEJA SEM GLÚTEN?", "SOU DIABÉTICO, quanto custa o
 * brownie?"). Owner-signed 2026-07-27 off the Phase-1 posture table; the values
 * are a REVIEWED decision per family, not a heuristic.
 *
 * WHY THIS EXISTS: LE2-029 measured that the BKL-143 forbidden implication can
 * arrive with NO dietary sentence uttered — the customer asks a qualified
 * question, the system answers the UNQUALIFIED part with a grounded fact, and
 * the answer (read as a response to the question actually asked) carries the
 * qualifier's satisfaction. Nothing lied; the customer still reasonably hears an
 * assurance. Before this field the protection was `ALLERGEN_FAMILY_RE` gates
 * HAND-APPLIED per read family, so every NEW family was one omission from a gap.
 *
 *   - `abstain`              — the render NAMES, SELECTS or DESCRIBES food, so a
 *                              restrictive qualifier turns the answer into a
 *                              composition/suitability assertion. The READ is
 *                              suppressed ⇒ UNKNOWN ⇒ the ratified BKL-184
 *                              self-report + staff handoff.
 *   - `answer-anyway`        — the render is a clock window, an address, a
 *                              delivery zone, a money state, a status enum or a
 *                              count. Under even the most restrictive reading it
 *                              asserts nothing about food, and abstaining would
 *                              cost real helpfulness for no safety gain.
 *   - `answer-with-abstention` — the render is the customer's OWN prior act, so
 *                              the FACT is theirs to have, but the dietary FILTER
 *                              is not ours to answer. The read runs and renders,
 *                              AND the abstain + handoff sentence is appended.
 *                              `CART_CONTENTS` only (owner ruling 2026-07-27).
 *
 * THE ANSWER-ANYWAY SET IS SAFE ONLY AS A SET (the containment argument): every
 * family that could convert a logistics answer into a FOOD decision is in the
 * abstain set, so a customer cannot get from "we deliver to your CEP" to eating
 * something unsafe without asking a MENU_* or CART_CONTENTS question — all of
 * which abstain. Flipping any `abstain` row to `answer-anyway` OPENS that ring and
 * answer-anyway rows must be re-argued; they are not independent.
 *
 * NOT PER-QUALIFIER, DELIBERATELY: the abstain trigger is the system's inability
 * to ATTEST a composition fact, and that inability is identical across allergy /
 * diabetes / celiac — the catalog stores an owner-attested allergens array (which
 * BKL-143 ruled INSUFFICIENT to license a render) and stores nothing at all about
 * sugar. A per-qualifier axis would produce 22 rows with identical columns. It
 * becomes necessary the day an owner-attested nutrition field lands for ONE class
 * and not another; until that data exists the split has no referent.
 */
export type DietaryPosture = "abstain" | "answer-anyway" | "answer-with-abstention";

/**
 * A READ claim spec. `dietaryPosture` is REQUIRED and non-optional, so a new read
 * family that forgets to declare one is a COMPILE ERROR — there is no state in
 * which an undeclared read family can boot, and therefore no migration window
 * (the BKL-270 omission class, closed structurally rather than by review).
 */
export interface ReadClaimSpec extends ClaimSpecBase {
  /** The §5 claim kind — drives C4 (`action_claim` ⟹ outcome-confirmed). */
  readonly kind: "read_claim";
  /** BKL-270 — the ratified answer to a diet-qualified ask. See {@link DietaryPosture}. */
  readonly dietaryPosture: DietaryPosture;
}

/**
 * An ACTION claim spec. Carries NO `dietaryPosture`: the field answers "what do we
 * do when someone asks this READ with a dietary qualifier", and an action claim is
 * not a read — there is no grounded fact to withhold. Declaring one here would be
 * a field nobody consumes, i.e. exactly the kind of decorative declaration that
 * rots. The union makes that unrepresentable rather than merely discouraged.
 */
export interface ActionClaimSpec extends ClaimSpecBase {
  /** The §5 claim kind — drives C4 (`action_claim` ⟹ outcome-confirmed). */
  readonly kind: "action_claim";
}

/**
 * The per-registry-type evidence + claim SCHEMA the planner parameterizes into a
 * `CandidateClaim.soundness` (`MinimalClaim`). Transcribed from the SDD §E worked
 * types (the §5 conjuncts each field feeds): ownership, freshness,
 * source-integrity floor, provenance, and (for actions) the `action_claim`
 * kind. The planner only SELECTS the type + binds runtime params (subject,
 * resources, value); the evidence SHAPE is fixed here — the model never authors
 * it (SDD §O#3 "no model-authored …"; the soundness predicate quantifies over
 * THIS typed structure, never prose — §R topology condition 2).
 */
export type RegistryClaimSpec = ReadClaimSpec | ActionClaimSpec;

/**
 * BKL-270 — a read spec MINUS its posture: exactly what the claimdef compiler can
 * honestly produce.
 *
 * `compileClaimDefinition` lives in the published `@adjudicate/core` and projects a
 * `.claim.ts` source into a registry-spec row. It has no concept of
 * `dietaryPosture`, so a generated row CANNOT carry one, and making the generated
 * file assert the full {@link ReadClaimSpec} would be a lie the compiler cannot
 * honour. The generated module therefore satisfies THIS type, and the posture — a
 * ratified OWNER decision, not a mechanical projection — is spliced in at the
 * `REGISTRY_SPECS` site where a human reviews it beside its siblings.
 *
 * The split is the honest one: the compiler owns the evidence shape, the owner owns
 * the posture, and neither can silently supply the other's half.
 */
export type GeneratedReadClaimSpec = Omit<ReadClaimSpec, "dietaryPosture">;

/**
 * The representative per-type registry schema (SDD §E worked types). Keyed by
 * the closed {@link RegistryClaimType}, so adding a type without its schema is a
 * compile error (`satisfies Record<RegistryClaimType, …>`) — the registry and
 * its evidence schema can never silently diverge.
 */
export const REGISTRY_SPECS = {
  // inv.18 v2 / R2-S9 — MENU_ITEM_ALLERGENS is now GENERATED from its ClaimDefinition
  // source (`./claimdefs/menu-item-allergens.generated.ts`, compiled from
  // `menu-item-allergens.claim.ts`). The registry's SMALLEST adoption and the one R2-S1
  // rejected as proving nothing: no falsifiers, no valueBinding, no render, no closure —
  // so what its compile exercises is that the folds are TOTAL over the degenerate case.
  // It is here because the census demands it (a type left hand-written because its
  // adoption is unexciting is exactly the residue `22 + 1 = 23` cannot tolerate). The SDD
  // §E floor rationale — free-text "sem alérgenos" must FAIL the C2 conjunct — moved
  // verbatim into that source, along with the reason each absent facet is absent.
  // BKL-270 — the posture is SPLICED here for the same reason as on its siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`. `abstain` is
  // DOCUMENTATION with zero behaviour change: this type has NO VALIDATED_TEMPLATES entry
  // (slot-grammar.ts), so a validated claim already falls to the template-undefined branch
  // and abstains unconditionally. The declaration makes BKL-123's ratification LEGIBLE
  // here, so a future author who adds a template trips a contradiction instead of silently
  // un-ratifying a closed owner decision.
  MENU_ITEM_ALLERGENS: {
    ...MENU_ITEM_ALLERGENS_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // BKL-121 — the full STORE_HOURS validated render chain, now GENERATED from its
  // ClaimDefinition source (inv.18 v2 / R2-S1). The evidence key + W6 falsifier pair +
  // C6 value-binding all come from `./claimdefs/store-hours.generated.ts`, compiled
  // from the single `store-hours.claim.ts` source (which carries the moved BKL-125 ttl
  // UNITS pin and the falsifier-completeness rationale). This one line REPLACES the
  // ~57-line handwritten stanza and can never drift from the template, which is
  // generated too.
  // BKL-270 — the posture is SPLICED here for the same reason it is on STORE_OPEN_NOW:
  // `compileClaimDefinition` lives in the published @adjudicate/core with no concept of
  // `dietaryPosture`, so it cannot emit the field, and splicing keeps the generated
  // file byte-pure under its source-checksum drift guard. Renders a CLOCK WINDOW
  // (hoursText, "11h-15h / 18h-23h"). The canonical arguably-safe case: a restrictive
  // reading ("o horario pra quem come sem lactose") is strained past plausibility, and
  // refusing to tell a diabetic when the restaurant opens is a pure loss with no safety
  // gain.
  STORE_HOURS: {
    ...STORE_HOURS_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S8 — the DAY-SPECIFIC hours claim (BKL-138, SCN-002/003) is now
  // GENERATED from its ClaimDefinition source (`./claimdefs/store-hours-for-date.generated.ts`,
  // compiled from `store-hours-for-date.claim.ts`). The EIGHTH parameterized type and the
  // LAST one — every `perResourceKey` row in this object now compiles from a source. Its
  // ~57-line handwritten stanza collapses into this spread, and the SCN-003 rationale (the
  // falsifiers re-read the QUERIED date, so today's holiday can never poison a future-date
  // answer — the keys are date-suffixed in lockstep by `parameterizeKeysBySubject`) moved
  // verbatim into that source's header.
  //
  // PUBLIC per-date, so `ownerScopedBaseKey` stays undefined and `publicPerItemBaseKey`
  // still resolves `schedule:store_hours` off the GENERATED spec exactly as it did off this
  // stanza — which is what keeps BKL-289's `deriveUnionSubject` classifying this type into
  // its PUBLIC PER-ITEM branch and reading the `{date}` subject off the ledger.
  //
  // BKL-270 — the posture is SPLICED here rather than declared in the source, for the
  // STORE_OPEN_NOW reason: the generated spec is @generated under a source-checksum drift
  // guard and `compileClaimDefinition` (published @adjudicate/core) has no concept of
  // `dietaryPosture`. `answer-anyway`: the date-keyed twin of STORE_HOURS — same schedule
  // source, same clock-window content, same argument. (Never driven by the audit; reasoned
  // from the render fact.)
  STORE_HOURS_FOR_DATE: {
    ...STORE_HOURS_FOR_DATE_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // Triad slice — STORE_OPEN_NOW is now GENERATED from its ClaimDefinition source
  // (inv.18 v2). The override-aware evidence + W6 falsifier + C6 value-binding all
  // come from `./claimdefs/store-open-now.generated.ts`, compiled from the single
  // `store-open-now.claim.ts` source. This one line REPLACES the ~30-line handwritten
  // stanza (and can never drift from the template / closure, which are generated too).
  // BKL-270 — the posture is SPLICED here rather than declared in the .claim.ts
  // source, and that is deliberate: this spec is @generated under a
  // source-checksum drift guard, and `compileClaimDefinition` lives in the
  // published @adjudicate/core with no concept of `dietaryPosture`, so it cannot
  // emit the field. Splicing keeps the generated file byte-pure and its checksum
  // intact while still satisfying the required-field union. `answer-anyway`: the
  // render is a CLOSED 3-MEMBER enum (almoco|jantar|fechado) — three time-of-day
  // words cannot carry a dietary proposition under any reading.
  STORE_OPEN_NOW: {
    ...STORE_OPEN_NOW_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S7 — the STATUS SIBLINGS are now GENERATED from their ClaimDefinition
  // sources (`./claimdefs/order-fulfillment-stage.generated.ts` /
  // `./claimdefs/payment-status.generated.ts`, compiled from the matching `.claim.ts`). The
  // SIXTH and SEVENTH owner-scoped types to compile from source, on exactly the
  // RESERVATION_STATUS footing: each required-evidence row carries `ownershipPolicy:
  // "required"` and is projected VERBATIM (by reference) by the published `toRegistrySpec`,
  // so `ownerScopedBaseKey` below still resolves `order_fulfillment_stage` / `payment_status`
  // off the GENERATED specs exactly as it did off these stanzas — and so does the
  // `ORDER_SUBJECT_BASE_KEYS` display-id set in classify-only-reads.ts, which keys on those
  // two base names. The generated rows carry the UNSUFFIXED base keys plus
  // `perResourceKey: true`, and `selectCandidateClaim` suffixes them by `:{subject}` at
  // select time as before — here the subject is the ORDER id for BOTH types (the
  // investigator's `order_fulfillment_stage:{orderId}` / `payment_status:{orderId}`; one
  // active payment per order). These two lines REPLACE ~98 lines of handwritten stanza
  // (evidence + falsifiers + the C6 bindings, whose rationales moved verbatim into the
  // sources).
  //
  // PAYMENT_STATUS IS THE FIRST GENERATED SPEC TO CARRY THREE REGISTRY FACETS: TWO
  // falsifiers (both genuinely READ, unlike every predecessor's single deliberately-unread
  // one), the `first_party_verified` INTEGRITY FLOOR, and `first_party_only` PROVENANCE on
  // all three rows. No widening was needed for any of them — `toRegistrySpec` spreads the
  // whole falsifier tuple BY REFERENCE and passes the floor through as a scalar, the same
  // reference-pass mechanism R2-S4 proved for `ownershipPolicy` — and each field is asserted
  // individually in `./claimdefs/__tests__/per-resource-claim.test.ts`. So
  // `./claimdefs/per-resource-claim.ts` is UNCHANGED by this slice; the only facet the
  // published compiler cannot express remains R2-S2's `perResourceKey`.
  //
  // ORDER_FULFILLMENT_STAGE is the first adopted type required by a span it does NOT own:
  // `PICKUP_Q` needs both an open store and a ready order, and that row stays HAND-WRITTEN
  // at the closure table per R2-S6's shared-row rule (a source declares a row iff it owns the
  // span; rows for spans no type owns stay hand-written). Read
  // order-fulfillment-stage.claim.ts's header for the rule and for the MEASURED consequence:
  // INV-4 stays green with both rows, but its forward direction is masked as a de-sync
  // detector for that one type.
  //
  // BKL-270 — the postures are SPLICED here for the same reason as on their nine siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot emit the field,
  // and splicing keeps the generated files byte-pure under their source-checksum drift
  // guards. Both are `answer-anyway`, and for DIFFERENT reasons worth keeping distinct:
  // ORDER_FULFILLMENT_STAGE renders a CLOSED 7-MEMBER ENUM (pendente..entregue|cancelado) —
  // the logistics state of the customer's own order, and withholding it from someone who
  // disclosed an allergy is actively harmful, because that is exactly the customer who needs
  // to know whether the food has already left. PAYMENT_STATUS renders a CLOSED 12-MEMBER
  // ENUM of money state: no food, no product names, nothing a dietary qualifier can attach
  // to.
  ORDER_FULFILLMENT_STAGE: {
    ...ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  PAYMENT_STATUS: {
    ...PAYMENT_STATUS_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S4 — RESERVATION_STATUS is now GENERATED from its ClaimDefinition
  // source (`./claimdefs/reservation-status.generated.ts`, compiled from
  // `reservation-status.claim.ts`). The FIRST OWNER-SCOPED type to compile from source:
  // its required-evidence row carries `ownershipPolicy: "required"`, and that row is
  // projected VERBATIM by the published `toRegistrySpec`, so `ownerScopedBaseKey` below
  // still resolves `reservation_status` off the GENERATED spec exactly as it did off this
  // stanza — no second schema widening was needed for the ownership axis (only R2-S2's
  // `perResourceKey`, via `./claimdefs/per-resource-claim.ts`). The generated row carries
  // the UNSUFFIXED base keys plus `perResourceKey: true`, and `selectCandidateClaim`
  // suffixes them by `:{subject}` at select time as before. This one line REPLACES the
  // ~48-line handwritten stanza (evidence + the deliberately-unread W6 falsifier + the
  // BKL-185 C6 binding, whose rationales moved verbatim into the source) and can never
  // drift from the template or the closure row, which are generated too.
  // BKL-270 — the posture is SPLICED here for the same reason as on its siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot emit the
  // field, and splicing keeps the generated file byte-pure under its source-checksum
  // drift guard. `answer-anyway`: renders a status enum plus date/time/party integers.
  // No food.
  // CAVEAT (borderline B5): a diet-qualified reservation ask is often TWO spans
  // ("a minha reserva esta confirmada? preciso de menu sem lactose"). This
  // posture answers the RESERVATION span only; the dietary span still needs its
  // own disposition under SO15 completeness — answer-anyway must never mean
  // "silently drop the diet span".
  RESERVATION_STATUS: {
    ...RESERVATION_STATUS_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // BKL-139 / FE-D03 — the owner-scoped IN-PROGRESS CART read. Structurally the
  // RESERVATION_STATUS idiom (owner-scoped, per-resource, must_read_this_turn,
  // falsifier-complete), BUT its C6 value is a DETERMINISTICALLY PRE-COMPOSED summary
  // scalar (`itemsSummaryText`), following the STORE_HOURS_FOR_DATE `hoursText`
  // precedent: a list-shaped read (N cart lines) rendered as ONE C6-bound string under
  // the frozen single-scalar kernel (FE-D09). The subject is the AUTHENTICATED
  // customerId (the cart is 1-per-customer, resolved server-side from the session's
  // conversationId — never a model-extracted id), so the investigator records
  // `cart_contents:{customerId}` and the owner-scope wiring lists `cart_contents:` in
  // OWNER_SCOPED_KEY_PREFIXES (ibatexas-claims-kernel-deps.ts). A guest owns no cart →
  // the read is skipped (isAuthenticatedCustomer gate) → the claim resolves ABSENT →
  // honest UNKNOWN (the fail-closed ownership ruling). The money in `itemsSummaryText`
  // is composed in code from integer centavos (Hard Rule 2), NEVER model-authored
  // (FE-D04 / BKL-149).
  // inv.18 v2 / R2-S6 — the CART PRESENCE-COMPLEMENT PAIR is now GENERATED from their
  // ClaimDefinition sources (`./claimdefs/cart-contents.generated.ts` /
  // `./claimdefs/cart-empty.generated.ts`, compiled from the matching `.claim.ts`). The
  // FOURTH and FIFTH owner-scoped types to compile from source, on exactly the
  // RESERVATION_STATUS / histories footing: each required-evidence row carries
  // `ownershipPolicy: "required"` and is projected VERBATIM (by reference) by the published
  // `toRegistrySpec`, so `ownerScopedBaseKey` below still resolves `cart_contents` /
  // `cart_empty` off the GENERATED specs exactly as it did off these stanzas — no second
  // schema widening was needed (only R2-S2's `perResourceKey`, via
  // `./claimdefs/per-resource-claim.ts`). The generated rows carry the UNSUFFIXED base keys
  // plus `perResourceKey: true`, and `selectCandidateClaim` suffixes them by `:{subject}` at
  // select time as before — here the subject is the AUTHENTICATED customerId (one cart per
  // customer), matching the investigator's `cart_contents:{customerId}` /
  // `cart_empty:{customerId}`. These two lines REPLACE ~92 lines of handwritten stanza
  // (evidence + the deliberately-unread W6 falsifiers + the C6 bindings, whose rationales
  // moved verbatim into the sources) and can never drift from the templates or the SHARED
  // closure row, which are generated too.
  //
  // THE PAIR IS THE FIRST SLICE WHERE ONE CLOSURE ROW SERVES TWO SOURCES: `CART_CONTENTS_Q`
  // requires BOTH types, and it is declared by the span-owning source
  // (`cart-contents.claim.ts`) while `cart-empty.claim.ts` declares no `decomposition` at
  // all. Read cart-contents.claim.ts's header for the decision and its evidence.
  //
  // BKL-270 — the postures are SPLICED here for the same reason as on their seven siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot emit the
  // field, and splicing keeps the generated files byte-pure under their source-checksum
  // drift guard. THE PAIR TAKES TWO DIFFERENT VALUES, which is the sharpest available
  // demonstration that the posture is an OWNER RULING and not a projection of the source:
  // the two rows are otherwise structurally identical, and no mechanical rule over the
  // sources could produce `answer-with-abstention` for one and `answer-anyway` for the
  // other.
  //
  // `answer-with-abstention` for CART_CONTENTS — THE REGISTRY'S ONLY row with this posture
  // (owner ruling 2026-07-27). itemsSummaryText NAMES PRODUCTS, so under "o que tem no meu
  // carrinho QUE SEJA SEM GLUTEN?" returning the summary would assert those specific items
  // are safe — food the customer is about to eat, the highest-stakes assertion in the
  // registry. But the cart is the customer's OWN prior act, and refusing to show it is a
  // severe degradation for the very customer who needs to check. So: render the cart (the
  // fact is theirs to have) AND append the ratified BKL-184 abstain + handoff (the dietary
  // FILTER is not ours to answer).
  CART_CONTENTS: {
    ...CART_CONTENTS_REGISTRY_SPEC,
    dietaryPosture: "answer-with-abstention",
  },
  // `answer-anyway` for CART_EMPTY — the bound scalar is the hardcoded literal "vazio". The
  // safest render in the registry: true under every reading of every qualifier, and it names
  // no food. NOTE its complement CART_CONTENTS takes a DIFFERENT posture — the pair is
  // splittable only because the two use DISTINCT evidence keys (cart_empty vs
  // cart_contents), which the boot gate's shared-key check pins.
  CART_EMPTY: {
    ...CART_EMPTY_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S5 — the HISTORIES PAIR is now GENERATED from their ClaimDefinition
  // sources (`./claimdefs/order-history.generated.ts` /
  // `./claimdefs/payment-history.generated.ts`, compiled from the matching `.claim.ts`).
  // The SECOND and THIRD owner-scoped types to compile from source, on exactly the
  // RESERVATION_STATUS footing R2-S4 established: each required-evidence row carries
  // `ownershipPolicy: "required"` and is projected VERBATIM (by reference) by the
  // published `toRegistrySpec`, so `ownerScopedBaseKey` below still resolves
  // `order_history` / `payment_history` off the GENERATED specs exactly as it did off
  // these stanzas — no second schema widening was needed for the ownership axis (only
  // R2-S2's `perResourceKey`, via `./claimdefs/per-resource-claim.ts`). The generated rows
  // carry the UNSUFFIXED base keys plus `perResourceKey: true`, and `selectCandidateClaim`
  // suffixes them by `:{subject}` at select time as before — here the subject is the
  // AUTHENTICATED customerId (one history per customer), matching the investigator's
  // `order_history:{customerId}` / `payment_history:{customerId}`. These two lines REPLACE
  // ~73 lines of handwritten stanza (evidence + the deliberately-unread W6 falsifiers +
  // the C6 bindings, whose rationales moved verbatim into the sources) and can never drift
  // from the templates or the closure rows, which are generated too.
  // BKL-270 — the postures are SPLICED here for the same reason as on their five
  // siblings: `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot
  // emit the field, and splicing keeps the generated files byte-pure under their
  // source-checksum drift guard.
  // `answer-anyway` for ORDER_HISTORY: looks food-shaped and is NOT —
  // composeOrderHistorySummary renders order display numbers, status enums and money,
  // with NO item names. Nothing about food reaches the customer, so a restrictive
  // qualifier has nothing to attach to.
  ORDER_HISTORY: {
    ...ORDER_HISTORY_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // `answer-anyway` for PAYMENT_HISTORY: money, method, status enum, bounded to the most
  // recent N. Same argument as ORDER_HISTORY with even less surface.
  PAYMENT_HISTORY: {
    ...PAYMENT_HISTORY_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S2 — MENU_ITEM_PRICE is now GENERATED from its ClaimDefinition source
  // (`./claimdefs/menu-item-price.generated.ts`, compiled from `menu-item-price.claim.ts`).
  // The FIRST `perResourceKey` type to compile from source: the flag has no field in the
  // published `compileClaimDefinition`, so it is projected by the REPO-LOCAL widening
  // (`./claimdefs/per-resource-claim.ts`) — the generated row carries the UNSUFFIXED base
  // keys plus `perResourceKey: true`, exactly as this stanza spelled them, and
  // `selectCandidateClaim` below suffixes them by `:{subject}` at select time as before.
  // This one line REPLACES the ~46-line handwritten stanza (evidence + the
  // deliberately-unread W6 falsifier + the C6 binding, whose rationales moved verbatim
  // into the source) and can never drift from the template or the closure row, which are
  // generated too.
  // BKL-270 — the posture is SPLICED here for the same reason as on its three siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot emit the
  // field, and splicing keeps the generated file byte-pure under its source-checksum
  // drift guard. `abstain`: price is not food content, but the failure here is WORSE than
  // implication — it is SUBJECT MISRESOLUTION. Asked "quanto custa o brownie sem
  // lactose?" the resolver resolves the ORDINARY brownie and prices that, so the answer
  // both asserts a sem-lactose variant exists and attaches a real price to a product that
  // is not the one asked about. Highest helpfulness cost of any abstain (price is the
  // most-asked read) — accepted by the owner as drafted.
  MENU_ITEM_PRICE: {
    ...MENU_ITEM_PRICE_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // inv.18 v2 / R2-S3 — MENU_ITEM_CONTENTS is now GENERATED from its ClaimDefinition
  // source (`./claimdefs/menu-item-contents.generated.ts`, compiled from
  // `menu-item-contents.claim.ts`). MENU_ITEM_PRICE's structural twin: the same PUBLIC
  // per-item facet inventory reached through the same repo-local `perResourceKey` widening
  // (`./claimdefs/per-resource-claim.ts`), so the generated row carries the UNSUFFIXED
  // base keys plus `perResourceKey: true` exactly as this stanza spelled them, and
  // `selectCandidateClaim` below suffixes them by `:{subject}` at select time as before.
  // This one line REPLACES the ~32-line handwritten stanza (evidence + the
  // deliberately-unread W6 falsifier + the C6 binding, whose rationales moved verbatim
  // into the source) and can never drift from the template or the closure row, which are
  // generated too.
  // BKL-270 — the posture is SPLICED here for the same reason as on its siblings:
  // `compileClaimDefinition` has no concept of `dietaryPosture`, so it cannot emit the
  // field, and splicing keeps the generated file byte-pure under its source-checksum
  // drift guard. `abstain`: contentsText is the owner-authored free-text product blurb,
  // the ONLY scalar in the registry that can name ingredients verbatim. Under a dietary
  // qualifier it reads as an ingredient assurance — and a blurb is WEAKER evidence than
  // the attested allergens array BKL-143 already ruled insufficient. Gate shipped by
  // BKL-273/#441; this declaration makes it registry-driven.
  MENU_ITEM_CONTENTS: {
    ...MENU_ITEM_CONTENTS_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // inv.18 v2 / R2-S3 — MENU_DIETARY is now GENERATED from its ClaimDefinition source
  // (`./claimdefs/menu-dietary.generated.ts`, compiled from `menu-dietary.claim.ts`).
  // Same PUBLIC per-item facet inventory as MENU_ITEM_PRICE/CONTENTS (perResourceKey,
  // every row `not_applicable`) — the one difference is that the "resource id" is the
  // dietary TAG (vegetariano/vegano) rather than a product id, which is a fact about what
  // the ledger key DENOTES and not a facet the compiler models. This one line REPLACES
  // the ~35-line handwritten stanza; the rationales (the C6 `dietaryText` binding, the
  // deliberately-unread W6 falsifier, the empty-tag → honest-UNKNOWN disposition) moved
  // verbatim into the source.
  // BKL-270 — the posture is SPLICED here for the same reason as on its siblings.
  // `abstain`: the sentence is ALREADY a composition statement about food ("estas opcoes
  // veganas"), so a second dietary qualifier compounds two attribute claims the catalog
  // can attest to only one of. Gate shipped by BKL-273/#441.
  // POLICY NOTE (BKL-270 borderline B6, owner-ruled 2026-07-27): BKL-171 ratified
  // that vegano/vegetariano-only renders stay OUT; BKL-214 (PR #358) then shipped
  // exactly those renders. The owner has recorded BKL-214 as the WRITTEN REVERSAL
  // of BKL-171 — the shipped behaviour stands, and the reversal is now documented
  // rather than an undocumented divergence. This posture is correct either way.
  MENU_DIETARY: {
    ...MENU_DIETARY_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // inv.18 v2 / R2-S9 — MENU_OVERVIEW is now GENERATED from its ClaimDefinition source
  // (`./claimdefs/menu-overview.generated.ts`, compiled from `menu-overview.claim.ts`).
  // PUBLIC and FIXED-SUBJECT like STORE_HOURS (single key, NOT perResourceKey) — the
  // evidence is a deterministic listing of the whole catalog, not a per-item read — so it
  // reaches the compiler through the PUBLISHED `compileClaimDefinition`, and
  // `publicPerItemBaseKey` must keep resolving `undefined` for it while resolving a base
  // key for its three per-ITEM siblings (asserted in
  // `./claimdefs/__tests__/per-resource-claim.test.ts`'s base-key axis). This one line
  // REPLACES the ~40-line handwritten stanza; the ttl UNITS pin and the
  // same-row-tautology rationale for the deliberately-unread `menu:item_unpublished`
  // falsifier moved verbatim into that source, as did the BKL-205 marker/ordering
  // decomposition.
  // BKL-270 — the posture is SPLICED here (the compiler cannot emit it; see
  // STORE_OPEN_NOW). `abstain`: renders titles and prices with no descriptions, so no
  // INDIVIDUAL item is described; the implication lives in the LIST'S RESPONSIVENESS.
  // Under "o que tem no cardapio sem lactose?" the returned list IS the claimed
  // sem-lactose menu. Gate shipped by BKL-273/#441.
  MENU_OVERVIEW: {
    ...MENU_OVERVIEW_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // BKL-136 — STORE_INFO: the store address/parking read ("onde fica?"), now GENERATED
  // from its ClaimDefinition source (inv.18 v2 / R2-S1). The evidence + the
  // declared-but-deliberately-unread `store:info_changed` W6 falsifier + the C6
  // value-binding all come from `./claimdefs/store-info.generated.ts`, compiled from the
  // single `store-info.claim.ts` source (which carries the moved same-row-tautology
  // rationale and the ttl UNITS pin). This one line REPLACES the ~32-line handwritten
  // stanza; the template AND the §O#15 closure row + span markers are generated from
  // the same source, so the three can never drift apart.
  // BKL-270 — the posture is SPLICED here (the compiler cannot emit it; see
  // STORE_OPEN_NOW). infoText is address + parking BY CONTRACT
  // (store.metadata.address / .parking), so no product-content path exists.
  // CONDITIONAL (borderline B4): if store metadata ever carries dietary marketing copy
  // this row must be revisited, because the render would then pass owner prose through
  // to a diet-qualified ask.
  STORE_INFO: {
    ...STORE_INFO_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S9 — the DELIVERY PRESENCE-COMPLEMENT PAIR is now GENERATED from their
  // ClaimDefinition sources (`./claimdefs/delivery-coverage.generated.ts` /
  // `./claimdefs/delivery-no-coverage.generated.ts`). The SECOND pair to SHARE one §O#15
  // closure row after R2-S6's cart pair, and the FIRST whose members are PUBLIC — which is
  // the whole difference, and it is a MEASURED one rather than a stylistic note: INV-4's
  // forward direction obliges Triad-scoped types only, so for this pair (and the coupon and
  // pairing pairs below) it CANNOT detect a `requires` that stopped naming the twin.
  // Dropping CART_EMPTY from the cart row is DECOMPOSITION_UNREACHABLE; dropping
  // DELIVERY_NO_COVERAGE from this one is `{ ok: true }`. An explicit structural pin in
  // `./claimdefs/__tests__/generated-drift.test.ts` stands in for the boot-time refusal;
  // the full derivation, and why the fallback matters (a de-synced row silently removes
  // the twin from `classifyOnlyRequiredTypes`, so the honest-NO branch stops being
  // produced on the deterministic path), is in delivery-coverage.claim.ts's header.
  //
  // These two lines REPLACE ~90 lines of handwritten stanza (evidence + the
  // deliberately-unread W6 falsifiers + the C6 bindings + the ten-arm coverage-ask net,
  // whose rationales moved verbatim into the sources). Both are FIXED-SUBJECT single-key
  // (the STORE_INFO / MENU_OVERVIEW shape — no perResourceKey), so they compile through the
  // PUBLISHED `compileClaimDefinition` and nothing here is ever `:{subject}`-parameterized.
  //
  // BKL-270 — the postures are SPLICED here for the same reason as on their siblings.
  // `answer-anyway` for DELIVERY_COVERAGE: renders a zone name, integer centavos and
  // integer minutes. A delivery zone is store policy about GEOGRAPHY, not food. Borderline
  // B3 ("voces entregam comida sem gluten no CEP X?" is a product-existence question in
  // delivery clothing) resolved by the containment ring: the follow-up necessarily hits an
  // abstaining MENU_* family.
  DELIVERY_COVERAGE: {
    ...DELIVERY_COVERAGE_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // `answer-anyway` for DELIVERY_NO_COVERAGE — a NEGATIVE about geography. Carries the
  // least dietary implication of any row: it declines to serve, which cannot endorse
  // anything.
  DELIVERY_NO_COVERAGE: {
    ...DELIVERY_NO_COVERAGE_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S9 — the COUPON PRESENCE-COMPLEMENT PAIR is now GENERATED from their
  // ClaimDefinition sources (`./claimdefs/coupon-valid.generated.ts` /
  // `./claimdefs/coupon-invalid.generated.ts`). The THIRD shared-row pair, and the FIRST
  // whose span is named after NEITHER member (`COUPON_VALIDITY_Q`), so R2-S6's rule needed
  // a stated TIE-BREAK instead of the naming settlement the cart and delivery pairs had:
  // the POSITIVE member declares the row, on three grounds recorded in
  // coupon-valid.claim.ts's header. The choice moves no byte — the row is identical
  // whichever file declares it — so it is a REVIEW property, recorded so the next pair
  // inherits a rule.
  //
  // Its MARKER/GUARD split is also the first where NO conjunct of the span predicate
  // decomposes: all four coupon regexes are single lookbehind-anchored literals whose `|`s
  // sit inside one group (the R2-S8 `dateAnchor` shape), so the question was which conjunct
  // IS the marker net rather than which one splits. The coupon NOUN — the topic gate — is
  // the answer the compiler's own semantics give; the read-vs-mutation discrimination
  // (apply-imperative, modal frame, validity phrasing, the code-extraction FUNCTION) stays
  // hand-written and carries BEHAVIOURAL pins, a byte pin being guard-blind by
  // construction.
  //
  // These two lines REPLACE ~86 lines of handwritten stanza. Both are FIXED-SUBJECT
  // single-key (no perResourceKey), so they compile through the PUBLISHED
  // `compileClaimDefinition`. The same INV-4 vacuity noted on the delivery pair applies
  // here (MEASURED: `COUPON_VALIDITY_Q loses COUPON_INVALID -> { ok: true }`).
  //
  // BKL-270 — the postures are SPLICED here. `answer-anyway` for COUPON_VALID: a promotion
  // record's own code and discount terms. Money/policy, no food.
  COUPON_VALID: {
    ...COUPON_VALID_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // `answer-anyway` for COUPON_INVALID — a negative about a code, and it states NO reason
  // by design. Nothing to endorse.
  COUPON_INVALID: {
    ...COUPON_INVALID_REGISTRY_SPEC,
    dietaryPosture: "answer-anyway",
  },
  // inv.18 v2 / R2-S9 — the PAIRING PRESENCE-COMPLEMENT PAIR is now GENERATED from their
  // ClaimDefinition sources (`./claimdefs/menu-pairings.generated.ts` /
  // `./claimdefs/menu-substitutions.generated.ts`). The FOURTH and last shared-row pair,
  // and the family the compiler was built for: LE2-029 registered it across SIX files and
  // +430 lines pre-compiler, three of which are now projections of one source each. It is
  // ALSO the only unit in the corpus whose generated `markers` ORDER a RUNTIME branch reads
  // — the two arms are the relation discriminator `classifyPairingAsk` tests in sequence —
  // so the decomposer reads them through NAMED index constants and each arm is pinned
  // byte-for-byte and INDIVIDUALLY; see menu-pairings.claim.ts's header.
  //
  // These two lines REPLACE ~84 lines of handwritten stanza. Both are FIXED-SUBJECT
  // single-key (no perResourceKey). The same INV-4 vacuity noted on the delivery pair
  // applies (MEASURED: `PAIRING_Q loses MENU_SUBSTITUTIONS -> { ok: true }`).
  //
  // The "THERE IS NO MENU_NO_PAIRINGS" argument in the enum comment above is unaffected and
  // is summarized in menu-pairings.claim.ts's header, since that is now the file an author
  // adding a claim type would open.
  //
  // BKL-270 — the postures are SPLICED here. `abstain` for MENU_PAIRINGS: THE RATIFIED
  // ANCHOR. Renders the hand-authored 10-edge TASTE graph; under a dietary qualifier the
  // house's suggestion reads as a house recommendation FOR THAT DIET, with no staff in the
  // loop. LE2-029 measured the full list rendering for "sem gluten" and closed it; this
  // declaration makes the existing read-guard registry-driven instead of hand-applied.
  MENU_PAIRINGS: {
    ...MENU_PAIRINGS_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // `abstain` for MENU_SUBSTITUTIONS — same authored graph as MENU_PAIRINGS, and the frame
  // is if anything stronger: "a casa indica" is explicitly an endorsement verb.
  MENU_SUBSTITUTIONS: {
    ...MENU_SUBSTITUTIONS_REGISTRY_SPEC,
    dietaryPosture: "abstain",
  },
  // ── R2-S9 — THE ONE HAND-WRITTEN ROW LEFT, AND IT IS A RULING ─────────────────────
  //
  // PURCHASE_COMPLETED is EXCLUDED BY DESIGN from the claimdef compiler. It is the only
  // stanza in this object that is not a spread of a generated spec, and it must stay that
  // way; the census pin (`22 generated + 1 documented exclusion = 23`, in
  // `./claimdefs/__tests__/generated-drift.test.ts`) is what makes a future type addition
  // declare itself as one or the other rather than quietly becoming a second hand-written
  // row. The companion note lives at the end of `./claimdefs/generate.ts`'s UNITS.
  //
  // NOT "the compiler would reject it" — it would not. `kind: "action_claim"` is a member
  // of the published `ClaimKind`, the single `action_outcome` evidence row is structurally
  // ordinary, and with no `render` block the compiler's F7 guard never fires. The exclusion
  // is about what a compiled source would ASSERT.
  //
  // This is the registry's ONLY `action_claim`, and an action claim does not render through
  // the read-template grammar at all: it renders through the responder's
  // `SUCCESS_CLAIM_CLASSES` path (`./ibatexas-responder.ts`), where this ONE registry type
  // maps to TWO lowercase guard classes (`order-placed` + `purchase-completed`) in a
  // different namespace (SDD §K "map, do not equate"). The compiler's `render` block models
  // exactly one posture — the `validated` READ template — and has no shape for that. So a
  // compiled source would be SILENT about the one mechanism that determines how this type
  // reaches a customer, and its generated doc card would print `**render (validated)**:
  // _(no render template)_` — which for a read type truthfully means "abstains to
  // SAFE_UNKNOWN" (MENU_ITEM_ALLERGENS above, where the same card line is TRUE and the
  // adoption is therefore honest) and for this one would be actively FALSE, since it does
  // render. Publishing that card is the dead-and-misleading-artifact failure inv.18 v2
  // exists to prevent.
  //
  // WHAT WOULD CHANGE THE RULING: an `action_claim` render posture in the published
  // compiler's `RenderSource`. Nothing in this repo can supply it — `@adjudicate/core` is a
  // separately published package and the dependency arrow never points backward (SDD
  // §M/§Q). This is NOT a deferral and NOT pending BKL-121/-123.
  PURCHASE_COMPLETED: {
    kind: "action_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "purchase_outcome",
        ownershipPolicy: "required",
        // Evidence = this turn's Action verdict + dispatch, not a read.
        freshnessPolicy: "action_outcome",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
  },
} satisfies Record<RegistryClaimType, RegistryClaimSpec>;

/**
 * LE2-012 — ONE PLANE's claim-type SCOPE: the closed enum the planner of that
 * plane may SELECT from (`types`, the `propose_claim` tool's `enum`) plus the
 * per-type evidence/falsifier/value-binding schema the deterministic walls
 * parameterize (`specs`). `specs` MUST be exhaustive over `types` — the two are
 * the SAME closed vocabulary seen from the enum side and the schema side, and a
 * drift between them is what the plane's registry pin test asserts against.
 *
 * WHY a scope and not one flat registry: the ops plane answers STORE-LEVEL
 * questions ("quantos pedidos hoje?") that the customer-scoped vocabulary cannot
 * express, and those types must NEVER become customer-plane parseable or
 * renderable (an operator's store totals are not a customer-facing fact). Rather
 * than invent a second mechanism, the EXISTING §H/§P3 constrained-generation wall
 * carries the boundary: each plane's planner advertises only ITS scope's enum,
 * and `selectCandidateClaim` DROPS an out-of-scope type exactly as it drops a
 * hallucinated one. The customer scope is unchanged and remains the DEFAULT of
 * every wall in this module, so nothing that does not explicitly pass a scope
 * changes by a byte.
 */
export interface ClaimPlaneScope {
  /** The closed claim-TYPE enum this plane's planner may select from. */
  readonly types: readonly string[];
  /** The per-type registry schema, exhaustive over {@link types}. */
  readonly specs: Readonly<Record<string, RegistryClaimSpec>>;
}

/**
 * The CUSTOMER plane's scope — the `CLAIM_REGISTRY` enum + `REGISTRY_SPECS`, i.e.
 * exactly the vocabulary that existed before plane scoping. It is the DEFAULT
 * argument of every scoped wall below. A plane-scoped type is added by composing a
 * SUPERSET scope on that plane (see `apps/api/src/ops/ops-claim-registry.ts`);
 * this constant is never widened, which is what keeps the customer plane closed.
 */
export const CUSTOMER_CLAIM_SCOPE: ClaimPlaneScope = {
  types: CLAIM_REGISTRY,
  specs: REGISTRY_SPECS,
};

/**
 * The owner-scoped, per-resource BASE ledger key for a registry type (FIX 2 —
 * owner-scoped subject resolution). It is the `order_fulfillment_stage` /
 * `payment_status` prefix the investigator records the owner-scoped read under,
 * BEFORE the `:{subject}` suffix (`parameterizeKeysBySubject`). `undefined` for a
 * public, single-key type (STORE_OPEN_NOW / STORE_HOURS / MENU_ITEM_ALLERGENS):
 * those carry no owner-scoped subject, so the claim planner never re-resolves
 * their subject from owner-scoped reads. Pure.
 *
 * Used by the claim planner (`ibatexas-planner.ts`, FIX 2) to map a candidate's
 * owner-scoped TYPE onto the base key whose PRESENT owner-scoped ledger ids are
 * the ONLY admissible subjects — so the subject derives from the authenticated
 * owner-scoped reads, never the 4B's (possibly empty/hallucinated) extraction.
 */
export function ownerScopedBaseKey(
  type: string,
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): string | undefined {
  const spec: RegistryClaimSpec | undefined = scope.specs[type];
  if (spec === undefined || spec.perResourceKey !== true) return undefined;
  const required = spec.requiredEvidence.find(
    (e) => e.ownershipPolicy === "required",
  );
  return required?.key;
}

/**
 * A model PROPOSAL of a claim, BEFORE the constrained-generation wall (SDD §H).
 * The model proposes a `type` (a free string — it may hallucinate one outside
 * the registry) plus runtime parameters. `selectCandidateClaim` is what
 * constrains it: only an in-enum `type` becomes a typed `CandidateClaim`.
 */
export interface ProposedClaim {
  /** The model-proposed claim type name — UNVALIDATED (may be out-of-enum). */
  readonly type: string;
  /** The same-subject partition key (e.g. an order id, a menu-item handle). */
  readonly subject: string;
  /** The kernel-abstract actor the §5 `owns(actor, resource)` check is about. */
  readonly actor: unknown;
  /** Per-evidence-`key` → resource bindings for the C1 ownership check. */
  readonly resources?: Readonly<Record<string, unknown>>;
  /** The domain proposition the renderer would fill from this claim. */
  readonly value: unknown;
}

/**
 * The PRE-planning constrained-generation wall (SDD §H · §P3; claim-registry
 * v0.1 §1). Select-and-parameterize: a model `ProposedClaim` becomes a typed
 * `@adjudicate/core` `CandidateClaim` IFF its `type` is in the registry enum;
 * otherwise `undefined` (the proposal is DROPPED — the model can never
 * free-generate a type, exactly as a hallucinated `express_intent.capability`
 * is dropped by the planner's `allowedIntents` guard).
 *
 * Parameterization binds the model's runtime params (subject/actor/resources/
 * value) into the registry type's FIXED evidence schema — the model authors the
 * params, NEVER the evidence/soundness shape (SDD §E; §O#3). The produced
 * `CandidateClaim` matches the linked kernel input verbatim, so the downstream
 * `runClaimsKernel` (Q6a) consumes it. Pure.
 */
export function selectCandidateClaim(
  proposed: ProposedClaim,
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): CandidateClaim | undefined {
  // fix 3 — CASING-ROBUST membership: canonicalize the (possibly miscased) model
  // tag to its UPPER_SNAKE registry form BEFORE the membership test, so a
  // correctly-classified-but-miscased type (`ORDER_fulfillment_stage`) is RESCUED
  // rather than dropped into the lie-capable prose path. A tag that does not map
  // even after canonicalization → `undefined` → DROPPED by the constrained-
  // generation wall (degrade SAFE; the planner routes UNKNOWN/CLARIFY/ESCALATE).
  // LE2-012 — resolved against the PLANE's scope (the customer registry by
  // default): an out-of-SCOPE type is dropped by the very same wall that drops a
  // hallucinated one, which is what keeps an ops-scoped type unreachable from the
  // customer plane.
  const canonicalType = canonicalizeScopedClaimType(proposed.type, scope);
  if (canonicalType === undefined) {
    return undefined;
  }
  // Widen the `as const` literal member to the interface so the OPTIONAL W6
  // fields (falsifierComplete / falsifiers / valueBinding) are readable on every
  // member (a member that omits them is `undefined`, not a missing property).
  // Keyed by the CANONICAL type so a miscased tag selects the right spec.
  // `canonicalizeScopedClaimType` already proved own-key membership, so the
  // lookup is total; the `?? undefined` guard is defense in depth for a caller
  // that hands in a scope whose `types`/`specs` drifted apart.
  const baseSpec: RegistryClaimSpec | undefined = scope.specs[canonicalType];
  if (baseSpec === undefined) return undefined;
  // STEP 3 key-alignment: an owner-scoped, per-resource type (perResourceKey) has
  // its evidence/falsifier/value-binding keys parameterized by the candidate
  // `subject` so they match the investigator's `${base}:{id}` ledger keys. A
  // single-key public type (STORE_OPEN_NOW) is untouched. PURE — the model never
  // authors the key shape (it only supplies `subject`).
  const spec: RegistryClaimSpec =
    baseSpec.perResourceKey === true
      ? parameterizeKeysBySubject(baseSpec, proposed.subject)
      : baseSpec;
  // fix 2 (owner-attribution C1 binding): the model authors ONLY `type` + `subject`
  // (the propose_claim tool exposes no `resources`), so an owner-scoped per-resource
  // claim would reach the kernel with NO C1 binding → `claim.resources?.[key]`
  // undefined → ownership REFUSED even for the legit owner. DERIVE the binding from
  // `subject` (the resource id), keyed by EACH suffixed requiredEvidence key so the
  // kernel's `evaluateEvidence` ownership check finds it. IDOR stays closed: the
  // per-turn `owns` (claims-pipeline.ts) gates `subject` against the owner-scoped
  // reads that actually returned PRESENT this turn — a forged/cross-owner subject
  // is never read → not owned → REFUSED ("no owner" ≠ "any owner", Inv 2). An
  // explicitly-supplied `resources` (tests / non-per-resource types) is honored
  // verbatim; a non-per-resource type with no resources stays unbound.
  const resources: Readonly<Record<string, unknown>> | undefined =
    proposed.resources !== undefined
      ? proposed.resources
      : baseSpec.perResourceKey === true
        ? Object.fromEntries(
            spec.requiredEvidence
              .filter((e) => e.ownershipPolicy === "required")
              .map((e) => [e.key, proposed.subject]),
          )
        : undefined;
  return {
    soundness: {
      requiredEvidence: spec.requiredEvidence,
      minSourceIntegrity: spec.minSourceIntegrity,
      kind: spec.kind,
      actor: proposed.actor,
      ...(resources === undefined ? {} : { resources }),
      // W6 falsifier-completeness (Plan 1 Phase 3) — threaded from the type's
      // FIXED spec, NEVER model-authored: the eligibility cap + the runtime arm
      // (resolveAgainstFalsifiers) live in the kernel. A type with no declared
      // falsifiers stays UNKNOWN-only (the fail-safe default).
      ...(spec.falsifierComplete === true
        ? { falsifierComplete: true, falsifiers: spec.falsifiers ?? [] }
        : {}),
      // W6 C6 value-binding — bind the rendered value to its licensing ledger
      // entry (also FIXED per type; the model never authors the binding).
      ...(spec.valueBinding === undefined
        ? {}
        : { valueBinding: spec.valueBinding }),
    },
    // Customer-scoped types partition by their owner-bound subject; the subject
    // is the Q4 same-subject consistency key (SDD §D).
    subject: proposed.subject,
    // The CANONICAL type so ALL downstream keying/rendering uses the UPPER_SNAKE
    // form (never the raw miscased tag) — fix 3.
    type: canonicalType,
    value: proposed.value,
  };
}

/**
 * STEP 3 — parameterize an owner-scoped, per-resource type's evidence/falsifier/
 * value-binding keys by the candidate `subject` (`${baseKey}:${subject}`) so they
 * match the investigator's per-resource ledger keys
 * (`order_fulfillment_stage:{id}`, `payment_status:{id}`,
 * `order_cancelled:{id}`, `payment_refund:{id}`, `payment_chargeback:{id}`). PURE.
 *
 * INVARIANT preserved: `valueBinding.key` is suffixed with the SAME `:{subject}`
 * as its requiredEvidence member, so it stays a member of the requiredEvidence key
 * set and the kernel's C6 structural guard (soundness.ts) never throws. The model
 * authors NONE of this — only `subject`; the evidence/falsifier SHAPE is FIXED.
 */
function parameterizeKeysBySubject(
  spec: RegistryClaimSpec,
  subject: string,
): RegistryClaimSpec {
  const suffix = `:${subject}`;
  const rekey = (e: EvidenceRequirement): EvidenceRequirement => ({
    ...e,
    key: `${e.key}${suffix}`,
  });
  return {
    ...spec,
    requiredEvidence: spec.requiredEvidence.map(rekey),
    ...(spec.falsifiers === undefined
      ? {}
      : { falsifiers: spec.falsifiers.map(rekey) }),
    ...(spec.valueBinding === undefined
      ? {}
      : {
          valueBinding: {
            ...spec.valueBinding,
            key: `${spec.valueBinding.key}${suffix}`,
          },
        }),
  };
}

/**
 * Run the constrained-generation wall over a batch of model proposals (SDD §H).
 * Returns the typed candidates that PASSED the enum constraint plus the names
 * of the proposals that were DROPPED (recorded for the planner rationale +
 * telemetry, mirroring the planner's `dropped` list for out-of-plan
 * capabilities). Pure.
 */
export function constrainClaimGeneration(
  proposals: readonly ProposedClaim[],
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): { readonly candidates: CandidateClaim[]; readonly dropped: string[] } {
  const candidates: CandidateClaim[] = [];
  const dropped: string[] = [];
  for (const p of proposals) {
    const candidate = selectCandidateClaim(p, scope);
    if (candidate === undefined) {
      dropped.push(p.type);
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, dropped };
}

/**
 * The first-party reads the ibatexas claim planner has available to DERIVE a
 * candidate's bound `value` from (tag-then-derive plan STEP 2). PUBLISH-FREE:
 * these are re-reads from the SAME first-party source the investigator records,
 * NOT the per-turn ledger (the planner has no ledger access — that ledger-exact
 * derivation is the Wall-2 `claims-validate.ts` republish). For STORE_OPEN_NOW the
 * re-read is byte-equal to the recorded `schedule:store_open_now` entry, so the
 * kernel's C6 value-binding passes BY CONSTRUCTION — without skipping C6.
 */
export interface FirstPartyDerivationReads {
  // BKL-126 — the schedule-family derives (scheduleSignal / storeHours /
  // storeHoursForDate) were REMOVED from this bag: unlike the memoized menu/
  // store-info reads below, they were FRESH loadSchedule()+clock loads at
  // claims-validate time, 5-20s (model latency) after the investigator's
  // recorded read — a mid-turn schedule edit or midnight rollover in that
  // window diverged the two arms into a C6 REFUSED mis-audited as a model
  // over-claim. The schedule-family candidates now leave the planner with
  // `value: undefined` and @claustrum/core claims-validate stage 4b binds the
  // value from the investigator's OWN recorded ledger entry (only-undefined,
  // full-entry, same-path projection) — C6 passes BY CONSTRUCTION with the
  // divergence window deleted, and the override/holiday falsifier arms are
  // untouched (a present falsifier still demotes). No recorded entry (span
  // didn't fire / read failed) → value stays undefined → honest UNKNOWN.
  /** BKL-142 — the per-item PRICE read(s) for THIS turn, keyed by the RESOLVED product
   *  id (the candidate `subject`). The SAME resolved product the investigator records
   *  under `menu:item_price:{id}`, so the derived `priceText` is byte-equal to the
   *  recorded ledger entry and C6 passes BY CONSTRUCTION. A candidate whose `subject`
   *  is absent from this map keeps `value: undefined` (C6 ABSTAIN → honest UNKNOWN). */
  readonly menuItemPrice?: Readonly<Record<string, { readonly priceText?: unknown }>>;
  /** BKL-142 — the per-item CONTENTS read(s) for THIS turn, keyed by resolved product
   *  id; the SAME product the investigator records under `menu:item_contents:{id}`. */
  readonly menuItemContents?: Readonly<Record<string, { readonly contentsText?: unknown }>>;
  /** BKL-214 — the per-TAG dietary read(s) for THIS turn, keyed by the dietary tag
   *  (vegetariano/vegano); the SAME `dietaryText` the investigator records under
   *  `menu:dietary:{tag}`, so the derived value is byte-equal (C6 passes by
   *  construction). Absent tag → value stays undefined → C6 ABSTAIN → honest UNKNOWN. */
  readonly menuDietary?: Readonly<Record<string, { readonly dietaryText?: unknown }>>;
  /** BKL-142 — the menu-WIDE overview read for THIS turn (fixed subject, single-key,
   *  like STORE_HOURS). The SAME `overviewText` the investigator records under
   *  `menu:overview`, so the derived value is byte-equal (C6 passes by construction).
   *  Absent (empty/unreadable catalog) → value stays undefined → C6 ABSTAIN → UNKNOWN. */
  readonly menuOverview?: { readonly overviewText?: unknown };
  /** BKL-136 — the store-info read for THIS turn (fixed subject, single-key, like
   *  MENU_OVERVIEW). The SAME `infoText` the investigator records under `store:info`
   *  (shared per-turn resolver memo), so the derived value is byte-equal (C6 passes
   *  by construction). Absent (blank/unreadable metadata) → value stays undefined →
   *  C6 ABSTAIN → honest UNKNOWN. */
  readonly storeInfo?: { readonly infoText?: unknown };
  /** LE2-002 / NEW-007 — the delivery-coverage read for THIS turn (fixed subject,
   *  single-key, like STORE_INFO). The SAME `coverageText` the investigator records
   *  under `delivery:coverage` (shared per-turn resolver memo keyed on turnId+text),
   *  so the derived value is byte-equal (C6 passes by construction). Absent (no zone
   *  matched / an unreadable projection) → value stays undefined → C6 ABSTAIN →
   *  honest UNKNOWN, never a fabricated fee or ETA. */
  readonly deliveryCoverage?: { readonly coverageText?: unknown };
  /** LE2-002 / NEW-007 — the NEGATIVE twin, recorded under `delivery:no_coverage`
   *  only on a POSITIVE out-of-zone determination (never on a read error). */
  readonly deliveryNoCoverage?: { readonly noCoverageText?: unknown };
  /** LE2-019 — the coupon-validity read for THIS turn (fixed subject, single-key,
   *  like DELIVERY_COVERAGE). The SAME `validityText` the investigator records
   *  under `coupon:valid` (shared per-turn resolver memo keyed on turnId+text), so
   *  the derived value is byte-equal (C6 passes by construction). Absent (no code
   *  supplied / an unreadable promotion lookup / unreadable terms) → value stays
   *  undefined → C6 ABSTAIN → honest UNKNOWN, never a fabricated discount. */
  readonly couponValid?: { readonly validityText?: unknown };
  /** LE2-019 — the NEGATIVE twin, recorded under `coupon:invalid` only on a
   *  POSITIVE not-usable determination off a SUCCESSFUL lookup (never on an
   *  error). */
  readonly couponInvalid?: { readonly invalidityText?: unknown };
  /** LE2-029 — the PAIRING read, recorded under `menu:pairings`. Same per-turn
   *  memo (turnId + text) as the investigator's read, so the derived value is
   *  byte-equal (C6 passes by construction). Absent (no known item, an ambiguous
   *  alias, no edge of that relation, or no live product behind the edges) → value
   *  stays undefined → C6 ABSTAIN → honest UNKNOWN, never an invented suggestion. */
  readonly menuPairings?: { readonly suggestionsText?: unknown };
  /** LE2-029 — the SUBSTITUTION twin, recorded under `menu:substitutions` only
   *  when the utterance asked what to have INSTEAD. */
  readonly menuSubstitutions?: { readonly substitutionsText?: unknown };
}

/**
 * tag-then-derive (STEP 2) — for a SINGLE candidate, OVERWRITE `value` from a
 * first-party read so the C6-bound field equals its licensing evidence value,
 * making the model a value-AUTHOR no longer (it only emits the `type` tag). PURE.
 *
 * HARD CONSTRAINT (i): this NEVER sets `validated`, NEVER skips a conjunct. It only
 * replaces `candidate.value` UPSTREAM of `runClaimsKernel`; the kernel then runs
 * EVERY conjunct (C0/∀-evidence/C4/C6 + the falsifier CAP + the CE#3 runtime arm).
 * A derived value that contradicts a present falsifier STILL demotes to UNKNOWN.
 *
 * Scope: STORE_OPEN_NOW and STORE_HOURS (BKL-121) are derivable publish-free (their
 * reads are public, single-key, re-readable in the planner). A bound type with NO
 * available first-party read here (ORDER_FULFILLMENT_STAGE / PAYMENT_STATUS — owner-scoped,
 * per-resource, NOT re-read in the planner to avoid an IDOR re-open) is passed
 * through UNCHANGED → its value stays as-proposed (undefined under the tag
 * protocol) → C6 ABSTAINs / ownership fails → the honest UNKNOWN residual. A type
 * with no `valueBinding` at all is also passed through unchanged.
 */
export function deriveBoundValue(
  candidate: CandidateClaim,
  reads: FirstPartyDerivationReads,
): CandidateClaim {
  // No binding ⟹ §5 is value-agnostic for this type — never re-author its value.
  if (candidate.soundness.valueBinding === undefined) return candidate;

  // BKL-126 — the STORE_OPEN_NOW / STORE_HOURS / STORE_HOURS_FOR_DATE branches
  // were removed: their values now bind at @claustrum/core claims-validate stage
  // 4b from the investigator's recorded ledger entry (see the
  // FirstPartyDerivationReads note) — same C6 outcome, no divergence window.

  if (candidate.type === "MENU_ITEM_PRICE") {
    // BKL-142 — bind the resolved item's `priceText` (the candidate `subject` is the
    // resolved product id). Project `priceText` from the SAME per-item first-party read
    // the investigator recorded under `menu:item_price:{id}` (byte-equal), so C6 passes
    // by construction. No read for this subject (unresolvable item) → value stays
    // undefined → C6 ABSTAINs → honest UNKNOWN.
    const read = reads.menuItemPrice?.[candidate.subject];
    if (read === undefined) return candidate;
    return { ...candidate, value: { priceText: read.priceText } };
  }

  if (candidate.type === "MENU_ITEM_CONTENTS") {
    const read = reads.menuItemContents?.[candidate.subject];
    if (read === undefined) return candidate;
    return { ...candidate, value: { contentsText: read.contentsText } };
  }

  if (candidate.type === "MENU_DIETARY") {
    // BKL-214 — PUBLIC per-item keyed by the dietary tag (candidate.subject). Bind
    // `dietaryText` from the per-tag read map. Absent (no tagged product) → value stays
    // undefined → C6 ABSTAINs → honest UNKNOWN, never a fabricated dietary list.
    const read = reads.menuDietary?.[candidate.subject];
    if (read === undefined) return candidate;
    return { ...candidate, value: { dietaryText: read.dietaryText } };
  }

  if (candidate.type === "MENU_OVERVIEW") {
    // BKL-142 — FIXED subject (single-key, like STORE_HOURS): bind `overviewText` from
    // the single menu-wide read, NOT a per-subject map. Absent read (empty/unreadable
    // catalog) → value stays undefined → C6 ABSTAINs → honest UNKNOWN.
    if (reads.menuOverview === undefined) return candidate;
    return { ...candidate, value: { overviewText: reads.menuOverview.overviewText } };
  }

  if (candidate.type === "STORE_INFO") {
    // BKL-136 — FIXED subject (single-key, like MENU_OVERVIEW): bind `infoText` from
    // the single store-info read. Absent read (blank/unreadable store metadata) →
    // value stays undefined → C6 ABSTAINs → honest UNKNOWN, never a fabricated
    // address.
    if (reads.storeInfo === undefined) return candidate;
    return { ...candidate, value: { infoText: reads.storeInfo.infoText } };
  }

  if (candidate.type === "DELIVERY_COVERAGE") {
    // LE2-002 — FIXED subject (single-key, like STORE_INFO): bind `coverageText`
    // from the single delivery-coverage read. Absent read (no zone matched, an
    // unrecognised place, or an unreadable projection) → value stays undefined →
    // C6 ABSTAINs → honest UNKNOWN, never a fabricated "sim, entregamos".
    if (reads.deliveryCoverage === undefined) return candidate;
    return { ...candidate, value: { coverageText: reads.deliveryCoverage.coverageText } };
  }

  if (candidate.type === "DELIVERY_NO_COVERAGE") {
    // LE2-002 — the negative twin. Bound ONLY when the resolver positively proved
    // the CEP is outside every zone; a read error leaves this undefined → C6
    // ABSTAINs → honest UNKNOWN (never a wrongly-confident "não entregamos").
    if (reads.deliveryNoCoverage === undefined) return candidate;
    return {
      ...candidate,
      value: { noCoverageText: reads.deliveryNoCoverage.noCoverageText },
    };
  }

  if (candidate.type === "COUPON_VALID") {
    // LE2-019 — FIXED subject (single-key, like DELIVERY_COVERAGE): bind
    // `validityText` from the single coupon read. Absent read (no code supplied,
    // an unreadable promotion lookup, or terms we could not state) → value stays
    // undefined → C6 ABSTAINs → honest UNKNOWN, never a fabricated "está válido".
    if (reads.couponValid === undefined) return candidate;
    return { ...candidate, value: { validityText: reads.couponValid.validityText } };
  }

  if (candidate.type === "COUPON_INVALID") {
    // LE2-019 — the negative twin. Bound ONLY when a SUCCESSFUL lookup positively
    // proved the code is not usable; a read error leaves this undefined → C6
    // ABSTAINs → honest UNKNOWN (never a wrongly-confident "não está válido").
    if (reads.couponInvalid === undefined) return candidate;
    return {
      ...candidate,
      value: { invalidityText: reads.couponInvalid.invalidityText },
    };
  }

  if (candidate.type === "MENU_PAIRINGS") {
    // LE2-029 — FIXED subject (single-key, like COUPON_VALID): bind
    // `suggestionsText` from the single pairing read. Absent read (no item the
    // graph knows, an ambiguous alias the canonicaliser declined to resolve, no
    // edge of that relation, or no live product behind the edges) → value stays
    // undefined → C6 ABSTAINs → honest UNKNOWN, never an invented suggestion.
    if (reads.menuPairings === undefined) return candidate;
    return {
      ...candidate,
      value: { suggestionsText: reads.menuPairings.suggestionsText },
    };
  }

  if (candidate.type === "MENU_SUBSTITUTIONS") {
    // LE2-029 — the substitution twin. Bound ONLY when the utterance asked what to
    // have INSTEAD and the graph had a live answer.
    if (reads.menuSubstitutions === undefined) return candidate;
    return {
      ...candidate,
      value: { substitutionsText: reads.menuSubstitutions.substitutionsText },
    };
  }

  // Owner-scoped per-resource types have no planner-available first-party read
  // (deriving them would require an owner-scoped re-read — reserved for Wall 2 to
  // keep the IDOR closed). Pass through → honest UNKNOWN residual.
  return candidate;
}

/**
 * tag-then-derive (STEP 2) — derive bound values across a candidate batch. PURE.
 * The planner runs this AFTER `constrainClaimGeneration` and BEFORE returning the
 * `ClaimPlan`, so the candidates the kernel validates carry first-party-derived
 * (never model-authored) values for every publish-free-derivable bound type.
 */
export function deriveCandidateValues(
  candidates: readonly CandidateClaim[],
  reads: FirstPartyDerivationReads,
): CandidateClaim[] {
  return candidates.map((c) => deriveBoundValue(c, reads));
}

/**
 * One meaningful component of the request the P4 completeness post-check
 * quantifies over (SDD §C P4; §J.8). The span-segmenter (SDD §O#8 — itself a
 * bounded probabilistic input) yields these; `checkCompleteness` is the
 * DETERMINISTIC net that guarantees none silently disappears.
 */
export interface RequestSpan {
  /** The raw request fragment (an interrogative or imperative component). */
  readonly text: string;
  /**
   * The registry claim type the planner MAPPED this span to — or `undefined`
   * for an UNMAPPED span (the model proposed nothing for it). An unmapped span
   * must surface, never drop (SDD §J.8).
   */
  readonly mappedClaimType?: string;
}

/**
 * The P4 disposition of one request span (SDD §C P4; §I). Every span gets
 * exactly one — none silently disappears:
 *
 *   - a typed `RegistryClaimType` — the span MAPPED to an in-enum claim;
 *   - `"UNKNOWN"`  — mapped but honest-ignorance (the §I claim/turn outcome);
 *   - `"ESCALATE"` — routed to a human (a first-class terminal);
 *   - `"CLARIFY"`  — an UNMAPPED span (SDD §J.8: never a silent drop) OR an
 *                    out-of-enum mapping (defense in depth — an unrecognized
 *                    mapped type is not silently honored).
 *
 * LE2-012: on a NON-default {@link ClaimPlaneScope} the mapped-type arm carries
 * that plane's type NAME (a string outside the customer `RegistryClaimType`
 * union). The union below documents the customer plane — the default and the
 * only one whose types this module can name without importing a plane.
 */
export type SpanDisposition =
  | RegistryClaimType
  | Extract<TurnTerminal, "UNKNOWN" | "ESCALATE" | "CLARIFY">;

/** One span paired with its deterministic P4 disposition (SDD §C P4 / §J.8). */
export interface SpanCompleteness {
  readonly text: string;
  readonly disposition: SpanDisposition;
}

/**
 * The POST-planning completeness wall (SDD §C P4 · Inv 8; §J.8). Maps EVERY
 * request span to a disposition so no meaningful component silently disappears.
 * An UNMAPPED span (`mappedClaimType === undefined`) → `CLARIFY` (SDD §J.8:
 * "an unmapped span forces CLARIFY, never a silent drop"). A span mapped to a
 * type OUTSIDE the registry enum also → `CLARIFY` (defense in depth — a
 * hallucinated mapped type is not silently honored as a claim).
 *
 * This is one of the two genuinely data-independent nets (SDD §H honesty
 * correction): it is structural over the candidate SET, not a probabilistic
 * re-classification. Pure.
 */
export function checkCompleteness(
  spans: readonly RequestSpan[],
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): SpanCompleteness[] {
  return spans.map((span) => {
    if (span.mappedClaimType === undefined) {
      // SDD §J.8 — an unmapped span is surfaced as CLARIFY, never dropped.
      return { text: span.text, disposition: "CLARIFY" };
    }
    // fix 3 — canonicalize a correctly-mapped-but-miscased span so it is not
    // needlessly forced to CLARIFY (mirrors selectCandidateClaim). A span that
    // does not map even after canonicalization still → CLARIFY (defense in depth:
    // a hallucinated/out-of-enum mapped type is not silently honored as a claim).
    // LE2-012 — resolved against the PLANE's scope, so an ops-plane span mapped to
    // an ops-scoped type is NOT force-CLARIFYed (and a customer-plane span mapped
    // to one still is: out of scope ⟹ not silently honored).
    const canonical = canonicalizeScopedClaimType(span.mappedClaimType, scope);
    if (canonical === undefined) {
      return { text: span.text, disposition: "CLARIFY" };
    }
    return { text: span.text, disposition: canonical as SpanDisposition };
  });
}

/**
 * Has the P4 check left any span UNRESOLVED in a way the turn must surface
 * (SDD §C P4)? `true` iff some span's disposition is `CLARIFY` — i.e. the turn
 * cannot silently render only the mapped claims; it must ask the customer to
 * disambiguate (a first-class terminal — SDD §I). Pure.
 */
export function hasUnmappedSpan(completeness: readonly SpanCompleteness[]): boolean {
  return completeness.some((s) => s.disposition === "CLARIFY");
}

// ── RECOGNIZED_SAFETY_MARKERS: DELETED (2026-08-05) ──────────────────────
//
// It was a `ReadonlySet<string>` holding `"allergen-severe-reaction"` and
// `"foodborne-illness"`, consulted by `routeSafety` below. It was INERT: both
// of its non-empty exits returned the identical `"ESCALATE"`, so membership
// changed nothing, and neither string appeared anywhere else in apps/ or
// packages/ — no producer ever emitted one. The live marker producers are
// `detectMedicalEmergencyMarkers` (required-claim-decomposer.ts, emits
// `"medical-emergency"`) and the model's own flagged markers (unbounded
// strings); neither can put a member of that set on the wire.
//
// It was deleted rather than kept because it READ as a live closed taxonomy
// while being dead: the only thing a future recognized-marker branch can do
// is let something NOT escalate, so an inert allowlist sitting in the safety
// router is a trap that offers zero test resistance to exactly the change
// that would weaken §O#9. Deleting it costs no guarantee — the routing below
// is UNCONDITIONAL on marker identity, which is strictly STRONGER than
// "default-to-safe on an unrecognized marker", and that strength is now
// pinned by a test (claim-aware-planner.test.ts, the every-marker-escalates
// case) instead of merely being true by accident.
//
// To reintroduce a differentiated taxonomy: author the typed non-escalate
// terminal FIRST, then the recognized set, and pin BOTH arms — a recognized
// marker reaching the new terminal AND an unrecognized one still reaching
// ESCALATE. A set with only one observable arm is the defect this deletion
// removed. The SDD §O#9 fact the old comment carried is preserved on
// `routeSafety` below.

/** A claim a safety request may carry past routing (when no marker fires). */
export interface SafetyRoutingInput {
  /**
   * The safety markers the detector (SDD §O#8 — a bounded probabilistic input)
   * flagged on the request. EMPTY for an ordinary, non-safety request.
   */
  readonly markers: readonly string[];
}

/**
 * The §O#9 safety router (SDD §O#9 · Inv 8; §8). ANY flagged marker routes the
 * turn to `ESCALATE` — the generic safe terminal. It NEVER passes a
 * health/safety framing through as ordinary text (the §O#9 NEW_HOLE:
 * "default-to-safe on any unrecognized health/safety marker").
 *
 *   - markers `[]`                → `undefined` (NOT over-escalated — an
 *                                    ordinary request proceeds normally).
 *   - any marker present, whatever it says → `"ESCALATE"`.
 *
 * UNCONDITIONAL ON MARKER IDENTITY, deliberately. This is what the retired
 * `RECOGNIZED_SAFETY_MARKERS` set (see the note above) failed to make true of
 * itself: recognition was consulted and then ignored, both branches returning
 * the same terminal. Unconditional routing is STRICTLY STRONGER than the §O#9
 * requirement — an attacker-crafted novel marker string escalates, and so does
 * every marker anyone might later call "recognized", so there is no
 * pass-through escape by ANY spelling. SDD §O#9's `harassment` /
 * `medical-emergency` have no typed non-escalate terminal, and neither does
 * anything else: until one exists, differentiating markers here can only
 * WEAKEN the router.
 *
 * Pure; returns the forced turn terminal (or `undefined` when nothing is
 * flagged).
 */
export function routeSafety(
  input: SafetyRoutingInput,
): Extract<TurnTerminal, "ESCALATE"> | undefined {
  if (input.markers.length === 0) {
    // Ordinary, non-safety request — no marker flagged → not over-escalated.
    return undefined;
  }
  return "ESCALATE";
}
