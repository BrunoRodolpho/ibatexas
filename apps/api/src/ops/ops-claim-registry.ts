// ops-claim-registry.ts — the OPS-SCOPED claim types (LE2 ticket 12; spec
// Implementation Decision 6: "store-level questions need claim types the
// customer-scoped registry doesn't have").
//
// LE2-011 converged the ops conductor onto the claims pipeline but deliberately
// left it speaking the CUSTOMER vocabulary ("ops-scoped claim TYPES are ticket 12,
// not this skeleton" — ops-conductor.ts). This module is that vocabulary: three
// STORE-LEVEL read types the operator actually asks about, each registered exactly
// like a customer type (evidence schema → resolver read → C6 value-binding →
// validated template), and each unreachable from the customer plane.
//
// ── The plane boundary (ticket AC 4) ─────────────────────────────────────────
// There is no second mechanism. `ClaimPlaneScope` (claim-registry.ts) makes the
// EXISTING §H/§P3 constrained-generation wall carry the boundary:
//   · the customer planner advertises `CUSTOMER_CLAIM_SCOPE.types` — the ops types
//     are absent, so the 4B cannot even SELECT one; and
//   · `selectCandidateClaim` resolves against the caller's scope, so a
//     customer-plane proposal of an ops type canonicalizes to `undefined` and is
//     DROPPED exactly like a hallucinated type (defense in depth for a compromised
//     prompt that bypasses the enum).
// The ops templates likewise live HERE, not in the customer `VALIDATED_TEMPLATES`,
// so the customer renderer has no way to emit one. `ops-claims-scope.test.ts` pins
// both directions.
//
// ── Grounding (ticket AC 1) ──────────────────────────────────────────────────
// Every resolver reads THROUGH the existing ops read roster (`ops_snapshot` /
// `ops_sales_analytics` — the BKL-100/BKL-149 deterministic read machinery), never
// a new direct DB path. The read composers already degrade PER SIGNAL and report
// which signals fell back (`degraded[]`), which is what lets these types honour the
// two honesty rules the ticket demands:
//   · an EMPTY read that SUCCEEDED is a FACT → a VALIDATED "nenhum/nenhuma" render
//     (AC 2), never an UNKNOWN;
//   · a DEGRADED/ERRORED read is NOT a zero → the resolver THROWS → the
//     investigator records a ledger ERROR (Inv 7) → the claim degrades through the
//     skeleton's safe-unknown gate with ZERO invented digits (AC 3).
//
// pt-BR per Hard Rule #4; the scalars reuse `ops-read-render.ts`'s existing
// panorama vocabulary verbatim so the two ops surfaces never drift.

import {
  CLAIM_REGISTRY,
  CUSTOMER_CLAIM_SCOPE,
  REGISTRY_SPECS,
  type ClaimPlaneScope,
  type DietaryPosture,
  type RegistryClaimSpec,
} from "../claustrum/claim-registry.js";
import {
  CLAIM_DEFINITIONS,
  assembleClaimDefinition,
  validateClaimDefinitionRegistry,
} from "../claustrum/claim-definition-registry.js";
import { REQUIRED_CLAIM_CLOSURE } from "../claustrum/required-claim-decomposer.js";
import {
  DELIVERY_COVERAGE,
  DELIVERY_NO_COVERAGE,
  VALIDATED_TEMPLATES,
  type Template,
  type TemplateSlot,
} from "../claustrum/slot-grammar.js";

// ── The registry enum ────────────────────────────────────────────────────────

/**
 * OPS_ORDERS_TODAY — "quantos pedidos hoje?" The store's order COUNT for the
 * current business day, resolved through `ops_sales_analytics`.
 */
export const OPS_ORDERS_TODAY = "OPS_ORDERS_TODAY";
/**
 * OPS_PENDING_ESCALATIONS — "tem escalação pendente?" The store's OPEN operational
 * attention queue, resolved through `ops_snapshot`.
 */
export const OPS_PENDING_ESCALATIONS = "OPS_PENDING_ESCALATIONS";
/**
 * OPS_RESERVATIONS_TODAY — "quais reservas hoje?" Today's reservation total + the
 * per-status tally, resolved through `ops_snapshot`.
 */
export const OPS_RESERVATIONS_TODAY = "OPS_RESERVATIONS_TODAY";

