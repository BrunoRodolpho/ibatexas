// Conformance fixtures for the REFERENTIAL-INTEGRITY pass (LE2-017).
//
// Four rule ids, four fixture catalogs. Each is the smallest catalog that
// makes its rule fire and nothing else — the two identity-collision fixtures
// need two capabilities by definition (a collision is not a per-object fault),
// every other one needs one.

import { FIXTURE_PACK as PACK } from "./base.js"
import { fixtureCatalog, type ConformanceFixture } from "../types.js"

export const REFERENTIAL_INTEGRITY_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "referential-integrity.claim-reference-dangling",
    targets: "referential-integrity/claim-reference-dangling",
    why:
      "`successClaimLinks` resolves against CLAIM_CLASS_REFERENCES; " +
      '"order-nuked" is not one of the 19 classes the responder defines.',
    definitions: fixtureCatalog({
      kind: "conformance.claim.dangling",
      pack: PACK,
      mutating: true,
      tier: "identity",
      successClaimLinks: ["order-nuked"],
    }),
  },
  {
    name: "referential-integrity.pack-reference-dangling",
    targets: "referential-integrity/pack-reference-dangling",
    why:
      "`pack` must name one of the six first-party Packs; " +
      '"ibatexas/pack-ghost" is not in CAPABILITY_PACK_IDS.',
    definitions: fixtureCatalog({
      kind: "conformance.pack.dangling",
      pack: "ibatexas/pack-ghost",
      mutating: true,
      tier: "identity",
    }),
  },
  {
    name: "referential-integrity.duplicate-capability-kind",
    targets: "referential-integrity/duplicate-capability-kind",
    why:
      "`kind` is the catalog's identity for a capability. Two objects claiming " +
      "one kind is the INBOUND fault a per-object check can never see, and every " +
      "projection would resolve it to whichever entry it reached first. Both " +
      "claimants are named, which is why the fixture emits two diagnostics.",
    definitions: fixtureCatalog(
      {
        kind: "conformance.duplicate.kind",
        pack: PACK,
        mutating: true,
        tier: "identity",
      },
      {
        kind: "conformance.duplicate.kind",
        pack: PACK,
        mutating: true,
        tier: "identity",
      },
    ),
  },
  {
    name: "referential-integrity.ambiguous-legacy-name",
    targets: "referential-integrity/ambiguous-legacy-name",
    why:
      "generate-tool-to-intent-map.ts INVERTS `legacyNames` into a name -> kind " +
      "map, so a tool name claimed by two capabilities silently drops one side " +
      "into a Map overwrite. Both claimants are named.",
    definitions: fixtureCatalog(
      {
        kind: "conformance.legacy.first",
        pack: PACK,
        mutating: true,
        tier: "identity",
        legacyNames: ["conformance_shared_tool"],
      },
      {
        kind: "conformance.legacy.second",
        pack: PACK,
        mutating: true,
        tier: "identity",
        legacyNames: ["conformance_shared_tool"],
      },
    ),
  },
]
