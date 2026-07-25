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
 *   3. SAFETY routing (§O#9/Inv 8 — closed taxonomy): `routeSafety` is
 *      closed-by-construction — an UNRECOGNIZED health/safety marker defaults
 *      to `ESCALATE` (the generic safe terminal). `harassment` /
 *      `medical-emergency` have NO typed terminal yet → `ESCALATE`. It NEVER
 *      passes an unrecognized safety framing through as ordinary text.
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
// inv.18 v2 — the STORE_OPEN_NOW registry spec is GENERATED from its ClaimDefinition
// source by the claimdef-compiler (./claimdefs/store-open-now.generated.ts — DO NOT
// EDIT). The ~30-line handwritten stanza collapsed into this one import; the runtime
// got SMALLER for this type and can no longer drift from the slot grammar / closure.
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
 * The per-registry-type evidence + claim SCHEMA the planner parameterizes into a
 * `CandidateClaim.soundness` (`MinimalClaim`). Transcribed from the SDD §E
 * worked types (the §5 conjuncts each field feeds): ownership, freshness,
 * source-integrity floor, provenance, and (for actions) the `action_claim`
 * kind. The planner only SELECTS the type + binds runtime params (subject,
 * resources, value); the evidence SHAPE is fixed here — the model never authors
 * it (SDD §O#3 "no model-authored …"; the soundness predicate quantifies over
 * THIS typed structure, never prose — §R topology condition 2).
 */
export interface RegistryClaimSpec {
  /** The §5 claim kind — drives C4 (`action_claim` ⟹ outcome-confirmed). */
  readonly kind: "read_claim" | "action_claim";
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
 * The representative per-type registry schema (SDD §E worked types). Keyed by
 * the closed {@link RegistryClaimType}, so adding a type without its schema is a
 * compile error (`satisfies Record<RegistryClaimType, …>`) — the registry and
 * its evidence schema can never silently diverge.
 */
export const REGISTRY_SPECS = {
  MENU_ITEM_ALLERGENS: {
    kind: "read_claim",
    // SDD §E: free-text "sem alérgenos" must fail → the floor is `structured`.
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "allergens",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "static",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
  },
  // BKL-121 — the full STORE_HOURS validated render chain. The evidence key is
  // aligned VERBATIM with the investigator's STORE_HOURS_KEY ("schedule:store_hours")
  // so the candidate validates against the actual recorded ledger entry; the
  // deriveBoundValue branch (below) + slot-grammar template (slot-grammar.ts) bind the
  // rendered `hoursText` proposition 1:1 to it (Inv 6). Public, single-key type — NOT
  // owner-scoped (no perResourceKey; keys are never `:{subject}`-parameterized).
  STORE_HOURS: {
    kind: "read_claim",
    minSourceIntegrity: "trusted_service",
    requiredEvidence: [
      {
        key: "schedule:store_hours",
        ownershipPolicy: "not_applicable",
        // UNITS (adversarial-review pin): the kernel enforces this in epoch-
        // MILLISECONDS — @adjudicate/core soundness.js freshnessVerdict computes
        // `age = now - entry.fetchedAt` (both Date.now-derived) with NO unit
        // conversion, even though evidence-requirement.d.ts documents ttl as
        // "seconds". A bare `3600` is therefore a 3.6-SECOND window, which a
        // normal claims turn (model latency 5-20s between the investigator read
        // and validation) exceeds — demoting every STORE_HOURS turn to UNKNOWN.
        // 3_600_000 ms = the intended 1-hour staleness bound (vacuous within a
        // per-turn ledger, but honest if entries ever outlive a turn). The
        // doc/enforcement mismatch is upstream (tracker BKL-125).
        freshnessPolicy: { kind: "cacheable", ttl: 3_600_000 },
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    // W6 — a TODAY'S-hours claim (BKL-121 / D1) has TWO honest falsifiers: a present
    // per-date ScheduleOverride OR a present holiday, either of which makes the
    // weekly-schedule-derived hours untrustworthy for today. BOTH are enumerated
    // (honest completeness), so the eligibility cap lets STORE_HOURS reach VALIDATED
    // and the runtime arm demotes it to UNKNOWN when either actually fires this turn.
    // (`schedule:schedule_override` is the SAME key STORE_OPEN_NOW declares — one
    // investigator read serves both.)
    falsifierComplete: true,
    falsifiers: [
      {
        key: "schedule:schedule_override",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
      {
        key: "schedule:holiday",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered value to the read's ACTUAL `hoursText` field
    // (ledger-sourced, never model-authored). `valueBinding.key` stays a member of
    // requiredEvidence so the kernel's C6 structural guard never throws.
    valueBinding: { key: "schedule:store_hours", path: ["hoursText"] },
  },
  // BKL-138 — the DAY-SPECIFIC hours claim (SCN-002/003). The per-date twin of
  // STORE_HOURS: identical evidence/falsifier/value-binding SHAPE, but `perResourceKey`
  // so `selectCandidateClaim` suffixes EVERY key with `:{subject}` (the QUERIED ISO
  // date) → the runtime keys are `schedule:store_hours:{date}` /
  // `schedule:schedule_override:{date}` / `schedule:holiday:{date}`, matching the
  // investigator's DATE-KEYED reads. This is the SCN-003 soundness pin: the falsifiers
  // re-read the QUERIED date, so a holiday/override ON that date demotes to UNKNOWN
  // while TODAY's holiday (recorded under the BARE `schedule:holiday` key STORE_HOURS
  // uses) can NEVER poison a future-date answer — the two never collide. PUBLIC
  // (owned by nobody): all evidence is `not_applicable` ownership, so
  // `ownerScopedBaseKey` is undefined and the subject is the resolved date, never an
  // owner id (its `schedule:*` key matches NO OWNER_SCOPED_KEY_PREFIXES → never an
  // owned resource). Do NOT overload the live-proven TODAY STORE_HOURS (BKL-121 D3):
  // an independent type keeps the two degrade paths decoupled.
  STORE_HOURS_FOR_DATE: {
    kind: "read_claim",
    minSourceIntegrity: "trusted_service",
    requiredEvidence: [
      {
        // SAME base key as STORE_HOURS — but `perResourceKey` suffixes it `:{date}`
        // at select time, so the ledger keys never collide with today's bare entry.
        key: "schedule:store_hours",
        ownershipPolicy: "not_applicable",
        // UNITS (BKL-121 / BKL-125 pin): the kernel enforces `cacheable` ttl in epoch-
        // MILLISECONDS (a bare `3600` = a 3.6s window that demotes every real turn).
        // 3_600_000 ms = the intended 1-hour bound (vacuous within a per-turn ledger).
        freshnessPolicy: { kind: "cacheable", ttl: 3_600_000 },
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    // Suffix every key by the candidate `subject` (the QUERIED ISO date).
    perResourceKey: true,
    // W6 — a per-date override OR a holiday ON THE QUERIED DATE falsifies that date's
    // weekly-schedule hours (BOTH enumerated → honest completeness). The keys are
    // date-suffixed in lockstep with requiredEvidence (`parameterizeKeysBySubject`).
    falsifierComplete: true,
    falsifiers: [
      {
        key: "schedule:schedule_override",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
      {
        key: "schedule:holiday",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered value to the QUERIED date's `hoursText` (ledger-sourced).
    valueBinding: { key: "schedule:store_hours", path: ["hoursText"] },
  },
  // Triad slice — STORE_OPEN_NOW is now GENERATED from its ClaimDefinition source
  // (inv.18 v2). The override-aware evidence + W6 falsifier + C6 value-binding all
  // come from `./claimdefs/store-open-now.generated.ts`, compiled from the single
  // `store-open-now.claim.ts` source. This one line REPLACES the ~30-line handwritten
  // stanza (and can never drift from the template / closure, which are generated too).
  STORE_OPEN_NOW: STORE_OPEN_NOW_REGISTRY_SPEC,
  ORDER_FULFILLMENT_STAGE: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        // STEP 3 key-alignment: the BASE name now matches the investigator's
        // `ORDER_FULFILLMENT_KEY` base (`order_fulfillment_stage`,
        // ibatexas-investigator.ts:162); `selectCandidateClaim` appends `:{subject}`
        // (perResourceKey) so the kernel resolves the actual per-order entry.
        key: "order_fulfillment_stage",
        // Customer-scoped — owner-scoped `getById` (SDD §E / §N P1).
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // The investigator records the schedule-style PER-RESOURCE key — parameterize.
    perResourceKey: true,
    // W6 — a present order CANCELLATION falsifies any in-progress fulfillment stage.
    // DELIBERATELY UNREAD (review ruling 2026-07-17, post-#277): no investigator
    // read populates `order_cancelled` — the only available read derives from the
    // SAME per-turn order row as the base ORDER_FULFILLMENT_STAGE read, so firing
    // it is a tautology that demotes every TRUTHFUL "cancelado" render to UNKNOWN
    // while catching zero staleness the base misses. The declaration stays for a
    // future INDEPENDENT cancellation signal (e.g. the order-events stream);
    // rendering cancellation as a first-class claim is tracked as BKL-160.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "order_cancelled",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered stage to the read's ACTUAL field (ledger-sourced).
    // Wall-2 reconcile (fix 4a): the OrderFulfillmentRead shape field is
    // `fulfillmentStatus` (turn-reads.ts), NOT `stage` — the old `["stage"]` path
    // projected `undefined` on both sides → C6 ABSTAIN → the claim demoted UNKNOWN
    // even for the legit owner. The path now matches the read field so C6 compares
    // a real scalar (the claim-planner adapter, `ibatexas-claim-planner.ts`, binds
    // the owner-scoped candidate value to the SAME present ledger entry →
    // claimSide === evidenceSide → C6 PASSes by construction, without skipping any
    // conjunct: ownership/freshness/falsifiers all still run). `valueBinding.key` stays a member of
    // requiredEvidence (suffixed `:{subject}` in lockstep) so the kernel's C6
    // structural guard never throws.
    valueBinding: { key: "order_fulfillment_stage", path: ["fulfillmentStatus"] },
  },
  PAYMENT_STATUS: {
    kind: "read_claim",
    minSourceIntegrity: "first_party_verified",
    requiredEvidence: [
      {
        key: "payment_status",
        // Ownership required via OrderProjection-join; first-party only money read.
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
    ],
    customerScoped: true,
    // STEP 3 key-alignment: the investigator records `payment_status:{id}`
    // (ibatexas-investigator.ts:164) — parameterize this type's keys by subject.
    perResourceKey: true,
    // W6 — a `paid` payment status is falsified by a present refund OR chargeback
    // (opposite money direction). BOTH are enumerated (honest completeness).
    falsifierComplete: true,
    falsifiers: [
      {
        key: "payment_refund",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
      {
        key: "payment_chargeback",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
    ],
    // C6 — bind the rendered status to the read's `status` field (ledger-sourced).
    valueBinding: { key: "payment_status", path: ["status"] },
  },
  // FE-T17 — the reservation-status read. Owner-scoped + per-resource, mirroring
  // ORDER_FULFILLMENT_STAGE exactly: the base key `reservation_status` matches the
  // investigator's `RESERVATION_KEY` (ibatexas-investigator.ts) and the owner-scope
  // wiring already declared for it in `OWNER_SCOPED_KEY_PREFIXES` / FIX 2's
  // `ownerScopedBaseKey` (ibatexas-claims-kernel-deps.ts / ibatexas-planner.ts) — both
  // pre-date this row and needed no change to pick it up.
  RESERVATION_STATUS: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "reservation_status",
        // Ownership required via the reservation service's owner-scoped getById.
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // Parameterize by subject — matches the investigator's `reservation_status:{id}`.
    perResourceKey: true,
    // W6 — a present reservation CANCELLATION falsifies an in-progress reservation
    // status read. DELIBERATELY UNREAD (review ruling 2026-07-17, post-#277) —
    // same-row tautology as ORDER_FULFILLMENT_STAGE's `order_cancelled` (see that
    // type's note): the only available read shares the base read's per-turn
    // reservation memo, so firing it would demote every truthful "cancelada"
    // render while catching nothing. Declaration retained for a future
    // INDEPENDENT signal; render-vs-demote decision = BKL-160.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "reservation_cancelled",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered scalar to the read's pre-composed `statusLine`
    // (BKL-185, the ORDER_HISTORY serialized-scalar idiom): status + optional
    // "— DD/MM às HH:MM, para N pessoa(s)" detail, composed DETERMINISTICALLY in
    // the read (turn-reads.ts composeReservationStatusLine — no clock, no model).
    // Detail-absent → the scalar IS the bare status → the render is byte-identical
    // to the pre-BKL-185 status-only form. Ledger-sourced, never model-authored.
    valueBinding: { key: "reservation_status", path: ["statusLine"] },
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
  CART_CONTENTS: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "cart_contents",
        // Ownership required — the cart is the authenticated customer's own
        // (session-resolved, never a model id); the owner-scope wiring gates it.
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // Parameterize by subject — matches the investigator's `cart_contents:{customerId}`.
    perResourceKey: true,
    // W6 — the `cart_cleared` falsifier is DECLARED (so CART_CONTENTS escapes the W6
    // UNKNOWN-only cap and can VALIDATE), but DELIBERATELY UNREAD by the investigator —
    // the SAME disposition as ORDER_FULFILLMENT_STAGE's `order_cancelled` /
    // RESERVATION_STATUS's `reservation_cancelled` after their review-fix: a
    // same-cart-row "cleared" signal is tautological AND inert (a cleared/checked-out
    // cart already reads `hasItems: false` ⇒ `cart_contents` ABSENT ⇒ no present base to
    // demote). Declaring-without-reading is sound: the runtime arm resolves an
    // always-absent key ⇒ never fires ⇒ demote-only safety is preserved.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "cart_cleared",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered summary to the read's PRE-COMPOSED `itemsSummaryText`
    // field (ledger-sourced, deterministic; never model-authored).
    valueBinding: { key: "cart_contents", path: ["itemsSummaryText"] },
  },
  // BKL-163 — CART_EMPTY: the provably-empty cart twin of CART_CONTENTS. The SAME
  // owner-scoped, must_read_this_turn, perResourceKey shape (subject = the
  // authenticated customerId), but its evidence key `cart_empty:{customerId}` is
  // recorded PRESENT by the investigator ONLY when the cart read resolved
  // `hasItems: false` — presence IS the provable-empty proposition, so the pair is
  // complementary by construction (a cart with items leaves `cart_empty` ABSENT ⇒
  // this claim resolves UNKNOWN ⇒ dropped when CART_CONTENTS validates; an empty
  // cart leaves `cart_contents` ABSENT ⇒ CART_CONTENTS drops and THIS renders).
  // The C6 proposition is a DETERMINISTIC code-composed scalar (`emptinessText`,
  // the literal "vazio") — never model-authored.
  CART_EMPTY: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "cart_empty",
        // Ownership required — the (empty) cart is the authenticated customer's own
        // (session-resolved, never a model id); the owner-scope wiring gates it.
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // Parameterize by subject — matches the investigator's `cart_empty:{customerId}`.
    perResourceKey: true,
    // W6 — `cart_item_added` is DECLARED (so CART_EMPTY escapes the W6 UNKNOWN-only
    // cap and can VALIDATE) but DELIBERATELY UNREAD — the exact CART_CONTENTS
    // `cart_cleared` disposition: a same-cart-row "item added" signal is tautological
    // AND inert (a cart that gained an item already reads `hasItems: true` ⇒
    // `cart_empty` ABSENT ⇒ no present base to demote). Declaring-without-reading is
    // sound: the runtime arm resolves an always-absent key ⇒ never fires ⇒
    // demote-only safety preserved.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "cart_item_added",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered scalar to the read's code-composed `emptinessText`
    // field (ledger-sourced, deterministic; never model-authored).
    valueBinding: { key: "cart_empty", path: ["emptinessText"] },
  },
  // FE-D03 slice C — ORDER_HISTORY: the owner-scoped list read ("meu histórico de
  // pedidos"). Structurally the CART_CONTENTS idiom (owner-scoped, must_read_this_turn,
  // perResourceKey by the authenticated customerId), but its C6 proposition is a
  // DETERMINISTICALLY PRE-COMPOSED bounded most-recent-N summary scalar
  // (historySummaryText, "Pedido #1042 (entregue, R$89,00), … — mostrando os N mais
  // recentes") derived from order listByCustomer (owner-scoped). The
  // `order_history_changed` falsifier is DECLARED (so ORDER_HISTORY escapes the W6
  // UNKNOWN-only cap and can VALIDATE) but DELIBERATELY UNREAD — the CART_CONTENTS
  // `cart_cleared` disposition: the summary is a must_read_this_turn SNAPSHOT that
  // already reflects each order's current status, so a same-read "changed" signal is
  // tautological AND inert (an always-absent key never fires; demote-only safety holds).
  ORDER_HISTORY: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "order_history",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // Parameterize by subject — matches the investigator's `order_history:{customerId}`.
    perResourceKey: true,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "order_history_changed",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered summary to the read's PRE-COMPOSED `historySummaryText`.
    valueBinding: { key: "order_history", path: ["historySummaryText"] },
  },
  // FE-D03 slice C — PAYMENT_HISTORY: the owner-scoped payment-list read ("meus últimos
  // pagamentos"). The exact ORDER_HISTORY shape over payment listByCustomer (owner-scoped
  // via the Payment→OrderProjection.customerId join; includes terminal/refunded rows —
  // it is billing HISTORY). `payment_history_changed` is likewise DECLARED-but-UNREAD:
  // must_read_this_turn re-reads each payment's current status (incl. refunded/disputed —
  // the same facts BKL-006's per-order refund/chargeback probes surface), so the summary
  // already reflects them and a separate falsifier would demote a snapshot that is
  // already current — no independent cross-read contradiction (re-verified: the refund/
  // chargeback probes are per-ORDER and this is a per-CUSTOMER snapshot; wiring them
  // here would be tautological). Declared-unread, mirroring cart_cleared.
  PAYMENT_HISTORY: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "payment_history",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    perResourceKey: true,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "payment_history_changed",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "payment_history", path: ["historySummaryText"] },
  },
  // BKL-142 — MENU_ITEM_PRICE: a PUBLIC per-item catalog read. Clones
  // STORE_HOURS_FOR_DATE's public (`not_applicable`, `perResourceKey`) shape + the
  // CART_CONTENTS pre-composed-scalar `valueBinding` (`priceText`, "R$ 89,00" composed
  // in code from integer centavos — Hard Rule 2, NEVER model-authored). The subject is
  // the RESOLVED product id (the shared menu-item-resolver.ts drives BOTH the claim
  // planner's candidate subject AND the investigator's `menu:item_price:{id}` key, so
  // they match by construction); an unresolvable item → no candidate/absent evidence →
  // honest UNKNOWN, never an arbitrary product.
  MENU_ITEM_PRICE: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "menu:item_price",
        ownershipPolicy: "not_applicable",
        // UNITS (BKL-121/BKL-125 pin): `cacheable` ttl is enforced in epoch-MILLISECONDS.
        // 300_000 ms = the ratified 5-minute catalog-freshness bound (vacuous within a
        // per-turn ledger, honest if an entry ever outlives a turn).
        freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    perResourceKey: true,
    // W6 — `menu:item_unpublished` is DECLARED (so this type escapes the W6 UNKNOWN-only
    // cap and can VALIDATE) but DELIBERATELY UNREAD by the investigator — the SAME
    // disposition CART_CONTENTS's `cart_cleared` / ORDER_FULFILLMENT_STAGE's
    // `order_cancelled` took after the #290/#291 review: a "this product row is
    // unpublished" signal derived from the SAME product row the price came from is a
    // TAUTOLOGY (an unpublished item already reads ABSENT ⇒ no present base to demote)
    // AND would re-introduce the exact same-row-tautology class those PRs removed.
    // Declaring-without-reading is sound: the runtime arm resolves an always-absent key
    // ⇒ never fires ⇒ demote-only safety is preserved. A future INDEPENDENT signal (a
    // catalog `product.unpublished` event, not this row) could wire the read.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "menu:item_unpublished",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "menu:item_price", path: ["priceText"] },
  },
  // BKL-142 — MENU_ITEM_CONTENTS: same PUBLIC per-item shape, C6-bound to the
  // first-party `contentsText` (the product description). Same deliberately-unread
  // `menu:item_unpublished` falsifier disposition as MENU_ITEM_PRICE.
  MENU_ITEM_CONTENTS: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "menu:item_contents",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    perResourceKey: true,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "menu:item_unpublished",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "menu:item_contents", path: ["contentsText"] },
  },
  // BKL-214 — MENU_DIETARY: the PUBLIC dietary-preference read. Same PUBLIC per-item
  // shape as MENU_ITEM_PRICE/CONTENTS (perResourceKey, ownershipPolicy not_applicable),
  // but the "resource id" is the dietary TAG (vegetariano/vegano). C6-bound to the
  // pre-composed `dietaryText` (first-party tagged-product titles, menu-item-resolver.ts).
  // Same deliberately-unread `menu:item_unpublished` falsifier disposition. Empty tag →
  // ABSENT evidence → honest UNKNOWN (never a fabricated "we have vegetarian options").
  MENU_DIETARY: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "menu:dietary",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    perResourceKey: true,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "menu:item_unpublished",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "menu:dietary", path: ["dietaryText"] },
  },
  // BKL-142 — MENU_OVERVIEW: the menu-WIDE overview ("o que tem no cardápio?"). PUBLIC
  // and FIXED-SUBJECT like STORE_HOURS (single key, NOT perResourceKey) — the evidence
  // is a deterministic listing of the whole catalog, not a per-item read. C6-bound to a
  // pre-composed scalar (`overviewText` — first-party titles + centavos prices, composed
  // in menu-item-resolver.ts; NO allergen/dietary — those stay carved out). Same
  // deliberately-unread `menu:item_unpublished` falsifier disposition as the per-item
  // menu claims.
  MENU_OVERVIEW: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "menu:overview",
        ownershipPolicy: "not_applicable",
        // ttl in epoch-MILLISECONDS (BKL-121/BKL-125 pin) — 300_000 ms = the ratified
        // 5-minute catalog-freshness bound (vacuous within a per-turn ledger).
        freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    // W6 — `menu:item_unpublished` is DECLARED (so MENU_OVERVIEW escapes the W6
    // UNKNOWN-only cap and can VALIDATE) but DELIBERATELY UNREAD — the SAME disposition
    // the per-item menu claims + CART_CONTENTS's `cart_cleared` took after the #290/#291
    // review: an "unpublished item" signal derived from the SAME catalog rows the
    // overview came from is a same-row TAUTOLOGY (an unpublished item already reads
    // ABSENT from the published listing ⇒ no present base to demote) that would
    // re-introduce the exact class those PRs removed. Declaring-without-reading is sound:
    // the runtime arm resolves an always-absent key ⇒ never fires ⇒ demote-only safety
    // preserved. A future INDEPENDENT catalog `product.unpublished` event could wire it.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "menu:item_unpublished",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "menu:overview", path: ["overviewText"] },
  },
  // BKL-136 — STORE_INFO: the store address/parking read ("onde fica?"). PUBLIC
  // fixed-subject single-key like MENU_OVERVIEW (`ownershipPolicy: not_applicable`,
  // NOT perResourceKey), cacheable at the same 5-minute config-freshness bound. The
  // `store:info_changed` falsifier is DECLARED (escapes the W6 UNKNOWN-only cap so
  // STORE_INFO can VALIDATE) but DELIBERATELY UNREAD — the MENU_OVERVIEW
  // `menu:item_unpublished` disposition: a "changed" signal derived from the SAME
  // store row the info came from is the same-row tautology #290/#291 removed (a
  // changed address already reads as the NEW `infoText` — there is no stale present
  // base to demote within a must-read turn). A future INDEPENDENT store-config
  // change event could wire the read.
  STORE_INFO: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "store:info",
        ownershipPolicy: "not_applicable",
        // ttl in epoch-MILLISECONDS (BKL-121/BKL-125 pin) — 300_000 ms = the same
        // 5-minute config-freshness bound MENU_OVERVIEW ratified (vacuous within a
        // per-turn ledger).
        freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "store:info_changed",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "store:info", path: ["infoText"] },
  },
  // LE2-002 / NEW-007 — DELIVERY_COVERAGE: the PUBLIC "we deliver there" read.
  // FIXED-SUBJECT single-key (the STORE_INFO / MENU_OVERVIEW shape — no
  // perResourceKey, keys are never `:{subject}`-parameterized): a coverage answer
  // is about the STORE's delivery policy, so there is one key and no owner.
  // `must_read_this_turn` (NOT cacheable): the fee/ETA are ADMIN-EDITABLE at any
  // moment (routes/admin/delivery-zones.ts) and the ticket requires an admin zone
  // edit to show up in the very next chat answer — a cacheable TTL would license
  // the kernel to accept a stale entry, which is exactly the staleness this claim
  // must not have. The `delivery:zones_changed` W6 falsifier is DECLARED (escaping
  // the W6 UNKNOWN-only cap so the type can VALIDATE) but DELIBERATELY UNREAD —
  // the same disposition STORE_INFO's `store:info_changed` and CART_CONTENTS's
  // `cart_cleared` carry, and for the same reason: the only available "changed"
  // signal derives from the SAME zone row the base read already returned this turn,
  // so firing it would be a tautology that demotes every truthful answer while
  // catching zero staleness the base misses. The declaration stays for a future
  // INDEPENDENT signal (a zone-events stream / the Redis invalidation pub-sub).
  DELIVERY_COVERAGE: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "delivery:coverage",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "delivery:zones_changed",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered sentence to the read's ACTUAL `coverageText`, the
    // scalar delivery-coverage-resolver.ts composes IN CODE from the zone row's
    // INTEGER centavos + minutes (Hard Rule 2). Ledger-sourced, never model-authored.
    valueBinding: { key: "delivery:coverage", path: ["coverageText"] },
  },
  // LE2-002 / NEW-007 — DELIVERY_NO_COVERAGE: the presence-COMPLEMENT of
  // DELIVERY_COVERAGE (the CART_CONTENTS/CART_EMPTY pairing, BKL-163). The
  // investigator records `delivery:no_coverage` PRESENT *only* when the estimation
  // tool positively proved the supplied CEP falls outside every active zone, so
  // exactly ONE of the pair can ever be present in a turn. A read that ERRORED or
  // could not resolve records NEITHER key → honest UNKNOWN (Inv 7: "could not
  // check" is never "we don't deliver").
  DELIVERY_NO_COVERAGE: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "delivery:no_coverage",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    falsifierComplete: true,
    falsifiers: [
      {
        key: "delivery:zones_changed",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    valueBinding: { key: "delivery:no_coverage", path: ["noCoverageText"] },
  },
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

/**
 * The CLOSED safety-marker taxonomy (SDD §O#9; §O#8; Inv 8). The set of
 * health/safety markers that have a RECOGNIZED, modeled routing. Closed by
 * construction — anything NOT in this set is, by definition, unrecognized and
 * routes to the generic safe terminal (`ESCALATE`). REPRESENTATIVE (SDD §Q
 * scope guard); the full adversarial marker taxonomy is the deferred follow-on.
 *
 * NOTE (SDD §O#9): `harassment` and `medical-emergency` have NO typed terminal
 * yet, so they are DELIBERATELY ABSENT from this recognized set — they fall
 * through to the `ESCALATE` default, which is exactly the spec's instruction
 * ("route to ESCALATE"). A recognized NON-safety request (no marker) is not
 * over-escalated.
 */
const RECOGNIZED_SAFETY_MARKERS: ReadonlySet<string> = new Set<string>([
  // Recognized, modeled safety markers with a known conservative routing. Kept
  // representative; each still routes to ESCALATE here (no non-escalate typed
  // terminal exists yet), but membership documents that the taxonomy KNOWS them
  // — the point of §O#9 is that an UNKNOWN marker is not treated as ordinary.
  "allergen-severe-reaction",
  "foodborne-illness",
]);

/** A claim a safety request may carry past routing (when no marker fires). */
export interface SafetyRoutingInput {
  /**
   * The safety markers the detector (SDD §O#8 — a bounded probabilistic input)
   * flagged on the request. EMPTY for an ordinary, non-safety request.
   */
  readonly markers: readonly string[];
}

/**
 * The §O#9 closed-taxonomy safety router (SDD §O#9 · Inv 8; §8). Closed by
 * construction: if ANY flagged marker is unrecognized (not in the closed
 * {@link RECOGNIZED_SAFETY_MARKERS}), or any recognized marker fired, the turn
 * routes to `ESCALATE` — the generic safe terminal. It NEVER passes an
 * unrecognized health/safety framing through as ordinary text (the §O#9
 * NEW_HOLE: "default-to-safe on any unrecognized health/safety marker").
 *
 *   - markers `[]`                      → `undefined` (NOT over-escalated — an
 *                                          ordinary request proceeds normally).
 *   - any recognized OR unrecognized marker present → `"ESCALATE"`.
 *
 * Because the taxonomy is closed, an attacker-crafted novel marker string is
 * unrecognized → `ESCALATE` by default — there is no pass-through escape. Pure;
 * returns the forced turn terminal (or `undefined` when nothing is flagged).
 */
export function routeSafety(
  input: SafetyRoutingInput,
): Extract<TurnTerminal, "ESCALATE"> | undefined {
  if (input.markers.length === 0) {
    // Ordinary, non-safety request — no marker flagged → not over-escalated.
    return undefined;
  }
  // Any flagged marker — recognized or not — routes to the safe terminal. The
  // closed-by-construction default: an UNRECOGNIZED marker is ESCALATE, never
  // pass-through. (Recognized markers also ESCALATE today — there is no
  // non-escalate typed terminal yet; SDD §O#9 harassment/medical-emergency.)
  for (const marker of input.markers) {
    if (!RECOGNIZED_SAFETY_MARKERS.has(marker)) {
      // The unrecognized-marker default — the §O#9 NEW_HOLE close.
      return "ESCALATE";
    }
  }
  // All flagged markers are recognized safety markers — still ESCALATE (the
  // conservative safe terminal; no typed non-escalate terminal exists yet).
  return "ESCALATE";
}