/**
 * The closed OPS-ONLY claim-type enum. DISJOINT from `CLAIM_REGISTRY` by
 * construction (pinned) — these are the types the customer registry cannot
 * express, and must never gain.
 */
export const OPS_CLAIM_REGISTRY = [
  OPS_ORDERS_TODAY,
  OPS_PENDING_ESCALATIONS,
  OPS_RESERVATIONS_TODAY,
] as const;

/** An ops-only claim TYPE name (a member of {@link OPS_CLAIM_REGISTRY}). */
export type OpsClaimType = (typeof OPS_CLAIM_REGISTRY)[number];

// ── Ledger evidence keys (aligned VERBATIM with the resolvers) ────────────────
//
// FIXED-SUBJECT, single-key types (the STORE_HOURS / MENU_OVERVIEW / STORE_INFO
// shape): the store is the only subject, so NO `perResourceKey` and NO
// `:{subject}` parameterization — the key the resolver records IS the key the
// kernel resolves. Namespaced `ops:` so an ops read can never collide with a
// customer read key.

/** Evidence key for {@link OPS_ORDERS_TODAY} (resolver: `ops_sales_analytics`). */
export const OPS_ORDERS_TODAY_KEY = "ops:orders_today";
/** Evidence key for {@link OPS_PENDING_ESCALATIONS} (resolver: `ops_snapshot`). */
export const OPS_PENDING_ESCALATIONS_KEY = "ops:pending_escalations";
/** Evidence key for {@link OPS_RESERVATIONS_TODAY} (resolver: `ops_snapshot`). */
export const OPS_RESERVATIONS_TODAY_KEY = "ops:reservations_today";

/**
 * The C6-bound FIELD each type's resolver composes and each template renders. One
 * DETERMINISTICALLY PRE-COMPOSED pt-BR scalar per type — the CART_CONTENTS /
 * STORE_INFO "serialized scalar under the frozen single-C6-field kernel" idiom, so
 * a count-plus-tally reads as ONE ledger-bound proposition and the model authors
 * none of it.
 */
export const OPS_ORDERS_TODAY_FIELD = "ordersTodayText";
export const OPS_PENDING_ESCALATIONS_FIELD = "escalationsText";
export const OPS_RESERVATIONS_TODAY_FIELD = "reservationsTodayText";

// ── The per-type registry schema ─────────────────────────────────────────────

/**
 * Build the SHARED ops read-claim spec. All three types are structurally identical
 * — the only differences are the evidence key and the C6-bound field — so the
 * shape is written ONCE and the three rows below only name their key/field. That
 * makes the justification auditable in one place:
 *
 *   · `kind: "read_claim"` — a store-state READ, never an action outcome.
 *   · `ownershipPolicy: "not_applicable"` — a STORE-LEVEL fact, owned by nobody
 *     (the STORE_HOURS / STORE_INFO posture). The staff actor's authority to ASK
 *     is enforced upstream by the ops plane itself (JWT-authenticated staffId +
 *     the staff role guard); it is NOT an ownership predicate over a resource, so
 *     claiming `required` here would be a false ownership assertion.
 *   · `freshnessPolicy: "must_read_this_turn"` — operational figures are LIVE.
 *     Deliberately NOT `cacheable`: an operator acting on "pedidos hoje" needs the
 *     number as of now, and a stale-but-in-TTL answer is exactly the confabulation
 *     class BKL-100 closed on this plane.
 *   · `sourceIntegrity: "structured"` + `provenancePolicy: "preserve"` — the reads
 *     are first-party composers over first-party services; the resolver stamps
 *     `originProvenance: "FIRST_PARTY"` on the ledger entry (the CART_CONTENTS /
 *     ORDER_HISTORY posture).
 *   · `customerScoped: false` — the Q4 consistency partition is the STORE, not a
 *     customer. (This is also what keeps the §O#15 customer-companion scoping in
 *     `claims-renderer-adapter.ts` from ever touching an ops type.)
 *   · `falsifierComplete: true` + one DECLARED-BUT-DELIBERATELY-UNREAD falsifier —
 *     see {@link opsSupersededFalsifierKey}.
 *   · `valueBinding` — the rendered scalar is bound to the resolver's OWN recorded
 *     ledger entry, so C6 compares a first-party value against itself and the
 *     model can never author a number (the tag-then-derive contract).
 */
