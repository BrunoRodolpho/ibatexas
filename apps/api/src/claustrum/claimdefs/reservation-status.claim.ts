/**
 * RESERVATION_STATUS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S4).
 *
 * THIS is the single editable artifact for the RESERVATION_STATUS claim type. It UNIONS
 * what was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[RESERVATION_STATUS]      (~48 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[RESERVATION_STATUS] (~24 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./reservation-status.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS TYPE IS THE FIRST OWNER-SCOPED ADOPTION ────────────────────────────
 *
 * It is the structurally simplest of the SEVEN owner-scoped `perResourceKey` types
 * (ORDER_FULFILLMENT_STAGE / PAYMENT_STATUS / RESERVATION_STATUS / CART_CONTENTS /
 * CART_EMPTY / ORDER_HISTORY / PAYMENT_HISTORY), and simplest in the sense that matters:
 * every facet it has is one the compiler already models, so the slice tests the OWNERSHIP
 * axis and nothing else. All seven share `perResourceKey: true`, `customerScoped: true`,
 * `triadScoped: true`, ONE `must_read_this_turn` required-evidence row and a
 * single-C6-field render, so the pick turned on the facets that DIFFER:
 *
 *   - ONE falsifier, floor `structured`, provenance `preserve`. PAYMENT_STATUS carries
 *     TWO falsifiers at the raised `first_party_verified` / `first_party_only` money tier
 *     — two extra axes on a first proof of ownership.
 *   - `answer-anyway` (BKL-270), the posture five of the seven share. CART_CONTENTS is
 *     the registry's ONLY `answer-with-abstention` row, which would entangle the
 *     BKL-184 append machinery with this proof.
 *   - A SELF-ONLY closure row that NO OTHER SPAN references. ORDER_FULFILLMENT_STAGE is
 *     required by PICKUP_Q as well as ORDER_STATUS_Q, and a compiled source contributes
 *     exactly ONE closure row — so its second row would have to stay hand-written beside
 *     a generated one.
 *   - NO presence-complement partner. CART_CONTENTS / CART_EMPTY SHARE one closure row
 *     (`CART_CONTENTS_Q` requires both), the shape R2-S1 excluded for STORE_INFO.
 *   - A classifier arm with NO side effect. The two history spans SPLICE their singular
 *     sibling out of the accumulated span list; that suppression is a sequencing fact
 *     about `classes`, not a marker, so migrating one would leave the interesting half
 *     hand-written anyway.
 *   - Its span markers are ALREADY two separate regex literals combined with `||`, so
 *     `markers.some((m) => m.test(t))` is the SAME expression the classifier ran before —
 *     this is the first marker migration with no alternation-splitting step at all (both
 *     arms are still pinned byte-for-byte in `__SPAN_NET_SOURCES_FOR_TEST`).
 *   - `reservation_status` is EXCLUDED from `ORDER_SUBJECT_BASE_KEYS`
 *     (classify-only-reads.ts) — reservations carry no display vocabulary — so the
 *     BKL-170 candidate-VOICING path is not in play. And while `claims-labels.ts` holds a
 *     `RESERVATION_STATUS.status` display map, the C6 binding is `statusLine` (BKL-185),
 *     whose pt-BR labels are applied upstream in `turn-reads.ts` — so no live label
 *     lookup rides this type's bound field, unlike ORDER_FULFILLMENT_STAGE
 *     (`fulfillmentStatus`) and PAYMENT_STATUS (`status`).
 *   - And it already had owner-scoped VALIDATED-render proofs against the REAL claims
 *     pipeline (`../__tests__/reservation-status-claim.test.ts`,
 *     `../__tests__/fe-t18-classify-only-reads.test.ts`), so the adoption is provable
 *     against real per-subject ledger evidence rather than only at the spec shape.
 *
 * ── THE OWNERSHIP AXIS, AND WHY IT NEEDED NO SCHEMA WIDENING ────────────────────
 *
 * `ownerScopedBaseKey` (claim-registry.ts) decides owner scoping off the BASE key of the
 * FIRST `ownershipPolicy: "required"` evidence row, and `publicPerItemBaseKey`
 * (classify-only-reads.ts) is its complement over the per-resource types — so between
 * them the per-row `ownershipPolicy` values below, IN ROW ORDER, are what make this type
 * owner-scoped rather than public. `OWNER_SCOPED_KEY_PREFIXES`
 * (ibatexas-claims-kernel-deps.ts) then joins that base key to the ledger half:
 * `reservation_status:` is a declared prefix, so a PRESENT `reservation_status:{id}` read
 * attributes ownership and its id becomes an admissible subject.
 *
 * That whole axis rides the PUBLISHED contract with NO new widening: `toRegistrySpec`
 * projects `requiredEvidence: def.requiredEvidence` VERBATIM (the whole rows, by
 * reference), and `ownershipPolicy` is a required field of the published
 * `EvidenceRequirement`. The ONLY facet the published compiler cannot express here is
 * `perResourceKey`, which R2-S2 already widened repo-locally
 * (`./per-resource-claim.ts`) — hence `definePerResourceClaim` +
 * `compilePerResourceClaimDefinition`, and hence the declared keys staying UNSUFFIXED
 * BASES: `selectCandidateClaim`'s `parameterizeKeysBySubject` appends `:{subject}` to
 * `requiredEvidence`, `falsifiers` AND `valueBinding.key` in LOCKSTEP at runtime,
 * matching the investigator's `reservation_status:{reservationId}`
 * (ibatexas-investigator.ts `RESERVATION_KEY`).
 *
 * The subject is NOT model-authored: for an owner-scoped type the claim planner
 * re-resolves it from the PRESENT owner-scoped ledger reads (`ownerScopedBaseKey` →
 * `ownedResourceIdsByBaseKey`), so a forged or cross-owner id was never read → never
 * PRESENT → never an admissible subject → `owns → false` → REFUSED ("no owner" ≠ "any
 * owner", Inv 2). A guest owns no reservation → the read is skipped → ABSENT evidence →
 * honest UNKNOWN.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling, not a projection, and it carries a borderline-B5 caveat that lives
 * beside its siblings), the span classifier's GUARD conjunction (`!mutationImperative` —
 * the compiler models markers, not suppression contexts), the bare-"status" de-shadow
 * that reads the same marker predicate, classify-only eligibility
 * (`classify-only-reads.ts`), the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `turn-reads.ts` `composeReservationStatusLine`), the owner-scope prefix list and
 * `OWNER_SCOPED_BASE_TO_RESOURCE_KIND` (`ibatexas-claims-kernel-deps.ts`), the
 * `claims-labels.ts` display map, the P2 pair table and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// FE-T17 — the reservation-status read. Owner-scoped + per-resource, mirroring
// ORDER_FULFILLMENT_STAGE exactly: the base key `reservation_status` matches the
// investigator's `RESERVATION_KEY` (ibatexas-investigator.ts) and the owner-scope
// wiring already declared for it in `OWNER_SCOPED_KEY_PREFIXES` / FIX 2's
// `ownerScopedBaseKey` (ibatexas-claims-kernel-deps.ts / ibatexas-planner.ts) — both
// pre-date this row and needed no change to pick it up.
export const RESERVATION_STATUS_SOURCE = definePerResourceClaim({
  type: "RESERVATION_STATUS",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some
  // REQUIRED_CLAIM_CLOSURE row, which the `decomposition` block below supplies (the
  // RESERVATION_STATUS_Q row). Declared HERE rather than inferred from
  // `TRIAD_SCOPED_TYPES` membership, so boot no longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening. The keys below stay BARE BASES — the runtime suffixes them.
  perResourceKey: true,

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

  // C6 — bind the rendered scalar to the read's pre-composed `statusLine`
  // (BKL-185, the ORDER_HISTORY serialized-scalar idiom): status + optional
  // "— DD/MM às HH:MM, para N pessoa(s)" detail, composed DETERMINISTICALLY in
  // the read (turn-reads.ts composeReservationStatusLine — no clock, no model).
  // Detail-absent → the scalar IS the bare status → the render is byte-identical
  // to the pre-BKL-185 status-only form. Ledger-sourced, never model-authored.
  // INV-7 is a COMPILE error here: the key is typed as the literal union of this def's
  // own requiredEvidence keys, and it is suffixed by the SAME `:{subject}` as its
  // requiredEvidence member at select time, so it stays a member of that set and the
  // kernel's C6 structural guard never throws.
  valueBinding: { key: "reservation_status", path: ["statusLine"] },

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

  // FE-T17 — the reservation-status validated template. ONE proposition slot
  // (self-type), mirroring PAYMENT_STATUS / ORDER_FULFILLMENT_STAGE exactly. NOT
  // multi-field: the linked kernel's mint step (SDD §5 C6 / the published
  // `runClaimsKernel` "F2" narrowing — `kernels.js`) reconstructs the CanonicalClaim's
  // value carrying ONLY the C6-`valueBinding.path`-proven slice and drops every sibling
  // field of the read as unvalidated content (by design — only the bound path was ever
  // compared against the ledger). A second proposition slot reading a sibling field
  // (e.g. `partySize`) would therefore ALWAYS be UNFILLABLE post-mint, aborting the
  // whole template to UNKNOWN (Inv 6 is all-or-nothing per template) — so this
  // template, like every other Triad type, renders exactly the one C6-bound field.
  // BKL-185 — that one slot binds the pre-composed `statusLine` (status + optional
  // "— DD/MM às HH:MM, para N pessoa(s)" detail; see the valueBinding note above).
  // Detail-absent → statusLine === status → the render is byte-identical to the
  // pre-BKL-185 status-only form.
  render: {
    validated: [lit("O status da sua reserva é: "), prop("statusLine"), lit(".")],
  },

  // The §O#15 decomposition contribution.
  //
  // FE-T17 — a reservation-status question requires ONLY the reservation claim. This row
  // is ALSO what auto-enrols RESERVATION_STATUS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the closure-value
  // union, so an over-proposed reservation claim is DEMOTED on a turn whose reservation
  // span did not fire, yet KEPT when it did.
  //
  // THE MARKERS. Reservation-bearing phrasing, as an explicit marker set — NOT folded
  // into the bare-"status" polysemy resolution the classifier does for order/payment
  // (reservation questions name "reserva"/"mesa" directly, unlike the "status"
  // ambiguity that file's F2 fix disambiguates). These are the SAME TWO regex literals
  // the classifier tested with `||` before this migration, moved verbatim: a `.some()`
  // over the arms and two `||`-ed `.test()`s are the same predicate, and each arm is
  // pinned byte-for-byte by `__SPAN_NET_SOURCES_FOR_TEST.reservationStatus`. What did
  // NOT move is the GUARD (`!mutationImperative`) or the bare-"status" de-shadow that
  // reads the same predicate — both stay hand-written in `classifyRequestSpans`.
  //
  // ARM 1 IS ANCHORED, not a bare substring test (review fix — the original unanchored
  // `/reserva/` false-fired on the unrelated preserv* family: "preservar" /
  // "preservam" / "preservação" / "preservativo" all contain "reserva" as a substring
  // — and, via the completeness gate, a false span match can degrade an otherwise-valid
  // answer to a DIFFERENT question to UNKNOWN. It also did NOT actually match
  // "reservei" / "reservou" despite the old comment claiming it did — `/reserva/`
  // requires the literal substring "reserva", which neither verb form contains). The
  // negative lookbehind `(?<![a-z])` requires the match start at a word boundary (never
  // mid-word, closing the preserv* false-positive); the alternation covers the verb
  // forms this domain actually sees: reserva(s) (noun/verb), reservar (infinitive),
  // reservad-o/a (participle), reservam (3p-pl present), reservando (gerund), reservei /
  // reservou (1s/3s preterite). The `(?!at)` lookahead right after "reserv" excludes
  // "reservatório" (reservoir/tank) — a real word sharing the "reserva-" prefix but
  // never the domain this decomposer models (a restaurant table reservation) — cheaply,
  // since no verb form in the alternation is ever followed by "at". Verified
  // empirically against both a must-fire and a must-not-fire word list
  // (RESERVATION_STATUS_Q tests in required-claim-decomposer.test.ts).
  //
  // ARM 2 (BKL-219/224) is the `mesa` (table) synonym: a customer asks about their
  // booking by "mesa" as often as "reserva" ("minha mesa está confirmada?"). Anchored
  // on BOTH sides (`(?<![a-z])mesas?(?![a-z])`) so it matches standalone "mesa"/"mesas"
  // only — never mid-word ("mesada" allowance; "mesas" is fine). The anchoring
  // ASYMMETRY between the two arms is load-bearing and is exactly what byte-identity
  // pins: arm 1 is anchored on the LEFT only (it must still match "reservas"/
  // "reservado" with their trailing letters), arm 2 on BOTH sides.
  //
  // BKL-217 — reservation MUTATIONS are excluded by the shared `mutationImperative`
  // net at the classifier (the same read-vs-mutation split #349/BKL-201 applied to the
  // cart span and BKL-206 to the order/payment status spans). RESERVATION_STATUS is
  // classify-only-eligible, so without that gate "cancela minha reserva" / "muda minha
  // reserva para 20h" fire this span → classify-only answers the READ and SILENTLY
  // DROPS the reservation.cancel / reservation.modify (the reservation sibling of the
  // BKL-201 hole — live-caught: a seeded-reservation "cancelar minha reserva das 18:30"
  // degraded to "não encontrei" with zero adjudication). A genuine reservation QUESTION
  // ("minha reserva está confirmada?", "qual minha reserva?") has no mutation verb and
  // still fires. A how-to interrogative ("como cancelo minha reserva?") also routes to
  // the model for a helpful answer — the fail-SAFE direction (never a wrong read).
  decomposition: {
    spanClass: "RESERVATION_STATUS_Q",
    markers: [
      /(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)/,
      /(?<![a-z])mesas?(?![a-z])/,
    ],
    requires: ["RESERVATION_STATUS"],
  },
});
