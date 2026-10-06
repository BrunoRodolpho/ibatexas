// Conformance fixtures for the SAFETY-IMPLICATION-EDGES pass (LE2-017).
//
// Two rule ids, two fixture catalogs. Both declare `alsoEmits` a
// `claim-reference-dangling`, and that co-emission is STRUCTURAL rather than
// sloppy fixture authoring:
//
//   `successClaimLinks` resolves against CLAIM_CLASS_REFERENCES (19 lowercase
//   guard ids), and none of those 19 carries a safety marker. So there is no
//   value that is simultaneously a RESOLVING claim link and a safety-bearing
//   one — which is exactly the layering the safety pass's own doc states:
//   "Referential integrity asks 'does this name something?'; this pass asks
//   'may a capability point at it?'". A safety edge is therefore always also
//   a referential dangler today, and the goldens pin both diagnostics.
//
// The day a claim class with a safety marker is added to the vocabulary, the
// first fixture's `alsoEmits` becomes wrong and this suite says so.

import { FIXTURE_PACK as PACK } from "./base.js"
import { fixtureCatalog, type ConformanceFixture } from "../types.js"

export const SAFETY_IMPLICATION_EDGES_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "safety-implication-edges.safety-restricted-claim-edge",
    targets: "safety-implication-edges/safety-restricted-claim-edge",
    alsoEmits: ["referential-integrity/claim-reference-dangling"],
    why:
      "MENU_ITEM_ALLERGENS is a REAL member of REGISTRY_CLAIM_TYPE_REFERENCES — " +
      "the pass's own 'resolvable is not permitted' example. Linking a " +
      "capability's success to it is precisely the license BKL-143/BKL-123 " +
      "refused: it asserts that running this capability justifies an allergen " +
      "claim.",
    definitions: fixtureCatalog({
      kind: "conformance.safety.restricted-edge",
      pack: PACK,
      mutating: true,
      tier: "identity",
      successClaimLinks: ["MENU_ITEM_ALLERGENS"],
    }),
  },
  {
    name: "safety-implication-edges.unrecognized-safety-marker-conservatively-denied",
    targets:
      "safety-implication-edges/unrecognized-safety-marker-conservatively-denied",
    alsoEmits: ["referential-integrity/claim-reference-dangling"],
    why:
      '"sem-gluten-list" resolves in NO claim vocabulary and carries the dietary ' +
      "stem `gluten`. It routes to DENY under BKL-171 rather than being assumed " +
      "harmless because the compiler does not recognize it — unknown is the case " +
      "that must fail closed. This is also what proves the marker table matches " +
      "STEMS, not an exact denylist.",
    definitions: fixtureCatalog({
      kind: "conformance.safety.unrecognized-marker",
      pack: PACK,
      mutating: true,
      tier: "identity",
      successClaimLinks: ["sem-gluten-list"],
    }),
  },
]
