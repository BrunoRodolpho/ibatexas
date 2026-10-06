// PASS 3 — SAFETY-IMPLICATION EDGES (LE2-016).
//
// The ratified allergen/dietary rulings, enforced as BUILD INVARIANTS. Ticket
// 16's third rejection class: "safety-implication edges terminating in
// allergen/dietary attributes".
//
// # What was ratified (verbatim, from ~/projects/ibx-master-tracker.yaml)
//
// BKL-143 — "DECIDED-CONSERVATIVE: a non-empty owner-attested allergens array
//   does NOT license a confident customer-facing 'não contém X' render. The
//   standing policy = honest self-report + real staff handoff … This CLOSES
//   the decision; reopening requires an explicit owner reversal in writing."
//
// BKL-123 — "follows BKL-143's conservative ruling: MENU_ITEM_ALLERGENS stays
//   deliberately UNKNOWN-only (no validated allergen render)".
//
// BKL-171 — "follows BKL-143: no dietary 'sem gluten/lactose' renders;
//   vegano/vegetariano-only renders REMAIN out too (scope-creep firewall).
//   Dietary questions keep self-report + handoff."
//
//   ┌─ SUPERSEDED IN PART, 2026-07-27 (owner ruling, BKL-270 Phase 1) ────────┐
//   │ BKL-171's vegano/vegetariano clause is REVERSED by **BKL-214** (PR      │
//   │ #358), which shipped exactly those renders one day after BKL-171 was    │
//   │ ratified. Until now that divergence was undocumented — the runtime      │
//   │ rendered vegano/vegetariano lists while the ratified row said they      │
//   │ "REMAIN out", and the note below merely observed the two disagreeing.   │
//   │ The owner has now recorded BKL-214 as the WRITTEN REVERSAL that         │
//   │ BKL-143's "reopening requires an explicit owner reversal in writing"    │
//   │ demands. Shipped behaviour STANDS and nothing changes here.             │
//   │                                                                         │
//   │ STILL IN FORCE, and NOT reversed: the `sem_gluten` / `sem_lactose`      │
//   │ half. A "sem glúten" list is a "não contém glúten" assurance by another │
//   │ name, and that remains forbidden. The reversal is narrow — pure         │
//   │ PREFERENCE tags only, never a restriction.                              │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// Those three rows are the ENTIRE policy content of this pass. It adds no
// rule of its own, and it deliberately does not restate the rulings' runtime
// half (which claim renders exist, when a turn abstains, when it pages staff)
// — that is `apps/api`'s, and the catalog holds no runtime authority.
//
// # What a "safety-implication edge" is, in catalog terms
//
// The rulings all forbid the same move: letting a stored attribute IMPLY a
// customer-facing assertion about allergens or dietary restriction. In the
// catalog, the objects that assert something to a customer are a capability's
// CLAIM EDGES — `successClaimLinks` today, "the SUCCESS_CLAIM_CLASSES ids this
// capability's EXECUTE can justify" (types.ts). A capability that links its
// success to an allergen-family claim is precisely the license BKL-143
// refused: it says "when this runs, that allergen assertion is justified".
//
// So: EVERY claim edge target is classified by `../safety-markers.ts`, and any
// hit is a compile error. The pass reads the same edge table the
// referential-integrity pass resolves against ({@link CLAIM_REFERENCE_EDGES}),
// so a claim slot added later is covered here the moment it is covered there —
// there is no second list to remember to update.
//
// # Resolvable is not permitted
//
// The two passes are deliberately independent. `MENU_ITEM_ALLERGENS` is a REAL
// member of `REGISTRY_CLAIM_TYPE_REFERENCES` — a future slot pointing at it
// would resolve perfectly under referential integrity and must still be
// rejected here. Referential integrity asks "does this name something?"; this
// pass asks "may a capability point at it?".
//
// # Conservative routing of unrecognized markers
//
// `safetyMarkerOf` matches STEMS, not an exact denylist, so a name nobody
// anticipated (`menu-item-allergens-v2`, `sem_gluten_list`) is safety-bearing
// by construction. On top of that, a safety-bearing target that resolves in NO
// known vocabulary gets its own rule id
// (`unrecognized-safety-marker-conservatively-denied`) rather than being left
// to the referential pass: an unknown name that looks like an allergen
// assertion routes to DENY, never to "we don't know it, so it can't be a
// problem". Unknown is the case that must fail closed.
//
// # There is no permitted-tag allowlist
//
// A dietary edge could in principle be a pure PREFERENCE tag rather than a
// restriction, and the runtime does draw that line (vegetariano/vegano render;
// sem_gluten/sem_lactose abstain). The catalog still does not — but note the
// REASON changed on 2026-07-27 and this paragraph would otherwise mislead.
//
// It used to be "BKL-171 ratified that vegano/vegetariano renders REMAIN out",
// which is no longer true: BKL-214 is now the recorded written reversal of that
// clause (see the box above). The allowlist stays EMPTY AND UNBUILT anyway, for
// a reason that survives the reversal intact: a capability CLAIM EDGE is not a
// render. BKL-214 licensed the RUNTIME to render a preference-tag list off a
// first-party facet; it licensed nothing about letting a capability's success
// IMPLY a dietary attribute, which is the only thing this pass rules on. Encoding an empty allowlist as an allowlist would invite the next
// author to append to it without an owner ruling, which is the exact
// scope-creep the firewall names. Adding a permitted dietary edge is a code
// change to this file, reviewed against a written owner reversal.
//
// Pure: no clock, no RNG, no IO.

