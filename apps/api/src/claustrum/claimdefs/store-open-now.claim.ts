/**
 * STORE_OPEN_NOW — the ClaimDefinition SOURCE (inv.18 v2 vertical slice).
 *
 * THIS is the single editable artifact for the STORE_OPEN_NOW claim type. It UNIONS
 * everything that was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[STORE_OPEN_NOW]  (~30 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[STORE_OPEN_NOW] (~11 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership + the derived
 *                                    value-projection fold
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * The contributor fills it ONCE; the `claimdef-compiler` (@adjudicate/core
 * `compileClaimDefinition`) GENERATES every runtime artifact from it (see
 * `./store-open-now.generated.ts`, which is `@generated` — DO NOT EDIT). Adding a new
 * claim type = adding a sibling `*.claim.ts` source + running the generator; NO
 * interpreter code is touched (constraint 1).
 *
 * Illegal states are UNREPRESENTABLE here (constraint 3): `defineClaim` is a
 * const-generic builder, so `valueBinding.key` is typed as the literal union of THIS
 * def's `requiredEvidence` keys (binding an un-§5-gated key is a COMPILE error, not a
 * load-time reject — INV-7), `requiredEvidence`/`falsifiers` are non-empty tuples
 * (INV-6/INV-2), and the falsifier stance is a discriminated union (INV-2).
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

export const STORE_OPEN_NOW_SOURCE = defineClaim({
  type: "STORE_OPEN_NOW",
  version: 1,
  kind: "read_claim",
  triadScoped: true,
  customerScoped: false,
  minSourceIntegrity: "trusted_service",

  // INV-6: a NON-EMPTY tuple. The evidence key is aligned VERBATIM with the
  // investigator's SCHEDULE_KEY ("schedule:store_open_now") so the candidate
  // validates against the actual recorded ledger entry.
  requiredEvidence: [
    {
      key: "schedule:store_open_now",
      ownershipPolicy: "not_applicable",
      // A short cacheable ttl bounds staleness (mirrors STORE_HOURS posture).
      freshnessPolicy: { kind: "cacheable", ttl: 3600 },
      sourceIntegrity: "trusted_service",
      provenancePolicy: "preserve",
    },
  ],

  // INV-7 (compile-time): key MUST be a member of requiredEvidence keys. The render
  // proposition's value projection is DERIVED from this binding × the render slots —
  // the slot↔projection↔evidence alignment is true BY CONSTRUCTION (INV-1).
  valueBinding: { key: "schedule:store_open_now", path: ["mealPeriod"] },

  // INV-2 (discriminated union): completeness REQUIRES a non-empty falsifier tuple.
  // W6 cross-key arm — a present ScheduleOverride contradicts the open/closed signal.
  // (The falsifier key is BY DESIGN a DIFFERENT key from requiredEvidence.)
  falsifierComplete: true,
  falsifiers: [
    {
      key: "schedule:schedule_override",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "trusted_service",
      provenancePolicy: "preserve",
    },
  ],

  // The validated (asserting) render template. `prop` names a FIELD only; the
  // backing claimType is implied = self and the projection is computed by the
  // compiler. Static pt-BR around the single ledger-bound proposition.
  render: {
    validated: [
      lit("No momento, o período de funcionamento é: "),
      prop("mealPeriod"),
      lit("."),
    ],
  },

  // The §O#15 decomposition contribution: the span class this type answers, the
  // conservative pt-BR markers that classify a request into it (DATA), and the
  // required-companion set (non-empty ⟹ INV-4 reachable-from-closure).
  decomposition: {
    spanClass: "STORE_OPEN_NOW_Q",
    markers: [/abert/, /fechad/, /que horas/, /funciona/, /hor[áa]rio/],
    requires: ["STORE_OPEN_NOW"],
  },
});
