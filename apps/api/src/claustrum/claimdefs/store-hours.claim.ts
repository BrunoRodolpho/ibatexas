/**
 * STORE_HOURS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S1).
 *
 * THIS is the single editable artifact for the STORE_HOURS claim type. It UNIONS what
 * was previously scattered across two files:
 *
 *   - `claim-registry.ts`  REGISTRY_SPECS[STORE_HOURS]        (~57 lines)
 *   - `slot-grammar.ts`    VALIDATED_TEMPLATES[STORE_HOURS]   (~13 lines)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./store-hours.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * WHY THIS TYPE MIGRATED SECOND: it is the nearest structural sibling of the migrated
 * STORE_OPEN_NOW — public, FIXED-SUBJECT (no `perResourceKey`, so no key is ever
 * `:{subject}`-parameterized, which is the one registry facet `compileClaimDefinition`
 * cannot express), no presence-complement partner, no per-family CLARIFY/UNKNOWN
 * template, and it shares the `schedule:schedule_override` falsifier VERBATIM with
 * STORE_OPEN_NOW (one investigator read serves both).
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS — an owner ruling, not a projection), classify-only eligibility
 * (`classify-only-reads.ts`), the read binding (`claim-registry.ts`
 * `deriveBoundValue` + `turn-reads.ts`), the P2 pair table
 * (`ibatexas-claims-kernel-deps.ts`) and the planner personas.
 *
 * STORE_HOURS declares NO `decomposition`: there is no `STORE_HOURS_Q` span class and
 * no `REQUIRED_CLAIM_CLOSURE` row for it (a bare hours question routes to
 * STORE_OPEN_NOW_Q; a day-anchored one to STORE_HOURS_FOR_DATE_Q). `triadScoped` is
 * false, so INV-4 imposes no closure obligation — the omission is the honest state,
 * not a gap.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// BKL-121 — the full STORE_HOURS validated render chain. The evidence key is
// aligned VERBATIM with the investigator's STORE_HOURS_KEY ("schedule:store_hours")
// so the candidate validates against the actual recorded ledger entry; the
// deriveBoundValue branch (claim-registry.ts) + slot-grammar template (slot-grammar.ts) bind the
// rendered `hoursText` proposition 1:1 to it (Inv 6). Public, single-key type — NOT
// owner-scoped (no perResourceKey; keys are never `:{subject}`-parameterized).
export const STORE_HOURS_SOURCE = defineClaim({
  type: "STORE_HOURS",
  version: 1,
  kind: "read_claim",
  triadScoped: false,
  customerScoped: false,
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

  // C6 — bind the rendered value to the read's ACTUAL `hoursText` field
  // (ledger-sourced, never model-authored). `valueBinding.key` stays a member of
  // requiredEvidence so the kernel's C6 structural guard never throws.
  // (INV-7 is now a COMPILE error rather than a runtime throw: the key is typed as
  // the literal union of this def's own requiredEvidence keys.)
  valueBinding: { key: "schedule:store_hours", path: ["hoursText"] },

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

  // BKL-121 — the STORE_HOURS validated template. Static pt-BR around the single
  // ledger-bound proposition prop(STORE_HOURS, "hoursText"), bound 1:1 to the C6
  // value-binding FIELD (`valueBinding.path = ["hoursText"]` above); the
  // StoreHoursRead shape's field is `hoursText` (turn-reads.ts). The value is a
  // FREE-FORM pt-BR hours string ("11h–15h / 18h–23h" | "fechado"), evidence-bound
  // from the real weekly schedule (never an enum, so no claims-labels localization).
  render: {
    validated: [
      lit("Hoje nosso horário de funcionamento é: "),
      prop("hoursText"),
      lit("."),
    ],
  },
});
