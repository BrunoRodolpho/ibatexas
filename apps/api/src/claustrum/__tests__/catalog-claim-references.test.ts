// LE2-014 — the catalog's claim-reference vocabularies vs the LIVE runtime.
//
// `@ibatexas/catalog`'s `claim-references.ts` mirrors two claim NAME SPACES so
// that the catalog's build-time cross-reference gate has something to resolve
// against. It has to be a mirror: `packages/*` cannot import `apps/api` (the
// arrow runs adjudicate -> claustrum -> ibatexas, and packages sit upstream of
// apps), so the gate physically cannot read the live arrays.
//
// A mirror nobody checks is just a second source of truth waiting to disagree
// with the first. This test is the check. It lives HERE because this is the
// only side that can see both — exactly the reason
// `capability-definitions.success-claim-round-trip.test.ts` lives here too.
//
// Both assertions are SET equality in BOTH directions, deliberately:
//   - a name in the catalog the runtime does not define would let a dangling
//     capability link sail through the build gate (a false PASS — the gate's
//     one job is to catch that);
//   - a name the runtime defines that the catalog lacks would fail the build
//     on a perfectly legitimate new link (a false FAIL).
// Neither is acceptable, so neither direction is left unpinned.
//
// Order carries no contract on either side; both are treated as sets.
//
// WHEN THIS FAILS: you added (or removed) a success-claim class or a registry
// claim type. Mirror the change into
// `packages/catalog/src/claim-references.ts` and bump `CATALOG_VERSION` —
// changing the claim-reference vocabulary is exactly the kind of change the
// catalog README's bump discipline names.

import { describe, expect, it } from "vitest";
import {
  CLAIM_CLASS_REFERENCES,
  REGISTRY_CLAIM_TYPE_REFERENCES,
} from "@ibatexas/catalog";
import { CLAIM_REGISTRY } from "../claim-registry.js";
import { SUCCESS_CLAIM_CLASSES } from "../ibatexas-responder.js";

describe("catalog claim-reference vocabularies mirror the live runtime (LE2-014)", () => {
  it("CLAIM_CLASS_REFERENCES equals the real SUCCESS_CLAIM_CLASSES ids, both directions", () => {
    const live = new Set(SUCCESS_CLAIM_CLASSES.map((c) => c.id));
    const mirrored = new Set<string>(CLAIM_CLASS_REFERENCES);

    // Named per-direction so a failure message says WHICH way it drifted.
    const inCatalogOnly = [...mirrored].filter((id) => !live.has(id)).sort();
    const inRuntimeOnly = [...live].filter((id) => !mirrored.has(id)).sort();

    expect(
      inCatalogOnly,
      "catalog names a claim class the responder does not define — the build gate would pass a dangling link",
    ).toEqual([]);
    expect(
      inRuntimeOnly,
      "the responder defines a claim class the catalog lacks — the build gate would reject a legitimate link",
    ).toEqual([]);
  });

  it("REGISTRY_CLAIM_TYPE_REFERENCES equals the real CLAIM_REGISTRY, both directions", () => {
    const live = new Set<string>(CLAIM_REGISTRY);
    const mirrored = new Set<string>(REGISTRY_CLAIM_TYPE_REFERENCES);

    const inCatalogOnly = [...mirrored].filter((t) => !live.has(t)).sort();
    const inRuntimeOnly = [...live].filter((t) => !mirrored.has(t)).sort();

    expect(
      inCatalogOnly,
      "catalog names a registry claim type the planner enum does not admit",
    ).toEqual([]);
    expect(
      inRuntimeOnly,
      "the planner enum admits a registry claim type the catalog lacks",
    ).toEqual([]);
  });

  it("the mirrors carry no duplicates (a set-equality pin cannot see a repeat)", () => {
    // Set equality above would silently tolerate a duplicated entry. Cardinality
    // is the complement that catches it.
    expect(new Set<string>(CLAIM_CLASS_REFERENCES).size).toBe(
      CLAIM_CLASS_REFERENCES.length,
    );
    expect(new Set<string>(REGISTRY_CLAIM_TYPE_REFERENCES).size).toBe(
      REGISTRY_CLAIM_TYPE_REFERENCES.length,
    );
  });

  it("keeps the two name spaces disjoint (SDD §K — map, do not equate)", () => {
    // UPPER_SNAKE registry TYPE names vs lowercase-hyphenated guard ids. A name
    // appearing in both would mean the two vocabularies had started to merge,
    // which §K explicitly forbids.
    const classes = new Set<string>(CLAIM_CLASS_REFERENCES);
    for (const type of REGISTRY_CLAIM_TYPE_REFERENCES) {
      expect(classes.has(type), `"${type}" appears in both name spaces`).toBe(false);
    }
  });
});
