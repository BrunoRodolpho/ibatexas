/**
 * STORE_HOURS_FOR_DATE — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S8).
 *
 * THIS is the single editable artifact for the STORE_HOURS_FOR_DATE claim type. It
 * UNIONS what was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[STORE_HOURS_FOR_DATE]      (~57 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[STORE_HOURS_FOR_DATE] (~13 lines)
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + one conjunct of the
 *                                    pt-BR span predicate
 *
 * See `./store-open-now.claim.ts` for the full compile contract and
 * `./per-resource-claim.ts` for the repo-local `perResourceKey` widening; the generated
 * image is `./store-hours-for-date.generated.ts` (`@generated` — DO NOT EDIT), kept in
 * sync by the `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS TYPE CAME LAST AMONG THE PARAMETERIZED ELEVEN ──────────────────────
 *
 * `menu-item-price.claim.ts`'s header named it explicitly and deferred it: "its span
 * class is classified by a COMPOSED predicate (`dateAnchor && scheduleContext`, plus a
 * STORE_OPEN_NOW_Q suppression seam), not a flat marker alternation, so migrating it
 * would entangle a span-net restructure with the first proof of the facet." With the
 * facet proven seven slices over, the entanglement is the only remaining work — and it
 * decomposes cleanly, because a `markers` array is DISJUNCTIVE (`markers.some(...)`)
 * while the span predicate is a CONJUNCTION. Exactly one conjunct can be the generated
 * net; the other must stay a hand-written GUARD wrapping it.
 *
 * ── THE DECOMPOSITION, AND HOW IT WAS DECIDED (measured, not judged) ────────────
 *
 * The pre-migration predicate, verbatim from `classifyRequestSpans`:
 *
 *     const dateAnchor =
 *       /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|amanh[ãa]|feriado)/.test(t);
 *     const scheduleContext =
 *       /hor[áa]rio|que horas|abre|abrem|abert|fecha|funciona|expediente|atend/.test(t);
 *     if (dateAnchor && scheduleContext) classes.push("STORE_HOURS_FOR_DATE_Q");
 *
 * The R2-S7 rule ("determine which conjunct is the MARKER net — flat and rejoinable
 * BYTE-IDENTICALLY — and which is the hand-written GUARD") selects `scheduleContext`,
 * and the selection is a MEASUREMENT rather than a preference:
 *
 *   - `scheduleContext` is a FLAT top-level alternation of NINE arms with no wrapping
 *     group and no shared prefix. Split at its top-level `|`, the arms rejoin
 *     `markers.map((m) => m.source).join("|")` CHARACTER-FOR-CHARACTER (pinned by
 *     `__SPAN_NET_SOURCES_FOR_TEST.storeHoursForDate` — the R2-S1 STORE_INFO
 *     discipline), so `.some()` over the arms and `.test()` on the alternation are the
 *     same predicate (∃ position ∃ arm).
 *   - `dateAnchor` CANNOT be that net. Its `|`s are INSIDE a group under a SHARED `\b`
 *     prefix, so a per-arm split rejoins to `\bdomingo|\bsegunda|…` — an EQUIVALENT
 *     predicate but a DIFFERENT string, which is precisely the "equivalent rewrite"
 *     every prior slice's byte pin exists to refuse. (Measured both ways: the naive
 *     split is behaviourally identical on a 10-probe sweep and byte-DIFFERENT; a
 *     one-element `markers` array would rejoin trivially but is a relocation dressed as
 *     a decomposition, and it would put the DATE half — the half that actually
 *     discriminates this span from its STORE_OPEN_NOW sibling — behind a generated
 *     surface with no guard left to review.)
 *
 * So: `scheduleContext` becomes the GENERATED nine-arm `markers` net below;
 * `dateAnchor` stays HAND-WRITTEN at `classifyRequestSpans` as the guard conjunct, in
 * the same position and with the same source bytes it had before.
 *
 * ── WHAT ELSE STAYS HAND-WRITTEN, AND WHY (the compiler models markers, not sequencing)
 *
 *   - The `dateAnchor` GUARD conjunct (above). A guard is not a facet — the same ruling
 *     STORE_INFO_Q's `notResourceScoped && !mutationImperative` and MENU_ITEM_CONTENTS_Q's
 *     three-conjunct guard already took. It carries BEHAVIOURAL pins as well as its
 *     source-byte pin, because a byte pin over the generated markers is GUARD-BLIND: the
 *     marker net stays byte-identical with the guard DELETED, and the span then fires on
 *     every bare hours question in the corpus (measured — see the R2-S7 precedent for why
 *     each guard half needs a pin that fails when the half is removed).
 *   - The BKL-152 STORE_OPEN_NOW_Q SUPPRESSION SEAM in `decomposeRequiredClaims`. It is
 *     SEQUENCING over the assembled required set (delete a companion the closure table
 *     already put there, under a PICKUP_Q guard and a clock-resolved date signal), not a
 *     contribution any single type's closure row can express. It stays where it is,
 *     verbatim, and gains behavioural pins on both directions of its guard.
 *   - The BKL-270 `dietaryPosture: "answer-anyway"` splice at REGISTRY_SPECS (an owner
 *     ruling, not a projection; `compileClaimDefinition` has no field for it).
 *   - classify-only eligibility (`classify-only-reads.ts` — where this type is PUBLIC
 *     PER-ITEM on the MENU_ITEM_PRICE footing and STORE_OPEN_NOW rides along as its
 *     companion), the read binding (`claim-registry.ts` `deriveBoundValue` +
 *     `turn-reads.ts`), the P2 pair table (`ibatexas-claims-kernel-deps.ts`), the planner
 *     personas, and the planner's `resolveQueriedScheduleDate` SUBJECT path
 *     (`ibatexas-planner.ts`) — all untouched by this migration.
 *
 * ── THE SUBJECT IS A DATE, NOT A RESOURCE ID ────────────────────────────────────
 *
 * `perResourceKey: true` with every evidence row `ownershipPolicy: "not_applicable"`, so
 * `ownerScopedBaseKey` is undefined and `publicPerItemBaseKey` yields
 * `"schedule:store_hours"` — the MENU_ITEM_PRICE class, with the "item" being the QUERIED
 * ISO DATE. The declared keys stay UNSUFFIXED BASES: `selectCandidateClaim` →
 * `parameterizeKeysBySubject` suffixes `requiredEvidence`, `falsifiers` AND
 * `valueBinding.key` in LOCKSTEP at runtime, matching the investigator's
 * `schedule:store_hours:{date}` / `schedule:schedule_override:{date}` /
 * `schedule:holiday:{date}`. That lockstep IS the SCN-003 soundness pin: the falsifiers
 * re-read the QUERIED date, so a holiday/override on that date demotes to UNKNOWN while
 * TODAY's holiday (recorded under the BARE key STORE_HOURS uses) can never poison a
 * future-date answer — the two never collide.
 *
 * The subject itself is resolved DETERMINISTICALLY on both paths that mint one — the
 * planner's `resolveQueriedScheduleDate` over `perception.text` (it DISCARDS the model's
 * subject for this type) and BKL-289's `deriveUnionSubject`, which reads the `{date}`
 * suffix off the LEDGER's own present `schedule:store_hours:{date}` entry. Neither reads
 * model output, and both keep working off the GENERATED spec because both derive from
 * the BASE KEY, which is unchanged.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-138 — the DAY-SPECIFIC hours claim (SCN-002/003). The per-date twin of
// STORE_HOURS: identical evidence/falsifier/value-binding SHAPE, but `perResourceKey` so
// every key is `:{date}`-suffixed at select time. PUBLIC (owned by nobody): its
// `schedule:*` keys match NO OWNER_SCOPED_KEY_PREFIXES, so the subject is a resolved date
// and never an owner id. Do NOT overload the live-proven TODAY STORE_HOURS (BKL-121 D3) —
// an independent type keeps the two degrade paths decoupled.
export const STORE_HOURS_FOR_DATE_SOURCE = definePerResourceClaim({
  type: "STORE_HOURS_FOR_DATE",
  version: 1,
  kind: "read_claim",
  // PUBLIC per-date: never Triad-scoped, so INV-4 imposes no closure obligation (the
  // closure row below exists because this type HAS a span class, not because it owes one).
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "trusted_service",

  // The repo-local widening. The keys below stay BARE BASES — the runtime suffixes them.
  perResourceKey: true,

  requiredEvidence: [
    {
      // The SAME base key as STORE_HOURS — but `perResourceKey` suffixes it `:{date}` at
      // select time, so the ledger keys never collide with today's bare entry.
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

  // C6 — bind the rendered value to the QUERIED date's `hoursText` (ledger-sourced, never
  // model-authored). INV-7 is a COMPILE error here: the key is typed as the literal union
  // of this def's own requiredEvidence keys, and it is suffixed by the SAME `:{subject}`
  // as its requiredEvidence member at select time, so it stays a member of that set and
  // the kernel's C6 structural guard never throws.
  valueBinding: { key: "schedule:store_hours", path: ["hoursText"] },

  // W6 — a per-date override OR a holiday ON THE QUERIED DATE falsifies that date's
  // weekly-schedule hours (BOTH enumerated → honest completeness), so the eligibility cap
  // lets this type reach VALIDATED and the runtime arm demotes it to UNKNOWN when either
  // actually fires. The keys are date-suffixed in lockstep with requiredEvidence.
  //
  // `schedule:schedule_override` is DECLARED with the SAME key string STORE_OPEN_NOW and
  // STORE_HOURS declare (the R2-S1 sharing): ONE investigator read serves all three. The
  // sharing is a property of the DECLARED BASE, which this source reproduces verbatim —
  // the per-date suffixing that happens afterwards is what keeps this type's arm reading
  // the QUERIED day rather than today.
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

  // BKL-138 — the DAY-SPECIFIC hours template (SCN-002/003). A SINGLE ledger-bound
  // proposition bound 1:1 to the C6 value-binding FIELD (`hoursText` above) — the per-date
  // twin of STORE_HOURS. Deliberately DAY-GENERIC static text ("nesse dia" — the day the
  // customer asked about): the single-proposition shape mirrors the proven STORE_HOURS
  // chain and its ONE value projection exactly, so it stays sound-by-construction (a
  // second, differently-projected day-name proposition would fight the compiled
  // ClaimDefinition). Renders the QUERIED date's REAL weekly hours; a holiday/override on
  // that date already demoted the claim to UNKNOWN upstream (never reaches here).
  render: {
    validated: [
      lit("Nesse dia, nosso horário de funcionamento é: "),
      prop("hoursText"),
      lit("."),
    ],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-138 — a day-specific hours question requires ONLY its own PUBLIC claim. This row
  // is ALSO what auto-enrols STORE_HOURS_FOR_DATE into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union, so an over-proposed date-hours
  // claim is DEMOTED on a turn whose date-hours span did not fire (the smalltalk-hijack
  // guard) yet KEPT when it did.
  //
  // The markers are the NINE top-level arms of the `scheduleContext` conjunct, IN ORDER,
  // so `markers.map((m) => m.source).join("|")` reproduces that literal exactly. They are
  // ONE HALF of the span predicate: the classifier still conjoins the hand-written
  // `dateAnchor` guard (see this file's header for why that half cannot be a flat net and
  // must not become one). A `.some()` over these arms is what `scheduleContext` was; it is
  // NOT what the span is.
  //
  // Byte-identity here holds the ACCENT CHARACTER CLASS `hor[áa]rio` — the
  // BKL-205/BKL-270/BKL-271 lesson, where an ASCII-only stem has an EMPTY true-positive
  // set on the real phrasing and no false-positive sweep reveals it — and the
  // `abre`/`abrem`/`abert` TRIPLE, whose middle arm is redundant under prefix matching but
  // is part of the literal the runtime has always run.
  decomposition: {
    spanClass: "STORE_HOURS_FOR_DATE_Q",
    markers: [
      /hor[áa]rio/,
      /que horas/,
      /abre/,
      /abrem/,
      /abert/,
      /fecha/,
      /funciona/,
      /expediente/,
      /atend/,
    ],
    requires: ["STORE_HOURS_FOR_DATE"],
  },
});