import { isClaimClassReference, isRegistryClaimTypeReference } from "../../claim-references.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  capabilityObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { safetyMarkerOf, type SafetyFamily } from "../safety-markers.js"
import { asRecord } from "../slots.js"
import { CLAIM_REFERENCE_EDGES } from "./referential-integrity.js"

const PASS = "safety-implication-edges" as const

/** The ratified basis a family's rejection cites. */
const RATIFIED_BASIS: Readonly<Record<SafetyFamily, string>> = {
  allergen:
    "BKL-143 (an owner-attested allergens array does NOT license a customer-facing " +
    '"não contém X" render; standing policy = honest self-report + real staff handoff) ' +
    "and BKL-123 (MENU_ITEM_ALLERGENS stays deliberately UNKNOWN-only)",
  "dietary-restriction":
    'BKL-171 (no dietary "sem gluten/lactose" renders; vegano/vegetariano-only renders ' +
    "REMAIN out too — the scope-creep firewall; dietary questions keep self-report + handoff)",
}

/** Does any known claim vocabulary define this name? */
function resolvesAnywhere(reference: string): boolean {
  return isClaimClassReference(reference) || isRegistryClaimTypeReference(reference)
}

/**
 * Run the safety-implication-edges pass.
 *
 * `checked` counts claim edge TARGETS classified — the pass's unit. A run
 * reporting `checked: 0` on the real catalog means the claim edges moved, not
 * that the catalog is safe.
 */
export function runSafetyImplicationEdgesPass(
  definitions: readonly CapabilityDefinition[],
): CatalogPassResult {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0

  definitions.forEach((def, index) => {
    const object = capabilityObjectName(asRecord(def)["kind"], index)
    for (const edge of CLAIM_REFERENCE_EDGES) {
      edge.read(def).forEach((value, position) => {
        checked += 1
        if (typeof value !== "string") return // a malformed slot, not an edge
        const marker = safetyMarkerOf(value)
        if (marker === undefined) return
        const field = edge.indexed ? `${edge.field}[${position}]` : edge.field
        const known = resolvesAnywhere(value)
        diagnostics.push({
          pass: PASS,
          rule: known
            ? "safety-restricted-claim-edge"
            : "unrecognized-safety-marker-conservatively-denied",
          severity: "error",
          object,
          field,
          message: known
            ? `claim edge terminates in the ${marker.family} attribute "${value}" ` +
              `(marker "${marker.token}"). Forbidden by ${RATIFIED_BASIS[marker.family]}. ` +
              "A capability may not declare that running it justifies an allergen or " +
              "dietary-restriction assertion; reopening requires an explicit owner " +
              "reversal in writing."
            : `claim edge target "${value}" resolves against no known claim vocabulary ` +
              `AND carries the ${marker.family} marker "${marker.token}". An ` +
              "unrecognized safety-bearing reference routes conservatively to DENY — " +
              `it is refused under ${RATIFIED_BASIS[marker.family]} rather than ` +
              "assumed harmless because the compiler does not recognize it.",
          reference: value,
        })
      })
    }
  })

  return { pass: PASS, checked, diagnostics }
}
