/**
 * Ops-boundary mirror generators — FE-4 MIGRATE 4b (FE-T24), the final
 * migrate batch.
 *
 * Ground truth (re-grounded fresh for this ticket, not assumed): the
 * ops-plane's foreign/forbidden hand lists live in two files —
 * `packages/pack-ops/src/capabilities.ts` (the FOREIGN-advertised trio) and
 * `apps/api/src/ops/ops-verb-scope.ts` (the FORBIDDEN-destructive set AND a
 * third, DISTINCT `WA_EXCLUDED_OPS_KINDS` set). Full sweep of both files plus
 * `apps/api/src/ops/ops-conductor.ts`'s `opsPlaneDriftProblems` inputs found
 * NO other ops-boundary hand list — every other `Set`/array in that
 * territory (`PRODUCT_AVAILABILITY_SET_KEYS` et al. in pack-ops/types.ts,
 * `OPS_REFUNDABLE_STATUSES` / `OPS_ENTITY_NON_TERMINAL_STATUSES`,
 * `OPS_READ_RENDER_TEMPLATE_KEYS` / `OPS_ACTION_RENDER_TEMPLATE_KEYS`,
 * `OPS_REFUSAL_CODES`) is a payload-key, domain-status, render-template, or
 * refusal-code list — a DIFFERENT family (extraction schema / rendering /
 * refusal-code territory), not foreign/forbidden ops-boundary data.
 *
 * # Generator 1 — foreign-advertised kinds
 *
 * `OPS_FOREIGN_ADVERTISED_KIND` / `_TRANSITION_KIND` / `_REFUND_KIND`
 * (pack-ops/capabilities.ts) are the 3 foreign-owned kinds the ops persona's
 * OWN planner advertises to widen its allowlist — EXACTLY what
 * `CapabilityDefinition.plannerAdvertisedBy` (FE-T20) already models: a kind
 * whose `pack` is NOT `"ibatexas/pack-ops"` but whose `plannerAdvertisedBy`
 * includes it. No new field needed.
 *
 * # Generator 2 — forbidden-destructive kinds
 *
 * `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` (ops-verb-scope.ts, BKL-096) — the
 * NO-PLANE-EVER two-person/destructive forbid (`order.cancel`,
 * `payment.waive`, `payment.status.force`) — was NOT already modeled by any
 * existing field (it says a kind must NEVER be ops-advertised, which
 * `plannerAdvertisedBy`'s absence cannot distinguish from "simply never
 * came up" for the other ~60 non-ops-advertised kinds). Per FE-T24's own
 * instruction ("if any boundary fact isn't in the registry, author it as
 * grounded data … never fabricate"), added `opsForbiddenDestructive?: true`
 * to `CapabilityDefinitionCommon` (types.ts) and set it on exactly those 3
 * kinds, grounded FROM the real committed constant.
 *
 * # Traced, NOT generated — `WA_EXCLUDED_OPS_KINDS`
 *
 * A third set in the same file (`WA_EXCLUDED_OPS_KINDS`, BKL-086) excludes
 * IRREVERSIBLE money verbs from the WhatsApp ingress specifically (a
 * SIM-swap compensating control) — today a single-element Set wrapping
 * `OPS_FOREIGN_ADVERTISED_REFUND_KIND` (already covered by Generator 1).
 * This is a genuine, narrow business-policy judgment (which verbs are
 * irreversible enough to need a step-up factor) — not a structural fact
 * this registry otherwise models (no "reversibility" axis exists anywhere
 * in `CapabilityDefinition`, and inventing one solely to force a generator
 * here would be exactly the fabrication FE-4.1 forbids). Left hand-authored;
 * reported, not migrated.
 */

import type { CapabilityDefinition } from "./types.js"

/**
 * Project the kinds a FOREIGN pack's planner advertises to widen its own
 * allowlist — i.e. every kind NOT owned by `pack` whose `plannerAdvertisedBy`
 * includes it. Generalized over the caller-supplied `pack` id (today only
 * ever called with `"ibatexas/pack-ops"`) rather than hardcoding the ops
 * pack id, since the underlying data (`plannerAdvertisedBy`) is itself
 * pack-agnostic. Returns a `Set` — order carries no meaning (the real
 * targets are 3 independent named string constants, not an ordered list).
 */
export function generateForeignAdvertisedKinds(
  defs: readonly CapabilityDefinition[],
  pack: CapabilityDefinition["pack"],
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of defs) {
    if (def.pack === pack) continue
    if ((def.plannerAdvertisedBy ?? []).includes(pack)) out.add(def.kind)
  }
  return out
}

/**
 * Project every kind marked `opsForbiddenDestructive: true` — the mirror of
 * `FORBIDDEN_OPS_DESTRUCTIVE_KINDS`. Returns a `Set`, matching the real
 * target's own `ReadonlySet<string>` contract.
 */
export function generateOpsForbiddenDestructiveKinds(
  defs: readonly CapabilityDefinition[],
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of defs) {
    if (def.opsForbiddenDestructive === true) out.add(def.kind)
  }
  return out
}
