/**
 * `SUCCESS_CLAIM_CLASSES.justifiedBy` reverse-mirror generator — FE-4
 * MIGRATE 3 (FE-T22).
 *
 * `CapabilityDefinition.successClaimLinks` (FE-T19) is the FORWARD
 * inversion: for each capability, which `SUCCESS_CLAIM_CLASSES` ids its
 * EXECUTE can justify. This generator goes the OTHER direction — for a
 * given claim class id, which capability kinds justify IT (the class's
 * own `justifiedBy` array, `apps/api/src/claustrum/ibatexas-responder.ts`)
 * — reconstructed FROM `successClaimLinks`, never re-typed from the real
 * export. Round-trip fidelity (forward inversion → reverse mirror →
 * matches the real `justifiedBy`) is the freshness proof; that test lives
 * in apps/api (`SUCCESS_CLAIM_CLASSES` is an apps/api export, packages
 * cannot import apps/api).
 *
 * Order note: `justifiedBy` arrays in the real registry are NOT declared
 * in `CAPABILITY_DEFINITIONS` order for every class (e.g. `"pix-generated"`
 * lists `["order.checkout.create", "payment.pix.regenerate"]` — orders
 * before payments, matching this registry's pack-group order; other
 * classes are single-kind or multi-kind-same-pack, where order is
 * trivially consistent). The freshness test compares as a SET, not an
 * ordered array, to stay robust to either convention.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project the kinds whose `successClaimLinks` includes `claimId` — the
 * capabilities that justify this one `SUCCESS_CLAIM_CLASSES` entry.
 */
export function generateJustifiedByForClaim(
  defs: readonly CapabilityDefinition[],
  claimId: string,
): readonly string[] {
  const out: string[] = []
  for (const def of defs) {
    if ((def.successClaimLinks ?? []).includes(claimId)) out.push(def.kind)
  }
  return out
}