function opsReadClaimSpec(
  key: string,
  field: string,
  dietaryPosture: DietaryPosture,
): RegistryClaimSpec {
  return {
    kind: "read_claim",
    // BKL-270 — a PARAMETER, deliberately, not a constant baked into the factory.
    // Three ops types share this factory; hardcoding the posture would lock all
    // three to one value forever, and a future ops read that genuinely needs a
    // different one would have to either fork the factory or (far more likely)
    // silently inherit the wrong posture. That silent-inheritance class is exactly
    // what BKL-270 exists to remove, so the factory refuses to decide.
    dietaryPosture,
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key,
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    // W6 — DECLARED so the type escapes the falsifier-completeness UNKNOWN-only cap
    // and can reach VALIDATED, but DELIBERATELY UNREAD: the SAME disposition
    // CART_CONTENTS's `cart_cleared` / MENU_OVERVIEW's `menu:item_unpublished` took
    // after the #290/#291 review. A "superseded" signal derived from the SAME
    // must_read_this_turn snapshot the figure came from is a same-row TAUTOLOGY (a
    // changed count already reads as the NEW count — there is no stale present base
    // to demote). Declaring-without-reading is sound: the runtime arm resolves an
    // always-absent key ⇒ never fires ⇒ demote-only safety preserved.
    //
    // What ACTUALLY protects these types is STRICTLY STRONGER than a demote-only
    // falsifier: the resolver fail-CLOSES at the READ. A composer signal that
    // degraded to its zero fallback (`degraded[]`) or a shape that fails the
    // structural guard makes the resolver THROW → `ledger.recordError` (Inv 7) →
    // the base evidence is an ERROR, not a present zero → the claim can never
    // VALIDATE a fabricated figure. A future INDEPENDENT supersession signal (an
    // ops event stream, not this snapshot) could wire the read.
    falsifierComplete: true,
    falsifiers: [
      {
        key: opsSupersededFalsifierKey(key),
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered proposition to the resolver's PRE-COMPOSED scalar
    // (ledger-sourced, deterministic; never model-authored).
    valueBinding: { key, path: [field] },
  };
}

/** The declared-but-unread W6 falsifier key for an ops evidence key. Pure. */
function opsSupersededFalsifierKey(key: string): string {
  return `${key}_superseded`;
}

/**
 * The ops-only registry schema, keyed by the closed {@link OpsClaimType} — so
 * adding a type without its schema is a COMPILE error (`satisfies`), exactly like
 * the customer `REGISTRY_SPECS`.
 */
// BKL-270 — all three ops reads declare `answer-anyway`, and the reason is the
// PLANE rather than the render: BKL-143's forbidden implication is about what a
// CUSTOMER is told, and this plane speaks to STAFF. None of the three renders food
// in any case (they are counts and a pending-escalation figure), so both arguments
// point the same way. The field is declared here — not made optional for non-customer
// planes — because an optional field is precisely the silence Option C removes: the
// ops plane must STATE its posture, even when the answer is easy.
export const OPS_REGISTRY_SPECS = {
  [OPS_ORDERS_TODAY]: opsReadClaimSpec(
    OPS_ORDERS_TODAY_KEY,
    OPS_ORDERS_TODAY_FIELD,
    "answer-anyway",
  ),
  [OPS_PENDING_ESCALATIONS]: opsReadClaimSpec(
    OPS_PENDING_ESCALATIONS_KEY,
    OPS_PENDING_ESCALATIONS_FIELD,
    "answer-anyway",
  ),
  [OPS_RESERVATIONS_TODAY]: opsReadClaimSpec(
    OPS_RESERVATIONS_TODAY_KEY,
    OPS_RESERVATIONS_TODAY_FIELD,
    "answer-anyway",
  ),
} satisfies Record<OpsClaimType, RegistryClaimSpec>;

// ── The templates (pt-BR; Inv 6 1:1) ─────────────────────────────────────────

const lit = (text: string): TemplateSlot => ({ kind: "LITERAL", text });
const prop = (claimType: string, field: string): TemplateSlot => ({
  kind: "PROPOSITION",
  claimType,
  field,
});

/**
 * The ops-only validated templates. Each is a STATIC pt-BR frame around EXACTLY
 * ONE proposition slot bound 1:1 to that type's C6 `valueBinding` field (Inv 6) —
 * the single-C6-field shape every post-#291 type uses (the frozen kernel drops
 * every sibling read field post-mint, so a second slot would be permanently
 * unfillable and abort the whole template to UNKNOWN).
 *
 * The frames are the SAME pt-BR the deterministic panorama render already speaks
 * (`ops-read-render.ts`: "- Reservas de hoje: nenhuma.", "- Pedidos: N"), so an
 * operator sees one vocabulary regardless of which surface answered.
 */
export const OPS_VALIDATED_TEMPLATES: Readonly<Record<string, Template>> = {
  [OPS_ORDERS_TODAY]: {
    claimType: OPS_ORDERS_TODAY,
    posture: "validated",
    slots: [
      lit("Pedidos de hoje: "),
      prop(OPS_ORDERS_TODAY, OPS_ORDERS_TODAY_FIELD),
      lit("."),
    ],
  },
  [OPS_PENDING_ESCALATIONS]: {
    claimType: OPS_PENDING_ESCALATIONS,
    posture: "validated",
    slots: [
      lit("Escalações operacionais pendentes: "),
      prop(OPS_PENDING_ESCALATIONS, OPS_PENDING_ESCALATIONS_FIELD),
      lit("."),
    ],
  },
  [OPS_RESERVATIONS_TODAY]: {
    claimType: OPS_RESERVATIONS_TODAY,
    posture: "validated",
    slots: [
      lit("Reservas de hoje: "),
      prop(OPS_RESERVATIONS_TODAY, OPS_RESERVATIONS_TODAY_FIELD),
      lit("."),
    ],
  },
};

// ── LE2-013 — PLANE-SCOPED PHRASING OVERRIDES (customer types, staff voice) ──

/**
 * Templates for CUSTOMER-registered claim types whose customer COPY is a
 * non-sequitur when voiced at a staff member. The type, its evidence, its C6
 * value binding and the PROPOSITION it asserts are IDENTICAL on both planes —
 * only the static LITERAL frame differs. This is the LE2-012
 * `SafeUnknownGateOptions.closedHoursOffer` precedent generalized: same fact,
 * same grounding, plane-appropriate frame.
 *
 * ── The delivery pair (ticket 13's demo, tracker NEW-007) ────────────────────
 * "Vocês entregam em Ibaté?" asked on the OPS thread is the original incident.
 * The SCOPE DECISION it forces is deliberate, and the mechanism made it explicit
 * rather than accidental: `DELIVERY_COVERAGE` / `DELIVERY_NO_COVERAGE` are
 * CUSTOMER-registered types, and {@link OPS_CLAIM_SCOPE} is `customer ∪ ops` by
 * construction — so the pair is PLANE-SHARED, already selectable, groundable
 * (the ops gatherer unions `createFirstPartyTurnReads`, whose delivery read sits
 * BEFORE the authenticated-customer gate) and renderable on ops. We keep it that
 * way rather than minting `OPS_DELIVERY_COVERAGE` twins: coverage is ONE store
 * policy read off ONE zones projection, and a second type would be a second
 * source of truth for the same fact — the exact drift `ops ⊃ customer` exists to
 * prevent. Nothing moves out of `CLAIM_REGISTRY`, so the customer counts and
 * every customer pin are untouched; the ops-scope count moves not at all.
 *
 * What DOES change is the frame:
 *   · YES — customer copy appends "Confirmo certinho pelo endereço no checkout."
 *     That describes what the system does for A CUSTOMER at THEIR checkout; the
 *     operator asking is the person who RUNS the checkout. Ops ships the bare
 *     grounded scalar (zone + fee + ETA) and nothing else — exactly the
 *     `closedHoursOffer: false` posture.
 *   · NO  — customer copy appends "mas você pode retirar aqui no restaurante".
 *     Offering pickup to the staff of the restaurant is the same non-sequitur.
 *     Ops ships the bare validated negative.
 *
 * BOUNDED BY CONSTRUCTION: {@link opsTemplateOverrideProblems} fail-CLOSES the ops
 * claims pipeline unless every override's PROPOSITION slots match the customer
 * template's exactly (same claimType, same field, same order). An override may
 * therefore only ever re-frame — it can never change, add or drop an assertion,
 * so the two planes can never disagree about a FACT, only about phrasing.
 */
export const OPS_PLANE_TEMPLATE_OVERRIDES: Readonly<Record<string, Template>> = {
  [DELIVERY_COVERAGE]: {
    claimType: DELIVERY_COVERAGE,
    posture: "validated",
    slots: [prop(DELIVERY_COVERAGE, "coverageText"), lit(".")],
  },
  [DELIVERY_NO_COVERAGE]: {
    claimType: DELIVERY_NO_COVERAGE,
    posture: "validated",
    slots: [prop(DELIVERY_NO_COVERAGE, "noCoverageText"), lit(".")],
  },
};

/** The PROPOSITION slots of a template, as comparable `claimType.field` tags. Pure. */
function propositionSignature(template: Template | undefined): readonly string[] {
  return (template?.slots ?? [])
    .filter(
      (slot): slot is Extract<TemplateSlot, { kind: "PROPOSITION" }> =>
        slot.kind === "PROPOSITION",
    )
    .map((slot) => `${slot.claimType}.${slot.field}`);
}

/**
 * FAIL-CLOSED guard over {@link OPS_PLANE_TEMPLATE_OVERRIDES}: an override must
 * re-frame a CUSTOMER template, never re-assert it. Returns human-readable
 * problems; empty = healthy. Checks, per override:
 *
 *   1. the overridden type IS a customer-registered type with a customer template
 *      (an override of nothing is drift, not a decision);
 *   2. it is NOT an ops-only type (those own their template outright — an entry
 *      here would be a second, shadowing definition);
 *   3. its PROPOSITION slot signature is IDENTICAL to the customer template's.
 *
 * (3) is the load-bearing one: the plane's `ClaimDefinition` (and therefore its
 * §5-gated `valueProjections`) is assembled from the CUSTOMER template, so an
 * override that changed a slot's `field` would render a projection the definition
 * never licensed — an unbacked proposition, inv.18's whole point. Pure.
 */
export function opsTemplateOverrideProblems(
  overrides: Readonly<Record<string, Template>> = OPS_PLANE_TEMPLATE_OVERRIDES,
): string[] {
  const problems: string[] = [];
  for (const [type, override] of Object.entries(overrides)) {
    const customer = VALIDATED_TEMPLATES[type];
    if (customer === undefined) {
      problems.push(
        `ops template override "${type}" overrides no CUSTOMER template ` +
          `(slot-grammar.ts VALIDATED_TEMPLATES) — an ops-only type belongs in ` +
          `OPS_VALIDATED_TEMPLATES, not here.`,
      );
      continue;
    }
    if (isOpsClaimType(type)) {
      problems.push(
        `ops template override "${type}" is an OPS-ONLY type — it already owns its ` +
          `template in OPS_VALIDATED_TEMPLATES; a second entry here would shadow it.`,
      );
      continue;
    }
    const want = propositionSignature(customer);
    const got = propositionSignature(override);
    if (got.length !== want.length || got.some((sig, i) => sig !== want[i])) {
      problems.push(
        `ops template override "${type}" changes what is ASSERTED, not just how it ` +
          `is framed: proposition slots [${got.join(", ")}] ≠ the customer template's ` +
          `[${want.join(", ")}]. An override may re-frame (LITERAL slots) ONLY — the ` +
          `plane's ClaimDefinition is assembled from the CUSTOMER template, so a ` +
          `different field would render a projection §5 never licensed.`,
      );
    }
  }
  return problems;
}

// ── The composed OPS plane scope ─────────────────────────────────────────────

/**
 * The OPS plane's claim-type scope: the customer vocabulary PLUS the ops types.
 * A SUPERSET, deliberately — LE2-011 proved the customer STORE_OPEN_NOW chain
 * end-to-end on this plane ("estamos abertos?" is a legitimate staff question),
 * and nothing about ops scoping should take that away. The containment is
 * one-directional and that is the whole point: ops ⊃ customer, customer ∌ ops.
 */
export const OPS_CLAIM_SCOPE: ClaimPlaneScope = {
  types: [...CLAIM_REGISTRY, ...OPS_CLAIM_REGISTRY],
  specs: { ...REGISTRY_SPECS, ...OPS_REGISTRY_SPECS },
};

/**
 * The OPS plane's validated templates: the customer grammar, PLUS the ops-only
 * one, PLUS the LE2-013 staff-voice re-frames of customer types
 * ({@link OPS_PLANE_TEMPLATE_OVERRIDES} — last, so they win). The overrides can
 * only ever change LITERAL frame text; `opsTemplateOverrideProblems` fail-closes
 * the plane otherwise.
 */
export const OPS_PLANE_VALIDATED_TEMPLATES: Readonly<Record<string, Template>> = {
  ...VALIDATED_TEMPLATES,
  ...OPS_VALIDATED_TEMPLATES,
  ...OPS_PLANE_TEMPLATE_OVERRIDES,
};

// ── The fail-closed inv.18 assertion for the ops scope ───────────────────────

/**
 * The ops scope as generic `ClaimDefinition`s, assembled through the SAME
 * `assembleClaimDefinition` the customer registry uses (so an ops row can never be
 * validated by a laxer path). The customer definitions are carried in verbatim so
 * the check is over the WHOLE ops vocabulary, not an ops-only island.
 *
 * `triadScoped: false` for every ops type: the Trustworthiness Triad is the
 * owner/override-aware CUSTOMER read family the §O#15 decomposer quantifies over.
 * An ops type is store-level and is reached by the ops plane's own deterministic
 * span detection (`ops-claim-reads.ts`), not by a `REQUIRED_CLAIM_CLOSURE` row —
 * so marking it Triad-scoped would make INV-4 demand a closure row it must not
 * have (and a customer span class must never force an ops companion).
 */
const OPS_CLAIM_DEFINITIONS = {
  ...CLAIM_DEFINITIONS,
  ...Object.fromEntries(
    OPS_CLAIM_REGISTRY.map((type) => [
      type,
      assembleClaimDefinition({
        type,
        spec: OPS_REGISTRY_SPECS[type],
        template: OPS_VALIDATED_TEMPLATES[type],
        triadScoped: false,
      }),
    ]),
  ),
};

/**
 * FAIL-CLOSED ops registry-load guard — the plane-scoped twin of
 * `assertClaimDefinitionRegistryValid`, wired as the ops `ClaimsPlaneExtension`'s
 * `assertRegistryValid`. Runs the REAL inv.18 validator over the ops definitions +
 * the ops cross-tables, so an unaligned ops row (a template slot with no §5-gated
 * projection, a `falsifierComplete` type with no falsifiers, a dangling template,
 * a vacuous C0 evidence set) refuses to boot the ops claims pipeline instead of
 * serving an unsound render. Idempotent + pure.
 */
export function assertOpsClaimDefinitionRegistryValid(): void {
  // LE2-013 — the phrasing-override guard runs FIRST: an override that changed a
  // PROPOSITION would make every check below reason about the customer template
  // while the plane rendered a different one.
  const overrideProblems = opsTemplateOverrideProblems();
  if (overrideProblems.length > 0) {
    throw new Error(
      `[ops-claim-registry] FAIL-CLOSED: an ops plane template override is not a ` +
        `pure re-frame and must not boot the ops claims pipeline:\n  ` +
        overrideProblems.join("\n  "),
    );
  }
  const result = validateClaimDefinitionRegistry(OPS_CLAIM_DEFINITIONS, {
    templates: OPS_PLANE_VALIDATED_TEMPLATES,
    closures: REQUIRED_CLAIM_CLOSURE,
    registryEnum: OPS_CLAIM_SCOPE.types,
  });
  if (!result.ok) {
    throw new Error(
      `[ops-claim-registry] FAIL-CLOSED: the OPS claim definition registry is ` +
        `incomplete/inconsistent and must not boot the ops claims pipeline ` +
        `(inv.18 ${result.code}): ${result.reason}`,
    );
  }
}

/** Is `type` an OPS-ONLY claim type? Pure (used by the plane-scoping pins). */
export function isOpsClaimType(type: string): type is OpsClaimType {
  return (OPS_CLAIM_REGISTRY as readonly string[]).includes(type);
}

/** The customer scope, re-exported for the pin tests' readability. */
export { CUSTOMER_CLAIM_SCOPE };
