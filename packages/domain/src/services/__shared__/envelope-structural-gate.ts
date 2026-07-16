// envelope-structural-gate.ts — canonical isIntentEnvelope boundary predicate.
//
// FE-T04: `isIntentEnvelope` (@adjudicate/core) is the kernel's OWN
// structural predicate — the same one a v2-conformant adopter implementation
// is expected to re-derive against `docs/specs/intent-envelope-v2.schema.json`.
// This module is the SINGLE canonical definition of the gate built on top of
// it, so every seam that adjudicates an envelope reuses the identical check
// and error code rather than re-deriving (and risking divergence in) its own
// copy.
//
// Two convergence points reuse this:
//   - `withAdjudicate` (./with-adjudicate.ts, same package) — the
//     command-service chokepoint every ops/admin/subscriber/job/LLM-tool
//     mutation flows through.
//   - `runCustomerIntent`
//     (apps/api/src/routes/__shared__/customer-intent-gateway.ts) — the
//     customer-plane HTTP chokepoint. `apps/api` depends on `@ibatexas/domain`
//     (never the reverse), so this lives here and the gateway imports it via
//     the `@ibatexas/domain` package export, rather than each seam keeping an
//     independent copy of the same logic.
//
// Additive, not a replacement for any seam-local defense (e.g. the gateway's
// `detectForgery`): defense-in-depth is a permanent property of this
// boundary, never ranked below an "upstream" structural fix.

import { isIntentEnvelope } from "@adjudicate/core"

/** Stable error code surfaced on a structural-boundary rejection. */
export const STRUCTURAL_REJECTION_CODE = "envelope_malformed" as const

/**
 * The named, asserted gate: `true` iff `envelope` is NOT a well-formed
 * `IntentEnvelope` per the kernel's own `isIntentEnvelope` predicate.
 *
 * Never-false-reject proof: every real call site builds its envelope via
 * `buildEnvelope` / `buildCustomerEnvelope`, which ALWAYS stamps the nine
 * required fields before an adjudication seam is ever invoked — so a
 * legitimate runtime envelope satisfies `isIntentEnvelope` by construction.
 * This gate can only fire on a value that bypassed construction entirely.
 *
 * Deliberately STRICTER than the kernel itself: `adjudicate()` only verifies
 * `version` and re-derives `intentHash` — it never calls `isIntentEnvelope`,
 * so an envelope carrying an extra top-level key still EXECUTEs at the raw
 * kernel (the extra key feeds no hash or guard) but REFUSEs here. A caller
 * threading `{ ...envelope, extraKey }` through a gated seam will start
 * seeing `envelope_malformed` where the ungated kernel would have accepted it.
 */
export function isStructurallyMalformed(envelope: unknown): boolean {
  return !isIntentEnvelope(envelope)
}
